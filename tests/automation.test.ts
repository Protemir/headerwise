import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { expect } from './expect.ts';
import { applyQuery, AUTOMATION_ID } from '../src/core/automation.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import { exportProfiles } from '../src/core/export.ts';
import { defaultState, emptyProfile, type State } from '../src/core/model.ts';
// @ts-expect-error plain .mjs build script, no type declarations
import { automationManifest, AUTOMATION_EXTENSION_ID, extensionId } from '../scripts/automation.mjs';

const headers = (s: State | undefined) => s!.profiles.find(p => p.id === AUTOMATION_ID);

describe('automation page', () => {
  it('sets request and response headers, an empty value removes', () => {
    const r = applyQuery(defaultState(), '?X-Env=staging&Authorization=Bearer%20abc&res:Access-Control-Allow-Origin=*&Referer=');
    const p = headers(r.state)!;
    expect(r.error).toBe(undefined);
    expect(p.requestHeaders.map(h => [h.name, h.value, h.op])).toEqual([['X-Env', 'staging', 'set'], ['Authorization', 'Bearer abc', 'set'], ['Referer', '', 'remove']]);
    expect(p.responseHeaders.map(h => [h.name, h.value])).toEqual([['Access-Control-Allow-Origin', '*']]);
    expect(r.state!.profiles[0].id).toBe(AUTOMATION_ID);
    // Names only: values may be tokens and end up in CI logs.
    expect(r.summary).toEqual(['Automation: set X-Env', 'Automation: set Authorization', 'Automation: remove Referer', 'Automation: set response Access-Control-Allow-Origin']);
    expect(toDnrRules(r.state!).rules.length).toBe(1);
  });

  it('replaces the profile on each call and keeps the others', () => {
    const state = defaultState();
    state.profiles.push({ ...emptyProfile('Mine'), enabled: false });
    const first = applyQuery(state, '?X-A=1').state!;
    const second = applyQuery(first, '?X-B=2').state!;
    expect(headers(second)!.requestHeaders.map(h => h.name)).toEqual(['X-B']);
    expect(second.profiles.map(p => p.title)).toEqual(['Automation', 'Profile 1', 'Mine']);
  });

  it('limits to URLs with @url', () => {
    const p = headers(applyQuery(defaultState(), '?X-A=1&@url=||api.example.com^&@url=*://localhost:*/*').state)!;
    expect(p.filters.map(f => [f.kind, f.pattern, f.isRegex])).toEqual([['include', '||api.example.com^', false], ['include', '*://localhost:*/*', false]]);
  });

  it('@clear drops the profile, turns the rest off and unpauses', () => {
    const state = applyQuery(defaultState(), '?X-A=1').state!;
    state.paused = true;
    const r = applyQuery(state, '?@clear');
    expect(r.state!.paused).toBe(false);
    expect(headers(r.state)).toBe(undefined);
    expect(r.state!.profiles.every(p => !p.enabled)).toBe(true);
    expect(r.summary).toEqual([]);
  });

  it('@import loads a Headerwise or ModHeader export', () => {
    const own = { ...emptyProfile('Staging'), requestHeaders: [{ id: 'h', enabled: true, name: 'X-Env', value: 'staging', op: 'set' as const }] };
    const r = applyQuery(defaultState(), '?' + new URLSearchParams({ '@import': exportProfiles([own]) }));
    expect(r.state!.profiles.map(p => p.title)).toEqual(['Staging']);
    const mh = JSON.stringify([{ title: 'MH', headers: [{ enabled: true, name: 'X-Mh', value: '1' }], respHeaders: [] }]);
    const both = applyQuery(defaultState(), '?' + new URLSearchParams({ '@import': mh, 'X-Extra': '2' }));
    expect(both.state!.profiles.map(p => p.title)).toEqual(['Automation', 'MH']);
    expect(both.summary).toEqual(['Automation: set X-Extra', 'MH: set X-Mh']);
  });

  it('without anything changes nothing', () => {
    const r = applyQuery(applyQuery(defaultState(), '?X-A=1').state!, '');
    expect([r.state, r.error, r.summary]).toEqual([undefined, undefined, ['Automation: set X-A']]);
  });

  it('refuses mistakes instead of guessing', () => {
    const errors = ['?X%20A=1', '?@nope=1', '?@url=||a.com^', '?@clear&X-A=1', '?@import=not-json', '?@url=&X-A=1']
      .map(q => applyQuery(defaultState(), q));
    for (const r of errors) {
      expect(typeof r.error).toBe('string');
      expect(r.state).toBe(undefined);
    }
    expect(errors[0].error).toBe('"X A" is not a valid header name.');
  });
});

describe('automation build', () => {
  const chrome = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));
  const m = automationManifest(chrome);

  it('has a key that gives the documented id', () => {
    expect(extensionId(m.key)).toBe(AUTOMATION_EXTENSION_ID);
    expect(AUTOMATION_EXTENSION_ID).toBe('mhlgmcieamjogdlnfjaoeophmdajkkek');
  });

  it('gets site access at install, says it is the automation build, keeps the rest', () => {
    expect([m.host_permissions, m.optional_host_permissions]).toEqual([['<all_urls>'], undefined]);
    expect(m.version_name).toBe(`${chrome.version} automation`);
    expect([m.version, m.permissions, m.content_security_policy]).toEqual([chrome.version, chrome.permissions, chrome.content_security_policy]);
    expect(chrome.key).toBe(undefined); // the store build has no key
  });
});
