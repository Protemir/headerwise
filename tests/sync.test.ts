import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { createSync, mergeSynced, SYNC_INDEX, toSyncItems, type SyncItems, type SyncStatus } from '../src/core/sync.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import type { HeaderMod, Profile, State } from '../src/core/model.ts';

const h = (id: string, name: string, value: string): HeaderMod => ({ id, enabled: true, name, value, op: 'set' });
const p = (id: string, title: string, over: Partial<Profile> = {}): Profile => ({ id, title, enabled: true, requestHeaders: [h(`${id}-h`, 'X-' + title, '1')], responseHeaders: [], filters: [], ...over });
const st = (...profiles: Profile[]): State => ({ version: 1, paused: false, profiles });

// One shared sync store (the browser's account) and a computer per call.
function cloud() {
  let items: SyncItems = {};
  return {
    get items() { return items; },
    computer(start: State, enabled = true) {
      let state = structuredClone(start);
      let known: string[] = [];
      let status: SyncStatus | null = null;
      let queue = Promise.resolve();
      const sync = createSync({
        enabled: async () => enabled,
        known: async () => known,
        setKnown: async ids => { known = ids; },
        remote: {
          get: async () => structuredClone(items),
          set: async next => { items = { ...items, ...structuredClone(next) }; },
          remove: async keys => { items = Object.fromEntries(Object.entries(items).filter(([k]) => !keys.includes(k))); },
        },
        loadState: async () => structuredClone(state),
        saveState: async s => { state = structuredClone(s); },
        status: async s => { status = s; },
        edit: fn => { const run = queue.then(fn); queue = run.then(() => {}, () => {}); return run; },
        now: () => 0,
      });
      return {
        sync,
        get state() { return state; },
        set state(s: State) { state = structuredClone(s); },
        get status() { return status; },
        titles: () => state.profiles.map(x => `${x.title}${x.enabled ? '' : ' (off)'}`),
      };
    },
  };
}

describe('sync', () => {
  it('a second computer gets the profiles, switched off, its blank starter profile gone', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Staging'), p('2', 'Prod', { enabled: false })));
    await a.sync.start(true);
    const b = c.computer(st({ id: 'blank', title: 'Profile 1', enabled: true, requestHeaders: [{ id: 'x', enabled: true, name: '', value: '', op: 'set' }], responseHeaders: [], filters: [] }));
    await b.sync.start(true);
    expect(b.titles()).toEqual(['Staging (off)', 'Prod (off)']);
  });

  it('first switched on where both have profiles: both keep theirs and get the other\'s', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'A1')));
    await a.sync.start(true);
    const b = c.computer(st(p('2', 'B1')));
    await b.sync.start(true);
    await a.sync.pull();
    expect([a.titles(), b.titles()]).toEqual([['A1', 'B1 (off)'], ['A1 (off)', 'B1']]);
  });

  it('edits, new profiles, order and deletions travel; on/off, tab and timer stay put', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One'), p('2', 'Two'), p('3', 'Three')));
    await a.sync.start(true);
    const b = c.computer(st());
    await b.sync.start(true);
    b.state = { ...b.state, profiles: b.state.profiles.map(x => (x.id === '2' ? { ...x, enabled: true, tab: { id: 5, host: 'x' }, offAt: 99 } : x)) };

    const s = a.state;
    s.profiles = [s.profiles[2], { ...s.profiles[0], title: 'One renamed' }, p('4', 'Four')]; // 3 first, 1 renamed, 2 deleted, 4 new
    s.profiles[0].enabled = false;
    a.state = s;
    await a.sync.push();
    await b.sync.pull();
    expect(b.titles()).toEqual(['Three (off)', 'One renamed (off)', 'Four (off)']);

    // b's own on/off, tab and timer survive a change to the same profile from a
    await a.sync.pull();
    a.state = { ...a.state, profiles: [...a.state.profiles, p('5', 'Five')] };
    b.state = { ...b.state, profiles: b.state.profiles.map(x => (x.id === '4' ? { ...x, enabled: true, tab: { id: 5, host: 'x' }, offAt: 99 } : x)) };
    await a.sync.push();
    await b.sync.pull();
    const four = b.state.profiles.find(x => x.id === '4')!;
    expect([four.enabled, four.tab?.id, four.offAt, b.titles().at(-1)]).toEqual([true, 5, 99, 'Five (off)']);
  });

  it('secret values never reach sync, and each computer keeps its own', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Api', { requestHeaders: [h('t', 'Authorization', 'Bearer a-secret'), h('e', 'X-Env', 'dev')] })));
    await a.sync.start(true);
    expect(JSON.stringify(c.items).includes('a-secret')).toBe(false);

    const b = c.computer(st());
    await b.sync.start(true);
    const header = () => b.state.profiles[0].requestHeaders[0];
    expect([header().value, header().secret]).toEqual(['', true]);
    // not sent while empty: an empty Authorization would log you out
    b.state = { ...b.state, profiles: b.state.profiles.map(x => ({ ...x, enabled: true })) };
    const out = toDnrRules(b.state);
    expect(JSON.stringify(out.rules).includes('Authorization')).toBe(false);
    expect(out.warnings[0]).toMatch(/secret value isn't filled in on this computer/);

    // filled in on b, then a changes the profile: b's value stays, a's never arrives
    b.state.profiles[0].requestHeaders[0].value = 'Bearer b-secret';
    b.state = b.state;
    await b.sync.push();
    expect(JSON.stringify(c.items).includes('b-secret')).toBe(false);
    a.state = { ...a.state, profiles: [{ ...a.state.profiles[0], title: 'Api v2' }] };
    await a.sync.push();
    await b.sync.pull();
    expect([b.state.profiles[0].title, header().value]).toEqual(['Api v2', 'Bearer b-secret']);
    await a.sync.pull();
    expect(a.state.profiles[0].requestHeaders[0].value).toBe('Bearer a-secret');
  });

  it('settles: a push after a pull writes nothing, a pull after a push changes nothing', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One', { requestHeaders: [h('t', 'Cookie', 'sid=1')] })));
    await a.sync.start(true);
    const before = JSON.stringify(c.items);
    const local = JSON.stringify(a.state);
    await a.sync.pull();
    await a.sync.push();
    expect([JSON.stringify(c.items), JSON.stringify(a.state)]).toEqual([before, local]);
  });

  it('a profile too big to sync is named, and the other computers keep their copy', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Small'), p('2', 'Big')));
    await a.sync.start(true);
    const b = c.computer(st());
    await b.sync.start(true);
    a.state = { ...a.state, profiles: [a.state.profiles[0], { ...a.state.profiles[1], requestHeaders: [h('big', 'X-Big', 'x'.repeat(9000))] }] };
    await a.sync.push();
    expect(a.status?.tooBig).toEqual(['Big']);
    await b.sync.pull();
    expect(b.titles()).toEqual(['Small (off)', 'Big (off)']);
  });

  it('switched off: nothing is read or written', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One')), false);
    await a.sync.start(true);
    expect(c.items).toEqual({});
  });

  it('half-arrived or foreign data in sync is ignored, never empties the profiles', () => {
    const local = st(p('1', 'One'));
    expect(mergeSynced(local, {}, [])).toBe(undefined);
    expect(mergeSynced(local, { [SYNC_INDEX]: { v: 2, order: [] } }, [])).toBe(undefined);
    // index arrived, item not yet: the local copy stays
    expect(mergeSynced(local, { [SYNC_INDEX]: { v: 1, order: ['1'] }, 'hw:p:1': { junk: true } }, ['1'])).toBe(undefined);
    // everything deleted elsewhere: one blank profile remains
    const gone = mergeSynced(local, { [SYNC_INDEX]: { v: 1, order: [] } }, ['1'])!;
    expect(gone.profiles.length).toBe(1);
    expect(toSyncItems(local).items[SYNC_INDEX]).toEqual({ v: 1, order: ['1'] });
  });
});
