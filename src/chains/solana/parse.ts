import { NETWORKS } from '../../core/networks.ts';
import type { RawTransfer, TransferDirection, TransferMeta, TransferStatus } from '../../core/types.ts';
import { isValidSolanaAddress } from './keys.ts';

/**
 * Pure parser for `getTransaction` results (encoding "jsonParsed" or "json",
 * maxSupportedTransactionVersion >= 0). No network access; safe to unit test.
 */

const NET = NETWORKS.solana;
export const NATIVE_KEY = NET.native.key;
/** Tracked SPL mints -> NetworkAsset.key. Everything else is ignored (spam). */
export const TRACKED_MINTS: ReadonlyMap<string, string> = new Map(NET.tokens.map((t) => [t.contract!, t.key]));

const MAX_COUNTERPARTIES = 10;

export class SolanaParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolanaParseError';
  }
}

export interface ParseOptions {
  /**
   * True when the transaction was observed at "finalized" commitment. Successful
   * transactions are then reported as "confirmed", otherwise as "pending".
   */
  finalized: boolean;
  /** Expected signature; a mismatch is treated as malformed data. */
  signature?: string;
  /**
   * Token accounts known to belong to the owner. Only used for token-balance entries that
   * lack an `owner` field (very old transactions).
   */
  ownerTokenAccounts?: ReadonlySet<string>;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Only well-formed public keys (base58, 32 bytes) may become counterparties or token owners. */
function isPubkey(v: unknown): v is string {
  return typeof v === 'string' && isValidSolanaAddress(v);
}

function keyString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length < 32 || v.length > 44) fail(`${what} invalid`);
  return v;
}

function fail(msg: string): never {
  throw new SolanaParseError(msg);
}

function lamports(v: unknown, what: string): bigint {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) fail(`${what} is not a non-negative integer`);
  return BigInt(v);
}

function baseUnits(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !/^\d{1,40}$/.test(v)) fail(`${what} is not a base-unit integer string`);
  try {
    return BigInt(v);
  } catch {
    fail(`${what} is not parseable`);
  }
}

/** Account keys in balance-array order (static keys, then loaded writable, then loaded readonly). */
export function resolveAccountKeys(message: Obj, meta: Obj, expected: number): string[] {
  const raw = message.accountKeys;
  if (!Array.isArray(raw)) fail('message.accountKeys missing');
  // Keys stay positional (balance indexes depend on them); validity is checked where they are emitted.
  const keys = raw.map((k, i) => keyString(typeof k === 'string' ? k : isObj(k) ? k.pubkey : undefined, `accountKeys[${i}]`));
  // "jsonParsed" already includes lookup-table addresses (source: "lookupTable");
  // "json" lists only static keys and puts the rest in meta.loadedAddresses.
  if (keys.length < expected && isObj(meta.loadedAddresses)) {
    const { writable, readonly } = meta.loadedAddresses;
    for (const list of [writable, readonly]) {
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) fail('meta.loadedAddresses malformed');
      for (const k of list) keys.push(keyString(k, 'meta.loadedAddresses entry'));
    }
  }
  if (keys.length !== expected) fail(`account key count ${keys.length} != balance count ${expected}`);
  return keys;
}

interface TokenEntry {
  key: string;
  mint: string;
  owner: string | null;
  amount: bigint;
}

function tokenEntries(list: unknown, keys: string[], what: string): TokenEntry[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail(`${what} is not an array`);
  const out: TokenEntry[] = [];
  for (const [i, e] of list.entries()) {
    if (!isObj(e)) fail(`${what}[${i}] invalid`);
    const mint = e.mint;
    if (typeof mint !== 'string') fail(`${what}[${i}].mint invalid`);
    if (!TRACKED_MINTS.has(mint)) continue; // untracked (spam) mints are never parsed further
    const idx = e.accountIndex;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= keys.length) fail(`${what}[${i}].accountIndex invalid`);
    const ui = e.uiTokenAmount;
    if (!isObj(ui)) fail(`${what}[${i}].uiTokenAmount invalid`);
    const owner = isPubkey(e.owner) ? e.owner : null;
    out.push({ key: keys[idx]!, mint, owner, amount: baseUnits(ui.amount, `${what}[${i}].amount`) });
  }
  return out;
}

function extractMemo(message: Obj): string | undefined {
  const ixs = message.instructions;
  if (!Array.isArray(ixs)) return undefined;
  const parts: string[] = [];
  for (const ix of ixs) {
    if (isObj(ix) && ix.program === 'spl-memo' && typeof ix.parsed === 'string') parts.push(ix.parsed);
  }
  if (!parts.length) return undefined;
  // Untrusted text: strip control characters and bound the length.
  const memo = parts
    .join(' | ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .trim();
  return memo ? memo.slice(0, 200) : undefined;
}

/** Counterparties (valid public keys only) with a delta of the opposite sign, largest magnitude first. */
function opposite(deltas: Map<string, bigint>, sign: 1 | -1): string[] {
  return [...deltas.entries()]
    .filter(([k, d]) => (sign > 0 ? d > 0n : d < 0n) && isPubkey(k))
    .sort((a, b) => {
      const x = a[1] < 0n ? -a[1] : a[1];
      const y = b[1] < 0n ? -b[1] : b[1];
      return x === y ? 0 : x > y ? -1 : 1;
    })
    .map(([k]) => k)
    .slice(0, MAX_COUNTERPARTIES);
}

function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * Converts one transaction into balance movements of `owner` (SOL + tracked SPL tokens).
 * Throws SolanaParseError on malformed data; returns [] when the owner is not affected.
 */
export function parseSolanaTransaction(tx: unknown, owner: string, opts: ParseOptions): RawTransfer[] {
  if (!isObj(tx)) fail('transaction result is not an object');
  const meta = tx.meta;
  const transaction = tx.transaction;
  if (!isObj(meta)) fail('meta missing');
  if (!isObj(transaction) || !isObj(transaction.message)) fail('transaction.message missing');
  const message = transaction.message;
  const sigs = transaction.signatures;
  if (!Array.isArray(sigs) || typeof sigs[0] !== 'string') fail('signatures missing');
  const txid = sigs[0];
  if (opts.signature !== undefined && opts.signature !== txid) fail('signature mismatch');
  const slot = tx.slot;
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0) fail('slot invalid');
  const blockTime = typeof tx.blockTime === 'number' && Number.isFinite(tx.blockTime) ? Math.trunc(tx.blockTime) : null;

  const pre = meta.preBalances;
  const post = meta.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length || pre.length === 0) fail('pre/postBalances invalid');
  const keys = resolveAccountKeys(message, meta, pre.length);
  const fee = lamports(meta.fee, 'meta.fee');
  const failed = meta.err !== null && meta.err !== undefined;
  const status: TransferStatus = failed ? 'failed' : opts.finalized ? 'confirmed' : 'pending';
  const payerIsOwner = keys[0] === owner;
  const memo = extractMemo(message);

  const base = { txid, fee, blockHeight: slot, blockTime, status } as const;
  const feeOnlyRow = (): RawTransfer => ({
    ...base,
    subId: 'native',
    assetKey: NATIVE_KEY,
    direction: 'out',
    amount: 0n,
    chargeFee: true,
    counterparty: null,
    meta: { feeOnly: true, ...(memo ? { memo } : {}) },
  });

  // Failed transactions only move the fee (from the fee payer).
  if (failed) return payerIsOwner ? [feeOnlyRow()] : [];

  const out: RawTransfer[] = [];

  // --- SOL ---
  const solDeltas = new Map<string, bigint>();
  let ownerDelta = 0n;
  for (let i = 0; i < keys.length; i++) {
    let d = lamports(post[i], `postBalances[${i}]`) - lamports(pre[i], `preBalances[${i}]`);
    if (i === 0) d += fee; // the fee is not a transfer to anyone
    const k = keys[i]!;
    if (k === owner) ownerDelta += d;
    else if (d !== 0n) solDeltas.set(k, (solDeltas.get(k) ?? 0n) + d);
  }
  if (ownerDelta !== 0n) {
    const direction: TransferDirection = ownerDelta > 0n ? 'in' : 'out';
    const cps = opposite(solDeltas, ownerDelta > 0n ? -1 : 1);
    const meta: TransferMeta = memo ? { memo } : {};
    out.push({
      ...base,
      subId: 'native',
      assetKey: NATIVE_KEY,
      direction,
      amount: abs(ownerDelta),
      chargeFee: payerIsOwner,
      counterparty: cps[0] ?? null,
      counterparties: cps,
      ...(Object.keys(meta).length ? { meta } : {}),
    });
  } else if (payerIsOwner) {
    out.push(feeOnlyRow());
  }

  // --- SPL tokens ---
  const preTok = tokenEntries(meta.preTokenBalances, keys, 'preTokenBalances');
  const postTok = tokenEntries(meta.postTokenBalances, keys, 'postTokenBalances');
  const known = opts.ownerTokenAccounts;
  const belongs = (e: TokenEntry) => e.owner === owner || (e.owner === null && known?.has(e.key) === true);
  for (const [mint, assetKey] of TRACKED_MINTS) {
    let mine = 0n;
    let involved = false;
    const others = new Map<string, bigint>();
    for (const [list, sign] of [
      [preTok, -1n],
      [postTok, 1n],
    ] as const) {
      for (const e of list) {
        if (e.mint !== mint) continue;
        if (belongs(e)) {
          mine += sign * e.amount;
          involved = true;
        } else {
          const who = e.owner ?? e.key;
          others.set(who, (others.get(who) ?? 0n) + sign * e.amount);
        }
      }
    }
    if (!involved || mine === 0n) continue;
    const cps = opposite(others, mine > 0n ? -1 : 1);
    out.push({
      ...base,
      subId: `token:${mint}`,
      assetKey,
      direction: mine > 0n ? 'in' : 'out',
      amount: abs(mine),
      chargeFee: false,
      counterparty: cps[0] ?? null,
      counterparties: cps,
      ...(memo ? { meta: { memo } } : {}),
    });
  }
  return out;
}
