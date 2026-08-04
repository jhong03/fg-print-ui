/*
 * Pending-binding queue (phase 2 — QR gate).
 *
 * Some tabs (locations.json `requireQrBinding:true`, e.g. P3 Work Order) must NOT
 * print a label straight away. A completed/entered job on such a tab is STAGED
 * here first; the operator has to physically scan the workcell's Green (Start) and
 * Red (End) engraved QR tags before the label is released to the real print queue.
 * This is a compliance interlock, not an MES integration — the AI cameras detect
 * the physical start/end independently; we only gate our own printing.
 *
 * Validation is workcell-interlocked: the two tags are engraved with
 *   <qrWorkcell>:START   (Green)      <qrWorkcell>:END   (Red)
 * so a wrong-workcell tag or a swapped colour fails the match and is rejected
 * (no lockout — the operator just rescans the correct one).
 *
 * Model: one job runs per workcell, so a location has ONE active (front) item;
 * further triggers queue BEHIND it and only become active once the front item is
 * cleared/removed. The scan flags live only in memory (transient unlock); the item
 * list is PERSISTED so a restart never loses a staged job.
 *
 * On full binding the item is handed to the existing print queue (printQueue.add),
 * inheriting all of its resilience — nothing about printing changes here.
 */

const fs = require('node:fs');
const path = require('node:path');

const printQueue = require('./printQueue');
const locations = require('./locations');

const FILE = path.join(__dirname, '..', 'binding-jobs.json');

let jobs = [];
let seq = 0;

// ---- persistence ----------------------------------------------------------
function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify({ jobs }, null, 2));
  } catch (err) {
    console.error('[binding] could not persist:', err.message);
  }
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    jobs = Array.isArray(saved.jobs) ? saved.jobs : [];
    seq = jobs.reduce((m, j) => Math.max(m, Number(j.id) || 0), 0);
  } catch (_) {
    jobs = [];
  }
}

// ---- helpers --------------------------------------------------------------
// The expected Green/Red scans for a location, derived from its qrWorkcell token.
// Returns null when the tab has no qrWorkcell (misconfiguration).
function expectedTokens(loc) {
  const wc = loc && String(loc.qrWorkcell || '').trim();
  if (!wc) return null;
  return { workcell: wc, start: `${wc}:START`.toUpperCase(), end: `${wc}:END`.toUpperCase() };
}

// The item the operator is acting on: the one they SELECTED (by id) in the list,
// or the front (oldest) item when no id is given. The queue keeps its order; the
// selection just chooses which staged job the preview/scan/print apply to.
function itemFor(location, id) {
  const forLoc = jobs.filter((j) => j.location === location);
  if (id != null && id !== '') {
    return forLoc.find((j) => j.id === Number(id)) || null;
  }
  return forLoc[0] || null;
}

// Public snapshot for the UI, per location: the active item is marked so the
// front-end shows its checklist; the rest render as "waiting".
function list(location) {
  const forLoc = location ? jobs.filter((j) => j.location === location) : jobs;
  const activeId = location && forLoc.length ? forLoc[0].id : null;
  return forLoc.map((j) => ({
    id: j.id,
    paintingJtc: j.paintingJtc,
    sourceJtc: j.sourceJtc || null,
    location: j.location,
    boundStart: !!j.boundStart,
    boundEnd: !!j.boundEnd,
    printed: !!j.printed,
    active: j.id === activeId,
  }));
}

// ---- operations -----------------------------------------------------------
// Stage a job for binding. Deduped by paintingJtc+location so the auto-trigger and
// a manual scan of the same JTC don't create two rows. Returns the (existing or
// new) item's public shape.
function add(paintingJtc, location, sourceJtc) {
  const jtc = String(paintingJtc || '').trim();
  const existing = jobs.find((j) => j.location === location && j.paintingJtc === jtc && !j.printed);
  if (existing) return list(location).find((x) => x.id === existing.id);
  const job = {
    id: ++seq,
    paintingJtc: jtc,
    sourceJtc: sourceJtc ? String(sourceJtc).trim() : null,
    location: location || null,
    boundStart: false,
    boundEnd: false,
    printed: false,
    at: Date.now(),
  };
  jobs.push(job);
  persist();
  return list(location).find((x) => x.id === job.id);
}

// Validate a scanned token against the ACTIVE item's workcell tags and record the
// Start/End bind. Returns { ok, role?, error?, item? }. Never throws on a bad scan
// — a mismatch is a normal, retryable outcome (no lockout).
function scan(location, token, id) {
  const item = itemFor(location, id);
  if (!item) return { ok: false, error: 'No job is waiting for QR binding on this station.' };
  const loc = locations.get(item.location);
  const exp = expectedTokens(loc);
  if (!exp) {
    return { ok: false, error: 'This station has no qrWorkcell configured — cannot validate the QR tag.' };
  }
  const t = String(token || '').trim().toUpperCase();
  if (t === exp.start) {
    item.boundStart = true;
    persist();
    return { ok: true, role: 'start', item: list(location).find((x) => x.id === item.id) };
  }
  if (t === exp.end) {
    item.boundEnd = true;
    persist();
    return { ok: true, role: 'end', item: list(location).find((x) => x.id === item.id) };
  }
  return {
    ok: false,
    error: `Wrong QR tag for ${exp.workcell}. Scan this workcell's Green (Start) or Red (End) tag.`,
    item: list(location).find((x) => x.id === item.id),
  };
}

// Release the ACTIVE item to the real print queue — the gated print. Only succeeds
// when both Green and Red are bound (the compliance gate; there is no bypass). The
// item STAYS (printed=true) so the preview persists until the operator clears it,
// and a manual re-click reprints. Returns { ok, error?, queued? }.
function releasePrint(location, id) {
  const item = itemFor(location, id);
  if (!item) return { ok: false, error: 'No job is waiting for QR binding on this station.' };
  if (!item.boundStart || !item.boundEnd) {
    return { ok: false, error: 'Scan the Green (Start) and Red (End) QR tags before printing.' };
  }
  const r = printQueue.add(item.paintingJtc, item.location, item.sourceJtc);
  item.printed = true;
  persist();
  return { ok: true, queued: true, id: r.id, position: r.position, paused: r.paused };
}

function remove(id) {
  jobs = jobs.filter((j) => j.id !== Number(id));
  persist();
}

// Clear all staged bindings for a location (the operator's "Clear").
function clear(location) {
  jobs = location ? jobs.filter((j) => j.location !== location) : [];
  persist();
}

load();

module.exports = { add, list, scan, releasePrint, remove, clear };
