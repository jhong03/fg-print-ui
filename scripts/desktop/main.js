'use strict';
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..', '..');
const dataDir = path.resolve(process.env.FG_PRINT_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'FGPrint'));
const smoke = process.argv.includes('--smoke');
let window, supervisor, baseUrl, stopping = false, confirming = false, failure;
app.setName('Label Printer');
app.setAppUserModelId('Yollink.LabelPrinter');

function allowed(url) {
  try { return !!baseUrl && new URL(url).origin === baseUrl; } catch { return false; }
}
function renderFailure(message) {
  failure = message;
  if (smoke) { process.stderr.write(message + '\n'); return; }
  if (!window || window.isDestroyed()) return;
  window.loadFile(path.join(__dirname, 'starting.html')).then(() => window.webContents.executeJavaScript(
    'document.getElementById("status").textContent=' + JSON.stringify(message)
    + ';document.getElementById("help").textContent="Close and reopen Label Printer after resolving the issue. Service logs are in " + ' + JSON.stringify(path.join(dataDir, 'logs')))
  ).catch(() => {});
}
function navigate(suffix) {
  if (baseUrl && window && !window.isDestroyed()) window.loadURL(baseUrl + suffix).catch((e) => {
    // Choosing to keep editing cancels navigation; the current screen remains valid.
    if (e.code !== 'ERR_ABORTED' && e.errno !== -3) renderFailure(e.message);
  });
}
function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Printing screen', enabled: !!baseUrl, click: () => navigate('/') },
      { label: 'Printer settings', enabled: !!baseUrl, click: () => navigate('/settings.html') },
      { label: 'Label configuration', enabled: !!baseUrl, click: () => navigate('/settings.html#labelConfigHeading') },
      { label: 'Auto Print', enabled: !!baseUrl, click: () => navigate('/settings.html#auto') },
      { label: 'Open logs folder', click: () => { const dir = path.join(dataDir, 'logs'); fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); } },
      { type: 'separator' }, { label: 'Exit', accelerator: 'Alt+F4', click: () => requestQuit() },
    ] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
}
async function requestQuit() {
  if (stopping || confirming) return;
  confirming = true;
  try {
    if (supervisor && supervisor.exitCode === null && window && !window.isDestroyed()) {
      const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Close Label Printer',
        message: 'Stop printing services and close Label Printer?',
        detail: 'Pending jobs remain saved for review when you reopen the app.',
        buttons: ['Cancel', 'Exit'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1) return;
    }
    stopping = true;
    if (supervisor && supervisor.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { supervisor.kill(); resolve(); }, 22000);
        supervisor.once('exit', () => { clearTimeout(timer); resolve(); });
        if (supervisor.stdin.writable) supervisor.stdin.end('stop\n'); else supervisor.kill();
      });
    }
    app.exit(0);
  } finally { confirming = false; }
}
function startServices() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  supervisor = spawn(path.join(root, 'runtime', 'node.exe'), [path.join(root, 'launcher', 'desktop.js'), ...(smoke ? ['--smoke'] : [])], {
    cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  supervisor.stdin.on('error', () => {});
  const output = readline.createInterface({ input: supervisor.stdout });
  output.on('line', (line) => {
    if (smoke) process.stdout.write(line + '\n');
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.type === 'ready' && !smoke) {
      const address = new URL(event.url);
      if (address.protocol !== 'http:' || address.hostname !== 'localhost') { renderFailure('Unexpected local service address.'); return; }
      baseUrl = address.origin; menu(); navigate('/');
    } else if (event.type === 'error') renderFailure(event.message);
  });
  supervisor.stderr.on('data', (bytes) => { if (smoke) process.stderr.write(bytes); else renderFailure(bytes.toString()); });
  supervisor.on('error', (e) => { renderFailure('Cannot start printing services: ' + e.message); if (smoke) app.exit(1); });
  supervisor.on('exit', (code) => {
    if (smoke) { app.exit(code === 0 ? 0 : 1); return; }
    if (!stopping && !failure) renderFailure('Printing services stopped unexpectedly. Open the logs folder for details.');
  });
}

if (smoke) {
  // No renderer or external browser is created by the isolated backend check.
  startServices();
} else {
  fs.mkdirSync(path.join(dataDir, 'desktop'), { recursive: true });
  app.setPath('userData', path.join(dataDir, 'desktop'));
  if (!app.requestSingleInstanceLock()) app.exit(0);
  else {
    app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
    app.on('before-quit', (e) => { if (!stopping) { e.preventDefault(); requestQuit(); } });
    app.whenReady().then(async () => {
      const profile = session.fromPartition('persist:operator');
      profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      profile.setPermissionCheckHandler(() => false);
      profile.on('will-download', (e) => e.preventDefault());
      profile.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = { ...details.responseHeaders };
        if (allowed(details.url)) responseHeaders['Content-Security-Policy'] = [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        ];
        callback({ responseHeaders });
      });
      window = new BrowserWindow({ title: 'Label Printer', icon: path.join(__dirname, 'assets', 'label-printer.ico'), width: 1280, height: 900, minWidth: 760, minHeight: 600,
        backgroundColor: '#f5f7f9', show: false,
        webPreferences: { partition: 'persist:operator', nodeIntegration: false, contextIsolation: true,
          sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false, safeDialogs: true },
      });
      window.on('page-title-updated', (e) => { e.preventDefault(); window.setTitle('Label Printer'); });
      window.on('close', (e) => { if (!stopping) { e.preventDefault(); requestQuit(); } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-prevent-unload', (event) => {
        const choice = dialog.showMessageBoxSync(window, { type: 'question', title: 'Unsaved settings',
          message: 'Leave this page without saving your changes?',
          detail: 'Choose Stay to keep editing and save first, or discard the unsaved changes to leave.',
          buttons: ['Stay', 'Discard changes and leave'], defaultId: 0, cancelId: 0, noLink: true });
        // Electron cancels beforeunload by default. Override it only after explicit discard.
        if (choice === 1) event.preventDefault();
      });
      window.webContents.on('will-navigate', (e, url) => { if (!allowed(url)) e.preventDefault(); });
      window.webContents.on('will-redirect', (e, url) => { if (!allowed(url)) e.preventDefault(); });
      window.webContents.on('will-attach-webview', (e) => e.preventDefault());
      window.webContents.on('render-process-gone', () => renderFailure('The operator screen stopped. Close and reopen Label Printer.'));
      menu();
      await window.loadFile(path.join(__dirname, 'starting.html'));
      window.show(); startServices();
    }).catch((e) => { dialog.showErrorBox('Label Printer', e.message); app.exit(1); });
  }
}
