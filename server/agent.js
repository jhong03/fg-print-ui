'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fail } = require('./localStore');
const { localAgentUrl } = require('./printerSettings');

const DEFAULT_AGENT_URL = (process.env.AGENT_URL || 'http://localhost:9000').replace(/\/+$/, '');
const DEFAULT_PRINTER_TYPE = process.env.PRINTER_TYPE || 'tsc';
const agentUrlOf = (loc) => (loc?.agentUrl || DEFAULT_AGENT_URL).replace(/\/+$/, '');
const printerTypeOf = (loc) => loc?.printerType || DEFAULT_PRINTER_TYPE;
function keyFor(target) {
  const url = new URL(agentUrlOf(target));
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = '127.0.0.1';
  return 'printer-' + createHash('sha256').update(url.origin + '|' + (target.printerId || 'default')).digest('hex');
}
async function request(url, endpoint, { method = 'GET', body, management = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (management) {
    url = localAgentUrl(url);
    let token = process.env.AGENT_MANAGEMENT_TOKEN || process.env.PRINT_AGENT_MANAGEMENT_TOKEN;
    if (!token) {
      const tokenFile = process.env.AGENT_MANAGEMENT_TOKEN_FILE || path.join(
        process.env.PRINT_AGENT_DATA_DIR || path.resolve(__dirname, '..', '..', 'print-agent'), 'management-token');
      try { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
      catch { throw fail('Cannot access print-agent settings. Start the updated print-agent; if it is installed elsewhere, set AGENT_MANAGEMENT_TOKEN_FILE on this server.', 503); }
    }
    if (!token) throw fail('Print-agent management token is empty', 503);
    headers.Authorization = 'Bearer ' + token;
  }
  let response;
  try {
    response = await fetch(url + endpoint, { method, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(management ? 15000 : 6000), redirect: 'error' });
  } catch {
    throw fail('Print-agent is unreachable at ' + url + '. Check that it is running.', 503);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = fail(data.error || (management && response.status === 404
      ? 'Restart the updated print-agent to enable Printer settings.' : 'Print-agent request failed (' + response.status + ')'), response.status);
    error.rejected = true;
    throw error;
  }
  return data;
}
function management(endpoint, options = {}, url = DEFAULT_AGENT_URL) {
  return request(url, '/management' + endpoint, { ...options, management: true });
}
async function resolveTarget(loc) {
  const registry = await request(agentUrlOf(loc), '/local-config');
  if (!Array.isArray(registry.printers)) throw fail('Update print-agent before using printer Settings and client-controlled queues.', 409);
  const selected = loc.printerId
    ? registry.printers.find((p) => p.id === loc.printerId)
    : registry.printers.find((p) => p.id === registry.defaultPrinterId && p.protocol === 'tspl' && p.enabled)
      || registry.printers.find((p) => p.protocol === 'tspl' && p.enabled);
  if (!selected) throw fail('No compatible TSPL label printer is assigned. Open Printer settings.', 409);
  if (!selected.enabled) throw fail('The selected printer is disabled. Open Printer settings.', 409);
  if (selected.protocol !== 'tspl') throw fail('These labels require a TSPL printer. ESC/POS printers can be configured and tested, but cannot print these label templates.', 409);
  return { agentUrl: agentUrlOf(loc), printerId: selected.id, printerType: 'tsc',
    printerName: selected.name, printer: structuredClone(selected), resolved: true };
}
async function validateTarget(target) {
  const current = await resolveTarget(target);
  if (JSON.stringify(current.printer.connection) !== JSON.stringify(target.printer.connection)
      || current.printer.protocol !== target.printer.protocol) {
    throw fail('The queued printer connection changed. Review this job before retrying.', 409);
  }
}
async function printLabel(tspl, target, submissionId) {
  const data = await request(agentUrlOf(target), '/print-label', { method: 'POST',
    body: { printerId: target.printerId, printerType: 'tsc', format: 'tspl',
      labelData: tspl, retryOwner: 'client', submissionId } });
  if (!data.success || !data.jobId) throw fail('The agent did not confirm acceptance; check the job before retrying.', 502);
  return data;
}
async function jobStatus(jobId, target) {
  return request(agentUrlOf(target), '/print/status/' + encodeURIComponent(jobId));
}
async function printerStatus(target) {
  const query = target?.printerId ? '?printerId=' + encodeURIComponent(target.printerId)
    : '?printerType=' + encodeURIComponent(printerTypeOf(target));
  return request(agentUrlOf(target), '/printer/status' + query);
}
async function clearSpooler(target) {
  return management('/printers/' + encodeURIComponent(target.printerId) + '/clear-spooler',
    { method: 'POST', body: { confirm: true } }, agentUrlOf(target));
}
module.exports = { agentUrlOf, printerTypeOf, keyFor, resolveTarget, validateTarget, printLabel,
  jobStatus, printerStatus, clearSpooler, management, request, DEFAULT_AGENT_URL, DEFAULT_PRINTER_TYPE };
