'use strict';

/*
 * Draws the label preview from the server's resolved model so it matches the
 * printed label's geometry. Elements carry printer-dot coordinates in the
 * label's native (portrait) space; a group transform rotates that space into
 * the landscape orientation the label is read in — the same mapping the printed
 * media has. Verified layout: (x,y) -> (heightDots - y, x).
 */

(function () {
  const NS = 'http://www.w3.org/2000/svg';
  // Approx TSC internal font cell heights (dots @203dpi).
  const FONT_H = { 1: 12, 2: 20, 3: 24, 4: 32, 5: 48 };

  function svgEl(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  async function renderLabelPreview(jtcNo, mount) {
    mount.textContent = '';
    let model;
    try {
      const res = await fetch('/api/label/model?no=' + encodeURIComponent(jtcNo));
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || 'model ' + res.status);
      }
      model = await res.json();
    } catch (e) {
      const p = document.createElement('div');
      p.className = 'labelmount__err';
      p.textContent = 'Label preview unavailable: ' + e.message;
      mount.appendChild(p);
      return;
    }

    const { widthDots, heightDots } = model.label;
    // Display is landscape: long side (heightDots) horizontal.
    const svg = svgEl('svg', {
      viewBox: `0 0 ${heightDots} ${widthDots}`,
      class: 'labelsvg',
      preserveAspectRatio: 'xMidYMid meet',
    });
    // Media outline in display space.
    svg.appendChild(svgEl('rect', {
      x: 0, y: 0, width: heightDots, height: widthDots,
      fill: '#fff', stroke: '#111', 'stroke-width': 2,
    }));

    // Native (x,y) -> display: (heightDots - y, x).
    const g = svgEl('g', { transform: `translate(${heightDots},0) rotate(90)` });
    for (const el of model.elements) drawElement(g, el);
    svg.appendChild(g);
    mount.appendChild(svg);
  }

  function drawElement(g, el) {
    switch (el.type) {
      case 'bar':
        g.appendChild(svgEl('rect', {
          x: el.x, y: el.y, width: el.width, height: el.height, fill: '#000',
        }));
        break;
      case 'box':
        g.appendChild(svgEl('rect', {
          x: el.x, y: el.y, width: el.width, height: el.height,
          fill: 'none', stroke: '#000', 'stroke-width': el.thickness,
        }));
        break;
      case 'text': {
        if (!el.text) break;
        const h = (FONT_H[el.font] || 20) * (el.yMul || 1);
        const t = svgEl('text', {
          x: el.x, y: el.y,
          'font-family': '"Courier New", monospace',
          'font-size': h,
          'font-weight': 700,
          fill: '#000',
          'dominant-baseline': 'text-before-edge',
          'text-anchor': 'start',
          transform: `rotate(${el.rotation} ${el.x} ${el.y})`,
        });
        t.textContent = el.text;
        g.appendChild(t);
        break;
      }
      case 'barcode':
        drawBarcode(g, el);
        break;
      default:
        break; // unsupported element types are skipped
    }
  }

  function drawBarcode(g, el) {
    const content = el.content || '';
    let dataUrl = null;
    let aspect = 2;
    try {
      const canvas = document.createElement('canvas');
      // eslint-disable-next-line no-undef
      JsBarcode(canvas, content, {
        format: 'CODE128',
        displayValue: !!el.humanReadable,
        margin: 0,
        height: el.height,
        width: el.narrow,
      });
      dataUrl = canvas.toDataURL('image/png');
      aspect = canvas.width / canvas.height;
    } catch (_) {
      /* fall through to a placeholder */
    }
    const h = el.height;
    // Use the server's estimated width so the preview footprint matches the
    // centered TSPL barcode; fall back to the rendered aspect.
    const w = el.widthDots ? el.widthDots : Math.max(1, Math.round(h * aspect));
    if (dataUrl) {
      const img = svgEl('image', {
        x: el.x, y: el.y, width: w, height: h,
        transform: `rotate(${el.rotation} ${el.x} ${el.y})`,
        preserveAspectRatio: 'none',
      });
      img.setAttribute('href', dataUrl);
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataUrl);
      g.appendChild(img);
    } else {
      g.appendChild(svgEl('rect', {
        x: el.x, y: el.y, width: w, height: h, fill: '#000',
        transform: `rotate(${el.rotation} ${el.x} ${el.y})`,
      }));
    }
  }

  window.renderLabelPreview = renderLabelPreview;
})();
