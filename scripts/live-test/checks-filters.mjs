// Site / request type / method filters, and export + import, in a real browser.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openTab, sleep } from './cdp.mjs';

const hdr = (name, value) => ({ id: `${name}-${value}`, enabled: true, name, value, op: 'set' });
const prof = (title, over = {}) => ({ id: title, title, enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });

async function save(ctl, profiles) {
  await ctl.evaluate(`chrome.storage.local.set({ state: ${JSON.stringify({ version: 1, paused: false, profiles })} })`);
  await sleep(800);
}

async function go(tab, url) {
  await tab.send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (await tab.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`).catch(() => false)) return;
  }
}

// Fire a request from the page; the echo server records what it got.
const send = (tab, url, init = {}) => tab.evaluate(`fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(() => 'ok', e => 'failed: ' + e.message)`);

export async function filterChecks({ ctl, page, port }, { base, ip, saw, extId }, check) {
  // Methods
  await save(ctl, [prof('Posts only', { requestHeaders: [hdr('X-M', '1')], requestMethods: ['post'] })]);
  await go(page, `${base}/start`);
  await send(page, `${base}/m-get`);
  await send(page, `${base}/m-post`, { method: 'POST', body: 'x' });
  check('methods: POST gets the header, GET does not', saw('/m-post')?.['x-m'] === '1' && !('x-m' in (saw('/m-get') ?? {})), JSON.stringify({ get: saw('/m-get')?.['x-m'], post: saw('/m-post')?.['x-m'] }));

  // "On this tab" for a profile limited to POST, after a page load with GET only
  const tabId = await ctl.evaluate(`chrome.tabs.query({ url: '${base}/start' }).then(t => t[0]?.id)`);
  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html?tab=${tabId}`);
  await sleep(1200);
  const line = await popup.evaluate(`document.querySelector('.here .lines li')?.innerText.trim() ?? ''`);
  check('"On this tab" explains the method limit', /^Posts only (changed \d+ request|only POST requests)/.test(line), line);

  // The popup controls
  await popup.evaluate(`(async () => {
    document.querySelector('details.more').open = true;
    const tick = text => [...document.querySelectorAll('.checks label')].find(l => l.innerText.trim() === text).querySelector('input').click();
    tick('fetch / XHR');
    tick('PUT');
    const from = [...document.querySelectorAll('.more .row')].find(r => r.innerText.includes('Only from sites')).querySelector('input');
    from.value = 'App.io, x.io';
    from.dispatchEvent(new Event('change'));
  })()`);
  await sleep(800);
  const saved = await ctl.evaluate(`chrome.storage.local.get('state').then(s => { const p = s.state.profiles[0]; return [p.resourceTypes, p.requestMethods, p.initiatorDomains]; })`);
  check('popup: type, method and site filters saved', JSON.stringify(saved) === JSON.stringify([['xmlhttprequest'], ['post', 'put'], ['App.io', 'x.io']]), JSON.stringify(saved));
  await popup.send('Page.close').catch(() => {});

  // Resource types
  await save(ctl, [prof('XHR only', { requestHeaders: [hdr('X-T', '1')], resourceTypes: ['xmlhttprequest'] })]);
  await go(page, `${base}/t-nav`);
  await send(page, `${base}/t-xhr`);
  check('types: fetch gets the header, the page itself does not', saw('/t-xhr')?.['x-t'] === '1' && !('x-t' in (saw('/t-nav') ?? {})), JSON.stringify({ nav: saw('/t-nav')?.['x-t'], xhr: saw('/t-xhr')?.['x-t'] }));

  // Initiator ("from sites")
  await save(ctl, [
    prof('From IP', { requestHeaders: [hdr('X-I', '1')], initiatorDomains: ['127.0.0.1'] }),
    prof('Not from IP', { requestHeaders: [hdr('X-N', '1')], excludedInitiatorDomains: ['127.0.0.1'] }),
  ]);
  await go(page, `${ip}/start`);
  await send(page, `${base}/i-from-ip`, { mode: 'no-cors' });
  await go(page, `${base}/start`);
  await send(page, `${base}/i-from-localhost`);
  await go(page, `${base}/i-typed`);
  const a = saw('/i-from-ip') ?? {}, b = saw('/i-from-localhost') ?? {}, c = saw('/i-typed') ?? {};
  check('from sites: applied to requests made by pages on that site only', a['x-i'] === '1' && !('x-i' in b) && !('x-i' in c), JSON.stringify([a['x-i'], b['x-i'], c['x-i']]));
  check('never from sites: skipped for requests made by pages on that site', !('x-n' in a) && b['x-n'] === '1', JSON.stringify([a['x-n'], b['x-n']]));
}

export async function exportChecks({ ctl, port }, { extId, root }, check) {
  await save(ctl, [
    prof('Staging', { requestHeaders: [hdr('Authorization', 'Bearer top-secret'), hdr('X-Env', 'staging')], requestMethods: ['post'] }),
    prof('Other', { requestHeaders: [hdr('X-O', '1')] }),
  ]);
  const dir = join(root, 'downloads');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { connect } = await import('./cdp.mjs');
  const browser = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });

  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html`);
  await sleep(1200);
  await popup.evaluate(`(async () => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Export…').click();
    await new Promise(r => setTimeout(r, 200));
    [...document.querySelectorAll('.export label')].find(l => l.innerText.trim() === 'Other').querySelector('input').click();
    await new Promise(r => setTimeout(r, 100));
    [...document.querySelectorAll('.export button')].find(b => b.textContent.startsWith('Download')).click();
  })()`);
  let file;
  for (let i = 0; i < 30 && !file; i++) {
    await sleep(200);
    file = readdirSync(dir).find(f => f.endsWith('.json'));
  }
  const text = file && existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : '';
  let data = null;
  try { data = JSON.parse(text); } catch { /* checked below */ }
  check('export: downloads a JSON file with the chosen profile only', /^headerwise-profiles-\d{4}-\d\d-\d\d\.json$/.test(file ?? '') && data?.format === 'headerwise' && data.profiles.length === 1 && data.profiles[0].title === 'Staging', JSON.stringify({ file, n: data?.profiles?.length }));
  check('export: secret value left out, the rest kept', data?.profiles[0].requestHeaders.map(h => h.value).join('|') === '|staging' && data.profiles[0].requestMethods[0] === 'post', JSON.stringify(data?.profiles?.[0]?.requestHeaders));

  // And back in, through the popup's import box.
  await save(ctl, [prof('Existing', { requestHeaders: [hdr('X-E', '1')] })]);
  await popup.send('Page.reload');
  await sleep(1200);
  await popup.evaluate(`(async () => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Import JSON').click();
    await new Promise(r => setTimeout(r, 200));
    const ta = document.querySelector('.import textarea');
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 100));
    [...document.querySelectorAll('.import button')].find(b => b.textContent.trim() === 'Import').click();
  })()`);
  await sleep(1000);
  const after = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles.map(p => p.title + ':' + p.requestHeaders.map(h => h.name).join(',')))`);
  const warning = await popup.evaluate(`[...document.querySelectorAll('.notes li')].map(li => li.innerText).join(' ')`);
  check('import: exported file comes back next to existing profiles', JSON.stringify(after) === JSON.stringify(['Existing:X-E', 'Staging:Authorization,X-Env']), JSON.stringify(after));
  check('import: asks to fill in the secret that was left out', /fill them in: "Staging" → Authorization/.test(warning), warning);
  await popup.send('Page.close').catch(() => {});
  browser.close();
}

// Requestly and Simple Modify Headers exports, through the popup's import box,
// and what the server then receives.
export async function otherImportChecks({ ctl, page, port }, { base, saw, extId }, check) {
  await save(ctl, [prof('Profile 1', { requestHeaders: [hdr('', '')] })]);
  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html`);
  await sleep(1200);
  const importText = async text => {
    await popup.evaluate(`(async () => {
      if (!document.querySelector('.import textarea')) [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Import JSON').click();
      await new Promise(r => setTimeout(r, 200));
      const ta = document.querySelector('.import textarea');
      ta.value = ${JSON.stringify(text)};
      ta.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 100));
      [...document.querySelectorAll('.import button')].find(b => b.textContent.trim() === 'Import').click();
    })()`);
    await sleep(1200);
  };
  const requestly = [
    { id: 'Headers_1', objectType: 'rule', ruleType: 'Headers', name: 'RQ', status: 'Active', groupId: '', version: 2,
      pairs: [{ source: { key: 'Url', operator: 'Contains', value: '/rq-', filters: [] }, modifications: { Request: [{ header: 'X-Rq', type: 'Modify', value: 'yes' }], Response: [] } }] },
  ];
  await importText(JSON.stringify(requestly));
  const smh = { format_version: '1.2', target_page: '', use_url_contains: true, headers: [{ url_contains: '/smh-', action: 'add', header_name: 'X-Smh', header_value: 'yes', comment: '', apply_on: 'req', status: 'on' }] };
  await importText(JSON.stringify(smh));
  await go(page, `${base}/start`);
  for (const path of ['/rq-1', '/smh-1', '/plain-1']) await send(page, `${base}${path}`);
  await sleep(300);
  const got = Object.fromEntries(['/rq-1', '/smh-1', '/plain-1'].map(p => [p, [saw(p)?.['x-rq'] ?? '-', saw(p)?.['x-smh'] ?? '-'].join(',')]));
  check('import: Requestly and Simple Modify Headers exports work, each only where it did before',
    JSON.stringify(got) === JSON.stringify({ '/rq-1': 'yes,-', '/smh-1': '-,yes', '/plain-1': '-,-' }), JSON.stringify(got));
  await popup.send('Page.close').catch(() => {});
}

// Headers Headerwise adds don't make cross-origin requests "non-simple": no CORS
// preflight, so third-party fonts and scripts keep loading (headers a page or
// CDP's setExtraHTTPHeaders adds do trigger one). And a secret header with no
// site limit gets a warning with a one-click fix.
export async function corsAndSecretChecks({ ctl, page, port }, { base, ip, saw, extId }, check) {
  await save(ctl, [prof('Everywhere', { requestHeaders: [hdr('X-Cors-Test', '1'), hdr('Authorization', 'Bearer t')] })]);
  await go(page, `${base}/cors-page`);
  await send(page, `${ip}/cors-third-party`);
  await sleep(300);
  const got = saw('/cors-third-party') ?? {};
  check('cors: an added header causes no preflight, the third-party request goes through as is',
    got[':method'] === 'GET' && got['x-cors-test'] === '1', JSON.stringify({ method: got[':method'], header: got['x-cors-test'] }));

  const siteId = await ctl.evaluate(`chrome.tabs.query({ url: '${base}/cors-page' }).then(t => t[0].id)`);
  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html?tab=${siteId}`);
  await sleep(1200);
  const hint = await popup.evaluate(`document.querySelector('.secret-hint')?.innerText ?? ''`);
  await popup.evaluate(`document.querySelector('.secret-hint button')?.click()`);
  await sleep(800);
  const filters = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles[0].filters.map(f => f.pattern))`);
  const gone = await popup.evaluate(`!document.querySelector('.secret-hint')`);
  check('secret everywhere: warned, "Only on <site>" limits it in one click',
    /^Authorization goes to every site/.test(hint) && filters.join() === '||localhost^' && gone, JSON.stringify({ hint, filters, gone }));
  await popup.send('Page.close').catch(() => {});
}

// A page can't put headers on a WebSocket handshake (new WebSocket() takes none);
// the extension's rules do, which is what header-routed dev tools need.
export async function websocketChecks({ ctl, page }, { base, ip, saw }, check) {
  await save(ctl, [prof('Sandbox', { requestHeaders: [hdr('X-Sandbox-ID', 'sandbox-example')], filters: [{ id: 'f', enabled: true, kind: 'include', pattern: '||127.0.0.1^', isRegex: false }] })]);
  await go(page, `${base}/ws-page`);
  const state = await page.evaluate(`new Promise(ok => { const ws = new WebSocket('${ip.replace('http', 'ws')}/terminal'); ws.onopen = () => ok('open'); ws.onerror = () => ok('error'); setTimeout(() => ok('timeout'), 3000); })`);
  const got = saw('/terminal') ?? {};
  check('websocket: the handshake carries the header', state === 'open' && got[':method'] === 'UPGRADE' && got['x-sandbox-id'] === 'sandbox-example', JSON.stringify({ state, got: { method: got[':method'], header: got['x-sandbox-id'] } }));
}
