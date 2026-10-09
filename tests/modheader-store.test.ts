import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect } from './expect.ts';
import { snappyDecompress } from '../src/core/snappy.ts';
import { readLevelDb, type DbFile } from '../src/core/leveldb.ts';
import { readModHeaderStore } from '../src/core/modheader-store.ts';
import { importModHeader } from '../src/core/import-modheader.ts';

// Real LevelDB folders written by Chrome 154 (chrome.storage.local of a test
// extension running tests/fixtures/leveldb-writer.js), gzipped file by file.
//   leveldb-log:  first() + second(): only a write-ahead log
//   leveldb-bulk: + bulk(): profiles end up in a snappy-compressed .ldb table
function fixture(name: string): DbFile[] {
  const dir = new URL(`./fixtures/${name}/`, import.meta.url);
  return readdirSync(dir).map(f => ({
    name: f.replace(/\.gz$/, ''),
    data: new Uint8Array(gunzipSync(readFileSync(new URL(f, dir)))),
  }));
}

const utf8 = new TextEncoder();
const bytes = (...b: number[]) => new Uint8Array(b);

describe('snappyDecompress', () => {
  it('handles literals and overlapping copies', () => {
    // length 11; literal "ab"; copy len 4 offset 2 (1-byte offset form); literal "c"; copy len 4 offset 1 (2-byte offset form)
    const out = snappyDecompress(bytes(11, 0x04, 0x61, 0x62, 0x01, 0x02, 0x00, 0x63, 0x0e, 0x01, 0x00));
    expect(new TextDecoder().decode(out)).toBe('abababccccc');
  });

  it('rejects broken input instead of returning garbage', () => {
    let threw = false;
    try { snappyDecompress(bytes(5, 0x01, 0x05)); } catch { threw = true; }
    expect(threw).toBe(true);
  });
});

describe('readLevelDb on real Chrome folders', () => {
  it('reads a log-only folder: last write wins, deleted keys stay deleted', () => {
    const { values, errors } = readLevelDb(fixture('leveldb-log'));
    expect(errors).toEqual([]);
    expect([...values.keys()].sort()).toEqual(['isPaused', 'profiles', 'selectedProfile']);
    expect(JSON.parse(values.get('profiles')!).map((p: { title: string }) => p.title)).toEqual(['Staging', 'Юникод ✓', 'Legacy']);
  });

  it('reads a folder with a snappy-compressed table plus a newer log', () => {
    const { values, errors } = readLevelDb(fixture('leveldb-bulk'));
    expect(errors).toEqual([]);
    expect(values.size).toBe(27); // 24 fillers + profiles, selectedProfile, isPaused
    for (let i = 0; i < 24; i++) expect(JSON.parse(values.get(`filler${i}`)!)).toHaveLength(400);
    expect(JSON.parse(values.get('profiles')!)).toHaveLength(3);
  });

  it('ignores files it does not understand and reports broken ones', () => {
    const { values, errors } = readLevelDb([
      { name: 'LOG', data: utf8.encode('text log') },
      { name: '000009.ldb', data: utf8.encode('not a table at all, but long enough to have a footer of 48 bytes....') },
    ]);
    expect(values.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/000009\.ldb: leveldb: not a table/);
  });
});

describe('readModHeaderStore', () => {
  it('finds the profiles and the selected one, and they import cleanly', () => {
    const { result } = readModHeaderStore(fixture('leveldb-bulk'));
    expect(result!.source).toBe('profiles');
    expect(result!.selected).toBe(1);
    const { profiles, warnings } = importModHeader(JSON.stringify(result!.profiles), { active: result!.selected });
    expect(warnings).toEqual([]);
    expect(profiles.map(p => [p.title, p.enabled])).toEqual([['Staging', false], ['Юникод ✓', true], ['Legacy', false]]);
    expect(profiles[0].requestHeaders.map(h => [h.name, h.op])).toEqual([['X-Env', 'set'], ['Origin', 'remove']]);
    expect(profiles[1].filters.map(f => [f.kind, f.pattern])).toEqual([['exclude', '.*/login.*']]);
    expect(profiles[2].requestHeaders[0].value).toBe('yes');
  });

  it('falls back to the newest backup snapshot (sync storage)', () => {
    const batch = (seq: number, entries: [string, string][]) => {
      const parts: number[] = [seq, 0, 0, 0, 0, 0, 0, 0, entries.length, 0, 0, 0];
      for (const [k, v] of entries) {
        const kb = utf8.encode(k), vb = utf8.encode(v);
        parts.push(1, kb.length, ...kb, vb.length, ...vb);
      }
      const payload = bytes(...parts);
      return new Uint8Array([0, 0, 0, 0, payload.length & 0xff, payload.length >> 8, 1, ...payload]);
    };
    const snap = (title: string) => JSON.stringify([{ title, headers: [{ name: 'X', value: '1' }] }]);
    const { result } = readModHeaderStore([{ name: '000001.log', data: batch(1, [['1700000000000', snap('older')], ['1760000000000', snap('newer')]]) }]);
    expect((result!.profiles[0] as { title: string }).title).toBe('newer');
    expect(result!.source).toBe('backup from 2025-10-09');
  });

  it('returns null for a folder without ModHeader data', () => {
    expect(readModHeaderStore([]).result).toBe(null);
  });
});
