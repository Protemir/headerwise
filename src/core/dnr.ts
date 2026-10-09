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
  action:
    | { type: 'modifyHeaders'; requestHeaders?: DnrHeaderInfo[]; responseHeaders?: DnrHeaderInfo[] }
    | { type: 'allow' };
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
  /** Profile title by rule priority (each enabled profile has its own priority). */
  titles: Record<number, string>;
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

interface ProfileParts {
  title: string;
  index: number;
  requestHeaders: DnrHeaderInfo[];
  responseHeaders: DnrHeaderInfo[];
  conditions: DnrRule['condition'][];
  /** "Never on" filters Chrome can't express as excluded domains; they become allow rules. */
  allowConditions: DnrRule['condition'][];
}

function profileConditions(p: Profile): Pick<ProfileParts, 'conditions' | 'allowConditions'> {
  const excludedDomains: string[] = [];
  const allowConditions: DnrRule['condition'][] = [];
  for (const f of p.filters) {
    const pattern = f.pattern.trim();
    if (!f.enabled || f.kind !== 'exclude' || pattern === '') continue;
    if (f.isRegex) allowConditions.push({ regexFilter: pattern, resourceTypes: ALL_RESOURCE_TYPES });
    else if (DOMAIN.test(pattern)) excludedDomains.push(pattern.toLowerCase());
    else allowConditions.push({ urlFilter: pattern, resourceTypes: ALL_RESOURCE_TYPES });
  }
  const base = {
    resourceTypes: ALL_RESOURCE_TYPES,
    ...(excludedDomains.length ? { excludedRequestDomains: excludedDomains } : {}),
  };

  const includes = p.filters.filter(f => f.enabled && f.kind === 'include' && f.pattern.trim() !== '');
  const conditions = includes.length === 0
    ? [{ ...base }]
    : includes.map(f => f.isRegex
      ? { ...base, regexFilter: f.pattern.trim() }
      : { ...base, urlFilter: f.pattern.trim() });
  return { conditions, allowConditions };
}

function sharedHeader(a: ProfileParts, b: ProfileParts): string | undefined {
  for (const dir of ['requestHeaders', 'responseHeaders'] as const) {
    const names = new Set(b[dir].map(h => h.header.toLowerCase()));
    const hit = a[dir].find(h => names.has(h.header.toLowerCase()));
    if (hit) return hit.header;
  }
  return undefined;
}

/**
 * Turns the user's profiles into declarativeNetRequest dynamic rules.
 * The first profile in the list wins when two profiles touch the same header.
 *
 * Chrome has no "skip URLs matching this regex" condition. Such a "never on"
 * filter (or a non-domain urlFilter) becomes an `allow` rule with the profile's
 * own priority: Chrome then ignores every modifyHeaders rule with priority <=
 * that allow rule on matching URLs. That would also switch off every profile
 * below, so profiles with these excludes are moved under all the others.
 */
export function toDnrRules(state: State): ConversionResult {
  const warnings: string[] = [];
  const rules: DnrRule[] = [];
  const titles: Record<number, string> = {};
  if (state.paused) return { rules, warnings, titles };

  const parts: ProfileParts[] = [];
  state.profiles.forEach((p, index) => {
    if (!p.enabled) return;
    const requestHeaders = convertHeaders(p.requestHeaders, 'request', p.title, warnings);
    const responseHeaders = convertHeaders(p.responseHeaders, 'response', p.title, warnings);
    if (requestHeaders.length === 0 && responseHeaders.length === 0) return;
    parts.push({ title: p.title, index, requestHeaders, responseHeaders, ...profileConditions(p) });
  });

  const plain = parts.filter(x => x.allowConditions.length === 0);
  const withAllow = parts.filter(x => x.allowConditions.length > 0);
  for (const x of withAllow) {
    for (const y of plain) {
      const header = y.index > x.index ? sharedHeader(x, y) : undefined;
      if (header) warnings.push(`"${x.title}" has "never on" patterns, so "${y.title}" wins on header "${header}" even though it is lower in the list.`);
    }
  }
  withAllow.forEach((x, i) => {
    for (const y of withAllow.slice(i + 1)) {
      warnings.push(`"${x.title}": its "never on" patterns also turn off "${y.title}" on matching URLs.`);
    }
  });

  const ordered = [...plain, ...withAllow];
  ordered.forEach((x, pos) => {
    const priority = ordered.length - pos;
    titles[priority] = x.title;
    for (const condition of x.conditions) {
      rules.push({
        id: rules.length + 1,
        priority,
        action: {
          type: 'modifyHeaders',
          ...(x.requestHeaders.length ? { requestHeaders: x.requestHeaders } : {}),
          ...(x.responseHeaders.length ? { responseHeaders: x.responseHeaders } : {}),
        },
        condition,
      });
    }
    for (const condition of x.allowConditions) {
      rules.push({ id: rules.length + 1, priority, action: { type: 'allow' }, condition });
    }
  });

  limitRules(rules, warnings);
  return { rules, warnings, titles };
}

/**
 * Chrome uses RE2, so lookaheads, backreferences and very large patterns from
 * JS-style (e.g. ModHeader) regexes are rejected, and one bad regex fails the
 * whole update. Drops rules whose regex Chrome can't use. If it is an exclude
 * (allow rule), the whole profile is dropped: applying headers where the user
 * said "never" is worse than not applying them.
 */
export async function dropUnsupportedRegexes(
  { rules, warnings, titles }: ConversionResult,
  isSupported: (regex: string) => Promise<{ isSupported: boolean; reason?: string }>,
): Promise<DnrRule[]> {
  const badRules = new Set<DnrRule>();
  const badPriorities = new Set<number>();
  for (const r of rules) {
    const regex = r.condition.regexFilter;
    if (regex === undefined) continue;
    const res = await isSupported(regex);
    if (res.isSupported) continue;
    const why = res.reason ? ` (${res.reason})` : '';
    if (r.action.type === 'allow') {
      badPriorities.add(r.priority);
      warnings.push(`"${titles[r.priority]}": "never on" regex "${regex}" is not supported by Chrome${why}, so this profile is off.`);
    } else {
      badRules.add(r);
      warnings.push(`"${titles[r.priority]}": "only on" regex "${regex}" is not supported by Chrome${why}, skipped.`);
    }
  }
  return rules
    .filter(r => !badRules.has(r) && !badPriorities.has(r.priority))
    .map((r, i) => ({ ...r, id: i + 1 }));
}

function limitRules(rules: DnrRule[], warnings: string[]): void {
  if (rules.length > MAX_DYNAMIC_RULES) {
    warnings.push(`Too many rules (${rules.length}), Chrome allows ${MAX_DYNAMIC_RULES}. Only the first ${MAX_DYNAMIC_RULES} are applied.`);
    rules.length = MAX_DYNAMIC_RULES;
  }
  const regexCount = rules.filter(r => r.condition.regexFilter).length;
  if (regexCount > MAX_REGEX_RULES) {
    warnings.push(`Too many regex filters (${regexCount}), Chrome allows ${MAX_REGEX_RULES}.`);
  }
}
