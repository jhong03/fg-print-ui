'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');

const bundle = process.env.FG_PRINT_PACKAGE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function run(file, args, env, stdin = 'ignore') {
  const childEnv = { ...process.env, ...env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(file, args, { env: childEnv, windowsHide: true, stdio: [stdin, 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (b) => { output += b; }); child.stderr.on('data', (b) => { output += b; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => resolve(code)); });
  return { child, done, output: () => output };
}
async function port() {
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise((r) => s.close(r)); return p;
}

test('portable EXE starts bundled services, preserves identity and settings, and stops its children', { skip: !bundle, timeout: 60000 }, async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-desktop-test-'));
  const node = path.join(bundle, 'runtime', 'node.exe');
  const supervisor = path.join(bundle, 'launcher', 'desktop.js');
  let active;
  t.after(async () => {
    if (active && active.child.exitCode === null) { active.child.stdin.end('stop\n'); await active.done; }
    fs.rmSync(data, { recursive: true, force: true });
  });
  const env = { FG_PRINT_DATA_DIR: data };
  const first = run(path.join(bundle, 'Label Printer.exe'), ['--smoke'], env);
  assert.equal(await first.done, 0, first.output());
  const reportFile = path.join(data, 'smoke-report.json');
  const firstReport = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(firstReport.ok, true);
  assert.equal(firstReport.physicalPrinting, false);
  assert.equal(firstReport.printers, 0);
  assert.equal(fs.existsSync(path.join(data, 'desktop-lock.json')), false);
  assert.equal(fs.existsSync(path.join(data, 'agent', '.agent-lock')), false);
  const token = fs.readFileSync(path.join(data, 'agent', 'management-token'), 'utf8');
  const settings = fs.readFileSync(path.join(data, 'ui', 'printer-settings.json'), 'utf8');
  const second = run(path.join(bundle, 'Label Printer.exe'), ['--smoke'], env);
  assert.equal(await second.done, 0, second.output());
  assert.equal(JSON.parse(fs.readFileSync(reportFile)).terminalId, firstReport.terminalId);
  assert.equal(fs.readFileSync(path.join(data, 'agent', 'management-token'), 'utf8'), token);
  // New random smoke ports may update agentUrl, but individual choices survive.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'ui', 'printer-settings.json'))).hiddenLocations, JSON.parse(settings).hiddenLocations);

  const uiPort = await port();
  fs.writeFileSync(path.join(data, 'ui', '.env'), `DB_CLIENT=mock\nPORT=${uiPort}\nAUTO_PRINT_ENABLED=false\nPG_DATABASE=\nPG_USER=\nQRPG_DATABASE=\nQRPG_USER=\n`);
  active = run(node, [supervisor], env, 'pipe');
  for (let i = 0; i < 120 && !active.output().includes('"type":"ready"'); i++) {
    assert.equal(active.child.exitCode, null, active.output()); await sleep(100);
  }
  assert.match(active.output(), /"type":"ready"/);
  const duplicate = run(node, [supervisor], env, 'pipe');
  assert.equal(await duplicate.done, 1);
  assert.match(duplicate.output(), /already running/);
  assert.equal((await fetch('http://localhost:' + uiPort + '/api/config')).ok, true);
  active.child.stdin.end('stop\n'); assert.equal(await active.done, 0);
  assert.equal(fs.existsSync(path.join(data, 'desktop-lock.json')), false);
  assert.equal(fs.existsSync(path.join(data, 'agent', '.agent-lock')), false);
  await assert.rejects(fetch('http://localhost:' + uiPort + '/api/config'));

  // A conflicting port must remain owned by the original process.
  const occupied = net.createServer(); await new Promise((r) => occupied.listen(uiPort, r));
  try {
    const conflict = run(node, [supervisor], env, 'pipe');
    assert.equal(await conflict.done, 1);
    assert.match(conflict.output(), /port .*already in use/);
    assert.equal(occupied.listening, true);
  } finally { await new Promise((r) => occupied.close(r)); }
});

test('smoke mode refuses an existing production data folder', { skip: !bundle, timeout: 10000 }, async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-desktop-protect-'));
  const file = path.join(data, 'keep.txt'); fs.writeFileSync(file, 'existing state');
  try {
    const probe = run(path.join(bundle, 'runtime', 'node.exe'), [path.join(bundle, 'launcher', 'desktop.js'), '--smoke'], { FG_PRINT_DATA_DIR: data });
    assert.equal(await probe.done, 1);
    assert.match(probe.output(), /new empty test directory/);
    assert.deepEqual(fs.readdirSync(data), ['keep.txt']);
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing state');
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});
