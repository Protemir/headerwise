import { dropUnsupportedRegexes, toDnrRules } from './core/dnr.ts';
import { activeHeaderCount } from './core/model.ts';
import { loadState, STATE_KEY } from './core/storage.ts';

// Headerwise makes no network requests of its own. Everything below only talks
// to the browser's local APIs.

let syncing: Promise<void> = Promise.resolve();

async function sync(): Promise<void> {
  const state = await loadState();
  const converted = toDnrRules(state);
  const warnings = converted.warnings;
  const rules = await dropUnsupportedRegexes(
    converted.rules,
    regex => chrome.declarativeNetRequest.isRegexSupported({ regex }),
    warnings,
  );

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map(r => r.id),
      addRules: rules as unknown as chrome.declarativeNetRequest.Rule[],
    });
  } catch (e) {
    // Regexes are checked above, so this should be rare. Chrome rejects the whole
    // batch, so clear our rules instead of leaving stale ones in place.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(r => r.id) });
    warnings.push(`Chrome rejected the rules: ${e instanceof Error ? e.message : String(e)}`);
  }

  await chrome.storage.session.set({ warnings });

  const count = activeHeaderCount(state);
  await chrome.action.setBadgeText({ text: state.paused ? 'off' : count > 0 ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: state.paused ? '#888888' : warnings.length ? '#c2410c' : '#2563eb' });
}

function queueSync(): void {
  syncing = syncing.then(sync, sync);
}

chrome.runtime.onInstalled.addListener(queueSync);
chrome.runtime.onStartup.addListener(queueSync);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STATE_KEY]) queueSync();
});
chrome.permissions.onAdded.addListener(queueSync);
