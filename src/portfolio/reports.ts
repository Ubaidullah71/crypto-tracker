import { ASSET_IDS, type AssetId } from '../core/assets.ts';
import { formatUnits, toNumber } from '../core/amount.ts';
import { NETWORKS } from '../core/networks.ts';
import { transfers, type TransferFilter, type TransferWithWallet } from '../db/repo.ts';
import { buildEffectiveMap, categoryLabel, type TrackedIndex } from './classify.ts';
import { runLedger } from './ledger.ts';
import { effectivePrice, toLedgerInputs, trackedIndex } from './portfolio.ts';

export interface AssetFlow {
  asset: AssetId;
  count: number;
  qty: number;
  usd: number;
}

export interface FlowReport {
  from: number;
  to: number;
  incoming: AssetFlow[];
  incomingUsd: number;
  incomingCount: number;
  /** USD split of incoming value by category label (Payment received, Purchase, Received, ...). */
  incomingByCategory: Array<{ label: string; usd: number; count: number }>;
  outgoing: AssetFlow[];
  outgoingUsd: number;
  outgoingCount: number;
  internalCount: number;
  feesUsd: number;
  realized: number;
  /** An earlier purchase of a sold coin is still waiting for its historical price. */
  realizedProvisional: boolean;
  unpriced: number;
  largestIncoming: TransferWithWallet | null;
}

function addFlow(map: Map<AssetId, AssetFlow>, asset: AssetId, qty: number, usd: number): void {
  const f = map.get(asset) ?? { asset, count: 0, qty: 0, usd: 0 };
  f.count++;
  f.qty += qty;
  f.usd += usd;
  map.set(asset, f);
}

/** Money in / money out for a period, valued at the time of each transaction. */
export function flowReport(from: number, to: number, filter: Omit<TransferFilter, 'from' | 'to'> = {}): FlowReport {
  const tracked = trackedIndex();
  const rows = transfers.range({ ...filter, from, to });
  // Same pairing as the ledger, over all rows (the other side of a move may be outside the filter).
  const allRows = transfers.forLedger();
  const effective = buildEffectiveMap(allRows);
  const inMap = new Map<AssetId, AssetFlow>();
  const outMap = new Map<AssetId, AssetFlow>();
  const byCat = new Map<string, { label: string; usd: number; count: number }>();
  let feesUsd = 0;
  let internalCount = 0;
  let unpriced = 0;
  let largest: TransferWithWallet | null = null;
  let largestUsd = -1;

  for (const t of rows) {
    const e = effective.get(t.id);
    const eff = e?.effective ?? 'ignored';
    if (eff === 'ignored') continue;
    // Only the part that really left or arrived (a partly-internal payment counts its outside part).
    const qty = e ? e.qty : toNumber(BigInt(t.amount), t.decimals);
    const price = effectivePrice(t);
    if (price === null && qty > 0) unpriced++;
    const usd = qty * (price ?? 0);
    if (t.charge_fee && t.fee) {
      const native = NETWORKS[t.network].native;
      feesUsd += toNumber(BigInt(t.fee), native.decimals) * (t.fee_price_usd ?? 0);
    }
    if (qty === 0) continue;
    if (eff === 'internal') {
      internalCount++;
      continue;
    }
    if (t.direction === 'in') {
      addFlow(inMap, t.asset, qty, usd);
      const label = categoryLabel(t, tracked);
      const c = byCat.get(label) ?? { label, usd: 0, count: 0 };
      c.usd += usd;
      c.count++;
      byCat.set(label, c);
      if (usd > largestUsd) {
        largestUsd = usd;
        largest = t;
      }
    } else if (t.direction === 'out') {
      addFlow(outMap, t.asset, qty, usd);
    }
  }

  const ledger = runLedger(toLedgerInputs(allRows));
  // Realized P/L uses portfolio-wide average cost; for a filtered report only count the
  // disposals (and fees) of the transfers in this report.
  const filtered = Object.keys(filter).length > 0;
  const inReport = new Set(rows.map((r) => r.id));
  const events = ledger.realizedEvents.filter((e) => e.time >= from && e.time < to && (!filtered || inReport.has(e.id)));
  const realized = events.reduce((s, e) => s + e.amount, 0);
  const realizedProvisional = events.some((e) => (ledger.books.get(e.asset)?.unpriced ?? 0) > 0);
  const order = (a: AssetFlow, b: AssetFlow) => b.usd - a.usd || ASSET_IDS.indexOf(a.asset) - ASSET_IDS.indexOf(b.asset);
  const incoming = [...inMap.values()].sort(order);
  const outgoing = [...outMap.values()].sort(order);
  return {
    from,
    to,
    incoming,
    incomingUsd: incoming.reduce((s, f) => s + f.usd, 0),
    incomingCount: incoming.reduce((s, f) => s + f.count, 0),
    incomingByCategory: [...byCat.values()].sort((a, b) => b.usd - a.usd),
    outgoing,
    outgoingUsd: outgoing.reduce((s, f) => s + f.usd, 0),
    outgoingCount: outgoing.reduce((s, f) => s + f.count, 0),
    internalCount,
    feesUsd,
    realized,
    realizedProvisional,
    unpriced,
    largestIncoming: largest,
  };
}

// --- CSV ---

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralize spreadsheet formula injection from on-chain or API data: anything that is not a
  // plain number and starts with a formula character gets a leading quote.
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function transactionsCsv(rows: TransferWithWallet[], tracked: TrackedIndex = trackedIndex()): string {
  const header = [
    'date_utc',
    'wallet',
    'network',
    'asset',
    'token_variant',
    'direction',
    'category',
    'amount',
    'price_usd',
    'value_usd',
    'price_source',
    'fee',
    'fee_asset',
    'fee_paid_by_you',
    'fee_usd',
    'status',
    'block',
    'counterparty',
    'txid',
    'explorer_url',
    'note',
  ];
  const lines = [header.join(',')];
  for (const t of rows) {
    const net = NETWORKS[t.network];
    const qty = formatUnits(BigInt(t.amount), t.decimals);
    const price = effectivePrice(t);
    const fee = t.fee ? formatUnits(BigInt(t.fee), net.native.decimals) : '';
    const feeUsd = t.fee && t.fee_price_usd !== null ? toNumber(BigInt(t.fee), net.native.decimals) * t.fee_price_usd : null;
    const variant = net.tokens.find((x) => x.key === t.asset_key)?.label ?? '';
    let meta: Record<string, unknown> = {};
    try {
      meta = t.meta ? (JSON.parse(t.meta) as Record<string, unknown>) : {};
    } catch {
      /* ignore */
    }
    lines.push(
      [
        new Date((t.block_time ?? t.first_seen_at) * 1000).toISOString(),
        t.label,
        net.name,
        t.asset,
        variant,
        t.direction,
        categoryLabel(t, tracked),
        qty,
        price ?? '',
        price !== null ? (Number(qty) * price).toFixed(2) : '',
        t.price_override !== null ? 'manual' : (t.price_source ?? ''),
        fee,
        net.native.asset,
        t.charge_fee ? 'yes' : 'no',
        feeUsd !== null ? feeUsd.toFixed(4) : '',
        t.status,
        t.block_height ?? '',
        t.counterparty ?? '',
        meta.syntheticTxid ? '' : t.txid,
        meta.syntheticTxid ? '' : net.explorer.tx(t.txid),
        t.note ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
