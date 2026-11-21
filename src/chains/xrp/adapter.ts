/**
 * XRP Ledger adapter (native XRP only). Address-only, read-only.
 *
 * Cursor: `{ ledger: number }` = last validated ledger index whose transactions have been delivered.
 */
import type { BackfillOptions, ChainAdapter, Cursor, PollResult, RawTransfer, TxStatusResult } from '../../core/types.ts';
import { createLogger } from '../../logger.ts';
import { sleep } from '../../util/async.ts';
import { EndpointPool } from '../../util/http.ts';
import {
  MAINNET_FIRST_LEDGER,
  MalformedTxError,
  XRP_ASSET_KEY,
  isRecord,
  normalizeTx,
  parseDrops,
  parseLedgerIndex,
  parseTransfer,
  parseTxStatus,
  type Json,
  type XrplTx,
} from './parse.ts';
import { DEFAULT_XRPL_ENDPOINTS, XrplError, httpTransport, xrplCall, type XrplCallOptions, type XrplTransport } from './rpc.ts';

const log = createLogger('xrp');

/** rippled's public maximum for account_tx (xrplcluster answers tooBusy above it). */
const PAGE_LIMIT = 400;
const ACCOUNT_TX_TIMEOUT_MS = 45_000;
/** A live poll stops paging after this long (the tracker allows 90 s); the next poll continues. */
const POLL_BUDGET_MS = 40_000;
const POLL_MAX_PAGES = 25;
/** Ledger range errors: the requested ledgers are not (yet) validated / available on that server. */
const RANGE_ERRORS = new Set(['lgrNotFound', 'lgrIdxMalformed', 'lgrIdxsInvalid', 'lgrNotValidated', 'incompleteHistory']);
const HASH_RE = /^[0-9A-Fa-f]{64}$/;

export interface XrpAdapterOptions {
  /** Server URLs in priority order (default: DEFAULT_XRPL_ENDPOINTS). */
  endpoints?: readonly string[];
  /** Request function (default: HTTP via util/http). Tests inject a fake. */
  transport?: XrplTransport;
  /** account_tx page size (default 400). */
  pageLimit?: number;
  /** Wait between retries when a server has not validated the requested ledger yet (default 4000 ms). */
  rangeRetryDelayMs?: number;
}

interface AccountTxPage {
  transactions: unknown[];
  min: number;
  max: number;
  marker: unknown;
}

interface ScanPage {
  transfers: RawTransfer[];
  /** Validated transactions newly seen on this page. */
  txCount: number;
  /** Ledger of the first transaction seen in the whole scan. */
  firstLedger: number | null;
  /** Ledger of the last transaction seen so far. */
  lastLedger: number | null;
}

interface ScanOptions {
  address: string;
  /** -1 = earliest available. */
  min: number;
  /** -1 = latest validated; the first page's reported ledger_index_max is then pinned for later pages. */
  max: number;
  /** Drop transactions at or below this ledger (already delivered). */
  skipThroughLedger?: number;
  /** Retries (with a delay) when every server answers with a ledger-range error. */
  rangeRetries: number;
  /** Stop after this many pages or at this time (ms) and report the scan as incomplete. */
  budget?: { pages: number; deadline: number };
  signal?: AbortSignal;
  onPage: (page: ScanPage) => void | Promise<void>;
}

function cursorLedger(cursor: Cursor): number {
  const ledger = parseLedgerIndex(cursor.ledger);
  if (ledger === null) throw new Error(`Invalid XRP cursor: ${JSON.stringify(cursor).slice(0, 100)}`);
  return ledger;
}

function malformed(method: string, message: string): XrplError {
  return new XrplError(method, 'malformedResponse', message, false);
}

function isRangeError(err: unknown): err is XrplError {
  return err instanceof XrplError && RANGE_ERRORS.has(err.code);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');
}

function validateAccountTxPage(res: Json, address: string): AccountTxPage {
  if (res.account !== address) throw malformed('account_tx', 'response is for a different account');
  if (!Array.isArray(res.transactions)) throw malformed('account_tx', 'transactions is not an array');
  const min = parseLedgerIndex(res.ledger_index_min);
  const max = parseLedgerIndex(res.ledger_index_max);
  if (min === null || max === null || max < min) throw malformed('account_tx', 'invalid ledger_index_min/max');
  const marker = res.marker ?? undefined;
  if (marker !== undefined && !isRecord(marker) && typeof marker !== 'string') throw malformed('account_tx', 'invalid marker');
  return { transactions: res.transactions, min, max, marker };
}

export function createXrpAdapter(options: XrpAdapterOptions = {}): ChainAdapter {
  const pool = new EndpointPool('xrp', options.endpoints ?? DEFAULT_XRPL_ENDPOINTS);
  const transport = options.transport ?? httpTransport;
  const pageLimit = options.pageLimit ?? PAGE_LIMIT;
  const rangeRetryDelayMs = options.rangeRetryDelayMs ?? 4_000;

  function call(url: string, method: string, params: Json, opts: XrplCallOptions): Promise<Json> {
    return xrplCall(transport, url, method, params, opts);
  }

  async function getTip(signal?: AbortSignal): Promise<number> {
    return pool.run(async (url) => {
      const r = await call(url, 'ledger', { ledger_index: 'validated' }, signal ? { signal } : {});
      const idx = parseLedgerIndex(r.ledger_index) ?? (isRecord(r.ledger) ? parseLedgerIndex(r.ledger.ledger_index) : null);
      if (idx === null || r.validated !== true) throw malformed('ledger', 'no validated ledger index');
      return idx;
    }, signal);
  }

  /**
   * Walks account_tx forward. Markers are server specific (rippled markers point at the next
   * transaction, clio markers at the last returned one), so a marker is only ever sent back to the
   * server that issued it. After a failover the scan resumes from the last seen ledger (inclusive)
   * and drops the duplicates, so nothing is skipped or repeated.
   */
  async function scan(o: ScanOptions): Promise<{ max: number; lastLedger: number | null; complete: boolean }> {
    let pages = 0;
    let marker: unknown;
    let markerUrl: string | null = null;
    let fixedMax: number | null = o.max === -1 ? null : o.max;
    let firstLedger: number | null = null;
    let lastLedger: number | null = null;
    let seenAtLast = new Set<string>();

    for (;;) {
      throwIfAborted(o.signal);
      const sentMarker = marker;
      let pageRes: { url: string; page: AccountTxPage } | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          pageRes = await pool.run(async (url) => {
            const wantMin = sentMarker !== undefined && url !== markerUrl && lastLedger !== null ? lastLedger : o.min;
            const params: Json = {
              account: o.address,
              ledger_index_min: wantMin,
              ledger_index_max: fixedMax ?? -1,
              forward: true,
              limit: pageLimit,
              binary: false,
            };
            if (sentMarker !== undefined && url === markerUrl) params.marker = sentMarker;
            const res = await call(url, 'account_tx', params, {
              timeoutMs: ACCOUNT_TX_TIMEOUT_MS,
              ...(o.signal ? { signal: o.signal } : {}),
            });
            const page = validateAccountTxPage(res, o.address);
            // Servers without full history silently clamp the range (API v1) - fail over instead.
            const minOk = wantMin === -1 ? page.min <= MAINNET_FIRST_LEDGER : page.min <= wantMin;
            if (!minOk) throw new XrplError('account_tx', 'incompleteHistory', `server history starts at ledger ${page.min}`, false);
            if (fixedMax !== null && page.max < fixedMax) {
              throw new XrplError('account_tx', 'incompleteHistory', `server is at ledger ${page.max} < ${fixedMax}`, false);
            }
            return { url, page };
          }, o.signal);
          break;
        } catch (err) {
          if (!isRangeError(err) || attempt >= o.rangeRetries) throw err;
          log.debug(`account_tx range not available yet, retrying (${attempt + 1}/${o.rangeRetries})`, err);
          await sleep(rangeRetryDelayMs, o.signal);
        }
      }

      const { url, page } = pageRes;
      fixedMax ??= page.max;
      const transfers: RawTransfer[] = [];
      let txCount = 0;
      for (const entry of page.transactions) {
        let t: XrplTx;
        try {
          t = normalizeTx(entry);
        } catch (err) {
          log.warn('skipping malformed XRPL transaction entry', err);
          continue;
        }
        if (!t.validated) continue;
        if (o.skipThroughLedger !== undefined && t.ledgerIndex <= o.skipThroughLedger) continue;
        if (t.ledgerIndex > fixedMax) continue; // beyond the pinned bound: the next poll delivers it
        if (lastLedger !== null && t.ledgerIndex < lastLedger) {
          log.warn(`account_tx returned ${t.hash} out of order (ledger ${t.ledgerIndex} < ${lastLedger})`);
        } else {
          if (t.ledgerIndex === lastLedger && seenAtLast.has(t.hash)) continue; // duplicate after failover
          if (t.ledgerIndex !== lastLedger) {
            lastLedger = t.ledgerIndex;
            seenAtLast = new Set();
          }
          seenAtLast.add(t.hash);
        }
        firstLedger ??= t.ledgerIndex;
        txCount++;
        try {
          const transfer = parseTransfer(t, o.address);
          if (transfer) transfers.push(transfer);
        } catch (err) {
          log.warn(`skipping XRPL transaction ${t.hash}`, err);
        }
      }
      await o.onPage({ transfers, txCount, firstLedger, lastLedger });

      if (page.marker === undefined) return { max: fixedMax, lastLedger, complete: true };
      pages++;
      if (o.budget && (pages >= o.budget.pages || Date.now() >= o.budget.deadline)) return { max: fixedMax, lastLedger, complete: false };
      if (url === markerUrl && JSON.stringify(page.marker) === JSON.stringify(sentMarker)) {
        throw malformed('account_tx', 'pagination marker did not advance');
      }
      marker = page.marker;
      markerUrl = url;
    }
  }

  return {
    network: 'xrp',

    getTip,

    async getBalances(address: string, signal?: AbortSignal): Promise<Map<string, bigint>> {
      let balance: bigint;
      try {
        balance = await pool.run(async (url) => {
          const r = await call(
            url,
            'account_info',
            { account: address, ledger_index: 'validated' },
            {
              expect: ['actNotFound'],
              ...(signal ? { signal } : {}),
            },
          );
          if (r.validated === false) throw malformed('account_info', 'result is not from a validated ledger');
          const data = r.account_data;
          if (!isRecord(data) || data.Account !== address) throw malformed('account_info', 'account_data missing or for another account');
          try {
            return parseDrops(data.Balance, 'Balance');
          } catch (err) {
            throw malformed('account_info', err instanceof MalformedTxError ? err.message : 'bad Balance');
          }
        }, signal);
      } catch (err) {
        if (err instanceof XrplError && err.code === 'actNotFound') balance = 0n;
        else throw err;
      }
      return new Map([[XRP_ASSET_KEY, balance]]);
    },

    async initCursor(_address: string, signal?: AbortSignal): Promise<Cursor> {
      return { ledger: await getTip(signal) };
    },

    async poll(address: string, cursor: Cursor, signal?: AbortSignal): Promise<PollResult> {
      const from = cursorLedger(cursor);
      const transfers: RawTransfer[] = [];
      try {
        // ledger_index_min = cursor (inclusive, already delivered and filtered out) instead of cursor + 1:
        // the cursor ledger is validated on every up-to-date server, so polling faster than ledgers
        // close never produces "ledger not validated yet" errors.
        const r = await scan({
          address,
          min: from,
          max: -1,
          skipThroughLedger: from,
          rangeRetries: 0,
          budget: { pages: POLL_MAX_PAGES, deadline: Date.now() + POLL_BUDGET_MS },
          ...(signal ? { signal } : {}),
          onPage: (p) => {
            transfers.push(...p.transfers);
          },
        });
        if (!r.complete) {
          // A big backlog: keep what was read and continue next poll. The last ledger may be only
          // partly read, so it is read again (rows are de-duplicated when stored).
          log.info(`${transfers.length} new XRPL transfers so far for ${address.slice(0, 8)}..., continuing next poll`);
          return { transfers, cursor: { ledger: Math.max(from, (r.lastLedger ?? from) - 1) } };
        }
        return { transfers, cursor: { ledger: Math.max(from, r.max, r.lastLedger ?? 0) } };
      } catch (err) {
        if (isRangeError(err)) {
          log.debug(`no server has validated ledgers after ${from} yet`, err);
          return { transfers: [], cursor: { ledger: from } };
        }
        throw err;
      }
    },

    async backfill(address: string, boundary: Cursor, opts: BackfillOptions = {}): Promise<RawTransfer[]> {
      const end = cursorLedger(boundary);
      const all: RawTransfer[] = [];
      let done = 0;
      const stage = 'Fetching XRP Ledger history';
      opts.onProgress?.({ stage, fraction: 0, done: 0 });
      await scan({
        address,
        min: -1,
        max: end,
        rangeRetries: 3,
        ...(opts.signal ? { signal: opts.signal } : {}),
        onPage: async (p) => {
          done += p.txCount;
          if (p.transfers.length) {
            all.push(...p.transfers);
            await opts.onBatch?.(p.transfers);
          }
          let fraction: number | undefined;
          if (p.firstLedger !== null && p.lastLedger !== null) {
            fraction = end > p.firstLedger ? (p.lastLedger - p.firstLedger) / (end - p.firstLedger) : 1;
            fraction = Math.min(1, Math.max(0, fraction));
          }
          opts.onProgress?.({ stage, done, ...(fraction !== undefined ? { fraction } : {}) });
        },
      });
      opts.onProgress?.({ stage, fraction: 1, done, total: done });
      return all;
    },

    async getTxStatus(txid: string, _address: string, signal?: AbortSignal): Promise<TxStatusResult> {
      if (!HASH_RE.test(txid)) return { state: 'unknown' };
      try {
        const r = await pool.run(
          (url) =>
            call(
              url,
              'tx',
              { transaction: txid.toUpperCase(), binary: false },
              {
                expect: ['txnNotFound'],
                ...(signal ? { signal } : {}),
              },
            ),
          signal,
        );
        return parseTxStatus(r, txid);
      } catch (err) {
        if (err instanceof XrplError && err.code === 'txnNotFound') return { state: 'unknown' };
        throw err;
      }
    },
  };
}
