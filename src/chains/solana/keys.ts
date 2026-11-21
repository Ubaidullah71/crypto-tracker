import { createHash } from 'node:crypto';
import { BTC_ALPHABET, base58Decode } from '../../core/encoding.ts';

/** Classic SPL Token program (USDT and USDC both live here, not in Token-2022). */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
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
  let out = BTC_ALPHABET[0]!.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BTC_ALPHABET[digits[i]!]!;
  return out;
}

/** Decodes a base58 Solana public key; null unless it is exactly 32 bytes. */
export function decodePublicKey(address: string): Uint8Array | null {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return null;
  const raw = base58Decode(address);
  return raw && raw.length === 32 ? raw : null;
}

export function isValidSolanaAddress(address: string): boolean {
  return decodePublicKey(address) !== null;
}

/** Shortened address or signature for logs (privacy): first 8 + last 4 characters. */
export function short(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

/** Transaction signatures are 64 bytes (base58: 64..88 chars). */
export function isValidSignature(sig: string): boolean {
  if (typeof sig !== 'string' || sig.length < 64 || sig.length > 90) return false;
  const raw = base58Decode(sig);
  return raw !== null && raw.length === 64;
}

// --- Program derived addresses ---

const P = 2n ** 255n - 19n;
// Edwards d = -121665 / 121666 mod p
const D = (P - ((121665n * modPow(121666n, P - 2n, P)) % P)) % P;

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/**
 * True when the 32 bytes decompress to a point on the ed25519 curve (same rule as
 * curve25519-dalek's CompressedEdwardsY::decompress: y = low 255 bits mod p, valid when
 * (y^2 - 1) / (d*y^2 + 1) is a square mod p).
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  y &= (1n << 255n) - 1n;
  y %= P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  if (u === 0n) return true;
  const x2 = (u * modPow(v, P - 2n, P)) % P;
  return modPow(x2, (P - 1n) / 2n, P) === 1n;
}

/** Solana's findProgramAddress: the first bump (255 -> 0) whose hash is off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  const program = decodePublicKey(programId);
  if (!program) throw new Error(`Invalid program id: ${programId}`);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update('ProgramDerivedAddress');
    const digest = new Uint8Array(h.digest());
    if (!isOnCurve(digest)) return { address: base58Encode(digest), bump };
  }
  throw new Error('Unable to find a viable program address bump seed');
}

const ataCache = new Map<string, string>();

/** Associated token account address of `owner` for `mint` (classic Token program by default). */
export function deriveAssociatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM_ID): string {
  const key = `${owner}:${mint}:${tokenProgram}`;
  const hit = ataCache.get(key);
  if (hit) return hit;
  const o = decodePublicKey(owner);
  const m = decodePublicKey(mint);
  const t = decodePublicKey(tokenProgram);
  if (!o || !m || !t) throw new Error('Invalid owner/mint/program for ATA derivation');
  const { address } = findProgramAddress([o, t, m], ASSOCIATED_TOKEN_PROGRAM_ID);
  if (ataCache.size > 5000) ataCache.clear();
  ataCache.set(key, address);
  return address;
}
