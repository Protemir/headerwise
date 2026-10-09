import { importModHeader, type ImportResult } from './import-modheader.ts';
import { isSecret, newId, REQUEST_METHODS, RESOURCE_TYPES, type HeaderMod, type HeaderOp, type Profile, type UrlFilter } from './model.ts';

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
    const { tab: _tab, ...rest } = p;
    const strip = (h: HeaderMod): HeaderMod => (includeSecrets || !isSecret(h) ? h : { ...h, value: '', secret: true });
    return { ...rest, requestHeaders: p.requestHeaders.map(strip), responseHeaders: p.responseHeaders.map(strip) };
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
  const initiators = strings(p.initiatorDomains);
  const notInitiators = strings(p.excludedInitiatorDomains);
  return {
    id: newId(),
    title: str(p.title).trim() || `Imported ${i + 1}`,
    enabled: p.enabled === true,
    requestHeaders: list(p.requestHeaders, header),
    responseHeaders: list(p.responseHeaders, header),
    filters: list(p.filters, filter),
    ...(initiators.length ? { initiatorDomains: initiators } : {}),
    ...(notInitiators.length ? { excludedInitiatorDomains: notInitiators } : {}),
    ...(types.length ? { resourceTypes: types } : {}),
    ...(methods.length ? { requestMethods: methods } : {}),
  };
}

/** Reads a Headerwise export, or falls back to the ModHeader formats. */
export function importProfiles(text: string): ImportResult {
  let data: unknown;
  try { data = JSON.parse(text.trim()); } catch { /* not JSON: let the ModHeader importer explain */ }
  if (!data || typeof data !== 'object' || (data as { format?: unknown }).format !== EXPORT_FORMAT) return importModHeader(text);

  const d = data as { version?: unknown; profiles?: unknown };
  const warnings: string[] = [];
  if (d.version !== 1) warnings.push(`This file is from a newer Headerwise (format version ${String(d.version)}); some settings may be missing.`);
  const profiles = (Array.isArray(d.profiles) ? d.profiles : []).map(profile).filter((p): p is Profile => p !== null);
  const emptied = profiles.flatMap(p => [...p.requestHeaders, ...p.responseHeaders].filter(h => h.secret && h.value === '' && h.op !== 'remove').map(h => `"${p.title}" → ${h.name}`));
  if (emptied.length) warnings.push(`Secret values were not in the file, fill them in: ${emptied.join(', ')}.`);
  if (profiles.length === 0) warnings.push('No profiles found in the file.');
  return { profiles, warnings };
}
