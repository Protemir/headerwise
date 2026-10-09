import type { HeaderMod, Profile, State } from './model.ts';

/**
 * Minimal mirror of chrome.declarativeNetRequest.Rule, so the core can be
 * tested in Node without the chrome object.
 */
export interface DnrHeaderInfo {
  header: string;
  operation: 'set' | 'remove' | 'append';
  value?: string;
}

export interface DnrRule {
  id: number;
  priority: number;
  action: {
    type: 'modifyHeaders';
    requestHeaders?: DnrHeaderInfo[];
    responseHeaders?: DnrHeaderInfo[];
  };
  condition: {
    urlFilter?: string;
    regexFilter?: string;
    excludedRequestDomains?: string[];
    resourceTypes: string[];
  };
}

export interface ConversionResult {
  rules: DnrRule[];
  warnings: string[];
}

// Without an explicit list Chrome skips main_frame, which surprises users.
export const ALL_RESOURCE_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other',
];

// Chrome allows "append" only for these request headers.
export const APPENDABLE_REQUEST_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'access-control-request-headers',
  'cache-control', 'connection', 'content-language', 'cookie', 'forwarded',
  'if-match', 'if-none-match', 'keep-alive', 'range', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'user-agent', 'via', 'want-digest', 'x-forwarded-for',
]);

// Chrome limits; checked here so the user sees a warning instead of a silent failure.
export const MAX_DYNAMIC_RULES = 5000;
export const MAX_REGEX_RULES = 1000;

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DOMAIN = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i;

function convertHeaders(
  headers: HeaderMod[],
  direction: 'request' | 'response',
  profileTitle: string,
  warnings: string[],
): DnrHeaderInfo[] {
  const out: DnrHeaderInfo[] = [];
  for (const h of headers) {
    if (!h.enabled) continue;
    const name = h.name.trim();
    if (name === '') continue;
    const where = `"${profileTitle}", ${direction} header "${name}"`;
    if (!TOKEN.test(name)) {
      warnings.push(`${where}: invalid header name, skipped.`);
      continue;
    }
    if (h.op !== 'remove' && /[\r\n]/.test(h.value)) {
      warnings.push(`${where}: value contains a line break, skipped.`);
      continue;
    }
    if (h.op === 'append' && direction === 'request' && !APPENDABLE_REQUEST_HEADERS.has(name.toLowerCase())) {
      warnings.push(`${where}: Chrome can't append to this request header, use "set" instead. Skipped.`);
      continue;
    }
    out.push(h.op === 'remove'
      ? { header: name, operation: 'remove' }
      : { header: name, operation: h.op, value: h.value });
  }
  return out;
}

function profileConditions(p: Profile, warnings: string[]): DnrRule['condition'][] {
  const excludedDomains: string[] = [];
  for (const f of p.filters) {
    if (!f.enabled || f.kind !== 'exclude') continue;
    const d = f.pattern.trim().toLowerCase();
    if (!f.isRegex && DOMAIN.test(d)) excludedDomains.push(d);
    else warnings.push(`"${p.title}": exclude filter "${f.pattern}" ignored, only plain domains are supported for now.`);
  }
  const base = {
    resourceTypes: ALL_RESOURCE_TYPES,
    ...(excludedDomains.length ? { excludedRequestDomains: excludedDomains } : {}),
  };

  const includes = p.filters.filter(f => f.enabled && f.kind === 'include' && f.pattern.trim() !== '');
  if (includes.length === 0) return [{ ...base }];
  return includes.map(f => f.isRegex
    ? { ...base, regexFilter: f.pattern.trim() }
    : { ...base, urlFilter: f.pattern.trim() });
}

/**
 * Turns the user's profiles into declarativeNetRequest dynamic rules.
 * The first profile in the list wins when two profiles touch the same header.
 */
export function toDnrRules(state: State): ConversionResult {
  const warnings: string[] = [];
  const rules: DnrRule[] = [];
  if (state.paused) return { rules, warnings };

  const n = state.profiles.length;
  state.profiles.forEach((p, index) => {
    if (!p.enabled) return;
    const requestHeaders = convertHeaders(p.requestHeaders, 'request', p.title, warnings);
    const responseHeaders = convertHeaders(p.responseHeaders, 'response', p.title, warnings);
    if (requestHeaders.length === 0 && responseHeaders.length === 0) return;

    for (const condition of profileConditions(p, warnings)) {
      rules.push({
        id: rules.length + 1,
        priority: n - index,
        action: {
          type: 'modifyHeaders',
          ...(requestHeaders.length ? { requestHeaders } : {}),
          ...(responseHeaders.length ? { responseHeaders } : {}),
        },
        condition,
      });
    }
  });

  if (rules.length > MAX_DYNAMIC_RULES) {
    warnings.push(`Too many rules (${rules.length}), Chrome allows ${MAX_DYNAMIC_RULES}. Only the first ${MAX_DYNAMIC_RULES} are applied.`);
    rules.length = MAX_DYNAMIC_RULES;
  }
  const regexCount = rules.filter(r => r.condition.regexFilter).length;
  if (regexCount > MAX_REGEX_RULES) {
    warnings.push(`Too many regex filters (${regexCount}), Chrome allows ${MAX_REGEX_RULES}.`);
  }
  return { rules, warnings };
}
