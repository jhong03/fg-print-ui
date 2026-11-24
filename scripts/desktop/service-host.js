'use strict';
// Keep service lifecycle control separate from the two application repositories.
const path = require('node:path');
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 8000).unref();
  process.emit('SIGTERM');
}
process.on('message', (message) => { if (message === 'stop') stop(); });
process.on('disconnect', stop);
require(path.resolve(process.argv[2]));
