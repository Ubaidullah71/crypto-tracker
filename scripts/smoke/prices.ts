/** Live check of the price service: node scripts/smoke/prices.ts */
import { setConfigForTests } from '../../src/config.ts';
import { openDb } from '../../src/db/database.ts';
import { getPriceService } from '../../src/prices/prices.ts';

setConfigForTests({});
openDb(':memory:');
const ps = getPriceService();
const quotes = await ps.getQuotes();
for (const q of quotes.values()) console.log(q.asset.padEnd(5), String(q.price).padEnd(14), `24h ${q.change24hPct?.toFixed(2)}%`, q.source);
const checks: Array<[string, number]> = [
  ['BTC', 1_451_692_800],
  ['LTC', 1_762_700_040], // 2025-11-09
  ['POL', 1_700_000_000], // 2023-11 (MATIC era)
  ['SOL', 1_600_000_000],
  ['XRP', 1_500_000_000], // 2017 (before Binance XRPUSDT)
  ['USDC', 1_650_000_000],
  ['BNB', 1_620_000_000],
];
for (const [a, t] of checks) {
  const p = await ps.getHistoricalPrice(a as never, t);
  console.log('hist', a, new Date(t * 1000).toISOString().slice(0, 16), p);
}
