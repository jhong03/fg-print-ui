/*
 * Barcode standardization, shared by the TSPL renderer and the preview so both
 * agree.
 *
 * - hasBarcodeData: whether the barcode's source field actually has a value.
 *   If not, callers skip the barcode entirely (no barcode rather than encoding
 *   a fallback that would vary in width).
 * - centeredBarcode: align the barcode's length-center with the QC CHOP box's
 *   center, so it sits exactly centered below the box regardless of id length
 *   or where the box is placed in the template. Code128 width is proportional to
 *   content, so we estimate it and offset the anchor.
 *
 * The barcode is drawn rotated 270°, so it extends in the -y direction; the
 * anchor is its high-y end and the code runs down to (anchor.y - width). The
 * length axis (y) maps to the horizontal axis of the read (landscape) label, so
 * matching the box's y-center centers the barcode horizontally under the box.
 */

// Fallback center along the length axis (dots) if no box is found.
const CENTER_Y = 270;

function hasBarcodeData(el, values) {
  const v = el.value || {};
  if (v.kind === 'field') return String(values[v.field] ?? '').trim() !== '';
  return String(v.text ?? '').trim() !== '';
}

// Approximate Code128 rendered width in dots. Good enough to center; the printer
// draws the real bars. Assumes digits pair up in subset C (as TSC/JsBarcode do).
function estimateBarcodeWidth(content, narrow) {
  const s = String(content || '');
  const digits = (s.match(/\d/g) || []).length;
  const nonDigits = s.length - digits;
  const symbols = nonDigits + Math.ceil(digits / 2) + 2; // + rough subset switches
  const modules = 11 * (1 + symbols + 1) + 13; // start + data + checksum + stop
  return modules * (narrow || 2);
}

// The barcode only auto-centers on a QC CHOP box. This is that marker — a static
// "QC CHOP" caption. (Mirrors render.js; kept local to avoid a circular require.)
const QC_CAPTION = /^\s*QC\s*CHOP\s*$/i;

function hasQcCaption(elements) {
  return (elements || []).some((e) =>
    e.type === 'text' && e.value && e.value.kind === 'static' && QC_CAPTION.test(e.value.text || '')
  );
}

// The QC CHOP box — the largest box element.
function qcBox(elements) {
  const boxes = (elements || []).filter((e) => e.type === 'box');
  if (!boxes.length) return null;
  return boxes.reduce((a, b) =>
    (a.width || 0) * (a.height || 0) >= (b.width || 0) * (b.height || 0) ? a : b
  );
}

// Returns the barcode anchor plus estimated width (so the preview can size the
// image to match). Placement depends on the template:
//   - QC label (has a QC CHOP box): center the barcode along that box.
//   - Other boxes but NO QC box (e.g. a Work Order label's border/grid): keep
//     the designer's position — centering on the border would drop it on the
//     title.
//   - No boxes at all: CENTER_Y fallback (preserves existing calibrations).
function centeredBarcode(el, content, elements) {
  const width = estimateBarcodeWidth(content, el.narrow || 2);
  if (hasQcCaption(elements)) {
    const box = qcBox(elements);
    const center = box ? box.y + (box.height || 0) / 2 : CENTER_Y;
    return { x: el.x, y: Math.round(center + width / 2), width };
  }
  const anyBox = (elements || []).some((e) => e.type === 'box');
  if (anyBox) return { x: el.x, y: el.y, width }; // honour designed position
  return { x: el.x, y: Math.round(CENTER_Y + width / 2), width };
}

module.exports = { hasBarcodeData, estimateBarcodeWidth, centeredBarcode, CENTER_Y };
