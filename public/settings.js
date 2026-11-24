'use strict';
const $ = (id) => document.getElementById(id);
let state = null;
let draftPrinters = [];
let savedIds = new Set();
let saving = false;
const visibilityRestartMessage = 'Restart fg-print-ui, then reload this page to enable individual label visibility.';
const cardElements = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path = '', options = {}) {
  const response = await fetch('/api/settings' + path, { ...options,
    headers: { 'X-Print-UI-Settings': '1', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || (response.status === 404 ? 'Restart fg-print-ui to enable Printer settings.' : 'Settings request failed'));
  return body;
}
function notice(text, error = false) { $('settingsStatus').textContent = text; $('settingsStatus').classList.toggle('error', error); }
function option(value, text) { const node = document.createElement('option'); node.value = value; node.textContent = text; return node; }
function readCards() {
  return [...$('printersList').children].map((card) => {
    const field = (name) => card.querySelector('[data-field="' + name + '"]');
    const type = field('connection').value;
    return { id: field('id').value.trim(), name: field('name').value.trim(), enabled: field('enabled').checked,
      protocol: field('protocol').value, timeoutMs: Number(field('timeout').value),
      connection: type === 'windows' ? { type, shareName: field('share').value.trim() }
        : { type, host: field('host').value.trim(), port: Number(field('port').value) } };
  });
}
function refreshDefaults() {
  const selected = $('defaultPrinter').value || state?.agentState?.config.defaultPrinterId || '';
  $('defaultPrinter').replaceChildren(option('', 'Choose a default printer'));
  for (const p of readCards().filter((p) => p.enabled)) $('defaultPrinter').appendChild(option(p.id, p.name || p.id));
  $('defaultPrinter').value = selected;
}
function renderPrinters() {
  $('printersList').replaceChildren(); cardElements.clear();
  for (const p of draftPrinters) {
    const card = document.createElement('article'); card.className = 'printer-card';
    card.innerHTML = '<div class="section-heading"><h3></h3><label class="checkbox-label"><input type="checkbox" data-field="enabled">Enabled</label></div>'
      + '<div class="settings-grid">'
      + '<label>Printer name<input data-field="name" required maxlength="128"><span class="help">Friendly name shown in this app.</span></label>'
      + '<label>Printer ID<input data-field="id" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}"></label>'
      + '<label>Printer language<select data-field="protocol"><option value="tspl">TSPL label printer</option><option value="escpos">ESC/POS receipt printer</option></select></label>'
      + '<label>Connection<select data-field="connection"><option value="windows">Windows printer share</option><option value="tcp">Network TCP</option></select></label>'
      + '<label data-connection="windows" class="printer-destination"><span class="printer-destination-heading"><span>Windows share name</span><span class="printer-destination-badge">Must match Windows</span></span><input data-field="share" aria-label="Windows share name" list="windowsShares" placeholder="Exact Windows share name, e.g. TSC_FG"><span class="printer-destination-help" data-share-help>Determines which physical printer receives the job. Copy the exact Share name from Windows printer properties → Sharing.</span></label>'
      + '<label data-connection="tcp">Printer IP or hostname<input data-field="host" placeholder="192.168.1.88"></label>'
      + '<label data-connection="tcp">TCP port<input data-field="port" type="number" min="1" max="65535"></label>'
      + '<label>Connection timeout in milliseconds<input data-field="timeout" type="number" min="100" max="60000" required></label></div>'
      + '<div class="printer-actions"><button type="button" data-action="status" class="btn btn--sm btn--ghost">Check status</button><button type="button" data-action="test" class="btn btn--sm btn--ghost">Test print</button><button type="button" data-action="remove" class="btn btn--sm btn--ghost">Remove</button></div><p class="printer-result" role="status"></p>';
    const field = (name) => card.querySelector('[data-field="' + name + '"]');
    const shareHelp = card.querySelector('[data-share-help]');
    shareHelp.id = 'share-help-' + p.id;
    field('share').setAttribute('aria-describedby', shareHelp.id);
    card.querySelector('h3').textContent = p.name || 'New printer';
    field('id').value = p.id; field('id').disabled = savedIds.has(p.id);
    field('name').value = p.name; field('enabled').checked = p.enabled !== false;
    field('protocol').value = p.protocol; field('connection').value = p.connection.type;
    field('share').value = p.connection.shareName || ''; field('host').value = p.connection.host || '';
    field('port').value = p.connection.port || 9100; field('timeout').value = p.timeoutMs || 5000;
    function connectionFields() {
      for (const label of card.querySelectorAll('[data-connection]')) {
        const active = label.dataset.connection === field('connection').value;
        label.hidden = !active; label.querySelector('input').required = active;
      }
    }
    field('connection').addEventListener('change', connectionFields); connectionFields();
    card.addEventListener('change', refreshDefaults);
    for (const action of ['status', 'test']) {
      const button = card.querySelector('[data-action="' + action + '"]');
      button.disabled = !savedIds.has(p.id);
      button.title = savedIds.has(p.id) ? '' : 'Save this printer first';
      button.addEventListener('click', () => printerAction(p.id, action, card));
    }
    card.querySelector('[data-action="remove"]').addEventListener('click', () => {
      draftPrinters = readCards().filter((x, index) => index !== [...$('printersList').children].indexOf(card));
      renderPrinters();
    });
    $('printersList').appendChild(card); cardElements.set(p.id, card);
  }
  refreshDefaults();
}
function renderGroupVisibility() {
  const list = $('groupVisibilityList'); list.replaceChildren();
  const groups = [...new Set(state.locations.map((loc) => loc.group || 'Other'))];
  for (const group of groups) {
    const section = document.createElement('div'); section.className = 'visibility-group';
    const label = document.createElement('label'); label.className = 'group-visibility-option';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.group = group;
    checkbox.checked = !(state.routing.hiddenGroups || []).includes(group);
    label.append(checkbox, document.createTextNode('Show ' + group)); section.appendChild(label);
    const children = document.createElement('div'); children.className = 'visibility-children';
    for (const loc of state.locations.filter((loc) => (loc.group || 'Other') === group)) {
      const childLabel = document.createElement('label'); childLabel.className = 'group-visibility-option';
      const child = document.createElement('input'); child.type = 'checkbox'; child.dataset.location = loc.id;
      child.checked = !(state.routing.hiddenLocations || []).includes(loc.id);
      childLabel.append(child, document.createTextNode('Show ' + loc.name)); children.appendChild(childLabel);
    }
    section.appendChild(children); list.appendChild(section);
  }
}
function renderAssignments() {
  $('assignmentsList').replaceChildren();
  const printers = state.agentState?.config.printers || [];
  const groups = new Map();
  for (const loc of state.locations) {
    const group = loc.group || 'Other';
    if (!groups.has(group)) {
      const section = document.createElement('section'); section.className = 'assignment-group'; section.dataset.group = group;
      const heading = document.createElement('h3'); heading.textContent = group;
      if ((state.routing.hiddenGroups || []).includes(group)) {
        const note = document.createElement('span'); note.className = 'group-hidden-note'; note.textContent = 'Hidden on operator screen'; heading.appendChild(note);
      }
      section.appendChild(heading); $('assignmentsList').appendChild(section); groups.set(group, section);
    }
    const row = document.createElement('div'); row.className = 'assignment-row';
    const label = document.createElement('label'); label.textContent = loc.name;
    const select = document.createElement('select'); select.id = 'assign-' + loc.id; label.htmlFor = select.id; select.dataset.location = loc.id;
    select.appendChild(option('', 'Default compatible label printer'));
    for (const p of printers.filter((p) => p.enabled && p.protocol === 'tspl')) select.appendChild(option(p.id, p.name));
    if (loc.printerId && !printers.some((p) => p.id === loc.printerId && p.enabled && p.protocol === 'tspl')) select.appendChild(option(loc.printerId, loc.printerId + ' (unavailable)'));
    select.value = loc.printerId || '';
    if (loc.localPrinterSettings === false) {
      select.replaceChildren(option('', 'Configured on a remote print-agent'));
      select.disabled = true;
    }
    row.append(label, select); groups.get(group).appendChild(row);
  }
}
async function loadSettings(message) {
  try {
    state = await api();
    $('agentAddress').value = state.routing.agentUrl;
    $('visibilityFields').disabled = false;
    renderGroupVisibility(); renderAssignments();
    const ready = !!state.agentState;
    $('agentFields').disabled = !ready; $('assignmentFields').disabled = !ready;
    $('agentConnection').textContent = ready ? 'Connected to ' + state.agentState.config.agentId + ' at ' + state.routing.agentUrl : 'Agent settings are unavailable.';
    const visibilityReady = Array.isArray(state.routing.hiddenLocations);
    if (!ready) { notice(visibilityReady ? message || state.agentError : visibilityRestartMessage, !message || !visibilityReady); return; }
    const config = state.agentState.config;
    $('terminalId').value = config.agentId; $('relayAddress').value = config.relayUrl || ''; $('agentPort').value = config.localHttpPort;
    $('scalePort').value = config.scale?.port || ''; $('scaleBaud').value = config.scale?.baud || 9600; $('scaleAuto').checked = config.scale?.modeAuto === true;
    const fields = { agentId: 'terminal ID', relayUrl: 'relay address', localHttpPort: 'HTTP port', scale: 'scale connection' };
    const restart = state.agentState.restartRequired || [];
    $('restartNotice').hidden = !restart.length;
    $('restartNotice').textContent = 'Restart print-agent to apply: ' + restart.map((key) => fields[key] || key).join(', ') + '.';
    draftPrinters = structuredClone(config.printers); savedIds = new Set(draftPrinters.map((p) => p.id));
    $('defaultPrinter').value = config.defaultPrinterId || '';
    renderPrinters(); renderAssignments(); notice(visibilityReady ? message || 'Settings loaded.' : visibilityRestartMessage, !visibilityReady);
  } catch (e) { notice(e.message, true); }
}
async function save(action) {
  if (saving) return; saving = true;
  notice('Saving settings…');
  $('agentFields').disabled = true;
  $('assignmentFields').disabled = true;
  $('visibilityFields').disabled = true;
  $('reloadSettings').disabled = true;
  $('connectionForm').querySelector('button').disabled = true;
  try { await action(); } catch (e) { notice(e.message, true); }
  finally {
    saving = false;
    $('agentFields').disabled = !state?.agentState;
    $('assignmentFields').disabled = !state?.agentState;
    $('visibilityFields').disabled = !state;
    $('reloadSettings').disabled = false;
    $('connectionForm').querySelector('button').disabled = false;
  }
}
async function printerAction(id, action, card) {
  const result = card.querySelector('.printer-result'); result.classList.remove('error');
  if (action === 'test' && !confirm('Print a connection test on this saved printer? TSPL tests use a 50 × 30 mm label; ESC/POS tests print a short receipt.')) return;
  const buttons = card.querySelectorAll('[data-action="status"], [data-action="test"]'); buttons.forEach((b) => { b.disabled = true; });
  try {
    result.textContent = action === 'test' ? 'Sending test…' : 'Checking printer…';
    if (action === 'status') {
      const s = await api('/printers/' + encodeURIComponent(id) + '/status');
      const feedback = printerStatusFeedback(s, state?.agentState?.config.printers.find((p) => p.id === id)?.connection.type);
      result.textContent = feedback.text;
      result.classList.toggle('error', feedback.error);
    } else {
      const accepted = await api('/printers/' + encodeURIComponent(id) + '/test', { method: 'POST', body: { confirm: true } });
      result.textContent = 'Test accepted. Waiting for sending result…';
      for (let i = 0; i < 40; i++) {
        const job = await api('/jobs/' + encodeURIComponent(accepted.jobId));
        if (job.status === 'SUCCESS') { result.textContent = 'Test sent. Confirm it physically came out.'; return; }
        if (job.status === 'FAILED') throw new Error((job.lastError || 'Test failed') + (job.deliveryState === 'unknown' ? '. Check the printer before trying again.' : ''));
        await sleep(1000);
      }
      result.textContent = 'Test is still pending. Check the printer before submitting another test.';
    }
  } catch (e) {
    result.textContent = action === 'status'
      ? printerStatusFeedback({ connected: false, reason: e.message }, state?.agentState?.config.printers.find((p) => p.id === id)?.connection.type).text
      : e.message;
    result.classList.add('error');
  }
  finally { buttons.forEach((b) => { b.disabled = false; }); }
}
$('reloadSettings').addEventListener('click', () => loadSettings());
$('connectionForm').addEventListener('submit', (event) => {
  event.preventDefault(); save(async () => { await api('/connection', { method: 'PUT', body: { agentUrl: $('agentAddress').value, revision: state?.routing.revision } }); await loadSettings('Agent connected.'); });
});
$('addPrinter').addEventListener('click', () => {
  draftPrinters = readCards(); draftPrinters.push({ id: 'printer-' + Date.now().toString(36), name: 'New printer', enabled: true, protocol: 'tspl', connection: { type: 'windows', shareName: '' }, timeoutMs: 5000 }); renderPrinters();
});
$('discoverPrinters').addEventListener('click', async () => {
  $('discoverPrinters').disabled = true;
  try {
    const { printers } = await api('/printers/discover');
    $('windowsShares').replaceChildren(...printers.filter((p) => p.ShareName).map((p) => option(p.ShareName, p.Name)));
    $('discoveryStatus').textContent = printers.length ? printers.map((p) => p.Name + (p.ShareName ? ' — share: ' + p.ShareName : ' — not shared')).join('; ') : 'No Windows printers found.';
  } catch (e) { $('discoveryStatus').textContent = e.message; }
  finally { $('discoverPrinters').disabled = false; }
});
$('agentForm').addEventListener('submit', (event) => {
  event.preventDefault(); save(async () => {
    const config = { ...state.agentState.config, agentId: $('terminalId').value.trim(), relayUrl: $('relayAddress').value.trim(),
      localHttpPort: Number($('agentPort').value), printers: readCards(), defaultPrinterId: $('defaultPrinter').value || null };
    if (config.scale || $('scalePort').value.trim()) config.scale = { port: $('scalePort').value.trim(), baud: Number($('scaleBaud').value), modeAuto: $('scaleAuto').checked };
    await api('/agent', { method: 'PUT', body: { config, revision: state.agentState.revision } });
    await loadSettings('Terminal and printers saved.');
  });
});
$('assignmentsForm').addEventListener('submit', (event) => {
  event.preventDefault(); save(async () => {
    const assignments = Object.fromEntries([...$('assignmentsList').querySelectorAll('select')].filter((s) => !s.disabled).map((s) => [s.dataset.location, s.value || null]));
    await api('/assignments', { method: 'PUT', body: { assignments, revision: state.routing.revision } });
    await loadSettings('Label assignments saved. New jobs will use these printers.');
  });
});
$('visibilityForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!Array.isArray(state?.routing.hiddenLocations)) { notice(visibilityRestartMessage, true); return; }
  save(async () => {
    const hiddenGroups = [...$('groupVisibilityList').querySelectorAll('input[data-group]')].filter((input) => !input.checked).map((input) => input.dataset.group);
    const hiddenLocations = [...$('groupVisibilityList').querySelectorAll('input[data-location]')].filter((input) => !input.checked).map((input) => input.dataset.location);
    const saved = await api('/visibility', { method: 'PUT', body: { hiddenGroups, hiddenLocations, revision: state.routing.revision } });
    if (!Array.isArray(saved.hiddenLocations) || !Array.isArray(saved.hiddenGroups)
      || state.locations.some((loc) => saved.hiddenLocations.includes(loc.id) !== hiddenLocations.includes(loc.id)
        || saved.hiddenGroups.includes(loc.group || 'Other') !== hiddenGroups.includes(loc.group || 'Other'))) {
      throw new Error('Visibility was not saved correctly. ' + visibilityRestartMessage);
    }
    await loadSettings('Visibility saved. Return to printing to see the changes.');
  });
});
loadSettings();
