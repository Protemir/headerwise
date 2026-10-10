import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { parsePasted } from '../src/core/paste.ts';
import { importModHeader } from '../src/core/import-modheader.ts';

const named = (r: { headers: { name: string; value: string }[] }) => Object.fromEntries(r.headers.map(h => [h.name, h.value]));

describe('paste written by hand', () => {
  it('fetch with JS object syntax', () => {
    const r = parsePasted(`fetch('https://x.com/a', { headers: { Authorization: 'Bearer abc', 'X-Two': "2", "x-three": \`3\` } })`);
    expect(r.url).toBe('https://x.com/a');
    expect(named(r)).toEqual({ Authorization: 'Bearer abc', 'X-Two': '2', 'x-three': '3' });
  });

  it('PowerShell on one line, bare keys, single quotes', () => {
    expect(named(parsePasted(`Invoke-WebRequest -Uri "https://x.com" -Headers @{"Authorization"="Bearer abc"}`))).toEqual({ Authorization: 'Bearer abc' });
    expect(named(parsePasted(`Invoke-RestMethod -Uri 'https://x.com' -Headers @{ Authorization = 'Bearer it''s'; 'X-A' = "1" }`))).toEqual({ Authorization: "Bearer it's", 'X-A': '1' });
  });

  it('curl -u with non-Latin credentials is UTF-8, like curl sends it', () => {
    const r = parsePasted(`curl 'https://x.com' -u 'юзер:pass'`);
    expect(named(r).Authorization).toBe(`Basic ${Buffer.from('юзер:pass').toString('base64')}`);
  });

  it('plain lines: a URL line is not a header, "Name:" takes the next line only if it is a value', () => {
    expect(named(parsePasted('https://example.com/api\nX-A: 1'))).toEqual({ 'X-A': '1' });
    expect(named(parsePasted('X-Empty:\nX-Other:1'))).toEqual({ 'X-Empty': '', 'X-Other': '1' });
    expect(named(parsePasted('Referer:\nhttps://example.com/page\nX-B:\n2'))).toEqual({ Referer: 'https://example.com/page', 'X-B': '2' });
  });
});

describe('paste of a huge text', () => {
  it('stays fast: the paste box parses on every keystroke', () => {
    const texts = [
      `fetch('x', { headers: { ${'a-'.repeat(50000)} } })`,
      `Invoke-WebRequest -Uri "x" -Headers @{ ${'a'.repeat(50000)} }`,
      `Invoke-WebRequest -Uri "x" -Headers @{ ${"'".repeat(50000)} }`,
      'X-A: 1\n'.repeat(15000),
      `curl 'x' ${"-H 'a: b' ".repeat(10000)}`,
    ];
    for (const t of texts) {
      const start = performance.now();
      parsePasted(t);
      expect(performance.now() - start < 300).toBe(true);
    }
  });
});

describe('ModHeader files from the wild', () => {
  it('does not crash on nulls, numbers and single values where lists belong', () => {
    const r = importModHeader(JSON.stringify({ profiles: [null, {
      title: 5,
      headers: [null, { name: 'X-A', value: 1, enabled: true }],
      filters: [null],
      setCookieHeaders: [{ name: 'c', value: 'v', sameSite: 1 }],
      resourceFilters: [{ resourceType: 'xmlhttprequest' }],
      requestMethodFilters: [{ methods: 'POST' }],
    }] }));
    const p = r.profiles[0];
    expect(r.profiles).toHaveLength(1);
    expect([p.title, p.requestHeaders[0].value, p.resourceTypes, p.requestMethods]).toEqual(['5', '1', ['xmlhttprequest'], ['post']]);
    expect(p.responseHeaders[0].value).toBe('c=v; SameSite=1');
  });

  it('"append" on a header Chrome cannot append to becomes "set", and says so', () => {
    const r = importModHeader(JSON.stringify([{ title: 'T', headers: [{ name: 'X-Custom', value: 'v', appendMode: 'append' }, { name: 'Accept-Language', value: 'de', appendMode: 'append' }] }]));
    expect(r.profiles[0].requestHeaders.map(h => [h.name, h.op])).toEqual([['X-Custom', 'set'], ['Accept-Language', 'append']]);
    expect(r.warnings.some(w => /can't append to X-Custom, so it is set instead/.test(w))).toBe(true);
  });

  it('a URL replacement with nothing to replace with cuts the text out', () => {
    const r = importModHeader(JSON.stringify([{ title: 'T', urlReplacements: [{ name: 'debug=1', value: '' }] }]));
    expect(r.profiles[0].redirects?.map(x => [x.from, x.to, x.enabled])).toEqual([['debug=1', '', true]]);
  });
});
