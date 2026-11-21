import { createLogger } from '../../logger.ts';
import { sleep } from '../../util/async.ts';
import { EndpointPool, RpcError, jsonRpc, jsonRpcBatch, type HttpOptions, type RpcCall, routeCount } from '../../util/http.ts';

const log = createLogger('solana:rpc');

// --- Endpoints ---

export interface SolanaEndpoint {
  url: string;
  /** Serves getSignaturesForAddress/getTransaction back to genesis (BigTable-backed). */
  fullHistory: boolean;
  /** Shared rate-limit bucket in util/http.ts (defaults to the host). */
  rateKey?: string;
  /** Minimum spacing between calls of the same method (server-side per-method limits). */
  methodIntervalMs?: number;
  /** Accepts JSON-RPC batches (default true). When false, batches are sent as single calls. */
  batch?: boolean;
}

/**
 * Keyless mainnet endpoints, verified 2026-11:
 * - publicnode: fast and generous (60 req at 12 rps without 429), but only ~2.5 days of ledger
 *   (older txs return null, signature lists just end) and no keyless "indexed" methods
 *   (getTokenAccountsByOwner -> -32602 "requires a personal token"). Used first for live reads only.
 * - Trezor (sol1/sol2) and Ledger: wallet-vendor backends with full history, ~8 rps without 429s.
 *   Undocumented public infrastructure - may change without notice.
 * - Solana Foundation: full history but only 10 calls per method per ~10 s per IP (getTransaction,
 *   getSignaturesForAddress, getTokenAccountsByOwner), batch items count individually, and batches
 *   holding two getTokenAccountsByOwner calls are always 429 ("method-limit: 0"). Last resort.
 *   api.mainnet.solana.com shares the same quota, so it adds no capacity.
 * Rejected: Tatum gateway (anonymous: 5 req/min, no getSignaturesForAddress), solanavibestation
 * (partial history, inconsistent paging), sol5.trezor.io (inconsistent signature lists),
 * drpc/ankr/blockpi/onfinality/chainstack/helius (need keys).
 */
export const SOLANA_ENDPOINTS = {
  publicnode: { url: 'https://solana-rpc.publicnode.com', fullHistory: false },
  trezor1: { url: 'https://sol1.trezor.io', fullHistory: true, rateKey: 'sol.trezor.io' },
  trezor2: { url: 'https://sol2.trezor.io', fullHistory: true, rateKey: 'sol.trezor.io' },
  ledger: { url: 'https://solana.coin.ledger.com', fullHistory: true },
  foundation: { url: 'https://api.mainnet-beta.solana.com', fullHistory: true, methodIntervalMs: 1100, batch: false },
} as const satisfies Record<string, SolanaEndpoint>;

export interface SolanaPoolConfig {
  /** Recent data (live polling): signatures, recent transactions, statuses, slot. */
  live: readonly SolanaEndpoint[];
  /** Full-history endpoints. Backfill rotates the order to spread load. */
  history: readonly SolanaEndpoint[];
}

const E = SOLANA_ENDPOINTS;
export const DEFAULT_POOLS: SolanaPoolConfig = {
  live: [E.publicnode, E.trezor1, E.ledger, E.foundation],
  history: [E.trezor1, E.ledger, E.trezor2, E.foundation],
};

// --- Errors ---

/** Retryable "not here, try another endpoint" condition (null result, history gap). */
export class EndpointMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointMissError';
  }
}

// --- Per-method pacing ---

class IntervalGate {
  private next = 0;
  private readonly intervalMs: number;
  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }
  async wait(units: number, signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.next);
    this.next = start + this.intervalMs * Math.max(1, units);
    if (start > now) await sleep(start - now, signal);
  }
}

const gates = new Map<string, IntervalGate>();

async function pace(ep: SolanaEndpoint, methods: readonly string[], signal?: AbortSignal): Promise<void> {
  if (!ep.methodIntervalMs) return;
  const counts = new Map<string, number>();
  for (const m of methods) counts.set(m, (counts.get(m) ?? 0) + 1);
  for (const [m, n] of counts) {
    const key = `${ep.url}#${m}`;
    let g = gates.get(key);
    // Per-IP limit: with several connection routes (proxies) the gap shrinks accordingly.
    if (!g) gates.set(key, (g = new IntervalGate(ep.methodIntervalMs / routeCount())));
    await g.wait(n, signal);
  }
}

// --- Client ---

export interface CallOptions {
  signal?: AbortSignal;
  /** Transport retries per endpoint before failing over. */
  retries?: number;
  timeoutMs?: number;
}

/** Usage counters (smoke tests / diagnostics). */
export interface RpcStats {
  requests: number;
  calls: number;
  byMethod: Record<string, number>;
  byHost: Record<string, number>;
}

let pools = 0;

export class SolanaRpc {
  readonly live: EndpointPool;
  readonly history: readonly EndpointPool[];
  private readonly endpoints = new Map<string, SolanaEndpoint>();
  readonly stats: RpcStats = { requests: 0, calls: 0, byMethod: {}, byHost: {} };

  constructor(config: SolanaPoolConfig = DEFAULT_POOLS) {
    for (const ep of [...config.live, ...config.history]) this.endpoints.set(ep.url, ep);
    const id = pools++ === 0 ? '' : `#${pools}`;
    this.live = new EndpointPool(
      `solana-live${id}`,
      config.live.map((e) => e.url),
    );
    const h = config.history.map((e) => e.url);
    // Two rotations (A,B,...) and (B,A,...) so concurrent backfill requests use two hosts.
    const rotated = h.length > 1 ? [h, [h[1]!, h[0]!, ...h.slice(2)]] : [h];
    this.history = rotated.map((urls, i) => new EndpointPool(`solana-history${id}-${i}`, urls));
  }

  endpoint(url: string): SolanaEndpoint {
    return this.endpoints.get(url) ?? { url, fullHistory: false };
  }

  /** Pool for indexed queries (getTokenAccountsByOwner) and old slots (getBlockTime). */
  get indexed(): EndpointPool {
    return this.history[0]!;
  }

  private readonly ledgerStarts = new Map<string, { slot: number | null; at: number }>();

  /**
   * Oldest slot a limited-history endpoint still has (minimumLedgerSlot), cached for 10 minutes.
   * Null when unknown.
   */
  async ledgerStart(url: string, signal?: AbortSignal): Promise<number | null> {
    const hit = this.ledgerStarts.get(url);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.slot;
    let slot: number | null = null;
    try {
      const v = await this.callAt<unknown>(url, 'minimumLedgerSlot', [], { signal });
      slot = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    this.ledgerStarts.set(url, { slot, at: Date.now() });
    return slot;
  }

  historyPool(i = 0): EndpointPool {
    return this.history[i % this.history.length]!;
  }

  private httpOpts(ep: SolanaEndpoint, o: CallOptions): HttpOptions {
    return {
      retries: o.retries ?? 1,
      timeoutMs: o.timeoutMs ?? 20_000,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(ep.rateKey ? { rateKey: ep.rateKey } : {}),
    };
  }

  private count(url: string, methods: readonly string[]): void {
    this.stats.requests++;
    this.stats.calls += methods.length;
    const host = new URL(url).host;
    this.stats.byHost[host] = (this.stats.byHost[host] ?? 0) + 1;
    for (const m of methods) this.stats.byMethod[m] = (this.stats.byMethod[m] ?? 0) + 1;
  }

  /** One JSON-RPC call against a specific endpoint URL. */
  async callAt<T>(url: string, method: string, params: unknown, o: CallOptions = {}): Promise<T> {
    const ep = this.endpoint(url);
    await pace(ep, [method], o.signal);
    this.count(url, [method]);
    return jsonRpc<T>(url, method, params, this.httpOpts(ep, o));
  }

  /** JSON-RPC batch against a specific endpoint; any failed item fails the whole batch. */
  async batchAt(url: string, calls: readonly RpcCall[], o: CallOptions = {}): Promise<unknown[]> {
    if (calls.length === 0) return [];
    const ep = this.endpoint(url);
    if (calls.length === 1 || ep.batch === false) {
      const out: unknown[] = [];
      for (const c of calls) out.push(await this.callAt(url, c.method, c.params, o));
      return out;
    }
    await pace(
      ep,
      calls.map((c) => c.method),
      o.signal,
    );
    this.count(
      url,
      calls.map((c) => c.method),
    );
    const res = await jsonRpcBatch(url, calls, this.httpOpts(ep, o));
    return res.map((r) => {
      if (!r.ok) throw r.error;
      return r.result;
    });
  }

  call<T>(pool: EndpointPool, method: string, params: unknown, o: CallOptions = {}): Promise<T> {
    return pool.run((url) => this.callAt<T>(url, method, params, o), o.signal);
  }

  batch(pool: EndpointPool, calls: readonly RpcCall[], o: CallOptions = {}): Promise<unknown[]> {
    return pool.run((url) => this.batchAt(url, calls, o), o.signal);
  }
}

// --- Validated method wrappers ---

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export type Commitment = 'processed' | 'confirmed' | 'finalized';

export interface SignatureInfo {
  signature: string;
  slot: number;
  failed: boolean;
  blockTime: number | null;
  confirmationStatus: Commitment | null;
}

function asCommitment(v: unknown): Commitment | null {
  return v === 'processed' || v === 'confirmed' || v === 'finalized' ? v : null;
}

export function parseSignatureList(v: unknown): SignatureInfo[] {
  if (!Array.isArray(v)) throw new RpcError('getSignaturesForAddress: result is not an array', -1);
  const out: SignatureInfo[] = [];
  for (const e of v) {
    if (!isObj(e) || typeof e.signature !== 'string' || typeof e.slot !== 'number' || !Number.isInteger(e.slot)) {
      throw new RpcError('getSignaturesForAddress: malformed entry', -1);
    }
    out.push({
      signature: e.signature,
      slot: e.slot,
      failed: e.err !== null && e.err !== undefined,
      blockTime: typeof e.blockTime === 'number' ? e.blockTime : null,
      confirmationStatus: asCommitment(e.confirmationStatus),
    });
  }
  return out;
}

export interface SignatureStatus {
  slot: number;
  failed: boolean;
  confirmationStatus: Commitment | null;
}

export function parseSignatureStatuses(v: unknown, expected: number): Array<SignatureStatus | null> {
  if (!isObj(v) || !Array.isArray(v.value) || v.value.length !== expected) {
    throw new RpcError('getSignatureStatuses: malformed result', -1);
  }
  return v.value.map((s) => {
    if (s === null) return null;
    if (!isObj(s) || typeof s.slot !== 'number') throw new RpcError('getSignatureStatuses: malformed entry', -1);
    return { slot: s.slot, failed: s.err !== null && s.err !== undefined, confirmationStatus: asCommitment(s.confirmationStatus) };
  });
}

export interface TokenAccountInfo {
  pubkey: string;
  mint: string;
  owner: string;
  amount: bigint;
}

/** Parses getTokenAccountsByOwner (jsonParsed). Returns the context slot and accounts. */
export function parseTokenAccounts(v: unknown): { slot: number; accounts: TokenAccountInfo[] } {
  if (!isObj(v) || !isObj(v.context) || typeof v.context.slot !== 'number' || !Array.isArray(v.value)) {
    throw new RpcError('getTokenAccountsByOwner: malformed result', -1);
  }
  const accounts: TokenAccountInfo[] = [];
  for (const e of v.value) {
    const info =
      isObj(e) && isObj(e.account) && isObj(e.account.data) && isObj(e.account.data.parsed) ? e.account.data.parsed.info : undefined;
    const amount = isObj(info) && isObj(info.tokenAmount) ? info.tokenAmount.amount : undefined;
    if (!isObj(e) || typeof e.pubkey !== 'string' || !isObj(info) || typeof info.mint !== 'string' || typeof info.owner !== 'string') {
      throw new RpcError('getTokenAccountsByOwner: malformed account', -1);
    }
    if (typeof amount !== 'string' || !/^\d{1,40}$/.test(amount)) throw new RpcError('getTokenAccountsByOwner: malformed amount', -1);
    accounts.push({ pubkey: e.pubkey, mint: info.mint, owner: info.owner, amount: BigInt(amount) });
  }
  return { slot: v.context.slot, accounts };
}

export function parseLamports(v: unknown): bigint {
  const n = isObj(v) ? v.value : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new RpcError('getBalance: malformed result', -1);
  return BigInt(n);
}

export function parseSlot(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new RpcError('getSlot: malformed result', -1);
  return v;
}

// --- getTransaction with version negotiation ---

/** Highest transaction version we request; raised automatically when the cluster reports a newer one. */
let maxTxVersion = 1;

function unsupportedVersion(err: unknown): number | null {
  if (!(err instanceof RpcError) || err.code !== -32015) return null;
  const m = /Transaction version \((\d+)\)/.exec(err.message);
  const v = m ? Number(m[1]) : NaN;
  return Number.isInteger(v) && v > maxTxVersion && v < 16 ? v : null;
}

/** getTransaction (jsonParsed) on one endpoint. Throws EndpointMissError when the endpoint returns null. */
export async function getTransactionAt(rpc: SolanaRpc, url: string, signature: string, o: CallOptions = {}): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await rpc.callAt<unknown>(
        url,
        'getTransaction',
        [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: maxTxVersion, commitment: 'confirmed' }],
        o,
      );
      if (res === null || res === undefined) throw new EndpointMissError(`transaction not available at ${new URL(url).host}`);
      return res;
    } catch (err) {
      const v = unsupportedVersion(err);
      if (v === null || attempt > 0) throw err;
      log.info(`cluster reports transaction version ${v}; requesting it from now on`);
      maxTxVersion = v;
    }
  }
  throw new Error('unreachable');
}

/** getTransaction via a pool; null when no endpoint has it. */
export async function getTransaction(rpc: SolanaRpc, pool: EndpointPool, signature: string, o: CallOptions = {}): Promise<unknown | null> {
  try {
    return await pool.run((url) => getTransactionAt(rpc, url, signature, o), o.signal);
  } catch (err) {
    if (err instanceof EndpointMissError) return null;
    throw err;
  }
}
