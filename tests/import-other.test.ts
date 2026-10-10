import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { importProfiles } from '../src/core/export.ts';
import { pageVerdict } from '../src/core/explain.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import type { Profile } from '../src/core/model.ts';

// Samples shaped like the files these extensions write (from their source code).

const applies = (p: Profile, url: string) => pageVerdict(p, url).kind === 'applies';
const heads = (list: Profile['requestHeaders']) => list.map(h => [h.name, h.value, h.op, h.enabled]);

describe('Simple Modify Headers', () => {
  it('1.2: page list, per-row "URL contains", actions, request and response', () => {
    const { profiles, warnings } = importProfiles(JSON.stringify({
      format_version: '1.2', target_page: '', use_url_contains: true, debug_mode: false, show_comments: true,
      headers: [
        { url_contains: '/api/', action: 'add', header_name: 'X-Debug', header_value: '1', comment: 'dbg', apply_on: 'req', status: 'on' },
        { url_contains: '', action: 'delete', header_name: 'Server', header_value: '', comment: '', apply_on: 'res', status: 'off' },
        { url_contains: '', action: 'cookie_add_or_modify', header_name: 'sid', header_value: 'x', apply_on: 'req', status: 'on' },
      ],
    }));
    expect(profiles.map(p => p.title)).toEqual(['Simple Modify Headers: /api/', 'Simple Modify Headers']);
    expect(heads(profiles[0].requestHeaders)).toEqual([['X-Debug', '1', 'set', true]]);
    expect(profiles[0].requestHeaders[0].comment).toBe('dbg');
    expect(heads(profiles[1].responseHeaders)).toEqual([['Server', '', 'remove', false]]);
    expect([applies(profiles[0], 'https://x.io/api/v1'), applies(profiles[0], 'https://x.io/home')]).toEqual([true, false]);
    expect(warnings).toEqual(['1 cookie row skipped: Simple Modify Headers can only do those in Firefox.']);
  });

  it('page list as match patterns', () => {
    const { profiles } = importProfiles(JSON.stringify({ format_version: '1.1', target_page: 'https://*.example.com/*;https://api.test.io/v2/*', headers: [{ action: 'modify', header_name: 'User-Agent', header_value: 'Bot/1.0', apply_on: 'req', status: 'on' }] }));
    const p = profiles[0];
    expect(p.filters.map(f => f.pattern)).toEqual(['||example.com^', '||api.test.io/v2/*']);
    expect(['https://a.example.com/x', 'https://api.test.io/v2/u', 'https://api.test.io/v1/u', 'https://other.io/'].map(u => applies(p, u))).toEqual([true, true, false, false]);
    expect(p.enabled).toBe(true);
  });

  it('page list and "URL contains" together come in off, with a note', () => {
    const { profiles, warnings } = importProfiles(JSON.stringify({ format_version: '1.2', target_page: 'https://example.com/*', use_url_contains: true, headers: [{ url_contains: 'admin', action: 'add', header_name: 'X-A', header_value: '1', apply_on: 'req', status: 'on' }] }));
    expect(profiles[0].enabled).toBe(false);
    expect(warnings[0]).toMatch(/can't say "both"/);
  });

  it('1.0 (request headers only) and the old Firefox "Modify Header" list', () => {
    expect(heads(importProfiles(JSON.stringify({ format_version: '1.0', target_page: '', headers: [{ action: 'add', header_name: 'X-Env', header_value: 'dev', status: 'on' }] })).profiles[0].requestHeaders)).toEqual([['X-Env', 'dev', 'set', true]]);
    expect(heads(importProfiles(JSON.stringify([{ action: 'Filter', name: 'Referer', value: '', comment: '', enabled: true }, { action: 'Add', name: 'X-B', value: '2', enabled: false }])).profiles[0].requestHeaders))
      .toEqual([['Referer', '', 'remove', true], ['X-B', '2', 'set', false]]);
  });
});

describe('Requestly', () => {
  const v2 = [
    { id: 'Headers_k3x9a', objectType: 'rule', ruleType: 'Headers', name: 'Debug API', status: 'Active', groupId: 'Group_ab12c', version: 2, schemaVersion: '3.0.0',
      pairs: [{ id: 'p1', source: { key: 'Url', operator: 'Contains', value: 'api.example.com', filters: [{ requestMethod: ['GET', 'POST'], resourceType: ['xmlhttprequest'], pageDomains: ['app.example.com'] }] },
        modifications: { Request: [{ id: 'm1', header: 'X-Debug', type: 'Add', value: '1' }, { id: 'm2', header: 'Accept-Language', type: 'Add', value: 'de' }], Response: [{ id: 'm3', header: 'Server', type: 'Remove', value: '' }] } }] },
    { id: 'Headers_zz', objectType: 'rule', ruleType: 'Headers', name: 'Ungrouped', status: 'Active', groupId: '', version: 2,
      pairs: [{ source: { key: 'host', operator: 'Wildcard_Matches', value: '*.example.com', filters: [] }, modifications: { Request: [{ header: 'X-B', type: 'Modify', value: '2' }], Response: [] } }] },
    { id: 'Redirect_1', objectType: 'rule', ruleType: 'Redirect', name: 'R', status: 'Active', pairs: [] },
    { id: 'Group_ab12c', objectType: 'group', name: 'Staging', status: 'Inactive', children: [] },
  ];

  it('v2 header rules: operations like Requestly MV3, scope, groups switch rules off', () => {
    const { profiles, warnings } = importProfiles(JSON.stringify(v2));
    const [debug, ungrouped] = profiles;
    expect(profiles.map(p => [p.title, p.enabled])).toEqual([['Staging / Debug API', false], ['Ungrouped', true]]);
    expect(heads(debug.requestHeaders)).toEqual([['X-Debug', '1', 'set', true], ['Accept-Language', 'de', 'append', true]]);
    expect(heads(debug.responseHeaders)).toEqual([['Server', '', 'remove', true]]);
    expect([debug.requestMethods, debug.resourceTypes, debug.initiatorDomains]).toEqual([['get', 'post'], ['xmlhttprequest'], ['app.example.com']]);
    expect([applies(debug, 'https://api.example.com/x'), applies(debug, 'https://other.io/')]).toEqual([true, false]);
    expect(['https://a.example.com/', 'https://example.com/', 'https://a.example.com.evil.io/', 'https://evil.io/?a.example.com'].map(u => applies(ungrouped, u))).toEqual([true, false, false, false]);
    expect(warnings).toEqual(['Skipped Requestly rules that aren\'t about headers: 1 Redirect.']);
    expect(toDnrRules({ version: 1, paused: false, profiles }).warnings).toEqual([]);
  });

  it('v1 pairs, url operators, and filters Headerwise lacks', () => {
    const { profiles, warnings } = importProfiles(JSON.stringify([
      { objectType: 'rule', ruleType: 'Headers', name: 'Old', status: 'Active', groupId: '', pairs: [
        { header: 'X-Env', value: 'staging', type: 'Modify', target: 'Request', source: { key: 'Url', operator: 'Equals', value: 'https://a.io/x', filters: {} } },
        { header: 'X-R', value: '1', type: 'Add', target: 'Response', source: { key: 'Url', operator: 'Matches', value: '/^https://b\\.io/i', filters: {} } },
        { header: 'X-P', value: '1', type: 'Add', target: 'Request', source: { key: 'Url', operator: 'Contains', value: 'c.io', filters: { pageUrl: { operator: 'Contains', value: 'admin' } } } },
      ] },
    ]));
    expect(profiles.map(p => [p.title, p.enabled])).toEqual([['Old (1)', true], ['Old (2)', true], ['Old (3)', false]]);
    expect([applies(profiles[0], 'https://a.io/x'), applies(profiles[0], 'https://a.io/xy')]).toEqual([true, false]);
    expect(heads(profiles[1].responseHeaders)).toEqual([['X-R', '1', 'append', true]]);
    expect(applies(profiles[1], 'https://b.io/q')).toBe(true);
    expect(warnings[0]).toMatch(/"Old \(3\)": page URL filter can't be imported, so this rule comes in switched off/);
  });

  it('ModHeader and Headerwise files are still told apart', () => {
    expect(importProfiles(JSON.stringify([{ title: 'MH', headers: [{ enabled: true, name: 'X', value: '1' }] }])).profiles[0].title).toBe('MH');
  });
});
