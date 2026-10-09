import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { parsePasted, shellWords } from '../src/core/paste.ts';
import { addHeaders, applyPreset, PRESETS } from '../src/core/presets.ts';
import { emptyProfile } from '../src/core/model.ts';

// Samples follow Chrome DevTools' generators (NetworkLogView.ts): generateCurlCommand
// for unix and win, generateFetchCall, generatePowerShellCommand.

const curlBash = `curl --url 'https://api.example.com/v1/items?page=1' \\
  -H 'accept: application/json' \\
  -H 'accept-language: en-US,en;q=0.9' \\
  -H 'authorization: Bearer eyJhbGciOi.payload.sig' \\
  -b 'session=abc123; theme=dark' \\
  -H 'priority: u=1, i' \\
  -H 'sec-ch-ua: "Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"' \\
  -H 'x-empty;' \\
  -H $'x-note: it\\'s caf\\u00e9!' \\
  -H 'x-tenant: acme' \\
  -H 'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)' \\
  --data-raw '{"q":1}'`;

const curlCmd = `curl ^"https://api.example.com/v1/items?page=1^&sort=asc^" ^
  -H ^"accept: application/json^" ^
  -H ^"authorization: Bearer eyJhbGciOi.payload.sig^" ^
  -b ^"session=abc123; theme=dark^" ^
  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"154^\\^"^" ^
  -H ^"x-path: C:^\\^\\temp^" ^
  -H ^"x-pct: 100^%^&x=^%^PATH^%^" ^
  -H ^"x-tenant: acme^"`;

const fetchBrowser = `fetch("https://api.example.com/v1/items?page=1", {
  "headers": {
    "accept": "application/json",
    "authorization": "Bearer eyJhbGciOi.payload.sig",
    "sec-ch-ua": "\\"Chromium\\";v=\\"154\\"",
    "x-tenant": "acme"
  },
  "referrer": "https://app.example.com/",
  "body": null,
  "method": "GET",
  "mode": "cors",
  "credentials": "include"
});`;

const fetchNode = `fetch("https://api.example.com/v1/items", {
  "headers": {
    "accept": "application/json",
    "x-tenant": "acme",
    "cookie": "session=abc123",
    "Referer": "https://app.example.com/"
  },
  "body": null,
  "method": "GET"
});`;

const powershell = `$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$session.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
$session.Cookies.Add((New-Object System.Net.Cookie("session", "abc123", "/", "api.example.com")))
$session.Cookies.Add((New-Object System.Net.Cookie("theme", "dark", "/", "api.example.com")))
Invoke-WebRequest -UseBasicParsing -Uri "https://api.example.com/v1/items" \`
-WebSession $session \`
-Headers @{
"authority"="api.example.com"
  "method"="GET"
  "path"="/v1/items"
  "scheme"="https"
  "accept"="application/json"
  "authorization"="Bearer eyJhbGciOi.payload.sig"
  "x-note"="caf$([char]233) \`"quoted\`" \`$HOME"
  "x-tenant"="acme"
}`;

const named = (r: ReturnType<typeof parsePasted>) => Object.fromEntries(r.headers.map(h => [h.name.toLowerCase(), h]));

describe('shellWords', () => {
  it('handles quotes, $\'...\' escapes and line continuations', () => {
    expect(shellWords(`a 'b c' "d \\"e\\"" $'f\\'g\\u00e9' h\\ i \\\n j`)).toEqual(['a', 'b c', 'd "e"', "f'gé", 'h i', 'j']);
  });
});

describe('parsePasted', () => {
  it('reads "Copy as cURL (bash)"', () => {
    const r = parsePasted(curlBash);
    expect(r.url).toBe('https://api.example.com/v1/items?page=1');
    const h = named(r);
    expect(h['authorization'].value).toBe('Bearer eyJhbGciOi.payload.sig');
    expect(h['authorization'].suggested).toBe(true);
    expect(h['cookie']).toEqual({ name: 'Cookie', value: 'session=abc123; theme=dark', suggested: false });
    expect(h['x-note'].value).toBe("it's café!");
    expect(h['x-empty'].value).toBe('');
    expect(h['sec-ch-ua'].value).toBe('"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"');
    expect(r.headers.filter(x => x.suggested).map(x => x.name)).toEqual(['authorization', 'x-empty', 'x-note', 'x-tenant']);
  });

  it('reads "Copy as cURL (cmd)"', () => {
    const r = parsePasted(curlCmd);
    expect(r.url).toBe('https://api.example.com/v1/items?page=1&sort=asc');
    const h = named(r);
    expect(h['authorization'].value).toBe('Bearer eyJhbGciOi.payload.sig');
    expect(h['cookie'].value).toBe('session=abc123; theme=dark');
    expect(h['sec-ch-ua'].value).toBe('"Chromium";v="154"');
    expect(h['x-path'].value).toBe('C:\\temp');
    expect(h['x-pct'].value).toBe('100%&x=%PATH%');
    expect(h['x-tenant'].value).toBe('acme');
  });

  it('reads "Copy as fetch" for the browser and for Node.js', () => {
    const b = parsePasted(fetchBrowser);
    expect(b.url).toBe('https://api.example.com/v1/items?page=1');
    expect(b.headers.map(h => [h.name, h.value])).toEqual([
      ['accept', 'application/json'], ['authorization', 'Bearer eyJhbGciOi.payload.sig'],
      ['sec-ch-ua', '"Chromium";v="154"'], ['x-tenant', 'acme'], ['Referer', 'https://app.example.com/'],
    ]);
    const n = named(parsePasted(fetchNode));
    expect(n['cookie'].value).toBe('session=abc123');
    expect(n['referer'].value).toBe('https://app.example.com/');
  });

  it('reads "Copy as PowerShell", including the session user agent and cookies', () => {
    const r = parsePasted(powershell);
    expect(r.url).toBe('https://api.example.com/v1/items');
    const h = named(r);
    expect(h['user-agent'].value).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(h['cookie'].value).toBe('session=abc123; theme=dark');
    expect(h['x-note'].value).toBe('café "quoted" $HOME');
    expect(h['authority']).toBe(undefined);
    expect(h['method']).toBe(undefined);
    expect(h['x-tenant'].suggested).toBe(true);
  });

  it('reads Name: value lines, HTTP/2 pseudo-headers and the two-line DevTools pane copy', () => {
    const r = parsePasted(':authority: api.example.com\n:method: GET\nAuthorization: Bearer t\nX-Tenant:\nacme\nGET /x HTTP/1.1\nHost: api.example.com\nX-Trace: a:b:c');
    expect(r.headers.map(h => [h.name, h.value])).toEqual([['Authorization', 'Bearer t'], ['X-Tenant', 'acme'], ['X-Trace', 'a:b:c']]);
  });

  it('round-trips tricky values through DevTools\' own escaping (bash and cmd)', () => {
    // escapeStringPosix / escapeStringWin from NetworkLogView.ts, unchanged.
    const posix = (str: string) => {
      const ch = (x: string) => '\\u' + x.charCodeAt(0).toString(16).padStart(4, '0');
      if (/[\0-\x1F\x7F-\x9F!]|\'/.test(str)) {
        return '$\'' + str.replace(/\\/g, '\\\\').replace(/\'/g, '\\\'').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/[\0-\x1F\x7F-\x9F!]/g, ch) + '\'';
      }
      return '\'' + str + '\'';
    };
    const win = (str: string) => '^"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[^a-zA-Z0-9\s_\-:=+~'\/.',?;*]/g, '^$&')
      .replace(/%(?=[a-zA-Z0-9_])/g, '%^').replace(/[^ -~\r\n]/g, ' ').replace(/\r?\n|\r/g, '^\n\n') + '^"';
    const values = ['100%&x=%PATH%', 'C:\\temp\\new', '"Chromium";v="154"', "it's !important", 'a|b<c>d^e', 'tab\there', '$HOME `x`'];
    for (const v of values) {
      const bash = parsePasted(`curl --url 'https://h.io/' \\\n  -H ${posix(`x-v: ${v}`)}`);
      expect(bash.headers[0]?.value).toBe(v);
      const cmd = parsePasted(`curl ^"https://h.io/^" ^\n  -H ${win(`x-v: ${v}`)}`);
      expect(cmd.headers[0]?.value).toBe(v.replace(/\t/g, ' ')); // cmd can't carry a tab, DevTools turns it into a space
    }
  });

  it('keeps the last value when a header repeats, and ignores junk', () => {
    expect(parsePasted('X-A: 1\nX-A: 2').headers.map(h => h.value)).toEqual(['2']);
    expect(parsePasted('hello world').headers).toEqual([]);
    expect(parsePasted('Bad Name: x').headers).toEqual([]);
  });
});

describe('presets', () => {
  it('fills the empty starter row, then updates headers with the same name instead of duplicating', () => {
    const p = emptyProfile();
    applyPreset(p, PRESETS.find(x => x.id === 'mobile')!);
    expect(p.requestHeaders.map(h => h.name)).toEqual(['User-Agent']);
    applyPreset(p, PRESETS.find(x => x.id === 'googlebot')!);
    expect(p.requestHeaders).toHaveLength(1);
    expect(p.requestHeaders[0].value).toMatch(/Googlebot/);
  });

  it('removes response headers for the CSP preset', () => {
    const p = emptyProfile();
    applyPreset(p, PRESETS.find(x => x.id === 'no-csp')!);
    expect(p.responseHeaders.map(h => [h.name, h.op, h.value])).toEqual([
      ['Content-Security-Policy', 'remove', ''], ['Content-Security-Policy-Report-Only', 'remove', ''],
    ]);
  });

  it('addHeaders matches names case-insensitively', () => {
    const p = emptyProfile();
    addHeaders(p.requestHeaders, [{ name: 'x-tenant', value: 'a' }]);
    addHeaders(p.requestHeaders, [{ name: 'X-Tenant', value: 'b' }]);
    expect(p.requestHeaders.map(h => [h.name, h.value])).toEqual([['X-Tenant', 'b']]);
  });
});
