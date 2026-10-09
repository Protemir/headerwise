import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { expect } from './expect.ts';
import { applyQuery, AUTOMATION_ID } from '../src/core/automation.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import { exportProfiles } from '../src/core/export.ts';
import { defaultState, emptyProfile, type State } from '../src/core/model.ts';
// @ts-expect-error plain .mjs build script, no type declarations
import { automationManifest, AUTOMATION_EXTENSION_ID, extensionId, MODHEADER_RULESET, modheaderRules } from '../scripts/automation.mjs';
// @ts-expect-error plain .mjs build script, no type declarations
import { packCrx, readCrx } from '../scripts/crx.mjs';
// @ts-expect-error plain .mjs build script, no type declarations
import { zip } from '../scripts/firefox.mjs';

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

  it('@add keeps earlier headers and their URL filters, same name replaced', () => {
    const first = applyQuery(defaultState(), '?X-A=1&X-B=1&@url=||a.com^').state!;
    const second = applyQuery(first, '?@add&x-b=2&res:X-R=3').state!;
    const p = headers(second)!;
    expect(p.requestHeaders.map(h => [h.name, h.value])).toEqual([['X-A', '1'], ['x-b', '2']]);
    expect(p.responseHeaders.map(h => h.name)).toEqual(['X-R']);
    expect(p.filters.map(f => f.pattern)).toEqual(['||a.com^']);
    expect(headers(applyQuery(defaultState(), '?@add&X-A=1').state)!.requestHeaders.length).toBe(1);
    expect(typeof applyQuery(first, '?@add&@clear').error).toBe('string');
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
    expect(AUTOMATION_EXTENSION_ID).toBe('ogjbgamdhnjnagcdgboifgmhlgddcdce');
  });

  it("sends ModHeader's webdriver URLs to the automation page", () => {
    const rules = modheaderRules();
    const to = (url: string) => {
      for (const r of rules) {
        const re = new RegExp(r.condition.regexFilter);
        if (re.test(url)) return url.replace(re, r.action.redirect.regexSubstitution.replace(/\\(\d)/g, '$$$1'));
      }
      return null;
    };
    const page = `chrome-extension://${AUTOMATION_EXTENSION_ID}/automation.html?`;
    expect(to('https://webdriver.modheader.com/add?X-A=1&X-B=two')).toBe(`${page}@modheader&@add&X-A=1&X-B=two`);
    expect(to('https://webdriver.modheader.com/clear')).toBe(`${page}@modheader&@clear`);
    expect(to('http://webdriver.modheader.com/clear?x=1')).toBe(`${page}@modheader&@clear`);
    expect(to('https://webdriver.modheader.com/load?profile=%5B%7B%7D%5D')).toBe(`${page}@modheader&@import=%5B%7B%7D%5D`);
    expect(to('https://example.com/add?X-A=1')).toBe(null);
    expect(to('https://webdriver.modheader.com.evil.com/add?X-A=1')).toBe(null);
    expect(m.declarative_net_request.rule_resources[0].path).toBe(MODHEADER_RULESET);
    // Only ModHeader's address may open the page, not any web page.
    expect(m.web_accessible_resources).toEqual([{ resources: ['automation.html'], matches: ['https://webdriver.modheader.com/*', 'http://webdriver.modheader.com/*'] }]);
  });

  it('gets site access at install, says it is the automation build, keeps the rest', () => {
    expect([m.host_permissions, m.optional_host_permissions]).toEqual([['<all_urls>'], undefined]);
    expect(m.version_name).toBe(`${chrome.version} automation`);
    expect([m.version, m.permissions, m.content_security_policy]).toEqual([chrome.version, chrome.permissions, chrome.content_security_policy]);
    expect(chrome.key).toBe(undefined); // the store build has no key
  });
});

describe('crx', () => {
  it('signs a CRX3 that checks out, with the id of the key, and refuses tampering', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const der = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const zipBytes = zip([{ name: 'manifest.json', data: Buffer.from('{"manifest_version":3}') }]);
    const crx: Buffer = packCrx(zipBytes, privateKey);
    const read = readCrx(crx);
    expect([read.id, read.publicKey, Buffer.compare(read.zip, zipBytes)]).toEqual([extensionId(der), der, 0]);
    const tampered = Buffer.from(crx);
    tampered[tampered.length - 30] ^= 1;
    assert.throws(() => readCrx(tampered), /bad signature/);
  });
});
