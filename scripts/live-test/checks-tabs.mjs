// "Only this tab" and hidden secret values, in a real browser.
import { openTab, sleep } from './cdp.mjs';

const hdr = (name, value) => ({ id: `${name}-${value}`, enabled: true, name, value, op: 'set' });
const prof = (title, over = {}) => ({ id: title, title, enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });

async function save(ctl, profiles) {
  await ctl.evaluate(`chrome.storage.local.set({ state: ${JSON.stringify({ version: 1, paused: false, profiles })} })`);
  await sleep(800);
}

async function seen(tab, url) {
  await tab.send('Page.navigate', { url });
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (await tab.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`).catch(() => false)) break;
  }
  const text = await tab.evaluate('document.body.innerText');
  return JSON.parse(text.slice(text.indexOf('{'))).headers;
}

const tabIdOf = (ctl, url) => ctl.evaluate(`chrome.tabs.query({ url: ${JSON.stringify(url)} }).then(t => t[0]?.id)`);

export async function tabOnlyChecks({ ctl, page, port }, { base, extId }, check) {
  await seen(page, `${base}/bound`);
  const pageTab = await tabIdOf(ctl, `${base}/bound`);

  await save(ctl, [prof('Bound', { requestHeaders: [hdr('X-Tab', 'yes')], tab: { id: pageTab, host: 'localhost:8787' } }), prof('Global', { requestHeaders: [hdr('X-G', '1')] })]);
  const sessionRules = await ctl.evaluate('chrome.declarativeNetRequest.getSessionRules().then(r => r.map(x => x.condition.tabIds))');
  check('only this tab: rule goes to session rules with the tab id', JSON.stringify(sessionRules) === JSON.stringify([[pageTab]]), JSON.stringify(sessionRules));
  const here = await seen(page, `${base}/bound`);
  check('only this tab: applied in its tab', here['x-tab'] === 'yes' && here['x-g'] === '1', JSON.stringify(here));
  const other = await openTab(port, 'about:blank');
  const there = await seen(other, `${base}/other`);
  check('only this tab: not applied in another tab, global profile still is', !('x-tab' in there) && there['x-g'] === '1', JSON.stringify(there));
  await other.send('Page.close').catch(() => {});

  // Closing the tab drops the binding and turns the profile off.
  const doomed = await openTab(port, 'about:blank');
  await seen(doomed, `${base}/doomed`);
  const doomedId = await tabIdOf(ctl, `${base}/doomed`);
  await save(ctl, [prof('Doomed', { requestHeaders: [hdr('X-D', '1')], tab: { id: doomedId, host: 'localhost:8787' } })]);
  await doomed.send('Page.close').catch(() => {});
  await sleep(1500);
  const after = await ctl.evaluate(`Promise.all([chrome.storage.local.get('state'), chrome.declarativeNetRequest.getSessionRules()]).then(([s, r]) => ({ p: s.state.profiles[0], rules: r.length }))`);
  check('only this tab: closing the tab turns the profile off and removes its rule', after.p.enabled === false && !after.p.tab && after.rules === 0, JSON.stringify(after));

  // The popup button.
  await save(ctl, [prof('Pick me', { requestHeaders: [hdr('X-P', '1')] })]);
  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html?tab=${pageTab}`);
  await sleep(1200);
  await popup.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Only this tab').click()`);
  await sleep(800);
  const bound = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles[0].tab)`);
  const chip = await popup.evaluate(`document.querySelector('.chip')?.innerText.trim() ?? ''`);
  check('only this tab: popup button binds the profile to the tab', bound?.id === pageTab && /only in this tab · localhost:8787/.test(chip), JSON.stringify({ bound, chip }));
  const report = await popup.evaluate(`(async () => { await new Promise(r => setTimeout(r, 300)); return [...document.querySelectorAll('.here .lines li')].map(li => li.innerText.trim()); })()`);
  check('only this tab: "On this tab" still reports it', report.length === 1 && /^Pick me /.test(report[0]), JSON.stringify(report));
  await popup.send('Page.close').catch(() => {});
}

export async function secretChecks({ ctl, port }, { extId }, check) {
  await save(ctl, [prof('S', { requestHeaders: [hdr('Authorization', 'Bearer top-secret'), hdr('X-Env', 'dev')] })]);
  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html`);
  await sleep(1200);
  const state = () => popup.evaluate(`[...document.querySelectorAll('input[placeholder=Value]')].map(i => getComputedStyle(i).webkitTextSecurity)`);
  check('secrets: Authorization shown as dots, X-Env in clear', JSON.stringify(await state()) === JSON.stringify(['disc', 'none']), JSON.stringify(await state()));
  await popup.evaluate(`document.querySelector('button.icon[title="Show value"]').click()`);
  await sleep(200);
  check('secrets: 👁 reveals the value', (await state())[0] === 'none', JSON.stringify(await state()));
  await popup.evaluate(`[...document.querySelectorAll('button.icon')].filter(b => b.textContent === '🔒')[1].click()`);
  await sleep(800);
  const flag = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles[0].requestHeaders[1].secret)`);
  check('secrets: 🔒 marks another header as secret and saves it', (await state())[1] === 'disc' && flag === true, JSON.stringify({ s: await state(), flag }));
  await popup.send('Page.close').catch(() => {});
}
