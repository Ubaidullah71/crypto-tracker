import type { AssetId } from '../core/assets.ts';
import type { NetworkId } from '../core/networks.ts';
import type { Category } from '../db/repo.ts';
import type { Effective } from './classify.ts';

/**
 * Average-cost ledger (the method CoinGecko and most trackers use), pooled per coin across
 * all wallets and networks.
 *
 *  acquire       qty += q, cost += q * price
 *  dispose       realized += q * (price - avgCost); qty/cost reduced at avg cost
 *  transfer_out  qty/cost move to a "parked" pool (coins sent to an untracked wallet of your own)
 *  transfer_in   coins come back from the parked pool at their original cost (market price for
 *                any amount beyond what was parked)
 *  internal      no effect (moved between tracked wallets)
 *  fee           fee coins leave at avg cost with zero proceeds (a realized cost)
 *
 * When history is incomplete and a disposal exceeds the known quantity, the unknown part is
 * assumed to have cost exactly its sale price (zero P/L) instead of inventing a gain.
 */

export interface LedgerInput {
  id: number;
  asset: AssetId;
  /** Unix seconds; made non-decreasing per network along block height by the caller. */
  time: number;
  /** Network and block height break ties so rows follow chain order (null height = pending). */
  network?: NetworkId;
  height?: number | null;
  effective: Effective;
  category: Category;
  qty: number;
  /** USD per unit (override or market price at the time), null when unknown. */
  price: number | null;
  /** Why price is null: still being looked up, or no market data exists for that time. */
  priceMissing?: 'pending' | 'none';
  fee: { asset: AssetId; qty: number; price: number | null } | null;
}

export interface AssetBook {
  asset: AssetId;
  qty: number;
  cost: number;
  realized: number;
  acquiredQty: number;
  acquiredUsd: number;
  disposedQty: number;
  proceedsUsd: number;
  feesQty: number;
  feesUsd: number;
  /** Value at receipt of incoming payments (category payment, or default "received"). */
  receivedUsd: number;
  /** Coins sent to your own untracked wallets, with their cost (restored when they come back). */
  parkedQty: number;
  parkedCost: number;
  /** Transactions still waiting for a historical price (P/L is provisional meanwhile). */
  unpriced: number;
  /** Transactions with no market price at all (counted at $0 unless set with /tx edit). */
  noPrice: number;
  /** Largest quantity ever held (scales the floating-point zero threshold). */
  peakQty: number;
  firstTime: number | null;
  lastTime: number | null;
}

export interface RealizedEvent {
  id: number;
  asset: AssetId;
  time: number;
  amount: number;
}

export interface LedgerResult {
  books: Map<AssetId, AssetBook>;
  realizedEvents: RealizedEvent[];
}

const EPS = 1e-12;
/** Relative zero threshold: remainders below peak * this are float noise. */
const REL_EPS = 1e-12;

function emptyBook(asset: AssetId): AssetBook {
  return {
    asset,
    qty: 0,
    cost: 0,
    realized: 0,
    acquiredQty: 0,
    acquiredUsd: 0,
    disposedQty: 0,
    proceedsUsd: 0,
    feesQty: 0,
    feesUsd: 0,
    receivedUsd: 0,
    parkedQty: 0,
    parkedCost: 0,
    unpriced: 0,
    noPrice: 0,
    peakQty: 0,
    firstTime: null,
    lastTime: null,
  };
}

function zeroThreshold(b: AssetBook): number {
  return Math.max(EPS, b.peakQty * REL_EPS);
}

export function avgCost(b: AssetBook): number | null {
  return b.qty > zeroThreshold(b) ? b.cost / b.qty : null;
}

function add(b: AssetBook, q: number, cost: number): void {
  b.qty += q;
  b.cost += cost;
  if (b.qty > b.peakQty) b.peakQty = b.qty;
}

/** Removes qty at average cost; returns the cost basis removed and the qty actually covered. */
function removeAtCost(b: AssetBook, q: number): { covered: number; costRemoved: number } {
  const covered = Math.min(q, Math.max(0, b.qty));
  const avg = b.qty > zeroThreshold(b) ? b.cost / b.qty : 0;
  const costRemoved = covered * avg;
  b.qty -= covered;
  b.cost -= costRemoved;
  if (b.qty < zeroThreshold(b)) {
    b.qty = 0;
    b.cost = 0;
  }
  return { covered, costRemoved };
}

function countMissingPrice(b: AssetBook, e: LedgerInput): void {
  if (e.price !== null) return;
  if (e.priceMissing === 'none') b.noPrice++;
  else b.unpriced++;
}

const RANK: Record<Effective, number> = { acquire: 0, transfer_in: 0, internal: 1, dispose: 2, transfer_out: 2, ignored: 3 };

/**
 * Chain order: time, network, block height, then within one block acquisitions before disposals
 * (a block often holds a receive and the spend of it, and rows are imported newest-first), then
 * insertion order. Compared key by key so the order is total (Array.sort needs that).
 */
export function ledgerOrder(x: LedgerInput, y: LedgerInput): number {
  if (x.time !== y.time) return x.time - y.time;
  const nx = x.network ?? '';
  const ny = y.network ?? '';
  if (nx !== ny) return nx < ny ? -1 : 1;
  const hx = x.height ?? Number.MAX_SAFE_INTEGER;
  const hy = y.height ?? Number.MAX_SAFE_INTEGER;
  if (hx !== hy) return hx - hy;
  if (RANK[x.effective] !== RANK[y.effective]) return RANK[x.effective] - RANK[y.effective];
  return x.id - y.id;
}

export function runLedger(inputs: readonly LedgerInput[]): LedgerResult {
  const books = new Map<AssetId, AssetBook>();
  const realizedEvents: RealizedEvent[] = [];
  const book = (a: AssetId) => {
    let b = books.get(a);
    if (!b) books.set(a, (b = emptyBook(a)));
    return b;
  };
  const sorted = [...inputs].sort(ledgerOrder);

  for (const e of sorted) {
    const b = book(e.asset);
    b.firstTime ??= e.time;
    b.lastTime = e.time;
    let realized = 0;

    // "Ignore" removes the transfer itself from the books, but a network fee you paid is real.
    if (e.qty > 0 && e.effective !== 'ignored') {
      switch (e.effective) {
        case 'acquire': {
          countMissingPrice(b, e);
          const p = e.price ?? 0;
          add(b, e.qty, e.qty * p);
          b.acquiredQty += e.qty;
          b.acquiredUsd += e.qty * p;
          if (e.category === 'auto' || e.category === 'payment') b.receivedUsd += e.qty * p;
          break;
        }
        case 'transfer_in': {
          // Coins coming back from your own wallet keep the cost they left with.
          const back = Math.min(e.qty, b.parkedQty);
          const backCost = b.parkedQty > 0 ? (b.parkedCost / b.parkedQty) * back : 0;
          b.parkedQty -= back;
          b.parkedCost -= backCost;
          if (b.parkedQty <= zeroThreshold(b)) {
            b.parkedQty = 0;
            b.parkedCost = 0;
          }
          const extra = e.qty - back;
          if (extra > 0) countMissingPrice(b, e);
          add(b, e.qty, backCost + extra * (e.price ?? 0));
          if (extra > 0) {
            b.acquiredQty += extra;
            b.acquiredUsd += extra * (e.price ?? 0);
          }
          break;
        }
        case 'dispose': {
          countMissingPrice(b, e);
          const avg = avgCost(b);
          const p = e.price ?? avg ?? 0;
          const { covered, costRemoved } = removeAtCost(b, e.qty);
          realized += covered * p - costRemoved;
          b.disposedQty += e.qty;
          b.proceedsUsd += e.qty * p;
          break;
        }
        case 'transfer_out': {
          const { covered, costRemoved } = removeAtCost(b, e.qty);
          b.parkedQty += covered;
          b.parkedCost += costRemoved;
          break;
        }
        case 'internal':
          break;
      }
    }

    if (e.fee && e.fee.qty > 0) {
      const fb = book(e.fee.asset);
      const { costRemoved } = removeAtCost(fb, e.fee.qty);
      fb.feesQty += e.fee.qty;
      fb.feesUsd += e.fee.qty * (e.fee.price ?? 0);
      fb.realized -= costRemoved;
      if (costRemoved !== 0) realizedEvents.push({ id: e.id, asset: e.fee.asset, time: e.time, amount: -costRemoved });
    }

    if (realized !== 0) {
      b.realized += realized;
      realizedEvents.push({ id: e.id, asset: e.asset, time: e.time, amount: realized });
    }
  }
  return { books, realizedEvents };
}
