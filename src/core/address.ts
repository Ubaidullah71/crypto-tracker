import { base58CheckDecode, base58Decode, decodeSegwit, XRP_ALPHABET } from './encoding.ts';
import { keccak256Hex } from './keccak.ts';
import { parseExtendedKey, SCRIPT_LABEL } from './xpub.ts';
import { EVM_NETWORKS, type NetworkFamily, type NetworkId } from './networks.ts';

export interface AddressCandidate {
  family: NetworkFamily;
  /** Networks this address can be tracked on. */
  networks: NetworkId[];
  /** Normalized form to store (EVM: EIP-55 checksum). */
  address: string;
  /** Human description, e.g. "Bitcoin (Native SegWit)". */
  description: string;
  /** Extended public key (tracks every address of a wallet account). */
  xpub?: boolean;
  /** Chosen when several candidates remain and nothing else decides (xpub defaults to Bitcoin). */
  preferred?: boolean;
}

export type AddressDetection =
  | { kind: 'address'; candidates: AddressCandidate[] }
  | { kind: 'secret'; reason: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'invalid'; reason: string };

// --- EVM ---

export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = keccak256Hex(lower);
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    const c = lower[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

export function isValidEvmAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  // All-lowercase or all-uppercase carry no checksum; mixed case must match EIP-55.
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return toChecksumAddress(address) === address;
}

// --- secret detection ---

const MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24]);

/** Returns a reason when the input looks like a private key / seed phrase instead of an address. */
export function looksLikeSecret(input: string): string | null {
  const s = input.trim();
  const words = s.split(/\s+/);
  if (MNEMONIC_LENGTHS.has(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    return 'This looks like a recovery (seed) phrase.';
  }
  if (/^(xprv|yprv|zprv|tprv|uprv|vprv|Ltpv|Mtpv)[1-9A-HJ-NP-Za-km-z]{100,}$/.test(s)) {
    return 'This looks like an extended private key.';
  }
  if (/^\[\s*\d+(\s*,\s*\d+){63}\s*\]$/.test(s)) return 'This looks like a Solana secret key.';
  if (/^[1-9A-HJ-NP-Za-km-z]{51,52}$/.test(s)) {
    const p = base58CheckDecode(s);
    if (p && (p[0] === 0x80 || p[0] === 0xb0) && (p.length === 33 || p.length === 34)) {
      return 'This looks like a private key (WIF format).';
    }
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{86,90}$/.test(s)) {
    const raw = base58Decode(s);
    if (raw && raw.length === 64) return 'This looks like a Solana secret key.';
  }
  return null;
}

// --- detection ---

function detectUtxo(s: string): AddressCandidate[] {
  const out: AddressCandidate[] = [];
  const lower = s.toLowerCase();
  if (lower.startsWith('bc1')) {
    const w = decodeSegwit('bc', s);
    if (w) {
      const desc = w.version === 0 ? 'Native SegWit' : w.version === 1 ? 'Taproot' : `SegWit v${w.version}`;
      out.push({ family: 'utxo', networks: ['bitcoin'], address: lower, description: `Bitcoin (${desc})` });
    }
    return out;
  }
  if (lower.startsWith('ltc1')) {
    const w = decodeSegwit('ltc', s);
    if (w) {
      const desc = w.version === 0 ? 'Native SegWit' : w.version === 1 ? 'Taproot' : `SegWit v${w.version}`;
      out.push({ family: 'utxo', networks: ['litecoin'], address: lower, description: `Litecoin (${desc})` });
    }
    return out;
  }
  if (/^[13LM][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) {
    const p = base58CheckDecode(s);
    if (!p || p.length !== 21) return out;
    const v = p[0];
    if (v === 0x00) out.push({ family: 'utxo', networks: ['bitcoin'], address: s, description: 'Bitcoin (Legacy)' });
    if (v === 0x05) {
      out.push({ family: 'utxo', networks: ['bitcoin'], address: s, description: 'Bitcoin (Nested SegWit / P2SH)' });
      out.push({ family: 'utxo', networks: ['litecoin'], address: s, description: 'Litecoin (Legacy P2SH)' });
    }
    if (v === 0x30) out.push({ family: 'utxo', networks: ['litecoin'], address: s, description: 'Litecoin (Legacy)' });
    if (v === 0x32) out.push({ family: 'utxo', networks: ['litecoin'], address: s, description: 'Litecoin (P2SH)' });
  }
  return out;
}

function detectXrp(s: string): AddressCandidate | null {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s)) return null;
  const p = base58CheckDecode(s, XRP_ALPHABET);
  if (!p || p.length !== 21 || p[0] !== 0x00) return null;
  return { family: 'xrp', networks: ['xrp'], address: s, description: 'XRP Ledger account' };
}

function detectSolana(s: string): AddressCandidate | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return null;
  const raw = base58Decode(s);
  if (!raw || raw.length !== 32) return null;
  return { family: 'solana', networks: ['solana'], address: s, description: 'Solana account' };
}

/** Detects which network(s) an address belongs to, validating checksums. */
export function detectAddress(input: string): AddressDetection {
  const s = input.trim();
  if (!s) return { kind: 'invalid', reason: 'The address is empty.' };

  const secret = looksLikeSecret(s);
  if (secret) return { kind: 'secret', reason: secret };

  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) {
    return {
      kind: 'secret',
      reason: 'This is 64 hex characters: either a transaction hash or a private key, but not a wallet address.',
    };
  }
  if (/^(xpub|ypub|zpub|Ltub|Mtub)/.test(s)) {
    const k = parseExtendedKey(s);
    if (!k) return { kind: 'invalid', reason: 'This extended public key is not valid (wrong length or checksum). Copy it again.' };
    const type = k.type ? ` (${SCRIPT_LABEL[k.type]})` : '';
    const btc: AddressCandidate = {
      family: 'utxo',
      networks: ['bitcoin'],
      address: s,
      description: `Bitcoin account via ${k.prefix}${type}`,
      xpub: true,
      preferred: true,
    };
    const ltc: AddressCandidate = {
      family: 'utxo',
      networks: ['litecoin'],
      address: s,
      description: `Litecoin account via ${k.prefix}${type}`,
      xpub: true,
    };
    return { kind: 'address', candidates: k.network === 'litecoin' ? [{ ...ltc, preferred: true }] : [btc, ltc] };
  }
  if (/^(Ypub|Zpub|Vpub|Upub)/.test(s)) {
    return {
      kind: 'unsupported',
      reason: 'Multisig extended keys are not supported. Use the single-signature account key (xpub/ypub/zpub).',
    };
  }
  if (/^X[1-9A-HJ-NP-Za-km-z]{46}$/.test(s)) {
    return { kind: 'unsupported', reason: 'XRP X-addresses are not supported. Use the classic address starting with "r".' };
  }

  if (s.startsWith('0x') || s.startsWith('0X')) {
    const a = '0x' + s.slice(2);
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return { kind: 'invalid', reason: 'EVM addresses are 0x followed by 40 hex characters.' };
    if (!isValidEvmAddress(a))
      return { kind: 'invalid', reason: 'The EVM address checksum (upper/lower case pattern) is invalid. Check for typos.' };
    return {
      kind: 'address',
      candidates: [{ family: 'evm', networks: [...EVM_NETWORKS], address: toChecksumAddress(a), description: 'EVM address' }],
    };
  }

  const utxo = detectUtxo(s);
  if (utxo.length) return { kind: 'address', candidates: utxo };

  const xrp = detectXrp(s);
  if (xrp) return { kind: 'address', candidates: [xrp] };

  const sol = detectSolana(s);
  if (sol) return { kind: 'address', candidates: [sol] };

  return { kind: 'invalid', reason: 'This is not a valid BTC, LTC, EVM, Solana or XRP address (or the checksum is wrong).' };
}

/** Case-insensitive comparison for EVM and bech32, exact for everything else. */
export function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  if (/^0x/i.test(a) || /^(bc1|ltc1)/i.test(a)) return a.toLowerCase() === b.toLowerCase();
  return false;
}

/** Shortens an address for compact display: 0x28C6...1d60. */
export function shortAddress(a: string, head = 6, tail = 4): string {
  return a.length <= head + tail + 3 ? a : `${a.slice(0, head)}...${a.slice(-tail)}`;
}
