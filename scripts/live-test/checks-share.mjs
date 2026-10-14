// Share links: made in the popup, opened on the share page (docs/share.html, served
// here by the echo server), handed to the extension with one click, and pasted
// into Import JSON.
import { openTab, sleep } from './cdp.mjs';

const hdr = (name, value) => ({ id: `${name}-${value}`, enabled: true, name, value, op: 'set' });
const prof = (title, over = {}) => ({ id: title, title, enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });
const SHARE_PAGE = 'https://protemir.github.io/headerwise/share';

async function save(ctl, profiles) {
  await ctl.evaluate(`chrome.storage.local.set({ state: ${JSON.stringify({ version: 1, paused: false, profiles })} })`);
  await sleep(800);
}

const profiles = ctl => ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles.map(p => ({
  title: p.title, on: p.enabled, redirects: (p.redirects ?? []).length,
  headers: p.requestHeaders.map(h => h.name + '=' + h.value + (h.enabled ? '' : ' (off)')).join('|'),
})))`);

export async function shareChecks({ ctl, page, port }, { base, ip, extId }, check) {
  await save(ctl, [prof('Shared', {
    requestHeaders: [hdr('Authorization', 'Bearer top-secret'), hdr('X-Shared', 'yes')],
    redirects: [{ id: 'r', enabled: true, from: 'api.example.com', to: 'localhost:3000', isRegex: false }],
  })]);
  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html`);
  await sleep(1200);
  const link = await popup.evaluate(`(async () => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Export…').click();
    await new Promise(r => setTimeout(r, 200));
    [...document.querySelectorAll('.export button')].find(b => b.textContent.trim() === 'Copy link').click();
    for (let i = 0; i < 30 && !document.querySelector('.share-url'); i++) await new Promise(r => setTimeout(r, 100));
    return document.querySelector('.share-url')?.value ?? '';
  })()`);
  check('share: the popup makes a link to the share page', link.startsWith(`${SHARE_PAGE}#1.`), link);

  // The test copy of the extension lets localhost message it, as the real one lets the site.
  const at = origin => link.replace(SHARE_PAGE, `${origin}/headerwise/share.html?id=${extId}`);
  await page.send('Page.navigate', { url: at(base) });
  await sleep(1200);
  const text = await page.evaluate('document.body.innerText');
  check('share page: shows what the link holds, no secret value, warns about the redirect',
    /Shared profile: Shared/.test(text) && /X-Shared\s+yes/.test(text) && !/top-secret/.test(text) && /secret, not in the link/.test(text) && /sends requests to other addresses/.test(text), text);

  await page.evaluate(`document.getElementById('add').click()`);
  let after = [];
  for (let i = 0; i < 30 && after.length < 2; i++) {
    await sleep(200);
    after = await profiles(ctl);
  }
  const status = await page.evaluate(`document.getElementById('status').textContent`);
  check('share page: "Add to Headerwise" adds the profile switched off, its secret empty',
    after.length === 2 && after[1].title === 'Shared' && after[1].on === false && after[1].headers === 'Authorization= (off)|X-Shared=yes' && after[1].redirects === 1 && /^Done/.test(status),
    JSON.stringify({ after, status }));
  // The editor that opened for it.
  for (const t of await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) {
    if (t.url.includes('shared=1')) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
  }

  // Any other site: the extension can't be reached from it.
  await page.send('Page.navigate', { url: at(ip) });
  await sleep(1200);
  const elsewhere = await page.evaluate('document.body.innerText');
  check('share page: from another site the extension is out of reach, the page says how to add the profiles', /isn't installed/.test(elsewhere) && /Import JSON/.test(elsewhere), elsewhere);

  // Pasted into Import JSON.
  await save(ctl, [prof('Existing', { requestHeaders: [hdr('X-E', '1')] })]);
  await popup.send('Page.reload');
  await sleep(1200);
  await popup.evaluate(`(async () => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Import JSON').click();
    await new Promise(r => setTimeout(r, 200));
    const ta = document.querySelector('.import textarea');
    ta.value = ${JSON.stringify(link)};
    ta.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 100));
    [...document.querySelectorAll('.import button')].find(b => b.textContent.trim() === 'Import').click();
  })()`);
  await sleep(1000);
  after = await profiles(ctl);
  const notes = await popup.evaluate(`[...document.querySelectorAll('.notes li')].map(li => li.innerText).join(' ')`);
  check('share: a link pasted into Import JSON comes in switched off, and says so',
    after.length === 2 && after[1].title === 'Shared' && after[1].on === false && /switched off: check their headers and redirects/.test(notes), JSON.stringify({ after, notes }));
  await popup.send('Page.close').catch(() => {});
}
