import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { toDnrRules, type DnrRule } from '../src/core/dnr.ts';
import { activeHeaderCount, type Profile, type Redirect, type State } from '../src/core/model.ts';
import { tabReport } from '../src/core/explain.ts';
import { importModHeader } from '../src/core/import-modheader.ts';
import { exportProfiles, importProfiles } from '../src/core/export.ts';

let n = 0;
const r = (from: string, to: string, isRegex = false, enabled = true): Redirect => ({ id: `r${++n}`, enabled, from, to, isRegex });
const p = (title: string, over: Partial<Profile> = {}): Profile => ({ id: title, title, enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });
const st = (...profiles: Profile[]): State => ({ version: 1, paused: false, profiles });

// What Chrome does with a redirect rule: match regexFilter, then expand
// regexSubstitution (RE2 rewrite: \0-\9 are groups, \\ is a backslash).
function chromeRedirect(rule: DnrRule, url: string): string | null {
  if (rule.action.type !== 'redirect') throw new Error('not a redirect');
  const m = new RegExp(rule.condition.regexFilter!).exec(url);
  if (!m) return null;
  return rule.action.redirect.regexSubstitution.replace(/\\(\\|\d)/g, (_, x: string) => (x === '\\' ? '\\' : m[Number(x)] ?? ''));
}

const redirectsOf = (state: State) => toDnrRules(state).rules.filter(x => x.action.type === 'redirect');

describe('redirects', () => {
  it('replace the first match, plain text or regex, the same way String.replace does', () => {
    const cases: [Redirect, string][] = [
      [r('api.example.com', 'api.staging.example.com'), 'https://api.example.com/v1/users?id=7'],
      [r('/v1/users?id=', '/v2/users?uid='), 'https://h.io/v1/users?id=7&x=1'],
      [r('/v(\\d+)/', '/v$1-beta/', true), 'https://h.io/v2/orders'],
      [r('^http://', 'https://', true), 'http://h.io/a'],
      [r('(\\w+)\\.example\\.com/(\\w+)', '$2.example.org/$1', true), 'https://shop.example.com/cart'],
      [r('C:\\path', 'D:\\path'), 'https://h.io/?f=C:\\path'],
      [r('/old/', '/new/'), 'https://h.io/old/old/x'], // first match only
    ];
    for (const [redirect, url] of cases) {
      const [rule] = redirectsOf(st(p('P', { redirects: [redirect] })));
      const pattern = redirect.isRegex ? new RegExp(redirect.from) : redirect.from;
      const expected = url.replace(pattern, redirect.isRegex ? redirect.to : () => redirect.to);
      expect(chromeRedirect(rule, url)).toBe(expected);
    }
  });

  it('leave URLs that do not match alone', () => {
    const [rule] = redirectsOf(st(p('P', { redirects: [r('api.example.com', 'api.staging.example.com')] })));
    expect(chromeRedirect(rule, 'https://www.example.com/')).toBe(null);
  });

  it('skip a redirect whose result would match again (a loop) and one with too many groups', () => {
    const { rules, warnings } = toDnrRules(st(p('P', { redirects: [r('example.com', 'staging.example.com'), r('(a)(b)(c)(d)(e)(f)(g)(h)', 'x', true), r('', 'x'), r('a', 'b', false, false)] })));
    expect(rules).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/would match again and redirect in a loop/);
    expect(warnings[1]).toMatch(/too many groups/);
  });

  it('a profile with only redirects is on: rule priority, scope and "never on" still apply', () => {
    const { rules } = toDnrRules(st(p('Redirect only', {
      redirects: [r('prod', 'staging')],
      filters: [{ id: 'f', enabled: true, kind: 'exclude', pattern: '/login', isRegex: true }, { id: 'g', enabled: true, kind: 'include', pattern: '||app.io^', isRegex: false }],
      requestMethods: ['get'],
    })));
    expect(rules.map(x => [x.action.type, x.priority])).toEqual([['redirect', 1], ['allow', 1]]);
    expect(rules[0].condition.requestMethods).toEqual(['get']);
    expect(rules[0].condition.urlFilter).toBe(undefined); // its own pattern decides where, not "only on"
    expect(rules[0].condition.resourceTypes.includes('websocket')).toBe(false);
  });

  it('count in the badge and in "On this tab"', () => {
    const s = st(p('R', { redirects: [r('a', 'b'), r('c', 'd', false, false)] }));
    expect(activeHeaderCount(s)).toBe(1);
    const { rules, info } = toDnrRules(s);
    expect(tabReport(s, 'https://h.io/', [{ ruleId: rules[0].id, timeStamp: 5 }], info, 0)[0].line).toEqual({ kind: 'applied', requests: 1 });
  });

  it('come in from ModHeader URL replacements and survive export / import', () => {
    const { profiles } = importModHeader('[{"version":2,"title":"M","urlReplacements":[{"enabled":true,"name":"api\\\\.prod","value":"api.staging"},{"enabled":false,"name":"x","value":"y"}]}]');
    expect(profiles[0].redirects!.map(x => [x.from, x.to, x.isRegex, x.enabled])).toEqual([['api\\.prod', 'api.staging', true, true], ['x', 'y', true, false]]);
    const back = importProfiles(exportProfiles(profiles)).profiles[0];
    expect(back.redirects!.map(x => [x.from, x.to, x.isRegex, x.enabled])).toEqual([['api\\.prod', 'api.staging', true, true], ['x', 'y', true, false]]);
  });
});
