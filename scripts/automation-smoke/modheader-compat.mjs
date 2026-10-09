// A test written for ModHeader, as its README shows it: chrome-modheader's URL
// helpers, a .crx through Selenium's addExtensions, waiting for the title "Done".
// Only the extension is swapped for headerwise-automation.crx.
import { resolve } from 'node:path';
import { Builder, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import modheader from 'chrome-modheader';
import { smoke } from './server.mjs';

const { getAddHeaderUrl, getAddHeadersUrl, getClearHeadersUrl, getLoadProfileUrl } = modheader;
const options = new chrome.Options().addExtensions(resolve('headerwise-automation.crx')).addArguments('--headless=new');
options.setBrowserVersion('stable'); // Chrome for Testing: branded Chrome 137+ ignores extensions from ChromeDriver
const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

const open = async url => {
  await driver.get(url);
  await driver.wait(until.titleIs('Done'), 10000);
  return 'Done';
};
const text = async url => {
  await driver.get(url);
  return driver.executeScript('return document.body.innerText');
};

await smoke('modheader-compat', {
  steps: base => [
    ['add', () => open(getAddHeaderUrl('X-Test', 'crx')), 'Done'],
    ['header sent', () => text(`${base}/h/x-test`), 'crx'],
    ['add more', () => open(getAddHeadersUrl({ 'X-Other': '2' })), 'Done'],
    ['both sent', async () => `${await text(`${base}/h/x-test`)} ${await text(`${base}/h/x-other`)}`, 'crx 2'],
    ['load profile', () => open(getLoadProfileUrl([{ title: 'P', headers: [{ enabled: true, name: 'X-Loaded', value: 'yes' }] }])), 'Done'],
    ['profile header sent, others gone', async () => `${await text(`${base}/h/x-loaded`)} ${await text(`${base}/h/x-test`)}`, 'yes (none)'],
    ['clear', () => open(getClearHeadersUrl()), 'Done'],
    ['nothing after clear', () => text(`${base}/h/x-loaded`), '(none)'],
  ],
  close: () => driver.quit(),
});
