/*
 * Auto-print watcher.
 *
 * Replaces the manual scan for normal flow: it polls the MES DB for jobs that
 * have just COMPLETED and enqueues a label for each, hands-free. Manual lookup
 * (the search box + Print button) stays as a reprint / fallback path.
 *
 * How completion is detected — and why it can't just SELECT completed jobs:
 *   - Signal: a job is done when Job.ActualEndDate goes from NULL -> set.
 *   - That's a LEVEL, not an EVENT. Polling "give me completed jobs" would return
 *     the SAME jobs every tick and reprint forever. So we detect the EDGE:
 *       * WATERMARK (persisted): the newest ActualEndDate we've acted past. Each
 *         poll asks only for completions strictly after it -> only NEW ones.
 *       * PRINTED-SET (persisted Job.Ids): a second guard so a late row-edit that
 *         resurfaces a job, or a restart, can never print it twice. One label per
 *         job, ever.
 *   - FIRST RUN seeds the watermark from the newest completion already in the DB
 *     (getLatestCompletionMark), so history is ignored and only jobs finishing
 *     AFTER startup print. (Seeding from the DB's own clock also sidesteps any
 *     app-vs-DB timezone skew — the value round-trips in the DB's own frame.)
 *
 * Routing (which printer prints it):
 *   - A completed job's model (SubProductGroup.Name) selects the location, which
 *     carries the template / variant / printer (locations.json "models" list).
 *   - THIS station only prints jobs routed to the location id(s) in
 *     AUTO_PRINT_LOCATIONS, so no two stations ever print the same label.
 *
 * Enqueue goes through the existing print queue, inheriting all of its
 * resilience (one-at-a-time, spooler-drain verify, hold-until-Resume on failure).
 */

const fs = require('node:fs');
const path = require('node:path');

const db = require('./db');
const locations = require('./locations');
const printQueue = require('./printQueue');
const bindingQueue = require('./bindingQueue');
const { isLeakTest, resolvePainting } = require('./paintingFlow');

const STATE_FILE = path.join(__dirname, '..', 'auto-print-state.json');
const MAX_PRINTED_IDS = 5000; // bound the dedupe set; keep the most-recent ids

const enabled = /^(1|true|yes|on)$/i.test(String(process.env.AUTO_PRINT_ENABLED || ''));
const ownedIds = String(process.env.AUTO_PRINT_LOCATIONS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_MS = Number(process.env.AUTO_PRINT_POLL_MS) || 15000;

let watermark = null;        // ISO string; newest ActualEndDate we've acted past
let printedIds = new Set();  // Job.Ids already enqueued
let polling = false;         // guards against overlapping polls
let started = false;
let timer = null;
let lastPoll = null;         // ISO time of the last successful poll
let lastError = null;
let lastQueued = null;       // { jtcNo, model, location } of the most recent enqueue

// ---- persistence ----------------------------------------------------------
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    watermark = s.watermark || null;
    printedIds = new Set(Array.isArray(s.printedIds) ? s.printedIds : []);
  } catch (_) {
    watermark = null;
    printedIds = new Set();
  }
}

function persist() {
  // Ids are Job.Id (ascending over time), so the largest are the newest — keep
  // only those so the file can't grow without bound.
  let ids = [...printedIds];
  if (ids.length > MAX_PRINTED_IDS) {
    ids = ids.sort((a, b) => a - b).slice(-MAX_PRINTED_IDS);
    printedIds = new Set(ids);
  }
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ watermark, printedIds: ids }, null, 2));
  } catch (err) {
    console.error('[auto] could not persist state:', err.message);
  }
}

// ---- routing ---------------------------------------------------------------
// model (upper-cased SubProductGroup.Name) -> owned location. Rebuilt each poll
// so live edits to locations.json take effect without a restart.
function routeMap() {
  const map = new Map();
  for (const loc of locations.list()) {
    if (!ownedIds.includes(loc.id)) continue;
    for (const m of loc.models || []) map.set(m, loc); // models already normalised
  }
  return map;
}

// For one completed row, decide the print target — { loc, printJtc } — or null
// to skip. Normally prints the completed job itself; a welding->painting location
// instead requires a Leak-Test completion and prints its ParentJob (Painting) JTC.
function resolveTarget(r, map) {
  const loc = map.get(String(r.model || '').trim().toUpperCase());
  if (!loc) return null; // not this station's responsibility
  if (!loc.weldingToPainting) return { loc, printJtc: r.jtcNo, sourceJtc: null };

  if (!isLeakTest(r.processCode)) return null; // not a welding leak-test completion
  const printJtc = String(r.parentJtcNo || '').trim();
  if (!printJtc) {
    console.warn(`[auto] LKT job ${r.jtcNo} has no Painting parent (ParentJob=${r.parentJobId ?? 'null'}) — skipped`);
    return null;
  }
  // sourceJtc = the welding JTC this painting label came from (shown in the queue).
  return { loc, printJtc, sourceJtc: r.jtcNo };
}

// ---- the poll --------------------------------------------------------------
async function poll() {
  if (polling) return;
  polling = true;
  try {
    // First run: seed the watermark from the DB so we ignore history.
    if (!watermark) {
      const mark = await db.getLatestCompletionMark();
      watermark = (mark ? new Date(mark) : new Date()).toISOString();
      persist();
      lastPoll = new Date().toISOString();
      console.log('[auto] seeded watermark =', watermark);
      return; // act only on completions AFTER this point
    }

    const rows = await db.getCompletedSince(new Date(watermark));
    lastPoll = new Date().toISOString();
    lastError = null;
    if (!rows || !rows.length) return;

    const map = routeMap();
    let newWatermark = watermark;
    let changed = false;

    for (const r of rows) {
      // Advance the watermark past every row we SEE (routed or not), so we never
      // re-scan it. Another station handles the ones we skip — its own state is
      // independent.
      const end = r.actualEnd ? new Date(r.actualEnd).toISOString() : null;
      if (end && end > newWatermark) newWatermark = end;

      const jobId = r.jobId != null ? r.jobId : r.barcodeId;
      if (jobId == null || printedIds.has(jobId)) continue;

      const target = resolveTarget(r, map);
      if (!target) continue;

      // Dedup on the completing (welding) Job.Id, so one welding completion => one
      // painting print even though we enqueue a different (painting) JTC.
      // A requireQrBinding tab STAGES the job for QR binding instead of printing;
      // it only reaches the print queue after the operator scans Green + Red.
      if (target.loc.requireQrBinding) {
        bindingQueue.add(target.printJtc, target.loc.id, target.sourceJtc);
      } else {
        printQueue.add(target.printJtc, target.loc.id, target.sourceJtc);
      }
      printedIds.add(jobId);
      lastQueued = { jtcNo: target.printJtc, sourceJtc: r.jtcNo, model: r.model, location: target.loc.id };
      changed = true;
      const how = target.loc.requireQrBinding ? 'staged for QR binding' : 'queued';
      const via = target.printJtc !== r.jtcNo ? ` (painting of welding ${r.jtcNo})` : '';
      console.log(`[auto] ${how} ${target.printJtc}${via} [job ${jobId}, model ${r.model}] -> ${target.loc.id}`);
    }

    if (newWatermark !== watermark) { watermark = newWatermark; changed = true; }
    if (changed) persist();
  } catch (err) {
    lastError = err.message;
    console.error('[auto] poll failed:', err.message);
    // Leave the watermark untouched so the next tick retries the same window.
  } finally {
    polling = false;
  }
}

// ---- lifecycle -------------------------------------------------------------
function start() {
  if (started) return;
  if (!enabled) {
    console.log('[auto] disabled (set AUTO_PRINT_ENABLED=true to turn on)');
    return;
  }
  if (typeof db.getCompletedSince !== 'function') {
    console.error(`[auto] DB adapter "${db.clientName}" has no getCompletedSince — auto-print disabled`);
    return;
  }
  if (!ownedIds.length) {
    console.warn('[auto] AUTO_PRINT_ENABLED but AUTO_PRINT_LOCATIONS is empty — nothing to watch');
  }
  started = true;
  loadState();
  console.log(`[auto] watching [${ownedIds.join(', ') || 'none'}] every ${POLL_MS}ms`);
  // First poll shortly after boot (lets the DB pool warm up), then on interval.
  timer = setInterval(poll, POLL_MS);
  setTimeout(poll, 2000);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

// Simulate a completion for a REAL, existing job: route it by model (or an
// explicit location override) and enqueue it — exactly what poll() does when it
// detects a completion, but with NO DB write, so production data is untouched.
// Does not advance the watermark or the printed-set, so it's freely repeatable.
async function testTrigger(jtcNo, locationOverride = null) {
  const rec = await db.getOne(jtcNo);
  if (!rec) return { ok: false, reason: 'JTC not found', jtcNo };

  let loc;
  if (locationOverride) {
    loc = locations.get(locationOverride);
    if (!loc || loc.id !== locationOverride) {
      return { ok: false, reason: `unknown location "${locationOverride}"` };
    }
  } else {
    const model = String(rec.model || '').trim().toUpperCase();
    loc = routeMap().get(model);
    if (!loc) {
      // Help debugging: does the model match ANY location, just not an owned one?
      const anywhere = locations.list().find((l) => (l.models || []).includes(model));
      return {
        ok: false,
        model: rec.model,
        reason: anywhere
          ? `model "${rec.model}" belongs to "${anywhere.id}", which this station does not own (AUTO_PRINT_LOCATIONS=${ownedIds.join(',') || 'none'}). Pass an explicit "location" to override.`
          : `model "${rec.model}" is in no location's models list`,
      };
    }
  }

  // Resolve welding->painting exactly like the real poll / manual print do, so the
  // simulation stages the PAINTING JTC (with provenance + SB prepend), not the raw
  // welding one. For non-welding tabs this is a no-op (target = the entered job).
  const { record: target, sourceJtc } = await resolvePainting(rec, loc, db);
  const printJtc = target.jtcNo;

  if (loc.requireQrBinding) {
    const b = bindingQueue.add(printJtc, loc.id, sourceJtc);
    console.log(`[auto] TEST trigger: JTC ${jtcNo} (model ${rec.model}) -> ${loc.id} (staged ${printJtc} for QR binding)`);
    return { ok: true, jtcNo, printJtc, sourceJtc, model: rec.model, location: loc.id, staged: true, bindingId: b.id };
  }
  const r = printQueue.add(printJtc, loc.id, sourceJtc);
  console.log(`[auto] TEST trigger: JTC ${jtcNo} (model ${rec.model}) -> ${loc.id} (queued ${printJtc})`);
  return { ok: true, jtcNo, printJtc, sourceJtc, model: rec.model, location: loc.id, queueId: r.id, position: r.position, paused: r.paused };
}

function status() {
  return {
    enabled,
    started,
    ownedLocations: ownedIds,
    models: [...routeMap().keys()],
    watermark,
    printedCount: printedIds.size,
    pollMs: POLL_MS,
    lastPoll,
    lastError,
    lastQueued,
  };
}

module.exports = { start, stop, status, poll, testTrigger };
