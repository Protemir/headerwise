// Variables, profile list handling, toolbar tooltip, shortcuts and the welcome page.
import { openTab, sleep } from './cdp.mjs';

const hdr = (name, value) => ({ id: `${name}-${value}`, enabled: true, name, value, op: 'set' });
const prof = (title, over = {}) => ({ id: title, title, enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });

async function save(ctl, profiles, paused = false) {
  await ctl.evaluate(`chrome.storage.local.set({ state: ${JSON.stringify({ version: 1, paused, profiles })} })`);
  await sleep(800);
}

const fetchSeen = (tab, url) => tab.evaluate(`fetch(${JSON.stringify(url)}).then(r => r.json()).then(j => j.headers)`);

export async function variableChecks({ ctl, page }, { base }, check) {
  await save(ctl, [prof('Vars', { requestHeaders: [hdr('X-Id', '{{uuid}}'), hdr('X-T', '{{timestamp}}'), hdr('X-Day', 'd={{date}}')] })]);
  await page.send('Page.navigate', { url: `${base}/vars` });
  await sleep(800);
  const a = await fetchSeen(page, `${base}/v1`);
  const t = Number(a['x-t']);
  check('variables: {{uuid}}, {{timestamp}}, {{date}} filled in',
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a['x-id'] ?? '') && Math.abs(Date.now() - t) < 120000 && a['x-day'] === `d=${new Date().toISOString().slice(0, 10)}`,
    JSON.stringify([a['x-id'], a['x-t'], a['x-day']]));
  const alarm = await ctl.evaluate(`chrome.alarms.get('refresh-variables').then(a => a ? a.periodInMinutes : null)`);
  check('variables: a refresh every minute is scheduled', alarm === 1, String(alarm));

  // A rebuild that only changes values (here: a rename) gives new values but keeps
  // the rules' shape, so the popup's "On this tab" isn't reset.
  const before = await ctl.evaluate(`chrome.storage.session.get('rulesUpdatedAt').then(s => s.rulesUpdatedAt)`);
  await ctl.evaluate(`chrome.storage.local.get('state').then(s => { s.state.profiles[0].title = 'Vars renamed'; return chrome.storage.local.set(s); })`);
  await sleep(800);
  const b = await fetchSeen(page, `${base}/v2`);
  const after = await ctl.evaluate(`chrome.storage.session.get('rulesUpdatedAt').then(s => s.rulesUpdatedAt)`);
  check('variables: new values on refresh, "On this tab" not reset', b['x-id'] !== a['x-id'] && before === after, JSON.stringify({ a: a['x-id'], b: b['x-id'], before, after }));

  await save(ctl, [prof('No vars', { requestHeaders: [hdr('X-Plain', '1')] })]);
  const gone = await ctl.evaluate(`chrome.alarms.get('refresh-variables').then(a => a ?? null)`);
  check('variables: no refresh when no rule uses them', gone === null, JSON.stringify(gone));
}

export async function listChecks({ ctl, port }, { extId }, check) {
  await save(ctl, [prof('A', { requestHeaders: [hdr('X-A', '1')] }), prof('B', { enabled: false, requestHeaders: [hdr('X-B', '1')] })]);
  const title = await ctl.evaluate('chrome.action.getTitle({})');
  check('toolbar tooltip names the active profiles', title === 'Headerwise: A', title);

  const popup = await openTab(port, `chrome-extension://${extId}/src/popup/index.html`);
  await sleep(1200);
  await popup.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Duplicate').click()`);
  await sleep(800);
  let names = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles.map(p => p.title + (p.enabled ? '+' : '-')))`);
  check('duplicate: copy right after the original, switched off', JSON.stringify(names) === JSON.stringify(['A+', 'A copy-', 'B-']), JSON.stringify(names));

  // Drag "B" (third tab) onto the first.
  await popup.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('nav.tabs button[draggable]')];
    const dt = new DataTransfer();
    tabs[2].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    tabs[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    tabs[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
  await sleep(800);
  names = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles.map(p => p.title))`);
  check('drag: profile moved to the front', JSON.stringify(names) === JSON.stringify(['B', 'A', 'A copy']), JSON.stringify(names));

  const footer = await popup.evaluate(`document.querySelector('footer').innerText`);
  const commands = await ctl.evaluate('chrome.commands.getAll()');
  check('shortcuts listed in the popup', /Alt\+Shift\+O pause/.test(footer) && /Alt\+Shift\+\. next profile/.test(footer), footer + ' | ' + JSON.stringify(commands));
  await popup.send('Page.close').catch(() => {});
}

export async function welcomeChecks(_tabs, { port }, check) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find(x => x.type === 'page' && x.url.includes('src/migrate/index.html?welcome=1'));
  check('welcome page opened on install', !!t, JSON.stringify(list.map(x => x.url)));
  if (!t) return;
  const { connect } = await import('./cdp.mjs');
  const c = await connect(t.webSocketDebuggerUrl);
  const text = await c.evaluate('document.body.innerText');
  check('welcome page: first steps, access already granted, ModHeader move below',
    /Headerwise is installed/.test(text) && /Done\./.test(text) && /Coming from ModHeader\?/.test(text), text.slice(0, 300));
  c.close();
}
