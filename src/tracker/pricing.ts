import type { AssetId } from '../core/assets.ts';
import { NETWORKS } from '../core/networks.ts';
import { transfers, type TransferRow } from '../db/repo.ts';
import { createLogger } from '../logger.ts';
import { getPriceService } from '../prices/prices.ts';
import { mapLimit, nowSec } from '../util/async.ts';

const log = createLogger('pricing');

/** Fills price_usd (and the fee asset price) for transfers that have none yet. */
export async function priceRows(rows: TransferRow[]): Promise<number> {
  const ps = getPriceService();
  let done = 0;

  // Bulk-download hourly candles for every coin and time span involved (a few requests per
  // coin instead of one per transaction).
  const spans = new Map<AssetId, { from: number; to: number }>();
  const widen = (asset: AssetId, time: number) => {
    const s = spans.get(asset);
    if (!s) spans.set(asset, { from: time, to: time });
    else {
      s.from = Math.min(s.from, time);
      s.to = Math.max(s.to, time);
    }
  };
  for (const t of rows) {
    if (t.price_usd !== null) continue;
    const time = t.block_time ?? t.first_seen_at;
    if (!t.backfilled && nowSec() - time < 600) continue;
    widen(t.asset, time);
    if (t.fee && t.fee !== '0') widen(NETWORKS[t.network].native.asset, time);
  }
  for (const [asset, s] of spans) {
    try {
      await ps.prefetchHourly(asset, s.from, s.to);
    } catch (err) {
      log.debug(`hourly price prefetch failed for ${asset}; using per-transaction lookups`, err);
    }
  }

  await mapLimit(rows, 4, async (t) => {
    if (t.price_usd !== null) return;
    const time = t.block_time ?? t.first_seen_at;
    const live = !t.backfilled && nowSec() - time < 600;
    try {
      const p = live
        ? await ps.getPrice(t.asset).then((x) => (x === null ? null : { price: x, source: 'live' }))
        : await ps.getHistoricalPrice(t.asset, time);
      if (!p) {
        // No market data exists for that time: stop retrying (the user can still set a price manually).
        if (!live) transfers.markPriceUnavailable(t.id);
        return;
      }
      let feePrice: number | null = null;
      if (t.fee && t.fee !== '0') {
        const nativeAsset = NETWORKS[t.network].native.asset;
        // getHistoricalPrice uses the live quote for recent times and THROWS when prices are
        // temporarily unavailable, so the whole row is retried later instead of saving a missing
        // fee price forever. A definitive "no market data" becomes 0 (unknown value).
        feePrice = nativeAsset === t.asset ? p.price : ((await ps.getHistoricalPrice(nativeAsset, time))?.price ?? 0);
      }
      transfers.setPrice(t.id, p.price, p.source, feePrice);
      done++;
    } catch (err) {
      log.debug(`price lookup failed for transfer ${t.id}`, err);
    }
  });
  return done;
}

export async function priceIds(ids: number[]): Promise<void> {
  const rows: TransferRow[] = [];
  for (const id of ids) {
    const t = transfers.get(id);
    if (t && t.price_usd === null) rows.push(t);
  }
  if (rows.length) await priceRows(rows);
}

let running = false;

/** Background job: prices historical (imported) transfers in batches. */
export async function priceBacklog(maxRows = 2000): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    const rows = transfers.unpriced(maxRows);
    if (!rows.length) return 0;
    const n = await priceRows(rows);
    if (n) log.info(`priced ${n}/${rows.length} transfers`);
    return n;
  } finally {
    running = false;
  }
}
