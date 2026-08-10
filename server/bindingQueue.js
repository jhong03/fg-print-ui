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
 * Validation is workcell-interlocked. Each tag is a 4-digit number "WDSS":
 *   W  = workcell number (must equal this tab's qrWorkcell)
 *   D  = direction: 1 = Start (Green), 2 = End (Red)
 *   SS = sequence (a Start/End PAIR shares the same SS — one physical station)
 * e.g. 4101 = workcell 4, Start, seq 01; its partner End is 4201. A wrong-workcell
 * tag, an unknown format, or a Start/End whose SS doesn't match the already-scanned
 * partner is rejected (no lockout — the operator just rescans the correct one).
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
const db = require('./db');
const qrLink = require('./qrLink');

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
// The workcell number a location is gated to. Returns null when unset (misconfig).
function workcellOf(loc) {
  const wc = loc && String(loc.qrWorkcell || '').trim();
  return wc || null;
}

// Decode a numeric QR tag "WDSS" -> { workcell, dir:'start'|'end', seq:'SS' }, or
// null if it isn't a valid 4-digit tag (W any digit, D must be 1 or 2, SS 2 digits).
function decode(token) {
  const m = String(token || '').trim().match(/^(\d)([12])(\d{2})$/);
  if (!m) return null;
  return { workcell: m[1], dir: m[2] === '1' ? 'start' : 'end', seq: m[3] };
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
    startSeq: j.startSeq || null,
    endSeq: j.endSeq || null,
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
    startSeq: null,
    endSeq: null,
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
  const wc = workcellOf(loc);
  const snap = () => list(location).find((x) => x.id === item.id);
  if (!wc) {
    return { ok: false, error: 'This station has no qrWorkcell number configured — cannot validate the QR tag.' };
  }
  const d = decode(token);
  if (!d) {
    return { ok: false, error: 'Unrecognised QR tag — expected a 4-digit workcell tag.', item: snap() };
  }
  // Workcell interlock: the tag's leading digit must be THIS station's number.
  if (d.workcell !== String(wc)) {
    return { ok: false, error: `Wrong workcell: this station is ${wc}, but the tag is for workcell ${d.workcell}.`, item: snap() };
  }
  // Sequence interlock: Start and End must share the same SS (one physical station).
  if (d.dir === 'start') {
    if (item.endSeq && item.endSeq !== d.seq) {
      return { ok: false, error: `Sequence mismatch: End tag is ${item.endSeq}, Start tag is ${d.seq}. Scan the matching Start/End pair.`, item: snap() };
    }
    item.startSeq = d.seq;
    item.boundStart = true;
  } else {
    if (item.startSeq && item.startSeq !== d.seq) {
      return { ok: false, error: `Sequence mismatch: Start tag is ${item.startSeq}, End tag is ${d.seq}. Scan the matching Start/End pair.`, item: snap() };
    }
    item.endSeq = d.seq;
    item.boundEnd = true;
  }
  persist();
  return { ok: true, role: d.dir, seq: d.seq, item: snap() };
}

// Release the ACTIVE item to the real print queue — the gated print. Only succeeds
// when both Green and Red are bound (the compliance gate; there is no bypass). The
// item STAYS (printed=true) so the preview persists until the operator clears it,
// and a manual re-click reprints. Returns { ok, error?, queued? }.
async function releasePrint(location, id) {
  const item = itemFor(location, id);
  if (!item) return { ok: false, error: 'No job is waiting for QR binding on this station.' };
  if (!item.boundStart || !item.boundEnd) {
    return { ok: false, error: 'Scan the Green (Start) and Red (End) QR tags before printing.' };
  }
  const firstRelease = !item.printed;
  const r = printQueue.add(item.paintingJtc, item.location, item.sourceJtc);
  item.printed = true;
  persist();
  // Log the QR<->JTC bind to Postgres on the FIRST release only (a reprint doesn't
  // duplicate the row). Best-effort: never let an audit-DB hiccup block the print.
  if (firstRelease) {
    logBinding(item).catch((e) => console.error('[binding] qrLink error:', e.message));
  }
  return { ok: true, queued: true, id: r.id, position: r.position, paused: r.paused };
}

// Resolve the printed painting JTC's Job.Id and write the QR bind row. The scanned
// tags are rebuilt from this workcell's number + each side's sequence (e.g. wc 2,
// start seq 01 -> 2101; end seq 01 -> 2201).
async function logBinding(item) {
  const loc = locations.get(item.location);
  const wc = workcellOf(loc);
  if (!wc) return;
  let barcodeId = null;
  try {
    const rec = await db.getOne(item.paintingJtc);
    barcodeId = rec && rec.barcodeId != null ? Number(rec.barcodeId) : null;
  } catch (e) {
    console.error('[binding] could not resolve Job.Id for', item.paintingJtc, '-', e.message);
  }
  if (barcodeId == null) {
    console.warn('[binding] no Job.Id for', item.paintingJtc, '- skipping qrLink write');
    return;
  }
  const qrStart = Number(`${wc}1${item.startSeq}`);
  const qrEnd = Number(`${wc}2${item.endSeq}`);
  const res = await qrLink.record({ jtcBarcodeId: barcodeId, qrStart, qrEnd });
  if (res.ok) console.log(`[binding] logged qr_jtc_link #${res.id}: barcode=${barcodeId} start=${qrStart} end=${qrEnd}`);
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
