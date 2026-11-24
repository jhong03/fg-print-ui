'use strict';
(() => {
  let config, draft = [], selected = 0, dirty = false, busy = false;
  let savedIds = new Set();
  let stockLocations = [], stockLoaded = false, stockLoading = false;
  const fields = [...$('labelEditor').querySelectorAll('[data-label-field]')];
  const numbers = new Set(['toLocation', 'barcodeNudge', 'splitPartOneQty']);
  const status = (message, error = false) => {
    $('labelConfigStatus').textContent = message;
    $('labelConfigStatus').classList.toggle('error', error);
  };
  function readEditor() {
    if (!draft[selected]) return;
    const next = { ...draft[selected] };
    for (const field of fields) {
      const key = field.dataset.labelField;
      if (field.type === 'checkbox') next[key] = field.checked;
      else if (key === 'models' || key === 'boldText') {
        next[key] = [...new Set(field.value.split(key === 'models' ? /[,\n]+/ : /\n+/).map((v) => key === 'models' ? v.trim().toUpperCase() : v.trim()).filter(Boolean))];
      } else if (numbers.has(key)) {
        if (!field.value.trim()) delete next[key];
        else { next[key] = Number(field.value); if (!Number.isFinite(next[key])) throw new Error('Enter a valid number for ' + key + '.'); }
      } else {
        const value = field.value.trim();
        if (value || key === 'id' || key === 'name') next[key] = value;
        else delete next[key];
      }
    }
    draft[selected] = next;
    updateFlowAvailability();
  }
  function choices() {
    const select = $('labelConfigSelect'); select.replaceChildren();
    draft.forEach((loc, index) => select.appendChild(option(String(index), (loc.group || 'Other') + ' · ' + (loc.name || 'New label'))));
    select.value = String(selected);
    $('removeLabel').disabled = draft.length <= 1;
    $('labelMoveUp').disabled = selected === 0;
    $('labelMoveDown').disabled = selected === draft.length - 1;
  }
  function render() {
    choices();
    const loc = draft[selected];
    renderStockLocations();
    for (const field of fields) {
      const key = field.dataset.labelField;
      if (field.type === 'checkbox') field.checked = key === 'upright' ? loc[key] !== false : loc[key] === true;
      else field.value = Array.isArray(loc[key]) ? loc[key].join(key === 'models' ? ', ' : '\n') : loc[key] ?? (key === 'splitPartOneQty' ? 25 : '');
      if (key === 'id') field.readOnly = savedIds.has(loc.id);
      if (key === 'templateId') field.placeholder = config.defaults.templateId || '';
      if (key === 'barcodeNudge') field.placeholder = String(config.defaults.barcodeNudge ?? 0);
      if (key === 'agentUrl') field.placeholder = config.defaults.agentUrl || '';
    }
    updateFlowAvailability();
  }
  function updateFlowAvailability() {
    const greenRed = fields.find((field) => field.dataset.labelField === 'requireQrBinding');
    const rework = fields.find((field) => field.dataset.labelField === 'reworkQrBinding');
    // Keep checked boxes editable, including old invalid configurations, so users can untick them.
    greenRed.disabled = rework.checked && !greenRed.checked;
    rework.disabled = greenRed.checked && !rework.checked;
    for (const field of [greenRed, rework]) field.closest('label').classList.toggle('qr-binding-disabled', field.disabled);
    const paintingFlow = fields.find((field) => field.dataset.labelField === 'weldingToPainting');
    fields.find((field) => field.dataset.labelField === 'processCodePrepend').disabled = !paintingFlow.checked;
    const split = fields.find((field) => field.dataset.labelField === 'splitWoLabels');
    const partOne = fields.find((field) => field.dataset.labelField === 'splitPartOneQty');
    split.disabled = !paintingFlow.checked || !greenRed.checked || rework.checked;
    if (split.disabled) split.checked = draft[selected].splitWoLabels = false;
    partOne.disabled = !split.checked;
    partOne.required = split.checked;
    const qty = partOne.valueAsNumber;
    $('splitQtyHelp').textContent = Number.isInteger(qty) && qty >= 1 && qty <= 49
      ? 'Part 2 quantity: ' + (50 - qty) + ' (total: 50)'
      : 'Enter a whole number from 1 to 49.';
  }
  function renderStockLocations() {
    const select = $('stockLocation'), current = draft[selected]?.toLocation;
    select.replaceChildren(option('', 'Any location'));
    for (const loc of stockLocations) {
      const text = [loc.code, loc.name].filter(Boolean).join(' — ') || 'Location';
      select.appendChild(option(String(loc.id), text + ' (ID ' + loc.id + ')'));
    }
    if (current != null && !stockLocations.some((loc) => loc.id === current)) {
      select.appendChild(option(String(current), 'Saved location ID ' + current + (stockLoaded ? ' — no longer active or available' : ' — awaiting database list')));
    }
    select.value = current == null ? '' : String(current);
    select.disabled = stockLoading;
    $('reloadStockLocations').disabled = stockLoading;
  }
  async function loadStockLocations() {
    if (stockLoading) return;
    stockLoading = true; renderStockLocations();
    $('stockLocationStatus').textContent = 'Loading active stock locations…';
    try {
      const result = await api('/stock-locations');
      if (!Array.isArray(result.locations)) throw new Error('Restart the updated app to load stock locations.');
      stockLocations = result.locations; stockLoaded = true;
      $('stockLocationStatus').textContent = stockLocations.length
        ? 'Active database locations only. Any location removes this job filter.'
        : 'No active locations found. Any location removes this job filter.';
    } catch (e) {
      $('stockLocationStatus').textContent = e.message + ' Saved location IDs are kept. Use Refresh locations to retry.';
    } finally { stockLoading = false; renderStockLocations(); }
  }
  function changed() { dirty = true; status('Unsaved label changes. Click Save label configuration to apply them.'); }
  async function load(message) {
    if (busy) return;
    $('labelConfigFields').disabled = true;
    try {
      const result = await api('/locations');
      if (!Array.isArray(result.locations) || !result.revision || !result.defaults) throw new Error('Restart the updated app to enable label configuration.');
      const oldId = draft[selected]?.id;
      config = result; draft = structuredClone(result.locations); savedIds = new Set(draft.map((l) => l.id));
      selected = Math.max(0, draft.findIndex((l) => l.id === oldId));
      dirty = false; render(); $('labelConfigFields').disabled = false;
      status(message || 'Label configuration loaded.');
      void loadStockLocations();
    } catch (e) { status(e.message, true); }
  }
  $('labelEditor').addEventListener('input', () => { try { readEditor(); choices(); changed(); } catch (e) { status(e.message, true); } });
  $('labelEditor').addEventListener('change', () => {
    try { readEditor(); choices(); changed(); } catch (e) { status(e.message, true); }
  });
  $('labelConfigSelect').addEventListener('change', () => {
    try { readEditor(); selected = Number($('labelConfigSelect').value); render(); }
    catch (e) { $('labelConfigSelect').value = String(selected); status(e.message, true); }
  });
  function add(duplicate) {
    try {
      readEditor();
      const id = 'label-' + crypto.randomUUID();
      const loc = duplicate ? { ...structuredClone(draft[selected]), id, name: draft[selected].name + ' copy', modeGroup: id }
        : { id, name: 'New label', group: draft[selected]?.group || '', models: [] };
      draft.push(loc); selected = draft.length - 1; render(); changed();
    } catch (e) { status(e.message, true); }
  }
  $('addLabel').addEventListener('click', () => add(false));
  $('duplicateLabel').addEventListener('click', () => add(true));
  $('removeLabel').addEventListener('click', () => {
    if (draft.length <= 1) return;
    draft.splice(selected, 1); selected = Math.min(selected, draft.length - 1); render(); changed();
  });
  function move(direction) {
    try {
      readEditor(); const next = selected + direction;
      if (next < 0 || next >= draft.length) return;
      [draft[selected], draft[next]] = [draft[next], draft[selected]]; selected = next; render(); changed();
    } catch (e) { status(e.message, true); }
  }
  $('labelMoveUp').addEventListener('click', () => move(-1));
  $('labelMoveDown').addEventListener('click', () => move(1));
  $('reloadLabelConfig').addEventListener('click', () => load('Label edits discarded.'));
  $('reloadStockLocations').addEventListener('click', () => { void loadStockLocations(); });
  $('reloadSettings').addEventListener('click', () => load());
  $('labelConfigForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy || !config) return;
    try {
      readEditor(); busy = true; $('labelConfigFields').disabled = true; status('Saving label configuration…');
      const saved = await api('/locations', { method: 'PUT', body: { locations: draft, revision: config.revision } });
      if (!Array.isArray(saved.locations) || !saved.revision) throw new Error('The label configuration was not saved. Restart the updated app and reload settings.');
      config = saved; draft = structuredClone(saved.locations); savedIds = new Set(draft.map((l) => l.id));
      dirty = false; render(); status('Label configuration saved. Return to printing to load the updated labels.');
      window.dispatchEvent(new Event('label-configuration-saved'));
      void loadSettings('Label configuration saved. Assign printers to any new labels above.');
    } catch (e) { status(e.message, true); }
    finally { busy = false; $('labelConfigFields').disabled = false; }
  });
  window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  void load();
})();
