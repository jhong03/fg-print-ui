/*
 * Operator print queue.
 *
 * Why this lives here (not just in the print-agent): the operator watches THIS
 * app, and the requirements are queue-shaped —
 *   - a scanned JTC is queued automatically and prints hands-free;
 *   - if the printer stops mid-run (label out, ribbon out, power/comms drop) the
 *     pending jobs must survive and the run must NOT silently continue;
 *   - after the operator reloads media (often power-cycling the printer) the
 *     queue stays intact and only continues on an explicit Resume.
 *
 * The print-agent has its own queue, but it auto-drains every 2s and auto-resumes
 * on restart — the opposite of "hold until a human says go". So we keep the
 * authoritative queue here and release ONE job at a time to the agent, confirming
 * each via /print/status before sending the next. Any printer/comms failure
 * PAUSES the whole queue; a data error (unknown JTC, bad template) just marks
 * that one job and moves on.
 *
 * Persistence: the queue is written to disk on every change, so a power cut can't
 * lose it. On startup we reload and start PAUSED whenever pending work exists —
 * the operator resumes when the printer is confirmed ready.
 */

const fs = require('fs');
const path = require('path');

const db = require('./db');
const { getTemplate } = require('./mes');
const { renderTspl } = require('./label/render');
const { mapRecordToFields } = require('./label/mapRecord');
const agent = require('./agent');
const locations = require('./locations');
const spooler = require('./spooler');
const { prependProcessCode } = require('./paintingFlow');

const FILE = path.join(__dirname, '..', 'print-jobs.json');
const DONE_HISTORY = 15;          // finished jobs kept for the operator to see
const POLL_MS = 1000;             // how often we ask the agent for a job outcome
const POLL_TIMEOUT_MS = 40000;    // give up waiting on one job after this
const GAP_MS = 400;               // small breather between labels
// Spooler-drain verification. The agent confirms a label was handed to Windows,
// not that it physically printed — a powered-off/offline printer still accepts
// the spool. So we watch the real spooler depth (queueDepth) fall back to zero.
// Env-overridable so a genuinely slow printer can be given more time.
const DRAIN_TIMEOUT_MS = Number(process.env.QUEUE_DRAIN_TIMEOUT_MS) || 12000;
const DRAIN_POLL_MS = Number(process.env.QUEUE_DRAIN_POLL_MS) || 1000;

// status: 'queued' | 'printing' | 'done' | 'error'
let jobs = [];
let paused = true;                // safe default; load() decides the real value
let processing = false;           // guards against two worker loops at once
let seq = 0;

// ---- persistence ----------------------------------------------------------
function persist() {
  try {
    fs.writeFileSync(FILE, JSON.stringify({ paused, jobs }, null, 2));
  } catch (err) {
    console.error('[queue] could not persist:', err.message);
  }
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    jobs = Array.isArray(saved.jobs) ? saved.jobs : [];
    // A job left 'printing' means we died mid-send — re-queue it to be safe
    // (reprinting a maybe-unprinted label beats silently dropping it).
    for (const j of jobs) if (j.status === 'printing') j.status = 'queued';
    seq = jobs.reduce((m, j) => Math.max(m, Number(j.id) || 0), 0);
  } catch (_) {
    jobs = [];
  }
  // Require an explicit Resume ONLY when we're restarting into a backlog — that's
  // the "continue from the cut-off" case. A clean start with no pending work
  // begins running, so the first scan of the day prints hands-free.
  paused = jobs.some((j) => j.status === 'queued');
  persist();
}

// ---- helpers --------------------------------------------------------------
const pendingCount = () => jobs.filter((j) => j.status === 'queued').length;

function trimHistory() {
  const finished = jobs.filter((j) => j.status === 'done' || j.status === 'error');
  if (finished.length <= DONE_HISTORY) return;
  const drop = new Set(finished.slice(0, finished.length - DONE_HISTORY));
  jobs = jobs.filter((j) => !drop.has(j));
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A paused queue with no pending work has nothing to resume — so it must not stay
// paused (otherwise the UI shows a stray "Resume" on an idle queue). Call after any
// removal that can empty the queue. `clearAll` already un-pauses; the worker only
// runs while un-paused, so completions can't strand this state.
function normalizePaused() {
  if (paused && !jobs.some((j) => j.status === 'queued' || j.status === 'printing')) {
    paused = false;
  }
}

// Public snapshot for the UI: never leaks TSPL, just what the operator needs.
function list() {
  return {
    paused,
    printing: jobs.some((j) => j.status === 'printing'),
    jobs: jobs.map((j) => ({
      id: j.id,
      jtcNo: j.jtcNo,
      sourceJtc: j.sourceJtc || null,
      location: j.location,
      status: j.status,
      error: j.error || null,
    })),
  };
}

// ---- queue operations -----------------------------------------------------
function add(jtcNo, location, sourceJtc) {
  const job = {
    id: ++seq,
    jtcNo: String(jtcNo || '').trim(),
    // The JTC this print was DERIVED from (e.g. the Welding JTC when jtcNo is its
    // Painting parent). Shown as provenance in the queue; null for direct prints.
    sourceJtc: sourceJtc ? String(sourceJtc).trim() : null,
    location: location || null,
    status: 'queued',
    error: null,
    at: Date.now(),
  };
  jobs.push(job);
  persist();
  kick();
  return { id: job.id, position: pendingCount(), paused };
}

function pause() {
  paused = true;
  persist();
}

function resume() {
  paused = false;
  persist();
  kick();
}

function remove(id) {
  jobs = jobs.filter((j) => j.id !== Number(id));
  normalizePaused();
  persist();
}

// Clear finished history (leaves pending work untouched).
function clearFinished() {
  jobs = jobs.filter((j) => j.status === 'queued' || j.status === 'printing');
  normalizePaused();
  persist();
}

// Discard the WHOLE queue — pending, printing, and finished — and return to a
// clean, un-paused state. For when the operator does NOT want to continue the
// held backlog. Note: a label already handed to the Windows spooler isn't recalled
// here (on a paused queue the spooler was already cleared, so this is clean).
function clearAll() {
  jobs = [];
  paused = false;
  persist();
}

// ---- the worker -----------------------------------------------------------
// Job lifecycle:
//   queued   -> not yet handed to the printer
//   printing -> handed to the Windows spooler; awaiting the physical label
//   done     -> the spooler drained, i.e. the label came out
//   error    -> data problem (bad JTC / template); skipped
//
// The distinction that fixes the duplicate/stuck bugs: once a label is in the
// Windows spooler it is 'printing' and we NEVER resend it — Windows owns it and
// will print it when the printer recovers. On Resume we simply re-confirm it
// drained instead of dispatching it again.

// Readiness BEFORE we commit a label to the spooler. If the agent is unreachable
// or reports the printer offline/paused, hold the (still-queued) job — it hasn't
// been sent, so nothing prints unexpectedly. The agent's `online` flag can be
// unreliable, which is why a job that slips through is still caught afterwards by
// the spooler-drain check.
async function notReadyReason(loc) {
  let st;
  try {
    st = await agent.printerStatus(loc);
  } catch (err) {
    return 'Print agent unreachable: ' + err.message;
  }
  if (st && (st.connected === false || st.online === false || st.paused === true)) {
    return 'Printer not ready (' + (st.status || 'offline') + ')';
  }
  return null;
}

// Hand a queued job to the agent. On SUCCESS the label is in the Windows spooler
// (verdict 'printing'); it has NOT necessarily printed yet.
async function dispatch(job, loc) {
  let tspl;
  try {
    const record = await db.getOne(job.jtcNo);
    if (!record) return { verdict: 'skip', error: 'JTC not found' };
    // Welding->Painting print (job came from a welding JTC): apply the location's
    // processCodePrepend so the printed label matches the preview (e.g. "SB, PL").
    // Gated on sourceJtc so a painting JTC printed directly stays untouched.
    if (job.sourceJtc) prependProcessCode(record, loc);
    const template = await getTemplate(loc.templateId);
    tspl = renderTspl(template, mapRecordToFields(record), { variant: loc.variant, barcodeNudge: loc.barcodeNudge, upright: loc.upright });
  } catch (err) {
    return { verdict: 'skip', error: 'Render failed: ' + err.message };
  }

  const notReady = await notReadyReason(loc);
  if (notReady) return { verdict: 'pause', error: notReady };

  let agentJobId;
  try {
    agentJobId = (await agent.printLabel(tspl, loc)).jobId;
  } catch (err) {
    return { verdict: 'pause', error: err.message };
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    await delay(POLL_MS);
    let st;
    try {
      st = await agent.jobStatus(agentJobId, loc);
    } catch (err) {
      return { verdict: 'pause', error: 'Lost contact with agent: ' + err.message };
    }
    if (st.status === 'FAILED') return { verdict: 'pause', error: st.lastError || 'Printer reported failure' };
    if (st.status === 'SUCCESS') return { verdict: 'printing' }; // in the spooler now
    if (Date.now() > deadline) return { verdict: 'pause', error: 'Timed out sending to the printer' };
  }
}

// A 'printing' label sits in the Windows spooler; a healthy printer drains it to
// zero within a second or two, a dead one never does. We watch queueDepth (the
// real spooler depth the agent already reports) fall to zero. A missing field
// (older agent) can't be verified, so we don't block the line on it.
async function spoolerDrained(loc) {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    let st;
    try {
      st = await agent.printerStatus(loc);
    } catch (_) {
      return false; // agent went away mid-check — treat as not printed
    }
    if (typeof st.queueDepth !== 'number') return true;
    if (st.queueDepth === 0) return true;
    if (Date.now() > deadline) return false;
    await delay(DRAIN_POLL_MS);
  }
}

// Is the printer's spooler on THIS machine (so we can clear it)? True for the
// normal single-terminal setup where the agent is localhost.
function isLocalAgent(loc) {
  const url = (loc && loc.agentUrl) || process.env.AGENT_URL || 'http://localhost:9000';
  return /\/\/(localhost|127\.0\.0\.1)\b/i.test(url);
}

// Pull a stuck label back out of the Windows spooler so a powered-off printer
// can't flush it before Resume. Returns true only if the spooler is confirmed
// empty afterwards (so the caller can safely re-queue the job for reprint).
async function clearSpooler(loc) {
  if (!isLocalAgent(loc)) return false;   // remote spooler isn't ours to clear
  let name;
  try {
    name = (await agent.printerStatus(loc)).name;
  } catch (_) {
    return false;
  }
  if (!name) return false;
  await spooler.clear(name);
  try {
    return (await agent.printerStatus(loc)).queueDepth === 0;
  } catch (_) {
    return false;
  }
}

// Process one job to a terminal state, mutating it in place and persisting.
// Returns 'continue' (advance to the next job) or 'pause' (stop the run).
async function processOne(job) {
  const loc = locations.get(job.location);

  // Step 1: hand a not-yet-sent job to the spooler.
  if (job.status === 'queued') {
    job.error = null;
    persist();
    const d = await dispatch(job, loc);
    if (d.verdict === 'skip') { job.status = 'error'; job.error = d.error; trimHistory(); persist(); return 'continue'; }
    if (d.verdict === 'pause') { job.error = d.error; persist(); console.warn('[queue] paused:', d.error); return 'pause'; }
    job.status = 'printing'; job.error = null; persist();
  }

  // Step 2: confirm the label physically printed (drained from the spooler). On
  // Resume this also reconciles a previously-stuck job — if the printer has since
  // recovered it drains here and is marked done, with no reprint.
  if (await spoolerDrained(loc)) {
    job.status = 'done';
    trimHistory();
    persist();
    await delay(GAP_MS);
    return 'continue';
  }

  // Printer isn't consuming the label. Pull it back OUT of the spooler so it
  // can't auto-flush when the printer wakes — nothing prints until the operator
  // Resumes. If cleared, the job goes back to 'queued' and is re-sent on Resume;
  // if we can't clear it (remote/non-Windows), leave it 'printing' and reconcile
  // on Resume instead (it may flush once).
  const cleared = await clearSpooler(loc);
  job.status = cleared ? 'queued' : 'printing';
  job.error = 'Printer not ready — held until Resume';
  persist();
  console.warn('[queue] paused:', job.error, cleared ? '(spooler cleared)' : '(spooler NOT cleared)');
  return 'pause';
}

async function worker() {
  if (processing) return;
  processing = true;
  try {
    while (!paused) {
      const job = jobs.find((j) => j.status === 'queued' || j.status === 'printing');
      if (!job) break;
      if (await processOne(job) === 'pause') { paused = true; persist(); break; }
    }
  } finally {
    processing = false;
  }
}

function kick() {
  if (!paused && !processing) worker();
}

load();

module.exports = { add, list, pause, resume, remove, clearFinished, clearAll };
