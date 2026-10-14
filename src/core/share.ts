import { t } from './i18n.ts';
import { EXPORT_FORMAT, exportProfiles, importProfiles } from './export.ts';
import type { ImportResult } from './import-modheader.ts';
import type { Profile } from './model.ts';

/*
 * Share links: https://protemir.github.io/headerwise/share#1.<data>, where <data> is
 * a Headerwise export without secret values, deflated and written in base64url.
 * The profiles travel in the part after "#", which browsers never send to the
 * server: the share page (docs/share.html) reads it in the browser, shows what is
 * inside and hands the link to the extension with one click. Pasted into "Import
 * JSON", the link works too. Profiles from a link come in switched off: whoever
 * made the link decides what they hold, the person opening it decides to use it.
 */

export const SHARE_PAGE = 'https://protemir.github.io/headerwise/share';
const VERSION = '1.';
// Anywhere in the text: pasted from a chat it may have words, brackets or a full stop around it.
const LINK = /https?:\/\/[^\s#]{1,300}?\/share(?:\.html)?\/?(?:\?[^#\s]{0,300})?#1\.([A-Za-z0-9_-]*)/;
// A link is pasted into chats and issues; and a small link must not unpack into
// something huge.
export const MAX_LINK = 200_000;
export const MAX_UNPACKED = 5_000_000;

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('too large'); }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const pack = (text: string) => readAll(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw')), Infinity);
const unpack = (bytes: Uint8Array) => readAll(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')), MAX_UNPACKED);

// Ids are made afresh on import, so the link doesn't carry them.
const withoutIds = (key: string, value: unknown) => (key === 'id' ? undefined : value);

/** A link holding these profiles, secret values left out; undefined if too big to open. */
export async function shareLink(profiles: Profile[]): Promise<string | undefined> {
  const json = JSON.stringify(JSON.parse(exportProfiles(profiles)), withoutIds);
  if (new TextEncoder().encode(json).length > MAX_UNPACKED) return undefined;
  const link = `${SHARE_PAGE}#${VERSION}${base64url(await pack(json))}`;
  return link.length > MAX_LINK ? undefined : link;
}

/** Whether the text is a share link (not whether it is a good one). */
export function isShareLink(text: string): boolean {
  return text.length <= MAX_LINK + 1000 && LINK.test(text);
}

/** The profiles in a share link, switched off; undefined if the text isn't one. */
export async function importShareLink(text: string): Promise<ImportResult | undefined> {
  const m = text.length <= MAX_LINK + 1000 ? LINK.exec(text) : null;
  if (!m) return undefined;
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(await unpack(fromBase64url(m[1])));
    if ((JSON.parse(json) as { format?: unknown })?.format !== EXPORT_FORMAT) throw new Error('not a Headerwise export');
  } catch {
    return { profiles: [], warnings: [t('shareLinkBroken')] };
  }
  const res = importProfiles(json);
  if (!res.profiles.length) return res;
  for (const p of res.profiles) p.enabled = false;
  return { profiles: res.profiles, warnings: [t('sharedOff'), ...res.warnings] };
}
