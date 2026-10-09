import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { expect } from './expect.ts';
// @ts-expect-error plain .mjs build script, no type declarations
import { firefoxManifest, GECKO_ID, zip } from '../scripts/firefox.mjs';

describe('Firefox build', () => {
  const chrome = JSON.parse(readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'));

  it('turns the service worker into an event page and adds what AMO requires', () => {
    const m = firefoxManifest(chrome);
    expect(m.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(m.minimum_chrome_version).toBe(undefined);
    expect(m.browser_specific_settings.gecko).toEqual({ id: GECKO_ID, strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } });
    expect([m.version, m.permissions, m.content_security_policy]).toEqual([chrome.version, chrome.permissions, chrome.content_security_policy]);
    expect(chrome.background.service_worker).toBe('background.js'); // the original is untouched
  });

  it('writes a zip with forward-slash paths that inflates back to the same bytes', () => {
    const files = [{ name: 'manifest.json', data: Buffer.from('{"a":1}') }, { name: 'src/popup/index.html', data: Buffer.from('<p>hi</p>'.repeat(50)) }];
    const z: Buffer = zip(files);
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    let at = 0;
    for (const f of files) {
      const nameLen = z.readUInt16LE(at + 26);
      const size = z.readUInt32LE(at + 18);
      expect(z.subarray(at + 30, at + 30 + nameLen).toString()).toBe(f.name);
      expect(inflateRawSync(z.subarray(at + 30 + nameLen, at + 30 + nameLen + size)).toString()).toBe(f.data.toString());
      at += 30 + nameLen + size;
    }
    expect(zip(files).equals(z)).toBe(true); // same input, same bytes
  });
});
