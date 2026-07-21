/*
 * Text wrapping for label fields.
 *
 * The MES template positions each value as a single line; long values (e.g. a
 * JTC No with a component suffix) run past their space and collide with the
 * barcode or QC box. We can't change the MES template, so we wrap here — used
 * by BOTH the TSPL renderer and the on-screen preview so they stay identical.
 *
 * Geometry: text is drawn rotated 270°, so a line extends in the -y direction
 * and wrapped lines stack in the +x direction (the next visual line down).
 * "Available width" for a line is the distance in -y until the nearest
 * blocking element (bar / box / barcode) in the same x-band, or the label edge.
 */

// Approx TSC internal font cell size (dots @203dpi): [width, height].
const FONT_W = { 1: 8, 2: 12, 3: 16, 4: 24, 5: 32 };
const FONT_H = { 1: 12, 2: 20, 3: 24, 4: 32, 5: 48 };
const MARGIN = 6;      // dots of breathing room before an obstacle
const LINE_FACTOR = 1.15;

function fontH(el) {
  return (FONT_H[el.font] || 20) * (el.yMul || 1);
}

// The x-range an element occupies (perpendicular to text flow).
function xBand(el) {
  switch (el.type) {
    case 'text': return [el.x, el.x + fontH(el)];
    case 'bar':
    case 'box': return [el.x, el.x + (el.width || 0)];
    case 'barcode': return [el.x, el.x + (el.height || 0)];
    default: return [el.x, el.x];
  }
}

// Highest y an obstacle reaches (the edge facing a text anchored below it).
function obstacleYHigh(el) {
  switch (el.type) {
    case 'bar':
    case 'box': return el.y + (el.height || 0);
    case 'barcode': return el.y;
    default: return el.y;
  }
}

function availableWidth(el, elements) {
  const [ex0, ex1] = xBand(el);
  let boundary = 0; // label edge at y=0
  for (const o of elements) {
    if (o === el) continue;
    if (o.type !== 'bar' && o.type !== 'box' && o.type !== 'barcode') continue;
    const [ox0, ox1] = xBand(o);
    if (ox1 <= ex0 || ox0 >= ex1) continue; // no x overlap → not in the way
    const yHigh = obstacleYHigh(o);
    if (yHigh <= el.y && yHigh > boundary) boundary = yHigh;
  }
  return el.y - boundary - MARGIN;
}

function wrap(text, maxChars) {
  const limit = Math.max(1, maxChars);
  const lines = [];
  let cur = '';
  for (let word of text.split(' ')) {
    // Hard-break a single word longer than the line.
    while (word.length > limit) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    if (cur === '') cur = word;
    else if ((cur + ' ' + word).length <= limit) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur !== '') lines.push(cur);
  return lines.length ? lines : [''];
}

/*
 * Expand one text element + its resolved value into one or more positioned line
 * segments (native coords). Non-wrapping values return a single segment.
 */
function layoutText(el, text, elements) {
  const charW = (FONT_W[el.font] || 12) * (el.xMul || 1);
  const maxChars = Math.floor(availableWidth(el, elements) / charW);
  if ((text || '').length <= maxChars || !text) {
    return [{ x: el.x, y: el.y, text: text || '' }];
  }
  const lineH = Math.round(fontH(el) * LINE_FACTOR);
  return wrap(text, maxChars).map((t, i) => ({
    x: el.x + i * lineH,
    y: el.y,
    text: t,
  }));
}

module.exports = { layoutText };
