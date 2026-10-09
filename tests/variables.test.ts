import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { fillRules, fillValue, hasVariables, rulesHaveVariables, unknownVariables, type VariableSource } from '../src/core/variables.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import { importModHeader } from '../src/core/import-modheader.ts';
import type { Profile } from '../src/core/model.ts';

let n = 0;
const src: VariableSource = { now: new Date('2026-10-09T10:20:30.456Z'), uuid: () => `uuid-${++n}`, random: () => 0.5 };

describe('variables', () => {
  it('fills every known variable, case and spaces aside', () => {
    expect(fillValue('{{timestamp}} {{ unix }} {{ISO}} {{date}} {{random}}', src)).toBe('1791541230456 1791541230 2026-10-09T10:20:30.456Z 2026-10-09 1073741824');
    // each {{uuid}} gets its own value
    const [, a, b] = /^req-uuid-(\d+)\/uuid-(\d+)$/.exec(fillValue('req-{{uuid}}/{{uuid}}', src)) ?? [];
    expect(a !== undefined && a !== b).toBe(true);
  });

  it('leaves unknown names and plain braces alone, and reports them', () => {
    expect(fillValue('{{user}} {not} {{ }}', src)).toBe('{{user}} {not} {{ }}');
    expect(unknownVariables('{{user}} {{uuid}} {{Env}}')).toEqual(['user', 'Env']);
    expect([hasVariables('x {{uuid}}'), hasVariables('{{user}}'), hasVariables('plain')]).toEqual([true, false, false]);
  });

  it('fills rules without touching the originals, and tells when a refresh is needed', () => {
    const p: Profile = { id: 'p', title: 'P', enabled: true, filters: [],
      requestHeaders: [{ id: 'a', enabled: true, name: 'X-Request-Id', value: '{{uuid}}', op: 'set' }, { id: 'b', enabled: true, name: 'X-Plain', value: 'v', op: 'set' }],
      responseHeaders: [{ id: 'c', enabled: true, name: 'X-Gone', value: '', op: 'remove' }] };
    const { rules, warnings } = toDnrRules({ version: 1, paused: false, profiles: [p] });
    expect(warnings).toEqual([]);
    expect(rulesHaveVariables(rules)).toBe(true);
    const filled = fillRules(rules, src);
    const action = filled[0].action as { requestHeaders: { value?: string }[]; responseHeaders: { value?: string }[] };
    expect(action.requestHeaders[0].value).toMatch(/^uuid-\d+$/);
    expect(action.requestHeaders[1].value).toBe('v');
    expect(action.responseHeaders[0].value).toBe(undefined);
    expect((rules[0].action as { requestHeaders: { value?: string }[] }).requestHeaders[0].value).toBe('{{uuid}}');
    expect(rulesHaveVariables(filled)).toBe(false);
  });

  it('warns about unknown variables in rules and in ModHeader imports', () => {
    const p: Profile = { id: 'p', title: 'P', enabled: true, filters: [], responseHeaders: [],
      requestHeaders: [{ id: 'a', enabled: true, name: 'X-User', value: '{{user}}', op: 'set' }] };
    expect(toDnrRules({ version: 1, paused: false, profiles: [p] }).warnings).toEqual(['"P", request header "X-User": {{user}} is not a Headerwise variable, sent as plain text.']);
    expect(importModHeader('[{"title":"M","headers":[{"name":"X-A","value":"{{uuid}}"},{"name":"X-B","value":"{{user}}"}]}]').warnings)
      .toEqual(['"M": {{user}} is not a Headerwise variable and will be sent as plain text.']);
  });
});
