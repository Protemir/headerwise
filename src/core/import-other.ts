import { APPENDABLE_REQUEST_HEADERS } from './dnr.ts';
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
 * A Chrome match pattern ("https://*.example.com/*") as an "only on" urlFilter.
 * "*.host" and "host" both become ||host (that host and its subdomains): a match
 * pattern for a bare host leaves subdomains out, so that is a little wider.
 */
function matchPatternFilter(pattern: string): string | undefined {
  const m = /^(\*|[a-z][a-z0-9+.-]*):\/\/(\*|\*\.[^/]+|[^/*]+)(\/.*)?$/i.exec(pattern.trim());
  if (!m) return undefined;
  const [, , host, path = '/*'] = m;
  if (host === '*') return path === '/*' ? '' : path;
  const site = `||${host.replace(/^\*\./, '')}`;
  return path === '/*' ? `${site}^` : `${site}${path}`;
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
  for (const t of targets) {
    const f = matchPatternFilter(t);
    if (f === undefined) { warnings.push(`"${t}" in the page list isn't a match pattern Headerwise can read.`); siteLost = true; }
    else if (f) siteFilters.push(filter('include', f, false));
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
  if (cookies) warnings.push(`${cookies} cookie row${cookies === 1 ? '' : 's'} skipped: Simple Modify Headers can only do those in Firefox.`);

  const profiles: Profile[] = [];
  for (const [contains, { request, response }] of groups) {
    const parts = contains.split(';').map(s => s.trim()).filter(Boolean);
    const named = parts.length ? `${title}: ${parts.join(', ')}` : title;
    // Both a page list and "URL contains" must match there; Headerwise ORs its
    // "only on" patterns, so such a profile comes in off for the user to check.
    const both = parts.length > 0 && siteFilters.length > 0;
    if (both) warnings.push(`"${named}": it applied only where the page list and "URL contains" both match. Headerwise can't say "both", so it is imported switched off with the "URL contains" patterns; check its filters.`);
    profiles.push({
      id: newId(),
      title: named,
      enabled: !both && !siteLost,
      requestHeaders: request,
      responseHeaders: response,
      filters: parts.length ? parts.map(p => filter('include', `*${p}*`, false)) : siteFilters.map(f => ({ ...f, id: newId() })),
    });
  }
  if (siteLost) warnings.push('Profiles are imported switched off: part of the page list could not be read, and without it they would apply more widely.');
  if (!profiles.length) warnings.push('No headers found in the file.');
  return { profiles, warnings };
}

// --- Requestly

interface Scope { filters: UrlFilter[]; initiatorDomains: string[]; resourceTypes: string[]; requestMethods: string[]; narrowingLost: string[] }

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
      const hostRe = operator === 'matches' ? regexBody(value).replace(/^\^/, '').replace(/\$$/, '')
        : operator === 'contains' ? `[^/]*${escapeRe(value)}[^/]*`
        : operator === 'wildcard_matches' ? wildcardRe(value).replace(/\.\*/g, '[^/]*')
        : escapeRe(value);
      f = filter('include', `^[a-z][a-z0-9+.-]*://${hostRe}(?::\\d+)?(?:[/?#]|$)`, true);
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
      if (REQUEST_METHODS.includes(m)) scope.requestMethods.push(m); else scope.narrowingLost.push(`method ${m.toUpperCase()}`);
    }
    for (const t of (Array.isArray(flt.resourceType) ? flt.resourceType : []).map(str)) {
      if (RESOURCE_TYPES.some(r => r.id === t)) scope.resourceTypes.push(t); else scope.narrowingLost.push(`request type ${t}`);
    }
    for (const d of (Array.isArray(flt.pageDomains) ? flt.pageDomains : []).map(str)) if (d.trim()) scope.initiatorDomains.push(d.trim());
    if (obj(flt.pageUrl) && str(flt.pageUrl.value)) scope.narrowingLost.push('page URL filter');
    if (flt.requestPayload && (obj(flt.requestPayload) ? Object.keys(flt.requestPayload).length : true)) scope.narrowingLost.push('request payload filter');
  }
  if (scope.narrowingLost.length) warnings.push(`"${title}": ${[...new Set(scope.narrowingLost)].join(', ')} can't be imported, so this rule comes in switched off.`);
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
  if (/rq_request_initiator_origin\(\)/.test(value)) warnings.push(`"${title}": ${name} uses Requestly's rq_request_initiator_origin(), which Headerwise sends as plain text.`);
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
    if (type !== 'Headers') { skippedTypes.set(type || 'unknown', (skippedTypes.get(type || 'unknown') ?? 0) + 1); continue; }
    const group = groups.get(str(rule.groupId));
    const active = rule.status === 'Active' && (!group || group.status === 'Active');
    const name = str(rule.name).trim() || 'Requestly rule';
    const title = group && str(group.name).trim() ? `${str(group.name).trim()} / ${name}` : name;
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
    warnings.push(`Skipped Requestly rules that aren't about headers: ${[...skippedTypes].map(([t, n]) => `${n} ${t}`).join(', ')}.`);
  }
  if (!profiles.length) warnings.push('No header rules found in the file.');
  return { profiles, warnings };
}
