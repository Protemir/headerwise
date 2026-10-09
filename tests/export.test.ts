import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { exportFileName, exportProfiles, importProfiles } from '../src/core/export.ts';
import type { Profile } from '../src/core/model.ts';

const profile: Profile = {
  id: 'p1',
  title: 'Staging',
  enabled: true,
  requestHeaders: [
    { id: 'a', enabled: true, name: 'Authorization', value: 'Bearer secret', op: 'set' },
    { id: 'b', enabled: false, name: 'X-Env', value: 'staging', op: 'set', comment: 'routes to staging' },
    { id: 'c', enabled: true, name: 'X-Team', value: 'core', op: 'set', secret: true },
  ],
  responseHeaders: [{ id: 'd', enabled: true, name: 'Content-Security-Policy', value: '', op: 'remove' }],
  filters: [{ id: 'f', enabled: true, kind: 'exclude', pattern: '/login', isRegex: true }],
  tab: { id: 42, host: 'app.io' },
  initiatorDomains: ['app.io'],
  resourceTypes: ['xmlhttprequest'],
  requestMethods: ['post'],
};
const now = new Date('2026-10-09T10:00:00Z');

describe('export', () => {
  it('leaves secret values and the tab binding out by default', () => {
    const file = JSON.parse(exportProfiles([profile], { now }));
    expect([file.format, file.version, file.exported]).toEqual(['headerwise', 1, '2026-10-09T10:00:00.000Z']);
    const [p] = file.profiles;
    expect(p.tab).toBe(undefined);
    expect(p.requestHeaders.map((h: { name: string; value: string }) => [h.name, h.value])).toEqual([['Authorization', ''], ['X-Env', 'staging'], ['X-Team', '']]);
    expect(p.requestMethods).toEqual(['post']);
    expect(exportFileName(now)).toBe('headerwise-profiles-2026-10-09.json');
  });

  it('keeps secrets when asked', () => {
    const [p] = JSON.parse(exportProfiles([profile], { includeSecrets: true })).profiles;
    expect(p.requestHeaders[0].value).toBe('Bearer secret');
  });

  it('round-trips through import with fresh ids, and asks to fill in the missing secrets', () => {
    const { profiles, warnings } = importProfiles(exportProfiles([profile]));
    expect(profiles).toHaveLength(1);
    const [p] = profiles;
    expect(p.id === 'p1').toBe(false);
    expect([p.title, p.enabled, p.tab]).toEqual(['Staging', true, undefined]);
    expect(p.requestHeaders.map(h => [h.name, h.value, h.enabled, h.secret ?? null, h.comment ?? null])).toEqual([
      ['Authorization', '', true, true, null], ['X-Env', 'staging', false, null, 'routes to staging'], ['X-Team', '', true, true, null],
    ]);
    expect(p.responseHeaders[0].op).toBe('remove');
    expect(p.filters.map(f => [f.kind, f.pattern, f.isRegex])).toEqual([['exclude', '/login', true]]);
    expect([p.initiatorDomains, p.resourceTypes, p.requestMethods]).toEqual([['app.io'], ['xmlhttprequest'], ['post']]);
    expect(warnings).toEqual(['Secret values were not in the file, fill them in: "Staging" → Authorization, "Staging" → X-Team.']);
  });

  it('drops junk from hand-edited files', () => {
    const { profiles, warnings } = importProfiles(JSON.stringify({ format: 'headerwise', version: 1, profiles: [
      { title: 'Ok', requestHeaders: [{ name: 'X-A', value: 1, op: 'explode' }, { value: 'no name' }, 'nonsense'], filters: [{ kind: 'sometimes', pattern: 'x' }], resourceTypes: ['image', 'telepathy'], requestMethods: ['GET', 'TELEPORT'] },
      42,
    ] }));
    expect(warnings).toEqual([]);
    expect(profiles).toHaveLength(1);
    const [p] = profiles;
    expect([p.enabled, p.requestHeaders.map(h => [h.name, h.value, h.op]), p.filters, p.resourceTypes, p.requestMethods])
      .toEqual([false, [['X-A', '', 'set']], [], ['image'], ['get']]);
  });

  it('still reads ModHeader files', () => {
    expect(importProfiles('[{"title":"From ModHeader","headers":[{"name":"X-M","value":"1"}]}]').profiles[0].title).toBe('From ModHeader');
    expect(importProfiles('nope').warnings).toEqual(['Not valid JSON.']);
  });
});
