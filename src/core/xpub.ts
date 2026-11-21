/**
 * Extended public keys (xpub / ypub / zpub / Ltub / Mtub): one read-only key from which a
 * wallet derives all of its receive and change addresses (BIP32). Tracking it covers a whole
 * Ledger / Trezor / Electrum account instead of a single address.
 *
 * Blockbook indexes them directly with output descriptors (pkh / sh(wpkh) / wpkh / tr), so no
 * address derivation happens locally.
 */
import { base58CheckDecode, base58CheckEncode } from './encoding.ts';

export type ScriptType = 'pkh' | 'sh-wpkh' | 'wpkh' | 'tr';

export const SCRIPT_LABEL: Record<ScriptType, string> = {
  pkh: 'Legacy',
  'sh-wpkh': 'Nested SegWit',
  wpkh: 'Native SegWit',
  tr: 'Taproot',
};

interface VersionInfo {
  prefix: string;
  network: 'bitcoin' | 'litecoin' | 'any';
  /** Fixed script type, or null when the prefix does not say (Ledger shows "xpub" for every type). */
  type: ScriptType | null;
}

const VERSIONS: Record<number, VersionInfo> = {
  0x0488b21e: { prefix: 'xpub', network: 'any', type: null },
  0x049d7cb2: { prefix: 'ypub', network: 'any', type: 'sh-wpkh' },
  0x04b24746: { prefix: 'zpub', network: 'any', type: 'wpkh' },
  0x019da462: { prefix: 'Ltub', network: 'litecoin', type: null },
  0x01b26ef6: { prefix: 'Mtub', network: 'litecoin', type: 'sh-wpkh' },
};

const XPUB_VERSION = 0x0488b21e;

export interface ExtendedKey {
  /** As the user entered it. */
  original: string;
  prefix: string;
  network: 'bitcoin' | 'litecoin' | 'any';
  type: ScriptType | null;
  /** Same key re-encoded with the standard xpub version bytes (what descriptors expect). */
  xpub: string;
  depth: number;
}

const EXT_RE = /^(xpub|ypub|zpub|Ltub|Mtub)[1-9A-HJ-NP-Za-km-z]{100,112}$/;

/** Validates an extended public key (checksum, length, version, compressed public key). */
export function parseExtendedKey(input: string): ExtendedKey | null {
  const s = input.trim();
  if (!EXT_RE.test(s)) return null;
  const payload = base58CheckDecode(s);
  if (!payload || payload.length !== 78) return null;
  const version = ((payload[0]! << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!) >>> 0;
  const info = VERSIONS[version];
  if (!info) return null;
  const keyPrefix = payload[45];
  if (keyPrefix !== 0x02 && keyPrefix !== 0x03) return null; // private keys start with 0x00
  const normalized = new Uint8Array(payload);
  normalized[0] = (XPUB_VERSION >>> 24) & 0xff;
  normalized[1] = (XPUB_VERSION >>> 16) & 0xff;
  normalized[2] = (XPUB_VERSION >>> 8) & 0xff;
  normalized[3] = XPUB_VERSION & 0xff;
  return {
    original: s,
    prefix: info.prefix,
    network: info.network,
    type: info.type,
    xpub: base58CheckEncode(normalized),
    depth: payload[4]!,
  };
}

export function isExtendedKey(s: string): boolean {
  return parseExtendedKey(s) !== null;
}

/** Blockbook output descriptor for a key and script type (receive and change chains). */
export function descriptorFor(k: ExtendedKey, type: ScriptType): string {
  switch (type) {
    case 'pkh':
      return `pkh(${k.xpub})`;
    case 'sh-wpkh':
      return `sh(wpkh(${k.xpub}))`;
    case 'wpkh':
      return `wpkh(${k.xpub})`;
    case 'tr':
      return `tr(${k.xpub})`;
  }
}

/** True for strings that must be queried through Blockbook's /xpub endpoint. */
export function isXpubQuery(s: string): boolean {
  return /^(pkh|sh|wpkh|tr)\(/.test(s) || EXT_RE.test(s);
}

/** Script types worth probing for a key on a network, most likely first. */
export function candidateTypes(k: ExtendedKey, network: 'bitcoin' | 'litecoin'): ScriptType[] {
  if (k.type) return [k.type];
  // Ledger Live / Trezor default to Native SegWit for new accounts; Taproot exists on Bitcoin only.
  return network === 'bitcoin' ? ['wpkh', 'tr', 'sh-wpkh', 'pkh'] : ['wpkh', 'sh-wpkh', 'pkh'];
}

/** "xpub6CUG...h7Dk" for display. */
export function shortKey(s: string): string {
  return s.length > 20 ? `${s.slice(0, 8)}...${s.slice(-4)}` : s;
}
