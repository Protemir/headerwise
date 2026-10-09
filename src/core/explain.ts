import type { RuleInfo } from './dnr.ts';
import { RESOURCE_TYPES, type Profile, type State } from './model.ts';

/*
 * "Is it working on this tab?" Chrome tells us which of our rules matched
 * requests in the tab (getMatchedRules); this turns that into one line per
 * profile, and when nothing matched, checks the page URL against the profile's
 * filters to say why.
 */

/**
 * Chrome's urlFilter syntax as a RegExp: `*` any text, `^` a separator (not a
 * letter, digit or _-.%) or the end, `|` anchors at the start or end, `||` the
 * start of the host or of a subdomain. Case-insensitive, like Chrome's default.
 */
export function urlFilterRegExp(filter: string): RegExp {
  let f = filter;
  let prefix = '';
  let suffix = '';
  if (f.startsWith('||')) { prefix = '^[a-z][a-z0-9+.-]*://(?:[^/?#]*\\.)?'; f = f.slice(2); }
  else if (f.startsWith('|')) { prefix = '^'; f = f.slice(1); }
  if (f.endsWith('|')) { suffix = '$'; f = f.slice(0, -1); }
  const body = [...f].map(c => c === '*' ? '.*' : c === '^' ? '(?:[^a-z0-9_.%-]|$)' : c.replace(/[.+?${}()|[\]\\/]/g, '\\$&')).join('');
  return new RegExp(prefix + body + suffix, 'i');
}

function matches(pattern: string, isRegex: boolean, url: string): boolean | undefined {
  try {
    return isRegex ? new RegExp(pattern).test(url) : urlFilterRegExp(pattern).test(url);
  } catch {
    return undefined; // a regex JS can't parse; Chrome will have warned about it
  }
}

const DOMAIN = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i;

export type PageVerdict =
  | { kind: 'applies' }
  | { kind: 'excluded'; pattern: string }
  | { kind: 'not-included'; patterns: string[] };

/** Would the profile's filters let it touch the page itself (the main document)? */
export function pageVerdict(p: Profile, url: string): PageVerdict {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* keep empty */ }
  for (const f of p.filters) {
    const pattern = f.pattern.trim();
    if (!f.enabled || f.kind !== 'exclude' || pattern === '') continue;
    const hit = !f.isRegex && DOMAIN.test(pattern)
      ? host === pattern.toLowerCase() || host.endsWith(`.${pattern.toLowerCase()}`)
      : matches(pattern, f.isRegex, url);
    if (hit) return { kind: 'excluded', pattern };
  }
  const includes = p.filters.filter(f => f.enabled && f.kind === 'include' && f.pattern.trim() !== '');
  if (includes.length && !includes.some(f => matches(f.pattern.trim(), f.isRegex, url) !== false)) {
    return { kind: 'not-included', patterns: includes.map(f => f.pattern.trim()) };
  }
  return { kind: 'applies' };
}

export interface MatchedRule {
  ruleId: number;
  timeStamp: number;
}

export type TabLine =
  | { kind: 'applied'; requests: number; skippedBy?: string } // skippedBy: a "never on" that keeps it off part of the tab
  | { kind: 'excluded'; pattern: string }
  | { kind: 'not-included'; patterns: string[] }
  | { kind: 'other-tab'; host: string } // "only this tab", bound to a different tab
  | { kind: 'narrowed'; scope: string } // limited by type / method / initiator, and none of those seen
  | { kind: 'waiting' } // should apply, but no requests since the last change
  | { kind: 'off' }
  | { kind: 'empty' };

export interface TabReportLine {
  profileId: string;
  title: string;
  line: TabLine;
}

/** "fetch / XHR, POST requests from app.io", or '' when the profile isn't limited that way. */
export function scopeSummary(p: Profile): string {
  const types = (p.resourceTypes ?? []).map(t => RESOURCE_TYPES.find(x => x.id === t)?.label ?? t);
  const methods = (p.requestMethods ?? []).map(m => m.toUpperCase());
  const from = (p.initiatorDomains ?? []).filter(d => d.trim());
  const notFrom = (p.excludedInitiatorDomains ?? []).filter(d => d.trim());
  if (!types.length && !methods.length && !from.length && !notFrom.length) return '';
  const what = [types.join(', '), methods.join(', ')].filter(Boolean).join(', ');
  return [what ? `${what} requests` : 'requests', from.length ? `from ${from.join(', ')}` : '', notFrom.length ? `not from ${notFrom.join(', ')}` : '']
    .filter(Boolean).join(' ');
}

export function hasHeaders(p: Profile): boolean {
  return [...p.requestHeaders, ...p.responseHeaders].some(h => h.enabled && h.name.trim() !== '');
}

/**
 * One line per profile for the tab showing `url`. `matched` comes from
 * chrome.declarativeNetRequest.getMatchedRules; matches older than `since` (the
 * last time the rules were rebuilt) are ignored, as rule ids change on rebuild.
 * Chrome 154 reports only rules that changed something, not "never on" (allow)
 * rules, so exclusions are judged from the page URL; allow matches are still
 * used if a browser does report them.
 */
export function tabReport(state: State, url: string, matched: MatchedRule[], info: Record<number, RuleInfo>, since: number, tabId?: number): TabReportLine[] {
  const requests = new Map<string, number>();
  const allowed = new Map<string, string>();
  for (const m of matched) {
    if (m.timeStamp < since) continue;
    const i = info[m.ruleId];
    if (!i) continue;
    if (i.kind === 'modify') requests.set(i.profileId, (requests.get(i.profileId) ?? 0) + 1);
    else if (i.pattern !== undefined && !allowed.has(i.profileId)) allowed.set(i.profileId, i.pattern);
  }

  return state.profiles.map(p => {
    const base = { profileId: p.id, title: p.title || 'Untitled' };
    if (!p.enabled) return { ...base, line: { kind: 'off' } };
    if (!hasHeaders(p)) return { ...base, line: { kind: 'empty' } };
    if (p.tab && p.tab.id !== tabId) return { ...base, line: { kind: 'other-tab', host: p.tab.host } };
    const verdict = pageVerdict(p, url);
    const excludedBy = allowed.get(p.id) ?? (verdict.kind === 'excluded' ? verdict.pattern : undefined);
    const n = requests.get(p.id) ?? 0;
    if (n > 0) return { ...base, line: { kind: 'applied', requests: n, ...(excludedBy ? { skippedBy: excludedBy } : {}) } };
    if (excludedBy) return { ...base, line: { kind: 'excluded', pattern: excludedBy } };
    if (verdict.kind === 'not-included') return { ...base, line: { kind: 'not-included', patterns: verdict.patterns } };
    const scope = scopeSummary(p);
    if (scope) return { ...base, line: { kind: 'narrowed', scope } };
    return { ...base, line: { kind: 'waiting' } };
  });
}
