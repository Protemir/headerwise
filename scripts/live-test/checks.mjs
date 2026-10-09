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
      [...document.querySelectorAll('button')].find(b => b.textContent.includes('Import from ModHeader')).click();
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
