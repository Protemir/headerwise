// Redirects in a real browser: page navigation, fetch, regex groups, "never on",
// the popup's form and "On this tab".
import { openTab, sleep } from './cdp.mjs';

const prof = (title, over = {}) => ({ id: title, title, enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });
const redirect = (from, to, isRegex = false) => ({ id: `${from}->${to}`, enabled: true, from, to, isRegex });

async function save(ctl, profiles) {
  await ctl.evaluate(`chrome.storage.local.set({ state: ${JSON.stringify({ version: 1, paused: false, profiles })} })`);
  await sleep(800);
}

async function go(tab, url) {
  await tab.send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (await tab.evaluate(`document.readyState === 'complete' && location.href !== 'about:blank'`).catch(() => false)) break;
  }
  await sleep(200);
  return tab.evaluate('location.href');
}

export async function redirectChecks({ ctl, page, port }, { base, extId, requests }, check) {
  await save(ctl, [prof('Redirects', {
    redirects: [redirect('/old/', '/new/'), redirect('/v(\\d+)/', '/v$1-beta/', true)],
    filters: [{ id: 'keep', enabled: true, kind: 'exclude', pattern: '/old/keep', isRegex: true }],
  })]);

  const before = requests.length;
  const landed = await go(page, `${base}/old/page?x=1`);
  const seen = requests.slice(before);
  check('redirect: page navigation lands on the new address', landed === `${base}/new/page?x=1` && seen.includes('/new/page?x=1'), JSON.stringify({ landed, seen }));

  const url = await page.evaluate(`fetch('${base}/v2/orders').then(r => r.json()).then(j => j.url)`);
  check('redirect: fetch with regex groups ($1)', url === '/v2-beta/orders', url);

  const kept = await go(page, `${base}/old/keep`);
  check('redirect: "never on" keeps it off', kept === `${base}/old/keep`, kept);

  // "On this tab" counts redirected requests for the profile.
  await go(page, `${base}/old/again`);
  const tabId = await ctl.evaluate(`chrome.tabs.query({ url: '${base}/*' }).then(t => t[0]?.id)`);
  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html?tab=${tabId}`);
  await sleep(1200);
  const line = await popup.evaluate(`document.querySelector('.here .lines li')?.innerText.trim() ?? ''`);
  check('redirect: "On this tab" counts redirected requests', /^Redirects changed \d+ requests?/.test(line), line);

  // Adding one in the popup.
  await save(ctl, [prof('Form')]);
  await popup.send('Page.reload');
  await sleep(1200);
  await popup.evaluate(`(async () => {
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '+ redirect').click();
    await new Promise(r => setTimeout(r, 200));
    const inputs = [...document.querySelectorAll('input[placeholder^="part of the URL"], input[placeholder^="e.g. api.staging"]')];
    inputs[0].value = 'prod.example.com'; inputs[0].dispatchEvent(new Event('input'));
    inputs[1].value = 'staging.example.com'; inputs[1].dispatchEvent(new Event('input'));
  })()`);
  await sleep(900);
  const saved = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles[0].redirects)`);
  const rules = await ctl.evaluate(`chrome.declarativeNetRequest.getDynamicRules().then(r => r.filter(x => x.action.type === 'redirect').length)`);
  check('redirect: added in the popup, saved and turned into a rule',
    saved?.length === 1 && saved[0].from === 'prod.example.com' && saved[0].to === 'staging.example.com' && rules === 1, JSON.stringify({ saved, rules }));
  await popup.send('Page.close').catch(() => {});
}
