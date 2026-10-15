// Sync through the browser's account, in a real browser. Not signed in, Chrome
// keeps chrome.storage.sync locally, which is enough to see what Headerwise writes
// there and what it does when "another computer" writes there.
import { openTab, sleep } from './cdp.mjs';

const hdr = (name, value) => ({ id: `h-${name}`, enabled: true, name, value, op: 'set' });
const prof = (id, title, over = {}) => ({ id, title, enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });

const until = async (fn, ms = 6000) => {
  let v;
  for (let i = 0; i < ms / 200; i++) {
    v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return v;
};

export async function syncChecks({ ctl, port }, { extId }, check) {
  await ctl.evaluate(`chrome.storage.sync.clear().then(() => chrome.storage.local.get('meta')).then(m => chrome.storage.local.set({ meta: { ...m.meta, sync: false }, syncBase: { profiles: {}, order: [] }, state: ${JSON.stringify({ version: 1, paused: false, profiles: [
    prof('a', 'Staging', { requestHeaders: [hdr('Authorization', 'Bearer top-secret'), hdr('X-Env', 'staging')] }),
  ] })} }))`);
  await sleep(800);
  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html`);
  await sleep(1200);
  await popup.evaluate(`document.querySelector('.sync input').click()`);
  const synced = await until(() => ctl.evaluate(`chrome.storage.sync.get(null).then(s => s['hw:p:a'] ? s : null)`));
  check('sync: switched on in the popup, the profile goes to sync storage without its secret',
    synced?.['hw:order']?.order?.join() === 'a' && synced['hw:p:a'].requestHeaders.map(h => h.value).join('|') === '|staging' && !JSON.stringify(synced).includes('top-secret') && !('enabled' in synced['hw:p:a']),
    JSON.stringify(synced));
  const line = await until(() => popup.evaluate(`document.querySelector('.sync .dim')?.textContent ?? ''`));
  check('sync: the popup says when it last synced', /synced at/.test(line), line);

  // "Another computer": renames this profile and adds one.
  await ctl.evaluate(`chrome.storage.sync.set({
    'hw:p:a': { ...${JSON.stringify(synced['hw:p:a'])}, title: 'Staging (renamed)' },
    'hw:p:b': ${JSON.stringify({ id: 'b', title: 'From the laptop', requestHeaders: [hdr('X-Laptop', '1')], responseHeaders: [], filters: [] })},
    'hw:order': { v: 1, order: ['a', 'b'] },
  })`);
  const got = await until(() => ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles.length === 2 && s.state.profiles[0].title.includes('renamed') ? s.state.profiles : null)`));
  check('sync: changes from another computer come in; the new profile off, this one keeps its secret and stays on',
    got?.[0].enabled === true && got[0].requestHeaders[0].value === 'Bearer top-secret' && got[1].title === 'From the laptop' && got[1].enabled === false,
    JSON.stringify(got));

  // Deleted on the other computer.
  await ctl.evaluate(`chrome.storage.sync.set({ 'hw:p:b': { id: 'b', deleted: Date.now() }, 'hw:order': { v: 1, order: ['a'] } })`);
  const left = await until(() => ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles.length === 1 ? s.state.profiles.map(p => p.title) : null)`));
  check('sync: a profile deleted on another computer goes here too', left?.join() === 'Staging (renamed)', JSON.stringify(left));

  // Switched off: an edit here stays here.
  await popup.send('Page.reload');
  await sleep(1200);
  await popup.evaluate(`document.querySelector('.sync input').click()`);
  await sleep(500);
  await ctl.evaluate(`chrome.storage.local.get('state').then(s => { s.state.profiles[0].title = 'Local only'; return chrome.storage.local.set(s); })`);
  await sleep(2500);
  const remote = await ctl.evaluate(`chrome.storage.sync.get('hw:p:a').then(s => s['hw:p:a'].title)`);
  check('sync: switched off, nothing more is sent', remote === 'Staging (renamed)', remote);
  await popup.send('Page.close').catch(() => {});
  await ctl.evaluate(`chrome.storage.sync.clear()`);
}
