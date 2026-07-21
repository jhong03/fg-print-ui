/*
 * Client for the local print-agent (runs on the same terminal, HTTP on :9000).
 * We hand it TSPL; it queues the job and drives the TSC printer.
 */

const AGENT_URL = (process.env.AGENT_URL || 'http://localhost:9000').replace(/\/+$/, '');
const PRINTER_TYPE = process.env.PRINTER_TYPE || 'tsc';

async function printLabel(tspl) {
  let res;
  try {
    res = await fetch(`${AGENT_URL}/print-label`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerType: PRINTER_TYPE, labelData: tspl }),
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    throw new Error(`Print agent unreachable at ${AGENT_URL} (${err.message})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    throw new Error(body.error || `Agent print failed (${res.status})`);
  }
  return body; // { success, jobId }
}

async function jobStatus(jobId) {
  const res = await fetch(`${AGENT_URL}/print/status/${encodeURIComponent(jobId)}`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Agent status ${res.status}`);
  return res.json();
}

async function printerStatus() {
  const res = await fetch(`${AGENT_URL}/printer/status`, {
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`Agent status ${res.status}`);
  return res.json();
}

module.exports = { printLabel, jobStatus, printerStatus, AGENT_URL, PRINTER_TYPE };
