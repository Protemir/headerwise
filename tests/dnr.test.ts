import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { ALL_RESOURCE_TYPES, dropUnsupportedRegexes, toDnrRules, type DnrRule } from '../src/core/dnr.ts';
import type { HeaderMod, Profile, State, UrlFilter } from '../src/core/model.ts';

let seq = 0;
const id = () => `id${++seq}`;

function h(name: string, value = 'v', op: HeaderMod['op'] = 'set', enabled = true): HeaderMod {
  return { id: id(), enabled, name, value, op };
}

function f(kind: UrlFilter['kind'], pattern: string, isRegex: boolean, enabled = true): UrlFilter {
  return { id: id(), enabled, kind, pattern, isRegex };
}

function p(over: Partial<Profile> = {}): Profile {
  return { id: id(), title: 'P', enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over };
}

function s(profiles: Profile[], paused = false): State {
  return { version: 1, paused, profiles };
}

function mod(r: DnrRule) {
  if (r.action.type !== 'modifyHeaders') throw new Error(`rule ${r.id} is ${r.action.type}`);
  return r.action;
}

describe('toDnrRules', () => {
  it('turns one request header into one rule for every URL, main_frame included', () => {
    const { rules, warnings } = toDnrRules(s([p({ requestHeaders: [h('X-Test', '1')] })]));
    expect(warnings).toEqual([]);
    expect(rules).toEqual([{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'X-Test', operation: 'set', value: '1' }] },
      condition: { resourceTypes: ALL_RESOURCE_TYPES },
    }]);
    expect(ALL_RESOURCE_TYPES).toContain('main_frame');
  });

  it('produces nothing when paused, when the profile is off, or when headers are empty/disabled', () => {
    expect(toDnrRules(s([p({ requestHeaders: [h('X-A')] })], true)).rules).toEqual([]);
    expect(toDnrRules(s([p({ enabled: false, requestHeaders: [h('X-A')] })])).rules).toEqual([]);
    expect(toDnrRules(s([p({ requestHeaders: [h(''), h('X-B', 'v', 'set', false)] })])).rules).toEqual([]);
  });

  it('puts request and response headers into the same rule', () => {
    const { rules } = toDnrRules(s([p({ requestHeaders: [h('X-Req')], responseHeaders: [h('X-Res', 'r')] })]));
    expect(rules).toHaveLength(1);
    expect(mod(rules[0]).responseHeaders).toEqual([{ header: 'X-Res', operation: 'set', value: 'r' }]);
  });

  it('drops the value for remove', () => {
    const { rules } = toDnrRules(s([p({ responseHeaders: [h('Content-Security-Policy', 'ignored', 'remove')] })]));
    expect(mod(rules[0]).responseHeaders).toEqual([{ header: 'Content-Security-Policy', operation: 'remove' }]);
  });

  it('makes one rule per include filter, regex and urlFilter', () => {
    const { rules } = toDnrRules(s([p({
      requestHeaders: [h('X-A')],
      filters: [f('include', '^https://api\\.example\\.com/', true), f('include', '||example.org^', false), f('include', 'x', true, false)],
    })]));
    expect(rules.map(r => r.condition.regexFilter ?? r.condition.urlFilter)).toEqual(['^https://api\\.example\\.com/', '||example.org^']);
    expect(rules.map(r => r.id)).toEqual([1, 2]);
  });

  it('maps plain-domain excludes to excludedRequestDomains', () => {
    const { rules, warnings } = toDnrRules(s([p({
      requestHeaders: [h('X-A')],
      filters: [f('exclude', 'Example.com', false), f('exclude', ' ', true)],
    })]));
    expect(warnings).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0].condition.excludedRequestDomains).toEqual(['example.com']);
  });

  it('turns regex and urlFilter excludes into allow rules with the profile priority', () => {
    const { rules, warnings } = toDnrRules(s([p({
      requestHeaders: [h('X-A')],
      filters: [f('include', '||example.com^', false), f('exclude', '^https://example\\.com/login', true), f('exclude', '*/health', false)],
    })]));
    expect(warnings).toEqual([]);
    expect(rules.map(r => [r.id, r.priority, r.action.type, r.condition.regexFilter ?? r.condition.urlFilter])).toEqual([
      [1, 1, 'modifyHeaders', '||example.com^'],
      [2, 1, 'allow', '^https://example\\.com/login'],
      [3, 1, 'allow', '*/health'],
    ]);
    expect(rules[1].condition.resourceTypes).toEqual(ALL_RESOURCE_TYPES);
  });

  it('moves profiles with allow-rule excludes below the others so they turn off nobody else', () => {
    const { rules, warnings } = toDnrRules(s([
      p({ title: 'top', requestHeaders: [h('X-Top')], filters: [f('exclude', 'login', true)] }),
      p({ title: 'bottom', requestHeaders: [h('X-Bottom')] }),
    ]));
    expect(rules.map(r => [r.priority, r.action.type])).toEqual([[2, 'modifyHeaders'], [1, 'modifyHeaders'], [1, 'allow']]);
    expect(mod(rules[0]).requestHeaders![0].header).toBe('X-Bottom');
    expect(warnings).toEqual([]);
  });

  it('warns when moving a profile changes who wins a header, or when allow rules overlap', () => {
    const { warnings } = toDnrRules(s([
      p({ title: 'A', requestHeaders: [h('X-Env', 'a')], filters: [f('exclude', 'login', true)] }),
      p({ title: 'B', requestHeaders: [h('x-env', 'b')] }),
      p({ title: 'C', requestHeaders: [h('X-C')], filters: [f('exclude', 'logout', true)] }),
    ]));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/"B" wins on header "X-Env"/);
    expect(warnings[1]).toMatch(/"A".*also turn off "C"/);
  });

  it('skips invalid header names and line breaks in values, with a warning', () => {
    const { rules, warnings } = toDnrRules(s([p({ requestHeaders: [h('Bad Name'), h('X-Ok', 'a\r\nb'), h('X-Good')] })]));
    expect(mod(rules[0]).requestHeaders).toEqual([{ header: 'X-Good', operation: 'set', value: 'v' }]);
    expect(warnings).toHaveLength(2);
  });

  it('allows append only for request headers Chrome supports', () => {
    const { rules, warnings } = toDnrRules(s([p({
      requestHeaders: [h('Accept-Language', 'kk', 'append'), h('X-Custom', 'a', 'append')],
      responseHeaders: [h('X-Any', 'b', 'append')],
    })]));
    expect(mod(rules[0]).requestHeaders).toEqual([{ header: 'Accept-Language', operation: 'append', value: 'kk' }]);
    expect(mod(rules[0]).responseHeaders).toEqual([{ header: 'X-Any', operation: 'append', value: 'b' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/can't append/);
  });

  it('gives the first profile the highest priority', () => {
    const { rules } = toDnrRules(s([
      p({ title: 'first', requestHeaders: [h('X-A', '1')] }),
      p({ title: 'off', enabled: false, requestHeaders: [h('X-A', '2')] }),
      p({ title: 'third', requestHeaders: [h('X-A', '3')] }),
    ]));
    expect(rules.map(r => [r.priority, mod(r).requestHeaders![0].value])).toEqual([[2, '1'], [1, '3']]);
  });
});

describe('dropUnsupportedRegexes', () => {
  // Stand-in for chrome.declarativeNetRequest.isRegexSupported: RE2 has no lookaround.
  const re2 = async (regex: string) => (/\(\?[=!<]/.test(regex)
    ? { isSupported: false, reason: 'syntaxError' }
    : { isSupported: true });

  it('skips an only-on rule with a lookahead and renumbers the rest', async () => {
    const converted = toDnrRules(s([p({
      title: 'Api',
      requestHeaders: [h('X-A')],
      filters: [f('include', '^https://(?!www)', true), f('include', '||example.com^', false)],
    })]));
    const kept = await dropUnsupportedRegexes(converted, re2);
    const { warnings } = converted;
    expect(kept.map(r => [r.id, r.condition.urlFilter])).toEqual([[1, '||example.com^']]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^"Api": "only on" regex .*\(syntaxError\)/);
  });

  it('turns off the whole profile when its never-on regex is unsupported, other profiles stay', async () => {
    const converted = toDnrRules(s([
      p({ title: 'ok', requestHeaders: [h('X-Ok')] }),
      p({ title: 'bad', requestHeaders: [h('X-Bad')], filters: [f('exclude', 'login(?=\\?)', true)] }),
    ]));
    const kept = await dropUnsupportedRegexes(converted, re2);
    expect(kept.map(r => mod(r).requestHeaders![0].header)).toEqual(['X-Ok']);
    expect(converted.warnings[0]).toMatch(/^"bad": .*so this profile is off/);
  });
});
