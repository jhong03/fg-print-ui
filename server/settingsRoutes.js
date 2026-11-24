'use strict';
const { randomUUID } = require('node:crypto');
const { fail } = require('./localStore');
const { localAgentUrl } = require('./printerSettings');
const { validateLocations } = require('./locationConfig');
const { isDeepStrictEqual } = require('node:util');

function localSettingsOnly(req, res, next) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.status(403).json({ error: 'Printer settings are available only on this computer.' });
  let host;
  try { host = new URL('http://' + req.headers.host); } catch { return res.status(403).json({ error: 'Invalid local host' }); }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) || req.headers['x-print-ui-settings'] !== '1') return res.status(403).json({ error: 'Open Printer settings from the local app.' });
  if ((req.headers.origin && req.headers.origin !== host.origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return res.status(403).json({ error: 'Settings requests must come from this app.' });
  next();
}

function registerSettings(app, { settings, agent, locations, queue, bindingQueue, autoPrint, db }) {
  const activeStockLocations = async () => {
    if (!db?.getStockLocations) throw fail('Stock locations are not available for this database.', 503);
    try { return await db.getStockLocations(); }
    catch { throw fail('Cannot load active stock locations. Check the database connection and try again.', 503); }
  };
  const url = () => settings.read().agentUrl || agent.DEFAULT_AGENT_URL;
  const call = (endpoint, options) => agent.management(endpoint, options, localAgentUrl(url()));
  const localPending = () => queue.pendingJobs().filter((job) => {
    try {
      const target = new URL(localAgentUrl(job.target?.agentUrl));
      const current = new URL(localAgentUrl(url()));
      return (target.port || '80') === (current.port || '80');
    } catch { return false; }
  });
  const route = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };
  const write = (fn) => route((req, res) => queue.withSettingsLock
    ? queue.withSettingsLock(() => fn(req, res)) : fn(req, res));
  app.use('/api/settings', localSettingsOnly);
  app.get('/api/settings/stock-locations', route(async (req, res) => {
    res.json({ locations: await activeStockLocations() });
  }));
  app.get('/api/settings/auto-print', route((req, res) => res.json(autoPrint.configuration())));
  app.put('/api/settings/auto-print', route(async (req, res) => {
    await autoPrint.configure(req.body?.config, req.body?.revision);
    res.json(autoPrint.configuration());
  }));
  app.get('/api/settings/locations', route((req, res) => {
    res.json({ ...locations.configuration.read(), defaults: { ...locations.envDefaults(), barcodeNudge: Number(process.env.BARCODE_NUDGE_DOTS) || 0 } });
  }));
  app.put('/api/settings/locations', write(async (req, res) => {
    const before = locations.configuration.read();
    const next = validateLocations(req.body?.locations);
    autoPrint?.validateLocations(next.map((loc) => locations.resolveEntry(loc, locations.envDefaults())));
    const byId = new Map(next.map((l) => [l.id, l]));
    const bindings = bindingQueue?.list() || [];
    const pending = queue.pendingJobs();
    for (const old of before.locations) {
      const replacement = byId.get(old.id);
      const changed = !replacement || !isDeepStrictEqual(locations.resolveEntry(old, locations.envDefaults()), locations.resolveEntry(replacement, locations.envDefaults()));
      if (!replacement && pending.some((job) => job.location === old.id)) throw fail('Finish or clear queued prints before removing ' + old.name + '.', 409);
      if (changed && bindings.some((job) => job.location === old.id)) throw fail('Finish and clear the QR binding list for ' + old.name + ' before changing this label.', 409);
    }
    // Existing filters survive unavailable/inactive rows; new assignments must be active.
    const oldById = new Map(before.locations.map((loc) => [loc.id, loc]));
    const changedStockLocations = next.filter((loc) => loc.toLocation != null && loc.toLocation !== oldById.get(loc.id)?.toLocation);
    if (changedStockLocations.length) {
      const activeIds = new Set((await activeStockLocations()).map((loc) => loc.id));
      for (const loc of changedStockLocations) {
        if (!activeIds.has(loc.toLocation)) throw fail(loc.name + ': choose an active stock location from the database list, or Any location. Refresh locations and try again.');
      }
    }
    const saved = locations.configuration.save(next, req.body?.revision);
    locations.invalidate();
    res.json({ ...saved, defaults: { ...locations.envDefaults(), barcodeNudge: Number(process.env.BARCODE_NUDGE_DOTS) || 0 } });
  }));
  app.get('/api/settings', route(async (req, res) => {
    let agentState = null, agentError = null;
    try { agentState = await call('/config'); } catch (e) { agentError = e.message; }
    const routing = settings.read();
    res.json({ routing: { ...routing, agentUrl: url() }, agentState, agentError,
      locations: locations.list().map((l) => ({ id: l.id, name: l.name, group: l.group, printerId: l.printerId || null, localPrinterSettings: l.localPrinterSettings !== false })) });
  }));
  app.put('/api/settings/connection', write(async (req, res) => {
    const agentUrl = localAgentUrl(req.body?.agentUrl);
    if (localPending().length && agentUrl !== url()) throw fail('Finish or clear pending jobs before changing the agent address.', 409);
    await agent.management('/config', {}, agentUrl); // verify before switching the local app
    const current = settings.read();
    res.json(settings.save({ agentUrl, assignments: current.assignments }, req.body?.revision));
  }));
  app.put('/api/settings/visibility', route((req, res) => {
    const hiddenGroups = req.body?.hiddenGroups;
    const allLocations = locations.list();
    const known = new Set(allLocations.map((l) => l.group || 'Other'));
    const knownIds = new Set(allLocations.map((l) => l.id));
    if (!Array.isArray(hiddenGroups) || hiddenGroups.some((group) => typeof group !== 'string' || !known.has(group))) throw fail('Choose label groups from the available list.');
    const current = settings.read();
    const hiddenLocations = req.body.hiddenLocations ?? current.hiddenLocations;
    if (!Array.isArray(hiddenLocations) || (req.body.hiddenLocations !== undefined
      && hiddenLocations.some((id) => typeof id !== 'string' || !knownIds.has(id)))) throw fail('Choose labels from the available list.');
    // Keep preferences for groups temporarily removed from locations.json.
    const retained = current.hiddenGroups.filter((group) => !known.has(group));
    const retainedLocations = current.hiddenLocations.filter((id) => !knownIds.has(id));
    res.json(settings.save({ agentUrl: current.agentUrl, assignments: current.assignments,
      hiddenGroups: [...retained, ...hiddenGroups], hiddenLocations: [...retainedLocations, ...hiddenLocations] }, req.body.revision));
  }));
  app.put('/api/settings/agent', write(async (req, res) => {
    const next = req.body?.config;
    if (!next || !Array.isArray(next.printers)) throw fail('Supply a printer list');
    const pending = localPending();
    const before = await call('/config');
    if (pending.some((j) => !j.target?.resolved)) {
      const redirected = next.defaultPrinterId !== before.config.defaultPrinterId || before.config.printers.some((old) => {
        const replacement = next.printers.find((p) => p.id === old.id);
        return !replacement || replacement.enabled !== old.enabled || replacement.protocol !== old.protocol
          || JSON.stringify(replacement.connection) !== JSON.stringify(old.connection);
      });
      if (redirected) throw fail('Resolve or clear queued jobs before redirecting existing printers.', 409);
    }
    if (pending.length && next.localHttpPort !== before.config.localHttpPort) throw fail('Finish pending jobs before changing the agent port.', 409);
    for (const job of pending) {
      if (!job.target?.resolved) continue;
      const p = next.printers.find((p) => p.id === job.target.printerId);
      if (!p || p.enabled === false || p.protocol !== job.target.printer.protocol || JSON.stringify(p.connection) !== JSON.stringify(job.target.printer.connection)) throw fail('A queued printer cannot be removed, disabled or redirected. Finish or clear its jobs first.', 409);
    }
    for (const id of Object.values(settings.read().assignments).filter(Boolean)) {
      if (!next.printers.some((p) => p.id === id && p.enabled !== false && p.protocol === 'tspl')) throw fail('Reassign label tabs before removing, disabling or changing an assigned printer.', 409);
    }
    res.json(await call('/config', { method: 'PUT', body: { config: next, revision: req.body.revision } }));
  }));
  app.put('/api/settings/assignments', write(async (req, res) => {
    const assignments = req.body?.assignments;
    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) throw fail('Invalid printer assignments');
    const registry = await call('/config');
    const known = new Map(locations.list().map((l) => [l.id, l]));
    for (const [id, printerId] of Object.entries(assignments)) {
      if (!known.has(id)) throw fail('Unknown label destination: ' + id);
      if (known.get(id).localPrinterSettings === false) throw fail('This destination uses a remote agent and cannot be assigned from local Settings.');
      if (printerId !== null && !registry.config.printers.some((p) => p.id === printerId && p.enabled && p.protocol === 'tspl')) throw fail('Assign label destinations to enabled TSPL printers.');
    }
    const current = settings.read();
    res.json(settings.save({ agentUrl: url(), assignments: { ...current.assignments, ...assignments } }, req.body.revision));
  }));
  app.get('/api/settings/printers/discover', route(async (req, res) => res.json(await call('/printers/discover'))));
  app.get('/api/settings/printers/:id/status', route(async (req, res) => res.json(await call('/printers/' + encodeURIComponent(req.params.id) + '/status'))));
  app.post('/api/settings/printers/:id/test', route(async (req, res) => {
    if (req.body?.confirm !== true) throw fail('Confirm the test print first.');
    res.json(await call('/printers/' + encodeURIComponent(req.params.id) + '/test', {
      method: 'POST', body: { confirm: true, submissionId: 'fgui-test:' + randomUUID() } }));
  }));
  app.get('/api/settings/jobs/:id', route(async (req, res) => res.json(await agent.jobStatus(req.params.id, { agentUrl: url() }))));
}

module.exports = { registerSettings, localSettingsOnly };
