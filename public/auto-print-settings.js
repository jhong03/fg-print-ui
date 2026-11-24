'use strict';
(() => {
  let state, dirty = false, saving = false, loading = false;
  function message(text, error = false) { $('autoPrintMessage').textContent = text; $('autoPrintMessage').classList.toggle('error', error); }
  function runtime(status) {
    $('autoPrintState').textContent = status.changing ? 'Applying settings…' : !status.enabled ? 'Off' : status.lastError ? 'Needs attention' : status.started ? 'Watching for completions' : 'Not running';
    $('autoPrintLastCheck').textContent = status.lastPoll ? new Date(status.lastPoll).toLocaleString() : 'No check yet';
    $('autoPrintLastJob').textContent = status.lastQueued ? status.lastQueued.jtcNo + ' · ' + status.lastQueued.model : 'No job queued yet';
    $('autoPrintError').hidden = !status.lastError; $('autoPrintError').textContent = status.lastError || '';
  }
  function render() {
    $('autoPrintEnabled').checked = state.enabled; $('autoPrintSeconds').value = state.pollMs / 1000;
    const list = $('autoPrintLabels'); list.replaceChildren();
    for (const loc of state.labels) {
      const row = document.createElement('label'); row.className = 'auto-print-label';
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.location = loc.id;
      input.checked = state.locations.includes(loc.id);
      input.disabled = !input.checked && (loc.manualOnly || !loc.models?.length);
      const content = document.createElement('span'), title = document.createElement('strong'), help = document.createElement('span');
      title.textContent = (loc.group || 'Other') + ' · ' + loc.name;
      help.className = 'help'; help.textContent = loc.manualOnly ? 'Rework — manual only' : !loc.models?.length ? 'Add model filters in Label configuration first.' : loc.models.join(', ') + (loc.requireQrBinding ? ' · Waits for Green/Red QR binding' : ' · Sends to the print queue');
      content.append(title, help); row.append(input, content); list.appendChild(row);
    }
    runtime(state.status);
  }
  async function load() {
    if (loading || saving) return; loading = true;
    $('autoPrintFields').disabled = true; message('Loading Auto Print settings…');
    try {
      const next = await api('/auto-print');
      if (!Array.isArray(next.labels) || !next.revision) throw new Error('Restart the updated app to enable Auto Print settings.');
      state = next; dirty = false; render(); $('autoPrintFields').disabled = false; message('Auto Print settings loaded.');
    } catch (e) { message(e.message, true); }
    finally { loading = false; $('autoPrintFields').disabled = !state; }
  }
  $('autoPrintForm').addEventListener('change', () => { dirty = true; message('Unsaved Auto Print changes. Click Save Auto Print to apply them.'); });
  $('autoPrintForm').addEventListener('input', () => { dirty = true; });
  $('autoPrintForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!state || saving) return;
    const config = { enabled: $('autoPrintEnabled').checked, pollMs: Number($('autoPrintSeconds').value) * 1000,
      locations: [...$('autoPrintLabels').querySelectorAll('input:checked')].map((input) => input.dataset.location) };
    saving = true; $('autoPrintFields').disabled = true; message('Saving Auto Print…');
    try {
      state = await api('/auto-print', { method: 'PUT', body: { config, revision: state.revision } });
      if (!state.revision || !state.status) throw new Error('Auto Print did not confirm the save. Reload its settings.');
      dirty = false; render(); message('Auto Print saved. Changes are active now.');
    } catch (e) { message(e.message, true); }
    finally { saving = false; $('autoPrintFields').disabled = false; }
  });
  $('reloadAutoPrint').addEventListener('click', () => void load());
  $('reloadSettings').addEventListener('click', () => void load());
  window.addEventListener('settings-section-change', (event) => { if (event.detail === 'auto' && !dirty) void load(); });
  window.addEventListener('label-configuration-saved', () => { if (!dirty) void load(); });
  window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  setInterval(async () => {
    if (document.hidden || document.querySelector('[data-settings-panel="auto"]').hidden) return;
    try { const response = await fetch('/api/auto'); if (response.ok) runtime(await response.json()); } catch {}
  }, 5000);
  void load();
})();
