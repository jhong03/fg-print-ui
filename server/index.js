require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('./db');
const { getTemplate, reload: reloadTemplate } = require('./mes');
const { renderTspl } = require('./label/render');
const { mapRecordToFields } = require('./label/mapRecord');
const { buildModel } = require('./label/model');
const agent = require('./agent');

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT || 3000);
const COMPANY_NAME = process.env.COMPANY_NAME || 'YOLLINK INDUSTRIES SDN BHD';
// Data source has no unit-of-measure column, so the label falls back to this.
const DEFAULT_UOM = process.env.DEFAULT_UOM || 'PCS';

// Print settings are read LIVE from .env on every request, so operators can
// tune or toggle and reprint without restarting. Falls back to the startup value.
const ENV_PATH = path.join(__dirname, '..', '.env');
function liveEnv(key) {
  try {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, 'm').exec(fs.readFileSync(ENV_PATH, 'utf8'));
    if (m) return m[1];
  } catch (_) { /* fall back below */ }
  return process.env[key];
}

/*
 * Which label variant to print, plus the barcode calibration that belongs to it.
 *
 * The two variants need SEPARATE nudges: the 'plain' variant has no QC CHOP box,
 * and the barcode centres under that box — remove it and the barcode shifts, so
 * one shared nudge can never suit both. Tune each once and toggling is clean.
 */
function printOpts() {
  const variant = String(liveEnv('LABEL_VARIANT') || 'qc').toLowerCase() === 'plain'
    ? 'plain'
    : 'qc';
  const nudge = Number(
    liveEnv(variant === 'plain' ? 'BARCODE_NUDGE_DOTS_PLAIN' : 'BARCODE_NUDGE_DOTS_QC')
    ?? liveEnv('BARCODE_NUDGE_DOTS')
  );
  return { variant, barcodeNudge: Number.isFinite(nudge) ? nudge : 0 };
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

// Suggestions for the search box / scanner. GET /api/jtc/search?q=...
app.get('/api/jtc/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const rows = await db.search(q);
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
// GET /api/print/preview?no=...
app.get('/api/print/preview', async (req, res) => {
  const no = (req.query.no || '').trim();
  if (!no) return res.status(400).json({ error: 'Missing ?no=' });
  try {
    const record = await db.getOne(no);
    if (!record) return res.status(404).json({ error: 'JTC not found' });
    const template = await getTemplate();
    const tspl = renderTspl(template, mapRecordToFields(record), printOpts());
    res.type('text/plain').send(tspl);
  } catch (err) {
    console.error('[preview]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolved label model (dimensions + positioned elements) for the on-screen
// preview to draw to scale. GET /api/label/model?no=...
app.get('/api/label/model', async (req, res) => {
  const no = (req.query.no || '').trim();
  if (!no) return res.status(400).json({ error: 'Missing ?no=' });
  try {
    const record = await db.getOne(no);
    if (!record) return res.status(404).json({ error: 'JTC not found' });
    const template = await getTemplate();
    res.json(buildModel(template, record, printOpts()));
  } catch (err) {
    console.error('[label/model]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Render a JTC label and send it to the local print agent.
// POST /api/print { jtcNo }
app.post('/api/print', async (req, res) => {
  const no = (req.body?.jtcNo || '').trim();
  if (!no) return res.status(400).json({ error: 'Missing jtcNo' });
  try {
    const record = await db.getOne(no);
    if (!record) return res.status(404).json({ error: 'JTC not found' });
    const template = await getTemplate();
    const tspl = renderTspl(template, mapRecordToFields(record), printOpts());
    const result = await agent.printLabel(tspl);
    res.json({ success: true, jobId: result.jobId });
  } catch (err) {
    console.error('[print]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// Poll a print job. GET /api/print/status/:jobId
app.get('/api/print/status/:jobId', async (req, res) => {
  try {
    res.json(await agent.jobStatus(req.params.jobId));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Printer health passthrough. GET /api/printer/status
app.get('/api/printer/status', async (req, res) => {
  try {
    res.json(await agent.printerStatus());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Force a fresh pull of the label template from the MES (clears the cache).
// POST /api/template/reload
app.post('/api/template/reload', async (req, res) => {
  try {
    const meta = await reloadTemplate();
    res.json({ success: true, ...meta });
  } catch (err) {
    console.error('[template/reload]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---- Start ----------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`\n  JTC Operator UI running:  http://localhost:${PORT}\n`);
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
