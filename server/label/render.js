/*
 * TSPL renderer.
 *
 * Reproduces the MES label-designer's element -> TSPL mapping so we can print
 * the same designed templates locally with real JTC data, without depending on
 * an MES render endpoint (which only injects sample data).
 *
 * Text / bar / box output matches the MES `/api/label-templates/:id/test-print`
 * renderer byte-for-byte. The BARCODE line intentionally diverges: we skip it
 * when there's no id and center it for a consistent footprint (see
 * barcodeLayout.js) — a deliberate our-side standardization.
 *
 * A template is: { label:{widthMm,heightMm,gapMm,dpi,direction,printMethod},
 *                  elements:[ {type:'text'|'bar'|'box'|'barcode', x,y, ...} ] }
 * `values` is a flat map of fieldKey -> string.
 */

const { layoutText } = require('./textLayout');
const { hasBarcodeData, centeredBarcode } = require('./barcodeLayout');

function resolveValue(el, values) {
  const v = el.value || {};
  let text = '';
  if (v.kind === 'static') text = v.text != null ? String(v.text) : '';
  else if (v.kind === 'field') {
    const raw = values[v.field];
    text = raw != null ? String(raw) : '';
  }
  if (v.prefix) text = String(v.prefix) + text;
  return text;
}

// TSPL delimits strings with double quotes; keep any stray quotes from breaking
// the command.
function q(s) {
  return String(s).replace(/"/g, '');
}

function normAngle(r) {
  return ((((r || 0) % 360) + 360) % 360);
}

/*
 * Label variants.
 *
 * Some labels want the QC CHOP box (a blank square to stamp), some don't.
 * Rather than keeping two MES templates in sync, 'plain' drops the box and its
 * caption from whichever template we were handed; 'qc' leaves it alone.
 *
 * Dropping the box MOVES THE BARCODE — centeredBarcode aligns it with the box
 * and falls back to a fixed centre when there is none. That is why each variant
 * carries its own BARCODE_NUDGE_DOTS_*: tune each once, then toggle freely.
 */
const QC_CAPTION = /^\s*QC\s*CHOP\s*$/i;

function isQcCaption(el) {
  const v = el.value || {};
  return el.type === 'text' && v.kind === 'static' && QC_CAPTION.test(v.text || '');
}

function boxArea(b) {
  return (b.width || 0) * (b.height || 0);
}

function applyVariant(elements, variant) {
  if (variant !== 'plain') return elements;
  // The QC CHOP box is the largest box — the same rule barcodeLayout uses to
  // pick what the barcode centres under, so the two always agree.
  const boxes = elements.filter((e) => e.type === 'box');
  const qcBox = boxes.length
    ? boxes.reduce((a, b) => (boxArea(a) >= boxArea(b) ? a : b))
    : null;
  return elements.filter((el) => el !== qcBox && !isQcCaption(el));
}

/*
 * The element list AS PRINTED, for text wrapping to measure against.
 *
 * Two things make the template's own list the wrong thing to measure:
 *   - a barcode is re-centered from its content, so it prints somewhere the
 *     template doesn't say (and moves as the id gets longer);
 *   - a barcode with no id isn't printed at all, so it shouldn't squeeze the
 *     text next to it.
 *
 * The print-only nudge is deliberately NOT applied: it shifts the barcode away
 * from the text, so ignoring it errs toward more clearance, and it keeps the
 * preview's wrapping identical to the print's.
 */
function placedElements(elements, values) {
  return elements.flatMap((el) => {
    if (el.type !== 'barcode') return [el];
    if (!hasBarcodeData(el, values)) return []; // not printed -> not an obstacle
    const { x, y } = centeredBarcode(el, resolveValue(el, values), elements);
    return [{ ...el, x, y }];
  });
}

/*
 * Upright printing.
 *
 * The MES designs these labels sideways: the media is portrait but every
 * element is placed at rotation 270, so the print has to be turned a quarter
 * turn to read. We turn the LAYOUT instead, so it comes off the printer the
 * normal way up — top-down, left-to-right.
 *
 * The mapping is the one the on-screen preview already uses to show the label
 * the way an operator reads it: (x,y) -> (H - y, x), where H is the design's
 * long side in dots. Rects trade width for height, and every element's own
 * rotation drops by 270 (so 270 -> 0, i.e. upright).
 *
 * Only sideways designs are transformed; an already-upright template is emitted
 * as-is. NOTE that the as-is path is not fully supported yet — textLayout.js
 * still measures wrapping as if text flowed sideways, so upright values wrap at
 * the wrong width. Fix that there before relying on an upright MES design.
 */
function isSidewaysDesign(elements) {
  const texts = (elements || []).filter((e) => e.type === 'text');
  if (!texts.length) return false;
  return texts.filter((e) => normAngle(e.rotation) === 270).length > texts.length / 2;
}

function makeUpright(elements, heightDots) {
  if (!isSidewaysDesign(elements)) return null;
  // Elements that overrun the declared label height map to negative
  // coordinates, which TSPL doesn't accept — pull them back to the edge.
  const clamp = (n) => Math.max(0, n);
  return {
    point: (x, y) => ({ x: clamp(heightDots - y), y: clamp(x) }),
    // A rect's anchor becomes what was its far-y corner; w and h swap.
    rect: (x, y, w, h) => ({
      x: clamp(heightDots - (y + (h || 0))),
      y: clamp(x),
      w: h || 0,
      h: w || 0,
    }),
    angle: (r) => normAngle(normAngle(r) - 270),
  };
}

// Returns an array of TSPL command lines for one element (text may wrap into
// several TEXT lines). `U` is the upright transform, or null to emit as designed.
function renderElement(el, values, elements, barcodeNudge = 0, U = null) {
  switch (el.type) {
    case 'text': {
      const val = resolveValue(el, values);
      // Wrapping is measured in the design's own space, then transformed — so
      // the line breaks are identical either way.
      return layoutText(el, val, elements).map((seg) => {
        const p = U ? U.point(seg.x, seg.y) : seg;
        const rot = U ? U.angle(el.rotation) : el.rotation;
        return `TEXT ${p.x},${p.y},"${el.font}",${rot},${el.xMul},${el.yMul},"${q(seg.text)}"`;
      });
    }
    case 'bar': {
      if (!U) return [`BAR ${el.x},${el.y},${el.width},${el.height}`];
      const r = U.rect(el.x, el.y, el.width, el.height);
      return [`BAR ${r.x},${r.y},${r.w},${r.h}`];
    }
    case 'box': {
      if (!U) return [`BOX ${el.x},${el.y},${el.x + el.width},${el.y + el.height},${el.thickness}`];
      const r = U.rect(el.x, el.y, el.width, el.height);
      return [`BOX ${r.x},${r.y},${r.x + r.w},${r.y + r.h},${el.thickness}`];
    }
    case 'barcode': {
      if (!hasBarcodeData(el, values)) return []; // no id -> no barcode
      const val = resolveValue(el, values);
      const codeType = el.codeType || '128';
      const hr = el.humanReadable ? 1 : 0;
      const { x, y } = centeredBarcode(el, val, elements);
      // Print-only horizontal calibration (positive = move printed barcode
      // RIGHT as the label is read). Passed in by the caller so it can be read
      // live from .env. Sideways that axis is -y; upright it is +x.
      if (U) {
        const p = U.point(x, y);
        return [`BARCODE ${p.x + barcodeNudge},${p.y},"${codeType}",${el.height},${hr},${U.angle(el.rotation)},${el.narrow},${el.wide},"${q(val)}"`];
      }
      return [`BARCODE ${x},${y - barcodeNudge},"${codeType}",${el.height},${hr},${el.rotation},${el.narrow},${el.wide},"${q(val)}"`];
    }
    default:
      return []; // unknown element types are skipped
  }
}

function renderTspl(template, values = {}, opts = {}) {
  const L = template.label || {};
  const barcodeNudge = opts.barcodeNudge != null
    ? opts.barcodeNudge
    : Number(process.env.BARCODE_NUDGE_DOTS || 0);
  const lines = [];

  // Drop the QC CHOP block first, so wrapping and barcode centring both see
  // the label as it will actually print.
  const elements = applyVariant(template.elements || [], opts.variant);
  const heightDots = Math.round((L.heightMm || 0) * (L.dpi || 203) / 25.4);
  const U = makeUpright(elements, heightDots);

  // Turned upright, the design's long edge becomes the print width, so SIZE
  // swaps to match the space the elements are now laid out in.
  lines.push(U ? `SIZE ${L.heightMm} mm,${L.widthMm} mm` : `SIZE ${L.widthMm} mm,${L.heightMm} mm`);
  lines.push(`GAP ${L.gapMm || 0} mm,0 mm`);
  lines.push(`DIRECTION ${L.direction || 0}`);
  lines.push('CLS');
  // The designer only emits SET PRINTMETHOD for direct-thermal; thermal-transfer
  // (the printer default) omits it.
  if (L.printMethod === 'DIRECT') lines.push('SET PRINTMETHOD DIRECT');
  lines.push('OFFSET 0');

  // Wrap against where things actually land, not where the template put them.
  const placed = placedElements(elements, values);
  for (const el of elements) {
    for (const line of renderElement(el, values, placed, barcodeNudge, U)) lines.push(line);
  }

  lines.push('PRINT 1,1');
  // Trailing newline to match the MES renderer's output exactly.
  return lines.join('\n') + '\n';
}

module.exports = { renderTspl, resolveValue, placedElements, applyVariant };
