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
 * A tag is a 4-digit number where ONLY the 2nd digit is read as the direction:
 *   2nd digit = 1 -> Start (Green),  2 -> End (Red).
 * The 1st digit (workcell) and last two (sequence) are NOT validated — any 4-digit
 * tag whose 2nd digit is 1 or 2 binds. The full scanned number is still recorded and
 * written to Postgres. Rescanning the same colour replaces it (e.g. change Green from
 * 2101 to 2102). Anything that isn't such a 4-digit tag is rejected (no lockout).
 *
 * Model: one job runs per workcell, so a location has ONE active (front) item;
 * further triggers queue BEHIND it and only become active once the front item is
 * cleared/removed. The staged jobs and their scans survive restart.
 *
 * On full binding the item is handed to the existing print queue (printQueue.add),
 * inheriting all of its resilience — nothing about printing changes here.
 */

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const printQueue = require('./printQueue');
const db = require('./db');
const qrLink = require('./qrLink');
const reworkQrLink = require('./reworkQrLink');

const { fileFor, atomicWrite, fail } = require('./localStore');
const FILE = fileFor('binding-jobs.json');

let jobs = [];
let seq = 0;

// ---- persistence ----------------------------------------------------------
function persist() {
  try {
    atomicWrite(FILE, { jobs });
  } catch (err) {
    console.error('[binding] could not persist:', err.message);
  }
}

function saveSplit(next) {
  atomicWrite(FILE, { jobs: next });
  jobs = next;
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(saved.jobs)) throw new Error('Invalid saved QR binding queue');
    jobs = saved.jobs;
    seq = jobs.reduce((m, j) => Math.max(m, Number(j.id) || 0), 0);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ---- helpers --------------------------------------------------------------
// Decode a 4-digit QR tag by its 2nd digit only -> { dir:'start'|'end', tag:<int> },
// or null if it isn't a 4-digit number whose 2nd digit is 1 or 2. The 1st digit
// (workcell) and last two (sequence) are ignored for gating but kept in `tag`.
function decode(token) {
  const t = String(token || '').trim();
  const m = t.match(/^\d([12])\d{2}$/);
  if (!m) return null;
  return { dir: m[1] === '1' ? 'start' : 'end', tag: Number(t) };
}

// The item the operator is acting on: the one they SELECTED (by id) in the list,
// or the front (oldest) item when no id is given. The queue keeps its order; the
// selection just chooses which staged job the preview/scan/print apply to.
function itemFor(location, id, mode) {
  const forLoc = jobs.filter((j) =>
    !j.dismissed && j.location === location && (!mode || (j.bindingMode || 'normal') === mode)
  );
  if (id != null && id !== '') {
    return forLoc.find((j) => j.id === Number(id)) || null;
  }
  return forLoc[0] || null;
}

// Public snapshot for the UI, per location: the active item is marked so the
// front-end shows its checklist; the rest render as "waiting".
function list(location) {
  const forLoc = jobs.filter((j) => !j.dismissed && (!location || j.location === location));
  const activeId = location && forLoc.length ? forLoc[0].id : null;
  return forLoc.map((j) => ({
    id: j.id,
    paintingJtc: j.paintingJtc,
    sourceJtc: j.sourceJtc || null,
    location: j.location,
    boundStart: !!j.boundStart,
    boundEnd: !!j.boundEnd,
    bindingMode: j.bindingMode || 'normal',
    boundRework: !!j.boundRework,
    reworkQrId: j.reworkQrId || null,
    startTag: j.startTag || null,
    endTag: j.endTag || null,
    printed: !!j.printed,
    ...(j.parts ? {
      currentPart: j.parts.find((part) => part.printJobId == null)?.number ?? null,
      parts: j.parts.map(({ number, qty, startTag, endTag, printJobId }) => ({ number, qty, startTag, endTag, printJobId })),
    } : {}),
    active: j.id === activeId,
  }));
}

// ---- operations -----------------------------------------------------------
// Stage a job for binding. Deduped by paintingJtc+location so the auto-trigger and
// a manual scan of the same JTC don't create two rows. Returns the (existing or
// new) item's public shape.
function add(paintingJtc, location, sourceJtc, bindingMode = 'normal', splitPartOneQty = null) {
  const jtc = String(paintingJtc || '').trim();
  const mode = bindingMode === 'rework' ? 'rework' : 'normal';
  const existing = jobs.find((j) =>
    j.location === location &&
    (j.paintingJtc === jtc || (j.parts && sourceJtc && j.sourceJtc === sourceJtc)) &&
    (j.bindingMode || 'normal') === mode &&
    (!j.printed || j.parts)
  );
  if (existing?.dismissed) throw fail('Both QR pairs for this Painting job were already queued. Check the print queue.', 409);
  if (existing) return list(location).find((x) => x.id === existing.id);
  const job = {
    id: ++seq,
    paintingJtc: jtc,
    sourceJtc: sourceJtc ? String(sourceJtc).trim() : null,
    location: location || null,
    bindingMode: mode,
    boundStart: false,
    boundEnd: false,
    startTag: null,
    endTag: null,
    printed: false,
    at: Date.now(),
  };
  if (mode === 'normal' && splitPartOneQty != null) {
    job.parts = [splitPartOneQty, 50 - splitPartOneQty].map((qty, index) => ({
      number: index + 1, qty, startTag: null, endTag: null, printJobId: null, releaseKey: randomUUID(),
    }));
    saveSplit([...jobs, job]);
  } else {
    jobs.push(job);
    persist();
  }
  return list(location).find((x) => x.id === job.id);
}

// Validate a scanned token against the ACTIVE item's workcell tags and record the
// Start/End bind. Returns { ok, role?, error?, item? }. Never throws on a bad scan
// — a mismatch is a normal, retryable outcome (no lockout).
function scan(location, token, id, bindingMode = 'normal', partNumber) {
  const mode = bindingMode === 'rework' ? 'rework' : 'normal';
  const item = itemFor(location, id, mode);
  if (!item) return { ok: false, error: 'No job is waiting for QR binding on this station.' };
  const snap = () => list(location).find((x) => x.id === item.id);
  if (mode === 'rework') {
    const t = String(token || '').trim();
    if (!/^03\d{2}$/.test(t)) {
      return { ok: false, error: 'Unrecognised Rework QR — expected a 03xx Black QR tag.', item: snap() };
    }
    item.reworkQrId = t;
    item.boundRework = true;
    persist();
    return { ok: true, role: 'rework', tag: t, item: snap() };
  }
  const d = decode(token);
  if (!d) {
    return { ok: false, error: 'Unrecognised QR tag — expected a 4-digit tag (2nd digit 1 = Start, 2 = End).', item: snap() };
  }
  if (item.parts) {
    const part = item.parts.find((p) => p.printJobId == null);
    if (!part) return { ok: false, error: 'Both QR pairs have already been queued.' };
    if (part.number !== partNumber) return { ok: false, error: 'The active QR pair changed. Check the screen and scan again.' };
    if (part.startTag && part.endTag) return { ok: false, error: 'This pair is complete. Queue its label before scanning more tags.' };
    const next = { ...part, [d.dir === 'start' ? 'startTag' : 'endTag']: d.tag };
    saveSplit(jobs.map((j) => j !== item ? j : { ...j, parts: j.parts.map((p) => p === part ? next : p) }));
    return { ok: true, role: d.dir, tag: d.tag, item: snap() };
  }
  // Only the direction (2nd digit) gates. Rescanning the same colour replaces its tag.
  if (d.dir === 'start') { item.startTag = d.tag; item.boundStart = true; }
  else { item.endTag = d.tag; item.boundEnd = true; }
  persist();
  return { ok: true, role: d.dir, tag: d.tag, item: snap() };
}

// Release the ACTIVE item to the real print queue — the gated print. Only succeeds
// when both Green and Red are bound (the compliance gate; there is no bypass). The
// item STAYS (printed=true) so the preview persists until the operator clears it,
// and a manual re-click reprints. Returns { ok, error?, queued? }.
async function releasePrint(location, id, bindingMode = 'normal', partNumber) {
  const mode = bindingMode === 'rework' ? 'rework' : 'normal';
  const item = itemFor(location, id, mode);
  if (!item) return { ok: false, error: 'No job is waiting for QR binding on this station.' };
  if (item.parts) {
    const part = item.parts.find((p) => p.number === partNumber);
    if (!part) return { ok: false, error: 'Select the active QR pair before releasing its label.' };
    if (part.printJobId != null) return { ok: true, queued: true, id: part.printJobId, partNumber };
    if (part !== item.parts.find((p) => p.printJobId == null) || !part.startTag || !part.endTag) {
      return { ok: false, error: 'Scan both QR tags for the active pair before printing.' };
    }
    const { number, qty, releaseKey } = part;
    const result = printQueue.add(item.paintingJtc, item.location, item.sourceJtc, { number, qty, releaseKey });
    const parts = item.parts.map((p) => p === part ? { ...p, printJobId: result.id } : p);
    saveSplit(jobs.map((j) => j !== item ? j : { ...j, parts, printed: parts.every((p) => p.printJobId != null) }));
    logBinding(item.paintingJtc, part.startTag, part.endTag, number)
      .catch((e) => console.error('[binding] qrLink error:', e.message));
    return { ok: true, queued: true, ...result, partNumber };
  }
  if (mode === 'rework') {
    if (!item.boundRework) {
      return { ok: false, error: 'Scan the Black Rework QR before printing.' };
    }
    if (!item.printed) {
      let rec;
      try {
        rec = await db.getOne(item.paintingJtc);
      } catch (err) {
        return {
          ok: false,
          error: `Could not resolve Painting JTC ${item.paintingJtc} from SQL Server: ${err.message}`,
        };
      }
      const jtcId = rec && rec.barcodeId != null ? Number(rec.barcodeId) : null;
      if (!Number.isInteger(jtcId)) {
        return {
          ok: false,
          error: `Painting JTC ${item.paintingJtc} has no valid SQL Server Job.Id.`,
        };
      }
      const linked = await reworkQrLink.record({
        qrId: item.reworkQrId,
        jtcId,
        remarks: null,
      });
      if (!linked.ok) {
        return {
          ok: false,
          error: linked.error,
          alreadyBound: linked.reason === 'already-bound',
        };
      }
    }
    const r = printQueue.add(item.paintingJtc, item.location, item.sourceJtc);
    item.printed = true;
    persist();
    return { ok: true, queued: true, id: r.id, position: r.position, paused: r.paused };
  }
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
    logBinding(item.paintingJtc, item.startTag, item.endTag)
      .catch((e) => console.error('[binding] qrLink error:', e.message));
  }
  return { ok: true, queued: true, id: r.id, position: r.position, paused: r.paused };
}

// Resolve the printed painting JTC's Job.Id and write the QR bind row, using the
// actual scanned tags (e.g. 2101 / 2201) exactly as they came in.
async function logBinding(paintingJtc, qrStart, qrEnd, pairNumber) {
  let barcodeId = null;
  try {
    const rec = await db.getOne(paintingJtc);
    barcodeId = rec && rec.barcodeId != null ? Number(rec.barcodeId) : null;
  } catch (e) {
    console.error('[binding] could not resolve Job.Id for', paintingJtc, '-', e.message);
  }
  if (barcodeId == null) {
    console.warn('[binding] no Job.Id for', paintingJtc, '- skipping qrLink write');
    return;
  }
  const res = await qrLink.record({ jtcBarcodeId: barcodeId, qrStart, qrEnd, pairNumber });
  if (res.ok) console.log(`[binding] logged qr_jtc_link #${res.id}: barcode=${barcodeId} start=${qrStart} end=${qrEnd}${pairNumber == null ? '' : ' pair=' + pairNumber}`);
}

function remove(id, location) {
  const item = itemFor(location, id);
  if (id != null && id !== '' && item) removeItems((j) => j === item);
}

// Clear all staged bindings for a location (the operator's "Clear").
function clear(location) {
  removeItems((j) => !location || j.location === location);
}

function removeItems(matches) {
  if (jobs.some((j) => matches(j) && j.parts && !j.printed && j.parts.some((p) => p.printJobId != null || printQueue.findSplitPrint(p.releaseKey)))) {
    throw fail('Finish both QR pairs before clearing this job.', 409);
  }
  // Keep a completed split's identity so rescanning it cannot create more labels.
  saveSplit(jobs.flatMap((j) => {
    if (!matches(j)) return [j];
    return j.parts && j.printed ? [{ ...j, dismissed: true }] : [];
  }));
}

load();

module.exports = { add, list, scan, releasePrint, remove, clear };
