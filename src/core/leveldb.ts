import { snappyDecompress } from './snappy.ts';

/*
 * Read-only LevelDB reader, enough to recover chrome.storage data from a folder
 * like "Local Extension Settings/<extension id>" without opening it with LevelDB.
 * It reads every write-ahead log (*.log) and sorted table (*.ldb, *.sst) and keeps,
 * for each key, the entry with the highest sequence number. MANIFEST is not
 * needed for that. Formats:
 * https://github.com/google/leveldb/blob/main/doc/log_format.md
 * https://github.com/google/leveldb/blob/main/doc/table_format.md
 */

export interface DbFile {
  name: string;
  data: Uint8Array;
}

interface Entry {
  seq: number;
  value: Uint8Array | null; // null = deleted
}

const LOG_BLOCK = 32768;
const TABLE_MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];

class Reader {
  pos = 0;
  readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  varint(): number {
    let result = 0;
    for (let shift = 0; ; shift += 7) {
      if (this.pos >= this.buf.length || shift > 63) throw new Error('leveldb: bad varint');
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
    }
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('leveldb: read past end');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  sliced(): Uint8Array {
    return this.bytes(this.varint());
  }
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** Physical records of a log file, reassembled into logical records. */
function* logRecords(data: Uint8Array): Generator<Uint8Array> {
  let pos = 0;
  let pending: Uint8Array[] | null = null;
  while (pos + 7 <= data.length) {
    const left = LOG_BLOCK - (pos % LOG_BLOCK);
    if (left < 7) { pos += left; continue; } // block trailer padding
    const length = data[pos + 4] | (data[pos + 5] << 8);
    const type = data[pos + 6];
    if (type === 0) { pos += left; continue; } // zeroed / preallocated space
    const start = pos + 7;
    if (start + length > data.length) break; // torn write at the end
    const fragment = data.subarray(start, start + length);
    pos = start + length;
    if (type === 1) { pending = null; yield fragment; } // FULL
    else if (type === 2) pending = [fragment]; // FIRST
    else if (type === 3) pending?.push(fragment); // MIDDLE
    else if (type === 4 && pending) { pending.push(fragment); yield concat(pending); pending = null; } // LAST
  }
}

function readLog(data: Uint8Array, put: (key: Uint8Array, e: Entry) => void): void {
  for (const record of logRecords(data)) {
    if (record.length < 12) continue;
    // WriteBatch: sequence (u64), count (u32), then tagged entries.
    const base = u32(record, 0) + u32(record, 4) * 2 ** 32;
    const count = u32(record, 8);
    const r = new Reader(record);
    r.pos = 12;
    try {
      for (let i = 0; i < count; i++) {
        const tag = r.bytes(1)[0];
        const key = r.sliced();
        if (tag === 1) put(key, { seq: base + i, value: r.sliced() });
        else if (tag === 0) put(key, { seq: base + i, value: null });
        else break;
      }
    } catch {
      // Truncated batch at the end of the log: keep what was read.
    }
  }
}

function blockHandle(r: Reader): { offset: number; size: number } {
  return { offset: r.varint(), size: r.varint() };
}

function readBlock(data: Uint8Array, h: { offset: number; size: number }): Uint8Array {
  const raw = data.subarray(h.offset, h.offset + h.size);
  const compression = data[h.offset + h.size];
  if (compression === 0) return raw;
  if (compression === 1) return snappyDecompress(raw);
  throw new Error(`leveldb: unsupported block compression ${compression}`);
}

function* blockEntries(block: Uint8Array): Generator<[Uint8Array, Uint8Array]> {
  const restarts = u32(block, block.length - 4);
  const end = block.length - 4 - restarts * 4;
  const r = new Reader(block.subarray(0, end));
  let key = new Uint8Array(0);
  while (r.pos < end) {
    const shared = r.varint();
    const unshared = r.varint();
    const valueLength = r.varint();
    key = concat([key.subarray(0, shared), r.bytes(unshared)]);
    yield [key, r.bytes(valueLength)];
  }
}

function readTable(data: Uint8Array, put: (key: Uint8Array, e: Entry) => void): void {
  if (data.length < 48) throw new Error('leveldb: table too short');
  const footer = data.subarray(data.length - 48);
  if (TABLE_MAGIC.some((b, i) => footer[40 + i] !== b)) throw new Error('leveldb: not a table file');
  const fr = new Reader(footer);
  blockHandle(fr); // metaindex, not needed
  const index = readBlock(data, blockHandle(fr));
  for (const [, handle] of blockEntries(index)) {
    for (const [internalKey, value] of blockEntries(readBlock(data, blockHandle(new Reader(handle))))) {
      // internal key = user key + 8 bytes: (sequence << 8) | type
      const n = internalKey.length - 8;
      if (n < 0) continue;
      const lo = u32(internalKey, n);
      const hi = u32(internalKey, n + 4);
      const type = lo & 0xff;
      const seq = hi * 2 ** 24 + (lo >>> 8);
      put(internalKey.subarray(0, n), { seq, value: type === 1 ? value : null });
    }
  }
}

export interface ReadResult {
  values: Map<string, string>;
  /** Files that could not be parsed, with the reason. */
  errors: string[];
}

/** Latest value of every live key, decoded as UTF-8. */
export function readLevelDb(files: DbFile[]): ReadResult {
  const latest = new Map<string, Entry>();
  const utf8 = new TextDecoder();
  const put = (key: Uint8Array, e: Entry) => {
    const k = utf8.decode(key);
    const old = latest.get(k);
    if (!old || e.seq >= old.seq) latest.set(k, e);
  };
  const errors: string[] = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    try {
      if (/^\d+\.log$/.test(name)) readLog(f.data, put);
      else if (/\.(ldb|sst)$/.test(name)) readTable(f.data, put);
    } catch (e) {
      errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const values = new Map<string, string>();
  for (const [k, e] of latest) if (e.value) values.set(k, utf8.decode(e.value));
  return { values, errors };
}
