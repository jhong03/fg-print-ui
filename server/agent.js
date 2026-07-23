/*
 * Client for a print-agent (an app running next to a printer, HTTP on :9000).
 * We hand it TSPL; it queues the job and drives the printer.
 *
 * Which agent + printer to use is passed per call, because one app can address
 * several destinations (see locations.js). Callers pass a resolved location; the
 * fields default to the .env agent for older single-printer setups.
 */

const DEFAULT_AGENT_URL = (process.env.AGENT_URL || 'http://localhost:9000').replace(/\/+$/, '');
const DEFAULT_PRINTER_TYPE = process.env.PRINTER_TYPE || 'tsc';

function agentUrlOf(loc) {
  return (loc && loc.agentUrl ? loc.agentUrl : DEFAULT_AGENT_URL).replace(/\/+$/, '');
}

function printerTypeOf(loc) {
  return (loc && loc.printerType) || DEFAULT_PRINTER_TYPE;
}

async function printLabel(tspl, loc) {
  const agentUrl = agentUrlOf(loc);
  let res;
  try {
    res = await fetch(`${agentUrl}/print-label`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerType: printerTypeOf(loc), labelData: tspl }),
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    throw new Error(`Print agent unreachable at ${agentUrl} (${err.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    throw new Error(body.error || `Agent print failed (${res.status})`);
  }
  return body; // { success, jobId }
}

async function jobStatus(jobId, loc) {
  const agentUrl = agentUrlOf(loc);
  const res = await fetch(`${agentUrl}/print/status/${encodeURIComponent(jobId)}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Agent status ${res.status}`);
  return res.json();
}

async function printerStatus(loc) {
  const agentUrl = agentUrlOf(loc);
  const res = await fetch(`${agentUrl}/printer/status`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Agent status ${res.status}`);
  return res.json();
}

module.exports = { printLabel, jobStatus, printerStatus, DEFAULT_AGENT_URL, DEFAULT_PRINTER_TYPE };
