import { readLevelDb, type DbFile } from './leveldb.ts';

/*
 * Recovering profiles from ModHeader's own storage folder, for people whose
 * ModHeader Chrome has turned off (so its Export button is gone):
 *   <browser profile>/Local Extension Settings/<ModHeader id>/
 * chrome.storage keeps JSON values there; ModHeader's list is under "profiles".
 * Its sync area only has backups under timestamp keys, used as a fallback, as
 * ModHeader itself does.
 */

export const MODHEADER_IDS = {
  chrome: 'idgpnmonknjnojddfkpgkljpfnnfcklj',
  edge: 'opgbiafapkbbnbnjcdomjaghbckfkglc',
};

export interface StoreResult {
  /** ModHeader profiles as stored, ready for importModHeader(). */
  profiles: unknown[];
  /** Index of the profile that was selected in ModHeader. */
  selected: number;
  /** 'profiles', or the date of the backup snapshot that was used. */
  source: string;
}

function looksLikeProfiles(v: unknown): v is unknown[] {
  return Array.isArray(v) && v.length > 0 && v.every(p =>
    p !== null && typeof p === 'object' && typeof (p as { title?: unknown }).title === 'string'
    && ['headers', 'respHeaders', 'urlFilters', 'filters'].some(k => Array.isArray((p as Record<string, unknown>)[k])));
}

function json(s: string | undefined): unknown {
  if (s === undefined) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

export function readModHeaderStore(files: DbFile[]): { result: StoreResult | null; errors: string[] } {
  const { values, errors } = readLevelDb(files);

  const profiles = json(values.get('profiles'));
  if (looksLikeProfiles(profiles)) {
    const sel = json(values.get('selectedProfileIndex') ?? values.get('selectedProfile'));
    const selected = typeof sel === 'number' && sel >= 0 && sel < profiles.length ? sel : 0;
    return { result: { profiles, selected, source: 'profiles' }, errors };
  }

  const snapshots = [...values.keys()].filter(k => /^\d+$/.test(k)).sort((a, b) => Number(b) - Number(a));
  for (const k of snapshots) {
    const v = json(values.get(k));
    if (looksLikeProfiles(v)) {
      return { result: { profiles: v, selected: 0, source: `backup from ${new Date(Number(k)).toISOString().slice(0, 10)}` }, errors };
    }
  }
  return { result: null, errors };
}
