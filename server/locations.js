/*
 * Print destinations ("tabs").
 *
 * Each terminal runs this app next to its printer, but they all deploy the SAME
 * locations.json — one universal list of every printer/label type in the plant.
 * The operator picks their tab; the choice is remembered per station (in the
 * browser). A tab bundles everything that differs between print jobs:
 *
 *   { id, name, templateId, printerType, agentUrl, variant, barcodeNudge }
 *
 * Only `id` and `name` are required. Everything else falls back to the global
 * defaults in .env, so a minimal entry is just an id, a name, and a templateId.
 *
 * The file is read LIVE (re-read when it changes on disk), so editing it takes
 * effect on the next print with no restart — same principle as the .env reads.
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'locations.json');

let cache = { mtimeMs: -1, raw: null };

function readRaw() {
  let stat;
  try {
    stat = fs.statSync(FILE);
  } catch (_) {
    return null; // no file -> caller synthesises a default from .env
  }
  if (stat.mtimeMs === cache.mtimeMs) return cache.raw;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = { mtimeMs: stat.mtimeMs, raw: Array.isArray(raw) ? raw : [] };
  } catch (err) {
    console.error('[locations] bad locations.json:', err.message);
    // Keep serving the last good copy rather than breaking every print.
    if (cache.raw) return cache.raw;
    cache = { mtimeMs: stat.mtimeMs, raw: [] };
  }
  return cache.raw;
}

// Global defaults, read live from the environment (dotenv loaded them at start;
// process.env is the source of truth here).
function envDefaults() {
  return {
    agentUrl: process.env.AGENT_URL || 'http://localhost:9000',
    printerType: process.env.PRINTER_TYPE || 'tsc',
    templateId: process.env.LABEL_TEMPLATE_ID || '11',
    variant: process.env.LABEL_VARIANT || 'qc',
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Fill a raw entry's gaps from the .env defaults and normalise its types.
function resolveEntry(entry, d) {
  const variant = String(entry.variant || d.variant).toLowerCase() === 'plain'
    ? 'plain'
    : 'qc';
  const nudge = num(entry.barcodeNudge)
    ?? num(process.env[variant === 'plain' ? 'BARCODE_NUDGE_DOTS_PLAIN' : 'BARCODE_NUDGE_DOTS_QC'])
    ?? num(process.env.BARCODE_NUDGE_DOTS)
    ?? 0;
  return {
    id: String(entry.id),
    name: String(entry.name || entry.id),
    templateId: String(entry.templateId || d.templateId),
    printerType: String(entry.printerType || d.printerType),
    agentUrl: String(entry.agentUrl || d.agentUrl).replace(/\/+$/, ''),
    variant,
    barcodeNudge: nudge,
  };
}

// A single fallback tab built entirely from .env, so the app still works before
// anyone writes a locations.json.
function defaultLocation(d) {
  return resolveEntry(
    { id: 'default', name: 'Default', templateId: d.templateId, variant: d.variant },
    d
  );
}

// All destinations, fully resolved, in file order. Never empty.
function list() {
  const d = envDefaults();
  const raw = (readRaw() || []).filter((e) => e && e.id != null);
  if (!raw.length) return [defaultLocation(d)];
  return raw.map((e) => resolveEntry(e, d));
}

// Resolve one destination by id. Falls back to the first tab when the id is
// missing or unknown, so a stale bookmark never dead-ends a print.
function get(id) {
  const all = list();
  return all.find((l) => l.id === id) || all[0];
}

module.exports = { list, get };
