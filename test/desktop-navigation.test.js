'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
let electron; try { ({ _electron: electron } = require('playwright')); } catch {}
const bundle = process.env.FG_PRINT_PACKAGE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Back to printing works across sections and handles unsaved settings explicitly', { skip: !bundle || !electron, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-navigation-'));
  const env = { ...process.env, FG_PRINT_DATA_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  t.after(async () => {
    if (desktop) {
      try {
        await desktop.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); dialog.showMessageBoxSync = () => 1; });
        await desktop.close();
      } catch {}
    }
    for (let i = 0; i < 100 && fs.existsSync(path.join(dir, 'desktop-lock.json')); i++) await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const smoke = spawn(path.join(bundle, 'Label Printer.exe'), ['--smoke'], { env, windowsHide: true, stdio: 'ignore' });
  assert.equal(await new Promise((resolve, reject) => { smoke.on('error', reject); smoke.on('exit', resolve); }), 0);
  const socket = net.createServer(); await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise((r) => socket.close(r));
  fs.writeFileSync(path.join(dir, 'ui', '.env'), `DB_CLIENT=mock\nPORT=${port}\nAUTO_PRINT_ENABLED=false\nPG_DATABASE=\nPG_USER=\nQRPG_DATABASE=\nQRPG_USER=\n`);
  desktop = await electron.launch({ executablePath: path.join(bundle, 'Label Printer.exe'), env });
  const page = await desktop.firstWindow(), base = 'http://localhost:' + port;
  // Electron owns beforeunload confirmation; CDP reports it without a browser dialog to dismiss.
  page.on('dialog', (item) => { void item.dismiss().catch(() => {}); });
  await page.waitForURL(base + '/');
  async function open(section) {
    await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
    await page.getByText('Settings loaded.', { exact: true }).waitFor();
    await page.getByRole('link', { name: section, exact: true }).click();
  }
  for (const section of ['Printers', 'Label assignments', 'Label configuration', 'Auto Print', 'Terminal and agent']) {
    await open(section);
    await page.getByRole('link', { name: 'Back to printing', exact: false }).click();
    await page.waitForURL(base + '/', { timeout: 5000 });
  }
  await desktop.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.navigationPrompts = []; globalThis.unloadAttempts = 0;
    BrowserWindow.getAllWindows()[0].webContents.on('will-prevent-unload', () => { globalThis.unloadAttempts++; });
    dialog.showMessageBoxSync = (_window, options) => { globalThis.navigationPrompts.push(options); return 0; };
  });
  await open('Label configuration'); await page.getByText('Label configuration loaded.', { exact: true }).waitFor();
  const originalName = await page.locator('[data-label-field="name"]').inputValue();
  await page.locator('[data-label-field="name"]').fill('Unsaved draft');
  await page.getByRole('link', { name: 'Back to printing', exact: false }).click({ noWaitAfter: true });
  const prompts = await desktop.evaluate(() => ({ prompts: globalThis.navigationPrompts.length, attempts: globalThis.unloadAttempts }));
  assert.equal(prompts.attempts, 1, 'Expected unsaved-changes protection to run');
  assert.equal(prompts.prompts, 1, 'Desktop app silently blocked Back without showing a confirmation');
  assert.match(page.url(), /settings\.html/);
  assert.equal(await page.locator('[data-label-field="name"]').inputValue(), 'Unsaved draft');
  // Choosing Stay from the native File menu must preserve the screen, not show a startup-error page.
  await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.label === 'Printing screen').click());
  await page.getByRole('heading', { name: 'Label configuration', exact: true, level: 2 }).waitFor();
  assert.equal(await page.locator('[data-label-field="name"]').inputValue(), 'Unsaved draft');
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
  await page.getByRole('link', { name: 'Back to printing', exact: false }).click(); await page.waitForURL(base + '/');
  const definitions = JSON.parse(fs.readFileSync(path.join(dir, 'ui', 'locations.json')));
  assert.equal(definitions[0].name, originalName);
  await open('Auto Print'); await page.getByText('Auto Print settings loaded.', { exact: true }).waitFor();
  await page.locator('#autoPrintSeconds').fill('30');
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
  await page.getByRole('link', { name: 'Back to printing', exact: false }).click({ noWaitAfter: true });
  assert.match(page.url(), /settings\.html/);
  assert.equal(await page.locator('#autoPrintSeconds').inputValue(), '30');
  await page.getByRole('button', { name: 'Save Auto Print', exact: true }).click();
  await page.getByText('Auto Print saved. Changes are active now.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Back to printing', exact: false }).click(); await page.waitForURL(base + '/');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ui', 'auto-print-settings.json'))).pollMs, 30000);
});
