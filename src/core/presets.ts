import { newId, type HeaderMod, type HeaderOp, type Profile } from './model.ts';

type PresetHeader = { name: string; value?: string; op?: HeaderOp };

export interface Preset {
  id: string;
  label: string;
  request?: PresetHeader[];
  response?: PresetHeader[];
}

// The things people set most, one click each.
export const PRESETS: Preset[] = [
  { id: 'cors', label: 'CORS: allow any origin', response: [
    { name: 'Access-Control-Allow-Origin', value: '*' },
    { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, DELETE, OPTIONS' },
    { name: 'Access-Control-Allow-Headers', value: '*' },
  ] },
  { id: 'no-csp', label: 'Remove Content-Security-Policy', response: [
    { name: 'Content-Security-Policy', op: 'remove' },
    { name: 'Content-Security-Policy-Report-Only', op: 'remove' },
  ] },
  { id: 'iframe', label: 'Allow the site in an iframe', response: [
    { name: 'X-Frame-Options', op: 'remove' },
    { name: 'Content-Security-Policy', op: 'remove' },
  ] },
  { id: 'bearer', label: 'Authorization: Bearer token', request: [{ name: 'Authorization', value: 'Bearer ' }] },
  { id: 'no-cache', label: 'No cache', request: [
    { name: 'Cache-Control', value: 'no-cache' },
    { name: 'Pragma', value: 'no-cache' },
  ] },
  { id: 'mobile', label: 'User-Agent: iPhone', request: [{ name: 'User-Agent', value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }] },
  { id: 'googlebot', label: 'User-Agent: Googlebot', request: [{ name: 'User-Agent', value: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }] },
  { id: 'xff', label: 'X-Forwarded-For: test IP', request: [{ name: 'X-Forwarded-For', value: '203.0.113.7' }] },
  { id: 'lang', label: 'Accept-Language: English', request: [{ name: 'Accept-Language', value: 'en-US,en;q=0.9' }] },
];

// Suggestions for the header name fields.
export const REQUEST_HEADER_NAMES = [
  'Accept', 'Accept-Language', 'Authorization', 'Cache-Control', 'Cookie', 'DNT', 'Forwarded', 'If-None-Match',
  'Origin', 'Pragma', 'Referer', 'User-Agent', 'X-Api-Key', 'X-Correlation-Id', 'X-Forwarded-For',
  'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP', 'X-Request-Id', 'X-Requested-With',
];
export const RESPONSE_HEADER_NAMES = [
  'Access-Control-Allow-Credentials', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Methods',
  'Access-Control-Allow-Origin', 'Access-Control-Expose-Headers', 'Cache-Control', 'Content-Security-Policy',
  'Content-Security-Policy-Report-Only', 'Content-Type', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy', 'Location', 'Permissions-Policy', 'Referrer-Policy', 'Set-Cookie',
  'Strict-Transport-Security', 'Vary', 'X-Content-Type-Options', 'X-Frame-Options',
];

/**
 * Adds headers to a profile. A header with the same name in the same list is
 * updated rather than duplicated, and an empty placeholder row is reused.
 */
export function addHeaders(list: HeaderMod[], headers: PresetHeader[]): void {
  for (const h of headers) {
    const op = h.op ?? 'set';
    const value = op === 'remove' ? '' : h.value ?? '';
    const same = list.find(x => x.name.trim().toLowerCase() === h.name.toLowerCase());
    const blank = list.find(x => x.name.trim() === '' && x.value === '');
    const target = same ?? blank;
    if (target) Object.assign(target, { name: h.name, value, op, enabled: true });
    else list.push({ id: newId(), enabled: true, name: h.name, value, op });
  }
}

export function applyPreset(p: Profile, preset: Preset): void {
  addHeaders(p.requestHeaders, preset.request ?? []);
  addHeaders(p.responseHeaders, preset.response ?? []);
}
