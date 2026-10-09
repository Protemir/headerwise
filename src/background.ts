import { FIREFOX_UNSUPPORTED_TYPES } from './core/dnr.ts';
import { createEngine, REFRESH_ALARM } from './core/engine.ts';
import { systemSource } from './core/variables.ts';
import { loadMeta, loadState, saveMeta, saveState, STATE_KEY } from './core/storage.ts';

// Wires the engine (src/core/engine.ts) to the browser. Headerwise makes no
// network requests of its own; everything here talks to local browser APIs.

const dnr = chrome.declarativeNetRequest;
// The Firefox build runs this same file (as an event page instead of a service worker).
const isFirefox = navigator.userAgent.includes('Firefox/');
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
  if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/migrate/index.html?welcome=1') });
});
chrome.runtime.onStartup.addListener(() => { engine.release(); });
chrome.tabs.onRemoved.addListener(tabId => { engine.release(tabId); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STATE_KEY]) engine.queueSync();
});
chrome.permissions.onAdded.addListener(() => { engine.queueSync(); });
chrome.permissions.onRemoved.addListener(() => { engine.queueSync(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === REFRESH_ALARM) engine.queueSync(); });
