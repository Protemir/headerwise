import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { ALL_RESOURCE_TYPES, toDnrRules } from '../src/core/dnr.ts';
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
    expect(rules[0].action.responseHeaders).toEqual([{ header: 'X-Res', operation: 'set', value: 'r' }]);
  });

  it('drops the value for remove', () => {
    const { rules } = toDnrRules(s([p({ responseHeaders: [h('Content-Security-Policy', 'ignored', 'remove')] })]));
    expect(rules[0].action.responseHeaders).toEqual([{ header: 'Content-Security-Policy', operation: 'remove' }]);
  });

  it('makes one rule per include filter, regex and urlFilter', () => {
    const { rules } = toDnrRules(s([p({
      requestHeaders: [h('X-A')],
      filters: [f('include', '^https://api\\.example\\.com/', true), f('include', '||example.org^', false), f('include', 'x', true, false)],
    })]));
    expect(rules.map(r => r.condition.regexFilter ?? r.condition.urlFilter)).toEqual(['^https://api\\.example\\.com/', '||example.org^']);
    expect(rules.map(r => r.id)).toEqual([1, 2]);
  });

  it('maps plain-domain excludes to excludedRequestDomains and warns on regex excludes', () => {
    const { rules, warnings } = toDnrRules(s([p({
      requestHeaders: [h('X-A')],
      filters: [f('exclude', 'Example.com', false), f('exclude', '.*\\.local', true)],
    })]));
    expect(rules[0].condition.excludedRequestDomains).toEqual(['example.com']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/only plain domains/);
  });

  it('skips invalid header names and line breaks in values, with a warning', () => {
    const { rules, warnings } = toDnrRules(s([p({ requestHeaders: [h('Bad Name'), h('X-Ok', 'a\r\nb'), h('X-Good')] })]));
    expect(rules[0].action.requestHeaders).toEqual([{ header: 'X-Good', operation: 'set', value: 'v' }]);
    expect(warnings).toHaveLength(2);
  });

  it('allows append only for request headers Chrome supports', () => {
    const { rules, warnings } = toDnrRules(s([p({
      requestHeaders: [h('Accept-Language', 'kk', 'append'), h('X-Custom', 'a', 'append')],
      responseHeaders: [h('X-Any', 'b', 'append')],
    })]));
    expect(rules[0].action.requestHeaders).toEqual([{ header: 'Accept-Language', operation: 'append', value: 'kk' }]);
    expect(rules[0].action.responseHeaders).toEqual([{ header: 'X-Any', operation: 'append', value: 'b' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/can't append/);
  });

  it('gives the first profile the highest priority', () => {
    const { rules } = toDnrRules(s([
      p({ title: 'first', requestHeaders: [h('X-A', '1')] }),
      p({ title: 'off', enabled: false, requestHeaders: [h('X-A', '2')] }),
      p({ title: 'third', requestHeaders: [h('X-A', '3')] }),
    ]));
    expect(rules.map(r => [r.priority, r.action.requestHeaders![0].value])).toEqual([[3, '1'], [1, '3']]);
  });
});
