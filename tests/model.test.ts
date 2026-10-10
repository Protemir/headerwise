import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { duplicateProfile, isSecret, maskValue, moveProfile, nextProfile, releaseTabs, statusTitle, type Profile, type State } from '../src/core/model.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import { tabReport } from '../src/core/explain.ts';

const p = (title: string, over: Partial<Profile> = {}): Profile => ({
  id: title, title, enabled: true,
  requestHeaders: [{ id: `${title}-h`, enabled: true, name: 'X-A', value: '1', op: 'set' }],
  responseHeaders: [], filters: [], ...over,
});

describe('secrets', () => {
  it('guesses secret headers by name, and an explicit flag wins', () => {
    for (const name of ['Authorization', 'cookie', 'X-Api-Key', 'x-api_key', 'X-Auth-Token', 'X-Session-Id', 'Proxy-Authorization', 'X-Client-Secret'])
      expect(isSecret({ name })).toBe(true);
    for (const name of ['Accept', 'User-Agent', 'X-Env', 'X-Forwarded-For', 'Origin'])
      expect(isSecret({ name })).toBe(false);
    expect(isSecret({ name: 'Authorization', secret: false })).toBe(false);
    expect(isSecret({ name: 'X-Env', secret: true })).toBe(true);
  });

  it('masks read-only values, keeping a short prefix', () => {
    expect(maskValue('Bearer eyJhbGciOiJIUzI1NiJ9')).toBe('Bear••••••••••••');
    expect(maskValue('abc')).toBe('•••');
  });
});

describe('only this tab', () => {
  const state = (): State => ({ version: 1, paused: false, profiles: [
    p('Global'),
    p('Tab', { tab: { id: 42, host: 'app.io' }, filters: [{ id: 'f', enabled: true, kind: 'exclude', pattern: '/login', isRegex: true }] }),
  ] });

  it('puts tabIds on the profile\'s header rules and its "never on" allow rules only', () => {
    const { rules } = toDnrRules(state());
    expect(rules.map(r => [r.action.type, r.condition.tabIds ?? null])).toEqual([
      ['modifyHeaders', null], ['modifyHeaders', [42]], ['allow', [42]],
    ]);
  });

  it('releases the binding of a closed tab, or all of them after a restart, and turns those profiles off', () => {
    const s = state();
    expect(releaseTabs(s, 7)).toBe(false);
    expect(releaseTabs(s, 42)).toBe(true);
    expect([s.profiles[1].tab, s.profiles[1].enabled, s.profiles[0].enabled]).toEqual([undefined, false, true]);
    const t = state();
    expect(releaseTabs(t)).toBe(true);
    expect(t.profiles[1].tab).toBe(undefined);
  });

  it('says "only in another tab" in other tabs', () => {
    const s = state();
    const { info } = toDnrRules(s);
    expect(tabReport(s, 'https://x.io/', [], info, 0, 7)[1].line).toEqual({ kind: 'other-tab', host: 'app.io' });
    expect(tabReport(s, 'https://app.io/', [], info, 0, 42)[1].line).toEqual({ kind: 'waiting' });
  });
});

describe('profile list helpers', () => {
  const state = (): State => ({ version: 1, paused: true, profiles: [p('A'), { ...p('B'), enabled: false }, { ...p('C'), enabled: false }] });

  it('duplicates with fresh ids, switched off, without a tab binding', () => {
    const src = p('Src', { tab: { id: 1, host: 'h' } });
    const copy = duplicateProfile(src);
    expect([copy.title, copy.enabled, copy.tab, copy.id === src.id, copy.requestHeaders[0].id === src.requestHeaders[0].id])
      .toEqual(['Src copy', false, undefined, false, false]);
    expect(copy.requestHeaders[0].name).toBe('X-A');
    expect(src.tab).toEqual({ id: 1, host: 'h' });
  });

  it('moves profiles and ignores out-of-range moves', () => {
    const s = state();
    moveProfile(s, 2, 0);
    expect(s.profiles.map(x => x.title)).toEqual(['C', 'A', 'B']);
    moveProfile(s, 0, 9);
    expect(s.profiles.map(x => x.title)).toEqual(['C', 'A', 'B']);
  });

  it('"next profile" turns on the next one only, wraps around and un-pauses', () => {
    const s = state();
    expect(nextProfile(s)).toBe('B');
    expect([s.paused, s.profiles.map(x => x.enabled)]).toEqual([false, [false, true, false]]);
    nextProfile(s);
    expect(nextProfile(s)).toBe('A');
    s.profiles.forEach(x => { x.enabled = false; });
    expect(nextProfile(s)).toBe('A');
  });

  it('switching by hand (hotkey, closed tab) drops timers, so none fires on the wrong profile later', () => {
    const s = state();
    s.profiles[0].offAt = 5000;
    s.profiles[0].tab = { id: 3, host: 'a.io' };
    nextProfile(s);
    expect(s.profiles.map(x => x.offAt ?? null)).toEqual([null, null, null]);
    s.profiles[1].offAt = 9000;
    s.profiles[1].tab = { id: 4, host: 'b.io' };
    releaseTabs(s, 4);
    expect([s.profiles[1].enabled, s.profiles[1].offAt ?? null]).toEqual([false, null]);
  });

  it('describes the state for the toolbar tooltip', () => {
    const s = state();
    expect(statusTitle(s)).toBe('Headerwise: paused');
    s.paused = false;
    expect(statusTitle(s)).toBe('Headerwise: A');
    s.profiles[0].enabled = false;
    expect(statusTitle(s)).toBe('Headerwise: all profiles off');
  });
});
