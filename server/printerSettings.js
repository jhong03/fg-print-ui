'use strict';
const fs = require('node:fs');
const { fileFor, atomicWrite, revision, fail } = require('./localStore');

function localAgentUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('Enter a valid local print-agent address'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw fail('Settings can manage only a local HTTP print-agent, for example http://localhost:9000');
  }
  return url.origin;
}

class PrinterSettings {
  constructor(file = fileFor('printer-settings.json')) {
    this.file = file;
    this.read();
  }
  read() {
    let value = { agentUrl: null, assignments: {}, hiddenGroups: [], hiddenLocations: [] };
    try { value = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error(`Cannot read printer settings: ${e.message}`); }
    if (!value || !value.assignments || typeof value.assignments !== 'object' || Array.isArray(value.assignments)) throw fail('Invalid saved printer settings', 500);
    if (value.agentUrl != null) localAgentUrl(value.agentUrl);
    value.hiddenGroups ??= [];
    if (!Array.isArray(value.hiddenGroups) || value.hiddenGroups.some((group) => typeof group !== 'string' || !group.trim())) throw fail('Invalid saved label group visibility', 500);
    value.hiddenLocations ??= [];
    if (!Array.isArray(value.hiddenLocations) || value.hiddenLocations.some((id) => typeof id !== 'string' || !id.trim())) throw fail('Invalid saved label visibility', 500);
    this.current = value;
    return { ...structuredClone(value), revision: revision(value) };
  }
  apply(location) {
    const state = this.read();
    const assigned = Object.prototype.hasOwnProperty.call(state.assignments, location.id);
    let local = false;
    try { localAgentUrl(location.agentUrl); local = true; } catch {}
    return { ...location, localPrinterSettings: local,
      visible: !state.hiddenGroups.includes(location.group || 'Other') && !state.hiddenLocations.includes(location.id),
      agentUrl: local ? state.agentUrl || location.agentUrl : location.agentUrl,
      printerId: local && assigned ? state.assignments[location.id] : location.printerId };
  }
  save(value, expectedRevision) {
    const previous = this.read();
    if (!expectedRevision) throw fail('Reload Settings before saving', 428);
    if (expectedRevision !== previous.revision) throw fail('Printer assignments changed. Reload Settings before saving.', 409);
    if (!value || typeof value !== 'object' || !value.assignments || typeof value.assignments !== 'object' || Array.isArray(value.assignments)) throw fail('Invalid printer assignments');
    const assignments = Object.create(null);
    for (const [id, printerId] of Object.entries(value.assignments)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || (printerId !== null && (typeof printerId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(printerId)))) throw fail('Invalid destination or printer ID');
      assignments[id] = printerId;
    }
    const hiddenGroups = value.hiddenGroups ?? previous.hiddenGroups;
    if (!Array.isArray(hiddenGroups) || hiddenGroups.some((group) => typeof group !== 'string' || !group.trim())) throw fail('Invalid label group visibility');
    const hiddenLocations = value.hiddenLocations ?? previous.hiddenLocations;
    if (!Array.isArray(hiddenLocations) || hiddenLocations.some((id) => typeof id !== 'string' || !id.trim())) throw fail('Invalid label visibility');
    const next = { agentUrl: value.agentUrl == null ? null : localAgentUrl(value.agentUrl), assignments,
      hiddenGroups: [...new Set(hiddenGroups)], hiddenLocations: [...new Set(hiddenLocations)] };
    atomicWrite(this.file, next);
    return this.read();
  }
}
const store = new PrinterSettings();
module.exports = store;
module.exports.PrinterSettings = PrinterSettings;
module.exports.localAgentUrl = localAgentUrl;
