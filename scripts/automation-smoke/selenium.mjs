// Selenium (JavaScript). Chrome, and Chrome for Testing from 155 on, no longer
// load extensions given with --load-extension (or a .crx through ChromeDriver).
// The extension goes in over WebDriver BiDi instead: webExtension.install, which
// needs BiDi switched on and these two flags. selenium-webdriver has no helper
// for it yet, so the command is sent as it is.
import { resolve } from 'node:path';
import { Builder } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { smoke } from './server.mjs';

const ext = resolve('dist-automation');
const options = new chrome.Options().addArguments('--enable-unsafe-extension-debugging', '--remote-debugging-pipe', '--headless=new');
options.setBrowserVersion('stable'); // Chrome for Testing here; the Python run uses the installed Chrome
options.enableBidi();
const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
await (await driver.getBidi()).send({ method: 'webExtension.install', params: { extensionData: { type: 'path', path: ext } } });

await smoke('selenium-js', {
  async open(url) {
    await driver.get(url);
    await driver.wait(() => driver.executeScript('return document.documentElement.dataset.status'), 10000);
    return driver.executeScript('return document.documentElement.dataset.status');
  },
  async text(url, responseHeader) {
    await driver.get(url);
    if (responseHeader) return driver.executeAsyncScript('const done = arguments[1]; fetch(location.href).then(r => done(r.headers.get(arguments[0])))', responseHeader);
    return driver.executeScript('return document.body.innerText');
  },
  close: () => driver.quit(),
});
