// A tiny server for the automation smoke tests: /h/<name> answers with what the
// request header <name> was ("(none)" if it wasn't sent), as plain text.
import { createServer } from 'node:http';

export const ID = 'mhlgmcieamjogdlnfjaoeophmdajkkek';

export function start(port = Number(process.env.SMOKE_PORT ?? 8788)) {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.replace(/^\/h\//, '')).toLowerCase();
    res.setHeader('Content-Type', 'text/plain');
    res.end(String(req.headers[name] ?? '(none)'));
  });
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${port}` })));
}

/** Runs one tool's checks the same way: set, check, change, clear. */
export async function smoke(name, { open, text, close }) {
  const { server, base } = await start();
  const failures = [];
  const check = (what, got, want) => {
    const ok = got === want;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${what}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
    if (!ok) failures.push(what);
  };
  try {
    check('page ready', await open(`chrome-extension://${ID}/automation.html?X-Test=hello&res:X-Resp=yes`), 'ready');
    check('request header sent', await text(`${base}/h/x-test`), 'hello');
    check('response header set', await text(`${base}/h/x-test`, 'x-resp'), 'yes');
    check('next call replaces', await open(`chrome-extension://${ID}/automation.html?X-Other=2`), 'ready');
    check('old header gone', await text(`${base}/h/x-test`), '(none)');
    check('new header sent', await text(`${base}/h/x-other`), '2');
    check('@url limits', await open(`chrome-extension://${ID}/automation.html?X-Test=only&@url=||example.invalid^`), 'ready');
    check('not on other URLs', await text(`${base}/h/x-test`), '(none)');
    check('bad name refused', await open(`chrome-extension://${ID}/automation.html?Bad%20Name=1`), 'error');
    check('@clear', await open(`chrome-extension://${ID}/automation.html?@clear`), 'ready');
    check('nothing sent after @clear', await text(`${base}/h/x-test`), '(none)');
    // chrome-modheader's URLs, unchanged.
    check('modheader /add', await open('https://webdriver.modheader.com/add?X-Test=mh'), 'ready');
    check('modheader header sent', await text(`${base}/h/x-test`), 'mh');
    check('modheader /clear', await open('https://webdriver.modheader.com/clear'), 'ready');
    check('nothing sent after /clear', await text(`${base}/h/x-test`), '(none)');
  } finally {
    await close();
    server.close();
  }
  if (failures.length) process.exit(1);
}
