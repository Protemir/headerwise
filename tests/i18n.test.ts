import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { expect } from './expect.ts';
import { t, tn } from '../src/core/i18n.ts';
import { toDnrRules } from '../src/core/dnr.ts';
import { importProfiles } from '../src/core/export.ts';

// Every translation has every message, with the same {placeholders}, and the
// plural forms its language needs. A missing key would fall back to English in
// the middle of a translated popup; a lost {n} would show a sentence without its number.

type Messages = Record<string, { message: string }>;
const dir = new URL('../public/_locales/', import.meta.url);
const read = (lang: string): Messages => JSON.parse(readFileSync(new URL(`${lang}/messages.json`, dir), 'utf8'));
const en = read('en');
const langs = readdirSync(dir).filter(l => l !== 'en');
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const PLURAL = /_(one|two|few|many|other|zero)$/;
// The forms each language's plural rules use for whole numbers.
const forms = (lang: string) => [...new Set([0, 1, 2, 3, 5, 11, 21, 22, 25, 100, 101, 1000000].map(n => new Intl.PluralRules(lang.replace('_', '-')).select(n)))];

describe('translations', () => {
  it('cover the languages the store listing has', () => {
    expect(langs.sort()).toEqual(['de', 'es', 'fr', 'ja', 'pt_BR', 'ru', 'zh_CN']);
  });

  for (const lang of langs) {
    it(`${lang}: every message, same placeholders, the plural forms it needs, no stray $`, () => {
      const m = read(lang);
      const problems: string[] = [];
      for (const [key, { message }] of Object.entries(en)) {
        if (PLURAL.test(key)) continue;
        if (!m[key]?.message) problems.push(`missing ${key}`);
        else if (placeholders(m[key].message) !== placeholders(message)) problems.push(`placeholders differ in ${key}: ${m[key].message}`);
      }
      const families = [...new Set(Object.keys(en).filter(k => PLURAL.test(k)).map(k => k.replace(PLURAL, '')))];
      for (const base of families) {
        for (const form of forms(lang)) {
          const own = m[`${base}_${form}`]?.message ?? m[`${base}_other`]?.message;
          if (!own) problems.push(`missing ${base}_${form}`);
          else if (placeholders(own) !== placeholders(en[`${base}_other`].message)) problems.push(`placeholders differ in ${base}_${form}: ${own}`);
        }
      }
      for (const [key, { message }] of Object.entries(m)) {
        if (!(key in en) && !PLURAL.test(key)) problems.push(`unknown key ${key}`);
        // Chrome reads $1..$9 as substitutions: a literal $ must be written $$.
        if (/\$(?!\$)/.test(message.replace(/\$\$/g, ''))) problems.push(`single $ in ${key}`);
      }
      expect(problems).toEqual([]);
    });
  }

  it('fills placeholders and picks plural forms (English here)', () => {
    expect(t('profileN', { n: 3 })).toBe('Profile 3');
    expect([tn('imported', 1), tn('imported', 4)]).toEqual(['Imported 1 profile.', 'Imported 4 profiles.']);
    expect(t('redirectToRegexPlaceholder')).toBe('e.g. /v$1-beta/');
  });

  it('warnings from the engine and the importers come in the browser\'s language', () => {
    const ru = read('ru');
    const g = globalThis as { chrome?: unknown };
    g.chrome = { i18n: { getMessage: (k: string) => ru[k]?.message.replace(/\$\$/g, '$') ?? '', getUILanguage: () => 'ru' } };
    try {
      const bad = { id: 'h', enabled: true, name: 'Bad Name', value: 'v', op: 'set' as const };
      const out = toDnrRules({ version: 1, paused: false, profiles: [{ id: 'p', title: 'Тест', enabled: true, requestHeaders: [bad], responseHeaders: [], filters: [] }] });
      expect(out.warnings).toEqual([fill(ru.w_badHeaderName.message, { where: fill(ru.w_requestHeader.message, { profile: 'Тест', name: 'Bad Name' }) })]);
      // the automation page goes by this, not by the text
      expect(out.lost).toEqual(['p']);
      expect(importProfiles('{').warnings).toEqual([ru.imp_notJson.message]);
      expect(importProfiles('[]').warnings).toEqual([ru.imp_noProfiles.message]);
    } finally {
      delete g.chrome;
    }
  });
});

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
