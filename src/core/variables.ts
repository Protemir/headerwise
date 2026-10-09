import type { DnrRule } from './dnr.ts';

/*
 * {{variables}} in header values. Chrome applies fixed values, so these are
 * filled in when the rules are built (on every edit) and refreshed by the
 * background script every minute: requests within that minute share a value.
 */

export const VARIABLES: { name: string; hint: string }[] = [
  { name: 'uuid', hint: 'a random UUID' },
  { name: 'timestamp', hint: 'milliseconds since 1970' },
  { name: 'unix', hint: 'seconds since 1970' },
  { name: 'iso', hint: 'date and time, ISO 8601, UTC' },
  { name: 'date', hint: 'YYYY-MM-DD, UTC' },
  { name: 'random', hint: 'a random whole number' },
];

const PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/gi;
const KNOWN = new Set(VARIABLES.map(v => v.name));

export interface VariableSource {
  now: Date;
  uuid: () => string;
  random: () => number; // 0 <= x < 1
}

export function systemSource(): VariableSource {
  return { now: new Date(), uuid: () => globalThis.crypto.randomUUID(), random: Math.random };
}

/** Names in {{...}} that Headerwise doesn't know; such text is sent as is. */
export function unknownVariables(value: string): string[] {
  return [...value.matchAll(PATTERN)].map(m => m[1]).filter(n => !KNOWN.has(n.toLowerCase()));
}

export function hasVariables(value: string): boolean {
  return [...value.matchAll(PATTERN)].some(m => KNOWN.has(m[1].toLowerCase()));
}

export function fillValue(value: string, src: VariableSource): string {
  return value.replace(PATTERN, (whole, raw: string) => {
    switch (raw.toLowerCase()) {
      case 'uuid': return src.uuid();
      case 'timestamp': return String(src.now.getTime());
      case 'unix': return String(Math.floor(src.now.getTime() / 1000));
      case 'iso': return src.now.toISOString();
      case 'date': return src.now.toISOString().slice(0, 10);
      case 'random': return String(Math.floor(src.random() * 2 ** 31));
      default: return whole;
    }
  });
}

export function rulesHaveVariables(rules: DnrRule[]): boolean {
  return rules.some(r => r.action.type === 'modifyHeaders'
    && [...(r.action.requestHeaders ?? []), ...(r.action.responseHeaders ?? [])].some(h => h.value !== undefined && hasVariables(h.value)));
}

/** Copies of the rules with every {{variable}} filled in. */
export function fillRules(rules: DnrRule[], src: VariableSource): DnrRule[] {
  return rules.map(r => {
    if (r.action.type !== 'modifyHeaders') return r;
    const fill = (list?: { header: string; operation: 'set' | 'remove' | 'append'; value?: string }[]) =>
      list?.map(h => (h.value === undefined ? h : { ...h, value: fillValue(h.value, src) }));
    return {
      ...r,
      action: {
        ...r.action,
        ...(r.action.requestHeaders ? { requestHeaders: fill(r.action.requestHeaders) } : {}),
        ...(r.action.responseHeaders ? { responseHeaders: fill(r.action.responseHeaders) } : {}),
      },
    };
  });
}
