'use strict';
(() => {
  const sections = {
    printers: ['Printers', 'Add printers and choose their connections.'],
    assignments: ['Label assignments', 'Choose where labels print and which ones appear on this computer.'],
    labels: ['Label configuration', 'Manage models, Normal/Rework modes, QR rules and label layouts.'],
    auto: ['Auto Print', 'Choose which completed jobs this computer watches automatically.'],
    terminal: ['Terminal & agent', 'Manage the identity and backend connection of this computer.'],
  };
  const aliases = { agentHeading: 'terminal', assignmentsHeading: 'assignments', labelConfigHeading: 'labels', autoPrintHeading: 'auto' };
  function revealNav() {
    const nav = document.querySelector('.settings-nav'), active = nav.querySelector('.active');
    if (active && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = active.offsetLeft - nav.offsetLeft;
  }
  function show() {
    const hash = location.hash.slice(1);
    const selected = Object.hasOwn(sections, hash) ? hash : aliases[hash] || 'printers';
    for (const panel of document.querySelectorAll('[data-settings-panel]')) panel.hidden = panel.dataset.settingsPanel !== selected;
    for (const link of document.querySelectorAll('[data-settings-nav]')) {
      const active = link.dataset.settingsNav === selected;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    document.getElementById('settingsPageHeading').textContent = sections[selected][0];
    document.getElementById('settingsPageDescription').textContent = sections[selected][1];
    document.querySelector('.settings-page').scrollTop = 0;
    revealNav();
    window.dispatchEvent(new CustomEvent('settings-section-change', { detail: selected }));
  }
  window.addEventListener('hashchange', show); show();
  window.addEventListener('resize', revealNav);
  document.addEventListener('invalid', (event) => {
    const panel = event.target.closest('[data-settings-panel]');
    if (panel?.hidden) { location.hash = panel.dataset.settingsPanel; show(); }
  }, true);
})();
