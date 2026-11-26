'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-label-config-'));
process.env.FG_UI_DATA_DIR = root;
process.env.LOCATIONS_FILE = path.join(root, 'live-locations.json');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { LocationConfig, validateLocations } = require('../server/locationConfig');
const locations = require('../server/locations');
const { registerSettings } = require('../server/settingsRoutes');

test('label configuration saves atomically with backup, conflict detection and lossless extra fields', () => {
  const file = path.join(root, 'roundtrip.json');
  const store = new LocationConfig(file);
  const base = [{ id: 'normal', name: 'Normal label', group: 'P3', models: ['k2vg'], customMetadata: { retained: true } }];
  const first = store.save(base, store.read().revision);
  assert.deepEqual(first.locations[0].models, ['K2VG']);
  const next = [{ ...first.locations[0], mode: 'normal', modeGroup: 'pair', requireQrBinding: true },
    { id: 'rework', name: 'Rework label', group: 'P3', mode: 'rework', modeGroup: 'pair', reworkQrBinding: true }];
  const saved = store.save(next, first.revision);
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak')), first.locations);
  assert.deepEqual(new LocationConfig(file).read(), saved);
  assert.equal(saved.locations[0].customMetadata.retained, true);
  assert.throws(() => store.save(base, first.revision), (e) => e.status === 409);
  assert.throws(() => store.save(base), (e) => e.status === 428);
  assert.deepEqual(store.read(), saved);
});

test('stock-location API validates new filters and preserves existing filters during database outages', async (t) => {
  const store = new LocationConfig(path.join(root, 'stock-locations.json'));
  const original = [{ id: 'one', name: 'First', toLocation: 99 }];
  store.save(original, store.read().revision);
  let rows = [{ id: 18, name: 'P3 Outgoing', code: 'P3-OUTGOING' }], offline = false;
  const app = express(); app.use(express.json());
  registerSettings(app, { settings: {}, agent: {}, locations: { ...locations, configuration: store },
    queue: { pendingJobs: () => [], withSettingsLock: (fn) => fn() },
    db: { getStockLocations: async () => { if (offline) throw new Error('private database details'); return rows; } } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/settings';
  const headers = { 'X-Print-UI-Settings': '1', 'Content-Type': 'application/json' };
  const save = (value) => fetch(base + '/locations', { method: 'PUT', headers,
    body: JSON.stringify({ locations: value, revision: store.read().revision }) });
  assert.equal((await fetch(base + '/stock-locations')).status, 403);
  assert.deepEqual(await (await fetch(base + '/stock-locations', { headers })).json(), { locations: rows });
  assert.equal((await save([{ ...original[0], toLocation: 42 }])).status, 400);
  assert.equal((await save([{ ...original[0], requireQrBinding: true, reworkQrBinding: true }])).status, 400);
  assert.deepEqual(store.read().locations, original);
  offline = true;
  const failure = await fetch(base + '/stock-locations', { headers });
  assert.equal(failure.status, 503); assert.doesNotMatch(JSON.stringify(await failure.json()), /private database/);
  assert.equal((await save([{ ...original[0], name: 'Renamed' }])).status, 200);
  assert.equal(store.read().locations[0].toLocation, 99);
  assert.equal((await save([{ ...original[0], toLocation: 18 }])).status, 503);
  assert.equal((await save([{ id: 'one', name: 'First' }])).status, 200); // Clear a filter even while offline.
  offline = false;
  assert.equal((await save([{ ...original[0], toLocation: 18 }])).status, 200);
  rows = []; // Location became inactive after the dropdown was loaded.
  assert.equal((await save([{ ...original[0], toLocation: 18, name: 'Updated' }])).status, 200);
  assert.equal((await save([{ ...original[0], toLocation: 18 }, { id: 'two', name: 'Second', toLocation: 18 }])).status, 400);
});

test('invalid label flows, pairs, model lists and IDs are rejected without replacing saved labels', () => {
  const store = new LocationConfig(path.join(root, 'validated.json'));
  const loc = { id: 'one', name: 'First label' };
  store.save([loc], store.read().revision);
  for (const value of [[], [loc, loc], [{ ...loc, id: '../escape' }], [{ ...loc, models: 'K2VG' }],
    [{ ...loc, requireQrBinding: true, reworkQrBinding: true }], [{ ...loc, mode: 'normal', reworkQrBinding: true }],
    [{ ...loc, mode: 'rework', weldingToPainting: true }], [{ ...loc, doneOnly: 'false' }],
    [{ ...loc, barcodeNudge: 1.5 }], [{ ...loc, toLocation: -1 }], [{ ...loc, agentUrl: 123 }],
    [{ ...loc, modeGroup: 'pair', mode: 'normal' }, { id: 'two', name: 'Second', modeGroup: 'pair', mode: 'normal' }],
    [{ ...loc, modeGroup: 'pair', mode: 'normal', group: 'P1' }, { id: 'two', name: 'Second', modeGroup: 'pair', mode: 'rework', group: 'P3' }]]) {
    assert.throws(() => store.save(value, store.read().revision), (e) => e.status === 400);
    assert.deepEqual(store.read().locations, [loc]);
  }
  assert.deepEqual(validateLocations([{ ...loc, models: [' k2vg ', 'K2VG', 'k2sa'] }])[0].models, ['K2VG', 'K2SA']);
});

test('live label edits update resolved flow and stale IDs never fall back to another printer', () => {
  const defaults = { ...locations.envDefaults(), templateId: '11' };
  assert.equal(locations.resolveEntry({ id: 'work-order-p3-rework', name: 'Rework' }, defaults).templateId, '1');
  assert.equal(locations.resolveEntry({ id: 'qa', name: 'Work Order (QA)' }, defaults).templateId, '1');
  assert.equal(locations.resolveEntry({ id: 'qa', name: 'Work Order (QA)', templateId: '14' }, defaults).templateId, '14');
  assert.equal(locations.resolveEntry({ id: 'fg', name: 'FG sticker' }, defaults).templateId, '11');
  const store = locations.configuration;
  store.save([{ id: 'one', name: 'First' }, { id: 'two', name: 'Second' }], store.read().revision); locations.invalidate();
  const old = locations.get('one');
  store.save([{ id: 'one', name: 'First', models: ['K2SA'], mode: 'rework', reworkQrBinding: true }, { id: 'two', name: 'Second' }], store.read().revision); locations.invalidate();
  assert.equal(locations.get('one').bindingMode, 'rework');
  assert.deepEqual(locations.get('one').models, ['K2SA']);
  assert.throws(() => locations.assertUnchanged(old), (e) => e.status === 409);
  store.save([{ id: 'two', name: 'Second' }], store.read().revision); locations.invalidate();
  assert.equal(locations.get().id, 'two');
  assert.throws(() => locations.get('one'), (e) => e.status === 404);
});

test('local label API works without the agent and protects pending prints and QR bindings', async (t) => {
  const store = new LocationConfig(path.join(root, 'api.json'));
  const original = [{ id: 'one', name: 'First' }, { id: 'two', name: 'Second' }];
  store.save(original, store.read().revision);
  let queued = [{ location: 'one' }], bindings = [], agentCalls = 0;
  const app = express(); app.use(express.json());
  registerSettings(app, { settings: {}, agent: { management: () => { agentCalls++; } },
    locations: { ...locations, configuration: store },
    queue: { pendingJobs: () => queued, withSettingsLock: (operation) => operation() }, bindingQueue: { list: () => bindings } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/settings/locations';
  const headers = { 'X-Print-UI-Settings': '1', 'Content-Type': 'application/json' };
  const save = (value, revision = store.read().revision) => fetch(base, { method: 'PUT', headers, body: JSON.stringify({ locations: value, revision }) });
  assert.equal((await fetch(base)).status, 403);
  assert.equal((await fetch(base, { headers })).status, 200);
  assert.equal((await save([original[1]])).status, 409);
  const edited = [{ ...original[0], models: ['K2VG'] }, original[1]];
  assert.equal((await save(edited)).status, 200); // Existing print jobs already retain frozen options.
  queued = []; bindings = [{ location: 'one', printed: false }];
  assert.equal((await save([{ ...edited[0], reworkQrBinding: true }, original[1]])).status, 409);
  assert.equal((await save([original[1]])).status, 409);
  assert.equal((await save(edited)).status, 200); // Semantically unchanged edits are safe.
  bindings = [{ location: 'one', printed: true }];
  assert.equal((await save([original[1]])).status, 409); // Prevent stale binding reprints after removal.
  bindings = [];
  const token = store.read().revision;
  assert.equal((await save([original[1]])).status, 200);
  assert.equal((await save(original, token)).status, 409);
  assert.equal(agentCalls, 0);
});
