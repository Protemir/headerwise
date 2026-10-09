// Writes ModHeader-shaped data into chrome.storage.local so Chrome produces a real LevelDB.
// tests/fixtures/leveldb-* were made by loading this as an unpacked extension in
// Chrome 154, calling steps.first(), steps.second() (and steps.bulk() for -bulk),
// closing Chrome and gzipping its "Local Extension Settings/<id>" folder.
const header = (name, value, extra = {}) => ({ enabled: true, name, value, comment: '', ...extra });
const v2 = (title, headers, more = {}) => ({ version: 2, title, shortTitle: title.slice(-1), hideComment: true, backgroundColor: '#6b5352', textColor: '#ffffff',
  headers, respHeaders: [], urlReplacements: [], cookieHeaders: [], setCookieHeaders: [], cspHeaders: [], reqCookieAppend: [],
  urlFilters: [], initiatorDomainFilters: [], excludeUrlFilters: [], resourceFilters: [], tabFilters: [], tabGroupFilters: [], windowFilters: [], timeFilters: [],
  excludeRequestDomainFilters: [], requestMethodFilters: [], ...more });
window.steps = {
  async first() {
    await chrome.storage.local.set({ profiles: [v2('Old', [header('X-Old', '1')])], selectedProfile: 0, tmp: 'to be deleted' });
  },
  async second() {
    await chrome.storage.local.set({
      profiles: [
        v2('Staging', [header('X-Env', 'staging'), header('Origin', '', { appendMode: undefined })], { urlFilters: [{ enabled: true, urlRegex: '.*://localhost:3000/.*', comment: '' }], respHeaders: [header('Access-Control-Allow-Origin', '*')] }),
        v2('Юникод ✓', [header('X-Note', 'привет')], { excludeUrlFilters: [{ enabled: true, urlRegex: '.*/login.*', comment: '' }] }),
        // old v1 profile, as ModHeader 3.x left it in storage
        { title: 'Legacy', appendMode: false, filters: [{ enabled: true, type: 'urls', urlRegex: 'example', resourceType: [] }], headers: [header('X-Legacy', 'yes')], respHeaders: [], urlReplacements: [], hideComment: true, shortTitle: 'L' },
      ],
      selectedProfile: 1,
      isPaused: false,
    });
    await chrome.storage.local.remove('tmp');
  },
  // Lots of compressible data, so Chrome flushes to sorted tables with snappy blocks.
  async bulk() {
    const many = [];
    for (let i = 0; i < 400; i++) many.push(v2(`Bulk ${i}`, [header('X-Bulk', String(i).repeat(20)), header('Authorization', 'Bearer ' + 'abc'.repeat(30))]));
    for (let round = 0; round < 24; round++) await chrome.storage.local.set({ [`filler${round}`]: many });
  },
  async read() { return chrome.storage.local.get(null).then(d => Object.keys(d).sort()); },
};
