// What the live test checks. `ctl` is a tab with an extension page (same chrome.*
// APIs as the service worker, which MV3 puts to sleep), `page` is a tab that
// visits the echo server, which answers with the request headers it received.
import { sleep } from './cdp.mjs';

let n = 0;
const id = () => `t${++n}`;
const h = (name, value = '1', op = 'set') => ({ id: id(), enabled: true, name, value, op });
const f = (kind, pattern, isRegex) => ({ id: id(), enabled: true, kind, pattern, isRegex });
const p = (title, over = {}) => ({ id: id(), title, enabled: true, requestHeaders: [], responseHeaders: [], filters: [], ...over });
const st = (profiles, paused = false) => ({ version: 1, paused, profiles });

function harness({ ctl, page }) {
  return {
    // Saves the state the way the popup does, then reads back what the background script did.
    async apply(state) {
      await ctl.evaluate(`chrome.storage.local.set({ state: ${JSON.stringify(state)} })`);
      await sleep(700);
      return ctl.evaluate(`(async () => ({
        rules: await chrome.declarativeNetRequest.getDynamicRules(),
        warnings: (await chrome.storage.session.get('warnings')).warnings ?? [],
        badge: await chrome.action.getBadgeText({}),
      }))()`);
    },
    // Top-level navigation (main_frame); returns the request headers the server saw.
    async navigate(url) {
      await page.send('Page.navigate', { url });
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        if (await page.evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`).catch(() => false)) break;
      }
      const text = await page.evaluate('document.body.innerText');
      return JSON.parse(text.slice(text.indexOf('{'))).headers;
    },
    // fetch() from the page (xmlhttprequest): request headers seen + response headers.
    xhr(url) {
      return page.evaluate(`fetch(${JSON.stringify(url)}).then(async r => ({ seen: (await r.json()).headers, res: Object.fromEntries(r.headers) }))`);
    },
  };
}

/** Real manifest: no host access granted yet, so nothing may change. */
export async function noAccessChecks(tabs, { base }, check) {
  const { apply, navigate } = harness(tabs);
  const r = await apply(st([p('P', { requestHeaders: [h('X-Hw', 'on')] })]));
  check('no access: badge "!" and a warning', r.badge === '!' && /no access to sites/.test(r.warnings[0] ?? ''), JSON.stringify({ b: r.badge, w: r.warnings }));
  check('no access: header not sent', !('x-hw' in await navigate(`${base}/noaccess`)));
}

export async function accessChecks(tabs, { base, ip, extId }, check) {
  const { apply, navigate, xhr } = harness(tabs);
  const { page } = tabs;

  {
    const r = await apply(st([p('Basic', {
      requestHeaders: [h('X-Hw', 'on'), h('Accept-Language', '', 'remove')],
      responseHeaders: [h('X-Hw-Res', 'ok'), h('X-Server', '', 'remove')],
    })]));
    check('one rule, no warnings, badge = 4', r.rules.length === 1 && r.warnings.length === 0 && r.badge === '4', JSON.stringify({ n: r.rules.length, w: r.warnings, b: r.badge }));
    const nav = await navigate(`${base}/page`);
    check('main_frame: request header set', nav['x-hw'] === 'on', JSON.stringify(nav));
    check('main_frame: Accept-Language removed', !('accept-language' in nav), nav['accept-language']);
    const x = await xhr(`${base}/api`);
    check('fetch: request header set', x.seen['x-hw'] === 'on');
    check('fetch: response header set', x.res['x-hw-res'] === 'ok', JSON.stringify(x.res));
    check('fetch: response header removed', !('x-server' in x.res), JSON.stringify(x.res));
  }

  {
    const r = await apply(st([p('Append', { requestHeaders: [h('Accept-Language', 'kk', 'append'), h('X-Custom', 'a', 'append')] })]));
    check('append to a custom request header warns', r.warnings.some(w => /can't append/.test(w)), JSON.stringify(r.warnings));
    const al = (await navigate(`${base}/append`))['accept-language'] ?? '';
    check('Accept-Language appended', /kk$/.test(al) && al !== 'kk', al);
  }

  {
    await apply(st([p('Only api', { requestHeaders: [h('X-Only', 'api')], filters: [f('include', '||localhost^*/api/', false)] })]));
    check('only on: applied on /api/x', (await xhr(`${base}/api/x`)).seen['x-only'] === 'api');
    check('only on: not applied on /other', !('x-only' in (await xhr(`${base}/other`)).seen));
  }

  {
    await apply(st([p('Not on IP', { requestHeaders: [h('X-Dom', '1')], filters: [f('exclude', '127.0.0.1', false)] })]));
    check('never on domain: applied on localhost', (await navigate(`${base}/d`))['x-dom'] === '1');
    check('never on domain: skipped on 127.0.0.1', !('x-dom' in await navigate(`${ip}/d`)));
  }

  {
    const r = await apply(st([
      p('With regex exclude', { requestHeaders: [h('X-A', 'a')], filters: [f('exclude', '/login', true)] }),
      p('Plain', { requestHeaders: [h('X-B', 'b')] }),
    ]));
    check('regex exclude: 2 modify rules + 1 allow rule', r.rules.length === 3 && r.rules.filter(x => x.action.type === 'allow').length === 1, JSON.stringify(r.rules.map(x => [x.priority, x.action.type])));
    const home = await navigate(`${base}/home`);
    check('regex exclude: both profiles on /home', home['x-a'] === 'a' && home['x-b'] === 'b', JSON.stringify(home));
    const login = await navigate(`${base}/login`);
    check('regex exclude: excluded profile off on /login', !('x-a' in login), login['x-a']);
    check('regex exclude: other profile still on on /login', login['x-b'] === 'b', JSON.stringify(login));
    const lx = await xhr(`${base}/login?x=1`);
    check('regex exclude: same for fetch', !('x-a' in lx.seen) && lx.seen['x-b'] === 'b');
  }

  {
    await apply(st([p('Not health', { requestHeaders: [h('X-H', '1')], filters: [f('exclude', '*/health', false)] })]));
    check('never on urlFilter: skipped on /health', !('x-h' in (await xhr(`${base}/health`)).seen));
    check('never on urlFilter: applied on /ok', (await xhr(`${base}/ok`)).seen['x-h'] === '1');
  }

  {
    await apply(st([p('First', { requestHeaders: [h('X-Same', 'first')] }), p('Second', { requestHeaders: [h('X-Same', 'second')] })]));
    check('first profile wins a shared header', (await xhr(`${base}/same`)).seen['x-same'] === 'first');
  }

  {
    const r = await apply(st([
      p('Bad regex', { requestHeaders: [h('X-Bad', '1')], filters: [f('include', '^http://localhost(?!:9)', true), f('include', '||localhost^', false)] }),
      p('Other', { requestHeaders: [h('X-Other', '1')] }),
    ]));
    check('lookahead regex: warning names the profile', r.warnings.some(w => /^"Bad regex": .*not supported by Chrome/.test(w)), JSON.stringify(r.warnings));
    const x = (await xhr(`${base}/bad`)).seen;
    check('lookahead regex: other rules still applied', x['x-bad'] === '1' && x['x-other'] === '1', JSON.stringify(x));
  }

  {
    const r = await apply(st([p('Invalid', { requestHeaders: [h('Bad Name', '1'), h('X-Nl', 'a\nb'), h('X-Fine', 'y')] })]));
    check('invalid name / line break: 2 warnings, rest applied', r.warnings.length === 2 && (await xhr(`${base}/i`)).seen['x-fine'] === 'y', JSON.stringify(r.warnings));
  }

  {
    // Broken stored state (an array saved as {"0": ...}) must not fail silently.
    const r = await apply({ version: 1, paused: false, profiles: [{ ...p('Broken'), requestHeaders: { 0: h('X-Broken') } }] });
    check('broken state: badge "!" and a warning', r.badge === '!' && /could not apply/.test(r.warnings[0] ?? ''), JSON.stringify({ b: r.badge, w: r.warnings }));
  }

  {
    const r = await apply(st([p('Paused', { requestHeaders: [h('X-P', '1')] })], true));
    check('pause: no rules, badge "off"', r.rules.length === 0 && r.badge === 'off', JSON.stringify({ n: r.rules.length, b: r.badge }));
    check('pause: header not sent', !('x-p' in (await xhr(`${base}/p`)).seen));
  }

  {
    // A real ModHeader 7.x export (github.com/Zerohazard8x/custom), pasted into the popup.
    await apply(st([p('Profile 1', { requestHeaders: [h('X-Keep', '1')] })]));
    const modheader = '[{"version":2,"title":"ChromeUAforGoogle","headers":[{"enabled":true,"name":"User-Agent","value":"HeaderwiseTest/1.0"}],"urlFilters":[{"enabled":true,"urlRegex":".*localhost.*"}],"excludeUrlFilters":[{"enabled":true,"urlRegex":".*/login.*"}],"shortTitle":"1","alwaysOn":true}]';
    await page.send('Page.navigate', { url: `chrome-extension://${extId}/src/popup/index.html` });
    await sleep(1200);
    await page.evaluate(`(async () => {
      [...document.querySelectorAll('button')].find(b => b.textContent.includes('Import ModHeader JSON')).click();
      await new Promise(r => setTimeout(r, 200));
      const ta = document.querySelector('textarea');
      ta.value = ${JSON.stringify(modheader)};
      ta.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 200));
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Import').click();
    })()`);
    await sleep(1200);
    const saved = await tabs.ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles.map(p => [p.title, p.enabled]))`);
    check('popup import: profile added after the existing one', JSON.stringify(saved) === JSON.stringify([['Profile 1', true], ['ChromeUAforGoogle', true]]), JSON.stringify(saved));
    check('imported profile: User-Agent set', (await navigate(`${base}/ua`))['user-agent'] === 'HeaderwiseTest/1.0');
    check('imported profile: "never on" /login works', (await navigate(`${base}/login`))['user-agent'] !== 'HeaderwiseTest/1.0');
  }
}

/**
 * "Move from ModHeader" page: gets a real LevelDB folder written by Chrome
 * (tests/fixtures/leveldb-bulk) through its file input and imports it.
 */
export async function migrateChecks(tabs, { base, extId, fixtureDir }, check) {
  const { apply, navigate } = harness(tabs);
  const { page } = tabs;
  await apply(st([p('Profile 1', { requestHeaders: [h('', '')] })])); // fresh install: one empty profile

  await page.send('Page.navigate', { url: `chrome-extension://${extId}/src/migrate/index.html` });
  await sleep(1000);
  const { result } = await page.send('Runtime.evaluate', { expression: `document.querySelector('input[type=file]')` });
  await page.send('DOM.setFileInputFiles', { objectId: result.objectId, files: [fixtureDir] });
  await sleep(1500);
  const listed = await page.evaluate(`[...document.querySelectorAll('.profiles li')].map(li => li.innerText.split('\\n').join(' ').trim())`);
  check('migrate: lists the 3 ModHeader profiles', listed.length === 3 && /Staging/.test(listed[0]) && /Юникод ✓.*on/.test(listed[1]), JSON.stringify(listed) + ' page: ' + await page.evaluate(`document.body.innerText.slice(0, 600)`));
  if (listed.length === 0) return;

  await page.evaluate(`document.querySelector('button.primary').click()`);
  await sleep(1000);
  const done = await page.evaluate(`document.querySelector('.done h2')?.innerText ?? ''`);
  check('migrate: import done', /3 profiles added/.test(done), done);
  const saved = await tabs.ctl.evaluate(`chrome.storage.local.get('state').then(s => s.state.profiles.map(p => [p.title, p.enabled]))`);
  check('migrate: replaces the empty starter profile, keeps ModHeader\'s selection', JSON.stringify(saved) === JSON.stringify([['Staging', false], ['Юникод ✓', true], ['Legacy', false]]), JSON.stringify(saved));

  await sleep(700);
  const seen = await navigate(`${base}/migrated`);
  check('migrate: selected profile works (X-Note sent)', seen['x-note'] !== undefined, JSON.stringify(seen['x-note']) + ' rules: ' + JSON.stringify(await tabs.ctl.evaluate('chrome.declarativeNetRequest.getDynamicRules()')) + ' warnings: ' + JSON.stringify(await tabs.ctl.evaluate(`chrome.storage.session.get('warnings')`)));
  check('migrate: its "never on" works too', !('x-note' in await navigate(`${base}/login`)));
}

/** The popup's "On this tab" report, for the tab that visits the echo server. */
export async function tabChecks(tabs, { base, extId }, check) {
  const { apply, navigate, xhr } = harness(tabs);
  const { ctl } = tabs;
  const profiles = [
    p('Works', { requestHeaders: [h('X-W', '1')] }),
    p('Never login', { requestHeaders: [h('X-N', '1')], filters: [f('exclude', '/login', true)] }),
    p('Other site', { requestHeaders: [h('X-O', '1')], filters: [f('include', '||api.invalid^', false)] }),
    { ...p('Off', { requestHeaders: [h('X-Off', '1')] }), enabled: false },
  ];
  await apply(st(profiles));
  await navigate(`${base}/login`);
  await xhr(`${base}/login/data`);
  const tabId = await ctl.evaluate(`chrome.tabs.query({ url: '${base}/*' }).then(t => t[0].id)`);

  const report = async () => {
    const t = await openPopup(tabs.port, extId, tabId);
    const lines = await t.evaluate(`[...document.querySelectorAll('.here .lines li')].map(li => li.innerText.trim())`);
    const reload = await t.evaluate(`[...document.querySelectorAll('.here button')].some(b => b.textContent.includes('Reload tab'))`);
    return { t, lines, reload };
  };

  let r = await report();
  check('this tab: applied profile with a request count', /^Works changed [2-9]\d* requests$/.test(r.lines[0] ?? ''), JSON.stringify(r.lines));
  // The page itself is excluded; its favicon request is not, so either line is right.
  check('this tab: "never on" reported as the reason', /^Never login (skipped here: never on \/login matches this page|changed 1 request; skipped where never on \/login matches)$/.test(r.lines[1] ?? ''), r.lines[1]);
  check('this tab: "only on" explained', /^Other site only on \|\|api\.invalid\^: this page doesn't match/.test(r.lines[2] ?? ''), r.lines[2]);
  check('this tab: turned-off profile', r.lines[3] === 'Off turned off', r.lines[3]);
  check('this tab: no reload button when all is applied', !r.reload);
  await r.t.send('Page.close');

  // Change a header: the open page hasn't had a request since, so the popup asks for a reload.
  profiles[0].requestHeaders[0].value = '2';
  await apply(st(profiles));
  r = await report();
  check('this tab: after an edit asks to reload', /^Works nothing changed here since your last edit/.test(r.lines[0] ?? '') && r.reload, JSON.stringify(r));
  await r.t.evaluate(`[...document.querySelectorAll('.here button')].find(b => b.textContent.includes('Reload tab')).click()`);
  await sleep(2500);
  const after = await r.t.evaluate(`[...document.querySelectorAll('.here .lines li')].map(li => li.innerText.trim())`);
  check('this tab: "Reload tab" reloads and the report updates', /^Works changed \d+ request/.test(after[0] ?? ''), JSON.stringify(after));
  await r.t.send('Page.close');
}

async function openPopup(port, extId, tabId) {
  const { openTab } = await import('./cdp.mjs');
  const t = await openTab(port, `chrome-extension://${extId}/src/popup/index.html?tab=${tabId}`);
  await sleep(1200);
  return t;
}
