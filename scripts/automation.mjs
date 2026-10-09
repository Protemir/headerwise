// Automation build, for Selenium, Playwright and Puppeteer: takes dist/ (npm run
// build) and writes dist-automation/ and headerwise-automation-<version>.zip.
// The code is the same; the manifest differs:
// - "key" (scripts/automation-key.pub, a public key; nobody keeps the private one)
//   gives the unpacked extension a fixed id, so tests can open
//   chrome-extension://mhlgmcieamjogdlnfjaoeophmdajkkek/automation.html;
// - site access is granted at install time: nobody is there to click "Allow";
// - no welcome tab (background.ts checks version_name).
//   npm run build && node scripts/automation.mjs
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { listFiles, zip } from './firefox.mjs';

const KEY = readFileSync(new URL('./automation-key.pub', import.meta.url), 'utf8').trim();
export const AUTOMATION_EXTENSION_ID = 'mhlgmcieamjogdlnfjaoeophmdajkkek';

/** Chrome's id for an unpacked extension with this key: sha256 of the key, first 32 hex digits as a-p. */
export function extensionId(key) {
  const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function automationManifest(chrome) {
  const m = structuredClone(chrome);
  m.name = 'Headerwise (automation)';
  m.short_name = 'Headerwise';
  m.version_name = `${chrome.version} automation`;
  m.key = KEY;
  m.host_permissions = ['<all_urls>'];
  delete m.optional_host_permissions;
  return m;
}

if (process.argv[1]?.endsWith('automation.mjs')) {
  if (extensionId(KEY) !== AUTOMATION_EXTENSION_ID) throw new Error('automation-key.pub does not match the documented id');
  const dist = resolve('dist');
  const out = resolve('dist-automation');
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error('dist/ not found, run npm run build first');
  rmSync(out, { recursive: true, force: true });
  cpSync(dist, out, { recursive: true });
  const manifest = automationManifest(JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')));
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const files = listFiles(out).sort().map(f => ({ name: relative(out, f).split('\\').join('/'), data: readFileSync(f) }));
  // Two names: the versioned one, and a fixed one for releases/latest/download links.
  writeFileSync(`headerwise-automation-${manifest.version}.zip`, zip(files));
  writeFileSync('headerwise-automation.zip', zip(files));
  console.log(`headerwise-automation-${manifest.version}.zip: ${files.length} files, id ${AUTOMATION_EXTENSION_ID}`);
}
