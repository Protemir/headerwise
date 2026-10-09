// Draws the extension icons into public/icons/ with nothing but Node.
// Run: node scripts/icons.mjs
// Shapes are described on a 128x128 grid and rasterised with 8x8 supersampling.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const OUT = new URL('../public/icons/', import.meta.url);

const TOP = [59, 130, 246]; // #3b82f6
const BOTTOM = [29, 78, 216]; // #1d4ed8
const WHITE = [255, 255, 255];

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// "H" whose crossbar runs out to the right as an arrow: a header on its way out.
function inGlyph(x, y) {
  if (inRoundRect(x, y, 30, 28, 50, 100, 4)) return true; // left stem
  if (inRoundRect(x, y, 72, 28, 92, 100, 4)) return true; // right stem
  if (inRoundRect(x, y, 40, 55, 96, 73, 2)) return true; // crossbar
  // arrow head, tip at x=110
  const dx = x - 92;
  return dx >= 0 && dx <= 18 && Math.abs(y - 64) <= 20 * (1 - dx / 18);
}

// Chrome Web Store wants the 128px artwork at 96x96 with 16px of transparent padding.
const padding = size => (size === 128 ? 16 : 0);

function pixel(px, py, size) {
  const n = 8;
  const pad = padding(size);
  const inner = size - 2 * pad;
  let bg = 0, fg = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = ((px - pad + (i + 0.5) / n) * 128) / inner;
      const y = ((py - pad + (j + 0.5) / n) * 128) / inner;
      if (!inRoundRect(x, y, 2, 2, 126, 126, 26)) continue;
      if (inGlyph(x, y)) fg++;
      else bg++;
    }
  }
  const t = Math.min(Math.max((py - pad + 0.5) / inner, 0), 1);
  const base = TOP.map((c, k) => c + (BOTTOM[k] - c) * t);
  const a = (bg + fg) / (n * n);
  if (a === 0) return [0, 0, 0, 0];
  const w = fg / (bg + fg);
  const rgb = base.map((c, k) => Math.round(c + (WHITE[k] - c) * w));
  return [...rgb, Math.round(a * 255)];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(pixel(x, y, size), row + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  writeFileSync(new URL(`icon-${size}.png`, OUT), png(size));
  console.log(`icon-${size}.png`);
}
