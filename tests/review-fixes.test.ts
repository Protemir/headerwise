import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { importModHeader } from '../src/core/import-modheader.ts';
import { importRequestly } from '../src/core/import-other.ts';
import { exportProfiles, importProfiles } from '../src/core/export.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import { activeHeaderCount, isSecret, type Profile } from '../src/core/model.ts';
import { parsePasted } from '../src/core/paste.ts';

// Found in a review before 1.1.0; each of these once did the wrong thing.

const prof = (over: Partial<Profile>): Profile => ({ id: 'p', title: 'P', enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });

describe('fixes from the 1.1.0 review', () => {
  it('a ModHeader redirect with a number for its target imports as text, and rules still build', () => {
    const { profiles } = importModHeader(JSON.stringify([{ title: 'R', urlReplacements: [{ name: 'localhost:8080', value: 3000 }] }]));
    expect(profiles[0].redirects![0].to).toBe('3000');
    expect(toDnrRules({ version: 1, paused: false, profiles }).rules.length).toBe(1);
  });

  it('a header left empty on purpose stays empty, and is still sent', () => {
    const p = prof({ requestHeaders: [{ id: 'c', enabled: true, name: 'Cookie', value: '', op: 'set' }] });
    const back = importProfiles(exportProfiles([p])).profiles[0].requestHeaders[0];
    expect([back.value, back.secret, back.enabled]).toEqual(['', undefined, true]);
    expect(JSON.stringify(toDnrRules({ version: 1, paused: false, profiles: [p] }).rules).includes('"Cookie"')).toBe(true);
  });

  it('a profile on for a while exports switched off', () => {
    const p = prof({ offAt: Date.now() + 60_000 });
    expect(JSON.parse(exportProfiles([p])).profiles[0].enabled).toBe(false);
  });

  it('headers about credentials are not secrets; values that are credentials are', () => {
    const s = (name: string, value = 'x') => isSecret({ name, value });
    expect([s('Access-Control-Allow-Credentials', 'true'), s('WWW-Authenticate', 'Basic realm="x"'), s('X-Plan', 'Basic tier'), s('X-Note', 'token expired')]).toEqual([false, false, false, false]);
    expect([s('X-Authorization'), s('X-Fwd', 'Bearer abcdefghijkl123'), s('X-Basic', 'Basic dXNlcjpwYXNz'), s('Authorization')]).toEqual([true, true, true, true]);
  });

  it('an empty secret is neither sent nor counted on the badge', () => {
    const p = prof({ requestHeaders: [{ id: 'a', enabled: true, name: 'Authorization', value: '', op: 'set', secret: true }, { id: 'b', enabled: true, name: 'X-A', value: '1', op: 'set' }] });
    const state = { version: 1 as const, paused: false, profiles: [p] };
    expect([activeHeaderCount(state), toDnrRules(state).lost]).toEqual([1, ['p']]);
  });

  it('a regex redirect whose $1 would make it match again is caught as a loop', () => {
    const p = prof({ redirects: [{ id: 'r', enabled: true, from: 'foo(\\d+)', to: 'foo$1x', isRegex: true }] });
    const out = toDnrRules({ version: 1, paused: false, profiles: [p] });
    expect([out.rules.length, /loop/.test(out.warnings.join(' '))]).toEqual([0, true]);
    // and a normal one isn't
    const ok = prof({ redirects: [{ id: 'r', enabled: true, from: '/v1/(.*)', to: '/v2/$1', isRegex: true }] });
    expect(toDnrRules({ version: 1, paused: false, profiles: [ok] }).rules.length).toBe(1);
  });

  it('cutting to Chrome\'s 5000 rules never keeps half a profile', () => {
    const profiles = Array.from({ length: 2501 }, (_, i) => prof({ id: `p${i}`, title: `P${i}`, requestHeaders: [{ id: 'h', enabled: true, name: 'X-A', value: '1', op: 'set' }], filters: [{ id: 'f', enabled: true, kind: 'exclude', pattern: '/never/', isRegex: true }] }));
    const out = toDnrRules({ version: 1, paused: false, profiles });
    const byPriority = new Map<number, string[]>();
    for (const r of out.rules) byPriority.set(r.priority, [...(byPriority.get(r.priority) ?? []), r.action.type]);
    expect([...byPriority.values()].every(kinds => kinds.length === 2)).toBe(true);
    expect(out.lost.length > 0).toBe(true);
  });

  it('a Requestly redirect rule whose pairs had different limits comes in switched off', () => {
    const rule = (domains: string[]) => ({ source: { key: 'Url', operator: 'Contains', value: 'api', filters: [{ pageDomains: domains }] }, destination: 'https://staging.example.com', destinationType: 'url' });
    const { profiles, warnings } = importRequestly([{ ruleType: 'Redirect', name: 'R', status: 'Active', objectType: 'rule', pairs: [rule(['one.com']), rule(['two.com'])] }]);
    expect([profiles[0].enabled, /different limits/.test(warnings.join(' '))]).toEqual([false, true]);
  });

  it('a pasted fetch with a non-text referrer doesn\'t break the paste', () => {
    expect(parsePasted(`fetch("https://a.example/", { "referrer": 5, "headers": { "x-a": "1" } })`).headers.some(h => h.name.toLowerCase() === 'x-a')).toBe(true);
  });
});
