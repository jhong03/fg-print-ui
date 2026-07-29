'use strict';

// ---- Elements -------------------------------------------------------------
const input = document.getElementById('jtcInput');
const suggestions = document.getElementById('suggestions');
const statusEl = document.getElementById('status');
const emptyState = document.getElementById('emptyState');
const label = document.getElementById('label');
const actions = document.getElementById('actions');
const printBtn = document.getElementById('printBtn');
const previewBtn = document.getElementById('previewBtn');
const clearBtn = document.getElementById('clearBtn');
const labelMount = document.getElementById('labelMount');
const tsplPanel = document.getElementById('tsplPanel');
const tsplView = document.getElementById('tsplView');
const tsplCopy = document.getElementById('tsplCopy');
const reloadTplBtn = document.getElementById('reloadTplBtn');
const tabs = document.getElementById('tabs');

let activeIndex = -1;   // highlighted suggestion for keyboard nav
let currentList = [];   // current suggestion data
let debounceTimer = null;

// ---- Setup ----------------------------------------------------------------
input.focus();
initLocations();

// ---- Destination tabs -----------------------------------------------------
/*
 * Each tab is a print destination (printer + label template + calibration) from
 * /api/locations. The same list ships to every terminal; the operator picks the
 * one for their station and it's remembered here so it survives a reload.
 */
const LOC_KEY = 'jtc.locationId';
let currentLocation = null;   // { id, name, templateId, variant } or null
let locationName = {};        // id -> friendly name, for labelling queued jobs

// The location query string appended to GETs (empty until tabs load; the server
// then falls back to the first tab, so a print is never mis-routed silently).
function locQuery() {
  return currentLocation ? '&location=' + encodeURIComponent(currentLocation.id) : '';
}

async function initLocations() {
  let list;
  try {
    const res = await fetch('/api/locations');
    if (!res.ok) throw new Error('locations ' + res.status);
    list = await res.json();
  } catch (_) {
    return; // no tabs — the server still prints to its default destination
  }
  if (!Array.isArray(list) || !list.length) return;

  // id -> name, so the queue can label each job with its destination.
  locationName = Object.fromEntries(list.map((l) => [l.id, l.name]));

  const savedId = localStorage.getItem(LOC_KEY);
  currentLocation = list.find((l) => l.id === savedId) || list[0];
  if (list.length <= 1) return; // only one destination — no tab bar to show

  tabs.innerHTML = '';
  list.forEach((loc) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab';
    btn.setAttribute('role', 'tab');
    btn.dataset.id = loc.id;
    btn.textContent = loc.name;
    btn.addEventListener('click', () => selectLocation(loc));
    tabs.appendChild(btn);
  });
  tabs.hidden = false;
  markActiveTab();
}

function markActiveTab() {
  const id = currentLocation ? currentLocation.id : null;
  tabs.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.id === id;
    b.classList.toggle('tab--active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function selectLocation(loc) {
  if (currentLocation && loc.id === currentLocation.id) return;
  currentLocation = loc;
  localStorage.setItem(LOC_KEY, loc.id);
  markActiveTab();
  // The template + variant just changed, so anything on screen is now stale.
  if (currentJtc) {
    renderLabelPreview(currentJtc, labelMount, currentLocation);
    if (!tsplPanel.hidden) refreshTspl();
  }
  input.focus();
}

// ---- Scan detection -------------------------------------------------------
/*
 * A scanned code arrives as a whole value, not one character at a time — either
 * as a paste (Ctrl+V, or a scanner in clipboard mode) or as a burst of
 * keystrokes far faster than anyone can type. Either way we accept it straight
 * away instead of waiting for Enter. Hand-typing still gets the suggestion list.
 */
const SCAN_GAP_MS = 40;    // max ms between keystrokes to still count as a burst
const SCAN_MIN_LEN = 4;    // a burst must be this long before it counts as a scan
const SCAN_SETTLE_MS = 60; // wait this long for more characters before accepting
let pasted = false;
let burstLen = 0;
let lastCharAt = 0;

input.addEventListener('paste', () => { pasted = true; });

// ---- Search / suggestions -------------------------------------------------
input.addEventListener('input', (e) => {
  const q = input.value.trim();
  const now = performance.now();
  const gap = now - lastCharAt;
  lastCharAt = now;
  burstLen = gap < SCAN_GAP_MS ? burstLen + 1 : 1;

  clearTimeout(debounceTimer);
  if (!q) { pasted = false; burstLen = 0; hideSuggestions(); return; }

  const isScan = pasted || e.inputType === 'insertFromPaste' || burstLen >= SCAN_MIN_LEN;
  pasted = false;
  debounceTimer = isScan
    ? setTimeout(() => acceptScan(q), SCAN_SETTLE_MS)
    : setTimeout(() => runSearch(q), 180);
});

/*
 * Auto-accept a scanned/pasted value. `no=` resolves either a JTC No or a
 * barcode id, so both forms load directly. If the DB doesn't know it, fall back
 * to the suggestion list rather than showing a "not found" dead end.
 */
async function acceptScan(q) {
  if (input.value.trim() !== q) return;   // superseded while we waited
  hideSuggestions();
  setStatus('Loading ' + q + '…');
  let record;
  try {
    record = await loadJtc(q);
  } catch (err) {
    setStatus(err.message, true);
    return;
  }
  if (input.value.trim() !== q) return;   // operator typed/scanned again
  if (!record) { setStatus(''); runSearch(q); return; }
  // Show the resolved JTC No — a scanned barcode id isn't the order number.
  input.value = record.jtcNo || q;
  renderLabel(record);
  // A scan queues the print hands-free — no button press. (Manual lookups still
  // wait for the Print Label button.)
  enqueuePrint(record.jtcNo || q, { fromScan: true });
  input.select();   // leave it selected so the next scan replaces it
}

async function runSearch(q) {
  try {
    const res = await fetch('/api/jtc/search?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('search failed');
    const rows = await res.json();
    // Ignore stale responses if the box changed while we waited.
    if (input.value.trim() !== q) return;
    renderSuggestions(rows);
  } catch (e) {
    hideSuggestions();
  }
}

function renderSuggestions(rows) {
  currentList = rows;
  activeIndex = -1;
  suggestions.innerHTML = '';

  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 's-empty';
    li.textContent = 'No matching JTC';
    suggestions.appendChild(li);
    suggestions.hidden = false;
    return;
  }

  rows.forEach((row, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.index = i;
    li.innerHTML =
      '<span class="s-jtc"></span><span class="s-part"></span>';
    li.querySelector('.s-jtc').textContent = row.jtcNo;
    li.querySelector('.s-part').textContent = row.partName || '';
    li.addEventListener('mousedown', (ev) => {
      ev.preventDefault();          // keep focus in the input
      selectJtc(row.jtcNo);
    });
    suggestions.appendChild(li);
  });
  suggestions.hidden = false;
}

function hideSuggestions() {
  suggestions.hidden = true;
  suggestions.innerHTML = '';
  currentList = [];
  activeIndex = -1;
}

// ---- Keyboard + scanner ---------------------------------------------------
input.addEventListener('keydown', (e) => {
  const items = Array.from(suggestions.querySelectorAll('li[role="option"]'));

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (!items.length) return;
    activeIndex = (activeIndex + 1) % items.length;
    highlight(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!items.length) return;
    activeIndex = (activeIndex - 1 + items.length) % items.length;
    highlight(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    // Highlighted suggestion wins; otherwise take the raw value.
    // Barcode scanners type the whole code then send Enter — this loads it.
    if (activeIndex >= 0 && currentList[activeIndex]) {
      selectJtc(currentList[activeIndex].jtcNo);
    } else if (input.value.trim()) {
      selectJtc(input.value.trim());
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

function highlight(items) {
  items.forEach((li, i) =>
    li.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false')
  );
  if (activeIndex >= 0) items[activeIndex].scrollIntoView({ block: 'nearest' });
}

// ---- Load + render a record -----------------------------------------------
// Fetches one record. Returns null when the JTC simply isn't there (404);
// throws for real failures so callers can report them.
async function loadJtc(jtcNo) {
  const res = await fetch('/api/jtc?no=' + encodeURIComponent(jtcNo));
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Lookup failed');
  }
  return res.json();
}

async function selectJtc(jtcNo) {
  hideSuggestions();
  input.value = jtcNo;
  setStatus('Loading ' + jtcNo + '…');
  try {
    const record = await loadJtc(jtcNo);
    if (!record) {
      showEmpty();
      setStatus('No job found for ' + jtcNo, true);
      return;
    }
    renderLabel(record);
    setStatus('');
  } catch (e) {
    showEmpty();
    setStatus(e.message, true);
  }
}

function renderLabel(r) {
  currentJtc = r.jtcNo || null;
  hideTspl();
  emptyState.hidden = true;
  label.hidden = false;
  actions.hidden = false;
  // Draw the preview from the live template model so it matches the printed
  // label's geometry (positions + dimensions) for the selected destination.
  renderLabelPreview(currentJtc, labelMount, currentLocation);
}

function showEmpty() {
  currentJtc = null;
  label.hidden = true;
  actions.hidden = true;
  emptyState.hidden = false;
}

function formatDate(v) {
  if (!v) return '';
  // Pass through strings already formatted like dd/mm/yyyy.
  if (typeof v === 'string' && v.includes('/')) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return dd + '/' + mm + '/' + d.getFullYear();
}

function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

// ---- Actions --------------------------------------------------------------
let currentJtc = null;

// Manual print: the button queues the currently-shown JTC.
printBtn.addEventListener('click', () => {
  if (!currentJtc) return;
  enqueuePrint(currentJtc, { fromScan: false });
});

/*
 * Queue a print. Both the scan path and the Print Label button funnel through
 * here, so a job is never printed directly — it always joins the resilient queue
 * that survives printer stalls and power cuts. `fromScan` only tweaks the wording.
 */
async function enqueuePrint(jtcNo, { fromScan } = {}) {
  try {
    const res = await fetch('/api/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jtcNo, location: currentLocation?.id }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || 'Could not queue');
    const verb = fromScan ? 'Scanned & queued' : 'Queued';
    setStatus(body.paused
      ? verb + ' ' + jtcNo + ' — queue is paused, press Resume to print.'
      : verb + ' ' + jtcNo + ' for printing.');
    refreshQueue();
  } catch (e) {
    setStatus(e.message, true);
  }
}

// Fetch the rendered TSPL for the current JTC + destination into the panel.
async function refreshTspl() {
  const res = await fetch('/api/print/preview?no=' + encodeURIComponent(currentJtc) + locQuery());
  const text = await res.text();
  if (!res.ok) throw new Error(text || 'Preview failed');
  tsplView.textContent = text;
}

// Toggle the TSPL preview panel; fetch the rendered code on open.
previewBtn.addEventListener('click', async () => {
  if (!currentJtc) return;
  if (!tsplPanel.hidden) { hideTspl(); return; }
  previewBtn.disabled = true;
  try {
    await refreshTspl();
    tsplPanel.hidden = false;
    previewBtn.textContent = 'Hide TSPL';
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    previewBtn.disabled = false;
  }
});

tsplCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(tsplView.textContent);
    tsplCopy.textContent = 'Copied';
    setTimeout(() => { tsplCopy.textContent = 'Copy'; }, 1500);
  } catch (_) {
    tsplCopy.textContent = 'Copy failed';
    setTimeout(() => { tsplCopy.textContent = 'Copy'; }, 1500);
  }
});

function hideTspl() {
  tsplPanel.hidden = true;
  previewBtn.textContent = 'Preview TSPL';
}

// Pull the latest label design from the MES on demand.
reloadTplBtn.addEventListener('click', async () => {
  reloadTplBtn.disabled = true;
  const original = reloadTplBtn.textContent;
  reloadTplBtn.textContent = 'Reloading…';
  try {
    const res = await fetch('/api/template/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: currentLocation?.id }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) throw new Error(body.error || 'Reload failed');
    const when = body.updatedAt ? ' · updated ' + formatDate(body.updatedAt) : '';
    setStatus('Template reloaded' + (body.name ? ': ' + body.name : '') + when + '.');
    // Reflect the new design: redraw the label, and the TSPL panel if it's open.
    if (currentJtc) {
      renderLabelPreview(currentJtc, labelMount, currentLocation);
      if (!tsplPanel.hidden) await refreshTspl();
    }
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    reloadTplBtn.disabled = false;
    reloadTplBtn.textContent = original;
  }
});

clearBtn.addEventListener('click', () => {
  input.value = '';
  showEmpty();
  hideTspl();
  setStatus('');
  hideSuggestions();
  input.focus();
});

// Close suggestions when clicking away.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search__box')) hideSuggestions();
});

// ---- Print queue ----------------------------------------------------------
/*
 * Shows what's waiting so an operator knows what prints next, and surfaces the
 * paused state after a stall (label/ribbon out, power/comms drop) with a Resume
 * button. The queue lives on the server and survives restarts; we just poll it.
 */
const queuePanel = document.getElementById('queuePanel');
const queueList = document.getElementById('queueList');
const queueState = document.getElementById('queueState');
const queueBanner = document.getElementById('queueBanner');
const autoState = document.getElementById('autoState');
const resumeBtn = document.getElementById('resumeBtn');
const pauseBtn = document.getElementById('pauseBtn');
const clearQueueBtn = document.getElementById('clearQueueBtn');

// Latest auto-print watcher status (null until first /api/auto poll). Kept here
// so renderQueue can keep the panel visible while the station is auto-watching,
// even when the queue itself is momentarily empty.
let autoStatus = null;

// Honest wording: the app only knows a label was handed to the printer (left
// the spooler), NOT that it physically came out — media-out is invisible to
// Windows here. So a finished job is "Sent to printer", never a definitive
// "Printed"; anything not out yet reads as clearly not-done.
const STATUS_LABEL = {
  queued: 'Waiting',
  printing: 'Sending…',
  done: 'Sent to printer',
  error: 'Not printed',
};

async function refreshQueue() {
  let q;
  try {
    q = await (await fetch('/api/queue')).json();
  } catch (_) {
    return; // transient; the poll will retry
  }
  renderQueue(q);
}

function renderQueue(q) {
  const pending = q.jobs.filter((j) => j.status === 'queued' || j.status === 'printing');
  // Hide the panel entirely when there's nothing to show and all is well — but
  // keep it up while this station is auto-watching, so the operator can see it's
  // armed even with an empty queue.
  const autoWatching = !!(autoStatus?.enabled && autoStatus?.started);
  queuePanel.hidden = q.jobs.length === 0 && !q.paused && !autoWatching;

  const next = pending[0];
  if (q.paused && pending.length) {
    queueState.textContent = 'Paused · ' + pending.length + ' waiting';
    queueState.className = 'queue__state queue__state--paused';
    queueBanner.hidden = false;
    queueBanner.textContent =
      'Printer paused. Check labels/ribbon and feed if needed, then Resume'
      + (next ? ' — next: ' + next.jtcNo : '') + '.';
  } else if (pending.length) {
    queueState.textContent = 'Printing · ' + pending.length + ' in queue';
    queueState.className = 'queue__state queue__state--busy';
    queueBanner.hidden = true;
  } else {
    queueState.textContent = 'Idle';
    queueState.className = 'queue__state';
    queueBanner.hidden = true;
  }

  resumeBtn.hidden = !q.paused;
  pauseBtn.hidden = q.paused || !pending.length;
  clearQueueBtn.hidden = !q.jobs.some((j) => j.status === 'done' || j.status === 'error');

  queueList.innerHTML = '';
  // Pending shown in PRINT ORDER with a queue number (#1 = next out); finished
  // jobs follow as history (most recent first), unnumbered.
  const finished = q.jobs.filter((j) => j.status === 'done' || j.status === 'error').reverse();
  const rows = pending.map((j, i) => ({ j, num: i + 1 })).concat(finished.map((j) => ({ j, num: null })));

  rows.forEach(({ j, num }) => {
    const li = document.createElement('li');
    // Flag by problem, not status: a held/queued job carrying an error reads red
    // too, so operators see "not printed" at a glance.
    li.className = 'q-item q-' + j.status + (j.error ? ' q-problem' : '');

    const n = document.createElement('span');
    n.className = 'q-num';
    n.textContent = num ? '#' + num : '';

    const jtc = document.createElement('span');
    jtc.className = 'q-jtc';
    jtc.textContent = j.jtcNo;

    const type = document.createElement('span');
    type.className = 'q-type';
    type.textContent = locationName[j.location] || j.location || '';

    const st = document.createElement('span');
    st.className = 'q-status';
    st.textContent = j.error ? (STATUS_LABEL[j.status] + ': ' + j.error) : STATUS_LABEL[j.status];

    li.append(n, jtc, type, st);
    queueList.appendChild(li);
  });
}

async function queueAction(path) {
  try {
    renderQueue(await (await fetch('/api/queue/' + path, { method: 'POST' })).json());
  } catch (e) {
    setStatus('Queue action failed: ' + e.message, true);
  }
}

resumeBtn.addEventListener('click', () => queueAction('resume'));
pauseBtn.addEventListener('click', () => queueAction('pause'));
clearQueueBtn.addEventListener('click', () => queueAction('clear'));

// ---- Auto-print status badge ----------------------------------------------
// Shows whether THIS station is auto-watching for completed jobs, which
// destinations it serves, and when it last checked — so an operator can see the
// hands-free path is armed without reading logs.
async function refreshAuto() {
  try {
    autoStatus = await (await fetch('/api/auto')).json();
  } catch (_) {
    return; // transient; the poll will retry
  }
  renderAuto();
}

function renderAuto() {
  if (!autoStatus?.enabled) { autoState.hidden = true; return; }
  autoState.hidden = false;
  const names = (autoStatus.ownedLocations || [])
    .map((id) => locationName[id] || id)
    .join(', ') || '(none configured)';
  const t = autoStatus.lastPoll ? new Date(autoStatus.lastPoll).toLocaleTimeString() : '—';
  let txt = 'Auto-print: watching ' + names + ' · checked ' + t;
  autoState.classList.toggle('queue__auto--err', !!autoStatus.lastError);
  if (autoStatus.lastError) txt += ' · error';
  autoState.textContent = txt;
  autoState.title = autoStatus.lastError || '';
}

refreshQueue();
setInterval(refreshQueue, 2000);
refreshAuto();
setInterval(refreshAuto, 5000);
