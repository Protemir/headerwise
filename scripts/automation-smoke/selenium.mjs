// Selenium (JavaScript): Chrome for Testing, which Selenium Manager downloads
// when a browser version is asked for, still takes --load-extension.
import { resolve } from 'node:path';
import { Builder } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { smoke } from './server.mjs';

const ext = resolve('dist-automation');
const options = new chrome.Options().addArguments(`--load-extension=${ext}`, '--headless=new');
options.setBrowserVersion('stable');
const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

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
