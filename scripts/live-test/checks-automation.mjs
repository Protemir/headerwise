// The automation build: fixed id, site access without a click, no welcome tab,
// and the automation page that tests drive through URLs.
import { sleep } from './cdp.mjs';

const ID = 'mhlgmcieamjogdlnfjaoeophmdajkkek';

export async function automationChecks({ page, port }, { extId, base, saw }, check) {
  check('automation: fixed extension id', extId === ID, extId);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  check('automation: no welcome tab', !tabs.some(t => t.url.includes('welcome=1')), tabs.map(t => t.url).join(' '));

  const go = async url => {
    await page.send('Page.navigate', { url });
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const status = await page.evaluate(`document.documentElement.dataset.status ?? ''`).catch(() => '');
      if (status) return { status, text: await page.evaluate('document.body.innerText') };
    }
    return { status: 'timeout', text: await page.evaluate('document.body.innerText').catch(() => '') };
  };
  const visit = async path => {
    await page.send('Page.navigate', { url: `${base}${path}` });
    await sleep(500);
    return saw(path) ?? {};
  };

  let r = await go(`chrome-extension://${ID}/automation.html?X-Auto=one&Authorization=Bearer%20secret-123&res:X-Auto-Resp=yes`);
  check('automation: page reports ready, names only', r.status === 'ready' && /set X-Auto\b/.test(r.text) && !/secret-123/.test(r.text), r.text);
  let got = await visit('/auto-1');
  check('automation: headers sent right after "ready"', got['x-auto'] === 'one' && got.authorization === 'Bearer secret-123', JSON.stringify(got));
  const resp = await page.evaluate(`fetch('/auto-1b').then(r => r.headers.get('x-auto-resp'))`);
  check('automation: response header', resp === 'yes', resp);

  r = await go(`chrome-extension://${ID}/automation.html?X-Auto=two&@url=*/auto-only*`);
  const [onPath, offPath] = [await visit('/auto-only-1'), await visit('/auto-2')];
  check('automation: next call replaces, @url limits', r.status === 'ready' && onPath['x-auto'] === 'two' && !offPath['x-auto'] && !offPath.authorization, JSON.stringify({ onPath, offPath }));

  r = await go(`chrome-extension://${ID}/automation.html?@nope=1`);
  check('automation: mistakes are reported, nothing changes', r.status === 'error' && /Unknown option @nope/.test(r.text) && (await visit('/auto-only-2'))['x-auto'] === 'two', r.text);

  r = await go(`chrome-extension://${ID}/automation.html?@clear`);
  got = await visit('/auto-only-3');
  check('automation: @clear', r.status === 'ready' && !got['x-auto'] && /No headers are changed/.test(r.text), JSON.stringify({ text: r.text, got }));

  // Tests written for chrome-modheader keep their URLs.
  r = await go('https://webdriver.modheader.com/add?X-Mh=1');
  const url = await page.evaluate('location.href');
  r = await go('https://webdriver.modheader.com/add?X-Mh2=2&X-Mh=one');
  got = await visit('/mh-1');
  check('modheader: /add lands on the page and adds to earlier calls', r.status === 'ready' && url.startsWith(`chrome-extension://${ID}/automation.html?@add&X-Mh=1`) && got['x-mh'] === 'one' && got['x-mh2'] === '2', JSON.stringify({ url, got }));
  const profile = [{ title: 'Loaded', headers: [{ enabled: true, name: 'X-Loaded', value: 'yes' }], respHeaders: [] }];
  r = await go(`https://webdriver.modheader.com/load?profile=${encodeURIComponent(JSON.stringify(profile))}`);
  got = await visit('/mh-2');
  check('modheader: /load?profile= imports the export', r.status === 'ready' && got['x-loaded'] === 'yes' && !got['x-mh'], JSON.stringify({ text: r.text, got }));
  r = await go('https://webdriver.modheader.com/clear');
  got = await visit('/mh-3');
  check('modheader: /clear', r.status === 'ready' && !got['x-loaded'], JSON.stringify(got));

  // A web page must not be able to set headers through the page.
  await visit('/evil-start');
  const tryFrom = async (how, target) => {
    await page.evaluate(`(() => { ${how === 'iframe'
      ? `const f = document.createElement('iframe'); f.src = ${JSON.stringify(target)}; document.body.append(f);`
      : `location.href = ${JSON.stringify(target)};`} })()`).catch(() => {});
    await sleep(1500);
    const seen = await visit('/evil-check');
    await visit('/evil-start');
    return seen['x-evil'] ?? null;
  };
  const evil = {
    direct: await tryFrom('navigate', `chrome-extension://${ID}/automation.html?X-Evil=1`),
    iframe: await tryFrom('iframe', `chrome-extension://${ID}/automation.html?X-Evil=2`),
    viaModheader: await tryFrom('navigate', 'https://webdriver.modheader.com/add?X-Evil=3'),
    viaModheaderIframe: await tryFrom('iframe', 'https://webdriver.modheader.com/add?X-Evil=4'),
  };
  check('automation: web pages cannot reach the page', Object.values(evil).every(v => v === null), JSON.stringify(evil));
  await go(`chrome-extension://${ID}/automation.html?@clear`);
}
