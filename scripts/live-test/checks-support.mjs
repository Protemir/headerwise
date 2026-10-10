// "Rate Headerwise", diagnostics for bug reports, and the hint in an empty profile.
import { openTab, sleep } from './cdp.mjs';

const hdr = (name, value) => ({ id: `${name}-${value}`, enabled: true, name, value, op: 'set' });
const prof = (title, over = {}) => ({ id: title, title, enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });

async function save(ctl, profiles) {
  await ctl.evaluate(`chrome.storage.local.set({ state: ${JSON.stringify({ version: 1, paused: false, profiles })} })`);
  await sleep(700);
}

const popupAt = async (port, extId) => {
  const t = await openTab(port, `chrome-extension://${extId}/src/popup/index.html`);
  await sleep(1200);
  return t;
};

export async function supportChecks({ ctl, port }, { extId }, check) {
  // Install time is recorded; no rating link in the first two weeks.
  const meta = await ctl.evaluate(`chrome.storage.local.get('meta').then(m => m.meta ?? null)`);
  check('rate: install time recorded', typeof meta?.installedAt === 'number' && Date.now() - meta.installedAt < 3600e3, JSON.stringify(meta));
  let popup = await popupAt(port, extId);
  check('rate: no link in the first two weeks', !(await popup.evaluate(`!!document.querySelector('.rate')`)));
  await popup.send('Page.close').catch(() => {});

  // Fifteen days later it shows; clicking opens the reviews and it never comes back.
  await ctl.evaluate(`chrome.storage.local.set({ meta: { installedAt: Date.now() - 15 * 24 * 3600e3 } })`);
  popup = await popupAt(port, extId);
  const shown = await popup.evaluate(`document.querySelector('.rate')?.innerText ?? ''`);
  await popup.evaluate(`[...document.querySelectorAll('.rate button')].find(b => b.textContent.includes('Rate it')).click()`);
  // The tab opens once the setting is saved; its address shows up when it starts loading.
  let store;
  for (let i = 0; i < 25 && !store; i++) {
    await sleep(200);
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    store = tabs.find(t => t.url.includes('chromewebstore.google.com/detail/jedoaeaapdofoldmkacjbpojbnpapkna'));
  }
  const done = await ctl.evaluate(`chrome.storage.local.get('meta').then(m => m.meta.rateDone)`);
  check('rate: shown after two weeks, opens the reviews, remembered', /Finding Headerwise useful/.test(shown) && !!store && done === true, JSON.stringify({ shown, store: store?.url, done }));
  if (store) await fetch(`http://127.0.0.1:${port}/json/close/${store.id}`).catch(() => {});
  await popup.send('Page.close').catch(() => {});
  popup = await popupAt(port, extId);
  check('rate: not shown again', !(await popup.evaluate(`!!document.querySelector('.rate')`)));

  // Diagnostics: settings and header names, no values, profile names or URL patterns.
  await save(ctl, [prof('Client Acme', {
    requestHeaders: [hdr('Authorization', 'Bearer very-secret-token'), hdr('X-Env', 'staging')],
    filters: [{ id: 'f', enabled: true, kind: 'include', pattern: '||internal.acme.corp^', isRegex: false }],
  })]);
  await popup.send('Page.reload');
  await sleep(1200);
  const text = await popup.evaluate(`(async () => {
    let copied = null;
    navigator.clipboard.writeText = async t => { copied = t; };
    [...document.querySelectorAll('footer button')].find(b => b.textContent.includes('Copy diagnostics')).click();
    await new Promise(r => setTimeout(r, 500));
    return copied;
  })()`);
  check('diagnostics: version, rules, header names and filter kinds',
    /^Headerwise \d+\.\d+\.\d+/.test(text ?? '') && /Rules in the browser: \d+ dynamic/.test(text) && /set Authorization, set X-Env/.test(text) && /only on/.test(text), text);
  check('diagnostics: no header values, profile names or URL patterns',
    !/very-secret-token|staging|Client Acme|internal\.acme/.test(text ?? ''), text);

  // A regex Chrome won't take: marked on its row, and the warning sits above the
  // editor (the popup is cut at 600px, a warning at the bottom goes unseen).
  await save(ctl, [prof('A profile name long enough to need cutting short in its tab', {
    requestHeaders: [hdr('X-A', '1')],
    filters: [{ id: 'bad', enabled: true, kind: 'exclude', pattern: 'a(?=b)', isRegex: true }, { id: 'good', enabled: true, kind: 'exclude', pattern: '^https://x', isRegex: true }],
  })]);
  await popup.send('Page.reload');
  await sleep(1500);
  const ui = await popup.evaluate(`(() => {
    const bad = [...document.querySelectorAll('input.bad')];
    const warn = document.querySelector('.warnings'), tabs = document.querySelector('.tabs');
    const tabButton = tabs.querySelector('button');
    return {
      bad: bad.map(i => i.value), title: bad[0]?.title ?? '',
      warningOnTop: !!warn && !!(warn.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING),
      cut: tabButton.scrollWidth > tabButton.clientWidth && tabButton.title.startsWith('A profile name long'),
    };
  })()`);
  check('popup: bad regex marked on its row, warning above the editor, long tab name cut', ui.bad.join() === 'a(?=b)' && /Chrome can't use this regex/.test(ui.title) && ui.warningOnTop && ui.cut, JSON.stringify(ui));

  // Changed elsewhere while the popup is open (a shortcut, a closed tab): the popup
  // shows it, and its next edit doesn't undo it.
  await save(ctl, [prof('Sync me', { requestHeaders: [hdr('X-A', '1')] })]);
  await popup.send('Page.reload');
  await sleep(1200);
  await ctl.evaluate(`chrome.storage.local.get('state').then(s => { s.state.paused = true; return chrome.storage.local.set(s); })`);
  await sleep(600);
  const pauseShown = await popup.evaluate(`document.querySelector('.pause input').checked`);
  await popup.evaluate(`(() => { const i = document.querySelector('input[aria-label="Profile name"]'); i.value = 'Renamed'; i.dispatchEvent(new Event('input')); })()`);
  await sleep(700);
  let stored = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state)`);
  check('popup: takes in a change made elsewhere, its own edit keeps it', pauseShown && stored.paused === true && stored.profiles[0].title === 'Renamed', JSON.stringify({ pauseShown, paused: stored.paused, title: stored.profiles[0].title }));

  // An edit right before the popup closes (Chrome closes it on any outside click) is kept.
  await popup.evaluate(`(() => { const i = document.querySelector('input[aria-label="Profile name"]'); i.value = 'Closed fast'; i.dispatchEvent(new Event('input')); })()`);
  await popup.send('Page.close').catch(() => {});
  await sleep(800);
  stored = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state)`);
  check('popup: an edit made just before closing is saved', stored.profiles[0].title === 'Closed fast', stored.profiles[0].title);
  await ctl.evaluate(`chrome.storage.local.get('state').then(s => { s.state.paused = false; return chrome.storage.local.set(s); })`);
  popup = await popupAt(port, extId);

  // Profile order (who wins a shared header) without a mouse: Alt+Left on a tab.
  await save(ctl, [prof('First', { requestHeaders: [hdr('X-A', '1')] }), prof('Second', { requestHeaders: [hdr('X-A', '2')] })]);
  await popup.send('Page.reload');
  await sleep(1200);
  await popup.evaluate(`document.querySelectorAll('.tabs button')[1].focus()`);
  await popup.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 1 });
  await popup.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, modifiers: 1 });
  await sleep(700);
  stored = await ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state)`);
  const focused = await popup.evaluate(`document.activeElement?.textContent.trim()`);
  check('popup: Alt+Left moves a profile tab, focus follows', stored.profiles.map(x => x.title).join() === 'Second,First' && focused === 'Second', JSON.stringify({ order: stored.profiles.map(x => x.title), focused }));

  // An empty profile says where to start.
  await save(ctl, [prof('Profile 1', { requestHeaders: [hdr('', '')] })]);
  await popup.send('Page.reload');
  await sleep(1200);
  const hint = await popup.evaluate(`[...document.querySelectorAll('.small-hint')].some(p => p.textContent.startsWith('Start here'))`);
  await popup.evaluate(`(() => { const i = document.querySelector('input[aria-label="Request header name"]'); i.value = 'X-A'; i.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  const gone = await popup.evaluate(`![...document.querySelectorAll('.small-hint')].some(p => p.textContent.startsWith('Start here'))`);
  check('empty profile: hint shown, gone once a header is typed', hint && gone, JSON.stringify({ hint, gone }));
  await popup.send('Page.close').catch(() => {});
}
