/**
 * ChainAdapter for Bitcoin and Litecoin (address-only, read-only).
 *
 * Data: Blockbook API v2 (preferred) with Esplora as fallback, both normalized into NormTx and
 * turned into transfers by the single shared rule set in ./transfers.ts.
 *
 * Cursor: { height, fp, pending, gap?, watch?, ...extended-key fields }
 *   height  - tip of the provider that served the last poll (history/live boundary)
 *   fp      - fingerprint of the address counters (see parse.ts fingerprint)
 *   pending - txids that were still in the mempool at the last poll
 *   gap     - confirmed window not read yet because a poll hit its page cap (downtime, busy
 *             address, extended-key type switch); read with stable pagination in later polls
 *   watch   - highest block of a recently reported confirmed tx; those blocks are re-read on
 *             every new block until REORG_WATCH_DEPTH deep, so reorgs update stale heights
 */
import { NETWORKS } from '../../core/networks.ts';
import type { BackfillOptions, ChainAdapter, Cursor, PollResult, RawTransfer, TxStatusResult } from '../../core/types.ts';
import { createLogger } from '../../logger.ts';
import {
  candidateTypes,
  descriptorFor,
  parseExtendedKey,
  SCRIPT_LABEL,
  shortKey,
  type ExtendedKey,
  type ScriptType,
} from '../../core/xpub.ts';
import { ESPLORA_CHAIN_PAGE, XpubUnsupportedError, type ChainPage, type HistoryPage } from './backends.ts';
import { secondsForFeeRate } from './fees.ts';
import { addressMatcher, fingerprint, isPlausibleAddress, isRecord, isTxid } from './parse.ts';
import { FRESH_MAX_LAG, providerSetFor, type ActiveProvider } from './providers.ts';
import { resolveTxStatus } from './status.ts';
import { computeTransfer } from './transfers.ts';
import type { AddressMatcher, AddressSummary, FeeEstimates, GapState, NormTx, UtxoNetwork } from './types.ts';

/**
 * Blocks re-scanned below the cursor on every fetching poll. The cursor height is the serving
 * provider's tip from the health check, and a provider may lag the best tip by FRESH_MAX_LAG
 * blocks, so the margin covers that lag plus a one-block reorg.
 */
export const REORG_MARGIN = FRESH_MAX_LAG + 1;
/** Recently confirmed txs are re-read on every new block until this many blocks deep. */
export const REORG_WATCH_DEPTH = 6;
/** Lookback used when a cursor carries no usable height. */
const FALLBACK_LOOKBACK = 12;
/** Blockbook txslight page size for backfills (pageSize max is 1000; keep payloads moderate). */
export const BACKFILL_PAGE_SIZE = 250;
const MAX_BACKFILL_PAGES = 20_000;
/** Gap catch-up per poll: Blockbook txslight pages (8 x 250) / Esplora chain pages (20 x 25). */
export const GAP_PAGE_SIZE = BACKFILL_PAGE_SIZE;
export const GAP_PAGES_PER_POLL = 8;
export const ESPLORA_GAP_PAGES_PER_POLL = 20;
const FEE_TTL_MS = 60_000;
const FEE_FAILURE_TTL_MS = 15_000;
/** Pause before re-asking the only definitive provider about a missing tx. */
const DROP_RECHECK_MS = 3_000;
const MAX_PENDING_IN_CURSOR = 500;

export interface UtxoCursor {
  height: number | null;
  fp: string | null;
  pending: string[];
  gap: GapState | null;
  watch: number | null;
}

function readGap(v: unknown): GapState | null {
  if (!isRecord(v)) return null;
  const { from, to, page, after } = v;
  if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0) return null;
  if (typeof to !== 'number' || !Number.isSafeInteger(to) || to < from) return null;
  return {
    from,
    to,
    ...(typeof page === 'number' && Number.isSafeInteger(page) && page >= 1 ? { page } : {}),
    ...(isTxid(after) ? { after } : {}),
  };
}

/** Defensive read of a persisted cursor (it is JSON from the database). */
export function readCursor(c: Cursor | null | undefined): UtxoCursor {
  const height = typeof c?.height === 'number' && Number.isSafeInteger(c.height) && c.height >= 0 ? c.height : null;
  const fp = typeof c?.fp === 'string' ? c.fp : null;
  const pending = Array.isArray(c?.pending) ? (c.pending as unknown[]).filter(isTxid).slice(0, MAX_PENDING_IN_CURSOR) : [];
  const watch = typeof c?.watch === 'number' && Number.isSafeInteger(c.watch) && c.watch >= 0 ? c.watch : null;
  return { height, fp, pending, gap: readGap(c?.gap), watch };
}

/** True while recently reported confirmed txs should be re-read because a new block arrived. */
function reorgRecheckDue(prev: UtxoCursor, tip: number): boolean {
  return prev.watch !== null && prev.height !== null && tip !== prev.height && tip - prev.watch < REORG_WATCH_DEPTH;
}

/**
 * Poll short-circuit: nothing to fetch when the counters are unchanged, no mempool tx is involved
 * (neither remembered in the cursor nor reported by the summary), no gap is left to read, and no
 * new block arrived while recently confirmed txs could still be reorganized.
 */
export function pollNeedsFetch(prev: UtxoCursor, fp: string, summary: AddressSummary, tip: number): boolean {
  const idle = prev.height !== null && prev.fp === fp && prev.pending.length === 0 && summary.unconfirmedTxs === 0 && prev.gap === null;
  return !idle || reorgRecheckDue(prev, tip);
}

/**
 * Adds an unread window to the pending gap. A window inside the current gap keeps its pagination
 * progress (its content is fixed); otherwise the union is read again from its newest end.
 */
export function mergeGap(current: GapState | null, add: GapState): GapState {
  if (!current) return add;
  if (add.from >= current.from && add.to <= current.to) return current;
  return { from: Math.min(current.from, add.from), to: Math.max(current.to, add.to) };
}

function dedupeTxs(txs: readonly NormTx[]): NormTx[] {
  const seen = new Set<string>();
  return txs.filter((t) => (seen.has(t.txid) ? false : (seen.add(t.txid), true)));
}

function assertAddress(network: UtxoNetwork, address: string): void {
  if (!isPlausibleAddress(address) && !parseExtendedKey(address)) throw new Error(`Invalid ${NETWORKS[network].name} address`);
}

// --- Extended public keys (xpub / ypub / zpub / Ltub / Mtub) ---

/** Which script type an extended key uses, as detected from on-chain activity. */
export interface XpubState {
  type: ScriptType;
  /** False while the account has no transactions (type is a default guess, re-checked). */
  confident: boolean;
  probedAt: number;
}

/** Re-detect the script type of an empty account this often (its first tx reveals the type). */
const XPUB_REPROBE_MS = 10 * 60_000;
/** Cap for the list of derived addresses kept in the cursor (for internal-transfer detection). */
const MAX_OWN_ADDRESSES = 5_000;

function readXpubState(c: Cursor | null | undefined): XpubState | null {
  const t = c?.xtype;
  if (t !== 'pkh' && t !== 'sh-wpkh' && t !== 'wpkh' && t !== 'tr') return null;
  return { type: t, confident: c?.xconfident === true, probedAt: typeof c?.xprobedAt === 'number' ? c.xprobedAt : 0 };
}

function xpubCursorFields(x: XpubState | null, own: readonly string[] | null, ownCheckedAt?: number): Cursor {
  if (!x) return {};
  return {
    xtype: x.type,
    xconfident: x.confident,
    xprobedAt: x.probedAt,
    // Keep the newest addresses when capping (new receive/change addresses are appended).
    ...(own ? { ownAddresses: own.filter((a) => isPlausibleAddress(a)).slice(-MAX_OWN_ADDRESSES) } : {}),
    ...(ownCheckedAt ? { ownCheckedAt } : {}),
  };
}

/** Re-list used addresses when the saved list is empty (failed earlier, or a new account). */
const OWN_RECHECK_MS = 60 * 60_000;

function readOwnAddresses(c: Cursor | null | undefined): string[] {
  return Array.isArray(c?.ownAddresses)
    ? (c.ownAddresses as unknown[]).filter((a): a is string => typeof a === 'string' && isPlausibleAddress(a))
    : [];
}

/** Own addresses appearing in transactions (Blockbook marks them for extended-key queries). */
function ownAddressesIn(txs: readonly NormTx[]): string[] {
  const out = new Set<string>();
  for (const tx of txs) for (const io of [...tx.vin, ...tx.vout]) if (io.own) for (const a of io.addresses) out.add(a);
  return [...out];
}

export function createUtxoAdapter(network: 'bitcoin' | 'litecoin'): ChainAdapter {
  const info = NETWORKS[network];
  const assetKey = info.native.key;
  const log = createLogger(`utxo:${network}`);
  const providers = providerSetFor(network, log);

  let feeCache: { at: number; ttl: number; estimates: FeeEstimates | null } | null = null;
  let feeInflight: Promise<FeeEstimates | null> | null = null;
  const xpubStates = new Map<string, XpubState>();

  function toTransfers(txs: readonly NormTx[], xpubMode = false): RawTransfer[] {
    const out: RawTransfer[] = [];
    for (const tx of txs) {
      try {
        const t = computeTransfer(tx, { assetKey });
        if (!t) continue;
        if (xpubMode) {
          // Which of the account's addresses received / spent (shown in notifications).
          const ios = t.direction === 'in' ? tx.vout : tx.vin;
          const own = ios.find((io) => io.own)?.addresses[0];
          if (own) t.meta = { ...t.meta, ownAddress: own };
        }
        out.push(t);
      } catch (err) {
        log.warn(`skipping inconsistent tx ${tx.txid}`, err);
      }
    }
    return out;
  }

  /** Probes the script types of an extended key and keeps the one with activity. */
  async function detectXpubType(k: ExtendedKey, signal?: AbortSignal): Promise<XpubState> {
    const types = candidateTypes(k, network);
    if (types.length === 1) return { type: types[0]!, confident: true, probedAt: Date.now() };
    let best: { type: ScriptType; txs: number } | null = null;
    for (const type of types) {
      const s = await providers.run('history', (p) => p.client.summary(descriptorFor(k, type), signal), { signal, kinds: ['blockbook'] });
      const n = s.txs + s.unconfirmedTxs;
      if (n > 0 && (!best || n > best.txs)) best = { type, txs: n };
    }
    if (best) log.info(`${shortKey(k.original)} uses ${SCRIPT_LABEL[best.type]} addresses`);
    return best ? { type: best.type, confident: true, probedAt: Date.now() } : { type: types[0]!, confident: false, probedAt: Date.now() };
  }

  /**
   * What to send to providers: the address itself, or the output descriptor of an extended key.
   * `switched` is true when re-detection changed the script type (history must be re-read).
   */
  async function queryFor(
    address: string,
    cursor: Cursor | null,
    signal?: AbortSignal,
  ): Promise<{ q: string; x: XpubState | null; switched: boolean }> {
    const k = parseExtendedKey(address);
    if (!k) return { q: address, x: null, switched: false };
    const stored = readXpubState(cursor);
    let x = xpubStates.get(address) ?? stored;
    if (!x || (!x.confident && Date.now() - x.probedAt > XPUB_REPROBE_MS)) x = await detectXpubType(k, signal);
    xpubStates.set(address, x);
    // Compared with the type saved in the cursor (not the in-memory cache): if the poll that
    // first saw the switch fails, the next one still re-reads the whole history of the new type.
    const switched = stored !== null && stored.type !== x.type;
    return { q: descriptorFor(k, x.type), x, switched };
  }

  /** Used derived addresses of an extended key (best effort; only Blockbook can list them). */
  async function usedAddresses(q: string, signal?: AbortSignal): Promise<string[]> {
    try {
      return await providers.run(
        'history',
        (p) => {
          if (p.kind !== 'blockbook') throw new XpubUnsupportedError(p.id);
          return p.client.usedAddresses(q, signal);
        },
        { signal, kinds: ['blockbook'] },
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      log.debug('could not list used addresses of an extended key', err);
      return [];
    }
  }

  async function getTip(_signal?: AbortSignal): Promise<number> {
    const a = await providers.assessment();
    if (a.usable.length === 0) {
      throw new Error(`[${network}] no fresh provider available (${a.rejected.map((r) => `${r.id}: ${r.reason}`).join('; ')})`);
    }
    return Math.max(...a.usable.map((u) => u.tip));
  }

  async function getBalances(address: string, signal?: AbortSignal): Promise<Map<string, bigint>> {
    assertAddress(network, address);
    const { q, x } = await queryFor(address, null, signal);
    const s = await providers.run('mempool', (p) => p.client.balanceSummary(q, signal), {
      signal,
      ...(x ? { kinds: ['blockbook'] as const } : {}),
    });
    let total = s.balance + (s.unconfirmedBalance ?? 0n);
    if (total < 0n) {
      log.warn(`negative total balance reported for ${shortKey(address)}; using 0`);
      total = 0n;
    }
    return new Map([[assetKey, total]]);
  }

  async function initCursor(address: string, signal?: AbortSignal): Promise<Cursor> {
    assertAddress(network, address);
    const { q, x } = await queryFor(address, null, signal);
    const base = await providers.run(
      'mempool',
      async (p) => {
        // Validates the address with a provider. No fingerprint: p.tip can be a few seconds older
        // than the summary, so the first poll must always read from just below this height.
        await p.client.summary(q, signal);
        return { height: p.tip, fp: null };
      },
      { signal, ...(x ? { kinds: ['blockbook'] as const } : {}) },
    );
    return { ...base, ...xpubCursorFields(x, x ? await usedAddresses(q, signal) : null, x ? Date.now() : undefined) };
  }

  async function poll(address: string, cursor: Cursor, signal?: AbortSignal): Promise<PollResult> {
    assertAddress(network, address);
    const prev = readCursor(cursor);
    // The cursor height came from a fresh provider: anything far below it is stale.
    if (prev.height !== null) providers.noteHeight(prev.height);
    const isOurs = addressMatcher(address);
    const { q, x, switched } = await queryFor(address, cursor, signal);
    let knownOwn = readOwnAddresses(cursor);
    let ownCheckedAt = typeof cursor.ownCheckedAt === 'number' ? cursor.ownCheckedAt : 0;
    if (x && knownOwn.length === 0 && Date.now() - ownCheckedAt > OWN_RECHECK_MS) {
      knownOwn = await usedAddresses(q, signal);
      ownCheckedAt = Date.now();
    }
    return providers.run(
      'mempool',
      async (p: ActiveProvider): Promise<PollResult> => {
        // Fingerprint first: anything arriving after this call changes the next fingerprint.
        const summary = await p.client.summary(q, signal);
        const fp = fingerprint(summary);
        let gap = prev.gap;
        // A newly detected script type of an extended key: its whole history must be read once.
        if (switched) gap = mergeGap(gap, { from: 0, to: p.tip });
        if (!switched && !pollNeedsFetch(prev, fp, summary, p.tip)) {
          const { watch: _watch, gap: _gap, ...rest } = cursor;
          const watch = prev.watch !== null && p.tip - prev.watch < REORG_WATCH_DEPTH ? { watch: prev.watch } : {};
          return {
            transfers: [],
            cursor: { ...rest, ...watch, height: p.tip, fp, ...xpubCursorFields(x, x ? knownOwn : null, ownCheckedAt || undefined) },
          };
        }
        // Re-read from below the cursor (lagging providers, shallow reorgs) and from the block of
        // the newest recently confirmed tx while it can still be reorganized.
        const base = prev.height !== null ? Math.min(prev.height, prev.watch ?? prev.height) : null;
        const from = base !== null ? Math.max(0, base - REORG_MARGIN) : Math.max(0, p.tip - FALLBACK_LOOKBACK);
        const live = await p.client.recentTxs(q, from, isOurs, signal);
        if (!live.complete) {
          // Only the newest part was read: remember the rest instead of skipping it.
          const lost: GapState = { from, to: live.oldestHeight ?? p.tip, ...(live.resumeAfter ? { after: live.resumeAfter } : {}) };
          log.warn(
            `poll of ${shortKey(address)} read only the newest ${live.rawCount} txs; ` +
              `reading blocks ${lost.from}-${lost.to} over the next polls`,
          );
          gap = mergeGap(gap, lost);
        }
        let txs = live.txs;
        if (gap) {
          try {
            const r = await catchUpGap(p, q, gap, isOurs, signal);
            txs = dedupeTxs([...live.txs, ...r.txs]);
            gap = r.gap;
          } catch (err) {
            if (signal?.aborted || (err as { fatal?: boolean } | null)?.fatal) throw err;
            log.warn(`gap catch-up for ${shortKey(address)} failed; retrying next poll`, err);
          }
        }
        const transfers = toTransfers(txs, x !== null);
        const pending = [...new Set(transfers.filter((t) => t.status === 'pending').map((t) => t.txid))];
        let watch: number | null = null;
        for (const t of transfers) {
          const h = t.blockHeight;
          if (h !== null && p.tip - h < REORG_WATCH_DEPTH && (watch === null || h > watch)) watch = h;
        }
        const own = x ? [...new Set([...knownOwn, ...ownAddressesIn(txs)])] : null;
        return {
          transfers,
          cursor: {
            height: p.tip,
            fp,
            pending: pending.slice(0, MAX_PENDING_IN_CURSOR),
            ...(gap ? { gap } : {}),
            ...(watch !== null ? { watch } : {}),
            ...xpubCursorFields(x, own, ownCheckedAt || undefined),
          },
        };
      },
      // Extended keys can only be queried on Blockbook; keep its real error if it is down.
      { signal, ...(x ? { kinds: ['blockbook'] as const } : {}) },
    );
  }

  /**
   * Reads up to a few pages of a gap window (confirmed only, newest first, stable pagination).
   * Returns the remaining gap, or null when the window has been read completely.
   */
  async function catchUpGap(
    p: ActiveProvider,
    q: string,
    gap: GapState,
    isOurs: AddressMatcher,
    signal?: AbortSignal,
  ): Promise<{ txs: NormTx[]; gap: GapState | null }> {
    const txs: NormTx[] = [];
    if (p.kind === 'blockbook') {
      let page = gap.page ?? 1;
      for (let i = 0; i < GAP_PAGES_PER_POLL; i++, page++) {
        const res = await p.client.historyPage(q, { from: gap.from, to: gap.to }, page, GAP_PAGE_SIZE, isOurs, signal);
        if (res.page !== page) return { txs, gap: null };
        txs.push(...res.txs);
        if (res.rawCount < GAP_PAGE_SIZE) return { txs, gap: null };
      }
      return { txs, gap: { from: gap.from, to: gap.to, page } };
    }
    // Esplora has no height filter: walk the confirmed chain (newest first) and keep the window.
    let after = gap.after ?? null;
    for (let i = 0; i < ESPLORA_GAP_PAGES_PER_POLL; i++) {
      const res = await p.client.chainPage(q, after, isOurs, signal);
      txs.push(...res.txs.filter((t) => t.blockHeight !== null && t.blockHeight >= gap.from && t.blockHeight <= gap.to));
      if (res.rawCount < ESPLORA_CHAIN_PAGE || !res.lastTxid || res.lastHeight === null || res.lastHeight < gap.from) {
        return { txs, gap: null };
      }
      after = res.lastTxid;
    }
    return { txs, gap: { from: gap.from, to: gap.to, ...(after ? { after } : {}) } };
  }

  async function backfill(address: string, boundary: Cursor, opts: BackfillOptions = {}): Promise<RawTransfer[]> {
    assertAddress(network, address);
    const toHeight = readCursor(boundary).height;
    if (toHeight === null) throw new Error('backfill: boundary cursor has no height');
    providers.noteHeight(toHeight);
    const { signal, onBatch, onProgress } = opts;
    const isOurs = addressMatcher(address);
    const { q, x } = await queryFor(address, boundary, signal);
    const seen = new Set<string>();
    const all: RawTransfer[] = [];

    const emit = async (txs: readonly NormTx[]): Promise<void> => {
      const batch = toTransfers(
        txs.filter((t) => t.blockHeight !== null && t.blockHeight <= toHeight && !seen.has(t.txid)),
        x !== null,
      );
      if (batch.length === 0) return;
      for (const t of batch) seen.add(t.txid);
      all.push(...batch);
      await onBatch?.(batch);
    };
    const progress = (stage: string, done: number, total: number | null) => {
      onProgress?.({
        stage,
        done,
        ...(total ? { total, fraction: Math.min(0.99, done / total) } : {}),
      });
    };

    // Only provider failures trigger the Esplora fallback; errors from onBatch propagate.
    const providerFailure = (err: unknown): boolean => !signal?.aborted && !(err as { fatal?: boolean } | null)?.fatal;

    let done = 0;
    let blockbookError: unknown = null;
    let total: number | null = null;
    progress('Fetching transactions', 0, null);
    for (let page = 1; page <= MAX_BACKFILL_PAGES; page++) {
      signal?.throwIfAborted();
      let res: HistoryPage;
      try {
        res = await providers.run(
          'history',
          (p) => {
            if (p.kind !== 'blockbook') throw new Error('unexpected backend');
            return p.client.historyPage(q, { to: toHeight }, page, BACKFILL_PAGE_SIZE, isOurs, signal);
          },
          { signal, kinds: ['blockbook'] },
        );
      } catch (err) {
        if (!providerFailure(err)) throw err;
        blockbookError = err;
        break;
      }
      if (res.page !== page) break; // Blockbook repeats the last page for out-of-range requests.
      total ??= res.totalHint;
      await emit(res.txs);
      done += res.rawCount;
      progress('Fetching transactions', done, total);
      if (res.rawCount < BACKFILL_PAGE_SIZE) break;
    }

    // Esplora cannot query extended keys: the import retries later (/wallet reimport or restart).
    if (blockbookError !== null && x !== null) throw blockbookError;
    if (blockbookError !== null) {
      // Restart from the newest page on Esplora; rows already emitted are not repeated.
      log.warn(`Blockbook backfill failed for ${shortKey(address)}; continuing with Esplora`, blockbookError);
      done = 0;
      total = await providers
        .run('history', (p) => p.client.summary(address, signal), { signal, kinds: ['esplora'] })
        .then((s) => s.txs)
        .catch((err: unknown) => {
          if (!providerFailure(err)) throw err;
          return null;
        });
      let after: string | null = null;
      for (let page = 1; page <= MAX_BACKFILL_PAGES; page++) {
        signal?.throwIfAborted();
        const key: string | null = after;
        const res: ChainPage = await providers.run(
          'history',
          (p) => {
            if (p.kind !== 'esplora') throw new Error('unexpected backend');
            return p.client.chainPage(address, key, isOurs, signal);
          },
          { signal, kinds: ['esplora'] },
        );
        await emit(res.txs);
        done += res.rawCount;
        progress('Fetching transactions (fallback)', done, total);
        if (res.rawCount < ESPLORA_CHAIN_PAGE || !res.lastTxid) break;
        after = res.lastTxid;
      }
    }
    onProgress?.({ stage: 'Done', fraction: 1, done: all.length, total: all.length });
    return all;
  }

  async function getTxStatus(txid: string, _address: string, signal?: AbortSignal): Promise<TxStatusResult> {
    if (!isTxid(txid)) return { state: 'unknown' };
    // Every usable provider is asked (complete-mempool Blockbooks, Esplora, then the rest).
    return resolveTxStatus(await providers.ordered('mempool'), txid.toLowerCase(), {
      signal,
      recheckMs: DROP_RECHECK_MS,
      onError: (id, err) => log.debug(`tx status check failed on ${id}`, err),
    });
  }

  /** Cached ~60 s and shared by concurrent callers (so it is not tied to one caller's signal). */
  async function feeEstimates(): Promise<FeeEstimates | null> {
    if (feeCache && Date.now() - feeCache.at < feeCache.ttl) return feeCache.estimates;
    feeInflight ??= (async () => {
      try {
        const estimates = await providers.run('history', (p) => p.client.feeEstimates());
        feeCache = { at: Date.now(), ttl: FEE_TTL_MS, estimates };
        return estimates;
      } catch (err) {
        log.debug('fee estimates unavailable', err);
        feeCache = { at: Date.now(), ttl: FEE_FAILURE_TTL_MS, estimates: null };
        return null;
      } finally {
        feeInflight = null;
      }
    })();
    return feeInflight;
  }

  async function estimateConfirmationSeconds(feeRate: number, signal?: AbortSignal): Promise<number | null> {
    if (!Number.isFinite(feeRate) || feeRate <= 0) return null;
    signal?.throwIfAborted();
    const est = await feeEstimates();
    return est ? secondsForFeeRate(est, feeRate, info.blockTimeSec) : null;
  }

  return {
    network,
    getTip,
    getBalances,
    initCursor,
    poll,
    backfill,
    getTxStatus,
    estimateConfirmationSeconds,
  };
}
