// Firefox build: takes dist/ (npm run build) and writes dist-firefox/ and
// headerwise-firefox-<version>.zip. The code is the same; only the manifest differs:
// - Firefox has no extension service workers, so the background runs as an
//   event page (background.scripts, type module);
// - AMO needs an add-on id and a data collection declaration ("none"), which
//   Firefox understands from version 140.
//   npm run build && node scripts/firefox.mjs
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

export const GECKO_ID = 'headerwise@protemir.github.io';

export function firefoxManifest(chrome) {
  const m = structuredClone(chrome);
  m.background = { scripts: [chrome.background.service_worker], type: 'module' };
  delete m.minimum_chrome_version;
  m.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
  };
  return m;
}

// --- a small zip writer (stored paths use "/", as the format requires)
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0x00210000, 10); // fixed date (1980-01-01): the same input gives the same zip
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(0x00210000, 12); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(packed.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

function listFiles(dir) {
  return readdirSync(dir).flatMap(f => (statSync(join(dir, f)).isDirectory() ? listFiles(join(dir, f)) : [join(dir, f)]));
}

if (import.meta.url === `file:///${resolve(process.argv[1]).replace(/\\/g, '/')}` || process.argv[1]?.endsWith('firefox.mjs')) {
  const dist = resolve('dist');
  const out = resolve('dist-firefox');
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error('dist/ not found, run npm run build first');
  rmSync(out, { recursive: true, force: true });
  cpSync(dist, out, { recursive: true });
  const manifest = firefoxManifest(JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const files = listFiles(out).sort().map(f => ({ name: relative(out, f).split('\\').join('/'), data: readFileSync(f) }));
  const file = `headerwise-firefox-${manifest.version}.zip`;
  writeFileSync(file, zip(files));
  console.log(`${file}: ${files.length} files`);
}
