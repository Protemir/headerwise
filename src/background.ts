import { dropUnsupportedRegexes, toDnrRules } from './core/dnr.ts';
import { activeHeaderCount, releaseTabs } from './core/model.ts';
import { loadState, saveState, STATE_KEY } from './core/storage.ts';

// Headerwise makes no network requests of its own. Everything below only talks
// to the browser's local APIs.

let syncing: Promise<void> = Promise.resolve();

async function sync(): Promise<void> {
  try {
    await apply();
  } catch (e) {
    // Never fail silently: the user would see a working badge and no headers.
    await chrome.storage.session.set({ warnings: [`Headerwise could not apply your profiles: ${e instanceof Error ? e.message : String(e)}`] });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#c2410c' });
  }
}

async function apply(): Promise<void> {
  const state = await loadState();
  const converted = toDnrRules(state);
  const warnings = converted.warnings;
  const rules = await dropUnsupportedRegexes(
    converted,
    regex => chrome.declarativeNetRequest.isRegexSupported({ regex }),
  );

  // Rebuild only when the rules really changed (not on a profile rename, say):
  // a rebuild resets what the popup can report for the open tabs.
  const key = JSON.stringify([rules, converted.info]);
  const { rulesKey } = await chrome.storage.session.get('rulesKey');
  let rejected = false;
  if (rulesKey !== key) {
    // "Only this tab" rules need tabIds, which Chrome allows in session rules only.
    const dnr = chrome.declarativeNetRequest;
    const session = rules.filter(r => r.condition.tabIds);
    const dynamic = rules.filter(r => !r.condition.tabIds);
    const existing = await dnr.getDynamicRules();
    const existingSession = await dnr.getSessionRules();
    const clear = () => Promise.all([
      dnr.updateDynamicRules({ removeRuleIds: existing.map(r => r.id) }),
      dnr.updateSessionRules({ removeRuleIds: existingSession.map(r => r.id) }),
    ]);
    try {
      await clear();
      await dnr.updateDynamicRules({ addRules: dynamic as unknown as chrome.declarativeNetRequest.Rule[] });
      await dnr.updateSessionRules({ addRules: session as unknown as chrome.declarativeNetRequest.Rule[] });
      await chrome.storage.session.set({ rulesKey: key, ruleInfo: converted.info, rulesUpdatedAt: Date.now() });
    } catch (e) {
      // Regexes are checked above, so this should be rare. Chrome rejects the whole
      // batch, so clear our rules instead of leaving stale ones in place.
      rejected = true;
      await Promise.all([
        dnr.updateDynamicRules({ removeRuleIds: (await dnr.getDynamicRules()).map(r => r.id) }),
        dnr.updateSessionRules({ removeRuleIds: (await dnr.getSessionRules()).map(r => r.id) }),
      ]);
      // An empty key makes the next sync try again.
      await chrome.storage.session.set({ rulesKey: '', ruleInfo: {}, rulesUpdatedAt: Date.now() });
      warnings.push(`Chrome rejected the rules: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Without host access Chrome keeps the rules but changes nothing.
  const { origins = [] } = await chrome.permissions.getAll();
  const noAccess = origins.length === 0;
  if (noAccess && rules.length) {
    warnings.unshift('Headerwise has no access to sites yet, so no headers are changed. Click "Allow on all sites" above.');
  }

  await chrome.storage.session.set({ warnings });

  const count = activeHeaderCount(state);
  const broken = count > 0 && (rejected || noAccess);
  await chrome.action.setBadgeText({ text: state.paused ? 'off' : broken ? '!' : count > 0 ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#888888' : warnings.length ? '#c2410c' : '#2563eb' });
}

function queueSync(): void {
  syncing = syncing.then(sync, sync);
}

// Tab ids are per browser session: "only this tab" bindings end with the tab.
async function release(tabId?: number): Promise<void> {
  const state = await loadState();
  if (releaseTabs(state, tabId)) await saveState(state); // the storage change triggers a sync
  else if (tabId === undefined) queueSync(); // browser start: session rules are gone, rebuild
}

chrome.runtime.onInstalled.addListener(queueSync);
chrome.runtime.onStartup.addListener(() => release());
chrome.tabs.onRemoved.addListener(tabId => release(tabId));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STATE_KEY]) queueSync();
});
chrome.permissions.onAdded.addListener(queueSync);
chrome.permissions.onRemoved.addListener(queueSync);
