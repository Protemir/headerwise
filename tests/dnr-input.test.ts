import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { fixUrlFilter, groupCount, normalizeDomain, toDnrRules, type DnrRule } from '../src/core/dnr.ts';
import { pageVerdict } from '../src/core/explain.ts';
import type { Profile, State } from '../src/core/model.ts';

// What people actually type, and what must not take everything down with it.

const h = (name: string, value = '1', op: 'set' | 'append' | 'remove' = 'set') => ({ id: name + value, enabled: true, name, value, op });
const f = (kind: 'include' | 'exclude', pattern: string, isRegex = false) => ({ id: pattern, enabled: true, kind, pattern, isRegex });
const p = (over: Partial<Profile> = {}): Profile => ({ id: 'p', title: 'P', enabled: true, requestHeaders: [h('X-A')], responseHeaders: [], filters: [], ...over });
const st = (...profiles: Profile[]): State => ({ version: 1, paused: false, profiles });
const modify = (rules: DnrRule[]) => rules.filter(r => r.action.type === 'modifyHeaders');

describe('input people type', () => {
  it('fixes urlFilters Chrome would reject, refuses what has no clear meaning', () => {
    expect(fixUrlFilter('||*.example.com^')).toBe('||example.com^');
    expect(fixUrlFilter('||bücher.de^')).toBe('||xn--bcher-kva.de^');
    expect(fixUrlFilter('*/straße/*')).toBe('*/stra%C3%9Fe/*');
    expect(fixUrlFilter('||*foo')).toBe(undefined);
    expect(fixUrlFilter('||example.com/api')).toBe('||example.com/api');
  });

  it('a bad "only on" pattern skips that pattern, never the other profiles', () => {
    const r = toDnrRules(st(p({ id: 'a', title: 'A', filters: [f('include', '||*foo'), f('include', '||ok.com^')] }), p({ id: 'b', title: 'B' })));
    expect(modify(r.rules).map(x => x.condition.urlFilter ?? 'all')).toEqual(['||ok.com^', 'all']);
    expect(r.warnings.some(w => /"A": "only on" pattern "\|\|\*foo"/.test(w))).toBe(true);
  });

  it('if no "only on" pattern is usable, the profile is off rather than everywhere', () => {
    const r = toDnrRules(st(p({ filters: [f('include', '||*foo')] })));
    expect(r.rules).toHaveLength(0);
    expect(r.warnings.some(w => /so this profile is off/.test(w))).toBe(true);
  });

  it('cleans up site entries; a non-site turns the profile off instead of widening it', () => {
    expect(normalizeDomain('https://App.Example.com:8080/x')).toBe('app.example.com');
    expect(normalizeDomain('*.example.com')).toBe('example.com');
    expect(normalizeDomain('bücher.de')).toBe('xn--bcher-kva.de');
    expect(normalizeDomain('not a site')).toBe(undefined);
    const ok = toDnrRules(st(p({ initiatorDomains: ['https://app.example.com/'] })));
    expect(ok.rules[0].condition.initiatorDomains).toEqual(['app.example.com']);
    const bad = toDnrRules(st(p({ initiatorDomains: ['app.example.com', 'not a site'] })));
    expect(bad.rules).toHaveLength(0);
    expect(bad.warnings[0]).toMatch(/"not a site" in "only from sites" is not a site/);
    expect(toDnrRules(st(p({ excludedInitiatorDomains: ['not a site'] }))).rules).toHaveLength(0);
  });

  it('"never on" with a single word is part of a URL, not a site', () => {
    const r = toDnrRules(st(p({ filters: [f('exclude', 'logout'), f('exclude', 'example.com'), f('exclude', 'localhost')] })));
    expect(modify(r.rules)[0].condition.excludedRequestDomains).toEqual(['example.com', 'localhost']);
    expect(r.rules.filter(x => x.action.type === 'allow').map(x => x.condition.urlFilter)).toEqual(['logout']);
    expect(pageVerdict(p({ filters: [f('exclude', 'logout')] }), 'https://x.com/logout').kind).toBe('excluded');
  });

  it('regexes match without regard to case, like Chrome', () => {
    expect(pageVerdict(p({ filters: [f('include', '/Api/', true)] }), 'https://x.com/api/v1').kind).toBe('applies');
    const loop = toDnrRules(st(p({ requestHeaders: [], redirects: [{ id: 'r', enabled: true, from: '/API/', to: '/api/', isRegex: false }] })));
    expect(loop.rules).toHaveLength(0);
    expect(loop.warnings[0]).toMatch(/loop/);
  });

  it('a redirect does nothing until both fields are filled in', () => {
    const r = toDnrRules(st(p({ requestHeaders: [], redirects: [{ id: 'r', enabled: true, from: 'a', to: '', isRegex: false }] })));
    expect([r.rules.length, r.warnings.length]).toEqual([0, 0]);
  });

  it('counts regex groups like RE2: not in [...], named groups count', () => {
    expect(groupCount('[(]v1')).toBe(0);
    expect(groupCount('(?P<v>v1)/(\\d+)')).toBe(2);
    expect(groupCount('(?<v>v1)')).toBe(1);
    expect(groupCount('(?:a)(?i)b[^]()](c)')).toBe(1);
    const r = toDnrRules(st(p({ requestHeaders: [], redirects: [{ id: 'r', enabled: true, from: '(?P<v>v1)/', to: 'v2/', isRegex: true }] })));
    const sub = r.rules[0].action.type === 'redirect' ? r.rules[0].action.redirect.regexSubstitution : '';
    expect(sub).toBe('\\1v2/\\3');
  });

  it('"append" with several "only on" filters becomes one rule, so it is not applied twice', () => {
    const appendProfile = p({ requestHeaders: [h('X-Forwarded-For', '1.2.3.4', 'append')], filters: [f('include', '||example.com^'), f('include', '*/api/*')] });
    const rules = modify(toDnrRules(st(appendProfile)).rules);
    expect(rules).toHaveLength(1);
    const re = new RegExp(rules[0].condition.regexFilter!, 'i');
    expect(['https://example.com/x', 'https://other.io/api/v', 'https://other.io/x'].map(u => re.test(u))).toEqual([true, true, false]);
    // without "append" one rule per filter, as before
    expect(modify(toDnrRules(st(p({ filters: appendProfile.filters }))).rules)).toHaveLength(2);
  });
});
