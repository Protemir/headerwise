import { newId, type HeaderMod, type Profile, type UrlFilter } from './model.ts';

/*
 * ModHeader export format, checked against the 7.0.18 export code (as ported in
 * requestly/modheader-export-backup), the open 2.x/3.x sources and real files
 * from public repos.
 *
 * The file is a bare JSON array of profiles (2.x exported a single object).
 * Exports drop empty lists and empty comments, so every field is optional.
 *
 * version 2 (7.x): appendMode and sendEmptyHeader live on each header;
 *   filters are split into urlFilters, excludeUrlFilters, initiatorDomainFilters,
 *   excludeRequestDomainFilters, resourceFilters, requestMethodFilters,
 *   tabFilters, tabGroupFilters, windowFilters, timeFilters.
 * no version (2.x/3.x): appendMode and sendEmptyHeader are per profile, and
 *   filters is one list tagged with type 'urls' | 'excludeUrls' | 'types'.
 *
 * appendMode: undefined/false = override, 'append' or true/'true' = append,
 * 'comma' = append comma-separated. A header with an empty value and no
 * sendEmptyHeader is removed, not sent empty.
 */

type AppendMode = boolean | string | undefined;

interface MhHeader { enabled?: boolean; name?: string; value?: string; comment?: string; appendMode?: AppendMode; sendEmptyHeader?: boolean }
interface MhUrlFilter { enabled?: boolean; type?: string; urlRegex?: string; urlPattern?: string; resourceType?: string[] }
interface MhDomainFilter { enabled?: boolean; domain?: string }
interface MhProfile {
  version?: number;
  title?: string;
  shortTitle?: string;
  appendMode?: AppendMode;
  sendEmptyHeader?: boolean;
  headers?: MhHeader[];
  respHeaders?: MhHeader[];
  reqCookieAppend?: MhHeader[];
  filters?: MhUrlFilter[];
  urlFilters?: MhUrlFilter[];
  excludeUrlFilters?: MhUrlFilter[];
  excludeRequestDomainFilters?: MhDomainFilter[];
  [other: string]: unknown;
}

export interface ImportResult {
  profiles: Profile[];
  warnings: string[];
}

// Things Headerwise can't do yet, in the words the user knows them by in ModHeader.
const UNSUPPORTED: Record<string, string> = {
  urlReplacements: 'redirects',
  cookieHeaders: 'request cookie rules',
  setCookieHeaders: 'response cookie rules',
  cspHeaders: 'CSP rules',
  initiatorDomainFilters: '"initiator domain" filters',
  resourceFilters: 'resource type filters',
  requestMethodFilters: 'request method filters',
  tabFilters: 'tab filters',
  tabGroupFilters: 'tab group filters',
  windowFilters: 'window filters',
  timeFilters: 'time limits',
};

// Filters that narrow where a profile applies. Dropping one would make the profile
// hit more requests than it did in ModHeader, so such profiles come in switched off.
const NARROWING = new Set([
  'initiatorDomainFilters', 'resourceFilters', 'requestMethodFilters',
  'tabFilters', 'tabGroupFilters', 'windowFilters', 'timeFilters',
]);

function isAppend(mode: AppendMode): boolean {
  return mode === true || mode === 'true' || mode === 'append' || mode === 'comma';
}

function hasItems(v: unknown): boolean {
  return Array.isArray(v) && v.some(x => x && typeof x === 'object' && (x as { enabled?: boolean }).enabled !== false);
}

function headers(list: MhHeader[] | undefined, profile: MhProfile): HeaderMod[] {
  const out: HeaderMod[] = [];
  for (const h of list ?? []) {
    if (typeof h?.name !== 'string' || h.name.trim() === '') continue;
    const value = typeof h.value === 'string' ? h.value : '';
    const sendEmpty = h.sendEmptyHeader ?? profile.sendEmptyHeader ?? false;
    const op = value === '' && !sendEmpty ? 'remove' : isAppend(h.appendMode ?? profile.appendMode) ? 'append' : 'set';
    out.push({
      id: newId(),
      enabled: h.enabled !== false,
      name: h.name.trim(),
      value,
      op,
      ...(h.comment ? { comment: h.comment } : {}),
    });
  }
  return out;
}

// reqCookieAppend adds name=value to the Cookie header, which is what Chrome's
// append on Cookie does.
function cookieAppends(list: MhHeader[] | undefined): HeaderMod[] {
  return (list ?? [])
    .filter(c => typeof c?.name === 'string' && c.name.trim() !== '')
    .map(c => ({ id: newId(), enabled: c.enabled !== false, name: 'Cookie', value: `${c.name!.trim()}=${c.value ?? ''}`, op: 'append' as const }));
}

function urlFilter(f: MhUrlFilter, kind: UrlFilter['kind']): UrlFilter | null {
  const enabled = f?.enabled !== false;
  if (typeof f?.urlRegex === 'string' && f.urlRegex.trim() !== '') {
    return { id: newId(), enabled, kind, pattern: f.urlRegex.trim(), isRegex: true };
  }
  // 2.x glob, e.g. "*://*.example.com/*". Chrome's urlFilter reads * the same way.
  if (typeof f?.urlPattern === 'string' && f.urlPattern.trim() !== '') {
    return { id: newId(), enabled, kind, pattern: f.urlPattern.trim(), isRegex: false };
  }
  return null;
}

function parse(text: string): { list?: MhProfile[]; error?: string } {
  const trimmed = text.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { error: 'This is a ModHeader share link. Open it, export the profile as JSON and paste or pick that file instead.' };
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { error: 'Not valid JSON.' };
  }
  if (Array.isArray(data)) return { list: data.filter(p => p && typeof p === 'object') as MhProfile[] };
  if (data && typeof data === 'object') {
    const wrapped = (data as { profiles?: unknown }).profiles;
    return { list: Array.isArray(wrapped) ? wrapped as MhProfile[] : [data as MhProfile] };
  }
  return { error: 'Unexpected format: expected a ModHeader profile export.' };
}

export function importModHeader(text: string): ImportResult {
  const warnings: string[] = [];
  const { list, error } = parse(text);
  if (!list) return { profiles: [], warnings: [error!] };

  const profiles = list.map((p, i): Profile => {
    const title = p.title?.trim() || p.shortTitle?.trim() || `Imported ${i + 1}`;
    const filters: UrlFilter[] = [];
    const skipped: string[] = [];
    let narrowingSkipped = false;

    for (const f of p.filters ?? []) {
      if (f.type === 'excludeUrls') { const x = urlFilter(f, 'exclude'); if (x) filters.push(x); }
      else if (f.type === 'types') {
        if (f.enabled !== false && f.resourceType?.length) {
          skipped.push(UNSUPPORTED.resourceFilters);
          narrowingSkipped = true;
        }
      }
      else { const x = urlFilter(f, 'include'); if (x) filters.push(x); }
    }
    for (const f of p.urlFilters ?? []) { const x = urlFilter(f, 'include'); if (x) filters.push(x); }
    for (const f of p.excludeUrlFilters ?? []) { const x = urlFilter(f, 'exclude'); if (x) filters.push(x); }
    for (const f of p.excludeRequestDomainFilters ?? []) {
      if (typeof f?.domain === 'string' && f.domain.trim() !== '') {
        filters.push({ id: newId(), enabled: f.enabled !== false, kind: 'exclude', pattern: f.domain.trim(), isRegex: false });
      }
    }

    for (const [field, label] of Object.entries(UNSUPPORTED)) {
      if (!hasItems(p[field])) continue;
      if (!skipped.includes(label)) skipped.push(label);
      if (NARROWING.has(field)) narrowingSkipped = true;
    }
    if (skipped.length) warnings.push(`"${title}": skipped ${skipped.join(', ')}. Headerwise can't do these yet.`);
    if (narrowingSkipped) warnings.push(`"${title}" is imported switched off: without those filters it would apply to more requests than in ModHeader.`);

    const requestHeaders = [...headers(p.headers, p), ...cookieAppends(p.reqCookieAppend)];
    const responseHeaders = headers(p.respHeaders, p);
    if ([...requestHeaders, ...responseHeaders].some(h => /\{\{.*\}\}/.test(h.value))) {
      warnings.push(`"${title}": values with {{...}} are imported as plain text, Headerwise doesn't fill them in yet.`);
    }

    return {
      id: newId(),
      title,
      enabled: i === 0 && !narrowingSkipped,
      requestHeaders,
      responseHeaders,
      filters,
    };
  });

  if (profiles.length === 0) warnings.push('No profiles found in the file.');
  return { profiles, warnings };
}
