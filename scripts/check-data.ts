/**
 * Read-only accuracy check of the bot's database (safe while the bot is running):
 *
 *   npm run check-data            (uses DATABASE_PATH from .env, default ./data/portfolio.db)
 *
 * For every wallet network and coin it compares the stored transaction history with the live
 * on-chain balance the bot last fetched, and reports missing prices, implausible prices, history
 * imports that did not finish, and the resulting average cost / profit per coin.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ASSETS, type AssetId } from '../src/core/assets.ts';
import { formatUnits } from '../src/core/amount.ts';
import { getNetworkAsset, NETWORKS, type NetworkId } from '../src/core/networks.ts';
import type { TransferWithWallet } from '../src/db/repo.ts';
import { buildEffectiveMap } from '../src/portfolio/classify.ts';
import { avgCost, runLedger } from '../src/portfolio/ledger.ts';
import { toLedgerInputs } from '../src/portfolio/portfolio.ts';

if (existsSync('.env')) process.loadEnvFile('.env');
const path = resolve(process.argv[2] ?? process.env.DATABASE_PATH ?? './data/portfolio.db');
if (!existsSync(path)) {
  console.error(`No database at ${path}`);
  process.exit(1);
}
const db = new DatabaseSync(path, { readOnly: true });
const all = <T>(sql: string, ...p: Array<string | number>) => db.prepare(sql).all(...p) as T[];

interface Wn {
  id: number;
  wallet_id: number;
  network: NetworkId;
  label: string;
  address: string;
  backfill_status: string;
  backfill_error: string | null;
  consecutive_errors: number;
  cursor: string | null;
}
const wns = all<Wn>(
  `SELECT wn.*, w.label, w.address FROM wallet_networks wn JOIN wallets w ON w.id = wn.wallet_id ORDER BY w.label, wn.network`,
);
const rows = all<TransferWithWallet>(
  `SELECT t.*, w.id AS wallet_id, w.label, w.address FROM transfers t
   JOIN wallet_networks wn ON wn.id = t.wallet_network_id JOIN wallets w ON w.id = wn.wallet_id
   WHERE t.status != 'dropped' ORDER BY COALESCE(t.block_time, t.first_seen_at), t.id`,
);
const balances = all<{ wallet_network_id: number; asset_key: string; amount: string; updated_at: number }>('SELECT * FROM balances');

let problems = 0;
const flag = (msg: string) => {
  problems++;
  console.log(`  ! ${msg}`);
};

/* 1. History vs on-chain balance ------------------------------------------------------------ */
console.log('\n1. Imported history compared with the on-chain balance (per wallet, network and coin)\n');
for (const wn of wns) {
  const own = rows.filter((r) => r.wallet_network_id === wn.id);
  const sums = new Map<string, bigint>();
  const nativeKey = NETWORKS[wn.network].native.key;
  for (const t of own) {
    const amt = BigInt(t.amount);
    const delta = t.direction === 'in' ? amt : t.direction === 'out' ? -amt : 0n;
    sums.set(t.asset_key, (sums.get(t.asset_key) ?? 0n) + delta);
    if (t.charge_fee && t.fee) sums.set(nativeKey, (sums.get(nativeKey) ?? 0n) - BigInt(t.fee));
  }
  const status =
    wn.backfill_status === 'done'
      ? 'import done'
      : `import ${wn.backfill_status}${wn.backfill_error ? ` (${wn.backfill_error.slice(0, 80)})` : ''}`;
  console.log(`${wn.label} on ${NETWORKS[wn.network].name}: ${own.length} transactions, ${status}`);
  if (wn.backfill_status !== 'done') flag('history import not finished: balances below may not match yet');
  for (const b of balances.filter((x) => x.wallet_network_id === wn.id)) {
    const na = getNetworkAsset(b.asset_key);
    if (!na) continue;
    const live = BigInt(b.amount);
    const hist = sums.get(b.asset_key) ?? 0n;
    if (live === 0n && hist === 0n) continue;
    const diff = live - hist;
    const sym = na.label ?? na.asset;
    const line = `    ${sym.padEnd(14)} on-chain ${formatUnits(live, na.decimals).padStart(22)}   history ${formatUnits(hist, na.decimals).padStart(22)}`;
    if (diff === 0n) console.log(`${line}   exact`);
    else {
      console.log(`${line}   diff ${formatUnits(diff, na.decimals)}`);
      flag(`${wn.label} ${sym}: history differs from the balance by ${formatUnits(diff, na.decimals)} ${sym}`);
    }
  }
}

/* 2. Prices ------------------------------------------------------------------------------- */
console.log('\n2. Prices used for profit/loss\n');
const pending = rows.filter(
  (r) => r.price_usd === null && r.price_override === null && r.price_source !== 'unavailable' && r.amount !== '0',
);
const none = rows.filter((r) => r.price_usd === null && r.price_override === null && r.price_source === 'unavailable');
const overridden = rows.filter((r) => r.price_override !== null);
console.log(`  waiting for a price: ${pending.length}, no market price exists: ${none.length}, set by you: ${overridden.length}`);
if (pending.length) flag(`${pending.length} transactions still need a historical price (the bot fills them in the background)`);
if (none.length) flag(`${none.length} transactions have no market price for their date (they count as $0 cost; set one with /tx edit)`);

// Implausible prices: stablecoins outside 0.90-1.10, others more than 3x away from the median of
// the same coin within 30 days.
for (const r of rows) {
  if (r.price_usd === null) continue;
  if (ASSETS[r.asset].stablecoin && (r.price_usd < 0.9 || r.price_usd > 1.1)) flag(`${r.asset} priced at ${r.price_usd} in ${r.txid}`);
}
const byAsset = new Map<AssetId, Array<{ t: number; p: number; txid: string }>>();
for (const r of rows) {
  if (r.price_usd === null || ASSETS[r.asset].stablecoin) continue;
  const list = byAsset.get(r.asset) ?? [];
  list.push({ t: r.block_time ?? r.first_seen_at, p: r.price_usd, txid: r.txid });
  byAsset.set(r.asset, list);
}
for (const [asset, list] of byAsset) {
  for (const x of list) {
    const near = list
      .filter((y) => Math.abs(y.t - x.t) < 30 * 86400)
      .map((y) => y.p)
      .sort((a, b) => a - b);
    const median = near[Math.floor(near.length / 2)]!;
    if (near.length >= 3 && (x.p > median * 3 || x.p < median / 3))
      flag(`${asset} price ${x.p} far from nearby median ${median} (${x.txid})`);
  }
}

/* 3. Ledger ------------------------------------------------------------------------------- */
console.log('\n3. Average cost ledger per coin\n');
const ledger = runLedger(toLedgerInputs(rows));
const effective = buildEffectiveMap(rows);
const internal = rows.filter((r) => effective.get(r.id)?.effective === 'internal').length;
console.log(`  ${internal} transfers detected as moves between your own tracked wallets (no profit/loss)\n`);
// On-chain totals per coin across every wallet and network.
const onChain = new Map<AssetId, number>();
for (const b of balances) {
  const na = getNetworkAsset(b.asset_key);
  if (na) onChain.set(na.asset, (onChain.get(na.asset) ?? 0) + Number(formatUnits(BigInt(b.amount), na.decimals)));
}
console.log('  COIN       LEDGER QTY     ON-CHAIN QTY      AVG BUY      REALIZED   FEES USD  UNPRICED');
for (const b of [...ledger.books.values()].sort((a, c) => a.asset.localeCompare(c.asset))) {
  const avg = avgCost(b);
  const live = onChain.get(b.asset) ?? 0;
  console.log(
    `  ${b.asset.padEnd(5)}  ${b.qty.toFixed(8).padStart(15)}  ${live.toFixed(8).padStart(15)}  ${(avg === null ? 'n/a' : avg.toFixed(4)).padStart(11)}  ${b.realized.toFixed(2).padStart(12)}  ${b.feesUsd.toFixed(2).padStart(9)}  ${b.unpriced + b.noPrice}`,
  );
  if (b.qty < -1e-9) flag(`${b.asset}: ledger quantity is negative`);
  // The pooled average-cost ledger must hold exactly what the wallets hold (when history is complete).
  if (Math.abs(b.qty - live) > Math.max(1e-8, live * 1e-9)) flag(`${b.asset}: ledger holds ${b.qty} but the wallets hold ${live}`);
}

/* 4. Sync health -------------------------------------------------------------------------- */
console.log('\n4. Sync health\n');
for (const wn of wns) if (wn.consecutive_errors >= 3) flag(`${wn.label} on ${wn.network}: ${wn.consecutive_errors} failed syncs in a row`);
const stale = balances.filter((b) => Date.now() / 1000 - b.updated_at > 3600).length;
if (stale) flag(`${stale} balances were last refreshed over an hour ago (is the bot running?)`);

console.log(
  problems
    ? `\n${problems} item(s) need attention (see "!" lines).`
    : '\nEverything checks out: history matches the on-chain balances and every transaction is priced.',
);
db.close();
