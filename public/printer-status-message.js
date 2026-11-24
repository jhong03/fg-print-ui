'use strict';

function printerStatusFeedback(report = {}, connectionType) {
  const state = String(report.status || '').toUpperCase();
  const problem = (text) => ({ text, error: true });
  if (state === 'OFFLINE' || report.online === false) return problem('Printer is offline. Check its power and connection.');
  if (state === 'PAUSED' || report.paused) return problem('Printing is paused. Resume the printer in Windows.');

  if (report.connected === false || report.hasError || report.reason || ['ERROR', 'UNREACHABLE'].includes(state)) {
    const raw = String(report.reason || '');
    // PowerShell CLIXML also contains progress and echoed script text. Classify
    // the first actual error, rather than matching words in the command itself.
    const xmlError = raw.match(/<S\b[^>]*\bS="Error"[^>]*>([\s\S]*?)<\/S>/i);
    const reason = (xmlError ? xmlError[1] : raw.replace(/^Command failed:[^\r\n]*/i, ''))
      .replace(/_x000[AD]_/gi, '\n').split(/\r?\n/).find((line) => line.trim()) || '';
    if (/configured windows printer not found/i.test(reason)) return problem('Printer not found in Windows. Check the Windows share name and printer installation.');
    if (/unknown printer|printer.*(?:removed|not configured)/i.test(reason)) return problem('Printer settings are no longer available. Reload settings and select the printer again.');
    if (/printer.*disabled/i.test(reason)) return problem('This printer is disabled. Enable it in Printer settings.');
    if (/management.*(?:token|authorization)|cannot access print-agent|management authorization/i.test(reason)) return problem('Cannot access print-agent. Check the terminal connection and restart the app.');
    if (/print-agent.*(?:unreachable|unavailable)|failed to fetch|fetch failed/i.test(reason)) return problem('Print-agent is unavailable. Check the terminal connection and restart the app.');
    if (/access.*denied|unauthorized|eacces|eperm/i.test(reason)) return problem('Printer access was denied. Check Windows printer permissions.');
    if (/timed?\s*out|timeout|etimedout|aborterror/i.test(reason)) return problem('Printer check timed out. Check the printer connection and try again.');
    if (/enotfound|eai_again|getaddrinfo|host.*not found|name.*(?:not.*resolved|unknown)/i.test(reason)) return problem('Printer address could not be found. Check its IP address or hostname.');
    if (/econnrefused|connection.*refused/i.test(reason)) return problem('Printer connection was refused. Check the IP address and TCP port.');
    if (/econnreset|epipe|connection.*(?:reset|closed|interrupted)/i.test(reason)) return problem('Printer connection was interrupted. Check the connection and try again.');
    if (/ehostunreach|enetunreach|unreachable|no route to host/i.test(reason)) return problem('Printer cannot be reached. Check its power and network connection.');
    if (/spooler|print spooler|rpc server.*unavailable/i.test(reason)) return problem('Windows printing service is unavailable. Check the Windows print queue or restart the service.');
    if (report.hasError && !raw) return problem('The printer is reporting a problem. Check its display and Windows print queue.');
    return problem(connectionType === 'windows' || report.spoolerSupported
      ? 'Unable to check the Windows printer. Check the share name, printer connection and Windows print queue.'
      : 'Unable to check the printer. Check its address, port and connection, then try again.');
  }
  if (state === 'READY') {
    const queue = Number.isInteger(report.queueDepth) && report.queueDepth >= 0 ? report.queueDepth + ' spool jobs' : 'Windows print queue is available';
    return { text: 'READY · ' + queue, error: false };
  }
  if (state === 'REACHABLE') return { text: 'REACHABLE · Network connection only; physical printer status is not confirmed.', error: false };
  return problem('Printer status could not be determined. Check the printer and try again.');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { printerStatusFeedback };
