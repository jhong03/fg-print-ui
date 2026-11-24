'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const express = require('express');

let electron;
try { ({ _electron: electron } = require('playwright')); } catch {}
const bundle = process.env.FG_PRINT_PACKAGE;
const enabled = bundle && fs.existsSync(path.join(bundle, 'resources', 'app', 'main.js')) && electron;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise((r) => s.close(r)); return port;
}
async function smoke(dir) {
  const env = { ...process.env, FG_PRINT_DATA_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(bundle, 'Label Printer.exe'), ['--smoke'], {
    env, windowsHide: true, stdio: 'ignore',
  });
  return new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
}

test('desktop window contains operator flow and printer settings without an external browser', { skip: !enabled, timeout: 90000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-electron-window-'));
  let desktop;
  const mes = express();
  mes.get('/api/label-templates/:id', (req, res) => res.json({ template: {
    label: { widthMm: 50, heightMm: 30, dpi: 203, gapMm: 2 },
    elements: [{ type: 'text', x: 20, y: 220, rotation: 270, font: '2', xMul: 1, yMul: 1, value: { kind: 'field', field: 'coNumber' } }],
  } }));
  const mesServer = mes.listen(0, '127.0.0.1'); await new Promise((r) => mesServer.once('listening', r));
  t.after(async () => {
    if (desktop) {
      try { await desktop.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }); await desktop.close(); } catch {}
    }
    for (let i = 0; i < 100 && fs.existsSync(path.join(dir, 'desktop-lock.json')); i++) await sleep(100);
    await new Promise((r) => mesServer.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(await smoke(dir), 0);
  const uiPort = await freePort();
  fs.writeFileSync(path.join(dir, 'ui', '.env'), `DB_CLIENT=mock\nPORT=${uiPort}\nAUTO_PRINT_ENABLED=false\nPG_DATABASE=\nPG_USER=\nQRPG_DATABASE=\nQRPG_USER=\nMES_BASE_URL=http://127.0.0.1:${mesServer.address().port}\n`);
  const env = { ...process.env, FG_PRINT_DATA_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: path.join(bundle, 'Label Printer.exe'), env });
  const page = await desktop.firstWindow();
  await page.waitForURL('http://localhost:' + uiPort + '/');
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.locator('#tabs button').first().waitFor();
  assert.deepEqual(await desktop.evaluate(({ app, BrowserWindow }) => ({ name: app.getName(), title: BrowserWindow.getAllWindows()[0].getTitle() })), { name: 'Label Printer', title: 'Label Printer' });
  assert.equal(await page.title(), 'JTC Lookup');
  assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })), { require: 'undefined', process: 'undefined' });
  assert.deepEqual(await desktop.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows(), prefs = all[0].webContents.getLastWebPreferences();
    return { count: all.length, node: prefs.nodeIntegration, isolated: prefs.contextIsolation, sandbox: prefs.sandbox };
  }), { count: 1, node: false, isolated: true, sandbox: true });
  assert.equal(await page.evaluate(() => window.open('https://example.com/')), null);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await page.locator('#jtcInput').fill('J2606-593E21FGM-HD'); await page.locator('#jtcInput').press('Enter');
  await page.locator('#labelMount svg').waitFor();
  assert.equal(await page.locator('#labelMount svg').count(), 1);
  await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
  await page.getByText('Settings loaded.', { exact: true }).waitFor();
  assert.equal(await page.locator('.printer-card').count(), 0);
  await page.getByRole('button', { name: 'Add printer', exact: true }).click();
  await page.locator('[data-field="name"]').fill('Desktop setup test');
  await page.locator('[data-field="share"]').fill('QA_UNUSED_PRINTER');
  await page.getByRole('button', { name: 'Save terminal and printers', exact: true }).click();
  await page.getByText('Terminal and printers saved.', { exact: true }).waitFor();
  const printerId = await page.locator('[data-field="id"]').inputValue();
  await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
  await page.locator('#assign-fg-sticker-plain').selectOption(printerId);
  await page.getByRole('button', { name: 'Save label assignments', exact: true }).click();
  await page.getByText('Label assignments saved. New jobs will use these printers.', { exact: true }).waitFor();
  await page.getByLabel('Show Work Order (P3) - K2VG Rework', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save visibility', exact: true }).click();
  await page.getByText('Visibility saved. Return to printing to see the changes.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Show Work Order (P3) - K2VG Rework', { exact: true }).isChecked(), false);
  await page.getByRole('link', { name: 'Label configuration', exact: true }).click();
  await page.getByText('Label configuration loaded.', { exact: true }).waitFor();
  await page.locator('#labelConfigSelect').selectOption({ label: 'P3 · Work Order (P3) - K2VG Rework' });
  const labelField = (key) => page.locator('[data-label-field="' + key + '"]');
  await labelField('models').fill('K2VG, K2SA');
  await labelField('templateId').fill('33');
  await labelField('reworkQrBinding').uncheck();
  assert.equal(await labelField('requireQrBinding').isEnabled(), true);
  await labelField('toLocation').selectOption('18');
  await page.getByRole('button', { name: 'Save label configuration', exact: true }).click();
  await page.getByText('Label configuration saved. Return to printing to load the updated labels.', { exact: true }).waitFor();
  await page.reload(); await page.getByText('Label configuration loaded.', { exact: true }).waitFor();
  await page.locator('#labelConfigSelect').selectOption({ label: 'P3 · Work Order (P3) - K2VG Rework' });
  assert.equal(await labelField('reworkQrBinding').isChecked(), false);
  assert.equal(await labelField('toLocation').inputValue(), '18');
  assert.equal(await labelField('models').inputValue(), 'K2VG, K2SA');
  await labelField('reworkQrBinding').check();
  assert.equal(await labelField('requireQrBinding').isDisabled(), true);
  await page.getByRole('button', { name: 'Save label configuration', exact: true }).click();
  await page.getByText('Label configuration saved. Return to printing to load the updated labels.', { exact: true }).waitFor();
  const labelFile = path.join(dir, 'ui', 'locations.json');
  const savedLabel = JSON.parse(fs.readFileSync(labelFile)).find((l) => l.id === 'work-order-p3-k2vg-rework');
  assert.deepEqual(savedLabel.models, ['K2VG', 'K2SA']); assert.equal(savedLabel.mode, 'rework');
  assert.equal(savedLabel.reworkQrBinding, true); assert.equal(savedLabel.templateId, '33');
  assert.equal(fs.existsSync(labelFile + '.bak'), true);
  await page.reload(); await page.getByText('Settings loaded.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
  assert.equal(await page.getByLabel('Show Work Order (P3) - K2VG Rework', { exact: true }).isChecked(), false);
  if (process.env.FG_UI_QA_DIR) {
    fs.mkdirSync(process.env.FG_UI_QA_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.FG_UI_QA_DIR, 'desktop-app-settings.png'), fullPage: true });
  }
  await page.getByRole('link', { name: 'Auto Print', exact: true }).click();
  await page.getByText('Auto Print settings loaded.', { exact: true }).waitFor();
  await page.locator('#autoPrintEnabled').check(); await page.locator('#autoPrintSeconds').fill('30');
  await page.locator('#autoPrintLabels input[data-location="work-order-p3-k2vg"]').check();
  await page.getByRole('button', { name: 'Save Auto Print', exact: true }).click();
  await page.getByText('Auto Print saved. Changes are active now.', { exact: true }).waitFor();
  assert.equal(await page.locator('#autoPrintState').textContent(), 'Watching for completions');
  await page.locator('#autoPrintEnabled').uncheck();
  await page.getByRole('button', { name: 'Save Auto Print', exact: true }).click();
  await page.getByText('Auto Print saved. Changes are active now.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await desktop.evaluate(({ dialog, BrowserWindow }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    BrowserWindow.getAllWindows()[0].close();
  });
  await sleep(100);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.equal((await fetch('http://localhost:' + uiPort + '/api/config')).ok, true);
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await desktop.close(); desktop = null;
  for (let i = 0; i < 100 && fs.existsSync(path.join(dir, 'desktop-lock.json')); i++) await sleep(100);
  assert.equal(fs.existsSync(path.join(dir, 'desktop-lock.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'agent', '.agent-lock')), false);
  await assert.rejects(fetch('http://localhost:' + uiPort + '/api/config'));
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'agent', 'config.json')));
  assert.equal(cfg.printers.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'agent', 'print-queue.json')), false);
  desktop = await electron.launch({ executablePath: path.join(bundle, 'Label Printer.exe'), env });
  const reopened = await desktop.firstWindow(); await reopened.waitForURL('http://localhost:' + uiPort + '/');
  await reopened.getByRole('link', { name: 'Printer settings', exact: true }).click();
  await reopened.getByRole('link', { name: 'Label configuration', exact: true }).click();
  await reopened.getByText('Label configuration loaded.', { exact: true }).waitFor();
  await reopened.locator('#labelConfigSelect').selectOption({ label: 'P3 · Work Order (P3) - K2VG Rework' });
  assert.equal(await reopened.locator('[data-label-field="reworkQrBinding"]').isChecked(), true);
  assert.equal(await reopened.locator('[data-label-field="requireQrBinding"]').isDisabled(), true);
  assert.equal(await reopened.locator('[data-label-field="toLocation"]').inputValue(), '18');
  assert.equal(await reopened.locator('[data-label-field="models"]').inputValue(), 'K2VG, K2SA');
  await reopened.getByRole('link', { name: 'Auto Print', exact: true }).click();
  await reopened.getByText('Auto Print settings loaded.', { exact: true }).waitFor();
  assert.equal(await reopened.locator('#autoPrintEnabled').isChecked(), false);
  assert.equal(await reopened.locator('#autoPrintSeconds').inputValue(), '30');
  assert.equal(await reopened.locator('#autoPrintLabels input[data-location="work-order-p3-k2vg"]').isChecked(), true);
  await desktop.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await desktop.close(); desktop = null;
});
