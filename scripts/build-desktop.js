'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ui = path.resolve(__dirname, '..');
const agent = path.resolve(process.env.PRINT_AGENT_SOURCE || path.join(ui, '..', 'print-agent'));
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(outIndex === -1 ? path.join(ui, '.build', 'Label Printer') : process.argv[outIndex + 1]);
if (fs.existsSync(out)) throw new Error('Output folder already exists; choose a new empty folder: ' + out);
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64 with the installed Node runtime.');
const license = process.env.FG_NODE_LICENSE_FILE || path.join(path.dirname(process.execPath), 'LICENSE');
if (!fs.existsSync(license)) throw new Error('Set FG_NODE_LICENSE_FILE to the license for Node ' + process.version + ' before building.');
const electronDist = path.resolve(process.env.FG_ELECTRON_DIST || path.join(__dirname, 'desktop', 'node_modules', 'electron', 'dist'));
if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) throw new Error('Install the desktop dependencies and run node scripts/desktop/node_modules/electron/install.js first.');
execFileSync(process.execPath, [path.join(__dirname, 'desktop', 'build-icon.js')], { stdio: 'inherit', windowsHide: true });
function copy(source, dest) { fs.cpSync(source, dest, { recursive: true, dereference: true }); }
function json(dest, value) { fs.writeFileSync(dest, JSON.stringify(value, null, 2) + '\n'); }
for (const file of [path.join(ui, '.env'), path.join(ui, 'locations.json'), path.join(agent, 'config.json'), path.join(agent, 'node_modules')]) {
  if (!fs.existsSync(file)) throw new Error('Missing build input: ' + file);
}
fs.mkdirSync(out, { recursive: true });
copy(electronDist, out);
fs.renameSync(path.join(out, 'electron.exe'), path.join(out, 'Label Printer.exe'));
for (const dir of ['runtime', 'launcher', 'defaults', 'app/ui', 'app/agent', 'resources/app']) fs.mkdirSync(path.join(out, dir), { recursive: true });
console.log('Copying application code and installed dependencies...');
for (const name of ['server', 'public', 'node_modules', 'package.json', 'package-lock.json']) copy(path.join(ui, name), path.join(out, 'app', 'ui', name));
for (const name of ['server.js', 'lib', 'node_modules', 'package.json', 'package-lock.json']) copy(path.join(agent, name), path.join(out, 'app', 'agent', name));
copy(process.execPath, path.join(out, 'runtime', 'node.exe'));
for (const name of ['desktop.js', 'service-host.js']) copy(path.join(__dirname, 'desktop', name), path.join(out, 'launcher', name));
const agentConfig = JSON.parse(fs.readFileSync(path.join(agent, 'config.json'), 'utf8'));
json(path.join(out, 'defaults', 'agent.json'), {
  schemaVersion: 2, agentId: 'generated-on-first-launch', relayUrl: agentConfig.relayUrl || '',
  localHttpPort: 9000, printers: [], defaultPrinterId: null,
});
const dotenv = require('dotenv');
const rawEnvironment = fs.readFileSync(path.join(ui, '.env'), 'utf8');
const environment = dotenv.parse(rawEnvironment);
// Preserve plant connection defaults without shipping this machine's credentials for agent management.
const excluded = ['AGENT_MANAGEMENT_TOKEN', 'PRINT_AGENT_MANAGEMENT_TOKEN', 'AGENT_MANAGEMENT_TOKEN_FILE',
  'FG_UI_DATA_DIR', 'PRINT_AGENT_DATA_DIR', 'PRINT_AGENT_CONFIG', 'LOCATIONS_FILE'];
for (const key of excluded) delete environment[key];
Object.assign(environment, { PORT: '3000', AGENT_URL: 'http://localhost:9000' });
const lines = rawEnvironment.split(/\r?\n/).filter((line) => {
  const key = /^\s*(?:export\s+)?([\w]+)\s*=/.exec(line)?.[1];
  return !excluded.includes(key) && !['PORT', 'AGENT_URL'].includes(key);
});
const seedEnvironment = lines.join('\n') + '\nPORT=3000\nAGENT_URL=http://localhost:9000\n';
const parsedSeed = dotenv.parse(seedEnvironment);
if (JSON.stringify(Object.entries(parsedSeed).sort()) !== JSON.stringify(Object.entries(environment).sort())) throw new Error('Cannot preserve .env values exactly; check multiline deployment overrides.');
fs.writeFileSync(path.join(out, 'defaults', 'ui.env'), seedEnvironment, { mode: 0o600 });
copy(path.join(ui, 'locations.json'), path.join(out, 'defaults', 'locations.json'));
for (const name of ['main.js', 'starting.html']) copy(path.join(__dirname, 'desktop', name), path.join(out, 'resources', 'app', name));
copy(path.join(__dirname, 'desktop', 'assets'), path.join(out, 'resources', 'app', 'assets'));
json(path.join(out, 'resources', 'app', 'package.json'), { name: 'label-printer-desktop', productName: 'Label Printer', version: '1.0.0', main: 'main.js' });
execFileSync(path.join(__dirname, 'desktop', 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'), [
  path.join(out, 'Label Printer.exe'), '--set-icon', path.join(__dirname, 'desktop', 'assets', 'label-printer.ico'),
  '--set-version-string', 'ProductName', 'Label Printer', '--set-version-string', 'FileDescription', 'Label Printer',
  '--set-version-string', 'InternalName', 'LabelPrinter', '--set-version-string', 'OriginalFilename', 'Label Printer.exe',
  '--set-version-string', 'CompanyName', environment.COMPANY_NAME || 'Yollink Industries',
  '--set-file-version', '1.0.0', '--set-product-version', '1.0.0',
], { stdio: 'inherit', windowsHide: true });
json(path.join(out, 'build-info.json'), { name: 'Label Printer', builtAt: new Date().toISOString(), node: process.version,
  platform: 'win32-x64', shell: 'electron', electron: require('./desktop/package.json').devDependencies.electron,
  uiVersion: require('../package.json').version, agentVersion: agentConfig.schemaVersion || 1 });
copy(path.join(__dirname, 'desktop', 'QUICK-START.txt'), path.join(out, 'START HERE.txt'));
// Preserve the runtime's full bundled third-party license notice.
copy(license, path.join(out, 'runtime', 'LICENSE.txt'));
console.log('Built ' + path.join(out, 'Label Printer.exe'));
