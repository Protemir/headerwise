// CRX3 packing, for Selenium's addExtensions and cloud grids that take a base64
// .crx (ChromeDriver checks the signature and takes the id from the key).
//
//   "Cr24" | u32 version 3 | u32 header size | CrxFileHeader (protobuf) | zip
//
// The header holds the public key, an RSA-SHA256 signature and SignedData
// { crx_id: first 16 bytes of sha256(public key) }. The signature covers
// "CRX3 SignedData\0" | u32 size of SignedData | SignedData | zip.
import { createHash, createPublicKey, createSign, createVerify } from 'node:crypto';

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const varint = n => { const out = []; while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; } out.push(n); return Buffer.from(out); };
const field = (number, bytes) => Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
const PREFIX = Buffer.from('CRX3 SignedData\x00', 'binary');

function signedPart(signedData, zipBytes) {
  return Buffer.concat([PREFIX, u32(signedData.length), signedData, zipBytes]);
}

/** privateKey: a PEM string or KeyObject. Returns the .crx bytes. */
export function packCrx(zipBytes, privateKey) {
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const crxId = createHash('sha256').update(publicDer).digest().subarray(0, 16);
  const signedData = field(1, crxId);
  const signature = createSign('sha256').update(signedPart(signedData, zipBytes)).sign(privateKey);
  const proof = Buffer.concat([field(1, publicDer), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10000, signedData)]);
  return Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, zipBytes]);
}

// --- reading, for the tests: just enough protobuf for these three messages
function fields(buf) {
  const out = [];
  let at = 0;
  const read = () => { let n = 0, shift = 0, b; do { b = buf[at++]; n += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return n; };
  while (at < buf.length) {
    const tag = read();
    if ((tag & 7) !== 2) throw new Error('unexpected wire type');
    const len = read();
    out.push({ number: Math.floor(tag / 8), bytes: buf.subarray(at, at + len) });
    at += len;
  }
  return out;
}

/** Checks a .crx the way ChromeDriver does; returns { id, zip } or throws. */
export function readCrx(crx) {
  if (crx.subarray(0, 4).toString() !== 'Cr24' || crx.readUInt32LE(4) !== 3) throw new Error('not a CRX3 file');
  const size = crx.readUInt32LE(8);
  const header = fields(crx.subarray(12, 12 + size));
  const zipBytes = crx.subarray(12 + size);
  const signedData = header.find(f => f.number === 10000).bytes;
  const crxId = fields(signedData).find(f => f.number === 1).bytes;
  for (const proof of header.filter(f => f.number === 2)) {
    const [key, sig] = [1, 2].map(n => fields(proof.bytes).find(f => f.number === n).bytes);
    const hash = createHash('sha256').update(key).digest();
    if (!hash.subarray(0, 16).equals(crxId)) continue;
    const publicKey = createPublicKey({ key, format: 'der', type: 'spki' });
    if (!createVerify('sha256').update(signedPart(signedData, zipBytes)).verify(publicKey, sig)) throw new Error('bad signature');
    const id = [...hash.toString('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
    return { id, zip: zipBytes, publicKey: key.toString('base64') };
  }
  throw new Error('no proof for the crx id');
}
