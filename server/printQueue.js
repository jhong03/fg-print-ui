'use strict';
// print-ui owns operator queues and retry decisions. The agent only dispatches
// one accepted attempt and reports its result.
const { PrintQueue } = require('./queueManager');
const { fileFor } = require('./localStore');
module.exports = new PrintQueue({
  file: fileFor('print-jobs.json'),
  db: require('./db'),
  getTemplate: require('./mes').getTemplate,
  renderTspl: require('./label/render').renderTspl,
  mapRecordToFields: require('./label/mapRecord').mapRecordToFields,
  agent: require('./agent'),
  locations: require('./locations'),
  pollMs: Number(process.env.QUEUE_POLL_MS) || 1000,
  pollTimeoutMs: Number(process.env.QUEUE_POLL_TIMEOUT_MS) || 40000,
  drainTimeoutMs: Number(process.env.QUEUE_DRAIN_TIMEOUT_MS) || 12000,
  gapMs: Number(process.env.QUEUE_GAP_MS) || 400,
});
