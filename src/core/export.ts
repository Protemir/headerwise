import { t } from './i18n.ts';
import { importModHeader, type ImportResult } from './import-modheader.ts';
import { importRequestly, importSimpleModifyHeaders, isRequestly, isSimpleModifyHeaders } from './import-other.ts';
import { isSecret, newId, REQUEST_METHODS, RESOURCE_TYPES, type HeaderMod, type HeaderOp, type Profile, type Redirect, type UrlFilter } from './model.ts';

/*
 * Headerwise's own export file:
 *   { "format": "headerwise", "version": 1, "exported": "<ISO date>", "profiles": [...] }
 * Profiles are stored as in the extension, minus things that only make sense on
 * this machine (the tab a profile is bound to). Secret values are left out
 * unless asked for: the file is meant to be shared.
 */

export const EXPORT_FORMAT = 'headerwise';

export function exportProfiles(profiles: Profile[], { includeSecrets = false, now = new Date() } = {}): string {
  const clean = profiles.map(p => {
    const { tab: _tab, offAt: _offAt, ...rest } = p;
    // Empty on purpose (a "logged out" profile with an empty Cookie) stays empty, not "left out".
    const strip = (h: HeaderMod): HeaderMod => (includeSecrets || h.value === '' || !isSecret(h) ? h : { ...h, value: '', secret: true });
    // On only in one tab, or only for a while, here: elsewhere it would be on everywhere, for good.
    const enabled = p.enabled && !p.tab && !p.offAt;
    return { ...rest, enabled, requestHeaders: p.requestHeaders.map(strip), responseHeaders: p.responseHeaders.map(strip) };
  });
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, exported: now.toISOString(), profiles: clean }, null, 2);
}

export function exportFileName(now = new Date()): string {
  return `headerwise-profiles-${now.toISOString().slice(0, 10)}.json`;
}

const OPS: HeaderOp[] = ['set', 'append', 'remove'];
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// Files can be edited by hand or come from someone else: rebuild every profile
// from known fields only, with fresh ids.
function header(raw: unknown): HeaderMod | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  if (str(h.name).trim() === '') return null;
  return {
    id: newId(),
    enabled: h.enabled !== false,
    name: str(h.name).trim(),
    value: str(h.value),
    op: OPS.includes(h.op as HeaderOp) ? (h.op as HeaderOp) : 'set',
    ...(typeof h.comment === 'string' && h.comment ? { comment: h.comment } : {}),
    ...(typeof h.secret === 'boolean' ? { secret: h.secret } : {}),
  };
}

function redirect(raw: unknown): Redirect | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (str(r.from).trim() === '') return null;
  return { id: newId(), enabled: r.enabled !== false, from: str(r.from), to: str(r.to), isRegex: r.isRegex === true };
}

function filter(raw: unknown): UrlFilter | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (str(f.pattern).trim() === '' || (f.kind !== 'include' && f.kind !== 'exclude')) return null;
  return { id: newId(), enabled: f.enabled !== false, kind: f.kind, pattern: str(f.pattern), isRegex: f.isRegex === true };
}

function profile(raw: unknown, i: number): Profile | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const list = <T>(v: unknown, f: (x: unknown) => T | null) => (Array.isArray(v) ? v.map(f).filter((x): x is T => x !== null) : []);
  const types = strings(p.resourceTypes).filter(t => RESOURCE_TYPES.some(x => x.id === t));
  const methods = strings(p.requestMethods).map(m => m.toLowerCase()).filter(m => REQUEST_METHODS.includes(m));
  // Limits it had that can't be read here: without them it would apply more widely.
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const filters = list(p.filters, filter);
  const lostLimits = filters.length < count(p.filters) || types.length < count(p.resourceTypes) || methods.length < count(p.requestMethods)
    || strings(p.initiatorDomains).length < count(p.initiatorDomains);
  const initiators = strings(p.initiatorDomains);
  const notInitiators = strings(p.excludedInitiatorDomains);
  return {
    id: newId(),
    title: str(p.title).trim() || `Imported ${i + 1}`,
    enabled: p.enabled === true && !lostLimits,
    ...(lostLimits ? { limitsLost: true } : {}),
    requestHeaders: list(p.requestHeaders, header),
    responseHeaders: list(p.responseHeaders, header),
    filters,
    ...(Array.isArray(p.redirects) && p.redirects.length ? { redirects: list(p.redirects, redirect) } : {}),
    ...(initiators.length ? { initiatorDomains: initiators } : {}),
    ...(notInitiators.length ? { excludedInitiatorDomains: notInitiators } : {}),
    ...(types.length ? { resourceTypes: types } : {}),
    ...(methods.length ? { requestMethods: methods } : {}),
  };
}

/** Reads a Headerwise export, a Requestly or Simple Modify Headers export, or falls back to the ModHeader formats. */
export function importProfiles(text: string): ImportResult {
  let data: unknown;
  try { data = JSON.parse(text.trim()); } catch { /* not JSON: let the ModHeader importer explain */ }
  // Its own format first: a file that says it is a Headerwise export is read as one,
  // whatever other fields it carries (a share page shows it read this way).
  if (isHeaderwiseExport(data)) return importHeaderwise(data);
  if (isRequestly(data)) return importRequestly(data);
  if (isSimpleModifyHeaders(data)) return importSimpleModifyHeaders(data);
  return importModHeader(text);
}

export function isHeaderwiseExport(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { format?: unknown }).format === EXPORT_FORMAT;
}

/** A Headerwise export, already parsed. */
export function importHeaderwise(data: unknown): ImportResult {
  const d = data as { version?: unknown; profiles?: unknown };
  const warnings: string[] = [];
  if (typeof d.version === 'number' && d.version > 1) warnings.push(t('imp_newerVersion', { version: d.version }));
  const read = (Array.isArray(d.profiles) ? d.profiles : []).map(profile).filter((p): p is Profile & { limitsLost?: true } => p !== null);
  for (const p of read) {
    if (!p.limitsLost) continue;
    delete p.limitsLost;
    warnings.push(t('imp_limitsLost', { profile: p.title }));
  }
  const profiles: Profile[] = read;
  // An export without secrets has them empty. Switched on, an empty Authorization
  // or Cookie would be sent everywhere and log the user out, so they come in off.
  const emptied = profiles.flatMap(p => [...p.requestHeaders, ...p.responseHeaders]
    .filter(h => h.secret && h.value === '' && h.op !== 'remove')
    .map(h => { const was = h.enabled; h.enabled = false; return was ? `"${p.title}" → ${h.name}` : ''; })
    .filter(Boolean));
  if (emptied.length) warnings.push(t('imp_secretsEmptied', { headers: emptied.join(', ') }));
  if (profiles.length === 0) warnings.push(t('imp_noProfiles'));
  return { profiles, warnings };
}
