import { FIREFOX_UNSUPPORTED_TYPES } from './core/dnr.ts';
import { createEngine, REFRESH_ALARM, TIMER_ALARM } from './core/engine.ts';
import { systemSource } from './core/variables.ts';
import { isShareLink, MAX_LINK } from './core/share.ts';
import { createSync, emptyBase, type SyncBase, type SyncStatus } from './core/sync.ts';
import { loadMeta, loadState, saveMeta, saveState, STATE_KEY, type Meta } from './core/storage.ts';

// Wires the engine (src/core/engine.ts) to the browser. Headerwise makes no
// network requests of its own; everything here talks to local browser APIs.

const dnr = chrome.declarativeNetRequest;
// The Firefox build runs this same file (as an event page instead of a service worker).
const isFirefox = navigator.userAgent.includes('Firefox/');
// The automation build (scripts/automation.mjs) runs in test browsers: no welcome tab there.
const isAutomation = (chrome.runtime.getManifest().version_name ?? '').includes('automation');
type Rules = chrome.declarativeNetRequest.Rule[];

const engine = createEngine({
  loadState,
  saveState,
  session: {
    get: keys => chrome.storage.session.get(keys),
    set: items => chrome.storage.session.set(items),
  },
  dnr: {
    isRegexSupported: regex => dnr.isRegexSupported({ regex }),
    getDynamicRules: () => dnr.getDynamicRules(),
    updateDynamicRules: u => dnr.updateDynamicRules({ ...u, addRules: u.addRules as unknown as Rules }),
    getSessionRules: () => dnr.getSessionRules(),
    updateSessionRules: u => dnr.updateSessionRules({ ...u, addRules: u.addRules as unknown as Rules }),
  },
  grantedOrigins: async () => (await chrome.permissions.getAll()).origins ?? [],
  badge: {
    setText: text => chrome.action.setBadgeText({ text }),
    setColor: color => chrome.action.setBadgeBackgroundColor({ color }),
    setTitle: title => chrome.action.setTitle({ title }),
  },
  alarms: {
    exists: async name => !!(await chrome.alarms.get(name)),
    create: async (name, periodInMinutes) => { await chrome.alarms.create(name, { periodInMinutes }); },
    at: async (name, when) => { await chrome.alarms.create(name, { when }); },
    clear: async name => { await chrome.alarms.clear(name); },
  },
  now: Date.now,
  variables: systemSource,
  unsupportedResourceTypes: isFirefox ? FIREFOX_UNSUPPORTED_TYPES : [],
});

// Keyboard shortcuts (see "commands" in the manifest; people can change them at
// chrome://extensions/shortcuts).
chrome.commands.onCommand.addListener(command => { engine.command(command); });

chrome.runtime.onInstalled.addListener(details => {
  engine.queueSync();
  // When Headerwise came into use, for the "Rate Headerwise" link two weeks later.
  loadMeta().then(meta => { if (!meta.installedAt) saveMeta({ installedAt: Date.now() }); });
  // First install only (not updates): first steps and the ModHeader move.
  if (details.reason === 'install' && !isAutomation) chrome.tabs.create({ url: chrome.runtime.getURL('src/migrate/index.html?welcome=1') });
});
// The automation page asks for a sync and waits until the browser has the rules.
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'sync') return false;
  engine.queueSync().then(() => reply(true));
  return true;
});
// The share page (docs/share.html) hands over a share link when its "Add to
// Headerwise" button is clicked; only that site can (externally_connectable in the
// manifest). The editor opens in a tab and adds the profiles, switched off. Each
// link gets its own key, so two quick clicks open two tabs with one link each.
// Firefox has no externally_connectable: there any extension could send this, so
// the listener isn't there at all (the page then offers "paste into Import").
if (!isFirefox) chrome.runtime.onMessageExternal.addListener((message, _sender, reply) => {
  if (message?.type !== 'share') return false;
  // An answer either way: no answer would read on the page as "not installed".
  if (typeof message.link !== 'string' || message.link.length > MAX_LINK || !isShareLink(message.link)) { reply(false); return false; }
  const key = `shared-${crypto.randomUUID()}`;
  chrome.storage.session.set({ [key]: message.link })
    .then(() => chrome.tabs.create({ url: chrome.runtime.getURL(`src/popup/index.html?view=tab&shared=${key}`) }))
    .then(() => reply(true), () => reply(false));
  return true;
});
chrome.runtime.onStartup.addListener(() => { engine.release(); });
chrome.tabs.onRemoved.addListener(tabId => { engine.release(tabId); });
// Sync through the browser's account, when switched on (src/core/sync.ts). Edits
// go out a moment after the last one, so typing doesn't spend the browser's
// write quota; changes from other computers come in as they arrive.
const SYNC_RETRY = 'sync-retry';
const sync = createSync({
  enabled: async () => (await loadMeta()).sync === true,
  // Its own key: the popup writes meta (the sync switch) at any time.
  // Its own key, kept when sync is switched off: switched on again, it still knows
  // what was agreed, so edits made elsewhere meanwhile win over this computer's old copies.
  base: async () => ((await chrome.storage.local.get('syncBase')).syncBase as SyncBase | undefined) ?? emptyBase(),
  remote: {
    get: () => chrome.storage.sync.get(null),
    set: items => chrome.storage.sync.set(items),
    remove: keys => chrome.storage.sync.remove(keys),
  },
  loadState,
  commit: (state, base) => chrome.storage.local.set({ ...(state ? { [STATE_KEY]: JSON.parse(JSON.stringify(state)) } : {}), syncBase: base }),
  status: (s: SyncStatus) => chrome.storage.session.set({ syncStatus: s }),
  retryLater: () => { chrome.alarms.create(SYNC_RETRY, { delayInMinutes: 2 }); },
  edit: fn => engine.edit(fn),
  now: Date.now,
});
const timers: Record<string, ReturnType<typeof setTimeout>> = {};
const soon = (name: string, ms: number, fn: () => Promise<void>) => {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => { fn().catch(() => {}); }, ms);
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STATE_KEY]) {
    engine.queueSync();
    soon('sync', 1500, () => sync.run());
  }
  if (area === 'local' && changes.meta) {
    const was = (changes.meta.oldValue as Meta | undefined)?.sync === true;
    const now = (changes.meta.newValue as Meta | undefined)?.sync === true;
    if (!was && now) sync.run(true).catch(() => {});
    if (was && !now) chrome.storage.session.remove('syncStatus').catch(() => {});
  }
  if (area === 'sync') soon('sync', 300, () => sync.run());
});
// Every time the service worker starts: an edit whose round was cut short (the
// worker stopped, the browser closed) goes out now. Each round compares against
// the base, so running it again is harmless.
soon('sync', 2000, () => sync.run());
chrome.permissions.onAdded.addListener(() => { engine.queueSync(); });
chrome.permissions.onRemoved.addListener(() => { engine.queueSync(); });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === REFRESH_ALARM || a.name === TIMER_ALARM) engine.queueSync();
  if (a.name === SYNC_RETRY) sync.run().catch(() => {});
});
