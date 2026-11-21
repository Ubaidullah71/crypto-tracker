import { NETWORKS, type EvmNetworkId } from '../../core/networks.ts';
import { createLogger } from '../../logger.ts';
import { sleep } from '../../util/async.ts';
import { EndpointPool, httpJson, routeCount, SkipEndpointError } from '../../util/http.ts';
import { mergeRecord, NATIVE, type Leg, type TxRecord } from './aggregate.ts';
import type { ExplorerSpec } from './config.ts';
import { addr, decNum, decQty, isRecord, txHash } from './util.ts';

const log = createLogger('evm:explorer');

/** Rows per page. Etherscan requires page * offset <= 10000. */
export const PAGE_SIZE = 1000;
const MAX_WINDOW = 10_000;

export type ExplorerAction = 'txlist' | 'txlistinternal' | 'tokentx';

export interface ExplorerPage {
  rows: Record<string, unknown>[];
  /** The explorer said part of the range is not indexed yet (Blockscout internal txs). */
  incomplete: boolean;
}

export class ExplorerError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'ExplorerError';
    this.retryable = retryable;
  }
}

/**
 * Interprets an Etherscan / Blockscout "account" API response. "No transactions found" is an
 * empty result, rate-limit messages are retryable; key problems (KeyProblemError) and plan
 * restrictions (SourceUnavailableError) are typed so the caller can rotate keys or switch source.
 */
export function parseExplorerResponse(body: unknown): ExplorerPage {
  if (!isRecord(body)) throw new ExplorerError('explorer: unexpected response shape', true);
  const status = typeof body.status === 'string' ? body.status : '';
  const message = typeof body.message === 'string' ? body.message : '';
  const result = body.result;
  if (Array.isArray(result) && status !== '0') {
    return {
      rows: result.filter(isRecord),
      incomplete: /not yet been processed|not been indexed|still being indexed/i.test(message),
    };
  }
  if (status === '0' && /no (transactions|records|internal transactions|token transfers) found/i.test(message)) {
    return { rows: [], incomplete: false };
  }
  if (Array.isArray(result) && result.length === 0) return { rows: [], incomplete: false };
  const text = typeof result === 'string' ? result : message || 'unknown error';
  if (/invalid api key|missing\/invalid api key|api key (is )?(invalid|missing)/i.test(text)) {
    throw new KeyProblemError('invalid', `Etherscan rejected the API key: ${text}`);
  }
  if (/free api access is not supported|upgrade your api plan|not supported for this chain/i.test(text)) {
    // A plan restriction of this source for this chain, not a problem of the request.
    throw new SourceUnavailableError(`Etherscan does not serve this chain on the current plan: ${text}`);
  }
  if (/daily/i.test(text) && /limit/i.test(text)) {
    throw new KeyProblemError('daily', `Etherscan daily limit reached for this key: ${text}`);
  }
  if (/max (calls|rate) per sec|rate limit reached|too many requests|query timeout|please try again/i.test(text)) {
    throw new ExplorerError(`explorer busy: ${text}`, true);
  }
  throw new ExplorerError(`explorer error: ${message ? `${message}: ` : ''}${text}`.slice(0, 300), false);
}

export interface ExplorerStats {
  requests: number;
  byHost: Record<string, number>;
}

/** This source cannot serve this chain (e.g. Etherscan free plan): use another source for a while. */
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

/** How long a source that refused a chain is skipped before it is tried again. */
export const SOURCE_DISABLE_MS = 6 * 60 * 60_000;

/** A problem tied to one Etherscan key (another key may still work). */
export class KeyProblemError extends Error {
  readonly kind: 'invalid' | 'daily';
  constructor(kind: 'invalid' | 'daily', message: string) {
    super(message);
    this.name = 'KeyProblemError';
    this.kind = kind;
  }
}

interface KeyState {
  key: string;
  index: number;
  disabledUntil: number;
  invalid: boolean;
}

/**
 * Rotates requests over several Etherscan API keys. Each key has its own rate bucket; a key that
 * hits its per-second limit steps aside briefly, one at its daily cap rests until 00:00 UTC, and
 * an invalid key is dropped (with a warning) without stopping the others.
 */
export class KeyRing {
  private readonly keys: KeyState[];
  private cursor = 0;

  constructor(keys: readonly string[]) {
    this.keys = keys.map((key, index) => ({ key, index, disabledUntil: 0, invalid: false }));
  }

  get size(): number {
    return this.keys.length;
  }

  /** Next usable key, or null when none is usable right now. */
  next(): KeyState | null {
    const now = Date.now();
    for (let n = 0; n < this.keys.length; n++) {
      const k = this.keys[this.cursor++ % this.keys.length]!;
      if (!k.invalid && k.disabledUntil <= now) return k;
    }
    return null;
  }

  /** Milliseconds until the earliest temporarily disabled key is usable again (null: none will be). */
  waitMs(): number | null {
    const live = this.keys.filter((k) => !k.invalid);
    if (!live.length) return null;
    return Math.max(0, Math.min(...live.map((k) => k.disabledUntil)) - Date.now());
  }

  rateLimited(k: KeyState): void {
    k.disabledUntil = Math.max(k.disabledUntil, Date.now() + 1_100);
  }

  dailyLimit(k: KeyState): void {
    const d = new Date();
    k.disabledUntil = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 1);
    log.warn(`Etherscan key #${k.index + 1} reached its daily limit; using the other keys until 00:00 UTC`);
  }

  invalidKey(k: KeyState): void {
    k.invalid = true;
    log.warn(`Etherscan key #${k.index + 1} was rejected as invalid; check ETHERSCAN_API_KEY in .env`);
  }

  health(): Array<{ index: number; status: 'ok' | 'resting' | 'invalid' }> {
    const now = Date.now();
    return this.keys.map((k) => ({ index: k.index, status: k.invalid ? 'invalid' : k.disabledUntil > now ? 'resting' : 'ok' }));
  }
}

let sharedRing: KeyRing | null = null;
let sharedRingKeys = '';

/** One key ring shared by all EVM networks (Etherscan limits are per key, across chains). */
export function etherscanKeys(keys: readonly string[]): KeyRing {
  const sig = keys.join(',');
  if (!sharedRing || sharedRingKeys !== sig) {
    sharedRing = new KeyRing(keys);
    sharedRingKeys = sig;
  }
  return sharedRing;
}

/** Etherscan V2 (with keys) and/or Blockscout, with failover between them. */
export class Explorer {
  readonly network: EvmNetworkId;
  readonly stats: ExplorerStats = { requests: 0, byHost: {} };
  private readonly specs = new Map<string, ExplorerSpec>();
  private readonly pool: EndpointPool;
  private readonly keys: KeyRing;
  private readonly nextAt = new Map<string, number>();
  /** Sources skipped until a time (e.g. Etherscan refusing this chain on the free plan). */
  private readonly disabledUntil = new Map<string, number>();

  constructor(network: EvmNetworkId, specs: readonly ExplorerSpec[], apiKeys: readonly string[] | string | null) {
    this.network = network;
    const list = apiKeys === null ? [] : typeof apiKeys === 'string' ? [apiKeys] : apiKeys;
    this.keys = etherscanKeys(list);
    const usable = specs.filter((s) => s.kind !== 'etherscan' || this.keys.size > 0);
    if (usable.length === 0) throw new Error(`${network}: no explorer available (set ETHERSCAN_API_KEY)`);
    for (const s of usable) this.specs.set(s.url, s);
    this.pool = new EndpointPool(
      `${network}:explorer`,
      usable.map((s) => s.url),
    );
  }

  get sources(): string[] {
    return [...this.specs.values()].map((s) => s.kind);
  }

  private buildUrl(spec: ExplorerSpec, params: Record<string, string | number>, key: string | null): string {
    const q = new URLSearchParams();
    if (spec.kind === 'etherscan') q.set('chainid', String(NETWORKS[this.network].chainId));
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    if (spec.kind === 'etherscan' && key) q.set('apikey', key);
    return `${spec.url}?${q.toString()}`;
  }

  async query(params: Record<string, string | number>, signal?: AbortSignal): Promise<ExplorerPage> {
    return this.pool.run(async (base) => {
      const spec = this.specs.get(base)!;
      const host = new URL(base).host;
      if ((this.disabledUntil.get(base) ?? 0) > Date.now()) throw new SkipEndpointError(`${spec.kind} disabled for ${this.network}`);
      for (let attempt = 0; ; attempt++) {
        let key: KeyState | null = null;
        if (spec.kind === 'etherscan') {
          key = this.keys.next();
          if (!key) {
            const wait = this.keys.waitMs();
            // All keys invalid or resting for the day: let the pool fall back to Blockscout.
            if (wait === null || wait > 60_000) throw new ExplorerError('no usable Etherscan key right now', false);
            await sleep(wait + 50, signal);
            continue;
          }
        }
        if (spec.rps) {
          const now = Date.now();
          const at = Math.max(now, this.nextAt.get(base) ?? 0);
          this.nextAt.set(base, at + 1000 / (spec.rps * routeCount()));
          if (at > now) await sleep(at - now, signal);
        }
        this.stats.requests++;
        this.stats.byHost[host] = (this.stats.byHost[host] ?? 0) + 1;
        const url = this.buildUrl(spec, params, key?.key ?? null);
        const body = await httpJson<unknown>(url, {
          timeoutMs: 45_000,
          retries: 2,
          // Etherscan limits are per key, so each key gets its own bucket.
          ...(key ? { rateKey: `${host}#${key.index}` } : {}),
          ...(signal ? { signal } : {}),
        });
        try {
          return parseExplorerResponse(body);
        } catch (err) {
          if (err instanceof SourceUnavailableError) {
            this.disabledUntil.set(base, Date.now() + SOURCE_DISABLE_MS);
            log.warn(`${this.network}: ${err.message}; using the other explorer sources for ${SOURCE_DISABLE_MS / 3_600_000}h`);
            throw new SkipEndpointError(err.message);
          }
          if (key && err instanceof KeyProblemError) {
            if (err.kind === 'invalid') this.keys.invalidKey(key);
            else this.keys.dailyLimit(key);
            if (attempt < 10) continue;
          }
          if (err instanceof ExplorerError && err.retryable && attempt < 6) {
            if (key) {
              // Another key can take over at once; only wait when this was the only one.
              this.keys.rateLimited(key);
              if (this.keys.size > 1) continue;
            }
            await sleep(1_000 * (attempt + 1) + Math.floor(Math.random() * 300), signal);
            continue;
          }
          throw err;
        }
      }
    }, signal);
  }
}

// --- Row parsing ---

/** txlist row -> record (null if malformed). */
export function parseTxlistRow(row: Record<string, unknown>): TxRecord | null {
  const hash = txHash(row.hash);
  const block = decNum(row.blockNumber);
  const from = addr(row.from);
  const value = decQty(row.value);
  if (!hash || block === null || !from || value === null) return null;
  const to = addr(row.to) ?? addr(row.contractAddress);
  const gasUsed = decQty(row.gasUsed);
  const gasPrice = decQty(row.gasPrice);
  const failed = row.isError === '1' || row.txreceipt_status === '0';
  const legs: Leg[] = value > 0n && to ? [{ asset: NATIVE, from, to, value }] : [];
  return {
    hash,
    block,
    time: decNum(row.timeStamp),
    index: decNum(row.transactionIndex),
    sender: from,
    target: to,
    failed,
    fee: gasUsed !== null && gasPrice !== null ? gasUsed * gasPrice : null,
    gasPrice,
    legs,
  };
}

/** txlistinternal row (Etherscan "hash" / Blockscout "transactionHash") -> partial record. */
export function parseInternalRow(row: Record<string, unknown>): TxRecord | null {
  const hash = txHash(row.hash ?? row.transactionHash);
  const block = decNum(row.blockNumber);
  const from = addr(row.from);
  const value = decQty(row.value);
  if (!hash || block === null || !from || value === null) return null;
  const to = addr(row.to) ?? addr(row.contractAddress);
  const ok = row.isError !== '1';
  return {
    hash,
    block,
    time: decNum(row.timeStamp),
    sender: null,
    target: null,
    failed: false,
    fee: null,
    gasPrice: null,
    legs: ok && value > 0n && to ? [{ asset: NATIVE, from, to, value, internal: true }] : [],
  };
}

/** tokentx row -> partial record; only the expected contract, zero-value (poisoning) dropped. */
export function parseTokenRow(row: Record<string, unknown>, contract: string): TxRecord | null {
  const hash = txHash(row.hash ?? row.transactionHash);
  const block = decNum(row.blockNumber);
  const from = addr(row.from);
  const to = addr(row.to);
  const value = decQty(row.value);
  const c = addr(row.contractAddress);
  if (!hash || block === null || !from || !to || value === null || c !== contract.toLowerCase()) return null;
  const gasUsed = decQty(row.gasUsed);
  const gasPrice = decQty(row.gasPrice);
  return {
    hash,
    block,
    time: decNum(row.timeStamp),
    index: decNum(row.transactionIndex),
    sender: null,
    target: null,
    failed: false,
    fee: gasUsed !== null && gasPrice !== null ? gasUsed * gasPrice : null,
    gasPrice,
    legs: value > 0n ? [{ asset: c, from, to, value }] : [],
  };
}

// --- Windowed, paginated history ---

interface Stream {
  action: ExplorerAction;
  contract?: string;
  start: number;
  page: number;
  /** Rows of the last (possibly partial) block, replaced when that block is re-queried. */
  tail: Record<string, unknown>[];
  /** Highest block whose rows are fully committed. */
  coverage: number;
  done: boolean;
}

export interface HistoryOptions {
  from: number;
  to: number;
  signal?: AbortSignal;
  /** Streams complete records as soon as every source has covered their block. */
  onFlush?: (records: TxRecord[], coveredTo: number) => Promise<void> | void;
  onPage?: (info: { rows: number; coveredTo: number; requests: number }) => void;
  /** Stop after this many requests (bounded work); throws. */
  maxRequests?: number;
}

export interface HistoryResult {
  /** Records not handed to onFlush (all of them when onFlush is not given). */
  records: TxRecord[];
  /** Transactions sent by the address in the range (for nonce reconciliation). */
  sentTxs: number;
  /** Block of each transaction sent by the address. */
  sentBlocks: number[];
  incomplete: boolean;
  requests: number;
  rows: number;
}

export class ExplorerBudgetError extends Error {
  constructor(n: number) {
    super(`explorer history stopped after ${n} requests (budget exhausted)`);
    this.name = 'ExplorerBudgetError';
  }
}

/**
 * Fetches txlist + txlistinternal + tokentx (one stream per tracked contract) for [from, to].
 * Each stream pages with sort=asc; a full page restarts the window at the last block it saw
 * (that block's rows are re-fetched and replace the previous partial copy), which keeps
 * page * offset <= 10000. Records are merged by tx hash.
 */
export async function fetchHistory(
  explorer: Explorer,
  address: string,
  contracts: readonly string[],
  opts: HistoryOptions,
): Promise<HistoryResult> {
  const me = address.toLowerCase();
  const streams: Stream[] = [
    { action: 'txlist', start: opts.from, page: 1, tail: [], coverage: opts.from - 1, done: false },
    { action: 'txlistinternal', start: opts.from, page: 1, tail: [], coverage: opts.from - 1, done: false },
    ...contracts.map((c): Stream => ({
      action: 'tokentx',
      contract: c,
      start: opts.from,
      page: 1,
      tail: [],
      coverage: opts.from - 1,
      done: false,
    })),
  ];
  const pending = new Map<string, TxRecord>();
  const sent = new Map<string, number>();
  let requests = 0;
  let rowsSeen = 0;
  let incomplete = false;
  if (opts.to < opts.from) return { records: [], sentTxs: 0, sentBlocks: [], incomplete: false, requests: 0, rows: 0 };

  const commit = (s: Stream, rows: Record<string, unknown>[]): void => {
    for (const row of rows) {
      const rec =
        s.action === 'txlist'
          ? parseTxlistRow(row)
          : s.action === 'txlistinternal'
            ? parseInternalRow(row)
            : parseTokenRow(row, s.contract!);
      if (!rec) {
        log.debug(`${explorer.network}: skipped malformed ${s.action} row`);
        continue;
      }
      if (rec.block < opts.from || rec.block > opts.to) continue;
      if (s.action === 'txlist' && rec.sender === me) sent.set(rec.hash, rec.block);
      mergeRecord(pending, rec);
    }
  };

  while (streams.some((s) => !s.done)) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    if (opts.maxRequests !== undefined && requests >= opts.maxRequests) throw new ExplorerBudgetError(requests);
    const s = streams.filter((x) => !x.done).reduce((a, b) => (b.coverage < a.coverage ? b : a));
    const params: Record<string, string | number> = {
      module: 'account',
      action: s.action,
      address: me,
      startblock: s.start,
      endblock: opts.to,
      page: s.page,
      offset: PAGE_SIZE,
      sort: 'asc',
    };
    if (s.contract) params.contractaddress = s.contract;
    const res = await explorer.query(params, opts.signal);
    requests++;
    rowsSeen += res.rows.length;
    if (res.incomplete) incomplete = true;
    const rows = res.rows;
    if (s.page === 1) s.tail = [];

    if (rows.length < PAGE_SIZE) {
      commit(s, [...s.tail, ...rows]);
      s.tail = [];
      s.coverage = opts.to;
      s.done = true;
    } else {
      let last = s.start;
      for (const r of rows) {
        const b = decNum(r.blockNumber);
        if (b !== null && b > last) last = b;
      }
      if (last > s.start) {
        const blockOf = (r: Record<string, unknown>) => decNum(r.blockNumber) ?? last;
        commit(s, [...s.tail, ...rows.filter((r) => blockOf(r) < last)]);
        s.tail = rows.filter((r) => blockOf(r) === last);
        s.start = last;
        s.page = 1;
        s.coverage = last - 1;
      } else {
        // The whole page is one block: keep paging inside it.
        s.tail.push(...rows);
        s.page++;
        if (s.page * PAGE_SIZE > MAX_WINDOW) {
          log.warn(`${explorer.network}: more than ${MAX_WINDOW} ${s.action} rows in block ${s.start}; the rest is skipped`);
          commit(s, s.tail);
          s.tail = [];
          s.start += 1;
          s.page = 1;
          s.coverage = s.start - 1;
          if (s.start > opts.to) s.done = true;
        }
      }
    }

    const covered = Math.min(...streams.map((x) => x.coverage));
    opts.onPage?.({ rows: rowsSeen, coveredTo: covered, requests });
    if (opts.onFlush) {
      const ready = [...pending.values()].filter((r) => r.block <= covered);
      if (ready.length) {
        for (const r of ready) pending.delete(r.hash);
        await opts.onFlush(ready, covered);
      }
    }
  }
  return { records: [...pending.values()], sentTxs: sent.size, sentBlocks: [...sent.values()], incomplete, requests, rows: rowsSeen };
}
