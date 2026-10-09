// Playwright: its own Chromium takes --load-extension (branded Chrome 137+ doesn't).
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { smoke } from './server.mjs';

const ext = resolve('dist-automation');
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium', // the full Chromium; the headless shell has no extensions
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = await context.newPage();

await smoke('playwright', {
  async open(url) {
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.dataset.status);
    return page.evaluate(() => document.documentElement.dataset.status);
  },
  async text(url, responseHeader) {
    await page.goto(url);
    if (responseHeader) return page.evaluate(h => fetch(location.href).then(r => r.headers.get(h)), responseHeader);
    return page.evaluate(() => document.body.innerText);
  },
  close: () => context.close(),
});
