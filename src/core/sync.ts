import { t } from './i18n.ts';
import { emptyProfile, isSecret, type HeaderMod, type Profile, type State } from './model.ts';

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
  /** Profiles whose agreed version this computer wrote itself (its fingerprint). */
  sent?: Record<string, string>;
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

/** A short fingerprint of a synced form: which version an edit was made from. */
export function fingerprint(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x9747b28c ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

export interface Reconciled {
  /** The profiles here after taking in the other computers' changes; undefined if unchanged. */
  state?: State;
  set: SyncItems;
  remove: string[];
  base: SyncBase;
  /** The base to keep if `state` couldn't be saved (the popup saved meanwhile): only what this computer still holds as it was. */
  baseIfNotSaved: SyncBase;
  tooBig: string[];
  /** Titles of profiles changed on two computers at once (both versions kept). */
  conflicts: string[];
}

/**
 * One round of sync: this computer's state against sync storage and the base.
 * `first`: sync was just switched on here; a blank starter profile then makes
 * way for the profiles already in sync, and their order comes first.
 *
 * Each item sent carries `parent`, the fingerprint of the version it was edited
 * from. Only a profile changed here is ever sent, so rounds always settle. When
 * a version this computer wrote is replaced by one not built on it (two computers
 * that didn't see each other's writes), the new one takes the id and this
 * computer's is kept as a copy. A computer that merely missed some versions in
 * between just takes the newest.
 */
export function reconcile(local: State, remote: SyncItems, base: SyncBase, now: number, first = false): Reconciled | 'newer' {
  const order = remote[SYNC_ORDER];
  if (obj(order) && typeof order.v === 'number' && order.v > FORMAT) return 'newer';
  const remoteOrder = obj(order) && Array.isArray(order.order) ? [...new Set(order.order.filter(str))] : [];

  const theirs = new Map<string, { p: SyncedProfile; s: string; parent?: string }>();
  const deleted = new Map<string, { at: number; parent?: string }>();
  const tooBigThere = new Set<string>();
  const unreadable = new Set<string>();
  for (const [key, item] of Object.entries(remote)) {
    if (!key.startsWith(PREFIX)) continue;
    const id = key.slice(PREFIX.length);
    const parent = obj(item) && str(item.parent) ? item.parent : undefined;
    if (obj(item) && typeof item.deleted === 'number') deleted.set(id, { at: item.deleted, parent });
    else if (obj(item) && item.tooBig === true) tooBigThere.add(id);
    else {
      const { parent: _parent, ...body } = obj(item) ? item : {};
      const p = readProfile(body, id);
      if (p) theirs.set(id, { p, s: stable(p), parent });
      else unreadable.add(id); // from a newer version, or damaged: left alone
    }
  }

  const mine = new Map(local.profiles.map(p => [p.id, p]));
  const set: SyncItems = {};
  const remove: string[] = [];
  const next: SyncBase = { profiles: {}, order: [] };
  const kept = new Map<string, Profile>();
  const added: Profile[] = []; // copies kept on a conflict
  const marked = new Set<string>(); // deleted here this round
  const tooBig: string[] = [];
  const conflicts: string[] = [];
  const sentHere: Record<string, string> = {};
  next.sent = sentHere;
  const send = (p: Profile, form: SyncedProfile, s: string, parent?: string) => {
    set[PREFIX + p.id] = parent ? { ...form, parent } : form;
    next.profiles[p.id] = s;
    sentHere[p.id] = fingerprint(s);
  };
  // This computer wrote the version it last agreed on, and the incoming one wasn't built on it.
  const overwrote = (id: string, parent: string | undefined, fromB: string | undefined) =>
    parent !== undefined && fromB !== undefined && parent !== fromB && base.sent?.[id] === fromB;
  // A version kept next to another under an id made from both, so a round repeated
  // after a failure finds the copy it already made instead of making another.
  const keepCopy = (p: Profile, s: string, title: string) => {
    const id = `${p.id}~${fingerprint(s)}`;
    if (mine.has(id) || theirs.has(id) || added.some(x => x.id === id)) return;
    added.push({ ...p, id, enabled: false, tab: undefined, offAt: undefined, title: t('syncConflictTitle', { title }) });
  };

  // Switched on with only a blank profile here, and profiles in sync: the blank one goes.
  const dropBlank = first && local.profiles.length === 1 && isBlank(local.profiles[0]) && theirs.size > 0;

  const ids = [...new Set([...local.profiles.map(p => p.id), ...remoteOrder, ...theirs.keys(), ...Object.keys(base.profiles), ...tooBigThere])];
  for (const id of ids) {
    const L = mine.get(id);
    const T = theirs.get(id);
    const R = T?.p;
    const Rs = T?.s;
    const B = base.profiles[id];
    const fromB = B !== undefined && B !== TOO_BIG ? fingerprint(B) : undefined;
    if (L && dropBlank && L === local.profiles[0] && !R) continue;
    const form = L ? syncedProfile(L) : undefined;
    const Ls = form ? stable(form) : undefined;

    if (L && form && bytes(PREFIX + id) + bytes(JSON.stringify({ ...form, parent: 'x'.repeat(14) })) > SYNC_ITEM_LIMIT) {
      // Too big for one sync item: kept here, a placeholder there, the other computers keep their copy.
      kept.set(id, L);
      tooBig.push(L.title.trim() || id);
      if (!tooBigThere.has(id)) set[PREFIX + id] = { id, tooBig: true };
      next.profiles[id] = TOO_BIG;
      continue;
    }
    if (L && !R && ((tooBigThere.has(id) && B !== TOO_BIG) || unreadable.has(id))) {
      // Too big on another computer, or written by a newer version: keep this copy, don't send it over that.
      kept.set(id, L);
      if (B !== undefined) next.profiles[id] = B;
      continue;
    }
    if (L && R && Rs !== undefined && Ls !== undefined && form) {
      if (Ls === Rs) {
        kept.set(id, L);
        next.profiles[id] = Ls;
        if (base.sent?.[id] === fingerprint(Ls)) sentHere[id] = base.sent[id]; // still ours
      } else if (Ls === B) {
        // Not changed here: the newer version is taken in. If it replaced this
        // computer's own write without having seen it, that one is kept as a copy.
        kept.set(id, fromSynced(R, L));
        next.profiles[id] = Rs;
        if (overwrote(id, T!.parent, fromB)) {
          keepCopy(L, Ls, L.title);
          conflicts.push(L.title.trim() || id);
        }
      } else if (Rs === B) {
        kept.set(id, L); // changed here
        send(L, form, Ls, fromB);
      } else if (B === undefined) {
        // Met for the first time with different contents: the version in sync keeps
        // the id (the other computers aren't disturbed), this one is kept as a copy.
        kept.set(id, fromSynced(R, L));
        next.profiles[id] = Rs;
        keepCopy(L, Ls, L.title);
        conflicts.push(L.title.trim() || id);
      } else {
        // Changed on both, or changed elsewhere without having seen this computer's
        // last version: this one keeps the id, the other is kept as a copy.
        kept.set(id, L);
        send(L, form, Ls, fingerprint(Rs));
        keepCopy(fromSynced(R, undefined), Rs, R.title);
        conflicts.push(L.title.trim() || id);
      }
    } else if (L && form && Ls !== undefined) {
      const mark = deleted.get(id);
      // Deleted elsewhere and not changed here since: goes here too (as a copy, if
      // the deletion was of an older version than the one this computer wrote).
      if (mark && Ls === B) {
        if (overwrote(id, mark.parent, fromB)) keepCopy(L, Ls, L.title);
        continue;
      }
      // New here, changed here (after a deletion elsewhere too), or its item lost: sent.
      kept.set(id, L);
      send(L, form, Ls, fromB);
    } else if (R && Rs !== undefined) {
      if (B === undefined || Rs !== B) {
        kept.set(id, fromSynced(R, undefined)); // new elsewhere (comes in off), or changed there after a deletion here
        next.profiles[id] = Rs;
      } else {
        set[PREFIX + id] = { id, deleted: now, ...(fromB ? { parent: fromB } : {}) }; // deleted here
        marked.add(id);
      }
    } else if (B !== undefined && tooBigThere.has(id)) {
      set[PREFIX + id] = { id, deleted: now }; // deleted here, too big to have been in sync
      marked.add(id);
    }
  }
  for (const p of added) {
    const form = syncedProfile(p);
    kept.set(p.id, p);
    send(p, form, stable(form));
  }
  // Old deletion marks.
  for (const [id, mark] of deleted) if (now - mark.at > KEEP_DELETIONS && !kept.has(id)) remove.push(PREFIX + id);

  // Order. Ids in sync this computer doesn't hold (not arrived yet, too big, newer)
  // stay in their places, so two computers never rewrite it back and forth.
  const othersOnly = remoteOrder.filter(id => !kept.has(id) && !deleted.has(id) && !marked.has(id) && !(mine.has(id) && !kept.has(id)));
  const localOrder = local.profiles.map(p => p.id);
  // The other computers' order, unless this one changed its own since the last agreement.
  const useTheirs = remoteOrder.length > 0 && (first || stable(localOrder) === stable(base.order.filter(id => mine.has(id))));
  let full: string[];
  if (useTheirs) {
    full = [...new Set([...remoteOrder.filter(id => kept.has(id) || othersOnly.includes(id)), ...localOrder.filter(id => kept.has(id)), ...kept.keys()])];
  } else {
    full = [...new Set([...localOrder.filter(id => kept.has(id)), ...kept.keys()])];
    for (const id of othersOnly) {
      const before = remoteOrder.slice(0, remoteOrder.indexOf(id)).reverse().find(x => full.includes(x));
      full.splice(before ? full.indexOf(before) + 1 : 0, 0, id);
    }
  }
  next.order = full;
  if (!obj(order) || stable(remoteOrder) !== stable(full)) set[SYNC_ORDER] = { v: FORMAT, order: full };

  // Never none: the popup needs one to show.
  const ranked = full.filter(id => kept.has(id));
  const profiles = ranked.length ? ranked.map(id => kept.get(id)!) : [emptyProfile()];
  const state: State = { ...local, profiles };
  const changed = stable(state) !== stable(local);

  const baseIfNotSaved: SyncBase = { profiles: {}, order: base.order, sent: {} };
  for (const id of new Set([...Object.keys(next.profiles), ...Object.keys(base.profiles)])) {
    const same = kept.get(id) === mine.get(id) && mine.has(id);
    const v = same ? next.profiles[id] : base.profiles[id];
    if (v !== undefined) baseIfNotSaved.profiles[id] = v;
    const sent = same ? sentHere[id] : base.sent?.[id];
    if (sent !== undefined) baseIfNotSaved.sent![id] = sent;
  }
  return { ...(changed ? { state } : {}), set, remove, base: next, baseIfNotSaved, tooBig, conflicts };
}

/**
 * The popup's state when a change arrives while it has unsaved typing: profiles
 * changed only here keep the typing, the rest comes from the change. A profile
 * changed in both keeps the typing, and the incoming version is kept as a copy.
 */
export function withEditsKept(saved: State, here: State, incoming: State): State {
  const j = (v: unknown) => stable(v);
  const before = new Map(saved.profiles.map(p => [p.id, j(p)]));
  const mine = new Map(here.profiles.map(p => [p.id, p]));
  const profiles: Profile[] = [];
  for (const p of incoming.profiles) {
    const m = mine.get(p.id);
    if (!m && before.has(p.id)) continue; // deleted here
    if (!m || j(m) === before.get(p.id)) { profiles.push(p); continue; } // not edited here
    const was = saved.profiles.find(x => x.id === p.id);
    // (Compared with secret values: a new token typed here is an edit.)
    const content = (x: Profile) => j({ ...x, enabled: undefined, tab: undefined, offAt: undefined });
    if (was && content(m) === content(was)) {
      // Only switched on or off, bound to a tab or timed here: the incoming content, with that.
      profiles.push({ ...p, enabled: m.enabled, tab: m.tab, offAt: m.offAt });
      continue;
    }
    profiles.push(m);
    // Changed there too (not just switched on or off, or a tab let go): keep that version as well.
    if (was && j(syncedProfile(p)) !== j(syncedProfile(was)) && j(syncedProfile(p)) !== j(syncedProfile(m))) {
      profiles.push({ ...p, id: `${p.id}~${fingerprint(stable(syncedProfile(p)))}`, enabled: false, tab: undefined, offAt: undefined, title: t('syncConflictTitle', { title: p.title }) });
    }
  }
  for (const p of here.profiles) if (!before.has(p.id) && !profiles.some(x => x.id === p.id)) profiles.push(p); // added here
  return { ...incoming, paused: here.paused !== saved.paused ? here.paused : incoming.paused, profiles };
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
  remote: {
    get(): Promise<SyncItems>;
    set(items: SyncItems): Promise<void>;
    remove(keys: string[]): Promise<void>;
  };
  loadState(): Promise<State>;
  /** Saves the profiles (if given) and the base together, in one write. */
  commit(state: State | undefined, base: SyncBase): Promise<void>;
  status(s: SyncStatus): Promise<void>;
  /** Try again in a while (after a failure). */
  retryLater(): void;
  /** The engine's edit queue: changes to the profiles one at a time. */
  edit<T>(fn: () => Promise<T>): Promise<T>;
  now(): number;
}

/** The browser's sync errors, in words. */
function syncError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  if (/QUOTA_BYTES(?!_PER_ITEM)/.test(message)) return t('syncFull');
  if (/MAX_WRITE_OPERATIONS|MAX_ITEMS/.test(message)) return t('syncBusy');
  return message;
}

export function createSync(api: SyncApi) {
  return {
    /** One round: take in the other computers' changes, send this one's. */
    run(first = false): Promise<void> {
      return api.edit(async () => {
        if (!(await api.enabled())) return;
        try {
          const local = await api.loadState();
          const r = reconcile(local, await api.remote.get(), await api.base(), api.now(), first);
          if (r === 'newer') {
            await api.status({ at: api.now(), error: t('syncNewer') });
            return;
          }
          // Sync first: if it fails, nothing here changes and the next round starts over.
          if (Object.keys(r.set).length) await api.remote.set(r.set);
          if (r.remove.length) await api.remote.remove(r.remove);
          // The popup saves outside this queue. If it saved meanwhile, its state
          // stays; what this round took in is taken in again by the next one.
          const saved = stable(await api.loadState()) === stable(local);
          await api.commit(saved ? r.state : undefined, saved ? r.base : r.baseIfNotSaved);
          await api.status({ at: api.now(), ...(r.tooBig.length ? { tooBig: r.tooBig } : {}), ...(r.conflicts.length ? { conflicts: r.conflicts } : {}) });
        } catch (e) {
          // Nothing here is lost: the next round sends it.
          await api.status({ at: api.now(), error: syncError(e) });
          api.retryLater();
        }
      });
    },
  };
}
