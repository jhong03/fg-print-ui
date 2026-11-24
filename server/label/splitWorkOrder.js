'use strict';

function prepareSplitWorkOrder(elements, values, part) {
  if (!part) return { elements, values };
  if (!elements.some((el) => el.type === 'text' && el.value?.kind === 'field' && el.value.field === 'qty')) {
    throw new Error('The split WO template must include a Quantity field.');
  }

  const frame = elements.filter((el) => el.type === 'box').reduce((largest, box) => {
    return !largest || box.width * box.height > largest.width * largest.height ? box : largest;
  }, null);
  const title = elements.find((el) => el.type === 'text' && el.value?.kind === 'static' && /^work order label$/i.test(el.value.text?.trim()));
  const text = `${part.number} OF 2`;
  // WO templates read sideways in printer coordinates. Text runs toward y=0,
  // so the right edge of the frame is its smaller y coordinate.
  const rightInset = 24;
  const font2CellWidth = 12;
  const marker = {
    type: 'text', x: title?.x ?? (frame?.x ?? 0) + 24,
    y: (frame?.y ?? 0) + rightInset + font2CellWidth * text.length,
    rotation: 270, font: '2', xMul: 1, yMul: 1, value: { kind: 'static', text },
  };
  return { elements: [...elements, marker], values: { ...values, qty: String(part.qty) } };
}

module.exports = { prepareSplitWorkOrder };
