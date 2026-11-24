'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { atomicWrite, fail } = require('./localStore');
const { prependProcessCode, applyWorkOrderFields } = require('./paintingFlow');
const pending = (j) => ['queued', 'submitting', 'printing', 'review'].includes(j.status);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PrintQueue {
  constructor({ file, agent, locations, db, getTemplate, renderTspl, mapRecordToFields,
    pollMs = 1000, pollTimeoutMs = 40000, drainTimeoutMs = 12000, gapMs = 400 }) {
    Object.assign(this, { file, agent, locations, db, getTemplate, renderTspl, mapRecordToFields,
      pollMs, pollTimeoutMs, drainTimeoutMs, gapMs });
    this.jobs = []; this.lanes = {}; this.workers = new Set(); this.seq = 0;
    this.splitReleases = {};
    this.stopped = false; this.fault = null; this.settingsBusy = false;
    this.load();
  }
  lane(key, target) {
    return this.lanes[key] ||= { key, name: target?.printerName || target?.printerId || 'Default label printer', paused: false };
  }
  load() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return; throw new Error('Cannot read print queue: ' + e.message); }
    if (!saved || !Array.isArray(saved.jobs)) throw new Error('Invalid saved print queue');
    this.jobs = saved.jobs;
    this.splitReleases = saved.splitReleases || {};
    this.seq = Math.max(saved.sequence || 0, ...this.jobs.map((j) => Number(j.id) || 0));
    for (const j of this.jobs) {
      j.options ||= structuredClone(this.locations.get(j.location));
      j.target ||= { agentUrl: j.options.agentUrl, printerId: j.options.printerId, printerType: j.options.printerType, resolved: false };
      j.queueKey ||= this.agent.keyFor(j.target);
      // Older queues did not retain acceptance IDs; they cannot safely replay a
      // label that might already be in Windows or physically printed.
      if (['printing', 'submitting'].includes(j.status) && !j.submissionId) {
        j.status = 'review'; j.error = 'Interrupted legacy print. Check the printer before retrying.';
      }
      const lane = this.lane(j.queueKey, j.target);
      if (pending(j)) lane.paused = true; // explicit Resume after restart
    }
    this.persist();
  }
  persist() {
    try { atomicWrite(this.file, { sequence: this.seq, lanes: this.lanes, jobs: this.jobs, splitReleases: this.splitReleases }); }
    catch (e) { this.fault = 'Queue storage failed. Restore storage access and restart the app.'; this.stopped = true; throw e; }
  }
  assertWritable() { if (this.stopped) throw fail(this.fault || 'Print queue is shutting down', 503); }
  findSplitPrint(releaseKey) { return this.splitReleases[releaseKey]; }
  add(jtcNo, location, sourceJtc, splitPart) {
    this.assertWritable();
    if (this.settingsBusy) throw fail('Printer settings are being saved. Try this job again shortly.', 409);
    const existing = splitPart && this.findSplitPrint(splitPart.releaseKey);
    if (existing != null && splitPart) return { id: existing };
    const options = structuredClone(this.locations.get(location));
    const target = { agentUrl: options.agentUrl, printerId: options.printerId, printerType: options.printerType, resolved: false };
    const job = { id: ++this.seq, jtcNo: String(jtcNo).trim(), sourceJtc: sourceJtc || null,
      location: options.id, options, target, queueKey: this.agent.keyFor(target), status: 'queued', error: null, at: Date.now() };
    const lane = this.lane(job.queueKey, target);
    if (splitPart) {
      job.splitPart = { number: splitPart.number, qty: splitPart.qty };
      this.splitReleases[splitPart.releaseKey] = job.id;
    }
    this.jobs.push(job); this.persist(); this.kick();
    return { id: job.id, position: this.jobs.filter((j) => j.queueKey === job.queueKey && pending(j)).length, paused: lane.paused };
  }
  list() {
    const keys = new Set(this.jobs.map((j) => j.queueKey));
    return { paused: [...keys].some((key) => this.lanes[key]?.paused), printing: this.workers.size > 0,
      fault: this.fault,
      queues: [...keys].map((key) => ({ ...this.lanes[key], busy: this.workers.has(key),
        pending: this.jobs.filter((j) => j.queueKey === key && pending(j)).length })),
      jobs: this.jobs.map((j) => ({ id: j.id, jtcNo: j.jtcNo, sourceJtc: j.sourceJtc || null,
        location: j.location, queueKey: j.queueKey, printerId: j.target.printerId || null,
        printerName: j.target.printerName || this.lanes[j.queueKey]?.name,
        splitPart: j.splitPart, status: j.status, error: j.error || null })) };
  }
  selected(key) {
    if (key && !this.lanes[key]) throw fail('Printer queue no longer exists. Refresh the page.', 404);
    return key ? [key] : [...new Set(this.jobs.map((j) => j.queueKey))];
  }
  pause(key) { this.assertWritable(); for (const k of this.selected(key)) this.lanes[k].paused = true; this.persist(); }
  resume(key) {
    this.assertWritable(); const keys = this.selected(key);
    if (this.jobs.some((j) => keys.includes(j.queueKey) && j.status === 'review')) throw fail('Check and resolve the uncertain print job before resuming this printer.', 409);
    for (const k of keys) this.lanes[k].paused = false;
    this.persist(); this.kick();
  }
  mutateRemoval(predicate) {
    this.assertWritable();
    if (this.jobs.some((j) => predicate(j) && pending(j) && this.workers.has(j.queueKey))) throw fail('Pause the printer and wait for the current send to finish first.', 409);
    if (this.jobs.some((j) => predicate(j) && ['submitting', 'printing'].includes(j.status))) throw fail('Check this in-flight job before removing it. Resolve its outcome first.', 409);
    this.jobs = this.jobs.filter((j) => !predicate(j));
    for (const lane of Object.values(this.lanes)) if (!this.jobs.some((j) => j.queueKey === lane.key && pending(j))) lane.paused = false;
    this.persist();
  }
  remove(id) { this.mutateRemoval((j) => j.id === Number(id)); }
  clearFinished(key) { const keys = this.selected(key); this.mutateRemoval((j) => keys.includes(j.queueKey) && !pending(j)); }
  clearAll(key) { const keys = this.selected(key); this.mutateRemoval((j) => keys.includes(j.queueKey)); }
  resolve(id, decision) {
    this.assertWritable();
    const job = this.jobs.find((j) => j.id === Number(id));
    const failedSplit = job?.splitPart && job.status === 'error' && decision === 'retry';
    if (!job || (job.status !== 'review' && !failedSplit)) throw fail('This job does not need outcome review.', 409);
    if (!['sent', 'retry'].includes(decision)) throw fail('Choose sent or retry');
    job.error = null;
    if (decision === 'sent') job.status = 'done';
    else { job.status = 'queued'; job.submissionId = null; job.agentJobId = null; job.tspl = null; job.submissionAt = null; this.lanes[job.queueKey].paused = true; }
    this.persist();
  }
  pendingJobs() { return this.jobs.filter(pending); }
  async withSettingsLock(operation) {
    if (this.settingsBusy) throw fail('Another printer settings save is in progress.', 409);
    this.settingsBusy = true;
    try { return await operation(); } finally { this.settingsBusy = false; }
  }
  hold(job, message, review = false) {
    if (review) job.status = 'review';
    job.error = message; this.lanes[job.queueKey].paused = true; this.persist();
    return 'pause';
  }
  async checkReady(target) {
    const s = await this.agent.printerStatus(target);
    if (s.connected === false || s.online === false || s.paused || s.hasError) throw fail('Printer is not ready (' + (s.status || 'offline') + ')', 409);
    return s;
  }
  async process(job) {
    if (job.status === 'review') return this.hold(job, job.error || 'Check the previous print outcome.', true);
    if (!job.target.resolved) {
      const previousKey = job.queueKey;
      try {
        const target = await this.agent.resolveTarget(job.target);
        const nextKey = this.agent.keyFor(target);
        const lane = this.lane(nextKey, target);
        lane.name = target.printerName;
        if (this.lanes[previousKey]?.paused) lane.paused = true;
        job.target = target; job.queueKey = nextKey;
        this.persist(); return 'move'; // restart under the canonical printer lock
      } catch (e) { return this.hold(job, e.message); }
    }
    if (job.status === 'queued') {
      let record;
      try {
        record = await this.db.getOne(job.jtcNo);
        if (!record) throw new Error('JTC not found');
        record = { ...record };
        if (job.sourceJtc || job.splitPart) { prependProcessCode(record, job.options); applyWorkOrderFields(record); }
        const template = await this.getTemplate(job.options.templateId);
        job.tspl = this.renderTspl(template, this.mapRecordToFields(record, job.options.templateId), { ...job.options, splitPart: job.splitPart });
      } catch (e) { job.status = 'error'; job.error = 'Render failed: ' + e.message; this.persist(); return 'continue'; }
      try { await this.agent.validateTarget(job.target); await this.checkReady(job.target); }
      catch (e) { return this.hold(job, e.message); }
      if (this.lanes[job.queueKey].paused || this.stopped) return 'pause';
      job.submissionId = 'fgui:' + randomUUID(); job.submissionAt = Date.now(); job.agentJobId = null;
      job.status = 'submitting'; job.error = null; this.persist();
    }
    if (job.status === 'submitting') {
      if (!job.agentJobId) {
        if (Date.now() - job.submissionAt > 23 * 60 * 60 * 1000) return this.hold(job, 'The submission is too old to replay safely. Check whether it printed.', true);
        try {
          const accepted = await this.agent.printLabel(job.tspl, job.target, job.submissionId);
          job.agentJobId = accepted.jobId; this.persist();
        } catch (e) {
          if (e.rejected) { job.status = 'queued'; job.submissionId = null; }
          return this.hold(job, e.message);
        }
      }
      const deadline = Date.now() + this.pollTimeoutMs;
      for (;;) {
        let outcome;
        try { outcome = await this.agent.jobStatus(job.agentJobId, job.target); }
        catch (e) { return this.hold(job, e.status === 404 ? 'The agent no longer has this job. Check whether it printed.' : e.message, e.status === 404); }
        if (outcome.status === 'SUCCESS') { job.status = 'printing'; job.error = null; this.persist(); break; }
        if (outcome.status === 'FAILED') {
          if (outcome.deliveryState !== 'notSent') return this.hold(job, (outcome.lastError || 'Sending was interrupted') + '. Check the printer before retrying.', true);
          job.status = 'queued'; job.submissionId = null; job.agentJobId = null;
          return this.hold(job, outcome.lastError || 'The job was not sent. Fix the printer and Resume.');
        }
        if (Date.now() >= deadline) return this.hold(job, 'Waiting for the agent. Resume will check this same job without creating a duplicate.');
        await delay(this.pollMs);
      }
    }
    if (job.status === 'printing') {
      const deadline = Date.now() + this.drainTimeoutMs;
      for (;;) {
        let status;
        try { status = await this.checkReady(job.target); }
        catch (e) { return this.hold(job, e.message + '. Resume will check the existing spool job.'); }
        if (typeof status.queueDepth !== 'number' || status.queueDepth === 0) {
          job.status = 'done'; job.error = null;
          const finished = this.jobs.filter((j) => !pending(j));
          const expired = new Set(finished.slice(0, -15));
          this.jobs = this.jobs.filter((j) => !expired.has(j)); this.persist();
          await delay(this.gapMs); return 'continue';
        }
        if (Date.now() >= deadline) return this.hold(job, 'The label is still in the Windows spooler. Check the printer, then Resume.');
        await delay(this.pollMs);
      }
    }
    return 'continue';
  }
  async worker(key) {
    try {
      while (!this.stopped && !this.lanes[key].paused) {
        const job = this.jobs.find((j) => j.queueKey === key && pending(j));
        if (!job) break;
        const result = await this.process(job);
        if (result === 'pause' || result === 'move') break;
      }
    } catch (e) {
      this.lanes[key].paused = true;
      console.error('[queue]', e.message);
    } finally { this.workers.delete(key); if (!this.stopped) this.kick(); }
  }
  kick() {
    if (this.stopped) return;
    for (const job of this.jobs) {
      const key = job.queueKey;
      if (!pending(job) || this.lanes[key].paused || this.workers.has(key)) continue;
      this.workers.add(key); queueMicrotask(() => this.worker(key));
    }
  }
  async clearPrinterSpooler(loc, key) {
    this.assertWritable();
    let target;
    if (key) { this.selected(key); target = this.jobs.find((j) => j.queueKey === key)?.target; }
    if (!target?.resolved) target = await this.agent.resolveTarget(loc);
    const queueKey = this.agent.keyFor(target);
    if (this.workers.has(queueKey)) throw fail('Pause this printer and wait for its current send to finish.', 409);
    if (target.printer.connection.type !== 'windows') throw fail('This network printer has no Windows spooler to clear.', 409);
    await this.agent.validateTarget(target);
    const state = await this.agent.clearSpooler(target);
    for (const job of this.jobs.filter((j) => j.queueKey === queueKey && ['submitting', 'printing'].includes(j.status))) {
      job.status = 'review'; job.error = 'The spooler was cleared. Check which labels printed before retrying.';
      this.lane(queueKey, target).paused = true;
    }
    this.persist();
    return { ok: true, empty: state.queueDepth === 0, printer: state.name };
  }
  stop() { this.stopped = true; }
}

module.exports = { PrintQueue, pending };
