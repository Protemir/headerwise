import { describe, it } from 'node:test';
import { expect } from './expect.ts';
import { importModHeader } from '../src/core/import-modheader.ts';

// Fixtures are reconstructed from public examples, not real exports yet.
const newer = JSON.stringify([
  {
    title: 'Staging',
    headers: [
      { enabled: true, name: 'X-Env', value: 'staging', comment: 'routes to staging' },
      { enabled: false, name: 'Authorization', value: 'Bearer x' },
      { enabled: true, name: '', value: 'dropped' },
    ],
    respHeaders: [{ enabled: true, name: 'Access-Control-Allow-Origin', value: '*' }],
    urlFilters: [{ enabled: true, urlRegex: '.*://api\\.example\\.com/.*' }],
    excludeUrlFilters: [{ enabled: true, urlRegex: '.*/health' }],
  },
  { shortTitle: 'B', headers: [{ name: 'X-B', value: '1' }] },
]);

const older = JSON.stringify({
  title: 'Old',
  appendMode: 'true',
  headers: [{ enabled: true, name: 'Accept-Language', value: 'kk' }],
  filters: [
    { enabled: true, type: 'urls', urlRegex: 'example' },
    { enabled: true, type: 'excludeUrls', urlRegex: 'login' },
    { enabled: true, type: 'types', resourceType: ['xmlhttprequest'] },
  ],
});

describe('importModHeader', () => {
  it('reads the newer array format', () => {
    const { profiles, warnings } = importModHeader(newer);
    expect(warnings).toEqual([]);
    expect(profiles.map(p => [p.title, p.enabled])).toEqual([['Staging', true], ['B', false]]);

    const [staging] = profiles;
    expect(staging.requestHeaders.map(h => [h.name, h.value, h.enabled, h.op])).toEqual([
      ['X-Env', 'staging', true, 'set'],
      ['Authorization', 'Bearer x', false, 'set'],
    ]);
    expect(staging.requestHeaders[0].comment).toBe('routes to staging');
    expect(staging.responseHeaders[0].name).toBe('Access-Control-Allow-Origin');
    expect(staging.filters.map(f => [f.kind, f.pattern, f.isRegex])).toEqual([
      ['include', '.*://api\\.example\\.com/.*', true],
      ['exclude', '.*/health', true],
    ]);
  });

  it('reads the older single-profile format with append mode and typed filters', () => {
    const { profiles, warnings } = importModHeader(older);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].requestHeaders[0].op).toBe('append');
    expect(profiles[0].filters.map(f => f.kind)).toEqual(['include', 'exclude']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/type "types"/);
  });

  it('accepts { profiles: [...] }', () => {
    expect(importModHeader(JSON.stringify({ profiles: [{ title: 'X' }] })).profiles[0].title).toBe('X');
  });

  it('rejects garbage without throwing', () => {
    expect(importModHeader('not json').warnings).toEqual(['Not valid JSON.']);
    expect(importModHeader('42').profiles).toEqual([]);
    expect(importModHeader('[]').warnings).toEqual(['No profiles found in the file.']);
  });
});
