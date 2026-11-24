'use strict';
const fs = require('node:fs');
const path = require('node:path');
const agent = path.resolve(process.env.PRINT_AGENT_SOURCE || path.join(__dirname, '..', '..', '..', 'print-agent'));
const sharp = require(path.join(agent, 'node_modules', 'sharp'));

async function buildIcon() {
  const dir = path.join(__dirname, 'assets');
  const svg = fs.readFileSync(path.join(dir, 'label-printer.svg'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map((size) => sharp(svg).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let i = 0; i < sizes.length; i++) {
    const entry = 6 + i * 16;
    header[entry] = header[entry + 1] = sizes[i] === 256 ? 0 : sizes[i];
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  }
  fs.writeFileSync(path.join(dir, 'label-printer.ico'), Buffer.concat([header, ...images]));
  fs.writeFileSync(path.join(dir, 'label-printer.png'), images.at(-1));
}
if (require.main === module) buildIcon().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { buildIcon };
