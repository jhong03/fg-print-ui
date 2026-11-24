'use strict';
const fs = require('node:fs');
const { atomicWrite, revision, fail } = require('./localStore');
function validateAutoPrint(value, labels) {
  if (!value || typeof value.enabled !== 'boolean' || !Array.isArray(value.locations)
    || value.locations.some((id) => typeof id !== 'string' || !id.trim())
    || !Number.isInteger(value.pollMs) || value.pollMs < 1000 || value.pollMs > 300000) {
    throw fail('Choose on/off, a list of labels, and a check interval between 1 and 300 seconds.');
  }
  const next = { enabled: value.enabled, locations: [...new Set(value.locations)], pollMs: value.pollMs };
  if (next.enabled && labels) {
    if (!next.locations.length) throw fail('Choose at least one label for Auto Print.');
    const models = new Map();
    for (const id of next.locations) {
      const loc = labels.find((l) => l.id === id);
      if (!loc) throw fail('An Auto Print label no longer exists. Update the selected labels.');
      if (loc.reworkQrBinding || loc.mode === 'rework') throw fail(loc.name + ': Rework labels must stay manual.');
      if (!loc.models?.length) throw fail(loc.name + ': Set its models in Label configuration first.');
      for (const model of loc.models) {
        const key = String(model).trim().toUpperCase();
        if (models.has(key)) throw fail('Model ' + key + ' is selected for more than one Auto Print label. Choose one destination per model.');
        models.set(key, id);
      }
    }
  }
  return next;
}
class AutoPrintSettings {
  constructor(file, env = process.env) { this.file = file; this.env = env; }
  read() {
    let value;
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw fail('Cannot read saved Auto Print settings: ' + e.message, 500);
      value = { enabled: /^(1|true|yes|on)$/i.test(String(this.env.AUTO_PRINT_ENABLED || '')),
        locations: String(this.env.AUTO_PRINT_LOCATIONS || '').split(',').map((s) => s.trim()).filter(Boolean),
        pollMs: Number(this.env.AUTO_PRINT_POLL_MS) || 15000 };
    }
    const normalized = validateAutoPrint(value);
    return { ...normalized, revision: revision(normalized) };
  }
  save(value, expectedRevision, labels) {
    const before = this.read();
    if (!expectedRevision) throw fail('Reload Auto Print before saving.', 428);
    if (before.revision !== expectedRevision) throw fail('Auto Print settings changed. Reload them before saving.', 409);
    const next = validateAutoPrint(value, labels);
    if (fs.existsSync(this.file)) atomicWrite(this.file + '.bak', { enabled: before.enabled, locations: before.locations, pollMs: before.pollMs });
    atomicWrite(this.file, next); return this.read();
  }
}
module.exports = { AutoPrintSettings, validateAutoPrint };
