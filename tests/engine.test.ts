import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { createEngine, REFRESH_ALARM, type EngineApi, type RuleUpdate } from '../src/core/engine.ts';
import type { DnrRule } from '../src/core/dnr.ts';
import type { Profile, State } from '../src/core/model.ts';

// A fake browser that keeps everything in memory and records what was called.
function fakeBrowser(initial: State, { origins = ['<all_urls>'] as string[], rejectWith = '' } = {}) {
  let state = structuredClone(initial);
  const session: Record<string, unknown> = {};
  let dynamic: DnrRule[] = [];
  let sessionRules: DnrRule[] = [];
  const alarms = new Set<string>();
  const badge = { text: '', color: '', title: '' };
  const calls: string[] = [];
  let clock = 1000;
  let n = 0;
  const update = (list: () => DnrRule[], set: (r: DnrRule[]) => void, name: string) => async (u: RuleUpdate) => {
    calls.push(name);
    if (rejectWith && u.addRules?.length) throw new Error(rejectWith);
    set([...list().filter(r => !u.removeRuleIds?.includes(r.id)), ...(u.addRules ?? [])]);
  };
  const api: EngineApi = {
    loadState: async () => structuredClone(state),
    saveState: async s => { state = structuredClone(s); calls.push('save'); },
    session: {
      get: async keys => Object.fromEntries(keys.map(k => [k, session[k]])),
      set: async items => { Object.assign(session, items); },
    },
    dnr: {
      isRegexSupported: async regex => (/\(\?[=!]/.test(regex) ? { isSupported: false, reason: 'syntaxError' } : { isSupported: true }),
      getDynamicRules: async () => dynamic,
      updateDynamicRules: update(() => dynamic, r => { dynamic = r; }, 'updateDynamic'),
      getSessionRules: async () => sessionRules,
      updateSessionRules: update(() => sessionRules, r => { sessionRules = r; }, 'updateSession'),
    },
    grantedOrigins: async () => origins,
    badge: {
      setText: async t => { badge.text = t; },
      setColor: async c => { badge.color = c; },
      setTitle: async t => { badge.title = t; },
    },
    alarms: {
      exists: async name => alarms.has(name),
      create: async name => { alarms.add(name); calls.push('alarm+'); },
      clear: async name => { alarms.delete(name); calls.push('alarm-'); },
    },
    now: () => clock,
    variables: () => ({ now: new Date(clock), uuid: () => `uuid-${++n}`, random: () => 0.5 }),
  };
  return {
    api, badge, calls, alarms,
    get state() { return state; },
    set state(s: State) { state = structuredClone(s); },
    get dynamic() { return dynamic; },
    get session() { return sessionRules; },
    get stored() { return session; },
    tick() { clock += 1000; },
  };
}

const h = (name: string, value = '1') => ({ id: `${name}-${value}`, enabled: true, name, value, op: 'set' as const });
const p = (title: string, over: Partial<Profile> = {}): Profile => ({ id: title, title, enabled: true, requestHeaders: [h('X-A')], responseHeaders: [], filters: [], ...over });
const st = (profiles: Profile[], paused = false): State => ({ version: 1, paused, profiles });
const valueOf = (r: DnrRule | undefined) => (r?.action.type === 'modifyHeaders' ? r.action.requestHeaders?.[0]?.value : undefined);

describe('engine', () => {
  it('applies rules, badge and tooltip', async () => {
    const b = fakeBrowser(st([p('Staging', { requestHeaders: [h('X-A'), h('X-B')] }), p('Off', { enabled: false })]));
    await createEngine(b.api).queueSync();
    expect(b.dynamic).toHaveLength(1);
    expect(b.badge).toEqual({ text: '2', color: '#2563eb', title: 'Headerwise: Staging' });
    expect(b.stored.warnings).toEqual([]);
  });

  it('does not touch the browser rules when nothing changed (a rename, say)', async () => {
    const b = fakeBrowser(st([p('A')]));
    const e = createEngine(b.api);
    await e.queueSync();
    const updates = b.calls.length;
    b.state = st([p('A renamed', { id: 'A' })]);
    await e.queueSync();
    expect(b.calls.length).toBe(updates);
    expect(b.badge.title).toBe('Headerwise: A renamed');
  });

  it('refreshes {{variables}} without resetting "On this tab", and schedules the minute alarm', async () => {
    const b = fakeBrowser(st([p('Vars', { requestHeaders: [h('X-Id', '{{uuid}}')] })]));
    const e = createEngine(b.api);
    await e.queueSync();
    const first = valueOf(b.dynamic[0]);
    const since = b.stored.rulesUpdatedAt;
    expect(b.alarms.has(REFRESH_ALARM)).toBe(true);
    b.tick();
    await e.queueSync(); // what the alarm does
    expect(valueOf(b.dynamic[0]) !== first).toBe(true);
    expect(b.stored.rulesUpdatedAt).toBe(since);
    // A real edit does reset it.
    b.state = st([p('Vars', { requestHeaders: [h('X-Id', '{{uuid}}'), h('X-New')] })]);
    b.tick();
    await e.queueSync();
    expect(b.stored.rulesUpdatedAt === since).toBe(false);
    // And no alarm once nothing uses variables.
    b.state = st([p('Plain')]);
    await e.queueSync();
    expect(b.alarms.has(REFRESH_ALARM)).toBe(false);
  });

  it('puts "only this tab" rules into session rules', async () => {
    const b = fakeBrowser(st([p('Everywhere'), p('Tab', { tab: { id: 7, host: 'a.io' } })]));
    await createEngine(b.api).queueSync();
    expect(b.dynamic.map(r => r.condition.tabIds ?? null)).toEqual([null]);
    expect(b.session.map(r => r.condition.tabIds)).toEqual([[7]]);
  });

  it('shows "!" and why when there is no site access', async () => {
    const b = fakeBrowser(st([p('A')]), { origins: [] });
    await createEngine(b.api).queueSync();
    expect(b.badge.text).toBe('!');
    expect(String((b.stored.warnings as string[])[0])).toMatch(/no access to sites/);
  });

  it('clears everything and says so when the browser rejects the rules, then retries next time', async () => {
    const b = fakeBrowser(st([p('A')]), { rejectWith: 'Internal error' });
    await createEngine(b.api).queueSync();
    expect([b.dynamic.length, b.session.length, b.badge.text]).toEqual([0, 0, '!']);
    expect((b.stored.warnings as string[]).some(w => /rejected the rules: Internal error/.test(w))).toBe(true);
    expect(b.stored.rulesKey).toBe('');
  });

  it('never fails silently on broken stored state', async () => {
    const b = fakeBrowser({ version: 1, paused: false, profiles: [{ ...p('Broken'), requestHeaders: { 0: h('X') } as unknown as Profile['requestHeaders'] }] });
    await createEngine(b.api).queueSync();
    expect(b.badge.text).toBe('!');
    expect(String((b.stored.warnings as string[])[0])).toMatch(/could not apply/);
  });

  it('drops a profile whose "never on" regex the browser can\'t use, and keeps the rest', async () => {
    const b = fakeBrowser(st([p('Ok'), p('Bad', { filters: [{ id: 'f', enabled: true, kind: 'exclude', pattern: 'a(?=b)', isRegex: true }] })]));
    await createEngine(b.api).queueSync();
    expect(b.dynamic.filter(r => r.action.type === 'modifyHeaders')).toHaveLength(1);
    expect((b.stored.warnings as string[]).some(w => /"Bad": "never on" regex/.test(w))).toBe(true);
  });

  it('pause turns everything off with an "off" badge', async () => {
    const b = fakeBrowser(st([p('A')], true));
    await createEngine(b.api).queueSync();
    expect([b.dynamic.length, b.badge.text, b.badge.title]).toEqual([0, 'off', 'Headerwise: paused']);
  });

  it('closing a bound tab turns its profile off; a browser start releases all bindings', async () => {
    const b = fakeBrowser(st([p('A', { tab: { id: 7, host: 'a.io' } }), p('B', { tab: { id: 8, host: 'b.io' } })]));
    const e = createEngine(b.api);
    await e.release(99);
    expect(b.calls.includes('save')).toBe(false); // not ours: nothing written
    await e.release(7);
    expect(b.state.profiles.map(x => [x.enabled, x.tab?.id ?? null])).toEqual([[false, null], [true, 8]]);
    await e.release();
    expect(b.state.profiles.map(x => [x.enabled, x.tab?.id ?? null])).toEqual([[false, null], [false, null]]);
  });

  it('keyboard commands: pause and next profile', async () => {
    const b = fakeBrowser(st([p('A'), p('B', { enabled: false })]));
    const e = createEngine(b.api);
    expect(await e.command('toggle-pause')).toBe(true);
    expect(b.state.paused).toBe(true);
    await e.command('next-profile');
    expect([b.state.paused, b.state.profiles.map(x => x.enabled)]).toEqual([false, [false, true]]);
    expect(await e.command('something-else')).toBe(false);
  });

  it('runs syncs one at a time, in order', async () => {
    const b = fakeBrowser(st([p('A')]));
    const e = createEngine(b.api);
    const order: string[] = [];
    const load = b.api.loadState;
    let n = 0;
    // Every sync starts by reading the state; make that slow and watch for overlap.
    b.api.loadState = async () => {
      const i = ++n;
      order.push(`start ${i}`);
      await new Promise(r => setTimeout(r, 5));
      order.push(`end ${i}`);
      return load();
    };
    await Promise.all([e.queueSync(), e.queueSync(), e.queueSync()]);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
  });
});
