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

// Returns an array of TSPL command lines for one element (text may wrap into
// several TEXT lines).
function renderElement(el, values, elements, barcodeNudge = 0) {
  switch (el.type) {
    case 'text': {
      const val = resolveValue(el, values);
      return layoutText(el, val, elements).map(
        (seg) => `TEXT ${seg.x},${seg.y},"${el.font}",${el.rotation},${el.xMul},${el.yMul},"${q(seg.text)}"`
      );
    }
    case 'bar':
      return [`BAR ${el.x},${el.y},${el.width},${el.height}`];
    case 'box':
      return [`BOX ${el.x},${el.y},${el.x + el.width},${el.y + el.height},${el.thickness}`];
    case 'barcode': {
      if (!hasBarcodeData(el, values)) return []; // no id -> no barcode
      const val = resolveValue(el, values);
      const codeType = el.codeType || '128';
      const hr = el.humanReadable ? 1 : 0;
      const { x, y } = centeredBarcode(el, val, elements);
      // Print-only horizontal calibration (positive = move printed barcode
      // RIGHT). Passed in by the caller so it can be read live from .env.
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

  lines.push(`SIZE ${L.widthMm} mm,${L.heightMm} mm`);
  lines.push(`GAP ${L.gapMm || 0} mm,0 mm`);
  lines.push(`DIRECTION ${L.direction || 0}`);
  lines.push('CLS');
  // The designer only emits SET PRINTMETHOD for direct-thermal; thermal-transfer
  // (the printer default) omits it.
  if (L.printMethod === 'DIRECT') lines.push('SET PRINTMETHOD DIRECT');
  lines.push('OFFSET 0');

  const elements = template.elements || [];
  for (const el of elements) {
    for (const line of renderElement(el, values, elements, barcodeNudge)) lines.push(line);
  }

  lines.push('PRINT 1,1');
  // Trailing newline to match the MES renderer's output exactly.
  return lines.join('\n') + '\n';
}

module.exports = { renderTspl, resolveValue };
