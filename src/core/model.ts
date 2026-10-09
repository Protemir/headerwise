export type HeaderOp = 'set' | 'remove' | 'append';

export interface HeaderMod {
  id: string;
  enabled: boolean;
  name: string;
  value: string;
  op: HeaderOp;
  comment?: string;
}

/**
 * include: the profile applies only to matching URLs (any include filter matches).
 * exclude: the profile never applies to matching URLs.
 *
 * isRegex=true  -> RE2 regular expression (Chrome's regexFilter).
 * isRegex=false -> Chrome urlFilter syntax ("||example.com^", "*api*"). A plain
 *                  domain in an exclude ("example.com") also covers its subdomains.
 */
export interface UrlFilter {
  id: string;
  enabled: boolean;
  kind: 'include' | 'exclude';
  pattern: string;
  isRegex: boolean;
}

export interface Profile {
  id: string;
  title: string;
  enabled: boolean;
  requestHeaders: HeaderMod[];
  responseHeaders: HeaderMod[];
  filters: UrlFilter[];
}

export interface State {
  version: 1;
  paused: boolean;
  profiles: Profile[];
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

export function emptyHeader(): HeaderMod {
  return { id: newId(), enabled: true, name: '', value: '', op: 'set' };
}

export function emptyProfile(title = 'Profile 1'): Profile {
  return {
    id: newId(),
    title,
    enabled: true,
    requestHeaders: [emptyHeader()],
    responseHeaders: [],
    filters: [],
  };
}

export function defaultState(): State {
  return { version: 1, paused: false, profiles: [emptyProfile()] };
}

/** Number of header modifications that are currently in effect. */
export function activeHeaderCount(state: State): number {
  if (state.paused) return 0;
  let n = 0;
  for (const p of state.profiles) {
    if (!p.enabled) continue;
    for (const h of [...p.requestHeaders, ...p.responseHeaders]) {
      if (h.enabled && h.name.trim() !== '') n++;
    }
  }
  return n;
}
