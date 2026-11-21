/**
 * Pure parsing of XRP Ledger transactions into RawTransfers (no network access).
 *
 * Balance-delta method: the XRP movement of the tracked account is read from its AccountRoot node in
 * `meta.AffectedNodes` (FinalFields.Balance - PreviousFields.Balance), never from `Amount` /
 * `DeliverMax` / `delivered_amount`. This is immune to the partial-payment exploit, counts offers
 * consumed by other people's transactions, AMM / escrow / channel / AccountDelete movements, and makes
 * the sum of all rows reconcile exactly with the account balance.
 */
import { base58CheckDecode, XRP_ALPHABET } from '../../core/encoding.ts';
import { NETWORKS } from '../../core/networks.ts';
import type { RawTransfer, TransferMeta, TransferStatus, TxStatusResult } from '../../core/types.ts';
import { createLogger } from '../../logger.ts';

const log = createLogger('xrp');

export type Json = Record<string, unknown>;

export function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const XRP_ASSET_KEY = NETWORKS.xrp.native.key;
/** Seconds between the Unix epoch and the Ripple epoch (2000-01-01T00:00:00Z). */
export const RIPPLE_EPOCH_OFFSET = 946_684_800;
/** Earliest ledger any mainnet server has (ledgers 1-32569 were lost in 2013). */
export const MAINNET_FIRST_LEDGER = 32_570;

const TF_PARTIAL_PAYMENT = 0x0002_0000;
const HASH_RE = /^[0-9A-Fa-f]{64}$/;
/** Drops are non-negative integers below 10^17 (100 billion XRP). */
const DROPS_RE = /^\d{1,18}$/;
const UINT32_MAX = 0xffff_ffff;

export class MalformedTxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedTxError';
  }
}

/** A validated-shape transaction, independent of API version (v1 `tx` / v2 `tx_json`). */
export interface XrplTx {
  /** Uppercase hex hash. */
  hash: string;
  ledgerIndex: number;
  /** Unix seconds of the ledger close, or null if the server did not provide it. */
  closeTime: number | null;
  validated: boolean;
  tx: Json;
  meta: Json;
}

export function parseDrops(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !DROPS_RE.test(value)) {
    throw new MalformedTxError(`${field} is not an XRP drops amount: ${JSON.stringify(value)?.slice(0, 60)}`);
  }
  return BigInt(value);
}

/** Ledger index from a number or numeric string (API v1 returns some as strings). */
export function parseLedgerIndex(value: unknown): number | null {
  let n = Number.NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{1,15}$/.test(value)) n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseUint32(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= UINT32_MAX ? value : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

const CLASSIC_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

/** True for a classic XRPL account address (base58check, XRPL alphabet, version byte 0x00). */
export function isClassicAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !CLASSIC_ADDRESS_RE.test(value)) return false;
  const payload = base58CheckDecode(value, XRP_ALPHABET);
  return payload !== null && payload.length === 21 && payload[0] === 0x00;
}

function classicAddress(value: unknown): string | null {
  return isClassicAddress(value) ? value : null;
}

/**
 * Normalizes an account_tx entry (v1: `{tx, meta, validated}`; v2: `{tx_json, meta, hash, ledger_index,
 * close_time_iso, validated}`) or a `tx` method result (v1: flat; v2: `tx_json`). Throws MalformedTxError.
 */
export function normalizeTx(entry: unknown): XrplTx {
  if (!isRecord(entry)) throw new MalformedTxError('entry is not an object');
  const tx = isRecord(entry.tx_json)
    ? entry.tx_json
    : isRecord(entry.tx)
      ? entry.tx
      : typeof entry.TransactionType === 'string'
        ? entry
        : null;
  if (!tx) throw new MalformedTxError('entry has no transaction object');
  const meta = isRecord(entry.meta) ? entry.meta : isRecord(entry.metaData) ? entry.metaData : null;
  if (!meta) throw new MalformedTxError('entry has no JSON metadata');

  const hash = entry.hash ?? tx.hash;
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw new MalformedTxError('invalid transaction hash');

  const ledgerIndex = parseLedgerIndex(entry.ledger_index ?? tx.ledger_index ?? tx.inLedger);
  if (ledgerIndex === null) throw new MalformedTxError(`transaction ${hash} has no ledger index`);

  let closeTime: number | null = null;
  const date = tx.date ?? entry.date;
  if (typeof date === 'number' && Number.isSafeInteger(date) && date > 0) {
    closeTime = date + RIPPLE_EPOCH_OFFSET;
  } else if (typeof entry.close_time_iso === 'string') {
    const ms = Date.parse(entry.close_time_iso);
    if (Number.isFinite(ms)) closeTime = Math.floor(ms / 1000);
  }

  return { hash: hash.toUpperCase(), ledgerIndex, closeTime, validated: entry.validated === true, tx, meta };
}

const NODE_KINDS = ['CreatedNode', 'ModifiedNode', 'DeletedNode'] as const;

/**
 * Net change of the account's XRP balance in drops (fee included), from its AccountRoot node.
 * `found` is false when the transaction did not touch the account's AccountRoot at all.
 */
export function xrpBalanceDelta(meta: Json, address: string): { delta: bigint; found: number } {
  const nodes = meta.AffectedNodes;
  if (!Array.isArray(nodes)) throw new MalformedTxError('meta.AffectedNodes is missing');
  let delta = 0n;
  let found = 0;
  for (const wrapper of nodes) {
    if (!isRecord(wrapper)) continue;
    for (const kind of NODE_KINDS) {
      const node = wrapper[kind];
      if (!isRecord(node) || node.LedgerEntryType !== 'AccountRoot') continue;
      // A ModifiedNode can lack FinalFields (only PreviousTxnID threading changed): no balance change.
      const fields = kind === 'CreatedNode' ? node.NewFields : node.FinalFields;
      if (!isRecord(fields) || fields.Account !== address) continue;
      found++;
      const prev = isRecord(node.PreviousFields) ? node.PreviousFields : undefined;
      if (kind === 'CreatedNode') {
        if (fields.Balance !== undefined) delta += parseDrops(fields.Balance, 'NewFields.Balance');
      } else if (kind === 'ModifiedNode') {
        // PreviousFields.Balance absent => balance unchanged.
        if (prev?.Balance !== undefined) {
          delta += parseDrops(fields.Balance, 'FinalFields.Balance') - parseDrops(prev.Balance, 'PreviousFields.Balance');
        }
      } else {
        // Deleted account: its balance afterwards is 0, whatever FinalFields says.
        const before = prev?.Balance ?? fields.Balance;
        if (before !== undefined) delta -= parseDrops(before, 'DeletedNode Balance');
      }
    }
  }
  return { delta, found };
}

/** Control, zero-width and bidi-override characters are removed from untrusted memo text. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Decodes MemoData fields that are valid UTF-8 text. Returns undefined when there is nothing readable. */
export function decodeMemos(tx: Json): string | undefined {
  if (!Array.isArray(tx.Memos)) return undefined;
  const parts: string[] = [];
  for (const m of tx.Memos.slice(0, 4)) {
    const data = isRecord(m) && isRecord(m.Memo) ? m.Memo.MemoData : undefined;
    if (typeof data !== 'string' || data.length > 2048 || !/^(?:[0-9A-Fa-f]{2})+$/.test(data)) continue;
    let text: string;
    try {
      text = utf8.decode(Buffer.from(data, 'hex'));
    } catch {
      continue; // binary memo
    }
    text = text.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  }
  if (parts.length === 0) return undefined;
  const joined = parts.join(' | ');
  return joined.length > 200 ? `${joined.slice(0, 199)}…` : joined;
}

/**
 * Converts one validated transaction into at most one RawTransfer (subId "native") for `address`.
 * Returns null when the account's XRP balance did not change and it did not pay the fee.
 * Throws MalformedTxError for inconsistent data.
 */
export function parseTransfer(t: XrplTx, address: string): RawTransfer | null {
  const { tx, meta } = t;
  const result = meta.TransactionResult;
  if (typeof result !== 'string') throw new MalformedTxError(`${t.hash}: missing TransactionResult`);
  let status: TransferStatus;
  if (result.startsWith('tes')) status = 'confirmed';
  else if (result.startsWith('tec')) status = 'failed';
  else throw new MalformedTxError(`${t.hash}: result ${result.slice(0, 40)} cannot be in a validated ledger`);

  const type = str(tx.TransactionType);
  const account = str(tx.Account);
  if (!type || !account) throw new MalformedTxError(`${t.hash}: missing TransactionType/Account`);
  const fee = parseDrops(tx.Fee, 'Fee');
  // PermissionDelegation: when a Delegate signs, the delegate (not Account) pays the fee.
  // Batch inner transactions carry Fee "0" (the outer Batch pays).
  const delegate = str(tx.Delegate);
  const feePayer = delegate ?? account;

  const { delta, found } = xrpBalanceDelta(meta, address);
  const paidFee = feePayer === address && fee > 0n;
  if (paidFee && found === 0) throw new MalformedTxError(`${t.hash}: fee payer's AccountRoot missing from metadata`);
  if (found > 1) log.warn(`${t.hash}: ${found} AccountRoot nodes for one account`);

  const net = delta + (paidFee ? fee : 0n);
  if (net === 0n && !paidFee) return null;
  if (status === 'failed' && net !== 0n) {
    log.warn(`${t.hash}: ${result} moved ${net} drops beyond the fee; reporting the balance change as-is`);
  }

  const direction = net > 0n ? 'in' : 'out';
  const amount = net < 0n ? -net : net;
  // Only well-formed classic addresses are ever reported (untrusted server data); anything else -> null.
  // The raw strings above are only compared with our own (valid) address, so junk can never match it.
  const sender = classicAddress(account);
  const destination = classicAddress(tx.Destination);
  const delegateAddress = classicAddress(delegate);

  // Main counterparty only for direct transfers between two accounts.
  let counterparty: string | null = null;
  if (type === 'Payment' || type === 'AccountDelete') {
    if (direction === 'in' && destination === address && sender && sender !== address) counterparty = sender;
    else if (direction === 'out' && sender === address && destination && destination !== address) counterparty = destination;
  }
  const counterparties = [...new Set([sender, destination, delegateAddress].filter((a): a is string => !!a && a !== address))];

  const m: TransferMeta = { txType: type, result, feeRate: Number(fee) };
  const destinationTag = parseUint32(tx.DestinationTag);
  const sourceTag = parseUint32(tx.SourceTag);
  if (destinationTag !== undefined) m.destinationTag = destinationTag;
  if (sourceTag !== undefined) m.sourceTag = sourceTag;
  if (amount === 0n) m.feeOnly = true;
  if (delegateAddress) m.delegate = delegateAddress;
  if (type === 'Payment' && typeof tx.Flags === 'number' && (tx.Flags & TF_PARTIAL_PAYMENT) !== 0) {
    m.partialPayment = true;
    const delivered = meta.delivered_amount;
    if (typeof delivered === 'string') {
      log.debug(`${t.hash}: partial payment, delivered_amount ${delivered.slice(0, 24)} drops (info only)`);
    }
  }
  const memo = decodeMemos(tx);
  if (memo) m.memo = memo;

  return {
    txid: t.hash,
    subId: 'native',
    assetKey: XRP_ASSET_KEY,
    direction,
    amount,
    fee,
    chargeFee: paidFee,
    counterparty,
    ...(counterparties.length ? { counterparties } : {}),
    blockHeight: t.ledgerIndex,
    blockTime: t.closeTime,
    status,
    meta: m,
  };
}

/**
 * Parses a list of account_tx entries, skipping (with a warning) unvalidated and malformed ones.
 * Never throws because of a single bad transaction.
 */
export function parseAccountTxEntries(entries: readonly unknown[], address: string): RawTransfer[] {
  const out: RawTransfer[] = [];
  for (const entry of entries) {
    const t = parseEntry(entry, address);
    if (t) out.push(t);
  }
  return out;
}

/** Normalizes + parses one entry; returns null (after logging) for unvalidated or malformed entries. */
export function parseEntry(entry: unknown, address: string): RawTransfer | null {
  let t: XrplTx;
  try {
    t = normalizeTx(entry);
  } catch (err) {
    log.warn('skipping malformed XRPL transaction entry', err);
    return null;
  }
  if (!t.validated) return null;
  try {
    return parseTransfer(t, address);
  } catch (err) {
    log.warn(`skipping XRPL transaction ${t.hash}`, err);
    return null;
  }
}

/** Interprets a `tx` method result. */
export function parseTxStatus(result: unknown, expectedHash: string): TxStatusResult {
  if (!isRecord(result)) return { state: 'unknown' };
  let t: XrplTx;
  try {
    t = normalizeTx(result);
  } catch {
    // Pending transactions may lack a ledger index.
    return result.validated === false ? { state: 'pending', blockHeight: null, blockTime: null } : { state: 'unknown' };
  }
  if (t.hash !== expectedHash.toUpperCase()) return { state: 'unknown' };
  if (!t.validated) return { state: 'pending', blockHeight: null, blockTime: null };
  const code = t.meta.TransactionResult;
  if (typeof code !== 'string') return { state: 'unknown' };
  const state = code.startsWith('tes') ? 'confirmed' : code.startsWith('tec') ? 'failed' : 'unknown';
  return { state, blockHeight: t.ledgerIndex, blockTime: t.closeTime };
}
