import { APPENDABLE_REQUEST_HEADERS } from './dnr.ts';
import { t, tn } from './i18n.ts';
import type { ImportResult } from './import-modheader.ts';
import { newId, REQUEST_METHODS, RESOURCE_TYPES, type HeaderMod, type HeaderOp, type Profile, type UrlFilter } from './model.ts';

/*
 * Exports of other header extensions, read from their source code:
 * - Simple Modify Headers (didierfred/SimpleModifyHeaders, popup/config.js):
 *   { format_version: "1.0" | "1.1" | "1.2", target_page, headers: [...] },
 *   and Firefox "Modify Header"'s bare [{ action, name, value, enabled }] list;
 * - Requestly (requestly/interceptor, SharingModal/actions.ts): a bare array of
 *   { objectType: "rule" | "group", ... }, header rules in v1 and v2 shapes.
 * Anything with no Headerwise equivalent is named in a warning; a profile that
 * would apply more widely than it did there comes in switched off.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const objs = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(obj) : obj(v) ? [v] : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const filter = (kind: UrlFilter['kind'], pattern: string, isRegex: boolean): UrlFilter => ({ id: newId(), enabled: true, kind, pattern, isRegex });
const header = (name: string, value: string, op: HeaderOp, enabled = true, comment = ''): HeaderMod =>
  ({ id: newId(), enabled, name: name.trim(), value: op === 'remove' ? '' : value, op, ...(comment ? { comment } : {}) });

export function isSimpleModifyHeaders(data: unknown): boolean {
  if (obj(data)) return typeof data.format_version === 'string' && Array.isArray(data.headers);
  return Array.isArray(data) && data.length > 0 && data.every(x => obj(x) && 'action' in x && 'name' in x && !('objectType' in x));
}

export function isRequestly(data: unknown): boolean {
  return Array.isArray(data) && data.length > 0 && data.every(x => obj(x) && (x.objectType === 'rule' || x.objectType === 'group'));
}

// --- Simple Modify Headers

/**
 * A Chrome match pattern ("https://*.example.com/api/*") as an "only on" regex
 * with the same reach: scheme ("*" is http or https), host ("*." also the bare
 * domain), any port, and the path matched whole. "" for all URLs.
 */
function matchPatternFilter(pattern: string): string | undefined {
  const m = /^(\*|https?|wss?|ftp):\/\/(\*|\*\.[^/:]+|[^/*:]+)(?::(\d+|\*))?(\/.*)$/i.exec(pattern.trim());
  if (!m) return undefined;
  const [, scheme, host, port, path] = m;
  if (scheme === '*' && host === '*' && !port && path === '/*') return '';
  const schemeRe = scheme === '*' ? 'https?' : escapeRe(scheme.toLowerCase());
  const hostRe = host === '*' ? '[^/?#:]+' : host.startsWith('*.') ? `(?:[^/?#:]*\\.)?${escapeRe(host.slice(2))}` : escapeRe(host);
  const portRe = port && port !== '*' ? `:${port}` : '(?::\\d+)?';
  const pathRe = path.split('*').map(escapeRe).join('.*');
  return `^${schemeRe}://${hostRe}${portRe}${pathRe}$`;
}

export function importSimpleModifyHeaders(data: unknown): ImportResult {
  const warnings: string[] = [];
  const title = 'Simple Modify Headers';
  // Firefox "Modify Header": [{ action: Add | Modify | Filter, name, value, comment, enabled }]
  if (Array.isArray(data)) {
    const headers = objs(data).filter(h => str(h.name).trim()).map(h => {
      const action = str(h.action).toLowerCase();
      return header(str(h.name), str(h.value), action === 'filter' ? 'remove' : 'set', h.enabled !== false, str(h.comment));
    });
    return { profiles: [{ id: newId(), title, enabled: true, requestHeaders: headers, responseHeaders: [], filters: [] }], warnings };
  }

  const d = data as Json;
  // target_page: Chrome match patterns separated by ";", empty or * for all.
  const targets = str(d.target_page).split(';').map(s => s.trim()).filter(s => s && s !== '*' && s !== '<all_urls>');
  const siteFilters: UrlFilter[] = [];
  let siteLost = false;
  for (const target of targets) {
    const f = matchPatternFilter(target);
    if (f === undefined) { warnings.push(t('imp_badMatchPattern', { pattern: target })); siteLost = true; }
    else if (f) siteFilters.push(filter('include', f, true));
  }

  // Rows can have their own "URL contains" list, so each list gets its own profile.
  const useContains = d.use_url_contains === true;
  const groups = new Map<string, { request: HeaderMod[]; response: HeaderMod[] }>();
  let cookies = 0;
  for (const h of objs(d.headers)) {
    const name = str(h.header_name).trim();
    const action = str(h.action);
    if (action.startsWith('cookie_')) { cookies++; continue; }
    if (!name) continue;
    const op: HeaderOp = action === 'delete' ? 'remove' : 'set';
    const row = header(name, str(h.header_value), op, str(h.status) !== 'off', str(h.comment));
    const contains = useContains ? str(h.url_contains).trim() : '';
    if (!groups.has(contains)) groups.set(contains, { request: [], response: [] });
    groups.get(contains)![str(h.apply_on) === 'res' ? 'response' : 'request'].push(row);
  }
  if (cookies) warnings.push(tn('imp_smhCookies', cookies));

  const profiles: Profile[] = [];
  for (const [contains, { request, response }] of groups) {
    const parts = contains.split(';').map(s => s.trim()).filter(Boolean);
    const named = parts.length ? `${title}: ${parts.join(', ')}` : title;
    // Both a page list and "URL contains" must match there; Headerwise ORs its
    // "only on" patterns, so such a profile comes in off for the user to check.
    const both = parts.length > 0 && siteFilters.length > 0;
    if (both) warnings.push(t('imp_smhBoth', { profile: named }));
    profiles.push({
      id: newId(),
      title: named,
      enabled: !both && !siteLost,
      requestHeaders: request,
      responseHeaders: response,
      filters: parts.length ? parts.map(p => filter('include', `*${p}*`, false)) : siteFilters.map(f => ({ ...f, id: newId() })),
    });
  }
  if (siteLost) warnings.push(t('imp_smhSiteLost'));
  if (!profiles.length) warnings.push(t('imp_noHeaders'));
  return { profiles, warnings };
}

// --- Requestly

interface Scope { filters: UrlFilter[]; initiatorDomains: string[]; resourceTypes: string[]; requestMethods: string[]; narrowingLost: string[] }

/**
 * Requestly's source as one regex for the whole URL, for redirects (a Headerwise
 * redirect replaces what its pattern matches, so this makes it the whole URL).
 * Wildcards become groups, as Requestly's $1, $2 refer to what * matched.
 */
function sourceUrlRegex(source: Json): string | undefined {
  const key = str(source.key).toLowerCase();
  const operator = str(source.operator).toLowerCase();
  const value = str(source.value).trim();
  if (!value) return undefined;
  const wild = (v: string) => v.split('*').map(escapeRe).join('(.*)');
  const body = /^\/(.*)\/[a-z]*$/s.exec(value)?.[1] ?? value;
  if (key === 'host') {
    const host = operator === 'matches' ? `[^/?#]*(?:${body.replace(/^\^/, '').replace(/(?<!\\)\$$/, '')})[^/?#]*`
      : operator === 'contains' ? `[^/?#]*${escapeRe(value)}[^/?#]*`
      : operator === 'wildcard_matches' ? wild(value)
      : escapeRe(value);
    return `^[a-z][a-z0-9+.-]*://${host}(?:[/?#].*)?$`;
  }
  if (operator === 'equals') return `^${escapeRe(value)}$`;
  if (operator === 'matches') return `^.*?(?:${body}).*$`;
  if (operator === 'wildcard_matches') return `^${wild(value)}$`;
  return `^.*${escapeRe(value)}.*$`; // contains
}

/** Requestly Redirect (whole URL to a destination) and Replace (part of the URL) rules as a profile of redirects. */
function requestlyRedirects(rule: Json, type: 'Redirect' | 'Replace', title: string, active: boolean, warnings: string[]): Profile | undefined {
  const redirects: NonNullable<Profile['redirects']> = [];
  let narrowed = false;
  let skipped = 0;
  const scope: Scope = { filters: [], initiatorDomains: [], resourceTypes: [], requestMethods: [], narrowingLost: [] };
  const limits = new Set<string>(); // each pair's own, to see whether they differ
  for (const pair of objs(rule.pairs)) {
    const source = obj(pair.source) ? pair.source : {};
    const s = requestlyScope({ ...source, value: '' }, title, warnings); // only its filters: the URL part goes into the pattern
    limits.add(JSON.stringify([[...s.initiatorDomains].sort(), [...s.resourceTypes].sort(), [...s.requestMethods].sort()]));
    scope.initiatorDomains.push(...s.initiatorDomains);
    scope.resourceTypes.push(...s.resourceTypes);
    scope.requestMethods.push(...s.requestMethods);
    scope.narrowingLost.push(...s.narrowingLost);
    if (type === 'Redirect') {
      const destination = str(pair.destination).trim();
      const kind = str(pair.destinationType) || 'url';
      const from = sourceUrlRegex(source);
      if (kind !== 'url' || !destination || destination.startsWith('file://') || !from) { skipped++; continue; }
      redirects.push({ id: newId(), enabled: true, from, to: destination, isRegex: true });
    } else {
      const fromRaw = str(pair.from);
      if (!fromRaw) { skipped++; continue; }
      const regex = /^\/(.*)\/[a-z]*$/s.exec(fromRaw)?.[1];
      const to = str(pair.to);
      const value = str(source.value).trim();
      const op = str(source.operator).toLowerCase();
      if (!value) redirects.push({ id: newId(), enabled: true, from: regex ?? fromRaw, to, isRegex: regex !== undefined });
      else if (regex === undefined && str(source.key).toLowerCase() === 'url' && (op === 'contains' || op === 'equals') && value.includes(fromRaw)) {
        // Requestly's own common case: "from" lies inside the URL condition, so
        // replacing the condition's text with itself-with-the-change is the same.
        redirects.push({ id: newId(), enabled: true, from: value, to: value.replace(fromRaw, to), isRegex: false });
      } else {
        // Only where the URL condition holds, which a Headerwise redirect can't say.
        redirects.push({ id: newId(), enabled: true, from: regex ?? fromRaw, to, isRegex: regex !== undefined });
        narrowed = true;
      }
    }
  }
  if (skipped) warnings.push(tn(type === 'Redirect' ? 'imp_fileRedirectsSkipped' : 'imp_replacementsSkipped', skipped, { profile: title }));
  if (narrowed) warnings.push(t('imp_requestlyNarrowed', { profile: title }));
  // One profile has one set of limits: pairs with different ones would each apply more widely.
  const mixed = limits.size > 1;
  if (mixed) warnings.push(t('imp_requestlyMixedLimits', { profile: title }));
  if (!redirects.length) return undefined;
  return {
    id: newId(),
    title,
    enabled: active && !narrowed && !mixed && scope.narrowingLost.length === 0,
    requestHeaders: [],
    responseHeaders: [],
    filters: [],
    redirects,
    ...(scope.initiatorDomains.length ? { initiatorDomains: [...new Set(scope.initiatorDomains)] } : {}),
    ...(scope.resourceTypes.length ? { resourceTypes: [...new Set(scope.resourceTypes)] } : {}),
    ...(scope.requestMethods.length ? { requestMethods: [...new Set(scope.requestMethods)] } : {}),
  };
}

/** Requestly's source { key, operator, value, filters } as Headerwise filters. */
function requestlyScope(source: Json, title: string, warnings: string[]): Scope {
  const scope: Scope = { filters: [], initiatorDomains: [], resourceTypes: [], requestMethods: [], narrowingLost: [] };
  const key = str(source.key).toLowerCase();
  const operator = str(source.operator).toLowerCase();
  const value = str(source.value).trim();
  if (value) {
    const regexBody = (v: string) => /^\/(.*)\/[a-z]*$/s.exec(v)?.[1] ?? v;
    const wildcardRe = (v: string) => v.split('*').map(escapeRe).join('.*');
    let f: UrlFilter | undefined;
    if (key === 'host') {
      // The host is what lies between "://" and the next / ? or #. Requestly tests
      // a host regex unanchored, so it may match part of the host unless it says
      // ^ or $; the user's regex goes in a group so its | can't escape the rest.
      const HOST = '[^/?#]*';
      let hostRe: string;
      if (operator === 'matches') {
        const body = regexBody(value);
        const start = body.startsWith('^') ? '' : HOST;
        const end = body.endsWith('$') && !body.endsWith('\\$') ? '(?::\\d+)?' : HOST;
        hostRe = `${start}(?:${body.replace(/^\^/, '').replace(/(?<!\\)\$$/, '')})${end}`;
      } else if (operator === 'contains') hostRe = `${HOST}${escapeRe(value)}${HOST}`;
      else if (operator === 'wildcard_matches') hostRe = `(?:${wildcardRe(value).replace(/\.\*/g, '[^/?#]*')})(?::\\d+)?`;
      else hostRe = `${escapeRe(value)}(?::\\d+)?`;
      f = filter('include', `^[a-z][a-z0-9+.-]*://${hostRe}(?:[/?#]|$)`, true);
    } else {
      // Url, and the legacy "path" (Requestly itself reads it as "Url contains").
      if (operator === 'matches') f = filter('include', regexBody(value), true);
      else if (operator === 'equals') f = filter('include', `^${escapeRe(value)}$`, true);
      else if (operator === 'wildcard_matches') f = filter('include', `^${wildcardRe(value)}$`, true);
      // contains: a plain urlFilter is a substring match already
      else f = /[*^|]/.test(value) ? filter('include', escapeRe(value), true) : filter('include', value, false);
    }
    scope.filters.push(f);
  }
  for (const flt of objs(source.filters)) {
    for (const m of (Array.isArray(flt.requestMethod) ? flt.requestMethod : []).map(x => str(x).toLowerCase())) {
      if (REQUEST_METHODS.includes(m)) scope.requestMethods.push(m); else scope.narrowingLost.push(t('imp_lostMethod', { method: m.toUpperCase() }));
    }
    for (const type of (Array.isArray(flt.resourceType) ? flt.resourceType : []).map(str)) {
      if (RESOURCE_TYPES.some(r => r.id === type)) scope.resourceTypes.push(type); else scope.narrowingLost.push(t('imp_lostType', { type }));
    }
    for (const d of (Array.isArray(flt.pageDomains) ? flt.pageDomains : []).map(str)) if (d.trim()) scope.initiatorDomains.push(d.trim());
    if (obj(flt.pageUrl) && str(flt.pageUrl.value)) scope.narrowingLost.push(t('imp_lostPageUrl'));
    if (flt.requestPayload && (obj(flt.requestPayload) ? Object.keys(flt.requestPayload).length : true)) scope.narrowingLost.push(t('imp_lostPayload'));
  }
  if (scope.narrowingLost.length) warnings.push(t('imp_narrowingLost', { profile: title, what: [...new Set(scope.narrowingLost)].join(', ') }));
  return scope;
}

function requestlyHeader(m: Json, direction: 'request' | 'response', warnings: string[], title: string): HeaderMod | undefined {
  const name = str(m.header).trim();
  if (!name) return undefined;
  const value = str(m.value);
  const type = str(m.type).toLowerCase();
  // As Requestly's own MV3 version: Add appends where Chrome allows it, else sets.
  const op: HeaderOp = type === 'remove' ? 'remove'
    : type === 'add' && (direction === 'response' || APPENDABLE_REQUEST_HEADERS.has(name.toLowerCase())) ? 'append'
    : 'set';
  if (/rq_request_initiator_origin\(\)/.test(value)) warnings.push(t('imp_initiatorOrigin', { profile: title, name }));
  return header(name, value, op);
}

export function importRequestly(data: unknown): ImportResult {
  const warnings: string[] = [];
  const items = objs(data);
  const groups = new Map(items.filter(x => x.objectType === 'group').map(g => [str(g.id), g]));
  const profiles: Profile[] = [];
  const skippedTypes = new Map<string, number>();

  for (const rule of items.filter(x => x.objectType === 'rule')) {
    const type = str(rule.ruleType);
    const group = groups.get(str(rule.groupId));
    const active = rule.status === 'Active' && (!group || group.status === 'Active');
    const name = str(rule.name).trim() || 'Requestly rule';
    const title = group && str(group.name).trim() ? `${str(group.name).trim()} / ${name}` : name;
    if (type === 'Redirect' || type === 'Replace') {
      const p = requestlyRedirects(rule, type, title, active, warnings);
      if (p) profiles.push(p);
      continue;
    }
    if (type !== 'Headers') { skippedTypes.set(type || 'unknown', (skippedTypes.get(type || 'unknown') ?? 0) + 1); continue; }
    const pairs = objs(rule.pairs);
    pairs.forEach((pair, i) => {
      const pairTitle = pairs.length > 1 ? `${title} (${i + 1})` : title;
      const scope = requestlyScope(obj(pair.source) ? pair.source : {}, pairTitle, warnings);
      const request: HeaderMod[] = [];
      const response: HeaderMod[] = [];
      if (obj(pair.modifications)) {
        // v2: { Request: [...], Response: [...] }
        for (const m of objs(pair.modifications.Request)) { const h = requestlyHeader(m, 'request', warnings, pairTitle); if (h) request.push(h); }
        for (const m of objs(pair.modifications.Response)) { const h = requestlyHeader(m, 'response', warnings, pairTitle); if (h) response.push(h); }
      } else {
        // v1: one header per pair, with target Request | Response
        const direction = str(pair.target) === 'Response' ? 'response' : 'request';
        const h = requestlyHeader(pair, direction, warnings, pairTitle);
        if (h) (direction === 'response' ? response : request).push(h);
      }
      if (!request.length && !response.length) return;
      profiles.push({
        id: newId(),
        title: pairTitle,
        enabled: active && scope.narrowingLost.length === 0,
        requestHeaders: request,
        responseHeaders: response,
        filters: scope.filters,
        ...(scope.initiatorDomains.length ? { initiatorDomains: [...new Set(scope.initiatorDomains)] } : {}),
        ...(scope.resourceTypes.length ? { resourceTypes: [...new Set(scope.resourceTypes)] } : {}),
        ...(scope.requestMethods.length ? { requestMethods: [...new Set(scope.requestMethods)] } : {}),
      });
    });
  }
  if (skippedTypes.size) {
    warnings.push(t('imp_requestlyOther', { list: [...skippedTypes].map(([type, n]) => `${n} ${type}`).join(', ') }));
  }
  if (!profiles.length) warnings.push(t('imp_noHeaderRules'));
  return { profiles, warnings };
}
