import { createHash } from 'node:crypto';

export const BTC_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const XRP_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

/** Decodes base58 with the given alphabet. Returns null on invalid characters. */
export function base58Decode(input: string, alphabet: string = BTC_ALPHABET): Uint8Array | null {
  if (input.length === 0 || input.length > 128) return null;
  const map = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) map.set(alphabet[i]!, i);
  const bytes: number[] = [0];
  for (const ch of input) {
    const v = map.get(ch);
    if (v === undefined) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading "zero" characters map to leading zero bytes.
  const zero = alphabet[0]!;
  let leading = 0;
  while (leading < input.length && input[leading] === zero) leading++;
  // Strip the accumulator's own leading zero bytes, then add one per leading zero char.
  while (bytes.length > 1 && bytes[bytes.length - 1] === 0) bytes.pop();
  const body = bytes.reverse();
  const isZero = body.length === 1 && body[0] === 0;
  const out = new Uint8Array(leading + (isZero ? 0 : body.length));
  out.set(isZero ? [] : body, leading);
  return out;
}

export function base58Encode(bytes: Uint8Array, alphabet: string = BTC_ALPHABET): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = []; // little-endian base58 digits
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return (
    alphabet[0]!.repeat(zeros) +
    digits
      .reverse()
      .map((d) => alphabet[d])
      .join('')
  );
}

export function base58CheckEncode(payload: Uint8Array, alphabet: string = BTC_ALPHABET): string {
  const checksum = sha256d(payload).subarray(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload);
  full.set(checksum, payload.length);
  return base58Encode(full, alphabet);
}

export function sha256d(data: Uint8Array): Buffer {
  return createHash('sha256').update(createHash('sha256').update(data).digest()).digest();
}

/** Decodes base58check. Returns payload (version byte included) or null if checksum fails. */
export function base58CheckDecode(input: string, alphabet: string = BTC_ALPHABET): Uint8Array | null {
  const raw = base58Decode(input, alphabet);
  if (!raw || raw.length < 5) return null;
  const payload = raw.subarray(0, raw.length - 4);
  const checksum = raw.subarray(raw.length - 4);
  const expected = sha256d(payload).subarray(0, 4);
  for (let i = 0; i < 4; i++) if (checksum[i] !== expected[i]) return null;
  return payload;
}

// --- bech32 ---

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

export type Bech32Variant = 'bech32' | 'bech32m';

export function bech32Decode(input: string): { hrp: string; data: number[]; variant: Bech32Variant } | null {
  if (input.length < 8 || input.length > 90) return null;
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) return null;
  const s = input.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return null;
  const hrp = s.slice(0, pos);
  const data: number[] = [];
  for (const c of s.slice(pos + 1)) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v === -1) return null;
    data.push(v);
  }
  const check = polymod([...hrpExpand(hrp), ...data]);
  const variant: Bech32Variant | null = check === 1 ? 'bech32' : check === 0x2bc830a3 ? 'bech32m' : null;
  if (!variant) return null;
  return { hrp, data: data.slice(0, -6), variant };
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || (acc << (to - bits)) & maxv) {
    return null;
  }
  return out;
}

/** Decodes a segwit address for the given HRP. Returns witness version + program, or null. */
export function decodeSegwit(hrp: string, address: string): { version: number; program: number[] } | null {
  const dec = bech32Decode(address);
  if (!dec || dec.hrp !== hrp || dec.data.length < 1) return null;
  const version = dec.data[0]!;
  if (version > 16) return null;
  const program = convertBits(dec.data.slice(1), 5, 8, false);
  if (!program || program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  if (version === 0 && dec.variant !== 'bech32') return null;
  if (version !== 0 && dec.variant !== 'bech32m') return null;
  return { version, program };
}
