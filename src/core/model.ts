export type HeaderOp = 'set' | 'remove' | 'append';

export interface HeaderMod {
  id: string;
  enabled: boolean;
  name: string;
  value: string;
  op: HeaderOp;
  comment?: string;
  /** Hide the value in the UI. Unset: decided by the name (see isSecret). */
  secret?: boolean;
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
  /**
   * "Only this tab": the profile applies to one tab only. Tab ids live as long as
   * the browser session, so the binding is dropped (and the profile turned off)
   * when the tab closes or the browser restarts.
   */
  tab?: { id: number; host: string };
  /** Only requests started by pages on these sites (and their subdomains). */
  initiatorDomains?: string[];
  /** Never requests started by pages on these sites. */
  excludedInitiatorDomains?: string[];
  /** Only these kinds of requests (Chrome's resource types). Empty or unset: all. */
  resourceTypes?: string[];
  /** Only these methods, lowercase ('get', 'post', ...). Empty or unset: all. */
  requestMethods?: string[];
}

export const RESOURCE_TYPES: { id: string; label: string }[] = [
  { id: 'main_frame', label: 'Page' },
  { id: 'sub_frame', label: 'Frames' },
  { id: 'xmlhttprequest', label: 'fetch / XHR' },
  { id: 'script', label: 'Scripts' },
  { id: 'stylesheet', label: 'Styles' },
  { id: 'image', label: 'Images' },
  { id: 'font', label: 'Fonts' },
  { id: 'media', label: 'Media' },
  { id: 'websocket', label: 'WebSocket' },
  { id: 'ping', label: 'Beacons' },
  { id: 'other', label: 'Other' },
];
export const REQUEST_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export interface State {
  version: 1;
  paused: boolean;
  profiles: Profile[];
}

// Names whose values are usually credentials.
const SECRET_NAME = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api[-_]?key|password|passwd|session|credential|signature/i;

/** Should the value be hidden in the UI? */
export function isSecret(h: Pick<HeaderMod, 'name' | 'secret'>): boolean {
  return h.secret ?? SECRET_NAME.test(h.name.trim());
}

/** "Bearer eyJh…" -> "Bear•••••", for places that show values read-only. */
export function maskValue(value: string): string {
  return value.length <= 4 ? '•'.repeat(value.length) : value.slice(0, 4) + '•'.repeat(Math.min(12, value.length - 4));
}

/**
 * Drops "only this tab" bindings, for a closed tab or (no id) for all after a
 * browser restart. Such profiles are turned off: without the binding they would
 * suddenly apply everywhere. Returns whether anything changed.
 */
export function releaseTabs(state: State, tabId?: number): boolean {
  let changed = false;
  for (const p of state.profiles) {
    if (!p.tab || (tabId !== undefined && p.tab.id !== tabId)) continue;
    delete p.tab;
    p.enabled = false;
    changed = true;
  }
  return changed;
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
