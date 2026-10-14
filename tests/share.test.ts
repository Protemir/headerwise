import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { importShareLink, isShareLink, SHARE_PAGE, shareLink } from '../src/core/share.ts';
import type { Profile } from '../src/core/model.ts';

const profile = (): Profile => ({
  id: 'p1', title: 'Staging', enabled: true,
  requestHeaders: [
    { id: 'h1', enabled: true, name: 'X-Env', value: 'staging', op: 'set' },
    { id: 'h2', enabled: true, name: 'Authorization', value: 'Bearer secret-123', op: 'set' },
  ],
  responseHeaders: [{ id: 'h3', enabled: true, name: 'Access-Control-Allow-Origin', value: '*', op: 'set' }],
  filters: [{ id: 'f1', enabled: true, kind: 'include', pattern: '||example.com^', isRegex: false }],
  redirects: [{ id: 'r1', enabled: true, from: 'api.example.com', to: 'localhost:3000', isRegex: false }],
  tab: { id: 7, host: 'example.com' },
});

describe('share links', () => {
  it('carry the profiles, without secret values, ids or the tab they were bound to', async () => {
    const link = (await shareLink([profile()]))!;
    expect(link.startsWith(`${SHARE_PAGE}#1.`)).toBe(true);
    expect(/^[\w:/.#-]+$/.test(link)).toBe(true); // nothing a chat app would break
    const res = (await importShareLink(link))!;
    const [p] = res.profiles;
    expect([p.title, p.requestHeaders.map(h => [h.name, h.value]), p.responseHeaders[0].name, p.filters[0].pattern, p.redirects![0].to])
      .toEqual(['Staging', [['X-Env', 'staging'], ['Authorization', '']], 'Access-Control-Allow-Origin', '||example.com^', 'localhost:3000']);
    expect(p.tab).toBe(undefined);
    expect(p.id === 'p1' || p.requestHeaders[0].id === 'h1').toBe(false);
  });

  it('bring profiles in switched off, and say so', async () => {
    const res = (await importShareLink((await shareLink([profile()]))!))!;
    expect(res.profiles[0].enabled).toBe(false);
    // the empty secret is switched off too, as with any export without secrets
    expect(res.profiles[0].requestHeaders[1].enabled).toBe(false);
    expect(res.warnings[0]).toMatch(/switched off: check their headers and redirects/);
  });

  it('are found in pasted text, and nothing else is taken for one', async () => {
    const link = (await shareLink([profile()]))!;
    expect([isShareLink(link), isShareLink(`  ${link}\n`), isShareLink(link.replace(SHARE_PAGE, 'http://localhost:8787/headerwise/share.html'))]).toEqual([true, true, true]);
    expect([isShareLink('[{"title":"x"}]'), isShareLink('https://modheader.com/p/abc'), isShareLink(`${SHARE_PAGE}#2.abc`)]).toEqual([false, false, false]);
    // as pasted from a chat
    for (const text of [`See: ${link}`, `${link} thanks`, `<${link}>`, `(${link}).`]) {
      expect((await importShareLink(text))!.profiles.length).toBe(1);
    }
    expect(await importShareLink('[]')).toBe(undefined);
  });

  it('a damaged or cut link says so instead of importing half', async () => {
    const link = (await shareLink([profile()]))!;
    for (const bad of [link.slice(0, -20), `${SHARE_PAGE}#1.`, `${SHARE_PAGE}#1.AAAA`]) {
      const res = (await importShareLink(bad))!;
      expect([res.profiles.length, res.warnings[0]]).toEqual([0, 'This share link is damaged or cut off. Ask for it again, or for an exported file.']);
    }
  });

  it('profiles too big for a link are refused when it is made, not when it is opened', async () => {
    const many = Array.from({ length: 3 }, () => ({ ...profile(), title: 'x'.repeat(3_000_000) }));
    expect(await shareLink(many)).toBe(undefined);
  });

  it('values that look like credentials stay out too, whatever the header is called', async () => {
    const p = profile();
    p.requestHeaders = [
      { id: 'a', enabled: true, name: 'X-Authorization', value: 'abc123', op: 'set' },
      { id: 'b', enabled: true, name: 'X-Forwarded-User', value: 'Bearer abc.def', op: 'set' },
      { id: 'c', enabled: true, name: 'X-Debug', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2ln', op: 'set' },
      { id: 'd', enabled: true, name: 'X-Author', value: 'ann', op: 'set' },
    ];
    const res = (await importShareLink((await shareLink([p]))!))!;
    expect(res.profiles[0].requestHeaders.map(h => h.value)).toEqual(['', '', '', 'ann']);
  });
});
