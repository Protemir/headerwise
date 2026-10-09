import { importProfiles } from './export.ts';
import { newId, type HeaderMod, type State } from './model.ts';

/*
 * The automation page, for Selenium, Playwright and Puppeteer (the automation
 * build has a fixed extension id, see scripts/automation.mjs):
 *
 *   chrome-extension://<id>/automation.html?X-Env=staging&res:Access-Control-Allow-Origin=*
 *
 *   Name=Value       set a request header (an empty value removes the header)
 *   res:Name=Value   the same for a response header
 *   @url=pattern     only on matching URLs (Chrome's urlFilter syntax, repeatable)
 *   @add             keep the headers earlier calls set, add these to them
 *   @clear           drop the Automation profile (alone: no headers at all)
 *   @import=json     replace all profiles with a Headerwise or ModHeader export
 *   (nothing)        change nothing, just show what is in effect
 *
 * Each call replaces the "Automation" profile (unless @add), so a test gets exactly
 * the headers it asked for. Names can't contain ":" or "@", so these never clash.
 *
 * ModHeader's webdriver URLs (webdriver.modheader.com/add, /clear, /load?profile=)
 * are redirected here by the automation build, see modheaderRules in
 * scripts/automation.mjs.
 */

export const AUTOMATION_ID = 'automation';

// RFC 9110 token: what a header name may be made of.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export interface AutomationResult {
  state?: State;
  error?: string;
  /** What is in effect now, one line each, for the page and the test log. */
  summary: string[];
  warnings: string[];
}

export function applyQuery(state: State, query: string): AutomationResult {
  const params = [...new URLSearchParams(query)];
  // Opening the page without anything just shows what is in effect.
  if (!params.length) return { summary: summarize(state), warnings: [] };
  const warnings: string[] = [];
  const next: State = structuredClone(state);
  next.paused = false;

  const imported = params.filter(([k]) => k === '@import');
  if (imported.length > 1) return fail('Use @import once per call.');
  if (imported.length) {
    const got = importProfiles(imported[0][1]);
    if (!got.profiles.length) return fail(`@import: ${got.warnings.join(' ') || 'no profiles in it'}`);
    next.profiles = got.profiles;
    warnings.push(...got.warnings);
  }

  // @add keeps what earlier calls set (a header of the same name is replaced).
  const add = params.some(([k]) => k === '@add');
  const before = add ? state.profiles.find(p => p.id === AUTOMATION_ID) : undefined;
  const request: HeaderMod[] = structuredClone(before?.requestHeaders ?? []);
  const response: HeaderMod[] = structuredClone(before?.responseHeaders ?? []);
  const urls: string[] = [];
  let clear = false;
  for (const [key, value] of params) {
    if (key === '@import' || key === '@add' || key === '@modheader') continue;
    if (key === '@clear') { clear = true; continue; }
    if (key === '@url') {
      if (!value.trim()) return fail('@url is empty.');
      urls.push(value.trim());
      continue;
    }
    if (key.startsWith('@')) return fail(`Unknown option ${key}. Known: @url, @add, @clear, @import.`);
    const res = key.startsWith('res:');
    const name = res ? key.slice(4) : key;
    if (!TOKEN.test(name)) return fail(`"${name}" is not a valid header name.`);
    const header: HeaderMod = { id: newId(), enabled: true, name, value, op: value === '' ? 'remove' : 'set' };
    const list = res ? response : request;
    const same = list.findIndex(h => h.name.toLowerCase() === name.toLowerCase());
    if (add && same >= 0) list[same] = header;
    else list.push(header);
  }
  if (clear && (add || request.length || response.length || urls.length)) return fail('@clear goes alone (or with @import).');
  if (urls.length && !request.length && !response.length) return fail('@url needs at least one header.');
  // @add without its own @url keeps the earlier URL filters.
  const filters = urls.length || !before
    ? urls.map(pattern => ({ id: newId(), enabled: true, kind: 'include' as const, pattern, isRegex: false }))
    : before.filters;

  next.profiles = next.profiles.filter(p => p.id !== AUTOMATION_ID);
  if (request.length || response.length) {
    next.profiles.unshift({
      id: AUTOMATION_ID,
      title: 'Automation',
      enabled: true,
      requestHeaders: request,
      responseHeaders: response,
      filters,
    });
  } else if (!imported.length) {
    // @clear: no headers at all, so the test starts from a clean browser.
    for (const p of next.profiles) p.enabled = false;
  }

  return { state: next, summary: summarize(next), warnings };

  function fail(error: string): AutomationResult {
    return { error, summary: summarize(state), warnings: [] };
  }
}

export function summarize(state: State): string[] {
  if (state.paused) return ['paused'];
  return state.profiles.filter(p => p.enabled).flatMap(p => [
    ...p.requestHeaders.filter(h => h.enabled && h.name).map(h => `${p.title}: ${h.op} ${h.name}`),
    ...p.responseHeaders.filter(h => h.enabled && h.name).map(h => `${p.title}: ${h.op} response ${h.name}`),
  ]);
}
