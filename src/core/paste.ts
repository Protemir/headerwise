/*
 * Turns what people copy out of DevTools into headers: "Copy as cURL" (bash and
 * cmd), "Copy as fetch" (browser and Node.js), "Copy as PowerShell", or plain
 * "Name: value" lines. Formats follow Chrome DevTools' own generators
 * (front_end/panels/network/NetworkLogView.ts).
 */

export interface PastedHeader {
  name: string;
  value: string;
  /** Pre-ticked: headers people usually want to replay (auth, custom x-*). */
  suggested: boolean;
}

export interface PasteResult {
  url?: string;
  headers: PastedHeader[];
}

// Set by the browser or the connection itself; replaying them makes no sense.
const DROPPED = new Set([
  'host', 'content-length', 'connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'expect',
  'method', 'path', 'scheme', 'authority', 'version', 'protocol',
]);

// The browser sends its own; offered, but not ticked. Cookie replaces all the
// site's real cookies, so it needs a conscious tick too.
const NOT_SUGGESTED = /^(accept(-encoding|-language)?|cache-control|pragma|content-type|cookie|dnt|if-.*|origin|priority|referer|sec-.*|upgrade-insecure-requests|user-agent|te|range)$/i;

function header(name: string, value: string): PastedHeader | null {
  const n = name.trim().replace(/^:/, '');
  if (n === '' || name.trim().startsWith(':') || DROPPED.has(n.toLowerCase()) || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(n)) return null;
  return { name: n, value: value.trim(), suggested: !NOT_SUGGESTED.test(n) };
}

/** Shell-style words: '...', "...", $'...' (with \n, \uXXXX…), backslash escapes and line continuations. */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  let i = 0;
  const flush = () => { if (cur !== null) out.push(cur); cur = null; };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) { i += s[i + 1] === '\r' ? 3 : 2; continue; }
    if (/\s/.test(c)) { flush(); i++; continue; }
    cur ??= '';
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      cur += end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      i = end < 0 ? s.length : end + 1;
    } else if (c === '$' && s[i + 1] === "'") {
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] !== '\\') { cur += s[i++]; continue; }
        const e = s[i + 1];
        i += 2;
        if (e === 'n') cur += '\n';
        else if (e === 'r') cur += '\r';
        else if (e === 't') cur += '\t';
        else if (e === 'u') { cur += String.fromCharCode(parseInt(s.slice(i, i + 4), 16)); i += 4; }
        else if (e === 'x') { cur += String.fromCharCode(parseInt(s.slice(i, i + 2), 16)); i += 2; }
        else cur += e ?? '';
      }
      i++;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { cur += s[i + 1]; i += 2; }
        else cur += s[i++];
      }
      i++;
    } else if (c === '\\') {
      cur += s[i + 1] ?? '';
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  flush();
  return out;
}

// btoa takes Latin-1 only; curl sends the user name and password as UTF-8.
function base64Utf8(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

// A JS string literal's value: "...", '...' or `...` (no ${} in what DevTools or people paste).
function jsString(lit: string): string {
  const body = lit.slice(1, -1);
  if (lit[0] === '"') { try { return JSON.parse(lit); } catch { return body; } }
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e: string) =>
    e[0] === 'u' || e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : e === 'n' ? '\n' : e === 't' ? '\t' : e);
}

const JS_STRING = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` + '`(?:[^`\\\\]|\\\\.)*`';

// curl flags that take a value we don't need.
const SKIP_VALUE = new Set(['-X', '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '-F', '--form', '-o', '--output', '-x', '--proxy', '-m', '--max-time']);

function fromCurl(text: string): PasteResult {
  let s = text;
  if (/\^"/.test(s)) {
    // "Copy as cURL (cmd)": ^-escapes and ^ line continuations around a "..." / \" quoting.
    s = s.replace(/\^\r?\n/g, ' ').replace(/%\^/g, '%').replace(/\^([\s\S])/g, '$1');
  }
  const words = shellWords(s);
  const headers: PastedHeader[] = [];
  let url: string | undefined;
  const add = (h: PastedHeader | null) => { if (h) headers.push(h); };
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    if (w === '--url' && next !== undefined) { url = next.replace(/\\([[\]{}])/g, '$1'); i++; }
    else if ((w === '-H' || w === '--header') && next !== undefined) {
      const colon = next.indexOf(':');
      if (colon < 0 && next.endsWith(';')) add(header(next.slice(0, -1), ''));
      else if (colon > 0) add(header(next.slice(0, colon), next.slice(colon + 1)));
      i++;
    }
    else if ((w === '-b' || w === '--cookie') && next !== undefined) { if (next.includes('=')) add(header('Cookie', next)); i++; }
    else if ((w === '-A' || w === '--user-agent') && next !== undefined) { add(header('User-Agent', next)); i++; }
    else if ((w === '-e' || w === '--referer') && next !== undefined) { add(header('Referer', next)); i++; }
    else if ((w === '-u' || w === '--user') && next !== undefined) { add(header('Authorization', `Basic ${base64Utf8(next)}`)); i++; }
    else if (SKIP_VALUE.has(w)) i++;
    else if (!w.startsWith('-') && url === undefined && /^https?:\/\//i.test(w)) url = w;
  }
  return { url, headers };
}

function fromFetch(text: string): PasteResult {
  const urlLiteral = new RegExp(String.raw`fetch\(\s*(${JS_STRING})`).exec(text)?.[1];
  const start = text.indexOf('{', text.indexOf('fetch('));
  const end = text.lastIndexOf('}');
  const headers: PastedHeader[] = [];
  let options: { headers?: Record<string, string>; referrer?: string } | undefined;
  try {
    options = JSON.parse(text.slice(start, end + 1));
  } catch {
    // Written by hand or with comments: name/value pairs out of the headers block,
    // with keys quoted or not and any kind of JS string as the value.
    const block = /["']?headers["']?\s*:\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? '';
    options = { headers: {} };
    const pair = new RegExp(String.raw`(${JS_STRING}|[A-Za-z_$][\w$-]*)\s*:\s*(${JS_STRING})`, 'g');
    for (const m of block.matchAll(pair)) {
      const key = /^["'`]/.test(m[1]) ? jsString(m[1]) : m[1];
      options.headers![key] = jsString(m[2]);
    }
  }
  for (const [name, value] of Object.entries(options?.headers ?? {})) {
    const h = header(name, String(value));
    if (h) headers.push(h);
  }
  if (options?.referrer && !headers.some(h => h.name.toLowerCase() === 'referer')) {
    const h = header('Referer', options.referrer);
    if (h) headers.push(h);
  }
  return { url: urlLiteral ? jsString(urlLiteral) : undefined, headers };
}

function psString(s: string): string {
  // '...' is literal ('' is a quote); "..." has `-escapes and $([char]NNN) for non-ASCII
  if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s.slice(1, -1).replace(/\$\(\[char\](\d+)\)/g, (_, code) => String.fromCharCode(Number(code))).replace(/`([\s\S])/g, '$1');
}

const PS_STRING = String.raw`"(?:[^"` + '`' + String.raw`]|` + '`' + String.raw`[\s\S])*"|'(?:[^']|'')*'`;

function fromPowerShell(text: string): PasteResult {
  const headers: PastedHeader[] = [];
  const add = (h: PastedHeader | null) => { if (h) headers.push(h); };
  const ua = new RegExp(`\\$session\\.UserAgent\\s*=\\s*(${PS_STRING})`).exec(text);
  if (ua) add(header('User-Agent', psString(ua[1])));
  const cookies = [...text.matchAll(new RegExp(`System\\.Net\\.Cookie\\((${PS_STRING}),\\s*(${PS_STRING})`, 'g'))]
    .map(m => `${psString(m[1])}=${psString(m[2])}`);
  if (cookies.length) add(header('Cookie', cookies.join('; ')));
  // DevTools writes the block over several lines and closes it on a line of its
  // own; by hand it is often one line: -Headers @{ Authorization = 'Bearer x'; "X-A" = "1" }
  const block = (/-Headers\s*@\{([\s\S]*?)\n\}/.exec(text) ?? /-Headers\s*@\{([\s\S]*?)\}/.exec(text))?.[1] ?? '';
  const pair = new RegExp(String.raw`(${PS_STRING}|[A-Za-z_][\w-]*)\s*=\s*(${PS_STRING})`, 'g');
  for (const m of block.matchAll(pair)) add(header(/^["']/.test(m[1]) ? psString(m[1]) : m[1], psString(m[2])));
  const url = new RegExp(`-Uri\\s+(${PS_STRING})`).exec(text)?.[1];
  return { url: url ? psString(url) : undefined, headers };
}

function fromLines(text: string): PasteResult {
  const headers: PastedHeader[] = [];
  const lines = text.split(/\r?\n/).map(l => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' || /^[A-Z]+ \S+ HTTP\/[\d.]+$/.test(line) || /^HTTP\/[\d.]+ /.test(line)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) continue; // a URL, not "Name: value"
    const colon = line.indexOf(':', line.startsWith(':') ? 1 : 0);
    if (colon < 0) continue;
    let value = line.slice(colon + 1);
    // The DevTools headers pane copies as "Name:" on one line and the value on the
    // next. The next line is a value unless it starts a header itself (a URL value
    // like https://... doesn't).
    const next = lines[i + 1];
    if (value.trim() === '' && next !== undefined && next !== '' && !/^:?[!#$%&'*+\-.^_`|~0-9A-Za-z]+:(?!\/\/)/.test(next)) value = lines[++i];
    const h = header(line.slice(0, colon), value);
    if (h) headers.push(h);
  }
  return { headers };
}

export function parsePasted(text: string): PasteResult {
  const t = text.trim();
  let r: PasteResult;
  if (/^curl(\.exe)?\s/i.test(t)) r = fromCurl(t);
  else if (/(^|\s)fetch\(/.test(t)) r = fromFetch(t);
  else if (/Invoke-WebRequest|Invoke-RestMethod|\$session\s*=/.test(t)) r = fromPowerShell(t);
  else r = fromLines(t);
  // One entry per name; the last one wins, like a later -H in curl.
  const byName = new Map<string, PastedHeader>();
  for (const h of r.headers) byName.set(h.name.toLowerCase(), h);
  return { ...r, headers: [...byName.values()] };
}
