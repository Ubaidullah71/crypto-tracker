import type { EmbedBuilder } from 'discord.js';
import { ASSET_IDS, ASSETS, type AssetId } from '../../core/assets.ts';
import { toNumber } from '../../core/amount.ts';
import { getNetworkAsset, NETWORKS, type NetworkId } from '../../core/networks.ts';
import { transfers, walletNetworks, type SnapshotRow, type TransferWithWallet } from '../../db/repo.ts';
import { categoryLabel, type TrackedIndex } from '../../portfolio/classify.ts';
import type { Holding, Portfolio } from '../../portfolio/portfolio.ts';
import { effectivePrice } from '../../portfolio/portfolio.ts';
import type { FlowReport } from '../../portfolio/reports.ts';
import type { Quote } from '../../prices/prices.ts';
import { pct, plural, pnl, price, qty, signedUsd, ts, usd, usdShort } from '../../util/format.ts';
import { table } from '../../util/table.ts';
import { base, coinIcon, COLORS, fieldValue, footer, safe, txLink } from '../theme.ts';

// --- helpers ---

function pnlColor(v: number): number {
  return v > 0.005 ? COLORS.success : v < -0.005 ? COLORS.danger : COLORS.brand;
}

/** Short network names that fit table columns. */
export const NET_SHORT: Record<NetworkId, string> = {
  bitcoin: 'Bitcoin',
  litecoin: 'Litecoin',
  ethereum: 'Ethereum',
  bsc: 'BNB Chain',
  polygon: 'Polygon',
  base: 'Base',
  solana: 'Solana',
  xrp: 'XRP Ledger',
};

/** "Up $123.45 (+1.01%) in the last 24 hours" */
function changeSentence(usdChange: number, pctChange: number | null): string {
  if (Math.abs(usdChange) < 0.005) return 'No change in the last 24 hours';
  const dir = usdChange > 0 ? 'Up' : 'Down';
  const p = pctChange !== null ? ` (${pct(pctChange)})` : '';
  return `${dir} ${usd(Math.abs(usdChange))}${p} in the last 24 hours`;
}

function statusNotes(p: Portfolio): string[] {
  const out: string[] = [];
  if (p.importing) out.push(`Importing history for ${plural(p.importing, 'wallet network')}. Profit/loss will update when it finishes.`);
  if (p.unpriced)
    out.push(`Looking up historical prices for ${plural(p.unpriced, 'transaction')}. Coins marked "pricing" show profit/loss once done.`);
  return out;
}

function sourceName(p: { quotes: Map<AssetId, Quote> }): string {
  const src = [...p.quotes.values()].find((q) => q.source !== 'peg')?.source;
  return src === 'coingecko' ? 'CoinGecko' : src === 'binance' ? 'Binance' : 'n/a';
}

function visibleHoldings(p: Portfolio): Holding[] {
  return p.holdings.filter((h) => h.value >= 0.01);
}

// --- overview ---

export function overviewEmbed(p: Portfolio): EmbedBuilder {
  const e = base(pnlColor(p.change24hUsd)).setTitle('Portfolio Overview');
  e.setDescription(['Total Value', `# ${usd(p.totalValue)}`, changeSentence(p.change24hUsd, p.change24hPct)].join('\n'));

  const held = visibleHoldings(p);
  if (!held.length) {
    e.addFields({
      name: 'Holdings',
      value: p.walletCount
        ? 'No balances yet. New wallets can take a minute to sync.'
        : 'No wallets yet. Add them to wallets.txt or use `/wallet add`.',
    });
    return footer(e, `Prices: ${sourceName(p)}`).setTimestamp(new Date());
  }

  const partial = p.pricingCoins > 0 ? '\n(some coins still pricing)' : '';
  e.addFields(
    { name: 'Invested', value: `${usd(p.costBasis)}${partial}`, inline: true },
    { name: 'Profit/Loss', value: pnl(p.unrealized, p.totalPnlPct), inline: true },
    { name: 'Realized', value: `${signedUsd(p.realized)}${p.pricingCoins > 0 ? '\n(provisional)' : ''}`, inline: true },
  );

  e.addFields({
    name: 'Holdings',
    value: fieldValue(
      table(
        [
          { header: 'COIN', max: 5 },
          { header: 'VALUE', align: 'right' },
          { header: 'SHARE', align: 'right' },
          { header: '24H', align: 'right' },
        ],
        held.map((h) => [h.asset, usd(h.value), `${h.allocationPct.toFixed(1)}%`, pct(h.change24hPct, 1)]),
      ),
    ),
  });

  const pl = held.filter((h) => !ASSETS[h.asset].stablecoin);
  if (pl.length) {
    e.addFields({
      name: 'Profit / Loss',
      value: fieldValue(
        table(
          [
            { header: 'COIN', max: 5 },
            { header: 'AVG BUY', align: 'right' },
            { header: 'P/L', align: 'right' },
            { header: '%', align: 'right' },
          ],
          pl.map((h) =>
            h.pricing
              ? [h.asset, 'pricing', '', '']
              : [
                  h.asset,
                  h.avgCost !== null ? usdShort(h.avgCost) : 'n/a',
                  usdShort(h.unrealized, true),
                  h.unrealizedPct !== null ? pct(h.unrealizedPct, 1) : '',
                ],
          ),
        ) + '\nStablecoins are not listed here (they stay at about $1).',
      ),
    });
  }

  const notes = statusNotes(p);
  if (notes.length) e.addFields({ name: 'Status', value: fieldValue(notes.join('\n')) });
  return footer(e, `Prices: ${sourceName(p)}  |  Average cost method`).setTimestamp(p.pricedAt ? new Date(p.pricedAt) : new Date());
}

// --- by wallet / network ---

export function byWalletEmbed(p: Portfolio): EmbedBuilder {
  const e = base(COLORS.brand)
    .setTitle('Portfolio by Wallet')
    .setDescription(['Total Value', `# ${usd(p.totalValue)}`].join('\n'));
  const totals = new Map<string, { label: string; value: number; coins: Set<string> }>();
  for (const h of p.holdings) {
    for (const w of h.byWallet) {
      const t = totals.get(w.key) ?? { label: w.label, value: 0, coins: new Set<string>() };
      t.value += w.value;
      if (w.value >= 0.01) t.coins.add(h.asset);
      totals.set(w.key, t);
    }
  }
  const rows = [...totals.values()].filter((w) => w.value >= 0.01).sort((a, b) => b.value - a.value);
  if (!rows.length) {
    e.addFields({ name: 'Wallets', value: 'No balances yet.' });
    return footer(e).setTimestamp(new Date());
  }
  e.addFields({
    name: 'Wallets',
    value: fieldValue(
      table(
        [
          { header: 'WALLET', max: 14 },
          { header: 'VALUE', align: 'right' },
          { header: 'SHARE', align: 'right' },
        ],
        rows.map((w) => [w.label, usd(w.value), p.totalValue > 0 ? `${((w.value / p.totalValue) * 100).toFixed(1)}%` : '']),
      ),
    ),
  });
  e.addFields({
    name: 'Coins per Wallet',
    value: fieldValue(rows.map((w) => `**${safe(w.label, 40)}**: ${[...w.coins].join(', ') || 'none'}`).join('\n')),
  });
  return footer(e, 'Use /wallet view for one wallet in detail').setTimestamp(new Date());
}

export function byNetworkEmbed(p: Portfolio): EmbedBuilder {
  const e = base(COLORS.brand)
    .setTitle('Portfolio by Network')
    .setDescription(['Total Value', `# ${usd(p.totalValue)}`].join('\n'));
  const nets = new Map<NetworkId, number>();
  const detail: Array<{ net: NetworkId; coin: string; value: number }> = [];
  for (const h of p.holdings) {
    for (const s of h.byNetwork) {
      const net = s.key.split(':')[0] as NetworkId;
      if (!(net in NETWORKS) || s.value < 0.01) continue;
      nets.set(net, (nets.get(net) ?? 0) + s.value);
      const variant = /\((.*)\)$/.exec(s.label)?.[1];
      detail.push({ net, coin: variant ?? h.asset, value: s.value });
    }
  }
  const rows = [...nets.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    e.addFields({ name: 'Networks', value: 'No balances yet.' });
    return footer(e).setTimestamp(new Date());
  }
  e.addFields({
    name: 'Networks',
    value: fieldValue(
      table(
        [
          { header: 'NETWORK', max: 12 },
          { header: 'VALUE', align: 'right' },
          { header: 'SHARE', align: 'right' },
        ],
        rows.map(([n, v]) => [NET_SHORT[n], usd(v), p.totalValue > 0 ? `${((v / p.totalValue) * 100).toFixed(1)}%` : '']),
      ),
    ),
  });
  detail.sort((a, b) => b.value - a.value);
  e.addFields({
    name: 'Coins per Network',
    value: fieldValue(
      table(
        [
          { header: 'NETWORK', max: 10 },
          { header: 'COIN', max: 7 },
          { header: 'VALUE', align: 'right' },
        ],
        detail.slice(0, 25).map((d) => [NET_SHORT[d.net], d.coin, usd(d.value)]),
      ),
    ),
  });
  return footer(e, `Prices: ${sourceName(p)}`).setTimestamp(new Date());
}

// --- activity ---

/**
 * Two readable lines per transaction:
 *   Received 5.7604 LTC ($300.01) to LTC Exodus
 *   November 9, 2026 9:06 PM, 9f2c1e7a...4e5f6a7b
 */
export function transferLine(t: TransferWithWallet, tracked: TrackedIndex, withWallet = true): string {
  const na = getNetworkAsset(t.asset_key);
  const sym = na?.label ?? t.asset;
  const amountNum = toNumber(BigInt(t.amount), t.decimals);
  const p = effectivePrice(t);
  const value = p !== null ? ` (${usd(amountNum * p)})` : '';
  const status = t.status === 'pending' ? ' (pending)' : t.status === 'failed' ? ' (failed)' : '';
  const where = withWallet ? ` ${t.direction === 'in' ? 'to' : 'from'} ${safe(t.label, 40)}` : '';
  const line1 = `**${categoryLabel(t, tracked)} ${qty(amountNum, ASSETS[t.asset].stablecoin)} ${sym}**${value}${where}${status}`;
  return `${line1}\n${ts(t.block_time ?? t.first_seen_at, 'f')}, ${txLink(t.network, t.txid, true)}`;
}

// --- coin ---

export function coinEmbed(asset: AssetId, h: Holding | undefined, q: Quote | undefined, p: Portfolio): EmbedBuilder {
  const info = ASSETS[asset];
  const e = base(info.color)
    .setAuthor({ name: info.name, iconURL: coinIcon(asset) })
    .setTitle(`${info.name} (${info.symbol})`);
  const desc = [`# ${price(q?.price ?? null)}`, `24 hours: ${pct(q?.change24hPct)}     7 days: ${pct(q?.change7dPct)}`];
  if (q?.high24h && q.low24h) desc.push(`Today's range: ${price(q.low24h)} to ${price(q.high24h)}`);
  e.setDescription(desc.join('\n'));
  if (!h) {
    e.addFields({ name: 'Holdings', value: `You do not hold any ${info.symbol} in tracked wallets.` });
    return footer(e).setTimestamp(new Date());
  }
  const b = h.book;
  const stable = info.stablecoin;
  e.addFields(
    { name: 'Holding', value: `${qty(h.qty, stable)} ${info.symbol}`, inline: true },
    { name: 'Value', value: usd(h.value), inline: true },
    { name: 'Share of Portfolio', value: `${h.allocationPct.toFixed(1)}%`, inline: true },
  );
  if (h.pricing) {
    e.addFields({ name: 'Profit/Loss', value: `Calculating: ${plural(b?.unpriced ?? 0, 'transaction')} still need a historical price.` });
  } else {
    e.addFields(
      { name: 'Average Buy Price', value: price(h.avgCost), inline: true },
      { name: 'Invested', value: usd(h.costBasis), inline: true },
      { name: 'Profit/Loss', value: pnl(h.unrealized, h.unrealizedPct), inline: true },
      { name: 'Realized Profit/Loss', value: signedUsd(h.realized), inline: true },
      {
        name: 'Total Received',
        value: b ? `${qty(b.acquiredQty, stable)} ${info.symbol}\n${usd(b.acquiredUsd)} at the time` : 'n/a',
        inline: true,
      },
      {
        name: 'Total Sent',
        value: b ? `${qty(b.disposedQty, stable)} ${info.symbol}\n${usd(b.proceedsUsd)} at the time` : 'n/a',
        inline: true,
      },
    );
  }
  if (h.byWallet.length) {
    e.addFields({
      name: 'By Wallet',
      value: fieldValue(
        table(
          [
            { header: 'WALLET', max: 14 },
            { header: 'AMOUNT', align: 'right' },
            { header: 'VALUE', align: 'right' },
          ],
          h.byWallet.map((s) => [s.label, qty(s.qty, stable), usdShort(s.value)]),
        ),
      ),
    });
  }
  if (h.byNetwork.length > 1) {
    e.addFields({
      name: 'By Network',
      value: fieldValue(
        table(
          [
            { header: 'NETWORK', max: 16 },
            { header: 'AMOUNT', align: 'right' },
          ],
          h.byNetwork.map((s) => [s.label.replace('BNB Smart Chain', 'BNB Chain'), qty(s.qty, stable)]),
        ),
      ),
    });
  }
  if (b && b.feesQty > 0) e.addFields({ name: 'Network Fees Paid', value: `${qty(b.feesQty)} ${info.symbol} (${usd(b.feesUsd)})` });
  const notes: string[] = [];
  if (b && b.noPrice > 0)
    notes.push(`${plural(b.noPrice, 'transaction')} have no market price for their date and count as $0. Set a price with \`/tx edit\`.`);
  if (Math.abs(h.discrepancy) > 1e-9 && b && !h.pricing) {
    notes.push(
      p.importing
        ? 'The history import is still running, so the average price may change.'
        : `The on-chain balance differs from the imported history by ${qty(h.discrepancy, stable)} ${info.symbol}; some very old or unsupported transfers may be missing.`,
    );
  }
  if (notes.length) e.addFields({ name: 'Note', value: fieldValue(notes.join('\n')) });
  const recent = transfers.list({ asset }, 5, 0);
  if (recent.length)
    e.addFields({ name: 'Recent Activity', value: fieldValue(recent.map((t) => transferLine(t, p.tracked)).join('\n\n')) });
  return footer(e, 'Average cost method').setTimestamp(new Date());
}

// --- prices ---

export function pricesEmbed(quotes: Map<AssetId, Quote>): EmbedBuilder {
  const e = base(COLORS.brand).setTitle('Market Prices');
  e.setDescription(
    table(
      [{ header: 'COIN' }, { header: 'PRICE', align: 'right' }, { header: '24H', align: 'right' }, { header: '7D', align: 'right' }],
      ASSET_IDS.map((a) => {
        const q = quotes.get(a);
        return [a, price(q?.price ?? null), pct(q?.change24hPct, 1), pct(q?.change7dPct, 1)];
      }),
    ),
  );
  return footer(e, `Source: ${sourceName({ quotes })}  |  /coin for details`).setTimestamp(new Date());
}

// --- reports ---

function flowTable(flows: FlowReport['incoming']): string {
  return table(
    [{ header: 'COIN' }, { header: 'AMOUNT', align: 'right' }, { header: 'VALUE', align: 'right' }, { header: 'TX', align: 'right' }],
    flows.map((f) => [f.asset, qty(f.qty, ASSETS[f.asset].stablecoin), usdShort(f.usd), String(f.count)]),
  );
}

export function flowReportEmbed(r: FlowReport, title: string, periodLabel: string): EmbedBuilder {
  const e = base(COLORS.brand)
    .setTitle(title)
    .setDescription(
      `**${periodLabel}**, ${ts(r.from || null, 'D')} to ${ts(r.to - 1, 'D')}\nAll values are in USD at the time of each transaction.`,
    );
  e.addFields(
    { name: 'Money In', value: `${usd(r.incomingUsd)}\n${plural(r.incomingCount, 'transaction')}`, inline: true },
    { name: 'Money Out', value: `${usd(r.outgoingUsd)}\n${plural(r.outgoingCount, 'transaction')}`, inline: true },
    { name: 'Net Flow', value: signedUsd(r.incomingUsd - r.outgoingUsd), inline: true },
    { name: 'Realized Profit/Loss', value: `${signedUsd(r.realized)}${r.realizedProvisional ? '\n(provisional)' : ''}`, inline: true },
    { name: 'Network Fees', value: usd(r.feesUsd), inline: true },
    { name: 'Own-Wallet Moves', value: plural(r.internalCount, 'transfer'), inline: true },
  );
  if (r.incomingByCategory.length) {
    e.addFields({
      name: 'Incoming by Type',
      value: fieldValue(r.incomingByCategory.map((c) => `${c.label}: **${usd(c.usd)}** (${plural(c.count, 'transaction')})`).join('\n')),
    });
  }
  if (r.incoming.length) e.addFields({ name: 'Incoming by Coin', value: fieldValue(flowTable(r.incoming)) });
  if (r.outgoing.length) e.addFields({ name: 'Outgoing by Coin', value: fieldValue(flowTable(r.outgoing)) });
  if (r.largestIncoming) {
    const t = r.largestIncoming;
    const amountNum = toNumber(BigInt(t.amount), t.decimals);
    const p = effectivePrice(t);
    e.addFields({
      name: 'Largest Incoming',
      value: `**${qty(amountNum, ASSETS[t.asset].stablecoin)} ${t.asset}**${p !== null ? ` (${usd(amountNum * p)})` : ''} to ${safe(t.label, 40)}\n${ts(t.block_time ?? t.first_seen_at, 'D')}, ${txLink(t.network, t.txid, true)}`,
    });
  }
  if (r.unpriced)
    e.addFields({ name: 'Note', value: `${plural(r.unpriced, 'transaction')} in this period have no price yet and count as $0.` });
  return footer(e, '/export transactions for the full CSV').setTimestamp(new Date());
}

export function dailySummaryEmbed(p: Portfolio, prev: SnapshotRow | undefined, day: FlowReport): EmbedBuilder {
  const e = base(pnlColor(p.change24hUsd)).setTitle('Daily Portfolio Summary');
  const desc = ['Total Value', `# ${usd(p.totalValue)}`, changeSentence(p.change24hUsd, p.change24hPct)];
  if (prev) {
    const diff = p.totalValue - prev.total_value;
    desc.push(
      `Since ${prev.day}: ${signedUsd(diff)}${prev.total_value > 0 ? ` (${pct((diff / prev.total_value) * 100)})` : ''}, including deposits and withdrawals`,
    );
  }
  e.setDescription(desc.join('\n'));
  e.addFields(
    { name: 'Received (24h)', value: `${usd(day.incomingUsd)}\n${plural(day.incomingCount, 'transaction')}`, inline: true },
    { name: 'Sent (24h)', value: `${usd(day.outgoingUsd)}\n${plural(day.outgoingCount, 'transaction')}`, inline: true },
    { name: 'Profit/Loss', value: pnl(p.unrealized, p.totalPnlPct), inline: true },
  );
  const held = visibleHoldings(p).filter((h) => h.value >= 1);
  if (held.length) {
    e.addFields({
      name: 'Holdings',
      value: fieldValue(
        table(
          [
            { header: 'COIN', max: 5 },
            { header: 'VALUE', align: 'right' },
            { header: '24H', align: 'right' },
            { header: 'P/L', align: 'right' },
          ],
          held.map((h) => [h.asset, usdShort(h.value), pct(h.change24hPct, 1), h.pricing ? 'pricing' : usdShort(h.unrealized, true)]),
        ),
      ),
    });
    const mover = [...held]
      .filter((h) => h.change24hPct !== null && !ASSETS[h.asset].stablecoin)
      .sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!))[0];
    if (mover)
      e.addFields({
        name: 'Biggest Mover',
        value: `${ASSETS[mover.asset].name}: ${pct(mover.change24hPct)} (${signedUsd(mover.change24hUsd)})`,
      });
  }
  if (day.incoming.length) e.addFields({ name: 'Received in the Last 24 Hours', value: fieldValue(flowTable(day.incoming)) });
  const errors = walletNetworks.all().filter((w) => w.consecutive_errors >= 10);
  if (errors.length) {
    e.addFields({
      name: 'Attention',
      value: fieldValue(
        errors
          .map((w) => `${safe(w.label, 40)} on ${NET_SHORT[w.network]} has failed to sync ${w.consecutive_errors} times in a row.`)
          .join('\n'),
      ),
    });
  }
  return footer(e, 'Change the time with /settings summary').setTimestamp(new Date());
}

/** Amount in base units as a readable coin string (used by other embeds). */
export function coinAmount(amount: string, decimals: number, asset: AssetId, label?: string): string {
  return `${qty(toNumber(BigInt(amount), decimals), ASSETS[asset].stablecoin)} ${label ?? asset}`;
}
