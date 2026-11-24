'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { printerStatusFeedback } = require('../public/printer-status-message');

test('printer status failures give a useful direction without printing technical details', () => {
  const cases = [
    ['Configured Windows printer not found', /not found in Windows.*share name/],
    ['Access is denied: C:\\private\\printer.ps1', /access was denied.*permissions/],
    ['connect ETIMEDOUT 192.168.1.88:9100', /timed out.*connection/],
    ['getaddrinfo ENOTFOUND internal-printer', /address could not be found.*hostname/],
    ['connect ECONNREFUSED 192.168.1.88:9100', /connection was refused.*TCP port/],
    ['connect EHOSTUNREACH 192.168.1.88:9100', /cannot be reached.*network/],
    ['read ECONNRESET private-details', /connection was interrupted/],
    ['Print-agent is unreachable at http://private:9000.', /Print-agent is unavailable/],
    ['Print-agent management token is empty', /Cannot access print-agent/],
    ['The print spooler service is not running', /Windows printing service is unavailable/],
    ['Unknown printer: private-id', /settings are no longer available/],
  ];
  for (const [reason, expected] of cases) {
    const result = printerStatusFeedback({ status: 'ERROR', connected: false, reason }, 'windows');
    assert.equal(result.error, true); assert.match(result.text, expected);
    assert.doesNotMatch(result.text, /private|192\.168|9100|ETIMEDOUT|ENOTFOUND|ECONN|EHOST|\.ps1/);
  }
  const unknown = printerStatusFeedback({ status: 'ERROR', reason: 'Command failed: powershell.exe -EncodedCommand ABCDEFG\n#< CLIXML\n<Objs>private details</Objs>', spoolerSupported: true });
  assert.match(unknown.text, /Unable to check the Windows printer/);
  assert.doesNotMatch(unknown.text, /powershell|ABCDEFG|CLIXML|private|Network reachability/);
});

test('PowerShell errors are classified from error records, ignoring script echoes and progress', () => {
  const prefix = 'Command failed: powershell.exe -EncodedCommand LONGBASE64\n#< CLIXML\n<Objs><Obj><S N="Record">if (-not $printer) { throw "Configured Windows printer not found" }</S></Obj>';
  for (const [error, expected] of [['Access is denied', /permissions/], ['Configured Windows printer not found', /share name/]]) {
    const result = printerStatusFeedback({ status: 'ERROR', connected: false,
      reason: prefix + '<S S="Error">' + error + '_x000D__x000A_</S><S S="Error">At line:3</S></Objs>' }, 'windows');
    assert.match(result.text, expected); assert.doesNotMatch(result.text, /EncodedCommand|CLIXML|At line/);
  }
});

test('offline, paused, healthy and unknown states use controlled messages', () => {
  assert.match(printerStatusFeedback({ status: 'OFFLINE' }).text, /offline.*power/);
  assert.match(printerStatusFeedback({ status: 'PAUSED' }).text, /paused.*Resume/);
  assert.deepEqual(printerStatusFeedback({ status: 'READY', connected: true, queueDepth: 2 }), { text: 'READY · 2 spool jobs', error: false });
  assert.equal(printerStatusFeedback({ status: 'REACHABLE', connected: true }).error, false);
  assert.match(printerStatusFeedback({ status: 'REACHABLE', connected: true }).text, /physical printer status is not confirmed/);
  assert.doesNotMatch(printerStatusFeedback({ status: 'private error dump' }).text, /private/);
  assert.doesNotMatch(printerStatusFeedback({ status: 'READY', queueDepth: 'private error dump' }).text, /private/);
});
