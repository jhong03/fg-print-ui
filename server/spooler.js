/*
 * Clears the LOCAL Windows print spooler for one printer.
 *
 * Why the queue needs this: once the agent copies a label to the Windows
 * spooler, Windows owns it — a powered-off printer holds it and prints it the
 * instant it comes back, before anyone clicks Resume. To honour "nothing prints
 * until Resume", the queue pulls that label back OUT of the spooler when it
 * pauses, then re-sends it on Resume.
 *
 * This only works when the printer's spooler is on THIS machine (i.e. the agent
 * is local, which is the normal single-terminal setup). It shells out to
 * PowerShell, so it is a Windows-only no-op elsewhere. Single-quoted PS only —
 * no double quotes — so it survives the `-Command "..."` wrapper.
 */

const { exec } = require('child_process');

function clear(printerName) {
  return new Promise((resolve) => {
    if (!printerName || process.platform !== 'win32') return resolve(false);
    const name = String(printerName).replace(/'/g, "''"); // PS single-quote escape
    const ps = `Get-PrintJob -PrinterName '${name}' -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue`;
    exec(`powershell -NoProfile -Command "${ps}"`, { timeout: 8000 }, (err) => resolve(!err));
  });
}

module.exports = { clear };
