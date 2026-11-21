import type { NetworkId } from '../core/networks.ts';
import type { TransferDirection } from '../core/types.ts';
import type { Category } from '../db/repo.ts';

/** How a transfer affects the cost-basis ledger. */
export type Effective = 'acquire' | 'dispose' | 'transfer_in' | 'transfer_out' | 'internal' | 'ignored';

/** Addresses of all tracked wallets per network (normalized), for internal-transfer detection. */
export type TrackedIndex = Map<NetworkId, Set<string>>;

export function normalizeAddr(a: string): string {
  return /^0x/i.test(a) || /^(bc1|ltc1)/i.test(a) ? a.toLowerCase() : a;
}

export function buildTrackedIndex(rows: Array<{ network: NetworkId; address: string }>): TrackedIndex {
  const idx: TrackedIndex = new Map();
  for (const r of rows) {
    let set = idx.get(r.network);
    if (!set) idx.set(r.network, (set = new Set()));
    set.add(normalizeAddr(r.address));
  }
  return idx;
}

export interface ClassifiableTransfer {
  network: NetworkId;
  direction: TransferDirection;
  category: Category;
  counterparty: string | null;
  counterparties: string | null;
  /** The tracked address that owns this transfer. */
  address: string;
}

function counterpartiesOf(t: ClassifiableTransfer): string[] {
  let list: string[] = [];
  if (t.counterparties) {
    try {
      const parsed: unknown = JSON.parse(t.counterparties);
      if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      /* ignore */
    }
  }
  if (list.length === 0 && t.counterparty) list = [t.counterparty];
  const own = normalizeAddr(t.address);
  return list.map(normalizeAddr).filter((a) => a !== own);
}

/** True when the other side of the transfer is another wallet you track on the same network. */
export function isInternal(t: ClassifiableTransfer, tracked: TrackedIndex): boolean {
  const set = tracked.get(t.network);
  if (!set) return false;
  const cps = counterpartiesOf(t);
  if (cps.length === 0) return false;
  return t.direction === 'in' ? cps.some((a) => set.has(a)) : cps.every((a) => set.has(a));
}

export function resolveEffective(t: ClassifiableTransfer, tracked: TrackedIndex): Effective {
  if (t.category === 'ignored') return 'ignored';
  if (t.direction === 'self' || t.category === 'internal') return 'internal';
  if (t.direction === 'in') {
    if (t.category === 'transfer') return 'transfer_in';
    if (t.category === 'auto' && isInternal(t, tracked)) return 'internal';
    return 'acquire';
  }
  // direction === 'out'
  if (t.category === 'transfer') return 'transfer_out';
  if (t.category === 'auto' && isInternal(t, tracked)) return 'internal';
  return 'dispose';
}

// --- pairing for the ledger ---

export interface PairableRow {
  id: number;
  network: NetworkId;
  txid: string;
  asset: string;
  direction: TransferDirection;
  category: Category;
  amount: string;
  decimals: number;
  meta: string | null;
}

export interface EffectiveEntry {
  effective: Effective;
  /** Quantity this row contributes with `effective` (the rest of the row is internal). */
  qty: number;
}

function rowQty(r: PairableRow): number {
  try {
    const v = BigInt(r.amount);
    const s = v.toString().padStart(r.decimals + 1, '0');
    return Number(r.decimals ? `${s.slice(0, -r.decimals)}.${s.slice(-r.decimals)}` : s);
  } catch {
    return 0;
  }
}

function isSynthetic(r: PairableRow): boolean {
  return r.txid.startsWith('block:') || (r.meta?.includes('"syntheticTxid":true') ?? false);
}

/**
 * How each row counts in the ledger. Transfers between tracked wallets are found by pairing the
 * sending and receiving rows of the SAME transaction (and coin), not by guessing from addresses:
 *  - a payment of 0.3 to a merchant with 0.7 change to another tracked wallet is a 0.3 sale,
 *  - a receipt from a tracked wallet whose sending side is not recorded counts as acquired.
 * A category set by hand (sale, spend, transfer, ...) describes the part that did not move between
 * tracked wallets, so marking a payment "Spend" does not turn its change into a sale. "Between my
 * tracked wallets" and "Ignore" always apply to the whole row.
 */
export function buildEffectiveMap(rows: readonly PairableRow[]): Map<number, EffectiveEntry> {
  const map = new Map<number, EffectiveEntry>();
  const groups = new Map<string, PairableRow[]>();
  for (const r of rows) {
    const qty = rowQty(r);
    let effective: Effective;
    if (r.category === 'ignored') effective = 'ignored';
    else if (r.direction === 'self' || r.category === 'internal') effective = 'internal';
    else if (r.direction === 'in') effective = r.category === 'transfer' ? 'transfer_in' : 'acquire';
    else effective = r.category === 'transfer' ? 'transfer_out' : 'dispose';
    map.set(r.id, { effective, qty });
    if (r.category !== 'ignored' && r.direction !== 'self' && !isSynthetic(r)) {
      const key = `${r.network}|${r.txid.toLowerCase()}|${r.asset}`;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }
  }
  for (const g of groups.values()) {
    const ins = g.filter((r) => r.direction === 'in');
    const outs = g.filter((r) => r.direction === 'out');
    if (!ins.length || !outs.length) continue;
    const inTotal = ins.reduce((s, r) => s + rowQty(r), 0);
    const outTotal = outs.reduce((s, r) => s + rowQty(r), 0);
    // The paired (internal) amount is what both sides agree on.
    const paired = Math.min(inTotal, outTotal);
    const split = (list: PairableRow[], total: number) => {
      for (const r of list) {
        const own = map.get(r.id)!;
        if (own.effective === 'internal') continue;
        const qty = rowQty(r);
        const internal = total > 0 ? (qty / total) * paired : 0;
        const remainder = qty - internal;
        map.set(
          r.id,
          remainder <= Math.max(1e-12, qty * 1e-9) ? { effective: 'internal', qty } : { effective: own.effective, qty: remainder },
        );
      }
    };
    split(ins, inTotal);
    split(outs, outTotal);
  }
  return map;
}

/** Human label for the category column. */
export function categoryLabel(t: ClassifiableTransfer, tracked: TrackedIndex): string {
  const eff = resolveEffective(t, tracked);
  if (t.category === 'ignored') return 'Ignored';
  if (eff === 'internal') return t.direction === 'self' ? 'Self transfer' : 'Between your wallets';
  switch (t.category) {
    case 'payment':
      return 'Payment received';
    case 'purchase':
      return 'Purchase';
    case 'transfer':
      return t.direction === 'in' ? 'Transfer in (own funds)' : 'Transfer out (own wallet)';
    case 'sale':
      return 'Sale';
    case 'spend':
      return 'Spend';
    default:
      return t.direction === 'in' ? 'Received' : 'Sent';
  }
}

export const CATEGORY_CHOICES_IN: Array<{ name: string; value: Category }> = [
  { name: 'Received (default)', value: 'auto' },
  { name: 'Payment received (income)', value: 'payment' },
  { name: 'Purchase (bought it)', value: 'purchase' },
  { name: 'Transfer in from my own wallet', value: 'transfer' },
  { name: 'Between my tracked wallets', value: 'internal' },
  { name: 'Ignore (spam / not mine)', value: 'ignored' },
];

export const CATEGORY_CHOICES_OUT: Array<{ name: string; value: Category }> = [
  { name: 'Sent (default)', value: 'auto' },
  { name: 'Sale (sold it)', value: 'sale' },
  { name: 'Spend (paid for something)', value: 'spend' },
  { name: 'Transfer out to my own wallet', value: 'transfer' },
  { name: 'Between my tracked wallets', value: 'internal' },
  { name: 'Ignore', value: 'ignored' },
];
