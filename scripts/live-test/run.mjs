// Live test: loads the built extension into a throwaway Chrome or Edge profile and
// checks what an echo server really receives.
//
//   npm run build && npm run test:live            (Chrome)
//   npm run test:live -- --browser edge
//
// Branded Chrome 137+ ignores --load-extension, so the extension is loaded through
// CDP Extensions.loadUnpacked, which needs --remote-debugging-pipe. Edge still
// takes --load-extension (and may relaunch itself, which would lose a pipe).
// Set HW_BROWSER to the browser binary if it isn't in the usual Windows place.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { openTab, sleep } from './cdp.mjs';
import { accessChecks, cspChecks, migrateChecks, noAccessChecks, quickInputChecks, tabChecks } from './checks.mjs';
import { secretChecks, tabOnlyChecks } from './checks-tabs.mjs';
import { exportChecks, filterChecks } from './checks-filters.mjs';
import { listChecks, variableChecks, welcomeChecks } from './checks-ux.mjs';
import { redirectChecks } from './checks-redirects.mjs';
import { supportChecks } from './checks-support.mjs';
import { automationChecks } from './checks-automation.mjs';

const args = process.argv.slice(2);
const browser = args.includes('--browser') ? args[args.indexOf('--browser') + 1] : 'chrome';
const BINARIES = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
};
const binary = process.env.HW_BROWSER ?? BINARIES[browser];
const dist = resolve('dist');
const ECHO_PORT = 8787;
const CDP_PORT = 9334;
const urls = { base: `http://localhost:${ECHO_PORT}`, ip: `http://127.0.0.1:${ECHO_PORT}` };

if (!existsSync(join(dist, 'manifest.json'))) throw new Error('dist/ not found, run npm run build first');
if (!binary || !existsSync(binary)) throw new Error(`browser not found: ${binary}; set HW_BROWSER`);

const requests = []; // every path the echo server saw, for the "sends nothing" checks
const headersByPath = new Map(); // what each path got, for requests whose answer a page can't read
const echo = createServer((req, res) => {
  requests.push(req.url);
  headersByPath.set(req.url, req.headers);
  res.setHeader('X-Server', 'echo');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ url: req.url, headers: req.headers }));
});
await new Promise(ok => echo.listen(ECHO_PORT, '127.0.0.1', ok));

// Keep the profile path short: with a long one Chrome fails to write the rules file
// ("Internal error while updating dynamic rules").
const root = join(tmpdir(), 'hw-live');

// The LevelDB folder the "Move from ModHeader" page is fed with, unpacked.
const fixtureDir = join(root, 'leveldb-bulk');
rmSync(fixtureDir, { recursive: true, force: true });
mkdirSync(fixtureDir, { recursive: true });
for (const f of readdirSync('tests/fixtures/leveldb-bulk')) {
  writeFileSync(join(fixtureDir, f.replace(/\.gz$/, '')), gunzipSync(readFileSync(join('tests/fixtures/leveldb-bulk', f))));
}

async function launch(name, grantAccess, source = dist) {
  const dir = join(root, `${browser}-${name}`);
  rmSync(dir, { recursive: true, force: true });
  const ext = join(dir, 'ext');
  cpSync(source, ext, { recursive: true });
  if (grantAccess) {
    // The real extension asks for site access with a button; a test can't click
    // the browser's permission dialog, so this copy gets it at install time.
    const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['<all_urls>'];
    // and getMatchedRules for any tab, which the real popup gets from activeTab on click.
    manifest.permissions.push('declarativeNetRequestFeedback');
    writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }
  mkdirSync(join(dir, 'profile'), { recursive: true });
  // Edge may relaunch itself right away, which loses the pipe; it still honours
  // --load-extension, so it gets that instead.
  return browser === 'edge' ? launchWithFlag(dir, ext) : launchWithPipe(dir, ext);
}

async function waitForPort() {
  for (let i = 0; i < 75; i++) {
    if (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(() => true, () => false)) return;
    await sleep(200);
  }
  throw new Error(`${browser}: no DevTools on port ${CDP_PORT}`);
}

async function opened(extId, close) {
  const ctl = await openTab(CDP_PORT, `chrome-extension://${extId}/src/popup/index.html`);
  await sleep(1000);
  const page = await openTab(CDP_PORT, 'about:blank');
  const version = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).Browser;
  return {
    extId, version, tabs: { ctl, page, port: CDP_PORT },
    async close() {
      ctl.close();
      page.close();
      await close();
    },
  };
}

async function launchWithFlag(dir, ext) {
  spawn(binary, [
    `--user-data-dir=${join(dir, 'profile')}`,
    `--load-extension=${ext}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore', detached: true }).unref();
  await waitForPort();
  // A fresh install opens the welcome page, whose URL carries the extension id.
  let extId;
  for (let i = 0; i < 50 && !extId; i++) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    extId = list.map(t => /^chrome-extension:\/\/([a-p]{32})\/src\/migrate\/index\.html\?welcome=1/.exec(t.url)?.[1]).find(Boolean);
    if (!extId) await sleep(200);
  }
  if (!extId) throw new Error(`${browser}: extension did not load`);
  return opened(extId, async () => {
    const { connect } = await import('./cdp.mjs');
    const b = await connect((await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl);
    await b.send('Browser.close').catch(() => {});
    for (let i = 0; i < 25 && await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(() => true, () => false); i++) await sleep(200);
  });
}

async function launchWithPipe(dir, ext) {
  const proc = spawn(binary, [
    `--user-data-dir=${join(dir, 'profile')}`,
    '--remote-debugging-pipe',
    `--remote-debugging-port=${CDP_PORT}`,
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

  const extId = await new Promise((ok, fail) => {
    // Fail fast instead of hanging if the browser quits or never answers.
    proc.once('exit', code => fail(new Error(`${browser} exited (code ${code}) before loading the extension`)));
    setTimeout(() => fail(new Error(`${browser} did not answer Extensions.loadUnpacked within 30 s`)), 30000);
    let buf = '';
    proc.stdio[4].on('data', d => {
      buf += d.toString();
      const end = buf.indexOf('\0');
      if (end < 0) return;
      const msg = JSON.parse(buf.slice(0, end));
      msg.result ? ok(msg.result.id) : fail(new Error(`loadUnpacked: ${JSON.stringify(msg.error)}`));
    });
    proc.stdio[3].write(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: ext } }) + '\0');
  });

  await waitForPort();
  return opened(extId, async () => {
    proc.stdio[3].write(JSON.stringify({ id: 2, method: 'Browser.close' }) + '\0');
    await new Promise(ok => { proc.once('exit', ok); setTimeout(() => { proc.kill(); ok(); }, 5000); });
  });
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
};

const both = async (tabs, ctx, check) => {
  await welcomeChecks(tabs, ctx, check);
  await accessChecks(tabs, ctx, check);
  await tabChecks(tabs, ctx, check);
  await quickInputChecks(tabs, ctx, check);
  await tabOnlyChecks(tabs, ctx, check);
  await secretChecks(tabs, ctx, check);
  await filterChecks(tabs, ctx, check);
  await exportChecks(tabs, ctx, check);
  await variableChecks(tabs, ctx, check);
  await listChecks(tabs, ctx, check);
  await redirectChecks(tabs, ctx, check);
  await supportChecks(tabs, ctx, check);
  await cspChecks(tabs, ctx, check);
  await migrateChecks(tabs, ctx, check);
};
// The automation build (npm run build:automation), when there is one.
const automation = resolve('dist-automation');
const runs = [['no-access', false, noAccessChecks], ['access', true, both]];
if (existsSync(join(automation, 'manifest.json'))) runs.push(['automation', false, automationChecks, automation]);
const labels = { 'no-access': 'real manifest, no site access', access: 'site access granted', automation: 'automation build' };
for (const [name, grant, checks, source] of runs) {
  const b = await launch(name, grant, source);
  console.log(`\n${b.version}, ${labels[name]}`);
  try {
    await checks(b.tabs, { ...urls, extId: b.extId, fixtureDir, requests, saw: path => headersByPath.get(path), port: CDP_PORT, root }, check);
  } catch (e) {
    check(`${name}: finished without errors`, false, e.stack);
  } finally {
    await b.close();
  }
}

echo.close();
const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
