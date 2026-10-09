/**
 * Snappy block decompression (the raw format LevelDB uses for table blocks).
 * https://github.com/google/snappy/blob/main/format_description.txt
 */
export function snappyDecompress(src: Uint8Array): Uint8Array {
  let pos = 0;
  let length = 0;
  for (let shift = 0; ; shift += 7) {
    if (pos >= src.length || shift > 28) throw new Error('snappy: bad length');
    const b = src[pos++];
    length += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) break;
  }

  const out = new Uint8Array(length);
  let op = 0;
  while (pos < src.length) {
    const tag = src[pos++];
    const kind = tag & 3;
    if (kind === 0) {
      // literal
      let n = tag >>> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let i = 0; i < bytes; i++) n += src[pos++] * 2 ** (8 * i);
      }
      n += 1;
      if (pos + n > src.length || op + n > length) throw new Error('snappy: literal out of range');
      out.set(src.subarray(pos, pos + n), op);
      pos += n;
      op += n;
      continue;
    }
    let n: number;
    let offset: number;
    if (kind === 1) {
      n = ((tag >>> 2) & 7) + 4;
      offset = ((tag >>> 5) << 8) | src[pos++];
    } else if (kind === 2) {
      n = (tag >>> 2) + 1;
      offset = src[pos] | (src[pos + 1] << 8);
      pos += 2;
    } else {
      n = (tag >>> 2) + 1;
      offset = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
      pos += 4;
    }
    if (offset === 0 || offset > op || op + n > length) throw new Error('snappy: copy out of range');
    // Byte by byte: the source and destination may overlap (run-length style copies).
    for (let i = 0; i < n; i++, op++) out[op] = out[op - offset];
  }
  if (op !== length) throw new Error('snappy: length mismatch');
  return out;
}
