// Generates icons/icon{16,32,48,128}.png from local geometry (no image packages or remote assets):
// a rounded square split diagonally into two colours, with a download arrow into a tray.
// Run once with `node scripts/icons.mjs`; the PNGs are committed.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, crc]);
}
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
await mkdir(directory, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const stride = 1 + size * 4;
  const pixels = Buffer.alloc(stride * size);
  const samples = 4; // supersample for smooth edges
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const nx = (x + (sx + .5) / samples) / size, ny = (y + (sy + .5) / samples) / size;
      const inRound = Math.hypot(Math.max(.22 - nx, 0, nx - .78), Math.max(.22 - ny, 0, ny - .78)) <= .2;
      if (!inRound) continue;
      const shaft = nx > .44 && nx < .56 && ny > .2 && ny < .58;
      const head = ny > .4 && ny < .66 && Math.abs(nx - .5) < (.66 - ny) * 1.05;
      const tray = (ny > .72 && ny < .8 && nx > .24 && nx < .76) || (ny > .6 && ny < .8 && ((nx > .24 && nx < .32) || (nx > .68 && nx < .76)));
      const color = shaft || head || tray ? [255, 255, 255] : nx + ny < 1 ? [201, 100, 66] : [16, 133, 104];
      r += color[0]; g += color[1]; b += color[2]; a += 255;
    }
    const n = samples * samples, cover = a / n;
    const px = cover ? [Math.round(r / (a / 255)), Math.round(g / (a / 255)), Math.round(b / (a / 255)), Math.round(cover)] : [0, 0, 0, 0];
    pixels.set(px, y * stride + 1 + x * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  await writeFile(path.join(directory, `icon${size}.png`), png);
}
console.log('Wrote icons/icon{16,32,48,128}.png');
