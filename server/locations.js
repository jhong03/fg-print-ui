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
const printerSettings = require('./printerSettings');
const { fail } = require('./localStore');
const { LocationConfig } = require('./locationConfig');

const FILE = process.env.LOCATIONS_FILE || path.join(__dirname, '..', 'locations.json');
const configuration = new LocationConfig(FILE);

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
  // A tab's own nudge wins; otherwise the single .env default; otherwise 0.
  const nudge = num(entry.barcodeNudge)
    ?? num(process.env.BARCODE_NUDGE_DOTS)
    ?? 0;
  // Turn the sideways MES design upright at print time (default). A tab can set
  // upright:false to print vertically, exactly as designed (e.g. Work Order P3).
  const upright = entry.upright !== false;
  // Auto-print routing: the SubProductGroup Names (models) a completed job must
  // match to be printed on THIS location's template/printer. Normalised to
  // upper-case, trimmed strings for case-insensitive matching in autoPrint.js.
  const models = Array.isArray(entry.models)
    ? entry.models.map((m) => String(m).trim().toUpperCase()).filter(Boolean)
    : [];
  // Welding->Painting flow: when true, an auto-print match on this location does
  // NOT print the completed (welding) job. Instead it must be a Leak-Test job
  // (processCode L-T/LKT); the watcher follows its ParentJob to the Painting JTC
  // and prints THAT. See autoPrint.js and PROJECT_CONTEXT.md §17.
  const weldingToPainting = entry.weldingToPainting === true;
  // QR binding gate: when true, a completed/entered job on this tab does NOT print
  // directly — it goes to the PENDING-BINDING queue and only reaches the print
  // queue after the operator scans this workcell's Green (Start) + Red (End) QR
  // tags. `qrWorkcell` is this station's workcell NUMBER; tags are 4-digit "WDSS"
  // (W=workcell, D=1 Start/2 End, SS=sequence, Start/End share SS). See bindingQueue.js.
  const requireQrBinding = entry.requireQrBinding === true;
  // Rework tabs use one Black Rework QR instead of the normal Green + Red pair.
  const reworkQrBinding = entry.reworkQrBinding === true;
  const qrWorkcell = String(entry.qrWorkcell || '').trim();
  // Welding->Painting only: a process code to PREPEND to the painting label's
  // process code (e.g. "SB" for ShotBlast — the painting line's first physical
  // station, which MES lumps into a single "PL" step for some models). Empty/
  // absent = show the routing's process code exactly as MES has it. Applied only
  // when a welding->painting resolution actually happened; see paintingFlow.js.
  const processCodePrepend = String(entry.processCodePrepend || '').trim();
  // Master-tab grouping: a category label so the UI can bucket locations (e.g. "P1",
  // "P3"). Blank falls back to "Other" in the UI.
  const group = String(entry.group || '').trim();
  // UI mode pairing: related destinations can appear as one page with a mode toggle
  // while retaining separate IDs and queues internally.
  const modeGroup = String(entry.modeGroup || entry.id || '').trim();
  const mode = String(entry.mode || '').trim().toLowerCase() || null;
  // FG Sticker tabs: only completed jobs (Job.ActualEndDate set) may be searched or
  // printed — you only sticker a finished good. Enforced in the search filter AND at
  // /api/print (a scanned barcode can't bypass it). See queries.js + index.js.
  const doneOnly = entry.doneOnly === true;
  // Pin a tab to one stock location: only jobs whose Job.ToLocationId equals this
  // surface / print (e.g. 18 = P3-OUTGOING for the P3 FG label). null = no filter.
  const toLocation = Number.isInteger(entry.toLocation) ? entry.toLocation : null;
  // Faux-bold on print (MES has no bold): `boldTitle:true` emboldens the label's
  // title (largest static text); `boldText` is a list of exact static texts or field
  // keys to embolden too. Both empty/false = print exactly as designed. See render.js.
  const boldTitle = entry.boldTitle === true;
  const boldText = Array.isArray(entry.boldText)
    ? entry.boldText.map((s) => String(s).trim()).filter(Boolean)
    : [];
  return {
    id: String(entry.id),
    name: String(entry.name || entry.id),
    group,
    modeGroup,
    mode,
    templateId: String(entry.templateId || d.templateId),
    printerType: String(entry.printerType || d.printerType),
    printerId: entry.printerId ? String(entry.printerId) : null,
    agentUrl: String(entry.agentUrl || d.agentUrl).replace(/\/+$/, ''),
    variant,
    barcodeNudge: nudge,
    upright,
    models,
    weldingToPainting,
    splitPartOneQty: entry.splitWoLabels === true && weldingToPainting && requireQrBinding && !reworkQrBinding && mode !== 'rework'
      ? (Number.isInteger(entry.splitPartOneQty) && entry.splitPartOneQty >= 1 && entry.splitPartOneQty <= 49 ? entry.splitPartOneQty : 25)
      : null,
    processCodePrepend,
    requireQrBinding,
    reworkQrBinding,
    bindingMode: reworkQrBinding ? 'rework' : (requireQrBinding ? 'normal' : null),
    qrWorkcell,
    doneOnly,
    toLocation,
    boldTitle,
    boldText,
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
  if (!raw.length) return [printerSettings.apply(defaultLocation(d))];
  return raw.map((e) => printerSettings.apply(resolveEntry(e, d)));
}

// Missing selections use the first label. A removed explicit ID must never
// silently redirect a stale operator window to another label/printer.
function get(id) {
  const all = list();
  if (!id) return all[0];
  const found = all.find((l) => l.id === id);
  if (!found) throw fail('This label no longer exists. Refresh the operator screen.', 404);
  return found;
}

function assertUnchanged(location) {
  if (JSON.stringify(get(location.id)) !== JSON.stringify(location)) throw fail('This label configuration changed. Refresh the operator screen and try again.', 409);
}
function invalidate() { cache = { mtimeMs: -1, raw: null }; }
module.exports = { list, get, configuration, invalidate, envDefaults, resolveEntry, assertUnchanged };
