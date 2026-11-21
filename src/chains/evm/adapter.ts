import { getConfig } from '../../config.ts';
import { NETWORKS, type EvmNetworkId } from '../../core/networks.ts';
import type { BackfillOptions, ChainAdapter, Cursor, PollResult, RawTransfer, TxStatusResult } from '../../core/types.ts';
import { createLogger } from '../../logger.ts';
import { netEffect, reconcile, toRawTransfers, type TxRecord } from './aggregate.ts';
import {
  bisect,
  estimateProbes,
  frontierOf,
  IncompleteScanError,
  type BisectProgress,
  type BisectResult,
  type Interval,
} from './bisect.ts';
import { analyzeChangeBlock, type AnalyzeContext } from './blocks.ts';
import { EVM_CONFIG, EXPLORER_MAX_RETRIES, type EvmNetworkConfig } from './config.ts';
import { Explorer, fetchHistory, type HistoryResult } from './explorer.ts';
import { discrepancyScan, type DiscrepancyResult } from './guided.ts';
import { fingerprint, parseFingerprint, probeAt, zeroState, type ChainState } from './probe.ts';
import { BadAnswerError, EvmRpc } from './rpc.ts';
import { hexNum, isRecord, toHex, txHash } from './util.ts';

/**
 * Cursor persisted by the tracker.
 * - block: last block whose effects are fully reported (the probe block).
 * - fp: fingerprint (nonce:balance:token...) of the address at `block`.
 * - retries: explorer networks only, polls in a row where the explorer did not yet explain a change.
 * - scan: a block scan was cut short by the poll time budget; (block, scan.hi] is known to contain
 *   a change and scan.fp is the fingerprint at scan.hi, so the next poll continues narrowing there.
 */
export interface EvmCursor {
  v: 1;
  block: number;
  fp: string;
  retries?: number;
  scan?: { hi: number; fp: string };
}

export interface EvmAdapterOptions {
  /** Bisection workers (2-4). Default: 2 for polls, 3 for backfill. */
  concurrency?: number;
  /** Bounded work for smoke tests: stop backfill after this many bisection probes. */
  maxProbes?: number;
  /** Bounded work for smoke tests: stop explorer backfill after this many requests. */
  maxExplorerRequests?: number;
  /** Override the endpoint configuration (tests). */
  config?: EvmNetworkConfig;
  /** How long a fetched tip is reused across polls of different addresses. Default 2000 ms. */
  tipMaxAgeMs?: number;
  /**
   * Time a poll may spend scanning blocks before it returns a partial cursor (the tracker aborts
   * polls after 90 s). Default 45 s.
   */
  pollBudgetMs?: number;
  /** Backoff before a failing bisection interval is retried (default 2 s, 5 s, 15 s). */
  retryDelaysMs?: number[];
}

export interface EvmAdapter extends ChainAdapter {
  readonly network: EvmNetworkId;
  readonly rpc: EvmRpc;
  /** Explorer client (Ethereum/Polygon), null for RPC networks or when none is usable. */
  explorer(): Explorer | null;
  /**
   * Bisection over (lo, hi] with known end states. Exposed for bounded smoke tests; emits
   * transfers per change block. Check `result.unresolved` for an incomplete scan.
   */
  scanRange(
    address: string,
    lo: number,
    hi: number,
    loState: ChainState,
    hiState: ChainState,
    opts?: BackfillOptions & { concurrency?: number; maxProbes?: number; deadline?: number },
  ): Promise<{ transfers: RawTransfer[]; result: BisectResult<ChainState> }>;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Explorer backfill: rows this close to the boundary are delivered only after verification. */
const BACKFILL_HOLDBACK_BLOCKS = 2_000;
/** Explorer live poll: probes spent looking for the latest explorer prefix that reconciles. */
const PREFIX_SEARCH_PROBES = 6;
/** Block-scan time budget inside one poll (the tracker aborts a poll after 90 s). */
const POLL_BUDGET_MS = 45_000;
/** How long an interrupted history scan can be resumed by the next backfill attempt. */
const RESUME_TTL_MS = 24 * 60 * 60_000;

function normalizeAddress(address: string): string {
  const a = address.trim();
  if (!ADDRESS.test(a)) throw new Error(`Invalid EVM address: ${a.slice(0, 50)}`);
  return a.toLowerCase();
}

interface ParsedCursor {
  block: number;
  state: ChainState | null;
  retries: number;
  scan: { hi: number; state: ChainState } | null;
}

function parseCursor(c: Cursor, tokenCount: number): ParsedCursor {
  const block = typeof c.block === 'number' && Number.isSafeInteger(c.block) && c.block >= 0 ? c.block : null;
  if (block === null) throw new Error('EVM cursor has no valid block');
  const retries = typeof c.retries === 'number' && Number.isSafeInteger(c.retries) && c.retries > 0 ? c.retries : 0;
  let scan: ParsedCursor['scan'] = null;
  if (isRecord(c.scan) && typeof c.scan.hi === 'number' && Number.isSafeInteger(c.scan.hi) && c.scan.hi > block) {
    const state = parseFingerprint(c.scan.fp, tokenCount);
    if (state) scan = { hi: c.scan.hi, state };
  }
  return { block, state: parseFingerprint(c.fp, tokenCount), retries, scan };
}

function makeCursor(block: number, state: ChainState, retries = 0, scan?: { hi: number; state: ChainState }): EvmCursor {
  return {
    v: 1,
    block,
    fp: fingerprint(state),
    ...(retries ? { retries } : {}),
    ...(scan ? { scan: { hi: scan.hi, fp: fingerprint(scan.state) } } : {}),
  };
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (err instanceof Error && err.name === 'AbortError');
}

const keyOf = (t: RawTransfer): string => `${t.txid}|${t.subId}`;
const sameRow = (a: RawTransfer, b: RawTransfer): boolean =>
  a.amount === b.amount && a.direction === b.direction && a.fee === b.fee && a.chargeFee === b.chargeFee && a.status === b.status;

export function createEvmAdapterInternal(network: EvmNetworkId, options: EvmAdapterOptions = {}): EvmAdapter {
  const info = NETWORKS[network];
  const cfg = options.config ?? EVM_CONFIG[network];
  const log = createLogger(`evm:${network}`);
  const rpc = new EvmRpc(network, cfg);
  const tokens = info.tokens.map((t) => t.contract!);
  /** Unresolved intervals of interrupted history scans, keyed by address + boundary. */
  const resumePoints = new Map<string, { intervals: Interval<ChainState>[]; at: number }>();
  let explorerClient: Explorer | null | undefined;

  const explorer = (): Explorer | null => {
    if (explorerClient !== undefined) return explorerClient;
    if (cfg.explorers.length === 0) return (explorerClient = null);
    try {
      explorerClient = new Explorer(network, cfg.explorers, getConfig().etherscanApiKeys);
      log.debug(`explorer sources: ${explorerClient.sources.join(', ')}`);
    } catch (err) {
      log.warn(`no usable explorer, falling back to block bisection: ${(err as Error).message}`);
      explorerClient = null;
    }
    return explorerClient;
  };

  const ctxFor = (address: string, signal?: AbortSignal): AnalyzeContext => ({
    rpc,
    network,
    address,
    tokens,
    opStack: cfg.opStack,
    ...(signal ? { signal } : {}),
  });

  const tipMaxAge = options.tipMaxAgeMs ?? 2_000;
  const head = async (): Promise<number> => (await rpc.tip(tipMaxAge)) - cfg.headLag;

  const stateAt = (address: string, block: number | 'latest', signal?: AbortSignal) => probeAt(rpc, address, tokens, block, signal);

  /** Bisection over several intervals; transfers are kept per change block (retries never duplicate). */
  async function runScan(
    address: string,
    intervals: Interval<ChainState>[],
    opts: {
      signal?: AbortSignal | undefined;
      concurrency?: number;
      maxProbes?: number | undefined;
      deadline?: number;
      onBatch?: BackfillOptions['onBatch'];
      onProgress?: (p: BisectProgress) => void;
    },
  ): Promise<{ transfers: RawTransfer[]; result: BisectResult<ChainState> }> {
    const byBlock = new Map<number, RawTransfer[]>();
    let emit: Promise<void> = Promise.resolve();
    const result = await bisect<ChainState>({
      intervals,
      key: fingerprint,
      probe: (b, s) => stateAt(address, b, s),
      concurrency: opts.concurrency ?? options.concurrency ?? 2,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.maxProbes !== undefined ? { maxProbes: opts.maxProbes } : {}),
      ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      onChange: async (block, before, after, s) => {
        const records = await analyzeChangeBlock(ctxFor(address, s), block, before, after);
        const transfers = toRawTransfers(network, address, records);
        if (transfers.length === 0) return;
        byBlock.set(block, transfers);
        if (opts.onBatch) {
          // Serialize onBatch calls even though blocks are analyzed concurrently.
          const sent = emit.then(() => opts.onBatch!(transfers));
          emit = sent.catch(() => {});
          await sent;
        }
      },
    });
    await emit;
    const transfers = [...byBlock.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, t]) => t);
    return { transfers, result };
  }

  async function scanRange(
    addressIn: string,
    lo: number,
    hi: number,
    loState: ChainState,
    hiState: ChainState,
    opts: BackfillOptions & { concurrency?: number; maxProbes?: number; deadline?: number } = {},
  ): Promise<{ transfers: RawTransfer[]; result: BisectResult<ChainState> }> {
    const { onProgress } = opts;
    return runScan(normalizeAddress(addressIn), [{ lo, hi, loState, hiState }], {
      signal: opts.signal,
      maxProbes: opts.maxProbes ?? options.maxProbes,
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
      ...(opts.onBatch ? { onBatch: opts.onBatch } : {}),
      ...(onProgress
        ? { onProgress: (p) => onProgress({ stage: 'Scanning blocks', fraction: p.total ? p.resolved / p.total : 1, done: p.probes }) }
        : {}),
    });
  }

  /**
   * Result of a poll whose block scan may have stopped early: everything up to the first
   * unresolved range is final and becomes the new cursor, and that range is remembered so the
   * next poll keeps narrowing it instead of starting over. Null when nothing moved.
   */
  function scanToPoll(
    c: ParsedCursor,
    to: number,
    after: ChainState,
    transfers: RawTransfer[],
    first: Interval<ChainState> | null,
    retries = 0,
  ): PollResult | null {
    if (!first) return { transfers, cursor: { ...makeCursor(to, after) } };
    const progressed = first.lo > c.block || first.hi < (c.scan?.hi ?? to);
    if (!progressed) return null;
    log.info(`poll resolved up to ${first.lo}, narrowing (${first.lo}, ${first.hi}] of (${c.block}, ${to}]; the next poll continues`);
    return {
      transfers: transfers.filter((t) => (t.blockHeight ?? 0) <= first.lo),
      cursor: { ...makeCursor(first.lo, first.loState, retries, { hi: first.hi, state: first.hiState }) },
    };
  }

  /** Scan intervals for (c.block, to]: a pending range from an interrupted scan comes first. */
  function pollIntervals(c: ParsedCursor, before: ChainState, to: number, after: ChainState): Interval<ChainState>[] {
    const p = c.scan && c.scan.hi <= to ? c.scan : null;
    if (!p) return [{ lo: c.block, hi: to, loState: before, hiState: after }];
    return [
      { lo: c.block, hi: p.hi, loState: before, hiState: p.state },
      ...(to > p.hi ? [{ lo: p.hi, hi: to, loState: p.state, hiState: after }] : []),
    ];
  }

  /**
   * Rows for a state change nobody could locate (explorer data accepted as-is after verification
   * kept failing): keeps the ledger equal to the chain at `block`.
   */
  function unlocatedResidual(block: number, before: ChainState, after: ChainState, known: readonly RawTransfer[]): RawTransfer[] {
    const eff = netEffect(network, known);
    const txid = `block:${block}:internal`;
    const rows: RawTransfer[] = [];
    const add = (assetKey: string, subId: string, signed: bigint, internal: boolean): void => {
      if (signed === 0n) return;
      rows.push({
        txid,
        subId,
        assetKey,
        direction: signed > 0n ? 'in' : 'out',
        amount: signed > 0n ? signed : -signed,
        fee: null,
        chargeFee: false,
        counterparty: null,
        blockHeight: block,
        blockTime: null,
        status: 'confirmed',
        meta: { syntheticTxid: true, unlocated: true, ...(internal ? { internal: true } : { residual: true }) },
      });
    };
    add(info.native.key, 'native', after.balance - before.balance - eff.native, true);
    info.tokens.forEach((t, i) => {
      add(t.key, `token:${t.contract}`, (after.tokens[i] ?? 0n) - (before.tokens[i] ?? 0n) - (eff.tokens.get(t.contract!) ?? 0n), false);
    });
    return rows;
  }

  /**
   * Binary search over the blocks the explorer returned for the latest block X < `to` such that
   * the explorer transfers up to X reconcile exactly with the chain state at X. At most
   * PREFIX_SEARCH_PROBES probes; null if no prefix reconciles.
   */
  async function acceptPrefix(
    address: string,
    from: number,
    to: number,
    before: ChainState,
    transfers: readonly RawTransfer[],
    sentBlocks: readonly number[],
    signal?: AbortSignal,
  ): Promise<PollResult | null> {
    const blocks = [...new Set(transfers.map((t) => t.blockHeight ?? 0))].filter((b) => b > from && b < to).sort((x, y) => x - y);
    let lo = 0;
    let hi = blocks.length - 1;
    let best: { block: number; state: ChainState } | null = null;
    for (let probes = 0; lo <= hi && probes < PREFIX_SEARCH_PROBES; probes++) {
      const mid = (lo + hi) >> 1;
      const x = blocks[mid]!;
      const state = await stateAt(address, x, signal);
      const part = transfers.filter((t) => (t.blockHeight ?? 0) <= x);
      if (reconcile(network, before, state, part, sentBlocks.filter((b) => b <= x).length).length === 0) {
        best = { block: x, state };
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (!best) return null;
    const b = best.block;
    return { transfers: transfers.filter((t) => (t.blockHeight ?? 0) <= b), cursor: { ...makeCursor(b, best.state) } };
  }

  /** Explorer-guided verification of (lo, hi]: only blocks the known transfers do not explain are re-derived from RPC. */
  async function guidedScan(
    address: string,
    lo: number,
    hi: number,
    loState: ChainState,
    hiState: ChainState,
    known: readonly RawTransfer[],
    sentBlocks: readonly number[],
    opts: {
      signal?: AbortSignal | undefined;
      maxProbes?: number | undefined;
      deadline?: number;
      split?: { block: number; state: ChainState } | undefined;
      onProgress?: BackfillOptions['onProgress'];
    } = {},
  ): Promise<DiscrepancyResult> {
    const last = known.reduce((m, t) => Math.max(m, t.blockHeight ?? 0), 0);
    const { onProgress } = opts;
    return discrepancyScan({
      network,
      lo,
      hi,
      loState,
      hiState,
      known,
      sentBlocks,
      probe: (b, s) => stateAt(address, b, s),
      analyze: async (b, before, after, s) =>
        toRawTransfers(network, address, await analyzeChangeBlock(ctxFor(address, s), b, before, after)),
      ...(last > lo ? { pivot: last } : {}),
      ...(opts.split ? { split: opts.split } : {}),
      concurrency: options.concurrency ?? 2,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.maxProbes !== undefined ? { maxProbes: opts.maxProbes } : {}),
      ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      ...(onProgress
        ? {
            onProgress: (p) =>
              onProgress({ stage: 'Verifying against chain state', fraction: p.total ? p.resolved / p.total : 1, done: p.probes }),
          }
        : {}),
    });
  }

  async function explorerRange(
    ex: Explorer,
    address: string,
    from: number,
    to: number,
    signal?: AbortSignal,
  ): Promise<{ transfers: RawTransfer[]; history: HistoryResult }> {
    const history = await fetchHistory(ex, address, tokens, { from, to, ...(signal ? { signal } : {}) });
    return { transfers: toRawTransfers(network, address, history.records), history };
  }

  /** Explorer history import, verified against the chain; repairs are re-emitted (upsert). */
  async function explorerBackfill(
    ex: Explorer,
    address: string,
    boundary: number,
    hiState: ChainState,
    opts: BackfillOptions,
  ): Promise<RawTransfer[]> {
    const started = Date.now();
    const all: RawTransfer[] = [];
    // Rows near the boundary are held back until the history is verified against the chain
    // (explorer lag at the tip is the usual reason a fresh backfill does not reconcile).
    const holdFrom = boundary - BACKFILL_HOLDBACK_BLOCKS;
    const held: RawTransfer[] = [];
    const emitted = new Map<string, RawTransfer>();
    const emitRows = async (rows: RawTransfer[]): Promise<void> => {
      if (rows.length === 0) return;
      for (const r of rows) emitted.set(keyOf(r), r);
      await opts.onBatch?.(rows);
    };
    const flushedSent: number[] = [];
    let first: number | null = null;
    const exBefore = ex.stats.requests;
    let history: HistoryResult | null = null;
    try {
      history = await fetchHistory(ex, address, tokens, {
        from: 0,
        to: boundary,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(options.maxExplorerRequests !== undefined ? { maxRequests: options.maxExplorerRequests } : {}),
        onPage: ({ rows, coveredTo }) => {
          const lo = first ?? 0;
          opts.onProgress?.({
            stage: 'Fetching transactions',
            fraction: boundary > lo ? Math.max(0, Math.min(1, (coveredTo - lo) / (boundary - lo))) : 1,
            done: rows,
          });
        },
        onFlush: async (records: TxRecord[]) => {
          for (const r of records) {
            if (first === null || r.block < first) first = r.block;
            if (r.sender === address && !r.hash.startsWith('block:')) flushedSent.push(r.block);
          }
          const t = toRawTransfers(network, address, records);
          all.push(...t);
          held.push(...t.filter((x) => (x.blockHeight ?? 0) > holdFrom));
          await emitRows(t.filter((x) => (x.blockHeight ?? 0) <= holdFrom));
        },
      });
    } catch (err) {
      if (isAbort(err, opts.signal)) throw err;
      // Explorer blocked or down part-way: whatever was delivered stays the base ("known") and the
      // chain fills in the rest, so nothing is imported twice under different txids.
      log.warn(`explorer history unavailable (${(err as Error).message}); completing from chain data`);
      opts.onProgress?.({ stage: 'Explorer unavailable, scanning blocks' });
    }
    if (history) {
      const rest = toRawTransfers(network, address, history.records);
      all.push(...rest);
      held.push(...rest);
    }
    const sentBlocks = history ? history.sentBlocks : flushedSent;
    const zero = zeroState(tokens.length);
    const problems = history ? reconcile(network, zero, hiState, all, history.sentTxs) : ['explorer history incomplete'];
    log.info(
      `backfill ${address.slice(0, 10)}: ${all.length} transfers from the explorer, ` +
        `${ex.stats.requests - exBefore} explorer requests, ${((Date.now() - started) / 1000).toFixed(1)}s` +
        (history?.incomplete ? ' (explorer reported unindexed data)' : ''),
    );
    let final = all;
    let out = held;
    if (problems.length) {
      log.info(`backfill ${address.slice(0, 10)}: explorer history does not match the chain (${problems.join('; ')}); locating the blocks`);
      opts.onProgress?.({ stage: 'Verifying against chain state' });
      const res = await guidedScan(address, 0, boundary, zero, hiState, all, sentBlocks, {
        signal: opts.signal,
        maxProbes: options.maxProbes,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      });
      if (res.firstUnresolved) {
        const safe = res.firstUnresolved.lo;
        await emitRows(held.filter((t) => (t.blockHeight ?? 0) <= safe && !res.replaced.has(t.blockHeight ?? -1)));
        throw new IncompleteScanError(
          `history verification incomplete (${res.stopped ?? 'failed'}); will retry`,
          { probes: res.probes, changes: res.replaced.size, unresolved: [] },
          { cause: res.error },
        );
      }
      final = res.transfers;
      // Repaired blocks: rows already delivered with other values are re-emitted (the tracker
      // upserts by txid/subId), rows that no longer apply are re-emitted with amount 0.
      const corrections: RawTransfer[] = [];
      for (const rows of res.replaced.values()) {
        for (const r of rows) {
          const prev = emitted.get(keyOf(r));
          if (prev && !sameRow(prev, r)) corrections.push(r);
        }
      }
      corrections.push(...res.retracted.filter((r) => emitted.has(keyOf(r))));
      out = [
        ...held.filter((t) => !res.replaced.has(t.blockHeight ?? -1)),
        ...[...res.replaced.values()].flat().filter((r) => !emitted.has(keyOf(r))),
      ];
      if (corrections.length) await emitRows(corrections);
      log.info(
        `backfill ${address.slice(0, 10)}: repaired ${res.replaced.size} block(s) from RPC data (${res.probes} probes)` +
          (corrections.length ? `, ${corrections.length} delivered row(s) corrected` : ''),
      );
    }
    const seen = new Set<string>();
    await emitRows(
      out.filter((r) => {
        const k = keyOf(r);
        if (seen.has(k) || emitted.has(k)) return false;
        seen.add(k);
        return true;
      }),
    );
    final.sort((x, y) => (x.blockHeight ?? 0) - (y.blockHeight ?? 0));
    return final;
  }

  const adapter: EvmAdapter = {
    network,
    rpc,
    explorer,
    scanRange,

    async getTip(): Promise<number> {
      return rpc.tip(Math.min(1_000, tipMaxAge));
    },

    async getBalances(addressIn: string, signal?: AbortSignal): Promise<Map<string, bigint>> {
      const address = normalizeAddress(addressIn);
      const s = await stateAt(address, 'latest', signal);
      const out = new Map<string, bigint>([[info.native.key, s.balance]]);
      info.tokens.forEach((t, i) => out.set(t.key, s.tokens[i] ?? 0n));
      return out;
    },

    async initCursor(addressIn: string, signal?: AbortSignal): Promise<Cursor> {
      const address = normalizeAddress(addressIn);
      const block = await head();
      const state = await stateAt(address, block, signal);
      return { ...makeCursor(block, state) };
    },

    async poll(addressIn: string, cursor: Cursor, signal?: AbortSignal): Promise<PollResult> {
      const address = normalizeAddress(addressIn);
      const c = parseCursor(cursor, tokens.length);
      // After downtime the range is covered over several polls.
      const to = Math.min(await head(), c.block + cfg.pollMaxSpan);
      if (to <= c.block) return { transfers: [], cursor };
      // Fingerprint from another token set (networks.ts changed): re-probe the cursor block.
      const before = c.state ?? (await stateAt(address, c.block, signal));
      const after = await stateAt(address, to, signal);
      // A pending range from an interrupted scan is known to contain a change, even if the
      // fingerprints at both ends happen to match again.
      const pending = c.scan && c.scan.hi <= to ? c.scan : null;
      if (!pending && fingerprint(before) === fingerprint(after)) return { transfers: [], cursor: { ...makeCursor(to, after) } };
      const budgetMs = options.pollBudgetMs ?? POLL_BUDGET_MS;
      const deadline = Date.now() + budgetMs;
      const parsed: ParsedCursor = { ...c, scan: pending };

      const ex = explorer();
      if (!ex) {
        const { transfers, result } = await runScan(address, pollIntervals(parsed, before, to, after), { signal, deadline });
        const res = scanToPoll(parsed, to, after, transfers, frontierOf(result));
        if (res) return res;
        if (result.stopped === 'failed')
          throw result.error instanceof Error ? result.error : new Error(`block scan failed in (${c.block}, ${to}]`);
        log.warn(`poll made no progress in (${c.block}, ${to}] within ${budgetMs / 1000}s`);
        return { transfers: [], cursor };
      }

      // Explorer network.
      let known: RawTransfer[] = [];
      let sentBlocks: number[] = [];
      try {
        const { transfers, history } = await explorerRange(ex, address, c.block + 1, to, signal);
        known = transfers;
        sentBlocks = history.sentBlocks;
        const problems = reconcile(network, before, after, transfers, history.sentTxs);
        if (problems.length === 0) return { transfers, cursor: { ...makeCursor(to, after) } };
        // Busy address: the explorer is usually complete up to some block before `to` (its
        // streams lag by different amounts). Accept the latest prefix that reconciles exactly.
        const accepted = await acceptPrefix(address, c.block, to, before, transfers, sentBlocks, signal);
        if (accepted) return accepted;
        if (c.retries < EXPLORER_MAX_RETRIES) {
          log.debug(`explorer does not explain the change in (${c.block}, ${to}] yet (${problems.join('; ')}), retry ${c.retries + 1}`);
          return { transfers: [], cursor: { ...makeCursor(c.block, before, c.retries + 1, pending ?? undefined) } };
        }
        log.info(
          `explorer still does not explain the change in (${c.block}, ${to}] (${problems.join('; ')}); verifying against chain state`,
        );
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        if ((err as { fatal?: boolean }).fatal) log.error(`explorer request rejected: ${(err as Error).message}`);
        else log.warn(`explorer unavailable, using block bisection: ${(err as Error).message}`);
      }

      let failure: unknown;
      try {
        const res = await guidedScan(address, c.block, to, before, after, known, sentBlocks, {
          signal,
          deadline,
          split: pending ? { block: pending.hi, state: pending.state } : undefined,
        });
        const done = scanToPoll(parsed, to, after, res.transfers, res.firstUnresolved, c.retries);
        if (done) return done;
        if (res.stopped !== 'failed') {
          log.warn(`poll made no progress in (${c.block}, ${to}] within ${budgetMs / 1000}s`);
          return { transfers: [], cursor };
        }
        failure = res.error;
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        failure = err;
      }
      const why = failure instanceof Error ? failure.message : String(failure);
      // Archive state unavailable for a long time: make progress with what the explorer has, plus
      // a residual row so balances still match the chain.
      if (known.length > 0 && c.retries >= EXPLORER_MAX_RETRIES + 20) {
        log.warn(`chain verification keeps failing (${why}); accepting explorer data with an unlocated residual`);
        return { transfers: [...known, ...unlocatedResidual(to, before, after, known)], cursor: { ...makeCursor(to, after) } };
      }
      log.warn(`chain verification failed, will retry: ${why}`);
      return { transfers: [], cursor: { ...makeCursor(c.block, before, c.retries + 1, pending ?? undefined) } };
    },

    async backfill(addressIn: string, boundary: Cursor, opts: BackfillOptions = {}): Promise<RawTransfer[]> {
      const address = normalizeAddress(addressIn);
      const b = parseCursor(boundary, tokens.length);
      const hiState = b.state ?? (await stateAt(address, b.block, opts.signal));
      const started = Date.now();
      const rpcBefore = rpc.stats.requests;
      await rpc.tip();
      const ex = explorer();
      if (ex) return explorerBackfill(ex, address, b.block, hiState, opts);

      // RPC network: bisection from genesis to the boundary on archive endpoints. An interrupted
      // scan leaves its unresolved intervals here; the next attempt continues from them (rows of
      // the finished intervals were already delivered through onBatch).
      const resumeKey = `${address}|${b.block}|${fingerprint(hiState)}`;
      for (const [k, v] of resumePoints) if (Date.now() - v.at > RESUME_TTL_MS) resumePoints.delete(k);
      let intervals = resumePoints.get(resumeKey)?.intervals;
      if (intervals) {
        const left = intervals.reduce((n, iv) => n + iv.hi - iv.lo, 0);
        log.info(`backfill ${address.slice(0, 10)}: resuming an interrupted scan (${intervals.length} range(s), ${left} blocks left)`);
      } else {
        let loState: ChainState;
        try {
          loState = await stateAt(address, 0, opts.signal);
        } catch (err) {
          if (isAbort(err, opts.signal)) throw err;
          loState = zeroState(tokens.length);
        }
        intervals = [{ lo: 0, hi: b.block, loState, hiState }];
        const estimate = estimateProbes(b.block, Number(hiState.nonce) * 2 + 2);
        log.info(
          `backfill ${address.slice(0, 10)}: bisecting ${b.block} blocks; nonce ${hiState.nonce} -> ~${estimate} probes ` +
            `+ ~3 requests per change block (rough estimate)`,
        );
      }
      const { onProgress } = opts;
      const { transfers, result } = await runScan(address, intervals, {
        signal: opts.signal,
        concurrency: options.concurrency ?? 3,
        maxProbes: options.maxProbes,
        ...(opts.onBatch ? { onBatch: opts.onBatch } : {}),
        ...(onProgress
          ? { onProgress: (p) => onProgress({ stage: 'Scanning blocks', fraction: p.total ? p.resolved / p.total : 1, done: p.probes }) }
          : {}),
      });
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (result.unresolved.length) {
        resumePoints.set(resumeKey, { intervals: result.unresolved, at: Date.now() });
        const left = result.unresolved.reduce((n, iv) => n + iv.hi - iv.lo, 0);
        const why =
          result.stopped === 'budget' ? 'probe budget exhausted' : result.stopped === 'deadline' ? 'time budget' : 'endpoint failures';
        throw new IncompleteScanError(
          `history scan incomplete after ${secs}s (${why}): ${result.unresolved.length} range(s) / ${left} blocks left; ` +
            `found transfers are kept and the next attempt resumes`,
          result,
          { cause: result.error },
        );
      }
      resumePoints.delete(resumeKey);
      log.info(
        `backfill ${address.slice(0, 10)}: ${transfers.length} transfers in ${result.changes} change blocks, ` +
          `${result.probes} probes, ${rpc.stats.requests - rpcBefore} RPC requests, ${secs}s`,
      );
      return transfers;
    },

    async getTxStatus(txid: string, _address: string, signal?: AbortSignal): Promise<TxStatusResult> {
      const synthetic = /^block:(\d+):/.exec(txid);
      if (synthetic) return { state: 'confirmed', blockHeight: Number(synthetic[1]), blockTime: null };
      const hash = txHash(txid);
      if (!hash) return { state: 'unknown' };
      const [receipt, tx] = await rpc.batch(
        'receipt',
        null,
        [
          { method: 'eth_getTransactionReceipt', params: [hash] },
          { method: 'eth_getTransactionByHash', params: [hash] },
        ],
        signal,
        ([r, t]) => {
          // Some nodes return a null receipt for old, mined txs: ask another endpoint.
          if (!isRecord(r) && isRecord(t) && t.blockNumber !== null && t.blockNumber !== undefined) {
            throw new BadAnswerError('receipt missing for a mined transaction');
          }
        },
      );
      if (isRecord(receipt)) {
        const blockHeight = hexNum(receipt.blockNumber);
        // Pre-Byzantium receipts have no status (treated as success, see parseReceipt).
        const status = receipt.status === undefined || receipt.status === null ? 1 : hexNum(receipt.status);
        let blockTime: number | null = null;
        if (blockHeight !== null) {
          try {
            const header = await rpc.call('block', blockHeight, 'eth_getBlockByNumber', [toHex(blockHeight), false], signal, (h) => {
              if (!isRecord(h)) throw new BadAnswerError('header not found');
            });
            blockTime = isRecord(header) ? hexNum(header.timestamp) : null;
          } catch (err) {
            if (isAbort(err, signal)) throw err;
          }
        }
        return { state: status === 0 ? 'failed' : 'confirmed', blockHeight, blockTime };
      }
      if (isRecord(tx) && (tx.blockNumber === null || tx.blockNumber === undefined))
        return { state: 'pending', blockHeight: null, blockTime: null };
      return { state: 'unknown' };
    },
  };
  return adapter;
}

/** EVM adapter for Ethereum, BNB Smart Chain, Polygon and Base. */
export function createEvmAdapter(network: EvmNetworkId): ChainAdapter {
  return createEvmAdapterInternal(network);
}
