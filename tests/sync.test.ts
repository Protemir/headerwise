import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { createSync, emptyBase, reconcile, SYNC_ORDER, withEditsKept, type SyncBase, type SyncItems, type SyncStatus } from '../src/core/sync.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import type { HeaderMod, Profile, State } from '../src/core/model.ts';

const h = (id: string, name: string, value: string): HeaderMod => ({ id, enabled: true, name, value, op: 'set' });
const p = (id: string, title: string, over: Partial<Profile> = {}): Profile => ({ id, title, enabled: true, requestHeaders: [h(`${id}-h`, 'X-' + id, '1')], responseHeaders: [], filters: [], ...over });
const st = (...profiles: Profile[]): State => ({ version: 1, paused: false, profiles });
const blank = (): Profile => ({ id: 'blank', title: 'Profile 1', enabled: true, requestHeaders: [{ id: 'x', enabled: true, name: '', value: '', op: 'set' }], responseHeaders: [], filters: [] });

// One shared sync store (the browser's account) and a computer per call. Here every
// computer sees every write at once; the tests make the timing problems happen by
// choosing when each computer runs a round.
function cloud() {
  let items: SyncItems = {};
  let writes = 0;
  let clock = 1000;
  let refuse = false;
  return {
    get items() { return items; },
    set items(v: SyncItems) { items = v; },
    get writes() { return writes; },
    /** The browser's sync refuses writes (a quota) while this is set. */
    set refuse(v: boolean) { refuse = v; },
    /**
     * Two rounds that don't see each other's writes (offline, or seconds apart):
     * each runs against sync as it was, then the browser keeps the last write of
     * each item, here the second one's.
     */
    async apart(first: { run(): Promise<void> }, second: { run(): Promise<void> }) {
      const before = structuredClone(items);
      const wrote = () => Object.fromEntries(Object.entries(items).filter(([k, v]) => JSON.stringify(before[k]) !== JSON.stringify(v)));
      await first.run();
      const firstWrote = wrote();
      items = structuredClone(before);
      await second.run();
      const secondWrote = wrote();
      items = { ...before, ...firstWrote, ...secondWrote };
    },
    computer(start: State, on = true) {
      let enabled = on;
      let state = structuredClone(start);
      let base: SyncBase = emptyBase();
      let status: SyncStatus | undefined;
      let queue = Promise.resolve();
      const sync = createSync({
        enabled: async () => enabled,
        base: async () => structuredClone(base),
        commit: async (s, b) => { if (s) state = structuredClone(s); base = structuredClone(b); },
        remote: {
          get: async () => structuredClone(items),
          set: async next => { if (refuse) throw new Error('QUOTA_BYTES quota exceeded'); writes++; items = { ...items, ...structuredClone(next) }; },
          remove: async keys => { if (refuse) throw new Error('QUOTA_BYTES quota exceeded'); writes++; items = Object.fromEntries(Object.entries(items).filter(([k]) => !keys.includes(k))); },
        },
        loadState: async () => structuredClone(state),
        status: async s => { status = s; },
        retryLater: () => {},
        edit: fn => { const run = queue.then(fn); queue = run.then(() => {}, () => {}); return run; },
        now: () => clock++,
      });
      const computer = {
        run: (first = false) => sync.run(first),
        set enabled(v: boolean) { enabled = v; },
        get state() { return state; },
        get status() { return status; },
        /** An edit made here (in the popup), not yet synced. */
        change(fn: (s: State) => void) { const s = structuredClone(state); fn(s); state = s; },
        titles: () => state.profiles.map(x => `${x.title}${x.enabled ? '' : ' (off)'}`),
        profile: (id: string) => state.profiles.find(x => x.id === id),
      };
      return computer;
    },
  };
}

describe('sync', () => {
  it('a second computer gets the profiles, switched off; its blank starter profile makes way', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Staging'), p('2', 'Prod', { enabled: false })));
    await a.run(true);
    const b = c.computer(st(blank()));
    await b.run(true);
    expect(b.titles()).toEqual(['Staging (off)', 'Prod (off)']);
  });

  it('switched on where both have profiles: each keeps its own and gets the other\'s', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'A1')));
    await a.run(true);
    const b = c.computer(st(p('2', 'B1')));
    await b.run(true);
    await a.run();
    expect([a.titles(), b.titles()]).toEqual([['A1', 'B1 (off)'], ['A1 (off)', 'B1']]);
  });

  it('edits, new profiles, order and deletions travel; on/off, tab and timer stay put', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One'), p('2', 'Two'), p('3', 'Three')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    b.change(s => { Object.assign(s.profiles[0], { enabled: true, tab: { id: 5, host: 'x' }, offAt: 99 }); });

    a.change(s => { s.profiles = [s.profiles[2], { ...s.profiles[0], title: 'One renamed' }, p('4', 'Four')]; }); // 3 first, 1 renamed, 2 deleted, 4 new
    await a.run();
    await b.run();
    expect(b.titles()).toEqual(['Three (off)', 'One renamed', 'Four (off)']);
    const one = b.profile('1')!;
    expect([one.tab?.id, one.offAt]).toEqual([5, 99]);
    await a.run();
    expect(a.titles()).toEqual(['Three', 'One renamed', 'Four']);
  });

  it('an edit made while a round of its own is on the way is not undone (one computer)', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Staging')));
    await a.run(true);
    a.change(s => { s.profiles[0].title = 'Staging 2'; });
    await a.run(); // sent
    a.change(s => { s.profiles[0].title = 'Staging 2b'; }); // typed before the echo of that write came back
    await a.run(); // the echo
    expect(a.titles()).toEqual(['Staging 2b']);
  });

  it('two computers editing different profiles keep both edits, whoever runs first', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One'), p('2', 'Two')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    b.change(s => { s.profiles[0].title = 'One (B)'; }); // not sent yet
    a.change(s => { s.profiles[1].title = 'Two (A)'; });
    await a.run();
    await b.run(); // takes A's edit before sending its own
    await a.run();
    expect([a.titles(), b.titles().map(x => x.replace(' (off)', ''))]).toEqual([['One (B)', 'Two (A)'], ['One (B)', 'Two (A)']]);
  });

  it('profiles added on two computers at once both survive, everywhere', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    a.change(s => { s.profiles.push(p('ya', 'New on A')); });
    b.change(s => { s.profiles.push(p('zb', 'New on B')); });
    // B writes its order without A's new profile, as if it hadn't arrived yet
    await a.run();
    const fromA = c.items['hw:p:ya'];
    c.items = Object.fromEntries(Object.entries(c.items).filter(([k]) => k !== 'hw:p:ya'));
    await b.run();
    c.items = { ...c.items, 'hw:p:ya': fromA };
    await a.run();
    await b.run();
    const names = (x: typeof a) => x.titles().map(t => t.replace(' (off)', '')).sort();
    expect([names(a), names(b)]).toEqual([['New on A', 'New on B', 'One'], ['New on A', 'New on B', 'One']]);
  });

  it('the order arriving before the profiles deletes nothing', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One'), p('2', 'Two')));
    await a.run(true);
    const all = c.items;
    c.items = { [SYNC_ORDER]: all[SYNC_ORDER] }; // what B's browser has so far
    const b = c.computer(st(blank()));
    await b.run(true);
    c.items = { ...all, ...c.items };
    await a.run();
    await b.run();
    expect(a.titles().filter(x => x !== 'Profile 1 (off)')).toEqual(['One', 'Two']);
    expect(b.titles().filter(x => !x.startsWith('Profile 1'))).toEqual(['One (off)', 'Two (off)']);
  });

  it('edited on two computers at once: both versions kept, and the popup is told', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Api')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    a.change(s => { s.profiles[0].requestHeaders[0].value = 'from A'; });
    b.change(s => { s.profiles[0].requestHeaders[0].value = 'from B'; });
    await a.run();
    await b.run();
    expect(b.state.profiles.map(x => [x.title, x.requestHeaders[0].value])).toEqual([['Api', 'from B'], ['Api (from another computer)', 'from A']]);
    expect(b.status?.conflicts).toEqual(['Api']);
    await a.run();
    expect(a.state.profiles.length).toBe(2);
  });

  it('deleted here while edited elsewhere: the edit wins, nothing is lost', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Keep'), p('2', 'Doomed')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    a.change(s => { s.profiles = s.profiles.filter(x => x.id !== '2'); });
    b.change(s => { s.profiles[1].title = 'Doomed, edited'; });
    await a.run();
    await b.run();
    await a.run();
    expect([a.titles(), b.titles()]).toEqual([['Keep', 'Doomed, edited (off)'], ['Keep (off)', 'Doomed, edited (off)']]);
  });

  it('secret values never reach sync; each computer keeps its own, even when the lock is ticked elsewhere', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Api', { requestHeaders: [h('t', 'Authorization', 'Bearer a-secret'), h('k', 'X-Internal-Key', 'dev-key')] })));
    await a.run(true);
    expect(JSON.stringify(c.items).includes('a-secret')).toBe(false);

    const b = c.computer(st());
    await b.run(true);
    expect([b.profile('1')!.requestHeaders[0].value, b.profile('1')!.requestHeaders[0].secret]).toEqual(['', true]);
    // not sent while empty: an empty Authorization would log you out
    b.change(s => { s.profiles[0].enabled = true; });
    const out = toDnrRules(b.state);
    expect(JSON.stringify(out.rules).includes('Authorization')).toBe(false);
    expect(out.warnings[0]).toMatch(/secret value isn't filled in on this computer/);

    // filled in on b; a renames the profile and ticks the lock on X-Internal-Key
    b.change(s => { s.profiles[0].requestHeaders[0].value = 'Bearer b-secret'; });
    await b.run();
    expect(JSON.stringify(c.items).includes('b-secret')).toBe(false);
    a.change(s => { s.profiles[0].title = 'Api v2'; s.profiles[0].requestHeaders[1].secret = true; });
    await a.run();
    await b.run();
    const there = b.profile('1')!.requestHeaders;
    expect([b.profile('1')!.title, there[0].value, there[1].value, there[1].secret]).toEqual(['Api v2', 'Bearer b-secret', 'dev-key', true]);
    await a.run();
    expect(a.profile('1')!.requestHeaders[0].value).toBe('Bearer a-secret');
  });

  it('settles: a round with nothing new writes nothing and changes nothing', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One', { requestHeaders: [h('t', 'Cookie', 'sid=1')] })));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    await a.run();
    const [writes, local] = [c.writes, JSON.stringify(a.state)];
    await a.run();
    await b.run();
    await a.run();
    expect([c.writes, JSON.stringify(a.state)]).toEqual([writes, local]);
  });

  it('too big to sync: kept where it is, named, the others keep their copy; synced again once small', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Small'), p('2', 'Grows')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    a.change(s => { s.profiles[1].requestHeaders[0].value = 'x'.repeat(9000); s.profiles.push(p('3', 'Born big', { requestHeaders: [h('b', 'X-Big', 'y'.repeat(9000))] })); });
    await a.run();
    expect(a.status?.tooBig).toEqual(['Grows', 'Born big']);
    b.change(s => { s.profiles[0].title = 'Small (B)'; });
    await b.run();
    await a.run();
    expect([a.titles(), a.profile('2')!.requestHeaders[0].value.length]).toEqual([['Small (B)', 'Grows', 'Born big'], 9000]);
    expect(b.titles()).toEqual(['Small (B) (off)', 'Grows (off)']);
    a.change(s => { s.profiles[1].requestHeaders[0].value = 'small again'; });
    await a.run();
    await b.run();
    expect(b.profile('2')!.requestHeaders[0].value).toBe('small again');
  });

  it('a newer format elsewhere stops sync here, writing nothing', async () => {
    const c = cloud();
    c.items = { [SYNC_ORDER]: { v: 2, order: ['x'] }, 'hw:p:x': { something: 'new' } };
    const a = c.computer(st(p('1', 'One')));
    await a.run(true);
    expect([c.writes, a.status?.error]).toEqual([0, 'another computer has a newer Headerwise: update this one to keep syncing']);
  });

  it('unreadable items are left alone and never get into the profiles', () => {
    const r = reconcile(st(p('1', 'One')), { [SYNC_ORDER]: { v: 1, order: ['1', '2'] }, 'hw:p:2': { id: '2', title: 'Broken', requestHeaders: [{ id: 'h' }], responseHeaders: [], filters: [] } }, emptyBase(), 0);
    expect(r === 'newer' ? r : [r.state?.profiles.map(x => x.title) ?? 'unchanged', 'hw:p:2' in r.set, r.remove]).toEqual(['unchanged', false, []]);
  });

  it('edited on two computers that don\'t see each other\'s writes: both versions kept, the last written under the id', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    a.change(s => { s.profiles[0].title = 'One edited on A'; });
    b.change(s => { s.profiles[0].title = 'One edited on B'; });
    await c.apart(a, b); // B's write lands last
    await a.run();
    await b.run();
    await a.run();
    const names = (x: typeof a) => x.titles().map(t => t.replace(' (off)', '')).sort();
    expect(names(a)).toEqual(['One edited on A (from another computer)', 'One edited on B']);
    expect(names(b)).toEqual(names(a));
  });

  it('deleted on one computer while edited on another that hadn\'t seen it: the edit stays', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'Keep'), p('2', 'Two')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    b.change(s => { s.profiles[1].title = 'Two edited on B'; });
    a.change(s => { s.profiles = s.profiles.filter(x => x.id !== '2'); });
    await c.apart(b, a); // A's deletion lands last
    await b.run();
    await a.run();
    const names = (x: typeof a) => x.titles().map(t => t.replace(' (off)', ''));
    expect([names(a), names(b)]).toEqual([['Keep', 'Two edited on B (from another computer)'], ['Keep', 'Two edited on B (from another computer)']]);
  });

  it('switched off and on again: edits made elsewhere meanwhile win over the old copies here', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One'), p('2', 'Two')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    b.enabled = false;
    a.change(s => { s.profiles[0].title = 'One v2'; s.profiles = s.profiles.filter(x => x.id !== '2'); });
    await a.run();
    b.enabled = true;
    await b.run(true);
    await a.run();
    expect([a.titles(), b.titles()]).toEqual([['One v2'], ['One v2 (off)']]);
  });

  it('a failing write repeated many times makes one conflict copy, not one per try', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    a.change(s => { s.profiles[0].title = 'One on A'; });
    b.change(s => { s.profiles[0].title = 'One on B'; });
    await a.run();
    c.refuse = true;
    for (let i = 0; i < 4; i++) await b.run();
    expect([b.titles().length, b.status?.error]).toEqual([1, 'the browser\'s sync storage for Headerwise is full (100 KB): delete or shorten some profiles']);
    c.refuse = false;
    await b.run();
    await b.run();
    expect(b.titles().length).toBe(2);
  });

  it('an id one computer can\'t hold (too big there) doesn\'t make the order bounce between computers', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One'), p('2', 'Two')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    a.change(s => { s.profiles.splice(1, 0, p('big', 'Big', { requestHeaders: [h('b', 'X-Big', 'x'.repeat(9000))] })); });
    await a.run();
    await b.run();
    const writes = c.writes;
    for (let i = 0; i < 5; i++) { await a.run(); await b.run(); }
    expect([c.writes - writes, a.titles()]).toEqual([0, ['One', 'Big', 'Two']]);
  });

  it('a profile too big to sync can still be deleted, on either computer', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One'), p('2', 'Grows')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    a.change(s => { s.profiles[1].requestHeaders[0].value = 'x'.repeat(9000); });
    await a.run();
    a.change(s => { s.profiles = s.profiles.filter(x => x.id !== '2'); });
    await a.run();
    await b.run();
    expect(b.titles()).toEqual(['One (off)']);
  });

  it('the popup, typing while a change to the same profile arrives, keeps both', () => {
    const saved = st(p('1', 'One'), p('2', 'Two'));
    const here = structuredClone(saved);
    here.profiles[0].title = 'One typed';
    const incoming = structuredClone(saved);
    incoming.profiles[0].filters = [{ id: 'f', enabled: true, kind: 'include', pattern: '||b.example^', isRegex: false }];
    incoming.profiles[1].title = 'Two from B';
    incoming.paused = true;
    const out = withEditsKept(saved, here, incoming);
    expect([out.paused, out.profiles.map(x => x.title), out.profiles[1].filters[0]?.pattern])
      .toEqual([true, ['One typed', 'One (from another computer)', 'Two from B'], '||b.example^']);
    // only switched on or off there: no copy
    const toggled = structuredClone(saved);
    toggled.profiles[0].enabled = false;
    expect(withEditsKept(saved, here, toggled).profiles.map(x => x.title)).toEqual(['One typed', 'Two']);
  });

  it('a computer that missed versions in between takes the newest, with no copies', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'v0')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    const missed = structuredClone(c.items);
    for (const v of ['v1', 'v2', 'v3']) { a.change(s => { s.profiles[0].title = v; }); await a.run(); }
    const latest = c.items;
    c.items = missed; // b was asleep...
    c.items = latest; // ...and wakes up to the last one only
    await b.run();
    await a.run();
    expect([a.titles(), b.titles()]).toEqual([['v3'], ['v3 (off)']]);
  });

  it('three computers editing in turn, one of them asleep, settle on the newest and stop writing', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'v0')));
    await a.run(true);
    const b = c.computer(st());
    await b.run(true);
    const d = c.computer(st());
    await d.run(true);
    a.change(s => { s.profiles[0].title = 'v1 by A'; });
    await a.run();
    await b.run();
    b.change(s => { s.profiles[0].title = 'v2 by B'; });
    await b.run();
    await d.run(); // was asleep through v1
    for (let i = 0; i < 3; i++) { await a.run(); await b.run(); await d.run(); }
    const writes = c.writes;
    for (let i = 0; i < 3; i++) { await a.run(); await b.run(); await d.run(); }
    const names = (x: typeof a) => x.titles().map(t => t.replace(' (off)', ''));
    expect([c.writes - writes, names(a), names(b), names(d)]).toEqual([0, ['v2 by B'], ['v2 by B'], ['v2 by B']]);
  });

  it('the popup, switching a profile on while its rename arrives, takes the rename and keeps it on', () => {
    const saved = st(p('1', 'One', { enabled: false }));
    const here = structuredClone(saved);
    here.profiles[0].enabled = true;
    const incoming = structuredClone(saved);
    incoming.profiles[0].title = 'One renamed on B';
    const out = withEditsKept(saved, here, incoming);
    expect(out.profiles.map(x => [x.title, x.enabled])).toEqual([['One renamed on B', true]]);
  });

  it('the popup, pasting a new token while any change to that profile arrives, keeps the token', () => {
    const saved = st(p('1', 'Api', { requestHeaders: [h('t', 'Authorization', 'Bearer OLD')] }));
    const here = structuredClone(saved);
    here.profiles[0].requestHeaders[0].value = 'Bearer NEW';
    const incoming = structuredClone(saved);
    incoming.profiles[0].enabled = false; // the timer, a released tab, a shortcut
    expect(withEditsKept(saved, here, incoming).profiles[0].requestHeaders[0].value).toBe('Bearer NEW');
  });

  it('switched off: nothing is read or written', async () => {
    const c = cloud();
    const a = c.computer(st(p('1', 'One')), false);
    await a.run(true);
    expect([c.writes, c.items]).toEqual([0, {}]);
  });
});
