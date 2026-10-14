import { t } from './i18n.ts';
import { emptyProfile, isSecret, newId, type HeaderMod, type Profile, type State } from './model.ts';

/*
 * Optional sync of profiles between computers, through the browser's own sync
 * (chrome.storage.sync: the Google or Microsoft account the browser is signed in
 * to). Headerwise has no server; this only hands the profiles to the browser.
 *
 * In sync storage:
 *   hw:p:<id>   a profile without what belongs to one computer (whether it is on,
 *               its tab, its timer, secret values); or a deletion mark
 *               { id, deleted: <time> }; or { id, tooBig: true } for a profile
 *               over the browser's 8 KB item limit
 *   hw:order    { v: 1, order: [ids] }
 * One item per profile, so computers editing different profiles don't touch
 * each other's items. Which profiles exist is read from the items, never from
 * the order: an order written by a computer that hadn't seen a new profile yet
 * can't delete it.
 *
 * Each computer keeps a "base": every profile as it was when this computer and
 * sync last agreed. Comparing both sides with it tells who changed what (a
 * three-way merge): changed here only -> sent; changed elsewhere only -> taken
 * in; changed on both -> this computer's version is kept and sent, the other one
 * added next to it as a copy. Nothing is ever dropped without a deletion mark.
 */

export const SYNC_ORDER = 'hw:order';
const PREFIX = 'hw:p:';
const FORMAT = 1;
// chrome.storage.sync.QUOTA_BYTES_PER_ITEM: key plus JSON value.
export const SYNC_ITEM_LIMIT = 8192;
// Deletion marks are dropped after this long; a computer offline for longer may bring the profile back.
const KEEP_DELETIONS = 60 * 24 * 60 * 60 * 1000;
// In the base: this computer put a too-big placeholder in sync for the profile.
const TOO_BIG = 'too big';

export type SyncedProfile = Omit<Profile, 'enabled' | 'tab' | 'offAt'>;
export type SyncItems = Record<string, unknown>;
export interface SyncBase {
  /** Synced form (stable JSON) of each profile at the last agreement. */
  profiles: Record<string, string>;
  order: string[];
}
export const emptyBase = (): SyncBase => ({ profiles: {}, order: [] });

/** JSON with sorted keys, to compare objects whatever order their keys were written in. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A profile as it is synced. */
export function syncedProfile(p: Profile): SyncedProfile {
  const { enabled: _enabled, tab: _tab, offAt: _offAt, ...rest } = p;
  const strip = (h: HeaderMod): HeaderMod => (isSecret(h) ? { ...h, value: '', secret: true } : h);
  return { ...rest, requestHeaders: p.requestHeaders.map(strip), responseHeaders: p.responseHeaders.map(strip) };
}

const str = (v: unknown): v is string => typeof v === 'string';
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const OPS = ['set', 'append', 'remove'];

/** A synced profile read back, if every part of it is something this version can use. */
function readProfile(item: unknown, id: string): SyncedProfile | undefined {
  if (!obj(item) || item.id !== id || !str(item.title)) return undefined;
  const headers = (v: unknown) => Array.isArray(v) && v.every(h => obj(h) && str(h.id) && str(h.name) && str(h.value) && OPS.includes(h.op as string) && typeof h.enabled === 'boolean');
  const filters = Array.isArray(item.filters) && item.filters.every(f => obj(f) && str(f.id) && str(f.pattern) && (f.kind === 'include' || f.kind === 'exclude'));
  const redirects = item.redirects === undefined || (Array.isArray(item.redirects) && item.redirects.every(r => obj(r) && str(r.id) && str(r.from) && str(r.to)));
  const lists = ['initiatorDomains', 'excludedInitiatorDomains', 'resourceTypes', 'requestMethods'].every(k => item[k] === undefined || (Array.isArray(item[k]) && (item[k] as unknown[]).every(str)));
  return headers(item.requestHeaders) && headers(item.responseHeaders) && filters && redirects && lists ? item as unknown as SyncedProfile : undefined;
}

/** Remote headers, with this computer's values put back where a secret was left out. */
function withLocalSecrets(remote: HeaderMod[], local: HeaderMod[] | undefined): HeaderMod[] {
  const byId = new Map((local ?? []).map(h => [h.id, h]));
  return remote.map(h => {
    const mine = byId.get(h.id);
    // Left out on the way: keep the value this computer has, whatever made it secret.
    return h.secret && h.value === '' && mine && mine.value !== '' ? { ...h, value: mine.value } : h;
  });
}

/** A profile here: content from sync; on/off, tab, timer and secret values from this computer. New ones come in off. */
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

export interface Reconciled {
  /** The profiles here after taking in the other computers' changes; undefined if unchanged. */
  state?: State;
  set: SyncItems;
  remove: string[];
  base: SyncBase;
  tooBig: string[];
  /** Titles of profiles changed on two computers at once (both versions kept). */
  conflicts: string[];
}

/**
 * One round of sync: this computer's state against sync storage and the base.
 * `first`: sync was just switched on here; a blank starter profile then makes
 * way for the profiles already in sync.
 */
export function reconcile(local: State, remote: SyncItems, base: SyncBase, now: number, first = false): Reconciled | 'newer' {
  const order = remote[SYNC_ORDER];
  if (obj(order) && typeof order.v === 'number' && order.v > FORMAT) return 'newer';
  const remoteOrder = obj(order) && Array.isArray(order.order) ? order.order.filter(str) : [];

  const theirs = new Map<string, SyncedProfile>();
  const deleted = new Map<string, number>();
  const tooBigThere = new Set<string>();
  for (const [key, item] of Object.entries(remote)) {
    if (!key.startsWith(PREFIX)) continue;
    const id = key.slice(PREFIX.length);
    if (obj(item) && typeof item.deleted === 'number') deleted.set(id, item.deleted);
    else if (obj(item) && item.tooBig === true) tooBigThere.add(id);
    else {
      const p = readProfile(item, id);
      if (p) theirs.set(id, p); // anything unreadable is left alone, as if not there yet
    }
  }

  const mine = new Map(local.profiles.map(p => [p.id, p]));
  const set: SyncItems = {};
  const remove: string[] = [];
  const next: SyncBase = { profiles: {}, order: [] };
  const kept = new Map<string, Profile>();
  const added: Profile[] = []; // copies made on a conflict
  const tooBig: string[] = [];
  const conflicts: string[] = [];
  const send = (p: Profile, form: SyncedProfile, s: string) => { set[PREFIX + p.id] = form; next.profiles[p.id] = s; };

  // Switched on with only a blank profile here, and profiles in sync: the blank one goes.
  const dropBlank = first && local.profiles.length === 1 && isBlank(local.profiles[0]) && theirs.size > 0;

  const ids = [...new Set([...local.profiles.map(p => p.id), ...remoteOrder, ...theirs.keys(), ...Object.keys(base.profiles)])];
  for (const id of ids) {
    const L = mine.get(id);
    const R = theirs.get(id);
    const B = base.profiles[id];
    if (L && dropBlank && L === local.profiles[0] && !R) continue;
    const form = L ? syncedProfile(L) : undefined;
    const Ls = form ? stable(form) : undefined;
    const Rs = R ? stable(R) : undefined;

    if (L && form && bytes(PREFIX + id) + bytes(JSON.stringify(form)) > SYNC_ITEM_LIMIT) {
      // Too big for one sync item: kept here, a placeholder there, the other computers keep their copy.
      kept.set(id, L);
      tooBig.push(L.title.trim() || id);
      if (!tooBigThere.has(id)) set[PREFIX + id] = { id, tooBig: true };
      next.profiles[id] = TOO_BIG;
      continue;
    }
    if (L && tooBigThere.has(id) && !R && B !== TOO_BIG) {
      // Too big on another computer: keep this copy, and don't send it over the bigger one.
      kept.set(id, L);
      if (B !== undefined) next.profiles[id] = B;
      continue;
    }
    if (L && R) {
      if (Ls === Rs) { kept.set(id, L); next.profiles[id] = Ls!; }
      else if (Ls === B) { kept.set(id, fromSynced(R, L)); next.profiles[id] = Rs!; } // changed elsewhere
      else if (Rs === B) { kept.set(id, L); send(L, form!, Ls!); } // changed here
      else {
        // Changed on both (or met for the first time with different contents): keep
        // both. This computer's version keeps the id; the other comes in as a copy.
        kept.set(id, L);
        send(L, form!, Ls!);
        const copy = fromSynced(R, undefined);
        added.push({ ...copy, id: newId(), title: t('syncConflictTitle', { title: R.title }) });
        conflicts.push(L.title.trim() || id);
      }
    } else if (L) {
      // Deleted elsewhere and not changed here since: goes here too. Otherwise (new
      // here, changed here after a deletion elsewhere, or its item lost) it is sent.
      if (deleted.has(id) && B !== undefined && Ls === B) continue;
      kept.set(id, L);
      send(L, form!, Ls!);
    } else if (R) {
      if (B === undefined) kept.set(id, fromSynced(R, undefined)); // new elsewhere: comes in off
      else if (Rs === B) set[PREFIX + id] = { id, deleted: now }; // deleted here
      else kept.set(id, fromSynced(R, undefined)); // changed elsewhere after a deletion here: the change wins
      if (kept.has(id)) next.profiles[id] = Rs!;
    }
  }
  for (const p of added) {
    const form = syncedProfile(p);
    kept.set(p.id, p);
    send(p, form, stable(form));
  }
  // Old deletion marks.
  for (const [id, at] of deleted) if (now - at > KEEP_DELETIONS && !kept.has(id)) remove.push(PREFIX + id);

  // Order: the other computers' if this one hasn't changed its own since the last
  // agreement (or is just joining: its own profiles then go after theirs).
  const localOrder = local.profiles.map(p => p.id);
  const useTheirs = (first || stable(localOrder) === stable(base.order)) && remoteOrder.length > 0;
  const ranked = [...new Set([...(useTheirs ? remoteOrder : localOrder), ...localOrder, ...kept.keys()])].filter(id => kept.has(id));
  next.order = ranked;
  if (stable(remoteOrder) !== stable(ranked) || !obj(order)) set[SYNC_ORDER] = { v: FORMAT, order: ranked };

  // Never none: the popup needs one to show.
  const profiles = ranked.length ? ranked.map(id => kept.get(id)!) : [emptyProfile()];
  const state: State = { ...local, profiles };
  const changed = stable(state) !== stable(local);
  return { ...(changed ? { state } : {}), set, remove, base: next, tooBig, conflicts };
}

export interface SyncStatus {
  at: number;
  tooBig?: string[];
  conflicts?: string[];
  error?: string;
}

export interface SyncApi {
  enabled(): Promise<boolean>;
  base(): Promise<SyncBase>;
  setBase(base: SyncBase): Promise<void>;
  remote: {
    get(): Promise<SyncItems>;
    set(items: SyncItems): Promise<void>;
    remove(keys: string[]): Promise<void>;
  };
  loadState(): Promise<State>;
  saveState(state: State): Promise<void>;
  status(s: SyncStatus): Promise<void>;
  /** Try again in a while (a quota error, or the profiles changed under us). */
  retryLater(): void;
  /** The engine's edit queue: changes to the profiles one at a time. */
  edit<T>(fn: () => Promise<T>): Promise<T>;
  now(): number;
}

export function createSync(api: SyncApi) {
  return {
    /** One round: take in the other computers' changes, send this one's. */
    run(first = false): Promise<void> {
      return api.edit(async () => {
        if (!(await api.enabled())) return;
        try {
          const local = await api.loadState();
          const r = reconcile(local, await api.remote.get(), first ? emptyBase() : await api.base(), api.now(), first);
          if (r === 'newer') {
            await api.status({ at: api.now(), error: t('syncNewer') });
            return;
          }
          if (r.state) {
            // The popup saves outside this queue: if it saved meanwhile, start over later.
            if (stable(await api.loadState()) !== stable(local)) { api.retryLater(); return; }
            await api.saveState(r.state);
          }
          if (Object.keys(r.set).length) await api.remote.set(r.set);
          if (r.remove.length) await api.remote.remove(r.remove);
          await api.setBase(r.base);
          await api.status({ at: api.now(), ...(r.tooBig.length ? { tooBig: r.tooBig } : {}), ...(r.conflicts.length ? { conflicts: r.conflicts } : {}) });
        } catch (e) {
          // Most likely the browser's sync quota; nothing here is lost, the next round sends it.
          await api.status({ at: api.now(), error: e instanceof Error ? e.message : String(e) });
          api.retryLater();
        }
      });
    },
  };
}
