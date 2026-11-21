/**
 * Thin HTTP clients for Blockbook API v2 and Esplora. All requests go through util/http
 * (rate limiting, retries, timeouts, proxy); all responses are validated by ./parse.ts.
 * Clients are stateless; provider selection / failover lives in ./providers.ts.
 */
import { FatalRequestError, HttpError, httpJson, type HttpOptions } from '../../util/http.ts';
import type { Logger } from '../../logger.ts';
import { FEE_TARGETS, coinPerKbToSatPerVb, parseEsploraFeeEstimates } from './fees.ts';
import {
  MalformedDataError,
  blockbookTxLookup,
  esploraTxLookup,
  isRecord,
  isPlausibleAddress,
  isTxid,
  parseBlockbookSummary,
  parseBlockbookTx,
  parseEsploraSummary,
  parseEsploraTx,
  parseTxList,
  toInt,
} from './parse.ts';
import type { AddressMatcher, AddressSummary, NormTx, ParsedTxList, ProbeResult, RecentTxs, TxLookup } from './types.ts';
import { isXpubQuery, shortKey } from '../../core/xpub.ts';

/** Health probes must be quick: a slow provider is treated as unavailable for this round. */
const PROBE_HTTP: HttpOptions = { timeoutMs: 6_000, retries: 1 };
/** Interactive requests (poll, balances, status): fail over quickly instead of retrying long. */
const FAST_HTTP: HttpOptions = { timeoutMs: 12_000, retries: 1 };
/** Large history pages. */
const HEAVY_HTTP: HttpOptions = { timeoutMs: 45_000, retries: 2, maxBytes: 48 * 1024 * 1024 };

/** Blockbook page size for live polls (details=txs includes hex, keep it modest). */
export const POLL_PAGE_SIZE = 50;
/**
 * Pages of the live read per poll. Anything older that does not fit is recorded as a gap and
 * read with light pages in the following polls (see the adapter), so nothing is skipped.
 */
export const POLL_MAX_PAGES = 10;
/** Esplora's fixed page size for /txs/chain (electrs CHAIN_TXS_PER_PAGE). */
export const ESPLORA_CHAIN_PAGE = 25;

export interface HistoryPage extends ParsedTxList {
  /** Page number the server actually returned (Blockbook clamps out-of-range pages). */
  page: number;
  /** Total confirmed tx count of the address (upper bound for the filtered set), if reported. */
  totalHint: number | null;
}

export interface ChainPage extends ParsedTxList {
  /** Txid of the last raw item, used as the next pagination key. */
  lastTxid: string | null;
  /** Block height of the last raw item (the lowest on the page). */
  lastHeight: number | null;
}

function oldestHeight(txs: readonly NormTx[]): number | null {
  let min: number | null = null;
  for (const t of txs) if (t.blockHeight !== null && (min === null || t.blockHeight < min)) min = t.blockHeight;
  return min;
}

/** Pagination key of an Esplora page: its last confirmed entry. */
function lastConfirmed(page: readonly unknown[]): { lastTxid: string | null; lastHeight: number | null; confirmed: number } {
  const confirmed = page.filter((t) => isRecord(t) && isRecord(t.status) && t.status.confirmed === true);
  const last = confirmed[confirmed.length - 1];
  return {
    lastTxid: isRecord(last) && isTxid(last.txid) ? last.txid : null,
    lastHeight: isRecord(last) && isRecord(last.status) ? toInt(last.status.block_height, 1) : null,
    confirmed: confirmed.length,
  };
}

/** Blockbook instances verified not to serve /api/v2/xpub (they answer with an HTML page). */
const NO_XPUB_HOSTS = new Set(['btcbook.guarda.co']);

/** Thrown for backends that cannot query extended keys; EndpointPool moves on without penalty. */
export class XpubUnsupportedError extends Error {
  readonly skip = true;
  constructor(host: string) {
    super(`${host} cannot query extended public keys`);
    this.name = 'XpubUnsupportedError';
  }
}

/** Error bodies may echo the queried address / xpub / descriptor: keep only a short form. */
export function redactKeys(text: string): string {
  return text.replace(/[A-Za-z0-9]{20,}/g, (m) => shortKey(m));
}

function isoToUnix(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}

function isNotFound(err: unknown, status: number): boolean {
  return err instanceof HttpError && err.status === status;
}

function skipLogger(log: Logger, where: string) {
  return (txid: string | null, err: unknown) => log.warn(`skipping malformed tx ${txid ?? '(no txid)'} from ${where}`, err);
}

// --- Blockbook ---

export class BlockbookClient {
  readonly kind = 'blockbook' as const;
  readonly base: string;
  readonly host: string;
  private readonly log: Logger;

  constructor(base: string, log: Logger) {
    this.base = base.replace(/\/+$/, '');
    this.host = new URL(this.base).host;
    this.log = log;
  }

  private async get(path: string, opts: HttpOptions, signal?: AbortSignal): Promise<unknown> {
    try {
      return await httpJson<unknown>(`${this.base}/api/v2${path}`, { ...opts, signal });
    } catch (err) {
      // Deterministic address errors would fail identically everywhere: stop failover.
      if (
        err instanceof HttpError &&
        err.status === 400 &&
        /invalid address|checksum mismatch|address missing/i.test(err.bodySnippet ?? '')
      ) {
        throw new FatalRequestError(`Address rejected by ${this.host}: ${redactKeys(err.bodySnippet ?? '')}`, { cause: err });
      }
      throw err;
    }
  }

  private addressPath(address: string, query: string): string {
    if (isXpubQuery(address)) {
      // Extended keys / descriptors: one query covers every derived address of the account.
      if (NO_XPUB_HOSTS.has(this.host)) throw new XpubUnsupportedError(this.host);
      return `/xpub/${encodeURIComponent(address)}?${query}`;
    }
    return `/address/${encodeURIComponent(address)}?${query}`;
  }

  /** Addresses of an extended key that have been used (receive and change). */
  async usedAddresses(descriptor: string, signal?: AbortSignal): Promise<string[]> {
    const raw = await this.get(this.addressPath(descriptor, 'details=tokens&tokens=used'), FAST_HTTP, signal);
    if (!isRecord(raw) || !Array.isArray(raw.tokens)) return [];
    return raw.tokens.flatMap((t) => (isRecord(t) && isPlausibleAddress(t.name) ? [t.name] : []));
  }

  async probe(): Promise<ProbeResult> {
    const raw = await this.get('', PROBE_HTTP);
    const bb = isRecord(raw) && isRecord(raw.blockbook) ? raw.blockbook : null;
    const backend = isRecord(raw) && isRecord(raw.backend) ? raw.backend : null;
    const tip = bb ? toInt(bb.bestHeight, 1) : null;
    if (!bb || tip === null) throw new MalformedDataError(`invalid status from ${this.host}`);
    return {
      tip,
      nodeTip: backend ? toInt(backend.blocks, 1) : null,
      mempoolSize: toInt(bb.mempoolSize),
      inSyncMempool: typeof bb.inSyncMempool === 'boolean' ? bb.inSyncMempool : null,
      tipTime: isoToUnix(bb.lastBlockTime),
    };
  }

  /** details=basic: the cheapest call (may omit unconfirmedBalance on some versions). */
  async summary(address: string, signal?: AbortSignal): Promise<AddressSummary> {
    return parseBlockbookSummary(await this.get(this.addressPath(address, 'details=basic'), FAST_HTTP, signal));
  }

  /** details=txids&pageSize=1 always includes unconfirmedBalance (unlike basic on newer versions). */
  async balanceSummary(address: string, signal?: AbortSignal): Promise<AddressSummary> {
    const s = parseBlockbookSummary(await this.get(this.addressPath(address, 'details=txids&pageSize=1'), FAST_HTTP, signal));
    if (s.unconfirmedTxs > 0 && s.unconfirmedBalance === null) {
      throw new MalformedDataError(`${this.host} did not report the unconfirmed balance`);
    }
    return s;
  }

  /**
   * Transactions at height >= fromHeight plus the mempool, with full details (details=txs has
   * sequence numbers for RBF and size data for the fee rate).
   */
  async recentTxs(address: string, fromHeight: number, isOurs: AddressMatcher, signal?: AbortSignal): Promise<RecentTxs> {
    const txs: NormTx[] = [];
    let rawCount = 0;
    let skipped = 0;
    let complete = false;
    for (let page = 1; page <= POLL_MAX_PAGES; page++) {
      const raw = await this.get(
        this.addressPath(address, `details=txs&from=${fromHeight}&pageSize=${POLL_PAGE_SIZE}&page=${page}`),
        page === 1 ? FAST_HTTP : HEAVY_HTTP,
        signal,
      );
      if (!isRecord(raw)) throw new MalformedDataError('address response is not an object');
      if (page > 1 && toInt(raw.page) !== page) {
        complete = true; // Blockbook repeats the last page for out-of-range requests.
        break;
      }
      const res = parseTxList(raw.transactions, parseBlockbookTx, isOurs, skipLogger(this.log, this.host));
      txs.push(...res.txs);
      rawCount += res.rawCount;
      skipped += res.skipped;
      if (res.rawCount < POLL_PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    // Newest first: when the cap is hit, the unread part is the oldest end of the range.
    return { txs, rawCount, skipped, complete, oldestHeight: oldestHeight(txs), resumeAfter: null };
  }

  /** Confirmed history with from <= height <= to (newest first), light details. */
  async historyPage(
    address: string,
    window: { from?: number; to: number },
    page: number,
    pageSize: number,
    isOurs: AddressMatcher,
    signal?: AbortSignal,
  ): Promise<HistoryPage> {
    const from = window.from !== undefined ? `&from=${window.from}` : '';
    const raw = await this.get(
      this.addressPath(address, `details=txslight${from}&to=${window.to}&pageSize=${pageSize}&page=${page}`),
      HEAVY_HTTP,
      signal,
    );
    if (!isRecord(raw)) throw new MalformedDataError('address response is not an object');
    const res = parseTxList(raw.transactions, parseBlockbookTx, isOurs, skipLogger(this.log, this.host));
    return { ...res, page: toInt(raw.page) ?? page, totalHint: toInt(raw.txs) };
  }

  async tx(txid: string, signal?: AbortSignal): Promise<TxLookup> {
    try {
      return blockbookTxLookup(await this.get(`/tx/${txid}`, FAST_HTTP, signal), txid);
    } catch (err) {
      if (isNotFound(err, 400) && /not found/i.test((err as HttpError).bodySnippet ?? '')) return { found: false };
      throw err;
    }
  }

  async feeEstimates(signal?: AbortSignal): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    // Sequential on purpose: Blockbook hosts throttle bursts.
    for (const target of FEE_TARGETS) {
      const rate = coinPerKbToSatPerVb(await this.get(`/estimatefee/${target}`, FAST_HTTP, signal));
      if (rate !== null) out.set(target, rate);
    }
    if (out.size === 0) throw new MalformedDataError(`no usable fee estimates from ${this.host}`);
    return out;
  }
}

// --- Esplora ---

export class EsploraClient {
  readonly kind = 'esplora' as const;
  readonly base: string;
  readonly host: string;
  private readonly log: Logger;

  constructor(base: string, log: Logger) {
    this.base = base.replace(/\/+$/, '');
    this.host = new URL(this.base).host;
    this.log = log;
  }

  private async get(path: string, opts: HttpOptions, signal?: AbortSignal): Promise<unknown> {
    try {
      return await httpJson<unknown>(`${this.base}${path}`, { ...opts, signal });
    } catch (err) {
      if (err instanceof HttpError && err.status === 400 && /base58|bech32|invalid address|checksum/i.test(err.bodySnippet ?? '')) {
        throw new FatalRequestError(`Address rejected by ${this.host}: ${redactKeys(err.bodySnippet ?? '')}`, { cause: err });
      }
      throw err;
    }
  }

  /** GET /blocks lists the newest blocks: the tip height and its timestamp in one request. */
  async probe(): Promise<ProbeResult> {
    const raw = await this.get('/blocks', PROBE_HTTP);
    const top = Array.isArray(raw) && isRecord(raw[0]) ? raw[0] : null;
    const tip = top ? toInt(top.height, 1) : null;
    if (!top || tip === null) throw new MalformedDataError(`invalid tip from ${this.host}`);
    return { tip, nodeTip: null, mempoolSize: null, inSyncMempool: null, tipTime: toInt(top.timestamp, 1) };
  }

  async summary(address: string, signal?: AbortSignal): Promise<AddressSummary> {
    if (isXpubQuery(address)) throw new XpubUnsupportedError(this.host);
    return parseEsploraSummary(await this.get(`/address/${encodeURIComponent(address)}`, FAST_HTTP, signal));
  }

  balanceSummary(address: string, signal?: AbortSignal): Promise<AddressSummary> {
    return this.summary(address, signal);
  }

  /** Mempool + confirmed transactions at height >= fromHeight. */
  async recentTxs(address: string, fromHeight: number, isOurs: AddressMatcher, signal?: AbortSignal): Promise<RecentTxs> {
    if (isXpubQuery(address)) throw new XpubUnsupportedError(this.host);
    const a = encodeURIComponent(address);
    const onSkip = skipLogger(this.log, this.host);
    const first = await this.get(`/address/${a}/txs`, FAST_HTTP, signal);
    const res = parseTxList(first, parseEsploraTx, isOurs, onSkip);
    const txs = [...res.txs];
    let rawCount = res.rawCount;
    let skipped = res.skipped;
    let complete = false;
    let resumeAfter: string | null = null;
    let oldest: number | null = null;
    // /txs returns the mempool plus the newest 25 confirmed; continue while still above fromHeight.
    let page = Array.isArray(first) ? first : [];
    for (let i = 0; ; i++) {
      const { lastTxid, lastHeight, confirmed } = lastConfirmed(page);
      if (lastHeight !== null) oldest = lastHeight;
      // A short page is the end of the history; an unusable pagination key cannot be followed.
      if (confirmed < ESPLORA_CHAIN_PAGE || !lastTxid || lastHeight === null || lastHeight < fromHeight) {
        complete = true;
        break;
      }
      if (i >= POLL_MAX_PAGES) {
        resumeAfter = lastTxid;
        break;
      }
      const next = await this.get(`/address/${a}/txs/chain/${lastTxid}`, FAST_HTTP, signal);
      const r = parseTxList(next, parseEsploraTx, isOurs, onSkip);
      txs.push(...r.txs);
      rawCount += r.rawCount;
      skipped += r.skipped;
      page = Array.isArray(next) ? next : [];
    }
    return {
      txs: txs.filter((t) => t.blockHeight === null || t.blockHeight >= fromHeight),
      rawCount,
      skipped,
      complete,
      oldestHeight: oldest,
      resumeAfter,
    };
  }

  /** One page of confirmed history (newest first), keyed by the last txid of the previous page. */
  async chainPage(address: string, afterTxid: string | null, isOurs: AddressMatcher, signal?: AbortSignal): Promise<ChainPage> {
    if (isXpubQuery(address)) throw new XpubUnsupportedError(this.host);
    const a = encodeURIComponent(address);
    const raw = await this.get(afterTxid ? `/address/${a}/txs/chain/${afterTxid}` : `/address/${a}/txs/chain`, HEAVY_HTTP, signal);
    const res = parseTxList(raw, parseEsploraTx, isOurs, skipLogger(this.log, this.host));
    const items = Array.isArray(raw) ? raw : [];
    const last = items[items.length - 1];
    const lastHeight = isRecord(last) && isRecord(last.status) ? toInt(last.status.block_height, 1) : null;
    return { ...res, lastTxid: isRecord(last) && isTxid(last.txid) ? last.txid : null, lastHeight };
  }

  async tx(txid: string, signal?: AbortSignal): Promise<TxLookup> {
    // Note: /tx/{id}/status answers {"confirmed":false} even for unknown txids, so use /tx/{id}.
    try {
      return esploraTxLookup(await this.get(`/tx/${txid}`, FAST_HTTP, signal), txid);
    } catch (err) {
      if (isNotFound(err, 404)) return { found: false };
      throw err;
    }
  }

  async feeEstimates(signal?: AbortSignal): Promise<Map<number, number>> {
    const out = parseEsploraFeeEstimates(await this.get('/fee-estimates', FAST_HTTP, signal));
    if (out.size === 0) throw new MalformedDataError(`no usable fee estimates from ${this.host}`);
    return out;
  }
}

export type BackendClient = BlockbookClient | EsploraClient;
