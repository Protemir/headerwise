import en from '../../public/_locales/en/messages.json' with { type: 'json' };

/*
 * The UI text, in the browser's language. Messages live in public/_locales/<lang>/
 * messages.json, Chrome's own format, so the browser picks the language and falls
 * back to English for anything a translation lacks. {name} in a message is filled
 * in here; Chrome's own $1 substitutions aren't used.
 * Outside the browser (tests) the English file is read directly.
 */

export type MessageKey = keyof typeof en;
type Vars = Record<string, string | number>;

function raw(key: string): string {
  const fromBrowser = globalThis.chrome?.i18n?.getMessage?.(key);
  if (fromBrowser) return fromBrowser;
  // As Chrome does: "$$" in a message is a literal "$".
  return ((en as Record<string, { message: string }>)[key]?.message ?? '').replace(/\$\$/g, '$');
}

function fill(text: string, vars?: Vars): string {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

export function t(key: MessageKey, vars?: Vars): string {
  return fill(raw(key) || key, vars);
}

/** The UI language, for plural rules: "1 profile, 2 profiles" is not how every language counts. */
export function uiLanguage(): string {
  return globalThis.chrome?.i18n?.getUILanguage?.() ?? 'en';
}

/**
 * A count with its plural form: messages key_one, key_few, key_many, key_other as
 * the language needs them (English: _one and _other; Russian: _one, _few, _many).
 * {n} in the message is the count.
 */
export function tn(key: string, n: number, vars?: Vars): string {
  const form = new Intl.PluralRules(uiLanguage()).select(n);
  const text = raw(`${key}_${form}`) || raw(`${key}_other`) || key;
  return fill(text, { n, ...vars });
}
