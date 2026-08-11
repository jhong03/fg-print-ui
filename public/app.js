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
const previewNote = document.getElementById('previewNote');
const tsplPanel = document.getElementById('tsplPanel');
const tsplView = document.getElementById('tsplView');
const tsplCopy = document.getElementById('tsplCopy');
const reloadTplBtn = document.getElementById('reloadTplBtn');
const tabs = document.getElementById('tabs');
const masterTabs = document.getElementById('masterTabs');

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
let currentLocation = null;   // { id, name, group, templateId, variant } or null
let locationName = {};        // id -> friendly name, for labelling queued jobs
let allLocations = [];        // every destination from /api/locations
let currentGroup = null;      // the selected master tab (group)

// Group helpers. A location with no `group` falls into "Other".
const groupOf = (loc) => (loc && loc.group) || 'Other';
function groupList() {
  const seen = [];
  allLocations.forEach((l) => { const g = groupOf(l); if (!seen.includes(g)) seen.push(g); });
  return seen;
}
const locsInGroup = (g) => allLocations.filter((l) => groupOf(l) === g);

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

  allLocations = list;
  // id -> name, so the queue can label each job with its destination.
  locationName = Object.fromEntries(list.map((l) => [l.id, l.name]));

  const savedId = localStorage.getItem(LOC_KEY);
  currentLocation = list.find((l) => l.id === savedId) || list[0];
  currentGroup = groupOf(currentLocation);
  renderMasterTabs();
  renderSubTabs();
}

// Master tabs = the distinct groups (e.g. P1 / P3). Hidden when there's only one
// group (no point categorising a single bucket).
function renderMasterTabs() {
  const groups = groupList();
  if (groups.length <= 1) { masterTabs.hidden = true; masterTabs.innerHTML = ''; return; }
  masterTabs.innerHTML = '';
  groups.forEach((g) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tab tab--master';
    btn.setAttribute('role', 'tab');
    btn.dataset.group = g;
    btn.textContent = g;
    btn.addEventListener('click', () => selectGroup(g));
    masterTabs.appendChild(btn);
  });
  masterTabs.hidden = false;
  markMasterTabs();
}

// Sub tabs = the destinations inside the current group. Hidden when the group has a
// single destination (the master tab already IS that destination).
function renderSubTabs() {
  const locs = locsInGroup(currentGroup);
  if (locs.length <= 1) { tabs.hidden = true; tabs.innerHTML = ''; return; }
  tabs.innerHTML = '';
  locs.forEach((loc) => {
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

function markMasterTabs() {
  masterTabs.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.group === currentGroup;
    b.classList.toggle('tab--active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function markActiveTab() {
  const id = currentLocation ? currentLocation.id : null;
  tabs.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.id === id;
    b.classList.toggle('tab--active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

// Pick a master group: switch to its destinations and select one (keep the current
// destination if it's in this group, else its first).
function selectGroup(g) {
  if (g === currentGroup) return;
  currentGroup = g;
  markMasterTabs();
  renderSubTabs();
  const locs = locsInGroup(g);
  const target = locs.find((l) => l.id === currentLocation?.id) || locs[0];
  if (target) selectLocation(target);
}

function selectLocation(loc) {
  if (currentLocation && loc.id === currentLocation.id) { markActiveTab(); return; }
  currentLocation = loc;
  localStorage.setItem(LOC_KEY, loc.id);
  // Keep the master tab + sub bar in sync if this selection changed the group.
  if (groupOf(loc) !== currentGroup) {
    currentGroup = groupOf(loc);
    markMasterTabs();
    renderSubTabs();
  }
  markActiveTab();
  // The template + variant just changed, so anything on screen is now stale.
  if (currentJtc) {
    renderLabelPreview(currentJtc, labelMount, currentLocation);
    if (!tsplPanel.hidden) refreshTspl();
  }
  // Reset binding selection so the new tab shows its own staged work (front item).
  selectedBindingId = null;
  bindingCleared = false;
  lastMaxBindingId = 0;
  refreshBinding();        // pick up the new tab's staged work (if any)
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
let suppressTapDropdown = false;   // skip the tap-dropdown during a programmatic focus()

input.addEventListener('paste', () => { pasted = true; });

// Touchscreen support: the workcells have NO keyboard, so tapping the JTC field
// opens the dropdown to pick from — recent JTCs for this tab's model when empty, or
// matches for the current text. Bound to CLICK/TAP ONLY (not focus): a scan's
// programmatic focus() must never pop the list — only a deliberate tap does.
function openSuggestionsOnTap() {
  if (suppressTapDropdown) return;   // guard: a programmatic focus/select, not a tap
  const q = input.value.trim();
  input.select();               // select any existing text so a scan/tap replaces it
  if (q) runSearch(q); else showRecent();
}
input.addEventListener('click', openSuggestionsOnTap);

// Empty-query search = the most recent JTCs for this tab's model, to tap from.
async function showRecent() {
  try {
    const res = await fetch('/api/jtc/search?q=' + locQuery());
    if (!res.ok) return;
    const rows = await res.json();
    // Only show if the operator is still on an empty field (didn't scan/type since).
    if (document.activeElement === input && !input.value.trim()) renderSuggestions(rows);
  } catch (_) { /* transient; a later tap retries */ }
}

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
  // A scanned QR TAG (bare 4-digit WDSS) is a binding scan, not a JTC lookup —
  // route it to the QR gate, clear the box, and blur so the dropdown doesn't cover
  // the preview (the next scan is caught by global capture, which needs no focus).
  if (isQrToken(q)) { bindingScan(q); input.value = ''; settleAfterScan(); return; }
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
  // On a QR-gated tab the preview is driven by the binding list (selected item),
  // so DON'T renderLabel here — just stage it (avoids a second, conflicting draw).
  if (!currentLocation?.requireQrBinding) renderLabel(record);
  // A scan queues the print hands-free — no button press. (Manual lookups still
  // wait for the Print Label button.) On a QR tab this stages for binding instead.
  enqueuePrint(record.jtcNo || q, { fromScan: true });
  settleAfterScan();   // blur + hide dropdown so the preview stays clear
}

// After a scan/selection resolves, CLEAR the field, drop the dropdown, and release
// focus. Clearing is essential: the current JTC lives in the preview + binding list,
// NOT the box — leaving its text there means the next scan (e.g. a QR rebind 2102)
// APPENDS to it ("…WF2102") and reads as a bad JTC. Empty + blurred means every
// following scan is fresh: a JTC loads, a 4-digit QR rebinds. Tap the field to bring
// the pick-list back for a manual choice.
function settleAfterScan() {
  input.value = '';
  hideSuggestions();
  input.blur();
}

// ---- Global scan capture (touchscreen kiosks: no keyboard) -----------------
/*
 * Operators may tap a button/panel and lose focus on the JTC field, so a scan would
 * otherwise land nowhere. This routes ANY scan to the right place regardless of what's
 * focused within the app — but only when the field ISN'T already focused (that path
 * owns its input, including the device's on-screen keyboard). Only fast bursts
 * accumulate (a >300ms gap resets the buffer), so slow on-screen typing elsewhere is
 * ignored. Completion = an Enter terminator OR a burst-then-pause, so either scanner
 * mode works. Scan chars are swallowed (preventDefault) so they can't stray-trigger a
 * focused control — JTCs contain spaces, and Space/Enter would "click" a button. This
 * listener lives on OUR document, so it's inert once focus leaves the app / it closes.
 * Nothing here touches the server-side job-end auto-print trigger.
 */
let scanBuf = '';
let scanLastAt = 0;
let scanBufTimer = null;
const SCAN_RESET_MS = 300;    // a gap bigger than this starts a fresh buffer
const GLOBAL_SETTLE_MS = 120; // no-Enter scanners: accept after this quiet gap

document.addEventListener('keydown', (e) => {
  if (document.activeElement === input) return;   // the field owns its own input
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const now = performance.now();
  const gap = now - scanLastAt;
  scanLastAt = now;

  if (e.key === 'Enter' || e.key === 'Tab') {     // scanner terminators (either kind)
    if (scanBuf.length >= SCAN_MIN_LEN) { e.preventDefault(); const v = scanBuf; scanBuf = ''; routeGlobalScan(v); }
    else scanBuf = '';                            // empty buffer -> let Enter/Tab act normally
    return;
  }
  if (e.key.length !== 1) return;                 // Shift, arrows, F-keys, etc.

  if (gap > SCAN_RESET_MS) scanBuf = '';          // too slow to be the same scan
  scanBuf += e.key;
  // Once it's clearly a fast burst, swallow keys so the scan can't drive buttons.
  if (gap < SCAN_GAP_MS && scanBuf.length >= 2) e.preventDefault();

  clearTimeout(scanBufTimer);
  scanBufTimer = setTimeout(() => {
    const v = scanBuf; scanBuf = '';
    if (v.length >= SCAN_MIN_LEN) routeGlobalScan(v);
  }, GLOBAL_SETTLE_MS);
});

// A globally-captured scan: a QR tag drives the current tab's binding; a JTC fills the
// field + loads/queues it — exactly like scanning into the field.
function routeGlobalScan(v) {
  const val = v.trim();
  if (!val) return;
  if (isQrToken(val)) { bindingScan(val); return; }
  suppressTapDropdown = true;                 // don't pop the dropdown from focus() below
  input.focus({ preventScroll: true });
  input.value = val;
  acceptScan(val).finally(() => { suppressTapDropdown = false; });
}

async function runSearch(q) {
  try {
    const res = await fetch('/api/jtc/search?q=' + encodeURIComponent(q) + locQuery());
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
    const raw = input.value.trim();
    // A QR tag scanned with an Enter suffix is a binding scan, not a JTC.
    if (isQrToken(raw)) { bindingScan(raw); input.value = ''; return; }
    // Highlighted suggestion wins; otherwise take the raw value.
    // Barcode scanners type the whole code then send Enter — this loads it.
    if (activeIndex >= 0 && currentList[activeIndex]) {
      selectJtc(currentList[activeIndex].jtcNo);
    } else if (raw) {
      selectJtc(raw);
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
    // QR-gated tab: ENTERING a JTC (typed + Enter, or a suggestion click) STAGES
    // it and lets the binding list drive the (single) preview — so don't renderLabel
    // here (that was the second, conflicting draw). Non-QR tabs render as before.
    if (currentLocation?.requireQrBinding) {
      enqueuePrint(record.jtcNo, { fromScan: false });
    } else {
      renderLabel(record);
      setStatus('');
    }
    // Blur + hide the dropdown so the preview stays clear (same as the scan path).
    // The next scan replaces the value via global capture — nothing lost by not
    // keeping the field selected.
    settleAfterScan();
  } catch (e) {
    showEmpty();
    setStatus(e.message, true);
  }
}

async function renderLabel(r) {
  currentJtc = r.jtcNo || null;
  hideTspl();
  emptyState.hidden = true;
  label.hidden = false;
  actions.hidden = false;
  // Draw the preview from the live template model so it matches the printed
  // label's geometry (positions + dimensions) for the selected destination.
  const model = await renderLabelPreview(currentJtc, labelMount, currentLocation);
  showProvenance(model);
}

// When the shown label was resolved from another JTC (Welding Leak-Test -> its
// Painting parent), tell the operator what they're actually looking at + printing.
function showProvenance(model) {
  if (model?.sourceJtc) {
    previewNote.hidden = false;
    previewNote.textContent =
      'Showing Painting Line label ' + (model.printJtc || '') + ' — from Welding JTC ' + model.sourceJtc;
  } else {
    previewNote.hidden = true;
    previewNote.textContent = '';
  }
}

function showEmpty() {
  currentJtc = null;
  label.hidden = true;
  actions.hidden = true;
  emptyState.hidden = false;
  showProvenance(null);
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

// Manual print: the button queues the currently-shown JTC. On a QR-gated tab it
// instead releases the bound job (gated — disabled until both tags are scanned).
printBtn.addEventListener('click', () => {
  if (currentLocation?.requireQrBinding) { bindingReleasePrint(); return; }
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
    // QR-gated tab: the server STAGED the job instead of queuing it. Surface the
    // task-list; nothing prints until Green + Red are scanned.
    if (body.binding) {
      // Select the just-staged job so its (single) preview shows and scans target it.
      if (body.id != null) selectedBindingId = body.id;
      bindingCleared = false;
      setStatus('Staged — scan the Green (Start) and Red (End) QR tags to release the label.');
      await refreshBinding();
      return;
    }
    const verb = fromScan ? 'Scanned & queued' : 'Queued';
    const queued = body.printJtc || jtcNo;
    // If a Welding JTC resolved to its Painting parent, say so.
    const from = body.sourceJtc ? ' (painting of ' + body.sourceJtc + ')' : '';
    setStatus(body.paused
      ? verb + ' ' + queued + from + ' — queue is paused, press Resume to print.'
      : verb + ' ' + queued + from + ' for printing.');
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
  // Clear resets ONLY the JTC field + preview. It does NOT clear the binding queue —
  // staged jobs persist; on a QR tab this just deselects (blank preview, rows stay).
  // Remove staged jobs individually with the ✕ on each row.
  if (currentLocation?.requireQrBinding) {
    selectedBindingId = null;
    bindingCleared = true;
    refreshBinding();   // re-render the rows unselected
  }
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
const clearAllBtn = document.getElementById('clearAllBtn');

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

  // Only offer Resume when there's actually a held backlog. A paused-but-empty
  // queue has nothing to resume (and a stale in-flight poll can't re-show it).
  resumeBtn.hidden = !(q.paused && pending.length);
  pauseBtn.hidden = q.paused || !pending.length;
  clearQueueBtn.hidden = !q.jobs.some((j) => j.status === 'done' || j.status === 'error');
  // "Clear queue" (discard the whole backlog) only when there's pending work.
  clearAllBtn.hidden = !pending.length;

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

    // JTC + optional provenance ("from <welding JTC>") stacked in one column.
    const jtcWrap = document.createElement('div');
    jtcWrap.className = 'q-jtcwrap';
    const jtc = document.createElement('span');
    jtc.className = 'q-jtc';
    jtc.textContent = j.jtcNo;
    jtcWrap.appendChild(jtc);
    if (j.sourceJtc) {
      const src = document.createElement('span');
      src.className = 'q-source';
      src.textContent = '↳ from ' + j.sourceJtc;
      jtcWrap.appendChild(src);
    }

    const type = document.createElement('span');
    type.className = 'q-type';
    type.textContent = locationName[j.location] || j.location || '';

    const st = document.createElement('span');
    st.className = 'q-status';
    st.textContent = j.error ? (STATUS_LABEL[j.status] + ': ' + j.error) : STATUS_LABEL[j.status];

    li.append(n, jtcWrap, type, st);
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
// Destructive: drops jobs still waiting to print, so confirm first.
clearAllBtn.addEventListener('click', () => {
  if (confirm('Clear the entire print queue, including jobs still waiting to print? This cannot be undone.')) {
    queueAction('clear-all');
  }
});

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

// ---- QR binding gate (phase 2) --------------------------------------------
/*
 * On a requireQrBinding tab, a job is STAGED (by the auto-watcher or a manual
 * scan) and shown here as a task-list. The operator scans this workcell's Green
 * (Start) and Red (End) engraved QR tags; only when both validate does the label
 * go to the print queue. A wrong/other-workcell tag is rejected (no lockout).
 * QR tags scan as a bare 4-digit number `WDSS` (W=workcell, D=1 Start/2 End,
 * SS=sequence; Start/End must share SS), which the scan handlers route here.
 */
const bindingPanel = document.getElementById('bindingPanel');
const bindingList = document.getElementById('bindingList');
const bindingState = document.getElementById('bindingState');
const bindingError = document.getElementById('bindingError');

// A QR workcell tag is a bare 4-digit number (WDSS). It only MEANS a binding scan
// on a QR-gated tab — elsewhere 4 digits are just a normal search term.
const QR_TOKEN_RE = /^\d{4}$/;
function isQrToken(v) {
  return !!currentLocation?.requireQrBinding && QR_TOKEN_RE.test(String(v || '').trim());
}

let bindingReleasing = false; // guards the one-shot auto-release on full binding
let selectedBindingId = null; // which staged item the preview + scan + print target
let bindingCleared = false;   // Clear deselects (blank preview) without touching the queue
let lastMaxBindingId = 0;     // detect newly-staged jobs (ids ascend) to re-surface them

function bindLocQuery() {
  return currentLocation ? '?location=' + encodeURIComponent(currentLocation.id) : '';
}

async function refreshBinding() {
  if (!currentLocation?.requireQrBinding) { renderBinding([]); return; }
  try {
    const r = await (await fetch('/api/binding' + bindLocQuery())).json();
    renderBinding(r.jobs || []);
  } catch (_) { /* transient; the poll retries */ }
}

function renderBinding(jobs) {
  // Non-QR tab (or none staged): keep the panel hidden and the Print button normal.
  if (!currentLocation?.requireQrBinding) {
    bindingPanel.hidden = true;
    printBtn.disabled = false;
    printBtn.textContent = 'Print label';
    return;
  }
  bindingPanel.hidden = jobs.length === 0;

  // A newly-staged job (ids ascend) re-surfaces the preview even after a Clear.
  const maxId = jobs.reduce((m, j) => Math.max(m, j.id), 0);
  if (maxId > lastMaxBindingId) { lastMaxBindingId = maxId; bindingCleared = false; }

  // The SELECTED item drives everything (one preview, one scan/print target).
  // Default to the front item UNLESS the operator hit Clear (then nothing is
  // selected → blank preview, but the queue rows stay). Keep the selection valid
  // if the previously-selected item was printed away / removed.
  let sel = jobs.find((j) => j.id === selectedBindingId);
  if (!sel && !bindingCleared) { sel = jobs[0] || null; selectedBindingId = sel ? sel.id : null; }
  if (!sel) selectedBindingId = null;

  // ONE preview, driven ONLY by the selected item (never by a separate manual
  // render — that was the double-preview bug). Render from the welding JTC
  // (sourceJtc) so the server applies welding->painting + SB prepend and returns
  // provenance. Guard on currentJtc so we don't redraw what's already shown.
  const previewJtc = sel ? (sel.sourceJtc || sel.paintingJtc) : null;
  if (previewJtc && previewJtc !== currentJtc) {
    currentJtc = previewJtc;
    emptyState.hidden = true;
    label.hidden = false;
    actions.hidden = false;
    renderLabelPreview(previewJtc, labelMount, currentLocation).then(showProvenance);
  }

  // Gate the Print button + header to the SELECTED item.
  if (sel) {
    const complete = sel.boundStart && sel.boundEnd;
    printBtn.disabled = !complete;
    printBtn.textContent = complete ? (sel.printed ? 'Reprint label' : 'Print label') : 'Scan QR to print';
    const done = (sel.boundStart ? 1 : 0) + (sel.boundEnd ? 1 : 0);
    bindingState.textContent = sel.printed
      ? 'Sent to print queue'
      : (done === 2 ? 'Ready' : done + '/2 tags scanned');
  } else {
    bindingState.textContent = '';
  }

  // Rows: click a row to select it (its preview shows and its tags are what the
  // next scan binds). The SELECTED row shows the Green/Red task-list.
  bindingList.innerHTML = '';
  jobs.forEach((j) => {
    const isSel = j.id === selectedBindingId;
    const li = document.createElement('li');
    li.className = 'b-item' + (isSel ? ' b-item--active' : '');
    li.addEventListener('click', () => {
      selectedBindingId = j.id;
      bindingCleared = false;
      renderBinding(jobs);
    });

    const head = document.createElement('div');
    head.className = 'b-head';
    const jtc = document.createElement('span');
    jtc.className = 'b-jtc';
    jtc.textContent = j.paintingJtc + (j.printed ? '  · sent' : (isSel ? '' : '  · waiting'));
    head.appendChild(jtc);
    if (j.sourceJtc) {
      const src = document.createElement('span');
      src.className = 'b-source';
      src.textContent = '↳ from ' + j.sourceJtc;
      head.appendChild(src);
    }

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'b-remove';
    rm.title = 'Remove from binding queue';
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeBinding(j.id); });

    li.append(head, rm);

    if (isSel) {
      const tasks = document.createElement('div');
      tasks.className = 'b-tasks';
      // Only the 2nd digit gates direction, so there's no fixed "expected" tag.
      // Show the actual scanned number under each pill once it's bound.
      tasks.append(
        taskPill('green', 'Green · Start', j.boundStart, j.startTag ? String(j.startTag) : ''),
        taskPill('red', 'Red · End', j.boundEnd, j.endTag ? String(j.endTag) : '')
      );
      li.insertBefore(tasks, rm);
    }
    bindingList.appendChild(li);
  });

  // Auto-release once the SELECTED item's tags are both in (hands-free path); the
  // Print button is the manual equivalent. The server's `printed` flag stops repeats.
  if (sel && sel.boundStart && sel.boundEnd && !sel.printed && !bindingReleasing) {
    bindingReleasing = true;
    bindingReleasePrint().finally(() => { bindingReleasing = false; });
  }
}

function taskPill(colour, text, done, hint) {
  const s = document.createElement('span');
  s.className = 'b-pill b-pill--' + colour + (done ? ' b-pill--done' : '');
  const label = document.createElement('span');
  label.textContent = (done ? '☑ ' : '☐ ') + text;
  s.appendChild(label);
  if (hint) {
    const h = document.createElement('small');
    h.className = 'b-pill-exp';
    h.textContent = hint;
    s.appendChild(h);
  }
  return s;
}

async function bindingScan(token) {
  try {
    const res = await fetch('/api/binding/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: currentLocation?.id, token, id: selectedBindingId }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.ok) { hideBindingError(); }
    else { showBindingError(body.error || 'QR tag rejected.'); }
    await refreshBinding();
  } catch (e) {
    showBindingError(e.message);
  }
  input.focus();
}

async function bindingReleasePrint() {
  try {
    const res = await fetch('/api/binding/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ location: currentLocation?.id, id: selectedBindingId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) { showBindingError(body.error || 'Could not release the label.'); return; }
    hideBindingError();
    setStatus('QR bound — Work Order label sent to the print queue.');
    renderBinding(body.jobs || []);
    refreshQueue();
  } catch (e) {
    showBindingError(e.message);
  }
}

async function removeBinding(id) {
  try {
    const r = await (await fetch('/api/binding/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, location: currentLocation?.id }),
    })).json();
    renderBinding(r.jobs || []);
  } catch (e) {
    showBindingError(e.message);
  }
}

function showBindingError(msg) {
  bindingError.hidden = false;
  bindingError.textContent = msg;
}
function hideBindingError() {
  bindingError.hidden = true;
  bindingError.textContent = '';
}

refreshBinding();
setInterval(refreshBinding, 2000);
