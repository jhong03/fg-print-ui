require('dotenv').config();

const path = require('path');
const express = require('express');
const db = require('./db');
const { getTemplate, reload: reloadTemplate } = require('./mes');
const { renderTspl } = require('./label/render');
const { mapRecordToFields } = require('./label/mapRecord');
const { buildModel } = require('./label/model');
const agent = require('./agent');
const locations = require('./locations');
const printQueue = require('./printQueue');
const bindingQueue = require('./bindingQueue');
const autoPrint = require('./autoPrint');
const { resolvePainting } = require('./paintingFlow');

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT || 3000);
const COMPANY_NAME = process.env.COMPANY_NAME || 'YOLLINK INDUSTRIES SDN BHD';
// Data source has no unit-of-measure column, so the label falls back to this.
const DEFAULT_UOM = process.env.DEFAULT_UOM || 'PCS';

// Resolve the print destination ("tab") for a request. The id arrives as
// ?location= (or in the POST body); an unknown/missing id falls back to the
// first tab. locations.js reads locations.json live, so edits need no restart.
function resolveLocation(req) {
  const id = (req.query.location || req.body?.location || '').trim();
  return locations.get(id);
}

// Everything renderTspl/buildModel need, taken from the resolved location.
function printOptsFor(loc) {
  return { variant: loc.variant, barcodeNudge: loc.barcodeNudge, upright: loc.upright };
}

// ---- Static assets --------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// Serve the JsBarcode library from node_modules (installed via npm) so the
// page works fully offline — no CDN needed on the operator station.
app.use(
  '/vendor',
  express.static(path.join(__dirname, '..', 'node_modules', 'jsbarcode', 'dist'))
);

// ---- API ------------------------------------------------------------------

// Front-end reads a little config (e.g. the company name on the label).
app.get('/api/config', (req, res) => {
  res.json({ companyName: COMPANY_NAME, defaultUom: DEFAULT_UOM });
});

// The tabs: one entry per print destination. Only what the UI needs — the agent
// URL stays server-side.
app.get('/api/locations', (req, res) => {
  res.json(
    locations.list().map((l) => ({
      id: l.id,
      name: l.name,
      group: l.group,
      templateId: l.templateId,
      variant: l.variant,
      // Tells the UI this tab gates printing behind a QR scan (task-list flow).
      requireQrBinding: l.requireQrBinding,
    }))
  );
});

// Suggestions for the search box / scanner. GET /api/jtc/search?q=...
app.get('/api/jtc/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    // Empty q is allowed: it returns the most RECENT JTCs for the tab's model, so a
    // touchscreen operator (no keyboard) can tap one from the dropdown. Non-empty q
    // filters as usual. Limited to the tab's models (empty list = all), and — on
    // FG-Sticker (doneOnly) tabs — to completed jobs only.
    const loc = resolveLocation(req);
    const rows = await db.search(q, loc.models, loc.doneOnly, loc.toLocation);
    res.json(rows);
  } catch (err) {
    console.error('[search]', err.message);
    res.status(500).json({ error: 'Search failed. ' + err.message });
  }
});

// Full record for one JTC number. GET /api/jtc?no=...
// Uses a query param (not a path param) because real JTC numbers contain "/"
// and spaces, which break path routing.
app.get('/api/jtc', async (req, res) => {
  const no = (req.query.no || '').trim();
  if (!no) return res.status(400).json({ error: 'Missing ?no=' });
  try {
    const record = await db.getOne(no);
    if (!record) return res.status(404).json({ error: 'JTC not found' });
    res.json(record);
  } catch (err) {
    console.error('[getOne]', err.message);
    res.status(500).json({ error: 'Lookup failed. ' + err.message });
  }
});

// ---- Printing -------------------------------------------------------------

// Build the TSPL for a JTC without printing — used for preview/debugging.
// GET /api/print/preview?no=...&location=...
app.get('/api/print/preview', async (req, res) => {
  const no = (req.query.no || '').trim();
  if (!no) return res.status(400).json({ error: 'Missing ?no=' });
  try {
    const record = await db.getOne(no);
    if (!record) return res.status(404).json({ error: 'JTC not found' });
    const loc = resolveLocation(req);
    // Welding->Painting: a Leak-Test JTC on a weldingToPainting tab previews/prints
    // its Painting parent's label (see paintingFlow.js).
    const { record: target } = await resolvePainting(record, loc, db);
    const template = await getTemplate(loc.templateId);
    const tspl = renderTspl(template, mapRecordToFields(target), printOptsFor(loc));
    res.type('text/plain').send(tspl);
  } catch (err) {
    console.error('[preview]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolved label model (dimensions + positioned elements) for the on-screen
// preview to draw to scale. GET /api/label/model?no=...&location=...
app.get('/api/label/model', async (req, res) => {
  const no = (req.query.no || '').trim();
  if (!no) return res.status(400).json({ error: 'Missing ?no=' });
  try {
    const record = await db.getOne(no);
    if (!record) return res.status(404).json({ error: 'JTC not found' });
    const loc = resolveLocation(req);
    // Welding->Painting: preview the Painting parent's label; tell the UI where it
    // came from so it can show "showing Painting label — from Welding JTC …".
    const { record: target, sourceJtc } = await resolvePainting(record, loc, db);
    const template = await getTemplate(loc.templateId);
    res.json({ ...buildModel(template, target, printOptsFor(loc)), sourceJtc, printJtc: target.jtcNo });
  } catch (err) {
    console.error('[label/model]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Queue a JTC label for printing. POST /api/print { jtcNo, location }
// Used by both a scan (auto-queued by the front-end) and the Print Label button.
// On a weldingToPainting tab a Leak-Test JTC resolves to its Painting parent, so
// we enqueue the Painting JTC and remember the welding one as `sourceJtc`. A JTC
// we can't look up is enqueued as-is (the queue surfaces the error at dispatch).
app.post('/api/print', async (req, res) => {
  const no = (req.body?.jtcNo || '').trim();
  if (!no) return res.status(400).json({ error: 'Missing jtcNo' });
  const loc = resolveLocation(req);
  let jtcToQueue = no;
  let sourceJtc = null;
  try {
    const record = await db.getOne(no);
    // Model guard: a tab with a models list only handles its own model(s). A
    // scanned/typed JTC for another model is rejected (not queued/staged) — the
    // operator sees "not under this tab". (Matches the model-filtered search; a scan
    // bypasses that filter, so this is the real enforcement point.) The entered
    // (welding) JTC shares the model with its painting parent, so this is safe for
    // the welding->painting flow too.
    if (record && loc.models?.length) {
      const m = String(record.model || '').trim().toUpperCase();
      if (!loc.models.includes(m)) {
        return res.status(409).json({
          error: `JTC ${record.jtcNo} is model ${record.model || '—'} — not handled by this tab (${loc.name}). This station handles: ${loc.models.join(', ')}.`,
          wrongModel: true,
        });
      }
    }
    // Done guard: FG-Sticker (doneOnly) tabs only print COMPLETED jobs (ActualEndDate
    // set). A scan bypasses the done-filtered search, so this is the real enforcement.
    if (record && loc.doneOnly && !record.actualEnd) {
      return res.status(409).json({
        error: `JTC ${record.jtcNo} is not finished yet — this tab only prints completed jobs.`,
        notDone: true,
      });
    }
    // Location guard: a tab pinned to a stock location prints only jobs at it.
    if (record && loc.toLocation != null && record.toLocationId !== loc.toLocation) {
      return res.status(409).json({
        error: `JTC ${record.jtcNo} is not at this tab's location (${loc.toLocation}) — cannot print here.`,
        wrongLocation: true,
      });
    }
    if (record) {
      const t = await resolvePainting(record, loc, db);
      jtcToQueue = t.record.jtcNo;
      sourceJtc = t.sourceJtc;
    }
  } catch (err) {
    console.error('[print] resolve failed, queuing as-is:', err.message);
  }
  // QR-gated tab: don't print — STAGE the job for binding. It reaches the print
  // queue only after the operator scans this workcell's Green + Red QR tags.
  if (loc.requireQrBinding) {
    const b = bindingQueue.add(jtcToQueue, loc.id, sourceJtc);
    return res.json({ success: true, binding: true, id: b.id, printJtc: jtcToQueue, sourceJtc });
  }
  const r = printQueue.add(jtcToQueue, loc.id, sourceJtc);
  res.json({
    success: true, queued: true, id: r.id, position: r.position, paused: r.paused,
    printJtc: jtcToQueue, sourceJtc,
  });
});

// ---- Print queue ----------------------------------------------------------
// Operator-facing queue: what's waiting, and pause/resume so a run can be held
// while media/ribbon is reloaded and only continued on an explicit Resume.
app.get('/api/queue', (req, res) => res.json(printQueue.list()));
app.post('/api/queue/pause', (req, res) => { printQueue.pause(); res.json(printQueue.list()); });
app.post('/api/queue/resume', (req, res) => { printQueue.resume(); res.json(printQueue.list()); });
app.post('/api/queue/remove', (req, res) => { printQueue.remove(req.body?.id); res.json(printQueue.list()); });
app.post('/api/queue/clear', (req, res) => { printQueue.clearFinished(); res.json(printQueue.list()); });
app.post('/api/queue/clear-all', (req, res) => { printQueue.clearAll(); res.json(printQueue.list()); });

// ---- QR binding (phase 2) -------------------------------------------------
// The pending-binding queue for QR-gated tabs. The job is staged here (by the
// auto-watcher or a manual scan) and only released to the print queue once the
// operator scans this workcell's Green (Start) + Red (End) tags. GET is per
// location so a station only sees its own staged work.
app.get('/api/binding', (req, res) => {
  res.json({ jobs: bindingQueue.list(resolveLocation(req).id) });
});
// Validate one scanned QR token against the active item; records Start/End.
// A mismatch returns 200 with { ok:false, error } — it's a normal, retryable
// outcome (no lockout), so the UI just shows the message and lets the operator
// rescan the correct tag.
app.post('/api/binding/scan', (req, res) => {
  const loc = resolveLocation(req);
  const token = (req.body?.token || '').trim();
  if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });
  res.json(bindingQueue.scan(loc.id, token, req.body?.id));
});
// Release the selected item to the print queue — the gated print. Fails unless both
// tags are bound (no bypass). Returns the binding list so the UI stays in sync.
app.post('/api/binding/print', (req, res) => {
  const loc = resolveLocation(req);
  const r = bindingQueue.releasePrint(loc.id, req.body?.id);
  res.json({ ...r, jobs: bindingQueue.list(loc.id) });
});
app.post('/api/binding/remove', (req, res) => {
  bindingQueue.remove(req.body?.id);
  res.json({ jobs: bindingQueue.list(resolveLocation(req).id) });
});
app.post('/api/binding/clear', (req, res) => {
  const loc = resolveLocation(req);
  bindingQueue.clear(loc.id);
  res.json({ jobs: bindingQueue.list(loc.id) });
});

// Auto-print watcher status (for the UI badge + diagnostics). GET /api/auto
app.get('/api/auto', (req, res) => res.json(autoPrint.status()));

// Simulate a completion for a REAL existing JTC — routes by model and enqueues
// it just like the watcher would, but writes NOTHING to the DB (safe against
// production). Lets you test the trigger + routing + print without setting a
// job's ActualEndDate. POST /api/auto/test { jtcNo, location? }
app.post('/api/auto/test', async (req, res) => {
  const jtcNo = (req.body?.jtcNo || '').trim();
  if (!jtcNo) return res.status(400).json({ error: 'Missing jtcNo' });
  try {
    const override = (req.body?.location || '').trim() || null;
    res.json(await autoPrint.testTrigger(jtcNo, override));
  } catch (err) {
    console.error('[auto/test]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Local trigger simulation (mock adapter only) --------------------------
// A full end-to-end test of the WATCHER: flip a mock job's ActualEndDate
// NULL <-> set and let the real poll loop detect it. HARD-guarded to
// DB_CLIENT=mock so it can never mutate a real database.
function devGuard(res) {
  if (db.clientName !== 'mock') {
    res.status(403).json({ error: 'Test controls require DB_CLIENT=mock (they never touch a real DB).' });
    return false;
  }
  return true;
}
// Flip a mock job to completed (ActualEndDate = now). POST /api/dev/complete { jtcNo | id }
app.post('/api/dev/complete', (req, res) => {
  if (!devGuard(res)) return;
  const key = String(req.body?.jtcNo ?? req.body?.id ?? '').trim();
  const r = db.__complete(key);
  if (!r) return res.status(404).json({ error: 'No such mock job: ' + key });
  res.json({ ok: true, completed: r });
});
// Clear a mock job's completion so it can be tested again. POST /api/dev/reset { jtcNo | id }
app.post('/api/dev/reset', (req, res) => {
  if (!devGuard(res)) return;
  const key = String(req.body?.jtcNo ?? req.body?.id ?? '').trim();
  const r = db.__reset(key);
  if (!r) return res.status(404).json({ error: 'No such mock job: ' + key });
  res.json({ ok: true, reset: r });
});

// Poll a print job. GET /api/print/status/:jobId?location=...
app.get('/api/print/status/:jobId', async (req, res) => {
  try {
    res.json(await agent.jobStatus(req.params.jobId, resolveLocation(req)));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Printer health passthrough. GET /api/printer/status?location=...
app.get('/api/printer/status', async (req, res) => {
  try {
    res.json(await agent.printerStatus(resolveLocation(req)));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Force a fresh pull of the destination's template from the MES (clears its
// cache). POST /api/template/reload { location }
app.post('/api/template/reload', async (req, res) => {
  try {
    const loc = resolveLocation(req);
    const meta = await reloadTemplate(loc.templateId);
    res.json({ success: true, ...meta });
  } catch (err) {
    console.error('[template/reload]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- Start ----------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`\n  JTC Operator UI running:  http://localhost:${PORT}\n`);
  // Start the auto-print watcher (no-op unless AUTO_PRINT_ENABLED). It polls the
  // DB for newly-completed jobs and enqueues their labels; see autoPrint.js.
  autoPrint.start();
});

// Clean shutdown so DB pools close properly.
async function shutdown() {
  console.log('\n[server] shutting down...');
  server.close();
  try {
    await db.close();
  } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
