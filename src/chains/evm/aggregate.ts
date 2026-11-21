import { NETWORKS, type EvmNetworkId } from '../../core/networks.ts';
import type { RawTransfer, TransferDirection, TransferMeta } from '../../core/types.ts';
import type { ChainState } from './probe.ts';
import { weiToGwei } from './util.ts';

export const NATIVE = 'native';

/** One value movement inside a transaction. */
export interface Leg {
  /** NATIVE or the token contract (lowercase). */
  asset: string;
  /** Lowercase addresses; '' when unknown (inferred movement). */
  from: string;
  to: string;
  value: bigint;
  /** Native value moved by a contract call (explorer internal tx, or inferred from balances). */
  internal?: boolean;
}

/** Everything known about one transaction from the tracked address's point of view. */
export interface TxRecord {
  /** Lowercase tx hash, or a synthetic id like "block:123:internal". */
  hash: string;
  block: number;
  time: number | null;
  /** Position in the block (ordering only). */
  index?: number | null;
  /** Transaction sender (lowercase); null when the transaction itself was not seen. */
  sender: string | null;
  /** Transaction recipient or created contract (lowercase), null if unknown. */
  target: string | null;
  /** Reverted: value legs did not happen, the sender still paid the fee. */
  failed: boolean;
  /** Total fee paid by the sender (native base units), null if unknown. */
  fee: bigint | null;
  /** Effective gas price (wei), null if unknown. */
  gasPrice: bigint | null;
  legs: Leg[];
  meta?: TransferMeta;
}

/** Merges a (partial) record into a map keyed by hash. */
export function mergeRecord(map: Map<string, TxRecord>, rec: TxRecord): TxRecord {
  const cur = map.get(rec.hash);
  if (!cur) {
    const copy: TxRecord = { ...rec, legs: [...rec.legs], ...(rec.meta ? { meta: { ...rec.meta } } : {}) };
    map.set(rec.hash, copy);
    return copy;
  }
  cur.legs.push(...rec.legs);
  cur.sender ??= rec.sender;
  cur.target ??= rec.target;
  cur.failed ||= rec.failed;
  cur.fee ??= rec.fee;
  cur.gasPrice ??= rec.gasPrice;
  cur.time ??= rec.time;
  if (cur.index === undefined || cur.index === null) cur.index = rec.index ?? null;
  if (rec.meta) cur.meta = { ...cur.meta, ...rec.meta };
  return cur;
}

interface Side {
  net: bigint;
  self: bigint;
  inflow: Map<string, bigint>;
  outflow: Map<string, bigint>;
  internal: boolean;
}

function largest(m: Map<string, bigint>): string | null {
  let best: string | null = null;
  let bestV = -1n;
  for (const [k, v] of m) {
    if (k && v > bestV) {
      best = k;
      bestV = v;
    }
  }
  return best;
}

function summarize(legs: readonly Leg[], me: string): Side {
  const s: Side = { net: 0n, self: 0n, inflow: new Map(), outflow: new Map(), internal: false };
  for (const l of legs) {
    if (l.value <= 0n) continue;
    const fromMe = l.from === me;
    const toMe = l.to === me;
    if (!fromMe && !toMe) continue;
    if (l.internal) s.internal = true;
    if (fromMe && toMe) {
      s.self += l.value;
    } else if (toMe) {
      s.net += l.value;
      s.inflow.set(l.from, (s.inflow.get(l.from) ?? 0n) + l.value);
    } else {
      s.net -= l.value;
      s.outflow.set(l.to, (s.outflow.get(l.to) ?? 0n) + l.value);
    }
  }
  return s;
}

function others(s: Side, extra: (string | null)[] = []): string[] {
  const set = new Set<string>();
  for (const k of [...s.inflow.keys(), ...s.outflow.keys(), ...extra]) if (k) set.add(k);
  return [...set];
}

/**
 * Converts records into RawTransfers: ONE row per (tx, asset).
 * - native row (subId "native"): net native movement incl. internal value; carries the fee and
 *   chargeFee when the tracked address sent the tx. Paid gas without native movement -> amount 0,
 *   direction "out", meta.feeOnly. Failed tx sent by us -> fee-only row with status "failed".
 * - token rows (subId "token:<contract>"): net movement per tracked contract, fee informational.
 * Direction follows the sign of the net (fee excluded); net 0 without a fee is skipped.
 */
export function toRawTransfers(network: EvmNetworkId, address: string, records: Iterable<TxRecord>): RawTransfer[] {
  const me = address.toLowerCase();
  const info = NETWORKS[network];
  const tokenKeys = new Map(info.tokens.map((t) => [t.contract!, t.key]));
  const out: RawTransfer[] = [];
  const sorted = [...records].sort(
    (a, b) => a.block - b.block || (a.index ?? 1e9) - (b.index ?? 1e9) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
  );

  for (const r of sorted) {
    const paidFee = r.sender === me && r.fee !== null && r.fee > 0n;
    const baseMeta: TransferMeta = { ...r.meta };
    if (r.gasPrice !== null && r.gasPrice > 0n) baseMeta.feeRate = weiToGwei(r.gasPrice);
    if (r.hash.startsWith('block:')) baseMeta.syntheticTxid = true;
    const common = {
      txid: r.hash,
      fee: r.fee,
      blockHeight: r.block,
      blockTime: r.time,
    };

    if (r.failed) {
      if (paidFee) {
        out.push({
          ...common,
          subId: 'native',
          assetKey: info.native.key,
          direction: 'out',
          amount: 0n,
          chargeFee: true,
          counterparty: r.target,
          ...(r.target ? { counterparties: [r.target] } : {}),
          status: 'failed',
          meta: { ...baseMeta, feeOnly: true },
        });
      }
      continue;
    }

    // Native
    const native = summarize(
      r.legs.filter((l) => l.asset === NATIVE),
      me,
    );
    let direction: TransferDirection | null = null;
    let amount = 0n;
    let counterparty: string | null = null;
    const meta: TransferMeta = { ...baseMeta };
    if (native.net > 0n) {
      direction = 'in';
      amount = native.net;
      counterparty = largest(native.inflow);
    } else if (native.net < 0n) {
      direction = 'out';
      amount = -native.net;
      counterparty = largest(native.outflow);
    } else if (paidFee && native.self > 0n) {
      direction = 'self';
      amount = native.self;
      counterparty = me;
    } else if (paidFee) {
      direction = 'out';
      amount = 0n;
      counterparty = r.target;
      meta.feeOnly = true;
    }
    if (direction) {
      if (counterparty === null && !meta.feeOnly) counterparty = r.sender === me ? r.target : r.sender;
      if (native.internal) meta.internal = true;
      const cps = others(native, meta.feeOnly ? [r.target] : []);
      out.push({
        ...common,
        subId: 'native',
        assetKey: info.native.key,
        direction,
        amount,
        chargeFee: paidFee,
        counterparty: counterparty === '' ? null : counterparty,
        ...(cps.length ? { counterparties: cps } : {}),
        status: 'confirmed',
        meta,
      });
    }

    // Tokens (tracked contracts only; everything else is ignored as spam)
    const contracts = [...new Set(r.legs.map((l) => l.asset).filter((a) => a !== NATIVE))].sort();
    for (const contract of contracts) {
      const key = tokenKeys.get(contract);
      if (!key) continue;
      const s = summarize(
        r.legs.filter((l) => l.asset === contract),
        me,
      );
      if (s.net === 0n) continue;
      const dir: TransferDirection = s.net > 0n ? 'in' : 'out';
      const cps = others(s);
      out.push({
        ...common,
        subId: `token:${contract}`,
        assetKey: key,
        direction: dir,
        amount: s.net > 0n ? s.net : -s.net,
        chargeFee: false,
        counterparty: (dir === 'in' ? largest(s.inflow) : largest(s.outflow)) ?? null,
        ...(cps.length ? { counterparties: cps } : {}),
        status: 'confirmed',
        meta: { ...baseMeta },
      });
    }
  }
  return out;
}

/** Net effect of transfers on balances (native includes charged fees). */
export interface NetEffect {
  native: bigint;
  /** By token contract (lowercase). */
  tokens: Map<string, bigint>;
}

export function netEffect(network: EvmNetworkId, transfers: readonly RawTransfer[]): NetEffect {
  const info = NETWORKS[network];
  const byKey = new Map(info.tokens.map((t) => [t.key, t.contract!]));
  const eff: NetEffect = { native: 0n, tokens: new Map() };
  for (const t of transfers) {
    const signed = t.direction === 'in' ? t.amount : t.direction === 'out' ? -t.amount : 0n;
    if (t.assetKey === info.native.key) eff.native += signed;
    else {
      const c = byKey.get(t.assetKey);
      if (c) eff.tokens.set(c, (eff.tokens.get(c) ?? 0n) + signed);
    }
    if (t.chargeFee && t.fee) eff.native -= t.fee;
  }
  return eff;
}

/**
 * Checks that `transfers` explain the state change before -> after. Returns human-readable
 * mismatches (empty = reconciled). `sentTxs` (optional) is compared with the nonce delta.
 */
export function reconcile(
  network: EvmNetworkId,
  before: ChainState,
  after: ChainState,
  transfers: readonly RawTransfer[],
  sentTxs?: number,
): string[] {
  const tokens = NETWORKS[network].tokens;
  const eff = netEffect(network, transfers);
  const problems: string[] = [];
  const dNative = after.balance - before.balance;
  if (dNative !== eff.native) problems.push(`native: state delta ${dNative}, transfers ${eff.native}`);
  tokens.forEach((t, i) => {
    const d = (after.tokens[i] ?? 0n) - (before.tokens[i] ?? 0n);
    const e = eff.tokens.get(t.contract!) ?? 0n;
    if (d !== e) problems.push(`${t.asset}${t.label ? ` (${t.label})` : ''}: state delta ${d}, transfers ${e}`);
  });
  if (sentTxs !== undefined && after.nonce - before.nonce !== BigInt(sentTxs)) {
    problems.push(`nonce: state delta ${after.nonce - before.nonce}, sent txs ${sentTxs}`);
  }
  return problems;
}
