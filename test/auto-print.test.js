'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { AutoPrintSettings, validateAutoPrint } = require('../server/autoPrintSettings');
const { AutoPrintWatcher } = require('../server/autoPrintWatcher');
const time = (hour) => '2026-11-13T' + String(hour).padStart(2, '0') + ':00:00.000Z';
function fixture(t, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-auto-test-'));
  const settings = new AutoPrintSettings(path.join(dir, 'settings.json'), { AUTO_PRINT_ENABLED: String(enabled), AUTO_PRINT_LOCATIONS: 'a', AUTO_PRINT_POLL_MS: '15000' });
  const labels = [{ id: 'a', name: 'Label A', models: ['A'] }, { id: 'b', name: 'Label B', models: ['B'] },
    { id: 'q', name: 'QR label', models: ['Q'], requireQrBinding: true, weldingToPainting: true },
    { id: 'r', name: 'Rework', models: ['R'], mode: 'rework' }, { id: 'empty', name: 'No models', models: [] }];
  const state = path.join(dir, 'history.json'); fs.writeFileSync(state, JSON.stringify({ watermark: time(0), printedIds: [99] }));
  let rows = [], latest = time(10), reads = 0;
  const prints = [], bindings = [];
  const dependencies = { settings, file: state, locations: { list: () => labels },
    db: { getLatestCompletionMark: async () => latest, getCompletedSince: async () => { reads++; return rows; } },
    printQueue: { add: (...args) => prints.push(args) }, bindingQueue: { add: (...args) => bindings.push(args) } };
  const watcher = new AutoPrintWatcher(dependencies); watcher.start();
  t.after(() => { watcher.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { watcher, settings, labels, prints, bindings, state, dependencies, get reads() { return reads; },
    set rows(value) { rows = value; }, set latest(value) { latest = value; } };
}
const row = (id, model, hour, extra = {}) => ({ jobId: id, model, jtcNo: 'J' + id, actualEnd: time(hour), ...extra });

test('Auto Print settings inherit old defaults once and persist frontend overrides with revisions', (t) => {
  const f = fixture(t, false), first = f.settings.read();
  assert.equal(first.enabled, false); assert.deepEqual(first.locations, ['a']);
  f.settings.save({ enabled: true, locations: ['a'], pollMs: 3000 }, first.revision, f.labels);
  const restarted = new AutoPrintSettings(f.settings.file, { AUTO_PRINT_ENABLED: 'false' });
  assert.equal(restarted.read().enabled, true); assert.equal(restarted.read().pollMs, 3000);
  assert.throws(() => f.settings.save({ enabled: false, locations: [], pollMs: 1000 }, first.revision), (e) => e.status === 409);
  for (const config of [{ enabled: true, locations: [], pollMs: 1000 }, { enabled: true, locations: ['r'], pollMs: 1000 },
    { enabled: true, locations: ['empty'], pollMs: 1000 }, { enabled: true, locations: ['missing'], pollMs: 1000 },
    { enabled: false, locations: [], pollMs: 100 }]) assert.throws(() => validateAutoPrint(config, f.labels));
  assert.throws(() => validateAutoPrint({ enabled: true, locations: ['a', 'b'], pollMs: 1000 }, [f.labels[0], { ...f.labels[1], models: ['A'] }]), /more than one/);
});

test('polling retains deduplication and history through interval changes and restarts', async (t) => {
  const f = fixture(t);
  f.rows = [row(99, 'A', 1), row(1, 'A', 2), row(2, 'B', 3)]; await f.watcher.poll();
  assert.deepEqual(f.prints, [['J1', 'a', null]]);
  const before = JSON.parse(fs.readFileSync(f.state));
  await f.watcher.configure({ enabled: true, locations: ['a'], pollMs: 3000 }, f.settings.read().revision);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.state)), before);
  f.watcher.stop(); const reopened = new AutoPrintWatcher(f.dependencies); t.after(() => reopened.stop()); reopened.start();
  await reopened.poll(); assert.equal(f.prints.length, 1);
  f.rows = [row(3, 'A', 4)]; await reopened.poll(); assert.equal(f.prints.length, 2);
  assert.equal(reopened.status().printedCount, 3); assert.equal(reopened.status().watermark, time(4));
});

test('enabling and reenabling skip earlier completions while preserving previously printed IDs', async (t) => {
  const f = fixture(t, false);
  f.watcher.watermark = null;
  await f.watcher.configure({ enabled: true, locations: ['a'], pollMs: 15000 }, f.settings.read().revision);
  f.rows = [row(1, 'A', 9), row(2, 'A', 11)]; await f.watcher.poll();
  assert.deepEqual(f.prints, [['J2', 'a', null]]);
  await f.watcher.configure({ enabled: false, locations: ['a'], pollMs: 15000 }, f.settings.read().revision);
  const readCount = f.reads; await f.watcher.poll(); assert.equal(f.reads, readCount);
  f.latest = time(12);
  await f.watcher.configure({ enabled: true, locations: ['a'], pollMs: 15000 }, f.settings.read().revision);
  f.rows = [row(3, 'A', 12), row(4, 'A', 13)]; await f.watcher.poll();
  assert.deepEqual(f.prints.map((p) => p[0]), ['J2', 'J4']);
  assert.deepEqual([...f.watcher.printedIds], [99, 2, 4]);
});

test('disabling cancels an in-flight completion lookup before it can queue work', async (t) => {
  const f = fixture(t); let finish;
  f.dependencies.db.getCompletedSince = () => new Promise((r) => { finish = r; });
  const pending = f.watcher.poll();
  await f.watcher.configure({ enabled: false, locations: ['a'], pollMs: 15000 }, f.settings.read().revision);
  finish([row(1, 'A', 1)]); await pending;
  assert.equal(f.prints.length, 0); assert.equal(f.watcher.watermark, time(0));
});

test('new watched labels skip their backlog without skipping existing destinations', async (t) => {
  const f = fixture(t);
  await f.watcher.configure({ enabled: true, locations: ['a', 'b'], pollMs: 15000 }, f.settings.read().revision);
  f.rows = [row(1, 'A', 9), row(2, 'B', 9), row(3, 'B', 11)]; await f.watcher.poll();
  assert.deepEqual(f.prints.map((p) => p[0]), ['J1', 'J3']);
});

test('QR-gated completion routes still stage the Painting job and never send directly', async (t) => {
  const f = fixture(t, false);
  f.labels.find((label) => label.id === 'q').splitPartOneQty = 20;
  await f.watcher.configure({ enabled: true, locations: ['q'], pollMs: 15000 }, f.settings.read().revision);
  f.rows = [row(1, 'Q', 11, { processCode: 'LKT', parentJtcNo: 'PAINT-1' }), row(2, 'Q', 12, { processCode: 'WD', parentJtcNo: 'PAINT-2' })];
  await f.watcher.poll(); assert.equal(f.prints.length, 0);
  assert.deepEqual(f.bindings, [['PAINT-1', 'q', 'J1', 'normal', 20]]);
  assert.throws(() => f.watcher.validateLocations(f.labels.filter((l) => l.id !== 'q')), /no longer exists/);
});

test('first startup seeds from existing completions without replaying them', async (t) => {
  const f = fixture(t); f.watcher.stop(); fs.unlinkSync(f.state);
  const fresh = new AutoPrintWatcher(f.dependencies); t.after(() => fresh.stop()); fresh.start();
  await fresh.poll(); assert.equal(fresh.watermark, time(10)); assert.equal(f.prints.length, 0);
});

test('Auto Print respects a label stock-location filter', async (t) => {
  const f = fixture(t); f.labels[0].toLocation = 18;
  f.rows = [row(1, 'A', 1, { toLocationId: 19 }), row(2, 'A', 2, { toLocationId: 18 }), row(3, 'A', 3)];
  await f.watcher.poll(); assert.deepEqual(f.prints, [['J2', 'a', null]]);
});
