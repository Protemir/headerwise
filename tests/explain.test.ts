import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { pageVerdict, tabReport, urlFilterRegExp } from '../src/core/explain.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import type { Profile, State, UrlFilter } from '../src/core/model.ts';

let seq = 0;
const id = () => `id${++seq}`;
const f = (kind: UrlFilter['kind'], pattern: string, isRegex = false): UrlFilter => ({ id: id(), enabled: true, kind, pattern, isRegex });
const p = (title: string, over: Partial<Profile> = {}): Profile => ({
  id: title, title, enabled: true,
  requestHeaders: [{ id: id(), enabled: true, name: 'X-A', value: '1', op: 'set' }],
  responseHeaders: [], filters: [], ...over,
});

describe('urlFilterRegExp (Chrome urlFilter syntax)', () => {
  const cases: [string, string, boolean][] = [
    ['||example.com^', 'https://example.com/a', true],
    ['||example.com^', 'https://api.example.com/a', true],
    ['||example.com^', 'https://notexample.com/a', false],
    ['||example.com^', 'https://example.com.evil.io/', false],
    ['||example.com^', 'https://example.com', true],
    ['|https://a.io/x|', 'https://a.io/x', true],
    ['|https://a.io/x|', 'https://a.io/xy', false],
    ['*/api/*', 'http://localhost:3000/api/users', true],
    ['/API/', 'https://h.io/api/x', true], // case-insensitive
    ['a.b', 'https://h.io/axb', false], // dot is literal
    ['login', 'https://h.io/user/login?next=/', true],
  ];
  for (const [filter, url, want] of cases) {
    it(`${filter} ${want ? 'matches' : 'does not match'} ${url}`, () => expect(urlFilterRegExp(filter).test(url)).toBe(want));
  }
});

describe('pageVerdict', () => {
  it('checks excluded domains, including subdomains', () => {
    expect(pageVerdict(p('A', { filters: [f('exclude', 'example.com')] }), 'https://app.example.com/').kind).toBe('excluded');
    expect(pageVerdict(p('A', { filters: [f('exclude', 'example.com')] }), 'https://example.org/').kind).toBe('applies');
  });

  it('checks regex and urlFilter excludes', () => {
    expect(pageVerdict(p('A', { filters: [f('exclude', '.*/login.*', true)] }), 'https://h.io/login')).toEqual({ kind: 'excluded', pattern: '.*/login.*' });
    expect(pageVerdict(p('A', { filters: [f('exclude', '*/health')] }), 'https://h.io/health').kind).toBe('excluded');
  });

  it('reports the "only on" patterns when none matches', () => {
    expect(pageVerdict(p('A', { filters: [f('include', '||api.io^'), f('include', '^https://x\\.io', true)] }), 'https://h.io/'))
      .toEqual({ kind: 'not-included', patterns: ['||api.io^', '^https://x\\.io'] });
    expect(pageVerdict(p('A', { filters: [f('include', '||h.io^')] }), 'https://h.io/').kind).toBe('applies');
  });
});

describe('tabReport', () => {
  const state: State = {
    version: 1,
    paused: false,
    profiles: [
      p('Works'),
      p('Never here', { filters: [f('exclude', '/login', true)] }),
      p('Other site', { filters: [f('include', '||api.io^')] }),
      p('Not reloaded'),
      p('Off', { enabled: false }),
      p('Empty', { requestHeaders: [] }),
    ],
  };
  const { info } = toDnrRules(state);
  const ruleOf = (profileId: string, kind: 'modify' | 'allow') => Number(Object.entries(info).find(([, i]) => i.profileId === profileId && i.kind === kind)![0]);

  it('explains every profile', () => {
    const matched = [
      { ruleId: ruleOf('Works', 'modify'), timeStamp: 200 },
      { ruleId: ruleOf('Works', 'modify'), timeStamp: 201 },
      { ruleId: ruleOf('Works', 'modify'), timeStamp: 50 }, // before the last rebuild: ignored
      { ruleId: ruleOf('Never here', 'allow'), timeStamp: 202 },
    ];
    const lines = tabReport(state, 'https://h.io/login', matched, info, 100);
    expect(lines.map(l => [l.title, l.line])).toEqual([
      ['Works', { kind: 'applied', requests: 2 }],
      ['Never here', { kind: 'excluded', pattern: '/login' }],
      ['Other site', { kind: 'not-included', patterns: ['||api.io^'] }],
      ['Not reloaded', { kind: 'waiting' }],
      ['Off', { kind: 'off' }],
      ['Empty', { kind: 'empty' }],
    ]);
  });

  it('says when a profile was applied to some requests and skipped on others', () => {
    const lines = tabReport(state, 'https://h.io/login', [
      { ruleId: ruleOf('Never here', 'modify'), timeStamp: 300 },
      { ruleId: ruleOf('Never here', 'allow'), timeStamp: 301 },
    ], info, 100);
    expect(lines[1].line).toEqual({ kind: 'applied', requests: 1, skippedBy: '/login' });
  });

  it('judges exclusions from the page URL (Chrome does not report allow rules)', () => {
    expect(tabReport(state, 'https://h.io/login', [], info, 0)[1].line).toEqual({ kind: 'excluded', pattern: '/login' });
    // applied to the favicon, but the page itself is excluded
    const lines = tabReport(state, 'https://h.io/login', [{ ruleId: ruleOf('Never here', 'modify'), timeStamp: 1 }], info, 0);
    expect(lines[1].line).toEqual({ kind: 'applied', requests: 1, skippedBy: '/login' });
  });
});

describe('tabReport without matched rules (Firefox)', () => {
  it('says "applies to this page" instead of asking for a reload', async () => {
    const { tabReport } = await import('../src/core/explain.ts');
    const s: State = { version: 1, paused: false, profiles: [p('Here'), p('Not here', { filters: [f('exclude', '/login', true)] })] };
    const lines = tabReport(s, 'https://h.io/login', [], {}, 0, undefined, false);
    expect(lines.map(l => l.line.kind)).toEqual(['page-match', 'excluded']);
  });
});
