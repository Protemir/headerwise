// Puppeteer: installs the extension over the pipe, works with Chrome for Testing.
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';
import { ID, smoke } from './server.mjs';

const ext = resolve('dist-automation');
const browser = await puppeteer.launch({ pipe: true, enableExtensions: [ext] });
// The extension installs after launch returns: wait for its service worker.
await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${ID}/`));
const page = await browser.newPage();

await smoke('puppeteer', {
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
  close: () => browser.close(),
});
