import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { importModHeader } from '../src/core/import-modheader.ts';
import { toDnrRules } from '../src/core/dnr.ts';

// Real ModHeader exports from public GitHub repos. The first two are verbatim;
// the v1 one keeps the structure but has the people's names and tokens replaced.

// github.com/sailod/coinfluence, modheader_profile.json (7.x, compact, keys sorted)
const coinfluence = '[{"headers":[{"appendMode":false,"enabled":true,"name":"Origin","value":""}],"initiatorDomainFilters":[{"domain":"api.mainnet-beta.solana.com","enabled":true}],"respHeaders":[{"appendMode":false,"enabled":true,"name":"Access-Control-Allow-Origin","value":"*"}],"shortTitle":"1","title":"Profile 1","version":2}]';

// github.com/Zerohazard8x/custom, modheader/ChromeUAforGoogle.json (7.x, prettified by the user)
const chromeUa = `[
  {
    "version": 2,
    "title": "ChromeUAforGoogle",
    "headers": [
      { "enabled": true, "name": "User-Agent", "value": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36" }
    ],
    "urlFilters": [{ "enabled": true, "urlRegex": ".*google.com.*" }],
    "excludeUrlFilters": [
      { "enabled": true, "urlRegex": ".*docs.google.com.*" },
      { "enabled": true, "urlRegex": ".*accounts.google.com.*" }
    ],
    "shortTitle": "1",
    "alwaysOn": true
  }
]`;

// github.com/CSSE1001/queue, bootstrap/modheaders.json (2.x/3.x, no version)
const v1 = JSON.stringify([{
  appendMode: false,
  backgroundColor: '#660000',
  filters: [{ comment: '', enabled: true, resourceType: [], type: 'urls', urlRegex: '.*://localhost:[35]000/.*' }],
  headers: [
    { comment: '', enabled: true, name: 'X-Uq-User', value: 'user1' },
    { comment: '', enabled: true, name: 'X-Kvd-Payload', value: '{"email": "user1@example.com"}' },
  ],
  hideComment: true,
  respHeaders: [],
  shortTitle: 'U1',
  title: 'User 1',
  urlReplacements: [],
}]);

// Shape of github.com/Acotec/Extension_Files, ModHeader.json: cookie rules Headerwise can't do yet.
const cookies = JSON.stringify([{
  version: 2,
  title: 'Cookies',
  headers: [{ enabled: true, name: 'User-Agent', value: '{{uuid}}' }],
  cookieHeaders: [{ enabled: true, name: 'user.*', regexEnabled: true, value: '' }],
  setCookieHeaders: [{ attributeOverride: true, enabled: true, maxAge: 7200, name: 'ip_check_time', value: '' }],
  resourceFilters: [{ enabled: true, resourceType: ['main_frame'] }],
  reqCookieAppend: [{ enabled: true, name: 'seen', value: '1' }],
  tabFilters: [{ tabId: 12 }],
}]);

describe('importModHeader', () => {
  it('reads a 7.x export: empty value means remove, initiator domain filter carried over', () => {
    const { profiles, warnings } = importModHeader(coinfluence);
    expect(warnings).toEqual([]);
    expect(profiles).toHaveLength(1);
    const [p] = profiles;
    expect([p.title, p.enabled]).toEqual(['Profile 1', true]);
    expect(p.requestHeaders.map(h => [h.name, h.op])).toEqual([['Origin', 'remove']]);
    expect(p.responseHeaders.map(h => [h.name, h.value, h.op])).toEqual([['Access-Control-Allow-Origin', '*', 'set']]);
    expect(p.initiatorDomains).toEqual(['api.mainnet-beta.solana.com']);
    const { rules } = toDnrRules({ version: 1, paused: false, profiles });
    expect(rules[0].condition.initiatorDomains).toEqual(['api.mainnet-beta.solana.com']);
  });

  it('carries over resource type and method filters, v1 and v2', () => {
    const { profiles, warnings } = importModHeader(JSON.stringify([
      { version: 2, title: 'A', headers: [{ name: 'X-A', value: '1' }], resourceFilters: [{ enabled: true, resourceType: ['xmlhttprequest', 'main_frame'] }], requestMethodFilters: [{ enabled: true, methods: ['POST', 'PUT'] }] },
      { title: 'B', headers: [{ name: 'X-B', value: '1' }], filters: [{ enabled: true, type: 'types', resourceType: ['script'] }] },
      { version: 2, title: 'C', headers: [{ name: 'X-C', value: '1' }], resourceFilters: [{ enabled: true, resourceType: ['speculative'] }] },
    ]));
    expect(profiles.map(p => [p.title, p.enabled, p.resourceTypes ?? null, p.requestMethods ?? null])).toEqual([
      ['A', true, ['xmlhttprequest', 'main_frame'], ['post', 'put']],
      ['B', false, ['script'], null],
      ['C', false, null, null], // its only type is unknown: kept off rather than applied to everything
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/"C": resource types speculative are not supported/);
    expect(warnings[1]).toMatch(/"C" is imported switched off/);
  });

  it('reads 7.x url filters and turns the result into Chrome rules', () => {
    const { profiles, warnings } = importModHeader(chromeUa);
    expect(warnings).toEqual([]);
    expect(profiles[0].filters.map(f => [f.kind, f.pattern, f.isRegex])).toEqual([
      ['include', '.*google.com.*', true],
      ['exclude', '.*docs.google.com.*', true],
      ['exclude', '.*accounts.google.com.*', true],
    ]);
    const { rules } = toDnrRules({ version: 1, paused: false, profiles });
    expect(rules.map(r => [r.action.type, r.condition.regexFilter])).toEqual([
      ['modifyHeaders', '.*google.com.*'],
      ['allow', '.*docs.google.com.*'],
      ['allow', '.*accounts.google.com.*'],
    ]);
  });

  it('reads a 2.x/3.x export with a profile-wide appendMode and a tagged filters list', () => {
    const { profiles, warnings } = importModHeader(v1);
    expect(warnings).toEqual([]);
    const [p] = profiles;
    expect(p.title).toBe('User 1');
    expect(p.requestHeaders.map(h => [h.name, h.op])).toEqual([['X-Uq-User', 'set'], ['X-Kvd-Payload', 'set']]);
    expect(p.filters.map(f => [f.kind, f.pattern])).toEqual([['include', '.*://localhost:[35]000/.*']]);
  });

  it('applies append modes and sendEmptyHeader, per header and per profile', () => {
    const { profiles } = importModHeader(JSON.stringify([
      { version: 2, headers: [
        { name: 'Accept-Language', value: 'kk', appendMode: 'comma' },
        { name: 'Accept', value: 'a', appendMode: 'append' },
        { name: 'X-Empty', value: '', sendEmptyHeader: true },
        { name: 'X-Off', value: 'v', enabled: false },
      ] },
      { appendMode: 'true', sendEmptyHeader: true, headers: [{ name: 'Accept', value: '' }], filters: [{ type: 'excludeUrls', urlPattern: '*://*.example.com/*' }] },
    ]));
    expect(profiles[0].requestHeaders.map(h => [h.name, h.op, h.enabled])).toEqual([
      ['Accept-Language', 'append', true], ['Accept', 'append', true], ['X-Empty', 'set', true], ['X-Off', 'set', false],
    ]);
    expect(profiles[1].requestHeaders.map(h => [h.name, h.op, h.value])).toEqual([['Accept', 'append', '']]);
    expect(profiles[1].filters.map(f => [f.kind, f.pattern, f.isRegex])).toEqual([['exclude', '*://*.example.com/*', false]]);
    expect(profiles.map(p => [p.title, p.enabled])).toEqual([['Imported 1', true], ['Imported 2', false]]);
  });

  it('keeps what it can from cookie-heavy profiles and lists what it skipped', () => {
    const { profiles, warnings } = importModHeader(cookies);
    expect(profiles[0].requestHeaders.map(h => [h.name, h.value, h.op])).toEqual([
      ['User-Agent', '{{uuid}}', 'set'],
      ['Cookie', 'seen=1', 'append'],
    ]);
    expect(profiles[0].enabled).toBe(false);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toBe('"Cookies": skipped request cookie rules, response cookie rules, tab filters. Headerwise can\'t do these yet.');
    expect(profiles[0].resourceTypes).toEqual(['main_frame']);
    expect(warnings[1]).toMatch(/switched off/);
    expect(warnings[2]).toMatch(/\{\{\.\.\.\}\} are imported as plain text/);
  });

  it('maps excludeRequestDomainFilters to "never on" domains', () => {
    const { profiles } = importModHeader('[{"version":2,"title":"D","headers":[{"name":"X-A","value":"1"}],"excludeRequestDomainFilters":[{"enabled":true,"domain":"example.com"}]}]');
    expect(profiles[0].filters.map(f => [f.kind, f.pattern, f.isRegex])).toEqual([['exclude', 'example.com', false]]);
  });

  it('accepts a single object and { profiles: [...] }', () => {
    expect(importModHeader('{"title":"One"}').profiles[0].title).toBe('One');
    expect(importModHeader(JSON.stringify({ profiles: [{ title: 'X' }] })).profiles[0].title).toBe('X');
  });

  it('rejects garbage and share links without throwing', () => {
    expect(importModHeader('not json').warnings).toEqual(['Not valid JSON.']);
    expect(importModHeader('42').profiles).toEqual([]);
    expect(importModHeader('[]').warnings).toEqual(['No profiles found in the file.']);
    expect(importModHeader('https://bewisse.com/modheader/p/#NobwRAhgDlCmB2ATAsge0bMAuAZ').warnings[0]).toMatch(/share link/);
  });
});
