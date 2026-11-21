import { ASSET_IDS, ASSETS, type AssetId } from '../core/assets.ts';
import { getDb } from '../db/database.ts';
import { assetMeta, priceCache } from '../db/repo.ts';
import { createLogger } from '../logger.ts';
import { HttpError, httpJson } from '../util/http.ts';

const log = createLogger('prices');

export interface Quote {
  asset: AssetId;
  price: number;
  change24hPct: number | null;
  change7dPct: number | null;
  high24h: number | null;
  low24h: number | null;
  marketCap: number | null;
  image: string | null;
  source: 'coingecko' | 'binance' | 'peg';
  updatedAt: number;
}

export interface HistoricalPrice {
  price: number;
  source: string;
}

const QUOTE_TTL_MS = 60_000;
const STALE_OK_MS = 30 * 60_000;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export class PriceService {
  private quotes = new Map<AssetId, Quote>();
  private fetchedAt = 0;
  private inflight: Promise<Map<AssetId, Quote>> | null = null;
  private readonly images = new Map<AssetId, string>();

  constructor() {
    try {
      for (const r of assetMeta.all()) if (r.image_url) this.images.set(r.asset, r.image_url);
    } catch {
      /* db not ready in some tests */
    }
  }

  /** Icon URL for embeds (CoinGecko metadata, with a static fallback). */
  icon(asset: AssetId): string {
    return this.images.get(asset) ?? ASSETS[asset].icon;
  }

  /** Current quotes for all supported assets (cached for 60s, stale data served for up to 30 min on failure). */
  async getQuotes(force = false): Promise<Map<AssetId, Quote>> {
    const fresh = Date.now() - this.fetchedAt < QUOTE_TTL_MS;
    if (!force && fresh && this.quotes.size) return this.quotes;
    if (this.inflight) return this.inflight;
    this.inflight = this.refresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async getQuote(asset: AssetId): Promise<Quote | null> {
    return (await this.getQuotes()).get(asset) ?? null;
  }

  async getPrice(asset: AssetId): Promise<number | null> {
    return (await this.getQuote(asset))?.price ?? null;
  }

  lastUpdated(): number {
    return this.fetchedAt;
  }

  private async refresh(): Promise<Map<AssetId, Quote>> {
    let next: Map<AssetId, Quote> | null = null;
    try {
      next = await this.fromCoinGecko();
    } catch (err) {
      log.warn('CoinGecko quotes failed, trying Binance', err);
    }
    // Fill any missing non-stable coin from Binance (CoinGecko can omit one, e.g. a null price).
    if (!next || ASSET_IDS.some((a) => !ASSETS[a].stablecoin && !next!.has(a))) {
      try {
        const b = await this.fromBinance();
        next = new Map([...(b ?? []), ...(next ?? [])]);
      } catch (err) {
        log.warn('Binance quotes failed', err);
      }
    }
    if (next && next.size) {
      for (const id of ASSET_IDS) {
        if (!next.has(id) && ASSETS[id].stablecoin) next.set(id, pegQuote(id, this.icon(id)));
      }
      this.quotes = next;
      this.fetchedAt = Date.now();
      return next;
    }
    if (this.quotes.size && Date.now() - this.fetchedAt < STALE_OK_MS) return this.quotes;
    // Last resort: stablecoins only.
    const pegs = new Map<AssetId, Quote>();
    for (const id of ASSET_IDS) if (ASSETS[id].stablecoin) pegs.set(id, pegQuote(id, this.icon(id)));
    return pegs;
  }

  private async fromCoinGecko(): Promise<Map<AssetId, Quote>> {
    const ids = ASSET_IDS.map((a) => ASSETS[a].coingeckoId).join(',');
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h,7d&precision=full`;
    const rows = await httpJson<Array<Record<string, unknown>>>(url, { retries: 2, timeoutMs: 15_000 });
    if (!Array.isArray(rows)) throw new Error('unexpected CoinGecko response');
    const out = new Map<AssetId, Quote>();
    for (const r of rows) {
      const asset = ASSET_IDS.find((a) => ASSETS[a].coingeckoId === r.id);
      const price = num(r.current_price);
      if (!asset || price === null || price <= 0) continue;
      const image = typeof r.image === 'string' && r.image.startsWith('https://') ? r.image : null;
      if (image && this.images.get(asset) !== image) {
        this.images.set(asset, image);
        try {
          assetMeta.put(asset, image);
        } catch {
          /* ignore */
        }
      }
      out.set(asset, {
        asset,
        price,
        change24hPct: num(r.price_change_percentage_24h_in_currency) ?? num(r.price_change_percentage_24h),
        change7dPct: num(r.price_change_percentage_7d_in_currency),
        high24h: num(r.high_24h),
        low24h: num(r.low_24h),
        marketCap: num(r.market_cap),
        image: image ?? this.icon(asset),
        source: 'coingecko',
        updatedAt: Date.now(),
      });
    }
    return out;
  }

  private async fromBinance(): Promise<Map<AssetId, Quote>> {
    const symbols = ASSET_IDS.flatMap((a) => (ASSETS[a].binance[0] ? [ASSETS[a].binance[0].symbol] : []));
    const url = `https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const rows = await httpJson<Array<Record<string, unknown>>>(url, { retries: 2 });
    const out = new Map<AssetId, Quote>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const asset = ASSET_IDS.find((a) => ASSETS[a].binance[0]?.symbol === r.symbol);
      const price = num(r.lastPrice);
      if (!asset || price === null || price <= 0) continue;
      out.set(asset, {
        asset,
        price,
        change24hPct: num(r.priceChangePercent),
        change7dPct: null,
        high24h: num(r.highPrice),
        low24h: num(r.lowPrice),
        marketCap: null,
        image: this.icon(asset),
        source: 'binance',
        updatedAt: Date.now(),
      });
    }
    return out;
  }

  /**
   * USD price of an asset at a moment in time (unix seconds). Uses 1-minute Binance candles,
   * then hourly Coinbase candles, then CoinGecko daily history. Results are cached forever.
   */
  async getHistoricalPrice(asset: AssetId, unixSec: number): Promise<HistoricalPrice | null> {
    if (asset === 'USDT') return { price: 1, source: 'peg' };
    const nowS = Math.floor(Date.now() / 1000);
    if (unixSec > nowS - 90) {
      const p = await this.getPrice(asset);
      if (p === null) throw new Error(`live price unavailable for ${asset}`);
      return { price: p, source: 'live' };
    }
    const minute = Math.floor(unixSec / 60) * 60;
    const cached = priceCache.get(asset, minute);
    if (cached) return cached;
    // Hourly candles fetched in bulk by prefetchHourly() (fast path for history imports).
    const hour = Math.floor(unixSec / 3600) * 3600;
    const hourly = this.hourly.get(`${asset}:${hour}`) ?? priceCache.get(asset, hour);
    if (hourly && hourly.source.endsWith(':1h')) return hourly;

    // A provider either finds a price, answers definitively "no data" (null / 4xx), or fails
    // transiently. Only when no provider failed transiently is the price truly unavailable.
    let transientErrors = 0;
    const attempt = async (name: string, fn: () => Promise<HistoricalPrice | null>) => {
      try {
        return await fn();
      } catch (e) {
        if (isNoDataError(e)) return null;
        transientErrors++;
        log.debug(`${name} history ${asset}`, e);
        return null;
      }
    };
    const result =
      (await attempt('binance', () => this.binanceAt(asset, minute))) ??
      (await attempt('coinbase', () => this.coinbaseAt(asset, minute))) ??
      (await attempt('coingecko', () => this.coingeckoAt(asset, minute)));

    if (result) {
      priceCache.put(asset, minute, result.price, result.source);
      return result;
    }
    if (ASSETS[asset].stablecoin) return { price: 1, source: 'peg' };
    if (transientErrors > 0) throw new Error(`historical price providers temporarily unavailable for ${asset}`);
    return null;
  }

  private readonly hourly = new Map<string, HistoricalPrice>();
  private readonly hourlyCovered = new Map<AssetId, Array<[number, number]>>();

  /**
   * Downloads hourly candles for [fromSec, toSec] in bulk (1000 hours per request) so that
   * thousands of imported transactions can be priced without one request each.
   * Hours not covered by Binance (before listing) fall back to per-transaction lookups.
   */
  async prefetchHourly(asset: AssetId, fromSec: number, toSec: number): Promise<number> {
    if (asset === 'USDT' || ASSETS[asset].binance.length === 0) return 0;
    const from = Math.floor(fromSec / 3600) * 3600;
    // Only completed hours: the candle of the current hour is still moving and must not be cached.
    const to = Math.min(Math.floor(toSec / 3600) * 3600, Math.floor(Date.now() / 1000 / 3600) * 3600 - 3600);
    if (to < from) return 0;
    const covered = this.hourlyCovered.get(asset) ?? [];
    if (covered.some(([a, b]) => a <= from && b >= to)) return 0;
    let stored = 0;
    const rows: Array<[number, number, string]> = [];
    // Newest symbol first; older periods use the previous market (e.g. MATIC before POL).
    for (const m of ASSETS[asset].binance) {
      let start = Math.max(from, Math.floor(m.since / 1000 / 3600) * 3600);
      while (start <= to) {
        const url = `https://data-api.binance.vision/api/v3/klines?symbol=${m.symbol}&interval=1h&startTime=${start * 1000}&endTime=${(to + 3599) * 1000}&limit=1000`;
        const klines = await httpJson<unknown[][]>(url, { retries: 2 });
        if (!Array.isArray(klines) || klines.length === 0) break;
        let last = start;
        for (const k of klines) {
          const t = Math.floor(Number(k[0]) / 1000);
          const open = num(k[1]);
          const close = num(k[4]);
          if (!Number.isFinite(t) || open === null || close === null) continue;
          const key = `${asset}:${t}`;
          if (!this.hourly.has(key)) {
            const p = { price: (open + close) / 2, source: `binance:${m.symbol}:1h` };
            this.hourly.set(key, p);
            rows.push([t, p.price, p.source]);
            stored++;
          }
          last = t;
        }
        // Stop on short pages, and never loop if the server does not move forward.
        if (klines.length < 1000 || last + 3600 <= start) break;
        start = last + 3600;
      }
    }
    if (rows.length) {
      try {
        getDb().transaction(() => {
          for (const [t, p, s] of rows) priceCache.put(asset, t, p, s);
        });
      } catch {
        /* cache persistence is best effort */
      }
    }
    covered.push([from, to]);
    this.hourlyCovered.set(asset, covered);
    return stored;
  }

  private async binanceAt(asset: AssetId, minute: number): Promise<HistoricalPrice | null> {
    const ms = minute * 1000;
    for (const m of ASSETS[asset].binance) {
      if (ms < m.since - 86_400_000) continue;
      const url = `https://data-api.binance.vision/api/v3/klines?symbol=${m.symbol}&interval=1m&startTime=${ms}&limit=1`;
      const rows = await httpJson<unknown[][]>(url, { retries: 2 });
      const k = Array.isArray(rows) ? rows[0] : undefined;
      if (!k) continue;
      const openTime = Number(k[0]);
      // A candle far after the requested time means the market did not exist yet.
      if (!Number.isFinite(openTime) || openTime - ms > 3_600_000) continue;
      const open = num(k[1]);
      const close = num(k[4]);
      if (open === null || close === null) continue;
      return { price: (open + close) / 2, source: `binance:${m.symbol}` };
    }
    return null;
  }

  private async coinbaseAt(asset: AssetId, minute: number): Promise<HistoricalPrice | null> {
    for (const product of ASSETS[asset].coinbase) {
      const start = new Date((minute - 1800) * 1000).toISOString();
      const end = new Date((minute + 1800) * 1000).toISOString();
      const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${start}&end=${end}`;
      let rows: number[][] | null;
      try {
        rows = await httpJson<number[][]>(url, { retries: 1 });
      } catch (err) {
        if (isNoDataError(err)) continue; // product does not exist (e.g. not listed yet)
        throw err;
      }
      if (!Array.isArray(rows) || rows.length === 0) continue;
      // [time, low, high, open, close, volume] newest first; pick the candle closest to the minute.
      let best: number[] | undefined;
      for (const r of rows) if (!best || Math.abs(r[0]! - minute) < Math.abs(best[0]! - minute)) best = r;
      const open = best?.[3];
      const close = best?.[4];
      if (typeof open === 'number' && typeof close === 'number') return { price: (open + close) / 2, source: `coinbase:${product}` };
    }
    return null;
  }

  private async coingeckoAt(asset: AssetId, minute: number): Promise<HistoricalPrice | null> {
    const d = new Date(minute * 1000);
    const date = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
    const url = `https://api.coingecko.com/api/v3/coins/${ASSETS[asset].coingeckoId}/history?date=${date}&localization=false`;
    const r = await httpJson<{ market_data?: { current_price?: { usd?: number } } }>(url, { retries: 1 });
    const p = num(r?.market_data?.current_price?.usd);
    return p === null ? null : { price: p, source: 'coingecko:daily' };
  }
}

/**
 * Definitive "this market/date has no data" answers (unknown symbol, not listed, beyond the
 * keyless CoinGecko history window). Anything else (timeouts, 429, 5xx) is transient.
 */
function isNoDataError(err: unknown): boolean {
  return err instanceof HttpError && err.status !== null && [400, 401, 403, 404, 422].includes(err.status);
}

function pegQuote(asset: AssetId, image: string): Quote {
  return {
    asset,
    price: 1,
    change24hPct: 0,
    change7dPct: 0,
    high24h: null,
    low24h: null,
    marketCap: null,
    image,
    source: 'peg',
    updatedAt: Date.now(),
  };
}

let service: PriceService | null = null;
export function getPriceService(): PriceService {
  service ??= new PriceService();
  return service;
}
