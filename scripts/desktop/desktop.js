'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..');
const smoke = process.argv.includes('--smoke');
const data = path.resolve(process.env.FG_PRINT_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'FGPrint'));
const children = new Set();
let lock, lockNonce, stopping = false, log;
function event(type, values = {}) { process.stdout.write(JSON.stringify({ type, ...values }) + '\n'); }
function copyOnce(source, dest) {
  try { fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}
function writeJson(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
function ownData() {
  fs.mkdirSync(data, { recursive: true });
  lock = path.join(data, 'desktop-lock.json');
  lockNonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: lockNonce }), { flag: 'wx' }); return; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = JSON.parse(fs.readFileSync(lock, 'utf8'));
      if (!Number.isInteger(old.pid) || old.pid <= 0) throw new Error('Invalid app lock. Check ' + lock);
      try { process.kill(old.pid, 0); }
      catch (probe) {
        if (probe.code !== 'ESRCH') throw probe;
        if (JSON.parse(fs.readFileSync(lock, 'utf8')).nonce !== old.nonce) throw new Error('Another app is starting. Try again.');
        fs.unlinkSync(lock); continue;
      }
      throw new Error('Label Printer is already running. Open its existing app window.');
    }
  }
  throw new Error('Cannot acquire the app lock.');
}
function unlock() {
  try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).nonce === lockNonce) fs.unlinkSync(lock); } catch {}
}
async function freePort() {
  const s = net.createServer();
  await new Promise((resolve, reject) => s.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve)); return port;
}
async function checkPort(port, name) {
  const s = net.createServer();
  try { await new Promise((resolve, reject) => s.once('error', reject).listen(port, resolve)); }
  catch { throw new Error(name + ' port ' + port + ' is already in use. Stop the old service before launching Label Printer.'); }
  await new Promise((resolve) => s.close(resolve));
}
function start(name, script, cwd, env) {
  const child = fork(path.join(__dirname, 'service-host.js'), [script], {
    cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => log.write('[' + name + '] ' + b));
  child.on('error', (e) => { event('error', { message: name + ': ' + e.message }); stop(1); });
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping) { event('error', { message: name + ' stopped unexpectedly (' + code + '). Open Logs for details.' }); stop(1); }
  });
  return child;
}
async function waitReady(url, child) {
  for (let i = 0; i < 120; i++) {
    if (stopping || child.exitCode !== null) throw new Error('A service stopped during startup. Open Logs for details.');
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Startup timed out. Open Logs for details.');
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  // Stop the UI first, so no new work is submitted while the agent shuts down.
  for (const child of [...children].reverse()) {
    if (child.exitCode !== null) continue;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 9000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send('stop', () => {}); else child.kill();
    });
  }
  unlock();
  event('stopped');
  if (log) await new Promise((r) => log.end(r));
  process.exit(code);
}

async function main() {
  if (smoke) {
    const marker = path.join(data, '.smoke-data');
    if (!process.env.FG_PRINT_DATA_DIR || (fs.existsSync(data) && fs.readdirSync(data).length && !fs.existsSync(marker))) {
      throw new Error('Smoke checks require FG_PRINT_DATA_DIR pointing to a new empty test directory.');
    }
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(marker, 'Label Printer isolated smoke data\n');
  }
  ownData();
  for (const dir of ['agent', 'ui', 'logs']) fs.mkdirSync(path.join(data, dir), { recursive: true });
  const logPath = path.join(data, 'logs', 'services.log');
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) fs.renameSync(logPath, logPath + '.' + Date.now());
  log = fs.createWriteStream(logPath, { flags: 'a' });
  log.on('error', (e) => { event('error', { message: 'Cannot write logs: ' + e.message }); stop(1); });
  const uiDir = path.join(data, 'ui'), agentDir = path.join(data, 'agent');
  copyOnce(path.join(root, 'defaults', 'ui.env'), path.join(uiDir, '.env'));
  copyOnce(path.join(root, 'defaults', 'locations.json'), path.join(uiDir, 'locations.json'));
  const cfgPath = path.join(agentDir, 'config.json');
  if (!fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'defaults', 'agent.json'), 'utf8'));
    cfg.agentId = 'fg-' + os.hostname().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) + '-' + randomUUID().slice(0, 8);
    writeJson(cfgPath, cfg);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const parseEnv = require(path.join(root, 'app', 'ui', 'node_modules', 'dotenv')).parse;
  const env = { ...process.env, ...parseEnv(fs.readFileSync(path.join(uiDir, '.env'))) };
  // Always use this installation's token and local agent, never inherited credentials.
  for (const key of ['AGENT_MANAGEMENT_TOKEN', 'PRINT_AGENT_MANAGEMENT_TOKEN', 'AGENT_MANAGEMENT_TOKEN_FILE']) delete env[key];
  const uiPort = smoke ? await freePort() : Number(env.PORT || 3000);
  let agentPort = smoke ? await freePort() : cfg.localHttpPort;
  while (smoke && agentPort === uiPort) agentPort = await freePort();
  if (!Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65535) throw new Error('Invalid UI port in the app data .env file.');
  if (uiPort === agentPort) throw new Error('The UI and print-agent must use different HTTP ports.');
  if (smoke) {
    Object.assign(env, { DB_CLIENT: 'mock', AUTO_PRINT_ENABLED: 'false', PG_DATABASE: '', PG_USER: '', QRPG_DATABASE: '', QRPG_USER: '' });
    cfg.relayUrl = ''; cfg.localHttpPort = agentPort; writeJson(cfgPath, cfg);
  }
  await checkPort(agentPort, 'Print-agent'); await checkPort(uiPort, 'Print UI');
  Object.assign(env, { PORT: String(uiPort), AGENT_URL: 'http://localhost:' + agentPort,
    FG_UI_DATA_DIR: uiDir, PRINT_AGENT_DATA_DIR: agentDir, PRINT_AGENT_CONFIG: cfgPath,
    LOCATIONS_FILE: path.join(uiDir, 'locations.json') });
  const uiSettingsPath = path.join(uiDir, 'printer-settings.json');
  if (fs.existsSync(uiSettingsPath)) {
    const settings = JSON.parse(fs.readFileSync(uiSettingsPath, 'utf8'));
    if (settings.agentUrl !== env.AGENT_URL) writeJson(uiSettingsPath, { ...settings, agentUrl: env.AGENT_URL });
  }
  const agent = start('agent', path.join(root, 'app', 'agent', 'server.js'), path.join(root, 'app', 'agent'), env);
  await waitReady(env.AGENT_URL + '/local-config', agent);
  const ui = start('ui', path.join(root, 'app', 'ui', 'server', 'index.js'), uiDir, env);
  const url = 'http://localhost:' + uiPort;
  await waitReady(url + '/api/config', ui);
  if (smoke) {
    const headers = { 'X-Print-UI-Settings': '1', 'Content-Type': 'application/json' };
    const response = await fetch(url + '/api/settings', { headers }); const state = await response.json();
    if (!response.ok || !state.agentState || !Array.isArray(state.routing.hiddenLocations)) throw new Error('Packaged agent/settings integration failed.');
    if (state.agentState.config.printers.length) throw new Error('Smoke data must have no configured printers.');
    const saved = await fetch(url + '/api/settings/visibility', { method: 'PUT', headers,
      body: JSON.stringify({ revision: state.routing.revision, hiddenGroups: [], hiddenLocations: [state.locations[0].id] }) });
    if (!saved.ok || !(await saved.json()).hiddenLocations.includes(state.locations[0].id)) throw new Error('Visibility did not persist.');
    const reload = await fetch(url + '/api/locations');
    if (!(await reload.json()).some((l) => l.id === state.locations[0].id && l.visible === false)) throw new Error('Operator visibility was not applied.');
    const report = { ok: true, terminalId: cfg.agentId, agentConnected: true, locations: state.locations.length,
      visibilitySaved: true, printers: 0, physicalPrinting: false, dataDir: data, uiPort, agentPort };
    writeJson(path.join(data, 'smoke-report.json'), report); event('smoke', report); await stop(); return;
  }
  event('ready', { url, dataDir: data });
}
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
process.on('uncaughtException', (e) => { event('error', { message: e.message }); stop(1); });
process.on('unhandledRejection', (e) => { event('error', { message: e?.message || String(e) }); stop(1); });
process.on('exit', unlock);
if (!smoke) {
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => { if (line.trim() === 'stop') stop(); });
  input.on('close', () => stop());
}
main().catch((e) => { event('error', { message: e.message }); stop(1); });
