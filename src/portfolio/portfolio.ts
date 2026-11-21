import { ASSET_IDS, ASSETS, type AssetId } from '../core/assets.ts';
import { toNumber } from '../core/amount.ts';
import { getNetworkAsset, NETWORKS, type NetworkId } from '../core/networks.ts';
import { balances, transfers, walletNetworks, type TransferRow, type TransferWithWallet, type WalletNetworkJoined } from '../db/repo.ts';
import { getPriceService, type Quote } from '../prices/prices.ts';
import { buildEffectiveMap, buildTrackedIndex, type TrackedIndex } from './classify.ts';
import { avgCost, runLedger, type AssetBook, type LedgerInput, type LedgerResult } from './ledger.ts';

export interface HoldingSlice {
  key: string;
  label: string;
  qty: number;
  value: number;
}

export interface Holding {
  asset: AssetId;
  qty: number;
  price: number | null;
  value: number;
  change24hPct: number | null;
  change24hUsd: number;
  avgCost: number | null;
  costBasis: number | null;
  unrealized: number | null;
  unrealizedPct: number | null;
  realized: number;
  totalPnl: number | null;
  /** Historical prices for this coin are still being filled in (P/L not shown yet). */
  pricing: boolean;
  allocationPct: number;
  byNetwork: HoldingSlice[];
  byWallet: HoldingSlice[];
  book: AssetBook | null;
  /** Live balance minus ledger quantity (non-zero when history is incomplete or still importing). */
  discrepancy: number;
}

export interface Portfolio {
  holdings: Holding[];
  totalValue: number;
  change24hUsd: number;
  change24hPct: number | null;
  costBasis: number;
  unrealized: number;
  realized: number;
  totalPnl: number;
  totalPnlPct: number | null;
  /** Coins whose P/L is hidden while historical prices are filled in. */
  pricingCoins: number;
  feesUsd: number;
  walletCount: number;
  importing: number;
  unpriced: number;
  quotes: Map<AssetId, Quote>;
  pricedAt: number;
  ledger: LedgerResult;
  tracked: TrackedIndex;
}

export function trackedIndex(wns: WalletNetworkJoined[] = walletNetworks.all()): TrackedIndex {
  const rows: Array<{ network: WalletNetworkJoined['network']; address: string }> = wns.map((w) => ({
    network: w.network,
    address: w.address,
  }));
  // Account keys (xpub): their derived addresses are listed by the adapter in the cursor.
  for (const w of wns) {
    if (!w.cursor || !w.cursor.includes('ownAddresses')) continue;
    try {
      const own = (JSON.parse(w.cursor) as { ownAddresses?: unknown }).ownAddresses;
      if (Array.isArray(own)) for (const a of own) if (typeof a === 'string') rows.push({ network: w.network, address: a });
    } catch {
      /* ignore malformed cursor */
    }
  }
  return buildTrackedIndex(rows);
}

/** Effective USD price used for accounting: manual override, else market price at the time. */
export function effectivePrice(t: Pick<TransferRow, 'price_override' | 'price_usd'>): number | null {
  return t.price_override ?? t.price_usd ?? null;
}

/**
 * Ledger inputs for every transfer:
 *  - how each row counts comes from pairing (see buildEffectiveMap),
 *  - time is made non-decreasing along block height per network (Bitcoin/Litecoin block
 *    timestamps may go backwards between consecutive blocks), so rows follow chain order.
 */
export function toLedgerInputs(rows: TransferWithWallet[]): LedgerInput[] {
  const effective = buildEffectiveMap(rows);
  const chainTime = new Map<number, number>();
  const byNetwork = new Map<string, TransferWithWallet[]>();
  for (const t of rows) {
    const list = byNetwork.get(t.network);
    if (list) list.push(t);
    else byNetwork.set(t.network, [t]);
  }
  for (const list of byNetwork.values()) {
    const ordered = [...list].sort(
      (a, b) =>
        (a.block_height ?? Number.MAX_SAFE_INTEGER) - (b.block_height ?? Number.MAX_SAFE_INTEGER) ||
        (a.block_time ?? a.first_seen_at) - (b.block_time ?? b.first_seen_at),
    );
    let running = 0;
    for (const t of ordered) {
      running = Math.max(running, t.block_time ?? t.first_seen_at);
      chainTime.set(t.id, running);
    }
  }
  const out: LedgerInput[] = [];
  for (const t of rows) {
    const e = effective.get(t.id)!;
    const native = NETWORKS[t.network].native;
    let fee: LedgerInput['fee'] = null;
    if (t.charge_fee && t.fee && t.fee !== '0') {
      fee = { asset: native.asset, qty: toNumber(BigInt(t.fee), native.decimals), price: t.fee_price_usd };
    }
    const price = effectivePrice(t);
    out.push({
      id: t.id,
      asset: t.asset,
      time: chainTime.get(t.id) ?? t.block_time ?? t.first_seen_at,
      network: t.network,
      height: t.block_height,
      effective: e.effective,
      category: t.category,
      qty: e.qty,
      price,
      ...(price === null ? { priceMissing: t.price_source === 'unavailable' ? ('none' as const) : ('pending' as const) } : {}),
      fee,
    });
  }
  return out;
}

export function computeLedger(): LedgerResult {
  return runLedger(toLedgerInputs(transfers.forLedger()));
}

export async function buildPortfolio(opts: { forceQuotes?: boolean } = {}): Promise<Portfolio> {
  const wns = walletNetworks.all();
  const tracked = trackedIndex(wns);
  const ledger = computeLedger();
  const quotes = await getPriceService().getQuotes(opts.forceQuotes);
  const wnById = new Map(wns.map((w) => [w.id, w]));

  // Live balances aggregated per asset, network and wallet.
  const qtyByAsset = new Map<AssetId, number>();
  const byNetwork = new Map<AssetId, Map<string, HoldingSlice>>();
  const byWallet = new Map<AssetId, Map<string, HoldingSlice>>();
  for (const b of balances.all()) {
    const wn = wnById.get(b.wallet_network_id);
    const na = getNetworkAsset(b.asset_key);
    if (!wn || !na) continue;
    let qty: number;
    try {
      qty = toNumber(BigInt(b.amount), na.decimals);
    } catch {
      continue;
    }
    if (qty === 0) continue;
    const price = quotes.get(na.asset)?.price ?? 0;
    qtyByAsset.set(na.asset, (qtyByAsset.get(na.asset) ?? 0) + qty);

    const nk = `${na.network}:${na.label ?? na.asset}`;
    const nmap = byNetwork.get(na.asset) ?? new Map<string, HoldingSlice>();
    byNetwork.set(na.asset, nmap);
    const ns = nmap.get(nk) ?? {
      key: nk,
      label: na.label && na.label !== na.asset ? `${NETWORKS[na.network].name} (${na.label})` : NETWORKS[na.network].name,
      qty: 0,
      value: 0,
    };
    ns.qty += qty;
    ns.value += qty * price;
    nmap.set(nk, ns);

    const wk = String(wn.wallet_id);
    const wmap = byWallet.get(na.asset) ?? new Map<string, HoldingSlice>();
    byWallet.set(na.asset, wmap);
    const ws = wmap.get(wk) ?? { key: wk, label: wn.label, qty: 0, value: 0 };
    ws.qty += qty;
    ws.value += qty * price;
    wmap.set(wk, ws);
  }

  const holdings: Holding[] = [];
  for (const asset of ASSET_IDS) {
    const qty = qtyByAsset.get(asset) ?? 0;
    const book = ledger.books.get(asset) ?? null;
    if (qty === 0 && !book) continue;
    const q = quotes.get(asset);
    const price = q?.price ?? null;
    const value = qty * (price ?? 0);
    // While historical prices are still being looked up, cost-based numbers would be wrong.
    const pricing = (book?.unpriced ?? 0) > 0;
    const avg = book && !pricing ? avgCost(book) : null;
    const costBasis = avg !== null ? avg * qty : null;
    const unrealized = costBasis !== null && price !== null ? value - costBasis : null;
    const realized = book?.realized ?? 0;
    const change = q?.change24hPct ?? null;
    const change24hUsd = change !== null ? value - value / (1 + change / 100) : 0;
    if (qty === 0 && Math.abs(realized) < 0.005) continue;
    holdings.push({
      asset,
      qty,
      price,
      value,
      change24hPct: change,
      change24hUsd,
      avgCost: avg,
      costBasis,
      unrealized,
      unrealizedPct: unrealized !== null && costBasis !== null && costBasis >= 0.01 ? (unrealized / costBasis) * 100 : null,
      realized,
      totalPnl: unrealized !== null ? unrealized + realized : pricing ? null : realized || null,
      pricing,
      allocationPct: 0,
      byNetwork: [...(byNetwork.get(asset)?.values() ?? [])].sort((a, b) => b.value - a.value),
      byWallet: [...(byWallet.get(asset)?.values() ?? [])].sort((a, b) => b.value - a.value),
      book,
      discrepancy: qty - (book?.qty ?? 0),
    });
  }

  const totalValue = holdings.reduce((s, h) => s + h.value, 0);
  for (const h of holdings) h.allocationPct = totalValue > 0 ? (h.value / totalValue) * 100 : 0;
  holdings.sort((a, b) => b.value - a.value || Math.abs(b.realized) - Math.abs(a.realized));

  const change24hUsd = holdings.reduce((s, h) => s + h.change24hUsd, 0);
  // Only coins with both a cost and a live price count, so Invested and P/L describe the same set.
  const costBasis = holdings.reduce((s, h) => s + (h.unrealized !== null ? (h.costBasis ?? 0) : 0), 0);
  const unrealized = holdings.reduce((s, h) => s + (h.unrealized ?? 0), 0);
  // One rule everywhere (overview, /report, CSV): all realized results, flagged while pricing.
  const realized = [...ledger.books.values()].reduce((s, b) => s + b.realized, 0);
  const feesUsd = [...ledger.books.values()].reduce((s, b) => s + b.feesUsd, 0);
  const totalPnl = unrealized + realized;

  return {
    holdings,
    totalValue,
    change24hUsd,
    change24hPct: totalValue - change24hUsd > 0 ? (change24hUsd / (totalValue - change24hUsd)) * 100 : null,
    costBasis,
    unrealized,
    realized,
    totalPnl,
    // Unrealized return on what the current holdings cost.
    totalPnlPct: costBasis >= 0.01 ? (unrealized / costBasis) * 100 : null,
    pricingCoins: holdings.filter((h) => h.pricing).length,
    feesUsd,
    walletCount: new Set(wns.map((w) => w.wallet_id)).size,
    importing: wns.filter((w) => w.backfill_status === 'pending' || w.backfill_status === 'running').length,
    unpriced: transfers.countUnpriced(),
    quotes,
    pricedAt: getPriceService().lastUpdated(),
    ledger,
    tracked,
  };
}

export interface WalletAssetBalance {
  network: NetworkId;
  assetKey: string;
  asset: AssetId;
  label: string;
  amount: bigint;
  decimals: number;
  qty: number;
  value: number;
}

/** Live balances for one wallet across its networks. */
export async function walletBalances(walletId: number): Promise<{ items: WalletAssetBalance[]; total: number }> {
  const quotes = await getPriceService().getQuotes();
  const items: WalletAssetBalance[] = [];
  for (const wn of walletNetworks.forWallet(walletId)) {
    for (const b of balances.forWalletNetwork(wn.id)) {
      const na = getNetworkAsset(b.asset_key);
      if (!na) continue;
      let amount: bigint;
      try {
        amount = BigInt(b.amount);
      } catch {
        continue;
      }
      const qty = toNumber(amount, na.decimals);
      items.push({
        network: wn.network,
        assetKey: na.key,
        asset: na.asset,
        label: na.label ?? ASSETS[na.asset].symbol,
        amount,
        decimals: na.decimals,
        qty,
        value: qty * (quotes.get(na.asset)?.price ?? 0),
      });
    }
  }
  items.sort((a, b) => b.value - a.value || b.qty - a.qty);
  return { items, total: items.reduce((s, i) => s + i.value, 0) };
}
