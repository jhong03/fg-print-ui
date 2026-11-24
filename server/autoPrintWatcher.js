'use strict';
const fs = require('node:fs');
const { atomicWrite, fail } = require('./localStore');
const { validateAutoPrint } = require('./autoPrintSettings');
const { isLeakTest, resolvePainting } = require('./paintingFlow');
class AutoPrintWatcher {
  constructor({ settings, file, db, locations, printQueue, bindingQueue, clock = Date.now }) {
    Object.assign(this, { settings, file, db, locations, printQueue, bindingQueue, clock });
    this.watermark = null; this.printedIds = new Set(); this.routeSince = Object.create(null);
    this.polling = false; this.started = false; this.changing = false; this.epoch = 0;
    this.lastPoll = this.lastError = this.lastQueued = null;
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(state.printedIds) || (state.watermark && !Number.isFinite(Date.parse(state.watermark)))) throw new Error('Invalid completion history');
      this.watermark = state.watermark || null; this.printedIds = new Set(state.printedIds);
      if (state.routeSince && (typeof state.routeSince !== 'object' || Array.isArray(state.routeSince) || Object.values(state.routeSince).some((date) => !Number.isFinite(Date.parse(date))))) throw new Error('Invalid activation history');
      Object.assign(this.routeSince, state.routeSince || {});
    } catch (e) { if (e.code !== 'ENOENT') this.stateError = 'Cannot read Auto Print history. Restore the history file before enabling it.'; }
  }
  persist() {
    if (this.printedIds.size > 5000) this.printedIds = new Set([...this.printedIds].sort((a, b) => a - b).slice(-5000));
    try { atomicWrite(this.file, { watermark: this.watermark, printedIds: [...this.printedIds], routeSince: this.routeSince }); }
    catch (e) { this.stateError = 'Auto Print stopped because completion history could not be saved.'; this.stop(); throw e; }
  }
  validateLocations(labels) { return validateAutoPrint(this.settings.read(), labels); }
  routeMap(config = this.settings.read()) {
    const labels = this.locations.list(); validateAutoPrint(config, config.enabled ? labels : undefined);
    const map = new Map();
    for (const loc of labels) if (config.locations.includes(loc.id) && !loc.reworkQrBinding && loc.mode !== 'rework') {
      for (const model of loc.models || []) map.set(model, loc);
    }
    return map;
  }
  async poll() {
    let config;
    try { config = this.settings.read(); } catch (e) { this.lastError = e.message; this.stop(); return; }
    if (!this.started || !config.enabled || this.polling || this.changing || this.stateError) return;
    this.polling = true; const epoch = this.epoch;
    const current = () => this.started && !this.changing && epoch === this.epoch;
    try {
      if (!this.watermark) {
        const mark = await this.db.getLatestCompletionMark(); if (!current()) return;
        this.watermark = new Date(mark || this.clock()).toISOString(); this.persist();
        this.lastPoll = new Date(this.clock()).toISOString(); this.lastError = null; return;
      }
      const rows = await this.db.getCompletedSince(new Date(this.watermark)); if (!current()) return;
      this.lastPoll = new Date(this.clock()).toISOString(); this.lastError = null;
      const map = this.routeMap(config); let nextMark = this.watermark;
      for (const row of rows || []) {
        const end = row.actualEnd ? new Date(row.actualEnd).toISOString() : null;
        if (end && end > nextMark) nextMark = end;
        const id = row.jobId != null ? row.jobId : row.barcodeId;
        if (id == null || this.printedIds.has(id)) continue;
        const loc = map.get(String(row.model || '').trim().toUpperCase()); if (!loc) continue;
        if (Number.isInteger(loc.toLocation) && row.toLocationId !== loc.toLocation) continue;
        if (this.routeSince[loc.id] && (!end || end <= this.routeSince[loc.id])) continue;
        let printJtc = row.jtcNo, sourceJtc = null;
        if (loc.weldingToPainting) {
          if (!isLeakTest(row.processCode) || !String(row.parentJtcNo || '').trim()) continue;
          printJtc = String(row.parentJtcNo).trim(); sourceJtc = row.jtcNo;
        }
        if (loc.requireQrBinding) this.bindingQueue.add(printJtc, loc.id, sourceJtc, 'normal', loc.splitPartOneQty);
        else this.printQueue.add(printJtc, loc.id, sourceJtc);
        this.printedIds.add(id); this.persist();
        this.lastQueued = { jtcNo: printJtc, sourceJtc: row.jtcNo, model: row.model, location: loc.id };
      }
      if (nextMark !== this.watermark) { this.watermark = nextMark; this.persist(); }
    } catch (e) { this.lastError = e.message; console.error('[auto] poll failed:', e.message); }
    finally { this.polling = false; }
  }
  clearTimers() { clearTimeout(this.firstTimer); clearInterval(this.timer); this.firstTimer = this.timer = null; }
  start() {
    if (this.started || this.changing || this.stateError) return;
    const config = this.settings.read(); if (!config.enabled) return;
    if (typeof this.db.getCompletedSince !== 'function' || typeof this.db.getLatestCompletionMark !== 'function') { this.lastError = 'This database adapter does not support completion watching.'; return; }
    this.started = true;
    this.firstTimer = setTimeout(() => void this.poll(), 2000);
    this.timer = setInterval(() => void this.poll(), config.pollMs);
  }
  stop() { this.epoch++; this.clearTimers(); this.started = false; }
  async configure(value, revision) {
    if (this.changing) throw fail('Another Auto Print save is in progress.', 409);
    const before = this.settings.read();
    if (!revision) throw fail('Reload Auto Print before saving.', 428);
    if (revision !== before.revision) throw fail('Auto Print settings changed. Reload them before saving.', 409);
    const next = validateAutoPrint(value, this.locations.list());
    if (next.enabled && this.stateError) throw fail(this.stateError, 409);
    if (next.enabled && (typeof this.db.getLatestCompletionMark !== 'function' || typeof this.db.getCompletedSince !== 'function')) throw fail('This database does not support Auto Print.');
    this.changing = true; this.stop();
    try {
      const added = next.enabled ? next.locations.filter((id) => !before.enabled || !before.locations.includes(id)) : [];
      if (added.length) {
        const mark = await this.db.getLatestCompletionMark();
        const boundary = new Date(mark || this.clock()).toISOString();
        for (const id of added) this.routeSince[id] = boundary;
        if (!this.watermark) this.watermark = boundary;
        this.persist();
      }
      const saved = this.settings.save(next, revision, this.locations.list());
      this.lastError = null; return saved;
    } finally { this.changing = false; this.start(); }
  }
  status() {
    const config = this.settings.read(); let models = [];
    try { models = [...this.routeMap(config).keys()]; } catch (e) { this.lastError = e.message; }
    return { enabled: config.enabled, started: this.started, changing: this.changing, ownedLocations: config.locations,
      models, watermark: this.watermark, printedCount: this.printedIds.size, pollMs: config.pollMs,
      lastPoll: this.lastPoll, lastError: this.stateError || this.lastError, lastQueued: this.lastQueued };
  }
  configuration() {
    return { ...this.settings.read(), status: this.status(), labels: this.locations.list().map((l) => ({ id: l.id, name: l.name, group: l.group,
      models: l.models, manualOnly: l.reworkQrBinding || l.mode === 'rework', requireQrBinding: l.requireQrBinding })) };
  }
  async testTrigger(jtcNo, override = null) {
    const record = await this.db.getOne(jtcNo); if (!record) return { ok: false, reason: 'JTC not found', jtcNo };
    const loc = override ? this.locations.get(override) : this.routeMap().get(String(record.model || '').trim().toUpperCase());
    if (!loc) return { ok: false, reason: 'This model is not assigned to Auto Print on this computer.', model: record.model };
    if (loc.reworkQrBinding || loc.mode === 'rework') return { ok: false, reason: 'Rework locations are manual-only and cannot be auto-triggered.' };
    const { record: target, sourceJtc } = await resolvePainting(record, loc, this.db);
    if (loc.splitPartOneQty != null && !sourceJtc && isLeakTest(record.processCode)) {
      return { ok: false, reason: 'This Leak Test job has no linked Painting job. Scan the Painting JTC directly.' };
    }
    this.locations.assertUnchanged(loc);
    if (loc.requireQrBinding) {
      const result = this.bindingQueue.add(target.jtcNo, loc.id, sourceJtc, 'normal', loc.splitPartOneQty);
      return { ok: true, jtcNo, printJtc: target.jtcNo, sourceJtc, model: record.model, location: loc.id, staged: true, bindingId: result.id };
    }
    const result = this.printQueue.add(target.jtcNo, loc.id, sourceJtc);
    return { ok: true, jtcNo, printJtc: target.jtcNo, sourceJtc, model: record.model, location: loc.id, queueId: result.id, position: result.position, paused: result.paused };
  }
}
module.exports = { AutoPrintWatcher };
