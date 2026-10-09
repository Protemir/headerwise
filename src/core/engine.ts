import { dropUnsupportedRegexes, forBrowser, toDnrRules, type DnrRule } from './dnr.ts';
import { activeHeaderCount, nextProfile, releaseTabs, statusTitle, type State } from './model.ts';
import { fillRules, rulesHaveVariables, type VariableSource } from './variables.ts';

/*
 * What the background script does, written against a small interface instead
 * of the global chrome object, so it can be tested in Node with a fake browser
 * (tests/engine.test.ts) and wired to Chrome or Firefox in background.ts.
 * Headerwise makes no network requests of its own; nothing here does either.
 */

export interface RuleUpdate {
  removeRuleIds?: number[];
  addRules?: DnrRule[];
}

export interface EngineApi {
  loadState(): Promise<State>;
  saveState(state: State): Promise<void>;
  session: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  dnr: {
    isRegexSupported(regex: string): Promise<{ isSupported: boolean; reason?: string }>;
    getDynamicRules(): Promise<{ id: number }[]>;
    updateDynamicRules(update: RuleUpdate): Promise<void>;
    getSessionRules(): Promise<{ id: number }[]>;
    updateSessionRules(update: RuleUpdate): Promise<void>;
  };
  /** Site access the user has granted. */
  grantedOrigins(): Promise<string[]>;
  badge: {
    setText(text: string): Promise<void>;
    setColor(color: string): Promise<void>;
    setTitle(title: string): Promise<void>;
  };
  alarms: {
    exists(name: string): Promise<boolean>;
    create(name: string, periodInMinutes: number): Promise<void>;
    clear(name: string): Promise<void>;
  };
  now(): number;
  variables(): VariableSource;
  /** Resource types this browser rejects (Firefox: webtransport, webbundle). */
  unsupportedResourceTypes: string[];
}

export const REFRESH_ALARM = 'refresh-variables';
const RED = '#c2410c';

export function createEngine(api: EngineApi) {
  async function apply(): Promise<void> {
    const state = await api.loadState();
    const converted = toDnrRules(state);
    const warnings = converted.warnings;
    const rules = forBrowser(
      await dropUnsupportedRegexes(converted, regex => api.dnr.isRegexSupported(regex)),
      api.unsupportedResourceTypes,
      warnings,
    );

    // Update the browser only when the rules really changed (not on a profile
    // rename, say). {{variables}} are filled in on a copy: a refresh of their
    // values keeps the rules' shape (structureKey), so it doesn't reset the
    // popup's "On this tab".
    const structureKey = JSON.stringify([rules, converted.info]);
    const filled = fillRules(rules, api.variables());
    const key = JSON.stringify(filled);
    const stored = await api.session.get(['rulesKey', 'structureKey']);
    let rejected = false;
    if (stored.rulesKey !== key) {
      // "Only this tab" rules need tabIds, which are allowed in session rules only.
      const session = filled.filter(r => r.condition.tabIds);
      const dynamic = filled.filter(r => !r.condition.tabIds);
      const clear = async () => {
        await api.dnr.updateDynamicRules({ removeRuleIds: (await api.dnr.getDynamicRules()).map(r => r.id) });
        await api.dnr.updateSessionRules({ removeRuleIds: (await api.dnr.getSessionRules()).map(r => r.id) });
      };
      try {
        await clear();
        await api.dnr.updateDynamicRules({ addRules: dynamic });
        await api.dnr.updateSessionRules({ addRules: session });
        await api.session.set({
          rulesKey: key,
          structureKey,
          ruleInfo: converted.info,
          ...(stored.structureKey !== structureKey ? { rulesUpdatedAt: api.now() } : {}),
        });
      } catch (e) {
        // Regexes are checked above, so this should be rare. The browser rejects
        // the whole batch, so clear our rules instead of leaving stale ones.
        rejected = true;
        await clear();
        // An empty key makes the next sync try again.
        await api.session.set({ rulesKey: '', structureKey: '', ruleInfo: {}, rulesUpdatedAt: api.now() });
        warnings.push(`The browser rejected the rules: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // {{uuid}}, {{timestamp}}...: new values every minute while any rule uses them.
    const wantRefresh = rulesHaveVariables(rules);
    const hasRefresh = await api.alarms.exists(REFRESH_ALARM);
    if (wantRefresh && !hasRefresh) await api.alarms.create(REFRESH_ALARM, 1);
    if (!wantRefresh && hasRefresh) await api.alarms.clear(REFRESH_ALARM);

    // Without host access the browser keeps the rules but changes nothing.
    const noAccess = (await api.grantedOrigins()).length === 0;
    if (noAccess && rules.length) {
      warnings.unshift('Headerwise has no access to sites yet, so no headers are changed. Click "Allow on all sites" above.');
    }

    await api.session.set({ warnings });
    await api.badge.setTitle(statusTitle(state));
    const count = activeHeaderCount(state);
    const broken = count > 0 && (rejected || noAccess);
    await api.badge.setText(state.paused ? 'off' : broken ? '!' : count > 0 ? String(count) : '');
    await api.badge.setColor(state.paused ? '#888888' : warnings.length ? RED : '#2563eb');
  }

  async function sync(): Promise<void> {
    try {
      await apply();
    } catch (e) {
      // Never fail silently: the user would see a working badge and no headers.
      await api.session.set({ warnings: [`Headerwise could not apply your profiles: ${e instanceof Error ? e.message : String(e)}`] });
      await api.badge.setText('!');
      await api.badge.setColor(RED);
    }
  }

  // One sync at a time, in order: events can arrive faster than a sync finishes.
  let queue: Promise<void> = Promise.resolve();
  function queueSync(): Promise<void> {
    queue = queue.then(sync, sync);
    return queue;
  }

  return {
    queueSync,

    /** Tab ids are per browser session: "only this tab" bindings end with the tab (no id: browser start). */
    async release(tabId?: number): Promise<void> {
      const state = await api.loadState();
      if (releaseTabs(state, tabId)) await api.saveState(state); // the storage change triggers a sync
      else if (tabId === undefined) await queueSync(); // browser start: session rules are gone, rebuild
    },

    /** Keyboard shortcuts. Returns whether the command was ours. */
    async command(name: string): Promise<boolean> {
      const state = await api.loadState();
      if (name === 'toggle-pause') state.paused = !state.paused;
      else if (name === 'next-profile') nextProfile(state);
      else return false;
      await api.saveState(state);
      return true;
    },
  };
}
