'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const dataDir = path.resolve(process.env.FG_UI_DATA_DIR || path.join(__dirname, '..'));
fs.mkdirSync(dataDir, { recursive: true });
const fileFor = (name) => path.join(dataDir, name);
const revision = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
module.exports = { dataDir, fileFor, revision, atomicWrite, fail };
