// Store screenshots from the real extension: loads dist/ into a throwaway Chrome,
// fills it with demo profiles, captures the popup and the ModHeader page (light
// and dark), then lays them out on 1280x800 screenshots with captions, plus the
// 440x280 small promo tile and the 1400x560 marquee.
//
//   npm run build && node scripts/store/shots.mjs
//
// Output: store/screenshots/*.png, store/promo-*.png, store/raw/*.png.
// The demo site is app.example.com (reserved for examples), mapped to a local server.
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { connect, openTab, sleep } from '../live-test/cdp.mjs';

const CHROME = process.env.HW_BROWSER ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9341;
const DEMO_PORT = 8790;
const out = resolve('store');
const raw = join(out, 'raw');
const work = join(tmpdir(), 'hw-shots');
rmSync(work, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });

// --- demo site: a page that makes a few API calls, so "On this tab" has something to say
const demo = createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Acme dashboard</title><h1>Acme dashboard</h1>
    <script>Promise.all(['/api/user', '/api/orders?page=1', '/api/flags'].map(u => fetch(u)));</script>`);
});
await new Promise(ok => demo.listen(DEMO_PORT, '127.0.0.1', ok));

// --- the extension, with site access granted up front (a script can't click the browser's dialog)
const ext = join(work, 'ext');
cpSync(resolve('dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
manifest.permissions.push('declarativeNetRequestFeedback'); // stands in for the activeTab a click would grant
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const proc = spawn(CHROME, [
  `--user-data-dir=${join(work, 'profile')}`,
  '--remote-debugging-pipe', `--remote-debugging-port=${PORT}`, '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--lang=en-US',
  `--host-resolver-rules=MAP app.example.com 127.0.0.1:${DEMO_PORT}, MAP api.example.com 127.0.0.1:${DEMO_PORT}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const extId = await new Promise((ok, fail) => {
  setTimeout(() => fail(new Error('Chrome did not load the extension')), 30000);
  let buf = '';
  proc.stdio[4].on('data', d => {
    buf += d;
    const end = buf.indexOf('\0');
    if (end >= 0) { const m = JSON.parse(buf.slice(0, end)); m.result ? ok(m.result.id) : fail(new Error(JSON.stringify(m.error))); }
  });
  proc.stdio[3].write(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: ext } }) + '\0');
});
await sleep(1500);
const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;

const ctl = await openTab(PORT, popupUrl);
await sleep(800);
const site = await openTab(PORT, 'about:blank');
await site.send('Page.navigate', { url: 'http://app.example.com/dashboard' });
await sleep(1000);
const siteTab = await ctl.evaluate(`chrome.tabs.query({ url: 'http://app.example.com/*' }).then(t => t[0].id)`);

const h = (name, value, op = 'set') => ({ id: `${name}-${value}`, enabled: true, name, value, op });
const state = {
  version: 1,
  paused: false,
  profiles: [
    { id: 'staging', title: 'Staging', enabled: true,
      requestHeaders: [h('X-Env', 'staging'), h('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl')],
      responseHeaders: [h('Access-Control-Allow-Origin', '*')],
      filters: [{ id: 'f1', enabled: true, kind: 'include', pattern: '||example.com^', isRegex: false }, { id: 'f2', enabled: true, kind: 'exclude', pattern: '/logout', isRegex: true }] },
    { id: 'qa', title: 'QA user 42', enabled: true, tab: { id: siteTab, host: 'app.example.com' },
      requestHeaders: [h('X-User-Id', '42'), h('X-Feature-Flags', 'new-checkout'), h('X-Request-Id', '{{uuid}}')],
      responseHeaders: [], filters: [], resourceTypes: ['xmlhttprequest'], requestMethods: ['get', 'post'] },
    { id: 'api', title: 'API debug', enabled: true, requestHeaders: [h('X-Debug', '1')], responseHeaders: [],
      filters: [{ id: 'f3', enabled: true, kind: 'include', pattern: '||api.example.com^', isRegex: false }] },
    { id: 'mobile', title: 'Mobile Safari', enabled: false, responseHeaders: [], filters: [],
      requestHeaders: [h('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')] },
  ],
};
await ctl.evaluate(`chrome.storage.local.set({ state: ${JSON.stringify(state)} })`);
await sleep(1000);
await site.send('Page.reload');
await sleep(1500);

// from / to: CSS selectors; the shot is cut from the top of `from` to the bottom of
// `to`, so a long popup isn't shrunk into unreadable text on the 1280x800 image.
async function capture(url, name, { width = 560, dark = false, prepare = '', from, to } = {}) {
  const t = await openTab(PORT, 'about:blank');
  await t.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 2, mobile: false });
  await t.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await t.send('Page.navigate', { url });
  await sleep(1500);
  if (prepare) { await t.evaluate(prepare); await sleep(700); }
  const height = await t.evaluate('Math.ceil(document.documentElement.scrollHeight)');
  await t.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  let clip;
  if (from || to) {
    const [top, bottom] = await t.evaluate(`[
      ${from ? `document.querySelector(${JSON.stringify(from)}).getBoundingClientRect().top - 4` : '0'},
      ${to ? `document.querySelector(${JSON.stringify(to)}).getBoundingClientRect().bottom + 4` : String(height)},
    ]`);
    clip = { x: 0, y: Math.max(0, top), width, height: Math.min(height, bottom) - Math.max(0, top), scale: 1 };
  }
  const { data } = await t.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
  writeFileSync(join(raw, `${name}.png`), Buffer.from(data, 'base64'));
  await t.send('Page.close').catch(() => {});
  return join(raw, `${name}.png`);
}

const click = text => `[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})).click()`;
const curl = [
  "curl --url 'https://app.example.com/api/orders?page=1'",
  "-H 'accept: application/json'",
  "-H 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiJ9.c2lnbmF0dXJl'",
  "-b 'session=7f3a9c2e; theme=dark'",
  "-H 'x-tenant: acme'",
  "-H 'x-request-id: 5d1c0b52-8f0e-4c55-9a43-0c1f6d2b9e17'",
  "-H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)'",
].join(' \\\n  ');
const pasteJs = `(async () => {
  ${click('Paste from DevTools')};
  await new Promise(r => setTimeout(r, 200));
  const ta = [...document.querySelectorAll('textarea')].find(t => t.placeholder.includes('Copy as cURL'));
  ta.value = ${JSON.stringify(curl)};
  ta.dispatchEvent(new Event('input'));
})()`;
const qaJs = `(async () => {
  [...document.querySelectorAll('nav.tabs button')].find(b => b.textContent.trim() === 'QA user 42').click();
  await new Promise(r => setTimeout(r, 200));
  document.querySelector('details.more').open = true;
})()`;

// ModHeader's folder (a real LevelDB written by Chrome with demo profiles), unpacked for the file input.
const mh = join(work, 'modheader-folder');
mkdirSync(mh, { recursive: true });
for (const f of readdirSync('scripts/store/modheader-demo')) {
  writeFileSync(join(mh, f.replace(/\.gz$/, '')), gunzipSync(readFileSync(join('scripts/store/modheader-demo', f))));
}
async function captureMigrate(name, dark) {
  const t = await openTab(PORT, 'about:blank');
  await t.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 600, deviceScaleFactor: 2, mobile: false });
  await t.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  await t.send('Page.navigate', { url: `chrome-extension://${extId}/src/migrate/index.html` });
  await sleep(1200);
  const { result } = await t.send('Runtime.evaluate', { expression: `document.querySelector('input[type=file]')` });
  await t.send('DOM.setFileInputFiles', { objectId: result.objectId, files: [mh] });
  await sleep(1500);
  const height = await t.evaluate('Math.ceil(document.querySelector("main").scrollHeight)');
  await t.send('Emulation.setDeviceMetricsOverride', { width: 760, height, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  const { data } = await t.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(raw, `${name}.png`), Buffer.from(data, 'base64'));
  await t.send('Page.close').catch(() => {});
  return join(raw, `${name}.png`);
}

const shots = {
  main: await capture(`${popupUrl}?tab=${siteTab}`, 'popup-main'),
  thisTab: await capture(`${popupUrl}?tab=${siteTab}`, 'popup-this-tab-dark', { dark: true, from: '.bar', to: 'nav.tabs' }),
  paste: await capture(`${popupUrl}?tab=${siteTab}`, 'popup-paste', { prepare: pasteJs, from: 'nav.tabs', to: '.import' }),
  filters: await capture(`${popupUrl}?tab=${siteTab}`, 'popup-filters-dark', { prepare: qaJs, dark: true, from: 'nav.tabs', to: 'details.more' }),
  migrate: await captureMigrate('migrate', false),
};

// --- layout: caption on the left, the real UI on the right
const icon = `data:image/png;base64,${readFileSync('public/icons/icon-128.png').toString('base64')}`;
const img = file => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
const page = (w, h, body) => `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; font-family: 'Segoe UI', system-ui, sans-serif;
         background: linear-gradient(135deg, #eef3ff 0%, #dfe8ff 100%); color: #10203f; display: flex; align-items: center; }
  .text { flex: 0 0 440px; padding: 0 40px 0 72px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 20px; color: #2b4aa8; margin-bottom: 28px; }
  .brand img { width: 40px; height: 40px; margin: -4px; }
  h1 { font-size: 40px; line-height: 1.15; margin: 0 0 18px; letter-spacing: -0.5px; }
  p { font-size: 19px; line-height: 1.45; margin: 0; color: #3a4a6b; }
  .shot { flex: 1; height: 100%; display: flex; align-items: center; justify-content: center; padding: 40px 48px 40px 0; }
  .shot img { max-width: 100%; max-height: 100%; border-radius: 10px; box-shadow: 0 18px 50px #1b2b5a40, 0 2px 6px #1b2b5a30; background: #fff; }
</style></head><body>${body}</body></html>`;
const poster = (title, text, file) => page(1280, 800, `
  <div class="text"><div class="brand"><img src="${icon}">Headerwise</div><h1>${title}</h1><p>${text}</p></div>
  <div class="shot"><img src="${img(file)}"></div>`);

const screens = [
  ['1-headers', 'Change HTTP headers. Nothing leaves your browser.', 'Set, append or remove request and response headers per profile. No account, no analytics, and the browser itself blocks the extension from sending anything.', shots.main],
  ['2-this-tab', 'See what changed on this tab, and why not.', 'Open the popup to see which profile changed how many requests here, or which filter kept it off. In light or dark.', shots.thisTab],
  ['3-modheader', 'Coming from ModHeader? Bring your profiles.', 'ModHeader was turned off, and its Export button with it. Headerwise reads its folder on your disk, right in the page.', shots.migrate],
  ['4-paste', 'Paste a request from DevTools.', 'Copy as cURL, fetch or PowerShell, paste, and the headers are in. Tokens and cookies stay hidden while you share your screen.', shots.paste],
  ['5-filters', 'Only where you need it.', 'Limit a profile to some sites, request types or methods, keep it off others, or bind it to a single tab.', shots.filters],
];

const render = async (html, w, h, file) => {
  const htmlFile = join(work, `${file.split(/[\\/]/).pop()}.html`);
  writeFileSync(htmlFile, html);
  const t = await openTab(PORT, 'about:blank');
  await t.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await t.send('Page.navigate', { url: pathToFileURL(htmlFile).href });
  await sleep(800);
  const { data } = await t.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
  await t.send('Page.close').catch(() => {});
};

for (const [name, title, text, file] of screens) {
  await render(poster(title, text, file), 1280, 800, join(out, 'screenshots', `${name}.png`));
}

const tile = (w, h, size) => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; width: ${w}px; height: ${h}px; display: flex; align-items: center; gap: ${size / 3}px; padding: 0 ${size / 2}px; box-sizing: border-box;
         font-family: 'Segoe UI', system-ui, sans-serif; background: linear-gradient(135deg, #2f6df6 0%, #1d4ed8 100%); color: #fff; overflow: hidden; }
  img { width: ${size}px; height: ${size}px; filter: drop-shadow(0 6px 14px #0003); }
  b { display: block; font-size: ${size * 0.42}px; letter-spacing: -0.5px; }
  span { display: block; font-size: ${size * 0.2}px; opacity: .92; margin-top: 6px; line-height: 1.3; }
</style></head><body><img src="${icon}"><div><b>Headerwise</b><span>Modify HTTP headers.<br>Nothing leaves your browser.</span></div></body></html>`;
await render(tile(440, 280, 96), 440, 280, join(out, 'promo-small-440x280.png'));
await render(tile(1400, 560, 200), 1400, 560, join(out, 'promo-marquee-1400x560.png'));

proc.stdio[3].write(JSON.stringify({ id: 2, method: 'Browser.close' }) + '\0');
await sleep(1500);
proc.kill();
demo.close();
ctl.close();
site.close();
console.log('written to', out);
process.exit(0);
