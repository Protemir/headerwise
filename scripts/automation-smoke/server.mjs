// A tiny server for the automation smoke tests: /h/<name> answers with what the
// request header <name> was ("(none)" if it wasn't sent), as plain text.
import { createServer } from 'node:http';

export const ID = 'ogjbgamdhnjnagcdgboifgmhlgddcdce';

export function start(port = Number(process.env.SMOKE_PORT ?? 8788)) {
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.replace(/^\/h\//, '')).toLowerCase();
    res.setHeader('Content-Type', 'text/plain');
    res.end(String(req.headers[name] ?? '(none)'));
  });
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok({ server, base: `http://127.0.0.1:${port}` })));
}

/** The usual checks: set, check, change, clear. */
function defaultSteps(base, open, text) {
  const page = `chrome-extension://${ID}/automation.html`;
  return [
    ['page ready', () => open(`${page}?X-Test=hello&res:X-Resp=yes`), 'ready'],
    ['request header sent', () => text(`${base}/h/x-test`), 'hello'],
    ['response header set', () => text(`${base}/h/x-test`, 'x-resp'), 'yes'],
    ['next call replaces', () => open(`${page}?X-Other=2`), 'ready'],
    ['old header gone', () => text(`${base}/h/x-test`), '(none)'],
    ['new header sent', () => text(`${base}/h/x-other`), '2'],
    ['@url limits', () => open(`${page}?X-Test=only&@url=||example.invalid^`), 'ready'],
    ['not on other URLs', () => text(`${base}/h/x-test`), '(none)'],
    ['bad name refused', () => open(`${page}?Bad%20Name=1`), 'error'],
    ['@clear', () => open(`${page}?@clear`), 'ready'],
    ['nothing sent after @clear', () => text(`${base}/h/x-test`), '(none)'],
    // chrome-modheader's URLs, unchanged.
    ['modheader /add', () => open('https://webdriver.modheader.com/add?X-Test=mh'), 'ready'],
    ['modheader header sent', () => text(`${base}/h/x-test`), 'mh'],
    ['modheader /clear', () => open('https://webdriver.modheader.com/clear'), 'ready'],
    ['nothing sent after /clear', () => text(`${base}/h/x-test`), '(none)'],
  ];
}

/** Runs one tool's checks: the usual ones from open/text, or its own steps(base). */
export async function smoke(name, { open, text, steps, close }) {
  const { server, base } = await start();
  const failures = [];
  try {
    for (const [what, run, want] of steps ? steps(base) : defaultSteps(base, open, text)) {
      const got = await run().catch(e => `error: ${e.message.split('\n')[0]}`);
      const ok = got === want;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${what}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
      if (!ok) failures.push(what);
    }
  } finally {
    await close();
    server.close();
  }
  if (failures.length) process.exit(1);
}
