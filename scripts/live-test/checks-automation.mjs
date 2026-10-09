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
}
