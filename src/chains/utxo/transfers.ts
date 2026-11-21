/**
 * The single, backend-independent rule set that turns a normalized UTXO transaction into the
 * tracked address's balance movement. Pure: no I/O, no logging.
 *
 * Reconciliation invariant (asserted by the tests): for every returned transfer the ledger effect
 *   in  -> +amount
 *   out -> -(amount + (chargeFee ? fee : 0))
 *   self -> -(chargeFee ? fee : 0)
 * equals ourOut - ourIn of the transaction exactly.
 */
import type { RawTransfer, TransferDirection, TransferMeta } from '../../core/types.ts';
import { MalformedDataError } from './parse.ts';
import type { NormTx } from './types.ts';

export interface TransferContext {
  /** NetworkAsset.key of the native asset, e.g. "bitcoin:native". */
  assetKey: string;
}

/** Keeps pathological transactions (huge coinjoins / batch payouts) from bloating rows. */
const MAX_COUNTERPARTIES = 200;

function uniqueAddresses(lists: Iterable<readonly string[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const a of list) {
      if (seen.has(a)) continue;
      seen.add(a);
      out.push(a);
      if (out.length >= MAX_COUNTERPARTIES) return out;
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Computes the single "native" RawTransfer of `tx` for the tracked address, or null when the
 * address is not involved (or nothing moved). Throws MalformedDataError for inconsistent data.
 */
export function computeTransfer(tx: NormTx, ctx: TransferContext): RawTransfer | null {
  let ownInputs = 0;
  let ourIn = 0n;
  let totalIn = 0n;
  let totalInKnown = true;
  let coinbase = false;
  for (const i of tx.vin) {
    if (i.coinbase) coinbase = true;
    if (i.value === null) totalInKnown = false;
    else totalIn += i.value;
    if (i.own) {
      if (i.value === null) throw new MalformedDataError('own input without value');
      ownInputs++;
      ourIn += i.value;
    }
  }
  let ownOutputs = 0;
  let ourOut = 0n;
  let totalOut = 0n;
  let totalOutKnown = true;
  for (const o of tx.vout) {
    if (o.value === null) totalOutKnown = false;
    else totalOut += o.value;
    if (o.own) {
      if (o.value === null) throw new MalformedDataError('own output without value');
      ownOutputs++;
      ourOut += o.value;
    }
  }
  if (ownInputs === 0 && ownOutputs === 0) return null;

  const reportedFee = tx.fee;
  const derivedFee = !coinbase && totalInKnown && totalOutKnown && totalIn >= totalOut ? totalIn - totalOut : null;
  const otherInputAddrs = () => uniqueAddresses(tx.vin.filter((i) => !i.own).map((i) => i.addresses));
  const otherOutputAddrs = () => uniqueAddresses(tx.vout.filter((o) => !o.own).map((o) => o.addresses));

  let direction: TransferDirection;
  let amount: bigint;
  let fee: bigint | null;
  let chargeFee: boolean;
  let counterparties: string[];
  let counterparty: string | null;
  const extra: TransferMeta = {};

  if (ownInputs === 0) {
    // Plain receive: someone else funded the transaction and paid its fee.
    if (ourOut === 0n) return null;
    direction = 'in';
    amount = ourOut;
    fee = reportedFee ?? derivedFee ?? (coinbase ? 0n : null);
    chargeFee = false;
    counterparties = otherInputAddrs();
    counterparty = counterparties[0] ?? null;
    if (coinbase) extra.coinbase = true;
  } else if (ownInputs === tx.vin.length) {
    // Every input is ours, so we paid the whole fee. Derive it from the values when possible
    // so the ledger reconciles exactly even if the reported fee is off.
    let paid: bigint;
    if (totalOutKnown) {
      paid = ourIn - totalOut;
      if (paid < 0n) throw new MalformedDataError('outputs exceed inputs');
    } else if (reportedFee !== null) {
      paid = reportedFee;
    } else {
      throw new MalformedDataError('cannot determine fee');
    }
    const sent = ourIn - ourOut - paid;
    chargeFee = true;
    if (sent > 0n) {
      direction = 'out';
      amount = sent;
      fee = paid;
      counterparties = otherOutputAddrs();
      counterparty = counterparties[0] ?? null;
    } else {
      // Consolidation / self-send: only the fee left the address.
      if (ourOut > ourIn) throw new MalformedDataError('own outputs exceed own inputs');
      direction = 'self';
      amount = 0n;
      fee = ourIn - ourOut;
      counterparties = [];
      counterparty = null;
      extra.feeOnly = true;
    }
  } else {
    // Some inputs belong to others (coinjoin / payjoin): fee attribution is unknown, so report
    // the net movement only.
    const net = ourOut - ourIn;
    direction = net > 0n ? 'in' : net < 0n ? 'out' : 'self';
    amount = net < 0n ? -net : net;
    fee = reportedFee ?? derivedFee;
    chargeFee = false;
    const ins = otherInputAddrs();
    const outs = otherOutputAddrs();
    counterparties = uniqueAddresses([direction === 'out' ? outs : ins, direction === 'out' ? ins : outs]);
    counterparty = direction === 'in' ? (ins[0] ?? null) : direction === 'out' ? (outs[0] ?? null) : null;
    extra.mixedInputs = true;
  }

  const meta: TransferMeta = {};
  if (tx.vsize !== null) {
    meta.vsize = tx.vsize;
    if (fee !== null) meta.feeRate = round2(Number(fee) / tx.vsize);
  }
  if (tx.rbf !== null) meta.rbf = tx.rbf;
  if (tx.blockHeight === null && tx.firstSeen !== null) meta.firstSeen = tx.firstSeen;
  Object.assign(meta, extra);

  const confirmed = tx.blockHeight !== null;
  return {
    txid: tx.txid,
    subId: 'native',
    assetKey: ctx.assetKey,
    direction,
    amount,
    fee,
    chargeFee,
    counterparty,
    counterparties,
    blockHeight: confirmed ? tx.blockHeight : null,
    blockTime: confirmed ? tx.blockTime : null,
    status: confirmed ? 'confirmed' : 'pending',
    meta,
  };
}

/** Ledger effect of one transfer on the native balance (used for reconciliation checks). */
export function balanceDelta(t: RawTransfer): bigint {
  const fee = t.chargeFee ? (t.fee ?? 0n) : 0n;
  if (t.direction === 'in') return t.amount - fee;
  return -t.amount - fee;
}
