import { emptyProfile, isSecret, type HeaderMod, type Profile, type State } from './model.ts';

/*
 * Optional sync of profiles between computers, through the browser's own sync
 * (chrome.storage.sync: the Google or Microsoft account the browser is signed in
 * to). Headerwise has no server; this only hands the profiles to the browser.
 *
 * In sync storage:
 *   hw:index      { v: 1, order: [profile ids] }
 *   hw:p:<id>     a profile without what belongs to one computer: whether it is
 *                 on, the tab it is bound to, its timer, and secret values.
 * One item per profile, so two computers editing different profiles don't
 * overwrite each other; the browser keeps the last write of each item.
 *
 * Each computer remembers which ids it last saw synced ("known"): a profile it
 * knows that is gone from the index was deleted elsewhere, one it doesn't know
 * is new here and still to be sent.
 */

export const SYNC_INDEX = 'hw:index';
const PREFIX = 'hw:p:';
// chrome.storage.sync.QUOTA_BYTES_PER_ITEM: key plus JSON value.
export const SYNC_ITEM_LIMIT = 8192;

export type SyncedProfile = Omit<Profile, 'enabled' | 'tab' | 'offAt'>;
interface SyncIndex { v: 1; order: string[] }
export type SyncItems = Record<string, unknown>;

/** JSON with sorted keys, to compare objects whatever order their keys were written in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A profile as it is synced. */
export function syncedProfile(p: Profile): SyncedProfile {
  const { enabled: _enabled, tab: _tab, offAt: _offAt, ...rest } = p;
  const strip = (h: HeaderMod): HeaderMod => (isSecret(h) ? { ...h, value: '', secret: true } : h);
  return { ...rest, requestHeaders: p.requestHeaders.map(strip), responseHeaders: p.responseHeaders.map(strip) };
}

/** What sync storage should hold for this state; profiles over the size limit are named in tooBig. */
export function toSyncItems(state: State): { items: SyncItems; tooBig: string[] } {
  const items: SyncItems = {};
  const tooBig: string[] = [];
  for (const p of state.profiles) {
    const value = syncedProfile(p);
    // Too big: it stays in the index (so other computers keep their copy) without an item.
    if (bytes(PREFIX + p.id) + bytes(JSON.stringify(value)) > SYNC_ITEM_LIMIT) tooBig.push(p.title.trim() || p.id);
    else items[PREFIX + p.id] = value;
  }
  items[SYNC_INDEX] = { v: 1, order: state.profiles.map(p => p.id) } satisfies SyncIndex;
  return { items, tooBig };
}

/** The writes that turn `remote` into `wanted`. */
export function syncDiff(remote: SyncItems, wanted: SyncItems): { set: SyncItems; remove: string[] } {
  const set: SyncItems = {};
  for (const [k, v] of Object.entries(wanted)) if (!same(remote[k], v)) set[k] = v;
  const order = new Set((wanted[SYNC_INDEX] as SyncIndex).order);
  const remove = Object.keys(remote).filter(k => k.startsWith(PREFIX) && !order.has(k.slice(PREFIX.length)));
  return { set, remove };
}

function readIndex(remote: SyncItems): string[] | undefined {
  const index = remote[SYNC_INDEX] as Partial<SyncIndex> | undefined;
  if (!index || index.v !== 1 || !Array.isArray(index.order)) return undefined;
  return index.order.filter((id): id is string => typeof id === 'string');
}

const isProfileLike = (r: unknown): r is SyncedProfile => {
  const p = r as SyncedProfile | undefined;
  return !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.title === 'string'
    && Array.isArray(p.requestHeaders) && Array.isArray(p.responseHeaders) && Array.isArray(p.filters);
};

/** Remote headers, with this computer's values put back where the secret was left out. */
function withLocalSecrets(remote: HeaderMod[], local: HeaderMod[] | undefined): HeaderMod[] {
  const byId = new Map((local ?? []).map(h => [h.id, h]));
  return remote.map(h => {
    const mine = byId.get(h.id);
    if (!(h.secret && h.value === '' && mine && isSecret(mine))) return h;
    const { secret: _secret, ...rest } = h;
    return mine.secret === undefined ? { ...rest, value: mine.value } : { ...rest, value: mine.value, secret: mine.secret };
  });
}

/** A profile here: content from sync, on/off, tab, timer and secrets from this computer. New ones come in off. */
function fromSynced(r: SyncedProfile, local: Profile | undefined): Profile {
  return {
    ...r,
    enabled: local?.enabled ?? false,
    ...(local?.tab ? { tab: local.tab } : {}),
    ...(local?.offAt ? { offAt: local.offAt } : {}),
    requestHeaders: withLocalSecrets(r.requestHeaders, local?.requestHeaders),
    responseHeaders: withLocalSecrets(r.responseHeaders, local?.responseHeaders),
  };
}

/** Nothing in it yet: the profile a fresh install starts with. */
const isBlank = (p: Profile) => !p.requestHeaders.some(h => h.name.trim()) && !p.responseHeaders.some(h => h.name.trim())
  && !p.filters.some(f => f.pattern.trim()) && !(p.redirects ?? []).some(r => r.from.trim());

/**
 * This computer's state with what sync holds taken in; undefined if nothing changes.
 * `first`: sync was just switched on here, so local profiles are kept (and later
 * sent) even if the other computers don't have them, except a blank starter profile.
 */
export function mergeSynced(local: State, remote: SyncItems, known: string[], first = false): State | undefined {
  const order = readIndex(remote);
  if (!order) return undefined;
  const mine = new Map(local.profiles.map(p => [p.id, p]));
  const profiles: Profile[] = [];
  const taken = new Set<string>();
  for (const id of order) {
    if (taken.has(id)) continue;
    const r = remote[PREFIX + id];
    const l = mine.get(id);
    // The item may not have arrived yet, or be too big to sync: keep this computer's copy.
    if (isProfileLike(r) && r.id === id) profiles.push(fromSynced(r, l));
    else if (l) profiles.push(l);
    else continue;
    taken.add(id);
  }
  for (const p of local.profiles) {
    if (taken.has(p.id)) continue;
    if (first ? order.length > 0 && local.profiles.length === 1 && isBlank(p) : known.includes(p.id)) continue; // deleted elsewhere
    profiles.push(p);
  }
  const next: State = { ...local, profiles: profiles.length ? profiles : [emptyProfile()] };
  return same(next, local) ? undefined : next;
}

export interface SyncStatus {
  at: number;
  tooBig?: string[];
  error?: string;
}

export interface SyncApi {
  enabled(): Promise<boolean>;
  known(): Promise<string[]>;
  setKnown(ids: string[]): Promise<void>;
  remote: {
    get(): Promise<SyncItems>;
    set(items: SyncItems): Promise<void>;
    remove(keys: string[]): Promise<void>;
  };
  loadState(): Promise<State>;
  saveState(state: State): Promise<void>;
  status(s: SyncStatus | null): Promise<void>;
  /** The engine's edit queue: changes to the profiles one at a time. */
  edit<T>(fn: () => Promise<T>): Promise<T>;
  now(): number;
}

export function createSync(api: SyncApi) {
  async function guarded(fn: () => Promise<string[] | void>): Promise<void> {
    try {
      const tooBig = await fn();
      await api.status({ at: api.now(), ...(tooBig?.length ? { tooBig } : {}) });
    } catch (e) {
      await api.status({ at: api.now(), error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** This computer's profiles to sync storage. */
  function push(): Promise<void> {
    return api.edit(async () => {
      if (!(await api.enabled())) return;
      await guarded(async () => {
        const state = await api.loadState();
        const remote = await api.remote.get();
        const { items, tooBig } = toSyncItems(state);
        const { set, remove } = syncDiff(remote, items);
        if (Object.keys(set).length) await api.remote.set(set);
        if (remove.length) await api.remote.remove(remove);
        await api.setKnown(state.profiles.map(p => p.id));
        return tooBig;
      });
    });
  }

  /** Sync storage to this computer's profiles. */
  function pull(first = false): Promise<void> {
    return api.edit(async () => {
      if (!(await api.enabled())) return;
      await guarded(async () => {
        const remote = await api.remote.get();
        const order = readIndex(remote);
        const next = mergeSynced(await api.loadState(), remote, first ? [] : await api.known(), first);
        if (next) await api.saveState(next);
        if (order) await api.setKnown(order);
      });
    });
  }

  return {
    push,
    pull,
    /** Switched on here (or the browser started): take in what the others have, then send ours. */
    async start(first = false): Promise<void> {
      await pull(first);
      await push();
    },
  };
}
