'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
let chromium; try { ({ chromium } = require('playwright')); } catch {}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(10); } throw new Error('Expected request did not arrive'); }

test('QR instructions follow the active mode and ignore delayed replies from other modes', { skip: !chromium, timeout: 45000 }, async (t) => {
  const app = express(); app.use(express.json());
  const locations = [
    { id: 'normal', name: 'Work Order', group: 'P3', modeGroup: 'work', mode: 'normal', requireQrBinding: true, bindingMode: 'normal' },
    { id: 'rework', name: 'Work Order Rework', group: 'P3', modeGroup: 'work', mode: 'rework', reworkQrBinding: true, bindingMode: 'rework' },
    { id: 'plain', name: 'Other label', group: 'P3' },
  ];
  const jobs = { normal: [{ id: 101, paintingJtc: 'NORMAL-JOB', location: 'normal', bindingMode: 'normal' }],
    rework: [{ id: 102, paintingJtc: 'REWORK-JOB', location: 'rework', bindingMode: 'rework' }] };
  let holdPrint = false, printReply, holdBinding = false, holdLookup = false, lookupReply;
  const bindingReplies = [], prints = [];
  let releases = 0, browser;
  app.get('/api/locations', (_req, res) => res.json(locations));
  app.get('/api/config', (_req, res) => res.json({ companyName: 'Preview' }));
  app.get('/api/queue', (_req, res) => res.json({ jobs: [], queues: [], paused: false }));
  app.get('/api/auto', (_req, res) => res.json({ enabled: false }));
  app.get('/api/jtc/search', (_req, res) => res.json([]));
  app.get('/api/jtc', (req, res) => {
    const reply = () => res.json({ jtcNo: req.query.no });
    if (holdLookup && req.query.no === 'LOOKUP-LATE') lookupReply = reply; else reply();
  });
  app.get('/api/label/model', (_req, res) => res.json({ label: { widthDots: 400, heightDots: 500 }, elements: [] }));
  app.get('/api/binding', (req, res) => {
    const id = req.query.location;
    const reply = () => res.json({ jobs: jobs[id] || [] });
    if (holdBinding && id === 'rework') bindingReplies.push(reply); else reply();
  });
  app.post('/api/print', (req, res) => {
    prints.push(req.body);
    const id = req.body.location;
    const reply = () => res.json({ success: true, binding: true, bindingMode: id === 'rework' ? 'rework' : 'normal', id: id === 'rework' ? 102 : 101 });
    if (holdPrint && id === 'rework') printReply = reply; else reply();
  });
  app.post('/api/binding/print', (_req, res) => { releases++; res.json({ ok: true, jobs: [] }); });
  app.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', 'jsbarcode', 'dist')));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  t.after(async () => {
    printReply?.(); lookupReply?.(); for (const reply of bindingReplies) reply();
    if (browser) await browser.close(); await new Promise((r) => server.close(r));
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  const normal = () => page.locator('#modeToggle').getByRole('button', { name: 'Normal', exact: true });
  const rework = () => page.locator('#modeToggle').getByRole('button', { name: 'Rework', exact: true });
  const text = () => page.locator('#status').textContent();
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  async function enter(value) { await page.locator('#jtcInput').fill(value); await page.locator('#jtcInput').press('Enter'); }
  await normal().waitFor(); await page.locator('#bindingList').getByText('NORMAL-JOB', { exact: true }).waitFor();
  assert.match(await text(), /Green.*Red/); assert.doesNotMatch(await text(), /Black|Rework/);
  await rework().click(); await enter('FIRST');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Staged'));
  assert.match(await text(), /Black Rework/);
  await normal().click(); await page.locator('#bindingList').getByText('NORMAL-JOB', { exact: true }).waitFor();
  assert.match(await text(), /Green.*Red/); assert.doesNotMatch(await text(), /Black Rework/);
  assert.match(await page.locator('#bindingNote').textContent(), /Green.*Red/);
  // A stage response that finishes after switching must not restore Black QR text.
  holdPrint = true; await rework().click(); await enter('PRINT-LATE'); await until(() => !!printReply);
  await normal().click();
  const printed = page.waitForResponse((r) => r.url().endsWith('/api/print') && r.request().postDataJSON().jtcNo === 'PRINT-LATE');
  printReply(); printReply = null; holdPrint = false; await printed; await frame();
  assert.match(await text(), /Green.*Red/); assert.doesNotMatch(await text(), /Black Rework/);
  // A late queue read must not put Rework rows into the Normal binding panel.
  holdBinding = true; await rework().click(); await until(() => bindingReplies.length > 0);
  await normal().click(); await page.locator('#bindingList').getByText('NORMAL-JOB', { exact: true }).waitFor();
  const lateBinding = page.waitForResponse((r) => r.url().includes('/api/binding?location=rework'));
  holdBinding = false; for (const reply of bindingReplies.splice(0)) reply(); await lateBinding; await frame();
  assert.match(await page.locator('#bindingList').textContent(), /NORMAL-JOB/);
  assert.doesNotMatch(await page.locator('#bindingList').textContent(), /REWORK-JOB/);
  // A lookup begun in Rework must not stage its result into Normal after switching.
  holdLookup = true; await rework().click(); await enter('LOOKUP-LATE'); await until(() => !!lookupReply);
  const count = prints.length; await normal().click();
  const lookedUp = page.waitForResponse((r) => r.url().includes('/api/jtc?no=LOOKUP-LATE'));
  lookupReply(); lookupReply = null; holdLookup = false; await lookedUp; await frame();
  assert.equal(prints.length, count); assert.match(await text(), /Green.*Red/);
  const qaDir = process.env.FG_UI_QA_DIR;
  if (qaDir) { fs.mkdirSync(qaDir, { recursive: true }); await page.screenshot({ path: path.join(qaDir, 'normal-qr-message.png') }); }
  await rework().click(); await page.locator('#bindingList').getByText('REWORK-JOB', { exact: true }).waitFor();
  assert.match(await text(), /Black Rework/); assert.match(await page.locator('#bindingNote').textContent(), /Black Rework/);
  assert.doesNotMatch(await text(), /Green|Red/);
  if (qaDir) await page.screenshot({ path: path.join(qaDir, 'rework-qr-message.png') });
  await page.locator('#tabs').getByRole('tab', { name: 'Other label', exact: true }).click();
  assert.equal(await text(), ''); assert.equal(await page.locator('#bindingPanel').isHidden(), true);
  assert.equal(releases, 0); assert.deepEqual(errors, []);
});
