'use strict';
const fs = require('node:fs');
const { atomicWrite, revision, fail } = require('./localStore');
const bools = ['upright', 'weldingToPainting', 'requireQrBinding', 'reworkQrBinding', 'doneOnly', 'boldTitle', 'splitWoLabels'];

function validateLocations(input) {
  if (!Array.isArray(input) || !input.length || input.length > 500) throw fail('Keep between 1 and 500 labels.');
  const ids = new Set(), pairs = new Map();
  const result = input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail('Invalid label at position ' + (index + 1));
    const loc = structuredClone(entry);
    const label = loc.name || loc.id || 'Label ' + (index + 1);
    const error = (message) => { throw fail(label + ': ' + message); };
    for (const key of ['__proto__', 'constructor', 'prototype']) if (Object.hasOwn(loc, key)) error('Invalid configuration field.');
    for (const key of ['id', 'name', 'group', 'modeGroup', 'qrWorkcell', 'processCodePrepend', 'printerId']) {
      if (loc[key] == null && !['id', 'name'].includes(key)) continue;
      if (typeof loc[key] !== 'string' || loc[key].length > 256 || /[\x00-\x1f]/.test(loc[key])) error('Invalid ' + key + '.');
      loc[key] = loc[key].trim();
    }
    if (!loc.id || !/^[a-zA-Z0-9_-]{1,128}$/.test(loc.id) || ids.has(loc.id)) error('Label IDs must be unique letters, numbers, underscores or hyphens.');
    if (!loc.name) error('Enter a label name.');
    ids.add(loc.id);
    if (loc.templateId != null && loc.templateId !== '') {
      if (!['string', 'number'].includes(typeof loc.templateId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(String(loc.templateId))) error('Invalid template ID.');
      loc.templateId = String(loc.templateId);
    }
    for (const key of bools) if (loc[key] != null && typeof loc[key] !== 'boolean') error(key + ' must be on or off.');
    for (const key of ['models', 'boldText']) if (loc[key] != null) {
      if (!Array.isArray(loc[key]) || loc[key].length > 500 || loc[key].some((v) => typeof v !== 'string' || v.length > 256 || /[\x00-\x1f]/.test(v))) error(key + ' must be a list of text values.');
      loc[key] = [...new Set(loc[key].map((v) => key === 'models' ? v.trim().toUpperCase() : v.trim()).filter(Boolean))];
    }
    if (loc.mode != null && !['', 'normal', 'rework'].includes(loc.mode)) error('Mode must be Normal, Rework or no mode.');
    if (loc.variant != null && !['', 'qc', 'plain'].includes(loc.variant)) error('Choose QC or Plain.');
    if (loc.printerType != null && !['', 'tsc', 'hprt'].includes(loc.printerType)) error('Invalid printer type.');
    if (loc.barcodeNudge != null && (!Number.isInteger(loc.barcodeNudge) || Math.abs(loc.barcodeNudge) > 10000)) error('Barcode nudge must be a whole number between -10000 and 10000.');
    if (loc.toLocation != null && (!Number.isInteger(loc.toLocation) || loc.toLocation < 0)) error('Stock location must be a positive whole number or blank.');
    if (loc.agentUrl != null && typeof loc.agentUrl !== 'string') error('Agent address must be text.');
    if (loc.agentUrl) {
      let url; try { url = new URL(loc.agentUrl); } catch { error('Invalid agent address.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) error('Use an HTTP agent address without credentials or a path.');
      loc.agentUrl = url.origin;
    }
    if (loc.requireQrBinding && loc.reworkQrBinding) error('Choose either Green/Red binding or Black Rework binding.');
    if ((loc.reworkQrBinding && loc.mode === 'normal') || (loc.requireQrBinding && loc.mode === 'rework')) error('The QR binding option must match the selected mode.');
    if (loc.weldingToPainting && (loc.reworkQrBinding || loc.mode === 'rework')) error('Welding to Painting is for the Normal flow.');
    if (loc.splitPartOneQty != null && (!Number.isInteger(loc.splitPartOneQty) || loc.splitPartOneQty < 1 || loc.splitPartOneQty > 49)) error('Part 1 quantity must be a whole number from 1 to 49.');
    const key = loc.modeGroup || loc.id;
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(loc);
    return loc;
  });
  for (const members of pairs.values()) if (members.length > 1) {
    if (members.length !== 2 || !members.some((l) => l.mode === 'normal') || !members.some((l) => l.mode === 'rework')
      || (members[0].group || '') !== (members[1].group || '')) {
      throw fail('Labels sharing a mode group must be one Normal and one Rework label in the same group.');
    }
  }
  return result;
}

class LocationConfig {
  constructor(file) { this.file = file; }
  snapshot() {
    let text = null;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    let value;
    try { value = text == null ? [{ id: 'default', name: 'Default' }] : JSON.parse(text); }
    catch { throw fail('Cannot read locations.json. Restore valid JSON before editing labels.', 500); }
    if (!Array.isArray(value)) throw fail('locations.json must contain a list of labels.', 500);
    return { locations: value.length ? value : [{ id: 'default', name: 'Default' }], revision: revision(text), text };
  }
  read() { const { locations, revision: token } = this.snapshot(); return { locations, revision: token }; }
  save(value, expectedRevision) {
    const before = this.snapshot();
    if (!expectedRevision) throw fail('Reload label configuration before saving.', 428);
    if (before.revision !== expectedRevision) throw fail('Label configuration changed. Reload it before saving.', 409);
    const next = validateLocations(value);
    if (before.text != null) atomicWrite(this.file + '.bak', JSON.parse(before.text));
    atomicWrite(this.file, next);
    return this.read();
  }
}
module.exports = { LocationConfig, validateLocations };
