'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const express = require('express');

const agentSource = process.env.PRINT_AGENT_SOURCE || path.resolve(__dirname, '..', '..', 'print-agent');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, message = 'Expected state did not appear') {
  for (let i = 0; i < 200; i++) { if (await check()) return; await pause(25); }
  throw new Error(message);
}
async function freePort() {
  const server = net.createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise((r) => server.close(r)); return port;
}
function startService(script, env) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, logs: '', exited: false };
  child.stdout.on('data', (b) => { state.logs += b; }); child.stderr.on('data', (b) => { state.logs += b; });
  child.on('exit', () => { state.exited = true; });
  return state;
}
async function stopService(state) {
  if (!state || state.exited) return;
  const exited = new Promise((r) => state.child.once('exit', r)); state.child.kill(); await exited;
}

test('fg-print-ui integrates with the real multi-printer agent using isolated data and TCP stand-ins',
  { skip: !fs.existsSync(path.join(agentSource, 'lib', 'print-service.js')) }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-ui-integration-'));
    const sockets = new Set(), receivers = [], labels = [[], [], []];
    let agentProcess, uiProcess, browser, mesServer;
    t.after(async () => {
      if (browser) await browser.close();
      await stopService(uiProcess); await stopService(agentProcess);
      for (const socket of sockets) socket.destroy();
      await Promise.all(receivers.map((s) => new Promise((r) => s.close(r))));
      if (mesServer) await new Promise((r) => mesServer.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    for (let i = 0; i < 3; i++) {
      const receiver = net.createServer((socket) => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        const chunks = []; socket.on('data', (b) => chunks.push(b));
        socket.on('end', () => { if (chunks.length) labels[i].push(Buffer.concat(chunks)); });
      });
      await new Promise((r) => receiver.listen(0, '127.0.0.1', r)); receivers.push(receiver);
    }
    const mes = express();
    let customQuantityReady = false;
    mes.get('/api/label-templates/:id', (req, res) => res.json({ template: {
      label: { widthMm: 80, heightMm: 130, dpi: 203, gapMm: 2 },
      elements: [
        { type: 'box', x: 15, y: 40, width: 585, height: 930, thickness: 3 },
        { type: 'text', x: 45, y: 625, rotation: 270, font: '3', xMul: 1, yMul: 1, value: { kind: 'static', text: 'WORK ORDER LABEL' } },
        { type: 'bar', x: 90, y: 40, width: 3, height: 930 },
        ...(req.params.id === '1' ? [
          { type: 'text', x: 145, y: 920, rotation: 270, font: '3', xMul: 1, yMul: 1, value: { kind: 'field', field: 'coNumber' } },
          { type: 'text', x: 345, y: 515, rotation: 270, font: '2', xMul: 1, yMul: 1, value: { kind: 'field', field: 'jtcNo' } },
          { type: 'text', x: 445, y: 920, rotation: 270, font: '3', xMul: 1, yMul: 1, value: { kind: 'field', field: 'remarksLine1' } },
          { type: 'text', x: 475, y: 920, rotation: 270, font: '3', xMul: 1, yMul: 1, value: { kind: 'field', field: 'remarksLine2' } },
        ] : [
          { type: 'text', x: 125, y: 955, rotation: 270, font: '2', xMul: 1, yMul: 1, value: { kind: 'field', field: 'coNumber' } },
        ]),
        ...(req.params.id === '14' && !customQuantityReady ? [] : [
          { type: 'text', x: 200, y: 220, rotation: 270, font: '2', xMul: 1, yMul: 1, value: { kind: 'field', field: 'qty' } },
        ]),
        { type: 'text', x: 245, y: 220, rotation: 270, font: '2', value: { kind: 'field', field: 'processCode' } },
        { type: 'barcode', x: 35, y: 925, rotation: 270, height: 40, codeType: '128', value: { kind: 'field', field: 'jtc_barcodeId', prefix: '*j' } },
      ],
    } }));
    mesServer = mes.listen(0, '127.0.0.1'); await new Promise((r) => mesServer.once('listening', r));
    const agentPort = await freePort(), uiPort = await freePort();
    const agentDir = path.join(dir, 'agent'), uiDir = path.join(dir, 'ui');
    fs.mkdirSync(agentDir); fs.mkdirSync(uiDir);
    const printers = ['fg', 'wo', 'receipt'].map((id, index) => ({ id, name: ['FG printer', 'Work Order printer', 'Receipt printer'][index],
      enabled: true, protocol: index === 2 ? 'escpos' : 'tspl', connection: { type: 'tcp', host: '127.0.0.1', port: receivers[index].address().port } }));
    const configFile = path.join(agentDir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ agentId: 'integration-terminal', relayUrl: '', localHttpPort: agentPort, defaultPrinterId: 'fg', printers }));
    const locationsFile = path.join(dir, 'locations.json');
    fs.writeFileSync(locationsFile, JSON.stringify([
      { id: 'fg', name: 'FG labels', group: 'P1', templateId: '11', doneOnly: true },
      { id: 'work', name: 'Work Orders', group: 'P3', templateId: '13', modeGroup: 'work', mode: 'normal' },
      { id: 'work-rework', name: 'Work Orders Rework', group: 'P3', templateId: '13', modeGroup: 'work', mode: 'rework', reworkQrBinding: true },
      { id: 'binding', name: 'K2VG binding', group: 'P3', templateId: '1', models: ['K2VG'], weldingToPainting: true, requireQrBinding: true },
    ]));
    agentProcess = startService(path.join(agentSource, 'server.js'), { PRINT_AGENT_DATA_DIR: agentDir, PRINT_AGENT_CONFIG: configFile, PRINT_AGENT_MANAGEMENT_TOKEN: 'integration-only-token' });
    const agentUrl = 'http://127.0.0.1:' + agentPort;
    await until(async () => { if (agentProcess.exited) throw new Error(agentProcess.logs); try { return (await fetch(agentUrl + '/local-config')).ok; } catch { return false; } }, 'Agent did not start');
    const startUi = () => startService(path.join(__dirname, '..', 'server', 'index.js'), {
      FG_UI_DATA_DIR: uiDir, LOCATIONS_FILE: locationsFile, PORT: String(uiPort), AGENT_URL: agentUrl,
      AGENT_MANAGEMENT_TOKEN: 'integration-only-token', DB_CLIENT: 'mock', AUTO_PRINT_ENABLED: 'false',
      PG_DATABASE: '', PG_USER: '', QRPG_DATABASE: '', QRPG_USER: '', MES_BASE_URL: 'http://127.0.0.1:' + mesServer.address().port,
      QUEUE_POLL_MS: '10', QUEUE_GAP_MS: '1', QUEUE_POLL_TIMEOUT_MS: '1000',
    });
    uiProcess = startUi();
    const base = 'http://127.0.0.1:' + uiPort;
    await until(async () => { if (uiProcess.exited) throw new Error(uiProcess.logs); try { return (await fetch(base + '/api/config')).ok; } catch { return false; } }, 'UI server did not start');
    const api = async (endpoint, body, method) => {
      const response = await fetch(base + endpoint, { method: method || (body ? 'POST' : 'GET'),
        headers: { 'X-Print-UI-Settings': '1', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    await t.test('local Settings authenticates through the UI backend without exposing the agent token', async () => {
      const settings = await api('/api/settings');
      assert.equal(settings.body.agentState.config.printers.length, 3);
      assert.equal(JSON.stringify(settings.body).includes('integration-only-token'), false);
      const saved = await api('/api/settings/assignments', { revision: settings.body.routing.revision, assignments: { fg: 'fg', work: 'wo', binding: 'wo' } }, 'PUT');
      assert.equal(saved.status, 200);
      const persisted = JSON.parse(fs.readFileSync(path.join(uiDir, 'printer-settings.json')));
      assert.equal(persisted.assignments.work, 'wo');
    });
    await t.test('production label jobs reach their assigned printer with client-owned retry IDs', async () => {
      assert.equal((await api('/api/print', { jtcNo: '*j1001', location: 'fg' })).body.success, true);
      assert.equal((await api('/api/print', { jtcNo: '*j1002', location: 'work' })).body.success, true);
      await until(async () => (await api('/api/queue')).body.jobs.length === 2 && (await api('/api/queue')).body.jobs.every((j) => j.status === 'done'));
      assert.equal(labels[0].length, 1); assert.equal(labels[1].length, 1); assert.equal(labels[2].length, 0);
      assert.match(labels[0][0].toString(), /J2606-593/); assert.match(labels[1][0].toString(), /J2606-118/);
      const history = JSON.parse(fs.readFileSync(path.join(agentDir, 'print-queue.json')));
      assert.equal(history.length, 2); assert.ok(history.every((j) => j.retryOwner === 'client' && j.submissionId.startsWith('fgui:')));
    });
    await t.test('Welding to Painting still waits for both Green and Red QR tags', async () => {
      const staged = await api('/api/print', { jtcNo: '*j91002', location: 'binding' });
      assert.equal(staged.body.binding, true); assert.match(staged.body.printJtc, /40\/40/);
      const id = staged.body.id;
      const layout = await api('/api/binding/label-count', { location: 'binding', id, labelCount: 1, previousLabelCount: 2 }, 'PUT');
      assert.equal(layout.status, 200);
      assert.equal(layout.body.jobs[0].labelCount, 1);
      assert.equal((await api('/api/binding/print', { location: 'binding', id })).body.ok, false);
      await api('/api/binding/scan', { location: 'binding', id, token: '2101' });
      assert.equal((await api('/api/binding/print', { location: 'binding', id })).body.ok, false);
      await api('/api/binding/scan', { location: 'binding', id, token: '3203' });
      assert.equal((await api('/api/binding/print', { location: 'binding', id })).body.ok, true);
      await until(() => labels[1].length === 2);
      assert.equal(labels[0].length, 1);
      assert.match(labels[1][1].toString(), /"Start QR: 2101"[\s\S]*"End QR: 3203"/);
    });
    let chromium;
    try { ({ chromium } = require('playwright')); } catch {}
    await t.test('browser can add printers, save assignments and navigate the operator page', { skip: !chromium }, async () => {
      browser = await chromium.launch({ channel: 'chrome', headless: true });
      const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      const leaked = []; page.on('request', (req) => { if (req.url().startsWith(base) && req.headers().authorization) leaked.push(req.url()); });
      await page.goto(base + '/settings.html');
      await page.getByRole('link', { name: 'Terminal and agent', exact: true }).click();
      await page.getByText('Connected to integration-terminal', { exact: false }).waitFor();
      await page.getByRole('link', { name: 'Printers', exact: true }).click();
      assert.equal(await page.locator('.printer-card').count(), 3);
      assert.equal(await page.locator('#assign-work option[value="receipt"]').count(), 0);
      await page.locator('.printer-card').nth(0).getByRole('button', { name: 'Check status', exact: true }).click();
      await page.locator('.printer-card').nth(0).getByText('REACHABLE', { exact: false }).waitFor();
      const statusCard = page.locator('.printer-card').nth(0);
      const statusUrl = base + '/api/settings/printers/fg/status';
      const rawStatusError = 'Command failed: powershell.exe -EncodedCommand LONGBASE64\n#< CLIXML\n<Objs><S S="Error">Configured Windows printer not found_x000D__x000A_</S></Objs>';
      await page.route(statusUrl, (route) => route.fulfill({ contentType: 'application/json',
        body: JSON.stringify({ status: 'ERROR', connected: false, spoolerSupported: true, reason: rawStatusError }) }));
      await statusCard.getByRole('button', { name: 'Check status', exact: true }).click();
      await statusCard.getByText('Printer not found in Windows. Check the Windows share name and printer installation.', { exact: true }).waitFor();
      assert.doesNotMatch(await statusCard.locator('.printer-result').innerText(), /powershell|EncodedCommand|CLIXML|LONGBASE64/);
      assert.match(await statusCard.locator('.printer-result').getAttribute('class'), /error/);
      await page.unroute(statusUrl);
      await page.route(statusUrl, (route) => route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: 'connect ETIMEDOUT private-printer:9100' }) }));
      await statusCard.getByRole('button', { name: 'Check status', exact: true }).click();
      await statusCard.getByText('Printer check timed out. Check the printer connection and try again.', { exact: true }).waitFor();
      assert.doesNotMatch(await statusCard.locator('.printer-result').innerText(), /ETIMEDOUT|private|9100/);
      await page.unroute(statusUrl);
      await statusCard.getByRole('button', { name: 'Check status', exact: true }).click();
      await statusCard.getByText('REACHABLE', { exact: false }).waitFor();
      page.once('dialog', (dialog) => dialog.accept());
      await page.locator('.printer-card').nth(2).getByRole('button', { name: 'Test print', exact: true }).click();
      await page.getByText('Test sent. Confirm it physically came out.', { exact: true }).waitFor();
      assert.equal(labels[2].length, 1);
      assert.match(labels[2][0].toString('latin1'), /Printer connection test/);
      await page.getByRole('button', { name: 'Add printer', exact: true }).click();
      const card = page.locator('.printer-card').last();
      await card.locator('[data-field="name"]').fill('Added from Settings');
      await card.locator('[data-field="share"]').fill('FAKE_UNUSED');
      await page.getByRole('button', { name: 'Save terminal and printers', exact: true }).click();
      await page.getByText('Terminal and printers saved.', { exact: true }).waitFor();
      assert.equal((await api('/api/settings')).body.agentState.config.printers.length, 4);
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.locator('#assign-work').selectOption('wo');
      await page.getByRole('button', { name: 'Save label assignments', exact: true }).click();
      await page.getByText('Label assignments saved. New jobs will use these printers.', { exact: true }).waitFor();
      const qaDir = process.env.FG_UI_QA_DIR;
      if (qaDir) { fs.mkdirSync(qaDir, { recursive: true }); await page.screenshot({ path: path.join(qaDir, 'settings-desktop.png'), fullPage: true }); }
      await page.setViewportSize({ width: 390, height: 850 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (qaDir) await page.screenshot({ path: path.join(qaDir, 'settings-mobile.png'), fullPage: true });
      await page.getByRole('link', { name: 'Back to printing', exact: false }).click();
      await page.locator('#tabs button').first().waitFor();
      assert.equal(await page.getByRole('link', { name: 'Printer settings', exact: true }).count(), 1);
      await page.locator('#jtcInput').fill('J2606-593E21FGM-HD');
      await page.locator('#jtcInput').press('Enter');
      await page.locator('#labelMount svg').waitFor();
      assert.equal(await page.locator('#labelMount svg').count(), 1);
      await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.getByLabel('Show P1', { exact: true }).waitFor();
      assert.equal(await page.locator('.assignment-group').count(), 2);
      await page.getByLabel('Show P1', { exact: true }).uncheck();
      await page.getByRole('button', { name: 'Save visibility', exact: true }).click();
      await page.getByText('Visibility saved. Return to printing to see the changes.', { exact: true }).waitFor();
      const hidden = await api('/api/locations');
      assert.ok(hidden.body.filter((loc) => loc.group === 'P1').every((loc) => loc.visible === false));
      assert.equal((await api('/api/settings')).body.routing.assignments.fg, 'fg');
      if (qaDir) await page.screenshot({ path: path.join(qaDir, 'label-group-visibility.png'), fullPage: true });
      await page.getByRole('link', { name: 'Back to printing', exact: false }).click();
      await page.locator('#tabs button').first().waitFor();
      assert.equal(await page.locator('#tabs').getByRole('tab', { name: 'FG labels', exact: true }).count(), 0);
      assert.equal(await page.locator('#tabs button').count(), 2);
      assert.equal(await page.locator('#jtcInput').isEnabled(), true);
      await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.getByLabel('Show P3', { exact: true }).waitFor();
      await page.getByLabel('Show P3', { exact: true }).uncheck();
      await page.getByRole('button', { name: 'Save visibility', exact: true }).click();
      await page.getByText('Visibility saved. Return to printing to see the changes.', { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Back to printing', exact: false }).click();
      await page.getByText('No labels are visible. Open Printer settings to show a group and its labels.', { exact: true }).waitFor();
      assert.equal(await page.locator('#jtcInput').isDisabled(), true);
      const jobCount = (await api('/api/queue')).body.jobs.length;
      await page.keyboard.type('*j1001', { delay: 1 }); await page.keyboard.press('Enter');
      await pause(200);
      assert.equal((await api('/api/queue')).body.jobs.length, jobCount);
      await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.getByLabel('Show P1', { exact: true }).check();
      await page.getByLabel('Show P3', { exact: true }).check();
      await page.getByRole('button', { name: 'Save visibility', exact: true }).click();
      await page.getByText('Visibility saved. Return to printing to see the changes.', { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Back to printing', exact: false }).click();
      await page.locator('#masterTabs button').first().waitFor();
      assert.equal(await page.locator('#masterTabs button').count(), 2);
      await page.locator('#masterTabs').getByRole('tab', { name: 'P3', exact: true }).click();
      await page.locator('#tabs').getByRole('tab', { name: 'Work Orders', exact: true }).click();
      assert.equal(await page.locator('#modeToggle button').count(), 2);
      await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.getByLabel('Show Work Orders Rework', { exact: true }).uncheck();
      await page.getByRole('button', { name: 'Save visibility', exact: true }).click();
      await page.getByText('Visibility saved. Return to printing to see the changes.', { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Back to printing', exact: false }).click();
      await page.locator('#tabs button').first().waitFor();
      assert.equal(await page.locator('#modeToggle').isHidden(), true);
      assert.equal(await page.locator('#tabs').getByRole('tab', { name: 'Work Orders', exact: true }).count(), 1);
      await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.getByLabel('Show Work Orders', { exact: true }).uncheck();
      await page.getByRole('button', { name: 'Save visibility', exact: true }).click();
      await page.getByText('Visibility saved. Return to printing to see the changes.', { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Back to printing', exact: false }).click();
      await page.locator('#masterTabs').getByRole('tab', { name: 'P3', exact: true }).click();
      assert.equal(await page.locator('#tabs').getByRole('tab', { name: 'Work Orders', exact: true }).count(), 0);
      assert.equal(await page.locator('#tabs button').count(), 1);
      await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.getByLabel('Show Work Orders Rework', { exact: true }).check();
      await page.getByRole('button', { name: 'Save visibility', exact: true }).click();
      await page.getByText('Visibility saved. Return to printing to see the changes.', { exact: true }).waitFor();
      if (qaDir) await page.screenshot({ path: path.join(qaDir, 'individual-label-visibility.png'), fullPage: true });
      await page.getByRole('link', { name: 'Back to printing', exact: false }).click();
      await page.locator('#tabs').getByRole('tab', { name: 'Work Orders', exact: true }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem('jtc.locationId')), 'work-rework');
      assert.equal(await page.locator('#modeToggle').isHidden(), true);
      // A server started before the individual-visibility update must not silently accept it.
      const restartMessage = 'Restart fg-print-ui, then reload this page to enable individual label visibility.';
      await page.route(base + '/api/settings', async (route) => {
        const response = await route.fetch(); const body = await response.json();
        delete body.routing.hiddenLocations;
        await route.fulfill({ response, json: body });
      });
      let visibilitySaves = 0;
      await page.route(base + '/api/settings/visibility', async (route) => {
        visibilitySaves++;
        await route.fulfill({ json: { hiddenGroups: [], revision: 'older-backend' } });
      });
      await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.getByText(restartMessage, { exact: true }).waitFor();
      await page.getByLabel('Show FG labels', { exact: true }).uncheck();
      await page.getByRole('button', { name: 'Save visibility', exact: true }).click();
      assert.equal(visibilitySaves, 0);
      assert.equal(await page.getByLabel('Show FG labels', { exact: true }).isChecked(), false);
      await page.unroute(base + '/api/settings');
      await page.reload();
      await page.getByText('Settings loaded.', { exact: true }).waitFor();
      await page.getByLabel('Show FG labels', { exact: true }).uncheck();
      await page.getByRole('button', { name: 'Save visibility', exact: true }).click();
      await page.getByText('Visibility was not saved correctly. ' + restartMessage, { exact: true }).waitFor();
      assert.equal(visibilitySaves, 1);
      assert.equal(await page.getByLabel('Show FG labels', { exact: true }).isChecked(), false);
      await page.unroute(base + '/api/settings/visibility');
      assert.equal(leaked.length, 0); assert.deepEqual(errors, []);
    });
    await t.test('label editor saves model and QR rules, manages destinations and updates operator tabs', { skip: !chromium }, async () => {
      const page = await browser.newPage({ viewport: { width: 1200, height: 950 } });
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/settings.html#labels');
      await page.getByRole('link', { name: 'Label configuration', exact: true }).click();
      await page.getByText('Label configuration loaded.', { exact: true }).waitFor();
      const field = (key) => page.locator('[data-label-field="' + key + '"]');
      await page.locator('#labelConfigSelect').selectOption({ label: 'P3 · Work Orders Rework' });
      assert.equal(await field('id').getAttribute('readonly') !== null, true);
      assert.equal(await field('reworkQrBinding').isChecked(), true);
      assert.equal(await field('requireQrBinding').isDisabled(), true);
      await field('reworkQrBinding').uncheck();
      assert.equal(await field('requireQrBinding').isEnabled(), true);
      assert.equal(await field('reworkQrBinding').isEnabled(), true);
      await field('requireQrBinding').check();
      assert.equal(await field('reworkQrBinding').isDisabled(), true);
      assert.match(await field('reworkQrBinding').locator('..').getAttribute('class'), /qr-binding-disabled/);
      await field('requireQrBinding').uncheck();
      assert.equal(await field('reworkQrBinding').isEnabled(), true);
      await field('reworkQrBinding').check();
      await page.locator('#labelConfigSelect').selectOption({ label: 'P3 · K2VG binding' });
      assert.equal(await field('requireQrBinding').isChecked(), true);
      assert.equal(await field('reworkQrBinding').isDisabled(), true);
      assert.equal(await field('processCodePrepend').isEnabled(), true);
      await field('processCodePrepend').fill('SB');
      await field('weldingToPainting').uncheck();
      assert.equal(await field('processCodePrepend').isDisabled(), true);
      assert.equal(await field('processCodePrepend').inputValue(), 'SB');
      await field('weldingToPainting').check();
      assert.equal(await field('processCodePrepend').isEnabled(), true);
      assert.equal(await field('processCodePrepend').inputValue(), 'SB');
      await field('processCodePrepend').fill(''); // Restore the label with an existing binding history.
      await page.locator('#labelConfigSelect').selectOption({ label: 'P3 · Work Orders Rework' });
      assert.equal(await field('processCodePrepend').isDisabled(), true);
      assert.equal(await field('reworkQrBinding').isChecked(), true);
      assert.equal(await field('requireQrBinding').isDisabled(), true);
      await field('mode').selectOption('normal'); await field('reworkQrBinding').uncheck();
      await page.getByRole('button', { name: 'Save label configuration', exact: true }).click();
      await page.locator('#labelConfigStatus.error').getByText('Labels sharing a mode group', { exact: false }).waitFor();
      assert.equal((await api('/api/settings/locations')).body.locations.find((l) => l.id === 'work-rework').mode, 'rework');
      await field('mode').selectOption('rework'); await field('reworkQrBinding').check();
      await field('models').fill('k2vg, K2SA'); await field('templateId').fill('21');
      await page.getByText('Label layout', { exact: true }).click();
      await field('barcodeNudge').fill('16'); await field('variant').selectOption('plain'); await field('upright').uncheck();
      await page.getByRole('button', { name: 'Save label configuration', exact: true }).click();
      await page.getByText('Label configuration saved. Return to printing to load the updated labels.', { exact: true }).waitFor();
      const rework = (await api('/api/settings/locations')).body.locations.find((l) => l.id === 'work-rework');
      assert.deepEqual(rework.models, ['K2VG', 'K2SA']); assert.equal(rework.reworkQrBinding, true); assert.equal(rework.barcodeNudge, 16);
      await page.reload(); await page.getByRole('link', { name: 'Label configuration', exact: true }).click();
      await page.getByText('Label configuration loaded.', { exact: true }).waitFor();
      await page.locator('#labelConfigSelect').selectOption({ label: 'P3 · Work Orders Rework' });
      assert.equal(await field('models').inputValue(), 'K2VG, K2SA');
      await page.getByRole('button', { name: 'Duplicate label', exact: true }).click();
      await field('id').fill('qa-label'); await field('name').fill('QA label'); await field('group').fill('P4');
      await field('modeGroup').fill('qa-pair'); await field('mode').selectOption('normal');
      await field('reworkQrBinding').uncheck(); await field('requireQrBinding').check(); await field('weldingToPainting').check();
      await field('models').fill('qa'); await field('templateId').fill('31'); await field('processCodePrepend').fill('QA');
      await field('doneOnly').check(); await field('toLocation').selectOption('18');
      assert.match(await field('toLocation').locator('option:checked').innerText(), /P3-OUTGOING.*ID 18/);
      await page.getByRole('button', { name: 'Save label configuration', exact: true }).click();
      await page.getByText('Label configuration saved. Return to printing to load the updated labels.', { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.getByLabel('Show P4', { exact: true }).waitFor();
      const created = (await api('/api/settings/locations')).body.locations.find((l) => l.id === 'qa-label');
      assert.equal(created.requireQrBinding, true); assert.equal(created.reworkQrBinding, false); assert.equal(created.weldingToPainting, true);
      assert.equal(created.toLocation, 18); assert.equal(created.processCodePrepend, 'QA'); assert.deepEqual(created.models, ['QA']);
      assert.ok(JSON.parse(fs.readFileSync(locationsFile + '.bak')).every((l) => l.id !== 'qa-label'));
      await page.getByRole('link', { name: 'Back to printing', exact: false }).click();
      await page.locator('#masterTabs').getByRole('tab', { name: 'P4', exact: true }).click();
      await page.locator('#tabs').getByRole('tab', { name: 'QA label', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Printer settings', exact: true }).click();
      await page.getByRole('link', { name: 'Label assignments', exact: true }).click();
      await page.getByRole('link', { name: 'Label configuration', exact: true }).click();
      await page.getByText('Label configuration loaded.', { exact: true }).waitFor();
      await page.locator('#labelConfigSelect').selectOption({ label: 'P4 · QA label' });
      assert.equal(await field('requireQrBinding').isChecked(), true);
      assert.equal(await field('reworkQrBinding').isDisabled(), true);
      assert.equal(await field('toLocation').inputValue(), '18');
      assert.equal(await field('processCodePrepend').isEnabled(), true);
      await field('weldingToPainting').uncheck();
      assert.equal(await field('processCodePrepend').isDisabled(), true);
      await page.getByRole('button', { name: 'Save label configuration', exact: true }).click();
      await page.getByText('Label configuration saved. Return to printing to load the updated labels.', { exact: true }).waitFor();
      await page.reload(); await page.getByText('Label configuration loaded.', { exact: true }).waitFor();
      await page.locator('#labelConfigSelect').selectOption({ label: 'P4 · QA label' });
      assert.equal(await field('processCodePrepend').isDisabled(), true);
      assert.equal(await field('processCodePrepend').inputValue(), 'QA');
      await field('weldingToPainting').check();
      assert.equal(await field('processCodePrepend').isEnabled(), true);
      assert.equal(await field('processCodePrepend').inputValue(), 'QA');
      await page.getByRole('button', { name: 'Save label configuration', exact: true }).click();
      await page.getByText('Label configuration saved. Return to printing to load the updated labels.', { exact: true }).waitFor();
      await page.route(base + '/api/settings/stock-locations', (route) => route.fulfill({ status: 503,
        contentType: 'application/json', body: JSON.stringify({ error: 'Database unavailable.' }) }));
      await page.getByRole('button', { name: 'Refresh locations', exact: true }).click();
      await page.locator('#stockLocationStatus').getByText('Database unavailable.', { exact: false }).waitFor();
      assert.equal(await field('toLocation').inputValue(), '18');
      await page.locator('#labelConfigSelect').selectOption({ label: 'P3 · Work Orders Rework' });
      assert.equal(await field('toLocation').inputValue(), '');
      await page.locator('#labelConfigSelect').selectOption({ label: 'P4 · QA label' });
      assert.equal(await field('toLocation').inputValue(), '18');
      await page.unroute(base + '/api/settings/stock-locations');
      await page.route(base + '/api/settings/stock-locations', (route) => route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ locations: [] }) }));
      await page.getByRole('button', { name: 'Refresh locations', exact: true }).click();
      await page.locator('#stockLocationStatus').getByText('No active locations found.', { exact: false }).waitFor();
      assert.match(await field('toLocation').locator('option:checked').innerText(), /Saved location ID 18.*no longer active/);
      await page.unroute(base + '/api/settings/stock-locations');
      await page.getByRole('button', { name: 'Refresh locations', exact: true }).click();
      await page.locator('#stockLocationStatus').getByText('Active database locations only.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Remove label', exact: true }).click();
      await page.getByRole('button', { name: 'Save label configuration', exact: true }).click();
      await page.getByText('Label configuration saved. Return to printing to load the updated labels.', { exact: true }).waitFor();
      assert.equal((await api('/api/print', { jtcNo: '*j1001', location: 'qa-label' })).status, 404);
      await page.locator('#labelConfigSelect').selectOption({ label: 'P3 · Work Orders Rework' });
      const qaDir = process.env.FG_UI_QA_DIR;
      if (qaDir) await page.locator('[aria-labelledby="labelConfigHeading"]').screenshot({ path: path.join(qaDir, 'label-configuration-desktop.png') });
      await page.setViewportSize({ width: 390, height: 850 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (qaDir) await page.locator('[aria-labelledby="labelConfigHeading"]').screenshot({ path: path.join(qaDir, 'label-configuration-mobile.png') });
      assert.deepEqual(errors, []); await page.close();
    });
    await t.test('sidebar Auto Print controls persist and stage new mock completions behind QR binding', { skip: !chromium }, async () => {
      const autoLocation = 'auto-binding';
      const configBefore = (await api('/api/settings/locations')).body;
      const autoLabel = { ...configBefore.locations.find((l) => l.id === 'binding'), id: autoLocation, group: 'QA', name: 'Auto WO binding' };
      assert.equal((await api('/api/settings/locations', { revision: configBefore.revision, locations: [...configBefore.locations, autoLabel] }, 'PUT')).status, 200);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(base + '/settings.html#auto');
      await page.getByText('Auto Print settings loaded.', { exact: true }).waitFor();
      assert.equal(await page.locator('[data-settings-panel="printers"]').isHidden(), true);
      assert.equal(await page.locator('[data-settings-panel="auto"]').isVisible(), true);
      assert.equal(await page.locator('#autoPrintLabels input[data-location="work-rework"]').isDisabled(), true);
      await page.locator('#autoPrintEnabled').check(); await page.locator('#autoPrintSeconds').fill('1');
      await page.locator('#autoPrintLabels input[data-location="auto-binding"]').check();
      await page.getByRole('button', { name: 'Save Auto Print', exact: true }).click();
      await page.getByText('Auto Print saved. Changes are active now.', { exact: true }).waitFor();
      const config = await api('/api/settings/auto-print');
      assert.equal(config.body.enabled, true); assert.equal(config.body.status.started, true); assert.equal(config.body.pollMs, 1000);
      assert.deepEqual(config.body.locations, [autoLocation]);
      const labelsConfig = (await api('/api/settings/locations')).body;
      const removal = await api('/api/settings/locations', { revision: labelsConfig.revision, locations: labelsConfig.locations.filter((l) => l.id !== autoLocation) }, 'PUT');
      assert.equal(removal.status, 400);
      const beforePrints = labels[0].length + labels[1].length;
      const bindings = async () => (await api('/api/binding?location=' + autoLocation)).body.jobs;
      const beforeBindings = (await bindings()).length;
      assert.equal((await api('/api/dev/complete', { id: 91002 })).status, 200);
      await until(async () => (await bindings()).length > beforeBindings, 'New completion did not stage for QR binding');
      assert.equal((await bindings())[0].labelCount, 2);
      assert.equal(labels[0].length + labels[1].length, beforePrints);
      await page.locator('#autoPrintEnabled').uncheck();
      await page.getByRole('button', { name: 'Save Auto Print', exact: true }).click();
      await page.getByText('Auto Print saved. Changes are active now.', { exact: true }).waitFor();
      assert.equal((await api('/api/auto')).body.started, false);
      assert.equal((await bindings()).length, beforeBindings + 1);
      await page.reload(); await page.getByText('Auto Print settings loaded.', { exact: true }).waitFor();
      assert.equal(await page.locator('#autoPrintEnabled').isChecked(), false);
      assert.equal(await page.locator('#autoPrintLabels input[data-location="auto-binding"]').isChecked(), true);
      const qaDir = process.env.FG_UI_QA_DIR;
      if (qaDir) await page.screenshot({ path: path.join(qaDir, 'sidebar-auto-print-desktop.png'), fullPage: true });
      await page.getByRole('link', { name: 'Label configuration', exact: true }).click();
      await page.getByText('Label configuration loaded.', { exact: true }).waitFor();
      const name = page.locator('[data-label-field="name"]');
      await name.fill('Unsaved draft preserved');
      await page.getByRole('link', { name: 'Printers', exact: true }).click();
      await page.getByRole('link', { name: 'Label configuration', exact: true }).click();
      assert.equal(await name.inputValue(), 'Unsaved draft preserved');
      await page.getByRole('button', { name: 'Discard label edits', exact: true }).click();
      await page.getByText('Label edits discarded.', { exact: true }).waitFor();
      await page.getByRole('link', { name: 'Auto Print', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 850 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (qaDir) await page.screenshot({ path: path.join(qaDir, 'sidebar-auto-print-mobile.png'), fullPage: true });
      await page.close();
    });
    await t.test('split WO labels persist between pairs, render separate quantities and retry individually', async () => {
      const config = (await api('/api/settings/locations')).body;
      const split = { id: 'split', name: 'Split WO', group: 'QA', templateId: '1', requireQrBinding: true, weldingToPainting: true, splitWoLabels: true, processCodePrepend: 'SB', upright: false };
      const custom = { ...split, id: 'custom-split', name: 'Custom split WO', templateId: '14', upright: true };
      assert.equal((await api('/api/settings/locations', { revision: config.revision, locations: [...config.locations, split, custom] }, 'PUT')).status, 200);
      const callBinding = (action, id, partNumber, token, location = 'split') => api('/api/binding/' + action, { location, id, partNumber, token });
      const bindings = async (location = 'split') => (await api('/api/binding?location=' + location)).body.jobs;
      const printJobs = async (location = 'split') => (await api('/api/queue')).body.jobs.filter((j) => j.location === location);
      const stage = (location = 'split', jtcNo = '*j91002') => api('/api/print', { jtcNo, location });
      assert.equal((await stage('split', '*j999999')).status, 404);
      const direct = await stage('split', '*j91001');
      assert.equal(direct.status, 200);
      assert.equal(direct.body.binding, true);
      const { id } = direct.body;
      assert.equal((await bindings())[0].splitTotal, 46);
      assert.deepEqual((await bindings())[0].parts.map((part) => part.qty), [23, 23]);
      const splitQuery = '?no=*j91001&location=split&bindingId=' + id + '&part=1';
      const model = (await api('/api/label/model' + splitQuery)).body;
      const fieldAt = (elements, x, y) => elements.find((el) => el.type === 'text' && el.x === x && el.y === y)?.text;
      assert.equal(fieldAt(model.elements, 145, 920), 'CO-2026-0047');
      assert.equal(fieldAt(model.elements, 345, 515), direct.body.printJtc);
      const noCustomerOrder = (await api('/api/label/model?no=*j1002&location=split')).body;
      assert.equal(fieldAt(noCustomerOrder.elements, 145, 920), '');
      assert.equal(fieldAt(noCustomerOrder.elements, 345, 515), 'J2606-118A02TRX-LD');
      const woLine = 'TEXT 145,920,"3",270,1,1,"CO-2026-0047"';
      const jtcLine = `TEXT 345,515,"2",270,1,1,"${direct.body.printJtc}"`;
      const tsplPreview = await (await fetch(base + '/api/print/preview' + splitQuery)).text();
      assert.ok(tsplPreview.includes(woLine) && tsplPreview.includes(jtcLine));
      assert.equal((await stage()).body.id, id);
      assert.equal((await bindings()).length, 1);
      const page = chromium ? await browser.newPage() : null;
      if (page) {
        await page.goto(base + '/');
        await page.getByRole('tab', { name: 'QA', exact: true }).click();
        await page.getByRole('tab', { name: 'Split WO', exact: true }).click();
        await page.locator('[aria-current="step"]').getByText('Pair 1 of 2', { exact: true }).waitFor();
        await page.locator('.b-pair--scanning').getByText('Scan now', { exact: true }).waitFor();
        await page.locator('#labelMount').getByText('1 OF 2', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Part 1 quantity').inputValue(), '23');
        assert.equal(await page.locator('#splitQuantityTwo').innerText(), '23');
        assert.equal(await page.locator('#splitTotalNote').innerText(), 'Job total: 46.');
        assert.equal(await page.getByRole('button', { name: 'Apply split', exact: true }).isDisabled(), true);
        await page.close();
      }
      assert.equal((await callBinding('scan', id, 1, '0101')).body.ok, true);
      assert.equal((await callBinding('print', id, 1)).body.ok, false);
      assert.equal((await printJobs()).length, 0);
      assert.equal((await callBinding('scan', id, 1, '2201')).body.ok, true);
      const first = (await Promise.all([callBinding('print', id, 1), callBinding('print', id, 1)])).map((r) => r.body);
      assert.equal(first[0].id, first[1].id);
      assert.equal(first[0].jobs[0].currentPart, 2);
      assert.equal((await api('/api/binding/split', { location: 'split', id, partOneQty: 20, previousQty: 23 }, 'PUT')).status, 409);
      assert.equal((await callBinding('remove', id)).status, 409);
      assert.equal((await callBinding('print', id, 2)).body.ok, false);
      assert.equal((await callBinding('scan', id, 1, '0101')).body.ok, false);
      assert.equal((await callBinding('scan', id, 2, '0101')).body.ok, true);
      assert.equal((await callBinding('scan', id, 2, '2102')).body.ok, true);
      assert.equal((await callBinding('print', id, 2)).body.ok, false);
      await until(async () => (await printJobs())[0]?.status === 'done');
      await stopService(uiProcess); uiProcess = startUi();
      await until(async () => { if (uiProcess.exited) throw new Error(uiProcess.logs); try { return (await fetch(base + '/api/config')).ok; } catch { return false; } });
      assert.equal((await bindings())[0].parts[1].startTag, 2102);
      assert.equal((await stage()).body.id, id);
      assert.equal((await stage('split', '*j91001')).body.id, id);

      if (chromium) {
        const page = await browser.newPage();
        await page.goto(base + '/');
        await page.getByRole('tab', { name: 'QA', exact: true }).click();
        await page.getByRole('tab', { name: 'Split WO', exact: true }).click();
        await page.locator('#bindingState').getByText('Pair 2 of 2 · Qty 23', { exact: true }).waitFor();
        assert.equal(await page.locator('#splitQuantityOne').isVisible(), false);
        const currentPair = page.locator('[aria-current="step"]');
        await currentPair.getByText('Pair 2 of 2', { exact: true }).waitFor();
        await currentPair.getByText('Scan now', { exact: true }).waitFor();
        const firstPair = page.locator('.b-pair').filter({ hasText: 'Pair 1 of 2' });
        await firstPair.getByText('Bind complete', { exact: true }).waitFor();
        await firstPair.locator('.b-pill--green').getByText('0101', { exact: true }).waitFor();
        await firstPair.locator('.b-pill--red').getByText('2201', { exact: true }).waitFor();
        assert.equal(await page.locator('.b-pair--scanning').count(), 1);
        const marker = page.locator('#labelMount').getByText('2 OF 2', { exact: true });
        await marker.waitFor();
        assert.equal(await marker.getAttribute('x'), '45');
        assert.equal(await marker.getAttribute('y'), '136');
        await page.locator('#labelMount').getByText('SB, PL', { exact: true }).waitFor();
        await page.locator('#labelMount').getByText('Start QR: 2102', { exact: true }).waitFor();
        const qaDir = process.env.FG_UI_QA_DIR;
        if (qaDir) {
          await page.locator('#bindingPanel').screenshot({ path: path.join(qaDir, 'split-qr-binding.png') });
          await page.locator('#labelMount').screenshot({ path: path.join(qaDir, 'split-wo-label.png') });
        }
        await page.setViewportSize({ width: 390, height: 850 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const input = page.locator('#jtcInput');
        await input.fill('2201'); await input.press('Enter');
        await page.locator('#bindingState').getByText('Bind complete', { exact: true }).waitFor();
        await page.locator('#labelMount').getByText('End QR: 2201', { exact: true }).waitFor();
        assert.equal(await page.locator('.b-pair').getByText('Bind complete', { exact: true }).count(), 2);
        assert.equal(await page.locator('.b-pair--scanning').count(), 0);
        await page.getByRole('button', { name: 'Preview Pair 1', exact: true }).click();
        await page.locator('#labelMount').getByText('1 OF 2', { exact: true }).waitFor();
        const secondPair = page.locator('.b-pair').filter({ hasText: 'Pair 2 of 2' });
        await secondPair.locator('.b-pill--green').getByText('2102', { exact: true }).waitFor();
        await secondPair.locator('.b-pill--red').getByText('2201', { exact: true }).waitFor();
        await page.locator('#labelMount').getByText('Start QR: 0101', { exact: true }).waitFor();

        await page.close();
      } else {
        assert.equal((await callBinding('scan', id, 2, '2201')).body.ok, true);
        assert.equal((await callBinding('print', id, 2)).body.ok, true);
      }
      await until(async () => (await printJobs()).length === 2 && (await printJobs()).every((j) => j.status === 'done'));
      assert.deepEqual((await printJobs()).map((j) => j.splitPart), [{ number: 1, qty: 23 }, { number: 2, qty: 23 }]);
      assert.equal((await callBinding('scan', id, 2, '2203')).body.ok, false);
      assert.equal((await callBinding('remove', id)).status, 200);
      assert.equal((await stage()).status, 409);
      assert.equal((await stage('split', '*j91001')).status, 409);

      const location = custom.id;
      const customId = (await stage(location)).body.id;
      const updateSplit = (partOneQty, previousQty = 23) => api('/api/binding/split', { location, id: customId, partOneQty, previousQty }, 'PUT');
      assert.equal((await updateSplit(46)).status, 400);
      assert.equal((await callBinding('scan', customId, 1, '2101', location)).body.ok, true);
      await stopService(uiProcess);
      const bindingFile = path.join(uiDir, 'binding-jobs.json');
      const oldQueue = JSON.parse(fs.readFileSync(bindingFile, 'utf8'));
      const legacyJob = oldQueue.jobs.find((job) => job.id === customId);
      delete legacyJob.splitTotal;
      for (const part of legacyJob.parts) part.qty = 25;
      fs.writeFileSync(bindingFile, JSON.stringify(oldQueue));
      uiProcess = startUi();
      await until(async () => { if (uiProcess.exited) throw new Error(uiProcess.logs); try { return (await fetch(base + '/api/config')).ok; } catch { return false; } });
      assert.equal((await bindings(location))[0].splitNeedsRefresh, true);
      assert.match((await callBinding('print', customId, 1, undefined, location)).body.error, /Rescan this JTC/);
      assert.equal((await stage(location)).body.id, customId);
      assert.equal((await bindings(location))[0].splitTotal, 46);
      if (chromium) {
        const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
        await page.goto(base + '/');
        await page.getByRole('tab', { name: 'QA', exact: true }).click();
        await page.getByRole('tab', { name: 'Custom split WO', exact: true }).click();
        const qty = page.getByLabel('Part 1 quantity');
        await qty.waitFor();
        assert.equal(await qty.inputValue(), '23');
        assert.equal(await qty.getAttribute('max'), '45');
        await qty.fill('15');
        await page.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await qty.inputValue(), '23');
        await qty.selectText();
        await qty.pressSequentially('20');
        await page.waitForResponse((response) => response.url().endsWith('/api/binding?location=custom-split'));
        assert.equal(await qty.inputValue(), '20');
        assert.equal(await page.locator('#splitQuantityTwo').innerText(), '26');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const qaDir = process.env.FG_UI_QA_DIR;
        if (qaDir) await page.locator('#bindingPanel').screenshot({ path: path.join(qaDir, 'operator-adjust-split.png') });
        await page.getByRole('button', { name: 'Apply split', exact: true }).click();
        await page.locator('#status').getByText('Split saved: 20 + 26.', { exact: true }).waitFor();
        await page.locator('.b-pair').filter({ hasText: 'Pair 2 of 2' }).getByText('Qty 26', { exact: true }).waitFor();
        await page.close();
      } else {
        assert.equal((await updateSplit(20)).status, 200);
      }
      assert.deepEqual((await bindings(location))[0].parts.map((part) => part.qty), [20, 26]);
      assert.equal((await bindings(location))[0].parts[0].startTag, 2101);
      assert.equal((await updateSplit(21)).status, 409);
      for (const [part, tags] of [[1, ['2101', '2201']], [2, ['2102', '2202']]]) {
        for (const tag of tags) assert.equal((await callBinding('scan', customId, part, tag, location)).body.ok, true);
        assert.equal((await callBinding('print', customId, part, undefined, location)).body.ok, true);
      }
      await until(async () => (await printJobs(location)).length === 2 && (await printJobs(location)).every((j) => j.status === 'error'));
      if (chromium) {
        const page = await browser.newPage();
        await page.goto(base + '/');
        await page.getByRole('tab', { name: 'QA', exact: true }).click();
        await page.getByRole('tab', { name: 'Custom split WO', exact: true }).click();
        await page.locator('#bindingState').getByText('Bind complete', { exact: true }).waitFor();
        assert.equal(await page.locator('.b-pair').getByText('Bind complete', { exact: true }).count(), 2);
        await page.close();
      }
      const [one, two] = await printJobs(location);
      customQuantityReady = true;
      assert.equal((await api('/api/template/reload', { location })).body.success, true);
      assert.equal((await api('/api/queue/resolve', { id: one.id, decision: 'retry' })).status, 200);
      await api('/api/queue/resume', { queueKey: one.queueKey });
      await until(async () => (await printJobs(location))[0].status === 'done');
      assert.equal((await printJobs(location))[1].status, 'error');
      await api('/api/queue/resolve', { id: two.id, decision: 'retry' });
      await api('/api/queue/resume', { queueKey: two.queueKey });
      await until(async () => (await printJobs(location))[1].status === 'done');
      const printed = labels.flat().map((b) => b.toString()).filter((s) => /"[12] OF 2"/.test(s));
      assert.equal(printed.length, 4);
      assert.equal(printed.filter((s) => s.includes(woLine) && s.includes(jtcLine)).length, 2);
      const splitLabels = printed.filter((s) => s.includes(woLine));
      for (const [part, tag] of [[1, '0101'], [2, '2102']]) {
        const text = splitLabels.find((s) => s.includes(`"${part} OF 2"`));
        assert.ok(text.includes(`TEXT 445,920,"3",270,1,1,"Start QR: ${tag}"`));
        assert.ok(text.includes('TEXT 475,920,"3",270,1,1,"End QR: 2201"'));
      }
      for (const [part, qty] of [[1, 23], [2, 23], [1, 20], [2, 26]]) {
        const markerPosition = qty === 23 ? '45,136,"2",270' : '903,45,"2",0';
        assert.ok(printed.some((s) => s.includes(`TEXT ${markerPosition},1,1,"${part} OF 2"`) && s.includes('"' + qty + '"') && s.includes('"SB, PL"') && /BARCODE.*\*j91001/.test(s)));
      }
      assert.ok(printed.every((s) => !s.includes('QR PAIR')));
    });
    await t.test('operators can switch a default split to one full-quantity label on the printing page', { skip: !chromium }, async () => {
      const location = 'operator-wo';
      const config = (await api('/api/settings/locations')).body;
      const label = { ...config.locations.find((l) => l.id === 'split'), id: location, name: 'Operator Work Order', splitWoLabels: false };
      assert.equal((await api('/api/settings/locations', { revision: config.revision, locations: [...config.locations, label] }, 'PUT')).status, 200);
      const { id } = (await api('/api/print', { jtcNo: '*j91001', location })).body;
      const printJobs = async () => (await api('/api/queue')).body.jobs.filter((j) => j.location === location);
      const scan = (token, partNumber) => api('/api/binding/scan', { location, id, token, partNumber });
      assert.equal((await scan('2101', 1)).body.ok, true);
      const page = await browser.newPage({ viewport: { width: 390, height: 850 } });
      const count = page.getByRole('combobox', { name: 'WO labels' });
      const openLabel = async () => {
        await page.goto(base + '/');
        await page.getByRole('tab', { name: 'QA', exact: true }).click();
        await page.getByRole('tab', { name: 'Operator Work Order', exact: true }).click();
        await count.waitFor();
      };
      try {
        await openLabel();
        assert.equal(await count.inputValue(), '2');
        const choose = async (value) => {
          const response = page.waitForResponse((r) => r.url().endsWith('/api/binding/label-count'));
          await count.selectOption(value);
          assert.equal((await response).ok(), true);
        };
        await choose('1');
        await page.getByText('Full job quantity: 46', { exact: true }).waitFor();
        assert.equal(await page.locator('#splitForm').isHidden(), true);
        await choose('2');
        await page.getByLabel('Part 1 quantity').waitFor();
        assert.equal(await page.getByLabel('Part 1 quantity').inputValue(), '23');
        await choose('1');
        await page.getByText('Full job quantity: 46', { exact: true }).waitFor();
        await openLabel();
        assert.equal(await count.inputValue(), '1');
        await page.locator('.b-pill--green').getByText('2101', { exact: true }).waitFor();
        await page.locator('#labelMount').getByText('46', { exact: true }).waitFor();
        assert.equal(await page.locator('#labelMount').getByText('1 OF 2', { exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal((await scan('2201', 1)).body.ok, false);
        assert.equal((await printJobs()).length, 0);
        const input = page.locator('#jtcInput');
        await input.fill('2201'); await input.press('Enter');
        await page.locator('#bindingState').getByText('Bind complete', { exact: true }).waitFor();
        await until(async () => (await printJobs())[0]?.status === 'done');
        assert.equal(await count.isDisabled(), true);
        const locked = await api('/api/binding/label-count', { location, id, labelCount: 2, previousLabelCount: 1 }, 'PUT');
        assert.equal(locked.status, 409);
        assert.equal((await api('/api/binding/print', { location, id })).body.id, (await printJobs())[0].id);
        assert.equal((await printJobs()).length, 1);
        assert.equal((await printJobs())[0].workOrderQty, 46);
        const tspl = labels.flat().map((buf) => buf.toString()).findLast((text) => text.includes('"End QR: 2201"'));
        assert.match(tspl, /TEXT 200,220,"2",270,1,1,"46"/);
        assert.match(tspl, /"Start QR: 2101"/);
        assert.doesNotMatch(tspl, /"[12] OF 2"/);
      } finally {
        await page.close();
      }
    });
  });
