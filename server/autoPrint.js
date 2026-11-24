'use strict';
const { fileFor } = require('./localStore');
const { AutoPrintSettings } = require('./autoPrintSettings');
const { AutoPrintWatcher } = require('./autoPrintWatcher');
module.exports = new AutoPrintWatcher({
  settings: new AutoPrintSettings(fileFor('auto-print-settings.json')),
  file: fileFor('auto-print-state.json'),
  db: require('./db'), locations: require('./locations'),
  printQueue: require('./printQueue'), bindingQueue: require('./bindingQueue'),
});
