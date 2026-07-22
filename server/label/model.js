/*
 * Builds a "preview model" from a template + JTC record: the label's real
 * dimensions (in printer dots) plus each element with its value resolved. The
 * browser draws this to scale so the on-screen preview matches the printed
 * label geometry — same coordinate system the TSPL uses.
 */

const { resolveValue, placedElements, applyVariant } = require('./render');
const { mapRecordToFields } = require('./mapRecord');
const { layoutText } = require('./textLayout');
const { hasBarcodeData, centeredBarcode } = require('./barcodeLayout');

function buildModel(template, record, opts = {}) {
  const values = mapRecordToFields(record);
  const L = template.label || {};
  const dpi = L.dpi || 203;
  const dotsPerMm = dpi / 25.4;
  const widthDots = Math.round((L.widthMm || 0) * dotsPerMm);
  const heightDots = Math.round((L.heightMm || 0) * dotsPerMm);

  // Same variant the printer gets, so the preview shows what comes out.
  const src = applyVariant(template.elements || [], opts.variant);
  // Wrap against the printed positions, exactly as renderTspl does, so the
  // preview's line breaks match the label's.
  const placed = placedElements(src, values);
  const elements = [];
  for (const el of src) {
    const base = { type: el.type, x: el.x, y: el.y, rotation: el.rotation || 0 };
    switch (el.type) {
      case 'text': {
        const font = String(el.font || '2');
        const xMul = el.xMul || 1;
        const yMul = el.yMul || 1;
        // Expand into one entry per wrapped line (same wrapping as the TSPL).
        for (const seg of layoutText(el, resolveValue(el, values), placed)) {
          elements.push({ ...base, x: seg.x, y: seg.y, font, xMul, yMul, text: seg.text });
        }
        break;
      }
      case 'bar':
        elements.push({ ...base, width: el.width, height: el.height });
        break;
      case 'box':
        elements.push({ ...base, width: el.width, height: el.height, thickness: el.thickness || 1 });
        break;
      case 'barcode': {
        if (!hasBarcodeData(el, values)) break; // no id -> skip the barcode
        const content = resolveValue(el, values);
        const { x, y, width } = centeredBarcode(el, content, src);
        elements.push({
          ...base,
          x, y,
          widthDots: width,
          codeType: el.codeType || '128',
          height: el.height,
          narrow: el.narrow || 2,
          wide: el.wide || 1,
          humanReadable: !!el.humanReadable,
          content,
        });
        break;
      }
      default:
        elements.push({ ...base, unsupported: true, rawType: el.type });
    }
  }

  return {
    label: { widthMm: L.widthMm, heightMm: L.heightMm, dpi, widthDots, heightDots },
    elements,
  };
}

module.exports = { buildModel };
