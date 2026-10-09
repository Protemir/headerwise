import { newId, type HeaderMod, type Profile, type UrlFilter } from './model.ts';

/*
 * ModHeader export format, reconstructed from public examples. Two shapes are
 * seen in the wild:
 *   older:  { title, headers, respHeaders, filters: [{ enabled, type: 'urls' | 'excludeUrls' | 'types', urlRegex }] }
 *   newer:  { title, headers, respHeaders, urlFilters: [{ enabled, urlRegex }], excludeUrlFilters: [...] }
 * TODO: verify against real export files from ModHeader 6.x and 7.x.
 */

interface MhHeader { enabled?: boolean; name?: string; value?: string; comment?: string }
interface MhFilter { enabled?: boolean; type?: string; urlRegex?: string }
interface MhProfile {
  title?: string;
  shortTitle?: string;
  appendMode?: boolean | string;
  headers?: MhHeader[];
  respHeaders?: MhHeader[];
  filters?: MhFilter[];
  urlFilters?: MhFilter[];
  excludeUrlFilters?: MhFilter[];
}

export interface ImportResult {
  profiles: Profile[];
  warnings: string[];
}

function headers(list: MhHeader[] | undefined, append: boolean): HeaderMod[] {
  return (list ?? [])
    .filter(h => typeof h?.name === 'string' && h.name.trim() !== '')
    .map(h => ({
      id: newId(),
      enabled: h.enabled !== false,
      name: h.name!.trim(),
      value: h.value ?? '',
      op: append ? 'append' : 'set',
      ...(h.comment ? { comment: h.comment } : {}),
    }));
}

function filter(f: MhFilter, kind: UrlFilter['kind']): UrlFilter | null {
  if (typeof f?.urlRegex !== 'string' || f.urlRegex.trim() === '') return null;
  return { id: newId(), enabled: f.enabled !== false, kind, pattern: f.urlRegex.trim(), isRegex: true };
}

export function importModHeader(json: string): ImportResult {
  const warnings: string[] = [];
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { profiles: [], warnings: ['Not valid JSON.'] };
  }

  let list: MhProfile[];
  if (Array.isArray(data)) list = data as MhProfile[];
  else if (data && typeof data === 'object' && Array.isArray((data as { profiles?: unknown }).profiles)) list = (data as { profiles: MhProfile[] }).profiles;
  else if (data && typeof data === 'object') list = [data as MhProfile];
  else return { profiles: [], warnings: ['Unexpected format: expected a ModHeader profile export.'] };

  const profiles = list.map((p, i): Profile => {
    const title = p.title?.trim() || p.shortTitle?.trim() || `Imported ${i + 1}`;
    const append = p.appendMode === true || p.appendMode === 'true';
    const filters: UrlFilter[] = [];

    for (const f of p.filters ?? []) {
      if (f.type === 'urls' || f.type === undefined) { const x = filter(f, 'include'); if (x) filters.push(x); }
      else if (f.type === 'excludeUrls') { const x = filter(f, 'exclude'); if (x) filters.push(x); }
      else warnings.push(`"${title}": filter of type "${f.type}" is not supported yet and was skipped.`);
    }
    for (const f of p.urlFilters ?? []) { const x = filter(f, 'include'); if (x) filters.push(x); }
    for (const f of p.excludeUrlFilters ?? []) { const x = filter(f, 'exclude'); if (x) filters.push(x); }

    return {
      id: newId(),
      title,
      enabled: i === 0,
      requestHeaders: headers(p.headers, append),
      responseHeaders: headers(p.respHeaders, append),
      filters,
    };
  });

  if (profiles.length === 0) warnings.push('No profiles found in the file.');
  return { profiles, warnings };
}
