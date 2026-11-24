'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-ui-unit-'));
process.env.FG_UI_DATA_DIR = testRoot;
after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
const { PrintQueue } = require('../server/queueManager');
const { PrinterSettings, localAgentUrl } = require('../server/printerSettings');
const { registerSettings } = require('../server/settingsRoutes');
const { keyFor } = require('../server/agent');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await pause(5); } throw new Error('Expected state did not appear'); }

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(testRoot, 'queue-'));
  const calls = [];
  const locations = { get: (id) => ({ id, name: id, agentUrl: 'http://localhost:9000', printerId: id, templateId: '11' }) };
  const agent = { keyFor, resolveTarget: async (loc) => ({ ...loc, resolved: true, printerName: 'Printer ' + loc.printerId,
    printer: { id: loc.printerId, protocol: 'tspl', connection: { type: 'tcp', host: '127.0.0.1', port: 9100 } } }),
  validateTarget: async () => {}, printerStatus: async () => ({ connected: true, status: 'READY', queueDepth: 0 }),
  printLabel: async (tspl, target, submissionId) => { calls.push({ tspl, target, submissionId }); return { jobId: 'accepted-' + submissionId }; },
  jobStatus: async () => ({ status: 'SUCCESS', deliveryState: 'sent' }), ...overrides };
  const options = { file: path.join(dir, 'jobs.json'), agent, locations, db: { getOne: async (jtcNo) => ({ jtcNo }) },
    getTemplate: async () => ({}), renderTspl: (template, record) => record.jtcNo, mapRecordToFields: (r) => r,
    pollMs: 5, pollTimeoutMs: 30, drainTimeoutMs: 15, gapMs: 0 };
  const queue = new PrintQueue(options);
  t.after(() => queue.stop());
  return { queue, options, agent, calls, locations, dir };
}

test('local settings persist separately with conflict detection and safe local agent URLs', (t) => {
  const file = path.join(testRoot, 'settings.json');
  const settings = new PrinterSettings(file), initial = settings.read();
  settings.save({ agentUrl: 'http://localhost:9000', assignments: { fg: 'a' } }, initial.revision);
  assert.equal(new PrinterSettings(file).apply({ id: 'fg', agentUrl: 'http://localhost:9000' }).printerId, 'a');
  // Local Settings must not silently redirect an existing remote destination.
  assert.equal(settings.apply({ id: 'fg', agentUrl: 'http://10.0.0.25:9000', printerId: 'remote-labels' }).printerId, 'remote-labels');
  assert.equal(settings.apply({ id: 'fg', agentUrl: 'http://10.0.0.25:9000' }).agentUrl, 'http://10.0.0.25:9000');
  assert.throws(() => settings.save({ agentUrl: 'http://localhost:9000', assignments: {} }, initial.revision), /changed/);
  for (const bad of ['http://example.com:9000', 'http://127.0.0.1:9000/path', 'http://user:pass@localhost:9000']) assert.throws(() => localAgentUrl(bad));
  assert.equal(localAgentUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
});

test('one failed printer pauses only its queue while the other printer sends', async (t) => {
  const f = fixture(t, { printerStatus: async (target) => target.printerId === 'a' ? { connected: false, status: 'OFFLINE' } : { connected: true } });
  f.queue.add('job-a', 'a'); f.queue.add('job-b', 'b');
  await until(() => f.queue.jobs[0].error && f.queue.jobs[1].status === 'done');
  assert.equal(f.queue.jobs[0].status, 'queued');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].target.printerId, 'b');
  assert.equal(f.queue.list().queues.find((q) => q.name === 'Printer a').paused, true);
});

test('group visibility survives restarts and assignment saves without losing printer assignments', () => {
  const file = path.join(testRoot, 'visibility-settings.json');
  const settings = new PrinterSettings(file);
  settings.save({ agentUrl: null, assignments: { fg: 'a' }, hiddenGroups: ['P1'] }, settings.read().revision);
  const reloaded = new PrinterSettings(file);
  const hidden = reloaded.apply({ id: 'fg', group: 'P1', agentUrl: 'http://localhost:9000' });
  assert.equal(hidden.visible, false);
  assert.equal(hidden.printerId, 'a');
  assert.equal(reloaded.apply({ id: 'work', group: 'P3', agentUrl: 'http://localhost:9000' }).visible, true);
  reloaded.save({ agentUrl: 'http://localhost:9000', assignments: { fg: 'b' } }, reloaded.read().revision);
  assert.deepEqual(reloaded.read().hiddenGroups, ['P1']);
  assert.equal(reloaded.read().assignments.fg, 'b');
});

test('visibility API works without the agent and validates group names and revisions', async (t) => {
  const settings = new PrinterSettings(path.join(testRoot, 'offline-visibility.json'));
  const app = express(); app.use(express.json());
  let agentCalls = 0;
  registerSettings(app, { settings, queue: { pendingJobs: () => [] },
    locations: { list: () => [{ id: 'fg', group: 'P1' }, { id: 'work', group: 'P3' }] },
    agent: { DEFAULT_AGENT_URL: 'http://localhost:9000', management: async () => { agentCalls++; throw new Error('offline'); } } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'X-Print-UI-Settings': '1', 'Content-Type': 'application/json' };
  const initial = settings.read();
  const save = (body) => fetch(base + '/api/settings/visibility', { method: 'PUT', headers, body: JSON.stringify(body) });
  assert.equal((await save({ revision: initial.revision, hiddenGroups: ['P1'] })).status, 200);
  assert.equal(agentCalls, 0);
  assert.equal((await save({ revision: initial.revision, hiddenGroups: [] })).status, 409);
  assert.equal((await save({ revision: settings.read().revision, hiddenGroups: ['unknown'] })).status, 400);
  assert.deepEqual(settings.read().hiddenGroups, ['P1']);
  assert.equal((await save({ revision: settings.read().revision, hiddenGroups: [], hiddenLocations: ['work'] })).status, 200);
  assert.deepEqual(settings.read().hiddenLocations, ['work']);
  assert.equal((await save({ revision: settings.read().revision, hiddenGroups: ['P3'] })).status, 200);
  assert.deepEqual(settings.read().hiddenLocations, ['work']);
  assert.equal((await save({ revision: settings.read().revision, hiddenGroups: [], hiddenLocations: ['missing'] })).status, 400);
  assert.equal((await save({ revision: settings.read().revision, hiddenGroups: [], hiddenLocations: 'work' })).status, 400);
});

test('individual visibility persists under a hidden group and survives assignment updates', () => {
  const file = path.join(testRoot, 'individual-visibility.json');
  const settings = new PrinterSettings(file);
  settings.save({ agentUrl: null, assignments: { work: 'a' }, hiddenGroups: [], hiddenLocations: ['work'] }, settings.read().revision);
  const loc = { id: 'work', group: 'P3', agentUrl: 'http://localhost:9000' };
  const other = { ...loc, id: 'rework' };
  assert.equal(settings.apply(loc).visible, false);
  assert.equal(settings.apply(other).visible, true);
  settings.save({ ...settings.read(), hiddenGroups: ['P3'] }, settings.read().revision);
  assert.equal(settings.apply(other).visible, false);
  settings.save({ agentUrl: null, assignments: { work: 'b' }, hiddenGroups: [] }, settings.read().revision);
  const reloaded = new PrinterSettings(file);
  assert.equal(reloaded.apply(loc).visible, false);
  assert.equal(reloaded.apply(other).visible, true);
  assert.equal(reloaded.apply(loc).printerId, 'b');
});

test('labels for one printer send in order without overlap', async (t) => {
  let active = 0, maximum = 0;
  const f = fixture(t, { jobStatus: async () => { active++; maximum = Math.max(maximum, active); await pause(10); active--; return { status: 'SUCCESS' }; } });
  f.queue.add('first', 'a'); f.queue.add('second', 'a');
  await until(() => f.queue.jobs.every((j) => j.status === 'done'));
  assert.equal(maximum, 1); assert.deepEqual(f.calls.map((c) => c.tspl), ['first', 'second']);
});

test('lost acceptance reply reuses the same submission and exact label bytes on Resume', async (t) => {
  const sent = [];
  const f = fixture(t, { printLabel: async (tspl, target, id) => {
    sent.push([tspl, id]);
    if (sent.length === 1) throw new Error('reply lost after acceptance');
    return { jobId: 'original-agent-job' };
  } });
  f.queue.add('stable-label', 'a');
  await until(() => f.queue.jobs[0].error);
  assert.equal(f.queue.jobs[0].status, 'submitting');
  f.queue.resume(f.queue.jobs[0].queueKey);
  await until(() => f.queue.jobs[0].status === 'done');
  assert.deepEqual(sent[0], sent[1]);
});

test('uncertain sends require review; intentional retry gets a new submission ID', async (t) => {
  let reads = 0;
  const f = fixture(t, { jobStatus: async () => ++reads === 1 ? { status: 'FAILED', deliveryState: 'unknown', lastError: 'connection dropped' } : { status: 'SUCCESS' } });
  const added = f.queue.add('uncertain', 'a');
  await until(() => f.queue.jobs[0].status === 'review');
  assert.throws(() => f.queue.resume(f.queue.jobs[0].queueKey), /resolve/);
  const firstId = f.calls[0].submissionId;
  f.queue.resolve(added.id, 'retry'); f.queue.resume(f.queue.jobs[0].queueKey);
  await until(() => f.queue.jobs[0].status === 'done');
  assert.notEqual(f.calls[1].submissionId, firstId);
});

test('restart keeps accepted job identity and waits for Resume before reconciling', async (t) => {
  const f = fixture(t, { jobStatus: async () => { throw new Error('agent temporarily unavailable'); } });
  f.queue.add('accepted', 'a'); await until(() => f.queue.jobs[0].error);
  const originalId = f.queue.jobs[0].agentJobId;
  f.queue.stop();
  const restarted = new PrintQueue({ ...f.options, agent: { ...f.agent, jobStatus: async () => ({ status: 'SUCCESS' }) } });
  t.after(() => restarted.stop());
  assert.equal(restarted.list().queues[0].paused, true);
  assert.equal(restarted.jobs[0].agentJobId, originalId);
  restarted.resume(restarted.jobs[0].queueKey);
  await until(() => restarted.jobs[0].status === 'done');
  assert.equal(f.calls.length, 1);
});

test('old interrupted queue entries are held for review instead of reprinted', (t) => {
  const f = fixture(t); f.queue.stop();
  fs.writeFileSync(f.options.file, JSON.stringify({ jobs: [{ id: 1, jtcNo: 'legacy', location: 'a', status: 'printing' }] }));
  const restarted = new PrintQueue(f.options); t.after(() => restarted.stop());
  assert.equal(restarted.jobs[0].status, 'review');
  assert.throws(() => restarted.resume(), /resolve/);
});

test('assignment changes do not redirect waiting labels', async (t) => {
  const f = fixture(t);
  f.queue.add('waiting', 'a');
  const key = f.queue.jobs[0].queueKey; f.queue.pause(key);
  f.locations.get = () => ({ id: 'a', agentUrl: 'http://localhost:9000', printerId: 'b' });
  f.queue.resume(key);
  await until(() => f.queue.jobs[0].status === 'done');
  assert.equal(f.calls[0].target.printerId, 'a');
});

test('a draining Windows spooler is reconciled on Resume without another send', async (t) => {
  let spoolDepth = 1;
  const f = fixture(t, { printerStatus: async () => ({ connected: true, queueDepth: spoolDepth }) });
  f.queue.add('spooled', 'a');
  await until(() => f.queue.jobs[0].error?.includes('spooler'));
  assert.equal(f.queue.jobs[0].status, 'printing'); assert.equal(f.calls.length, 1);
  spoolDepth = 0; f.queue.resume(f.queue.jobs[0].queueKey);
  await until(() => f.queue.jobs[0].status === 'done');
  assert.equal(f.calls.length, 1);
});

test('settings save prevents a concurrent submission from bypassing destination checks', async (t) => {
  const f = fixture(t);
  let release;
  const saving = f.queue.withSettingsLock(() => new Promise((resolve) => { release = resolve; }));
  assert.throws(() => f.queue.add('during-settings-save', 'a'), /settings are being saved/);
  release(); await saving;
  f.queue.add('after-settings-save', 'a');
  await until(() => f.queue.jobs[0].status === 'done');
});

test('clearing a queue during label preparation cannot orphan a later hardware send', async (t) => {
  const f = fixture(t);
  let release;
  f.options.db.getOne = () => new Promise((r) => { release = () => r({ jtcNo: 'prepared' }); });
  f.queue.add('preparing', 'a');
  await until(() => release);
  const key = f.queue.jobs[0].queueKey;
  f.queue.pause(key);
  assert.throws(() => f.queue.clearAll(key), /wait for the current send/);
  release();
  await until(() => !f.queue.workers.size);
  f.queue.clearAll(key);
  assert.equal(f.calls.length, 0);
});

test('Settings API protects access and rejects assigning receipt printers to TSPL labels', async (t) => {
  const settings = new PrinterSettings(path.join(testRoot, 'api-settings.json'));
  const config = { agentId: 'test', localHttpPort: 9000, printers: [{ id: 'a', name: 'Labels', enabled: true, protocol: 'tspl' }, { id: 'r', name: 'Receipt', enabled: true, protocol: 'escpos' }] };
  const app = express(); app.use(express.json());
  registerSettings(app, { settings, queue: { pendingJobs: () => [] }, locations: { list: () => [{ id: 'fg', name: 'FG', printerId: null }] },
    agent: { DEFAULT_AGENT_URL: 'http://localhost:9000', management: async () => ({ config, revision: 'agent-revision' }) } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/api/settings')).status, 403);
  assert.equal((await fetch(base + '/api/settings', { headers: { 'X-Print-UI-Settings': '1', Origin: 'http://evil.test' } })).status, 403);
  const headers = { 'X-Print-UI-Settings': '1', 'Content-Type': 'application/json' };
  const state = await (await fetch(base + '/api/settings', { headers })).json();
  const bad = await fetch(base + '/api/settings/assignments', { method: 'PUT', headers,
    body: JSON.stringify({ revision: state.routing.revision, assignments: { fg: 'r' } }) });
  assert.equal(bad.status, 400);
  const good = await fetch(base + '/api/settings/assignments', { method: 'PUT', headers,
    body: JSON.stringify({ revision: state.routing.revision, assignments: { fg: 'a' } }) });
  assert.equal(good.status, 200);
  assert.equal(settings.read().assignments.fg, 'a');
});
