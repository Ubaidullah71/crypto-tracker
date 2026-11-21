/**
 * Pure parsers that turn untrusted Blockbook / Esplora JSON into the internal NormTx shape.
 * Every value is validated; malformed transactions throw MalformedDataError so the caller
 * can skip them individually (see parseTxList).
 */
import type { AddressMatcher, AddressSummary, NormInput, NormOutput, NormTx, ParsedTxList, TxLookup } from './types.ts';

export class MalformedDataError extends Error {
  override name = 'MalformedDataError';
}

const TXID_RE = /^[0-9a-fA-F]{64}$/;
/** Standard address characters only; excludes Blockbook pseudo-addresses like "OP_RETURN (...)". */
const ADDRESS_RE = /^[a-zA-Z0-9]{14,100}$/;
const BECH32_RE = /^(bc1|tb1|bcrt1|ltc1|tltc1|rltc1)/i;
/** Sanity cap far above the BTC/LTC supply (8.4e15 litoshis). */
const MAX_SATS = 10n ** 16n;
const SEQUENCE_FINAL_RBF = 0xfffffffe;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isTxid(v: unknown): v is string {
  return typeof v === 'string' && TXID_RE.test(v);
}

export function isPlausibleAddress(v: unknown): v is string {
  return typeof v === 'string' && ADDRESS_RE.test(v);
}

/** Integer in [min, max], or null. */
export function toInt(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : null;
}

/** Non-negative satoshi amount from a digit string (Blockbook) or a safe integer (Esplora). */
export function parseSats(v: unknown): bigint | null {
  try {
    let b: bigint;
    if (typeof v === 'string') {
      if (!/^\d{1,18}$/.test(v)) return null;
      b = BigInt(v);
    } else if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || v < 0) return null;
      b = BigInt(v);
    } else {
      return null;
    }
    return b <= MAX_SATS ? b : null;
  } catch {
    return null;
  }
}

/** Signed satoshi amount (Blockbook unconfirmedBalance can be negative). */
export function parseSignedSats(v: unknown): bigint | null {
  if (typeof v === 'string' && v.startsWith('-')) {
    const abs = parseSats(v.slice(1));
    return abs === null ? null : -abs;
  }
  if (typeof v === 'number' && v < 0) {
    const abs = parseSats(-v);
    return abs === null ? null : -abs;
  }
  return parseSats(v);
}

/** bech32 addresses are case-insensitive; base58 addresses are compared exactly. */
export function normalizeAddress(a: string): string {
  return BECH32_RE.test(a) ? a.toLowerCase() : a;
}

export function addressMatcher(tracked: string): AddressMatcher {
  const t = normalizeAddress(tracked.trim());
  return (candidate) => normalizeAddress(candidate) === t;
}

function rbfFromSequences(vin: readonly NormInput[]): boolean | null {
  if (vin.length === 0 || vin.some((i) => i.sequence === null)) return null;
  return vin.some((i) => (i.sequence as number) < SEQUENCE_FINAL_RBF);
}

function requireTxid(raw: Record<string, unknown>): string {
  if (!isTxid(raw.txid)) throw new MalformedDataError('missing or invalid txid');
  return raw.txid.toLowerCase();
}

// --- Raw transaction size (for backends that only return hex) ---

/**
 * Computes size / weight / vsize from a serialized transaction. Supports legacy and BIP144
 * segwit serialization; returns null for anything else (e.g. Litecoin MWEB extension flags).
 */
export function rawTxSizes(hex: unknown): { size: number; weight: number; vsize: number } | null {
  if (typeof hex !== 'string' || hex.length < 20 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const b = Buffer.from(hex, 'hex');
  const total = b.length;
  let pos = 4;
  let segwit = false;
  if (b[4] === 0x00 && b[5] !== undefined && b[5] !== 0x00) {
    if (b[5] !== 0x01) return null;
    segwit = true;
    pos = 6;
  }
  const readVarInt = (): number | null => {
    const first = b[pos];
    if (first === undefined) return null;
    pos += 1;
    let width = 0;
    if (first < 0xfd) return first;
    if (first === 0xfd) width = 2;
    else if (first === 0xfe) width = 4;
    else width = 8;
    if (pos + width > total) return null;
    let v = 0;
    for (let i = width - 1; i >= 0; i--) v = v * 256 + (b[pos + i] as number);
    pos += width;
    return Number.isSafeInteger(v) ? v : null;
  };
  const skip = (n: number): boolean => {
    pos += n;
    return pos <= total;
  };
  const nIn = readVarInt();
  if (nIn === null) return null;
  for (let i = 0; i < nIn; i++) {
    if (!skip(36)) return null;
    const len = readVarInt();
    if (len === null || !skip(len) || !skip(4)) return null;
  }
  const nOut = readVarInt();
  if (nOut === null) return null;
  for (let i = 0; i < nOut; i++) {
    if (!skip(8)) return null;
    const len = readVarInt();
    if (len === null || !skip(len)) return null;
  }
  let witnessBytes = 0;
  if (segwit) {
    const start = pos;
    for (let i = 0; i < nIn; i++) {
      const items = readVarInt();
      if (items === null) return null;
      for (let j = 0; j < items; j++) {
        const len = readVarInt();
        if (len === null || !skip(len)) return null;
      }
    }
    witnessBytes = pos - start;
  }
  if (!skip(4) || pos !== total) return null;
  const base = segwit ? total - 2 - witnessBytes : total;
  const weight = base * 3 + total;
  return { size: total, weight, vsize: Math.ceil(weight / 4) };
}

// --- Blockbook ---

function blockbookAddresses(io: Record<string, unknown>): string[] {
  if (io.isAddress === false || !Array.isArray(io.addresses)) return [];
  return io.addresses.filter(isPlausibleAddress);
}

function blockbookInput(raw: unknown, isOurs: AddressMatcher): NormInput {
  if (!isRecord(raw)) throw new MalformedDataError('vin entry is not an object');
  const addresses = blockbookAddresses(raw);
  const coinbase = typeof raw.coinbase === 'string';
  const own = raw.isOwn === true || addresses.some(isOurs);
  let value = parseSats(raw.value);
  if (value === null && coinbase) value = 0n;
  if (value === null && raw.value !== undefined) throw new MalformedDataError('invalid vin value');
  if (own && value === null) throw new MalformedDataError('own input without value');
  return { addresses, value, sequence: toInt(raw.sequence, 0, 0xffffffff), coinbase, own };
}

function blockbookOutput(raw: unknown, isOurs: AddressMatcher): NormOutput {
  if (!isRecord(raw)) throw new MalformedDataError('vout entry is not an object');
  const addresses = blockbookAddresses(raw);
  const own = raw.isOwn === true || addresses.some(isOurs);
  const value = parseSats(raw.value);
  if (value === null) throw new MalformedDataError('invalid vout value');
  return { addresses, value, own };
}

/** Parses a Blockbook API v2 transaction (details=txs|txslight entries or GET /api/v2/tx/{txid}). */
export function parseBlockbookTx(raw: unknown, isOurs: AddressMatcher): NormTx {
  if (!isRecord(raw)) throw new MalformedDataError('tx is not an object');
  const txid = requireTxid(raw);
  if (!Array.isArray(raw.vin) || !Array.isArray(raw.vout)) throw new MalformedDataError('vin/vout missing');
  const vin = raw.vin.map((v) => blockbookInput(v, isOurs));
  const vout = raw.vout.map((v) => blockbookOutput(v, isOurs));
  const height = toInt(raw.blockHeight, 1);
  const confirmations = typeof raw.confirmations === 'number' ? raw.confirmations : null;
  const confirmed = height !== null && (confirmations === null || confirmations > 0);
  const time = toInt(raw.blockTime, 1);
  const fee = parseSats(raw.fees);
  if (raw.fees !== undefined && fee === null) throw new MalformedDataError('invalid fee');
  const vsize = toInt(raw.vsize, 1) ?? rawTxSizes(raw.hex)?.vsize ?? null;
  return {
    txid,
    blockHeight: confirmed ? height : null,
    blockTime: confirmed ? time : null,
    // Blockbook reports the first-seen time in blockTime for mempool transactions.
    firstSeen: confirmed ? null : time,
    fee,
    vsize,
    rbf: raw.rbf === true ? true : rbfFromSequences(vin),
    vin,
    vout,
  };
}

/** Blockbook GET /api/v2/address/{a} counters (any details level). */
export function parseBlockbookSummary(raw: unknown): AddressSummary {
  if (!isRecord(raw)) throw new MalformedDataError('address summary is not an object');
  const txs = toInt(raw.txs);
  const balance = parseSats(raw.balance);
  if (txs === null || balance === null) throw new MalformedDataError('address summary missing txs/balance');
  const unconfirmedTxs = raw.unconfirmedTxs === undefined ? 0 : toInt(raw.unconfirmedTxs);
  if (unconfirmedTxs === null) throw new MalformedDataError('invalid unconfirmedTxs');
  const unconfirmedBalance = raw.unconfirmedBalance === undefined ? null : parseSignedSats(raw.unconfirmedBalance);
  if (raw.unconfirmedBalance !== undefined && unconfirmedBalance === null) {
    throw new MalformedDataError('invalid unconfirmedBalance');
  }
  return { txs, unconfirmedTxs, balance, unconfirmedBalance };
}

/** Blockbook GET /api/v2/tx/{txid} -> confirmation state. */
export function blockbookTxLookup(raw: unknown, txid: string): TxLookup {
  if (!isRecord(raw) || !isTxid(raw.txid) || raw.txid.toLowerCase() !== txid.toLowerCase()) {
    throw new MalformedDataError('unexpected tx response');
  }
  const height = toInt(raw.blockHeight, 1);
  const confirmations = typeof raw.confirmations === 'number' ? raw.confirmations : null;
  const confirmed = height !== null && (confirmations === null || confirmations > 0);
  return {
    found: true,
    confirmed,
    blockHeight: confirmed ? height : null,
    blockTime: confirmed ? toInt(raw.blockTime, 1) : null,
  };
}

// --- Esplora ---

function esploraAddress(spk: unknown): string[] {
  return isPlausibleAddress(spk) ? [spk] : [];
}

function esploraInput(raw: unknown, isOurs: AddressMatcher): NormInput {
  if (!isRecord(raw)) throw new MalformedDataError('vin entry is not an object');
  const coinbase = raw.is_coinbase === true;
  const prevout = isRecord(raw.prevout) ? raw.prevout : null;
  const addresses = prevout ? esploraAddress(prevout.scriptpubkey_address) : [];
  const own = addresses.some(isOurs);
  let value = prevout ? parseSats(prevout.value) : null;
  if (value === null && coinbase) value = 0n;
  if (prevout && value === null) throw new MalformedDataError('invalid prevout value');
  if (own && value === null) throw new MalformedDataError('own input without value');
  return { addresses, value, sequence: toInt(raw.sequence, 0, 0xffffffff), coinbase, own };
}

function esploraOutput(raw: unknown, isOurs: AddressMatcher): NormOutput {
  if (!isRecord(raw)) throw new MalformedDataError('vout entry is not an object');
  const addresses = esploraAddress(raw.scriptpubkey_address);
  const value = parseSats(raw.value);
  if (value === null) throw new MalformedDataError('invalid vout value');
  return { addresses, value, own: addresses.some(isOurs) };
}

function esploraStatus(raw: unknown): { blockHeight: number | null; blockTime: number | null } {
  if (!isRecord(raw) || raw.confirmed !== true) return { blockHeight: null, blockTime: null };
  const blockHeight = toInt(raw.block_height, 1);
  if (blockHeight === null) throw new MalformedDataError('confirmed status without block height');
  return { blockHeight, blockTime: toInt(raw.block_time, 1) };
}

/** Parses an Esplora transaction (GET /tx/{txid} or entries of /address/{a}/txs). */
export function parseEsploraTx(raw: unknown, isOurs: AddressMatcher): NormTx {
  if (!isRecord(raw)) throw new MalformedDataError('tx is not an object');
  const txid = requireTxid(raw);
  if (!Array.isArray(raw.vin) || !Array.isArray(raw.vout)) throw new MalformedDataError('vin/vout missing');
  const vin = raw.vin.map((v) => esploraInput(v, isOurs));
  const vout = raw.vout.map((v) => esploraOutput(v, isOurs));
  const { blockHeight, blockTime } = esploraStatus(raw.status);
  const fee = parseSats(raw.fee);
  if (raw.fee !== undefined && fee === null) throw new MalformedDataError('invalid fee');
  const weight = toInt(raw.weight, 1);
  return {
    txid,
    blockHeight,
    blockTime,
    firstSeen: null,
    fee,
    vsize: weight !== null ? Math.ceil(weight / 4) : null,
    rbf: rbfFromSequences(vin),
    vin,
    vout,
  };
}

/** Esplora GET /address/{a}. */
export function parseEsploraSummary(raw: unknown): AddressSummary {
  if (!isRecord(raw) || !isRecord(raw.chain_stats) || !isRecord(raw.mempool_stats)) {
    throw new MalformedDataError('address stats missing');
  }
  const stats = (s: Record<string, unknown>) => {
    const funded = parseSats(s.funded_txo_sum);
    const spent = parseSats(s.spent_txo_sum);
    const count = toInt(s.tx_count);
    if (funded === null || spent === null || count === null) throw new MalformedDataError('invalid address stats');
    return { net: funded - spent, count };
  };
  const chain = stats(raw.chain_stats);
  const mempool = stats(raw.mempool_stats);
  if (chain.net < 0n) throw new MalformedDataError('negative confirmed balance');
  return { txs: chain.count, unconfirmedTxs: mempool.count, balance: chain.net, unconfirmedBalance: mempool.net };
}

/** Esplora GET /tx/{txid} -> confirmation state. */
export function esploraTxLookup(raw: unknown, txid: string): TxLookup {
  if (!isRecord(raw) || !isTxid(raw.txid) || raw.txid.toLowerCase() !== txid.toLowerCase()) {
    throw new MalformedDataError('unexpected tx response');
  }
  const { blockHeight, blockTime } = esploraStatus(raw.status);
  return { found: true, confirmed: blockHeight !== null, blockHeight, blockTime };
}

// --- Lists and fingerprint ---

export type TxParser = (raw: unknown, isOurs: AddressMatcher) => NormTx;

/**
 * Parses a list of transactions, skipping (and reporting) malformed entries instead of failing
 * the whole batch. `undefined` / `null` is treated as an empty list (Blockbook omits empty arrays).
 */
export function parseTxList(
  items: unknown,
  parser: TxParser,
  isOurs: AddressMatcher,
  onSkip?: (txid: string | null, err: unknown) => void,
): ParsedTxList {
  if (items === undefined || items === null) return { txs: [], rawCount: 0, skipped: 0 };
  if (!Array.isArray(items)) throw new MalformedDataError('transaction list is not an array');
  const txs: NormTx[] = [];
  let skipped = 0;
  for (const item of items) {
    try {
      txs.push(parser(item, isOurs));
    } catch (err) {
      skipped++;
      onSkip?.(isRecord(item) && isTxid(item.txid) ? item.txid : null, err);
    }
  }
  return { txs, rawCount: items.length, skipped };
}

/**
 * Cheap change detector stored in the poll cursor. The unconfirmed balance only participates
 * while there are mempool transactions (some Blockbook instances omit it in details=basic),
 * so the value is identical across Blockbook and Esplora for the same chain state.
 */
export function fingerprint(s: AddressSummary): string {
  const ub = s.unconfirmedTxs > 0 ? (s.unconfirmedBalance?.toString() ?? '?') : '0';
  return `${s.txs}:${s.unconfirmedTxs}:${s.balance}:${ub}`;
}
