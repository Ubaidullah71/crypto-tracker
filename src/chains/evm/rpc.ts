import type { EvmNetworkId } from '../../core/networks.ts';
import { createLogger } from '../../logger.ts';
import { chunk, sleep } from '../../util/async.ts';
import { EndpointPool, jsonRpc, jsonRpcBatch, routeCount, RpcError, type HttpOptions, type RpcCall } from '../../util/http.ts';
import { EVM_CONFIG, type EndpointSpec, type EvmNetworkConfig, type RpcCategory } from './config.ts';
import { hexNum } from './util.ts';

const log = createLogger('evm:rpc');

export interface RpcStats {
  /** HTTP requests sent (a batch counts once). */
  requests: number;
  /** JSON-RPC calls inside those requests. */
  calls: number;
  failures: number;
  byHost: Record<string, number>;
  byCategory: Record<string, number>;
}

/** Spaces requests to one endpoint (adapter-side cap on top of the http.ts host bucket). */
class Spacer {
  private next = 0;
  private readonly gapMs: number;
  constructor(rps: number) {
    this.gapMs = 1000 / rps;
  }
  async acquire(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await sleep(at - now, signal);
  }
}

/** Thrown from a pool callback when an endpoint answered but the answer is unusable (null block...). */
export class BadAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadAnswerError';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * JSON-RPC access for one EVM network: routes each call to "recent" endpoints (publicnode) or
 * archive endpoints by the age of the block it targets, batches with per-endpoint limits,
 * falls back to sequential calls when batches are rejected, and keeps request statistics.
 */
export class EvmRpc {
  readonly network: EvmNetworkId;
  readonly cfg: EvmNetworkConfig;
  readonly stats: RpcStats = { requests: 0, calls: 0, failures: 0, byHost: {}, byCategory: {} };
  private readonly specs = new Map<string, EndpointSpec>();
  private readonly spacers = new Map<string, Spacer>();
  private readonly noBatch = new Set<string>();
  private readonly recentPools = {} as Record<RpcCategory, EndpointPool>;
  private readonly archivePools = {} as Record<RpcCategory, EndpointPool[]>;
  private rotation = 0;
  private tipCache: { value: number; at: number } | null = null;
  private tipInflight: Promise<number> | null = null;

  constructor(network: EvmNetworkId, cfg: EvmNetworkConfig = EVM_CONFIG[network]) {
    this.network = network;
    this.cfg = cfg;
    for (const category of ['state', 'block', 'receipt', 'logs'] as const) {
      const route = cfg.routes[category];
      for (const s of [...route.recent, ...route.archive]) {
        if (!this.specs.has(s.url)) this.specs.set(s.url, s);
        // Per-IP pacing; proxies (routes) multiply the allowed rate.
        if (s.rps && !this.spacers.has(s.url)) this.spacers.set(s.url, new Spacer(s.rps * routeCount()));
      }
      const recentUrls = [...new Set([...route.recent, ...route.archive].map((s) => s.url))];
      this.recentPools[category] = new EndpointPool(`${network}:${category}`, recentUrls);
      const archive = route.archive.length ? route.archive : route.recent;
      const spread = archive.filter((s) => s.spread);
      const rest = archive.filter((s) => !s.spread);
      if (spread.length >= 2) {
        // Rotations spread load over several healthy archive endpoints; the rest stay as fallback.
        this.archivePools[category] = spread.map((_, i) => {
          const order = [...spread.slice(i), ...spread.slice(0, i), ...rest].map((s) => s.url);
          return new EndpointPool(`${network}:${category}:archive#${i}`, order);
        });
      } else {
        this.archivePools[category] = [
          new EndpointPool(
            `${network}:${category}:archive`,
            archive.map((s) => s.url),
          ),
        ];
      }
    }
  }

  /** Last known tip (may be stale); null before the first getTip. */
  get knownTip(): number | null {
    return this.tipCache?.value ?? null;
  }

  /** Current block number, cached for `maxAgeMs` and shared between concurrent callers. */
  async tip(maxAgeMs = 2_000): Promise<number> {
    if (this.tipCache && Date.now() - this.tipCache.at < maxAgeMs) return this.tipCache.value;
    this.tipInflight ??= (async () => {
      try {
        const [res] = await this.batch('state', 'latest', [{ method: 'eth_blockNumber', params: [] }], undefined, (r) => {
          const n = hexNum(r[0]);
          if (n === null || n <= 0) throw new BadAnswerError(`eth_blockNumber returned ${String(r[0]).slice(0, 40)}`);
        });
        const value = hexNum(res)!;
        this.tipCache = { value, at: Date.now() };
        return value;
      } finally {
        this.tipInflight = null;
      }
    })();
    return this.tipInflight;
  }

  private poolFor(category: RpcCategory, block: number | 'latest' | null): EndpointPool {
    if (block === 'latest' || block === null) return this.recentPools[category];
    const tip = this.tipCache?.value;
    if (tip === undefined || tip - block <= this.cfg.routes[category].window) return this.recentPools[category];
    const pools = this.archivePools[category];
    return pools[this.rotation++ % pools.length]!;
  }

  /**
   * Runs calls on one endpoint chosen for (category, block). All results must succeed; a
   * per-call error or a failed `validate` moves on to the next endpoint.
   */
  async batch(
    category: RpcCategory,
    block: number | 'latest' | null,
    calls: readonly RpcCall[],
    signal?: AbortSignal,
    validate?: (results: unknown[]) => void,
  ): Promise<unknown[]> {
    if (calls.length === 0) return [];
    // Same rule as poolFor, without advancing the archive rotation (that would skew load spreading).
    const tipNow = this.tipCache?.value;
    const isArchive = block !== 'latest' && block !== null && tipNow !== undefined && tipNow - block > this.cfg.routes[category].window;
    // Archive endpoints are few and sometimes briefly unavailable (the pruned fallbacks then
    // answer "missing trie node"): wait and retry before failing a whole history import.
    const delays = isArchive ? [5_000, 15_000] : [];
    for (let attempt = 0; ; attempt++) {
      const pool = this.poolFor(category, block);
      try {
        return await pool.run(async (url) => {
          try {
            const res = await this.runOn(url, category, calls, signal);
            validate?.(res);
            return res;
          } catch (err) {
            this.stats.failures++;
            throw err;
          }
        }, signal);
      } catch (err) {
        const delay = delays[attempt];
        if (delay === undefined || signal?.aborted || (err as { fatal?: boolean }).fatal) throw err;
        log.debug(`${this.network}: ${category} archive request failed, retrying in ${delay / 1000}s`, err);
        await sleep(delay, signal);
      }
    }
  }

  async call<T = unknown>(
    category: RpcCategory,
    block: number | 'latest' | null,
    method: string,
    params: unknown[],
    signal?: AbortSignal,
    validate?: (result: unknown) => void,
  ): Promise<T> {
    const [r] = await this.batch(category, block, [{ method, params }], signal, validate ? (res) => validate(res[0]) : undefined);
    return r as T;
  }

  private count(url: string, category: RpcCategory, calls: number): void {
    const host = hostOf(url);
    this.stats.requests++;
    this.stats.calls += calls;
    this.stats.byHost[host] = (this.stats.byHost[host] ?? 0) + 1;
    this.stats.byCategory[category] = (this.stats.byCategory[category] ?? 0) + 1;
  }

  private async runOn(url: string, category: RpcCategory, calls: readonly RpcCall[], signal?: AbortSignal): Promise<unknown[]> {
    const spec = this.specs.get(url);
    const opts: HttpOptions = { retries: spec?.retries ?? 2, timeoutMs: 20_000, ...(signal ? { signal } : {}) };
    const size = this.noBatch.has(url) ? 1 : Math.max(1, spec?.maxBatch ?? 1);
    const out: unknown[] = [];
    for (const part of chunk(calls, size)) {
      out.push(...(await this.send(url, category, part, opts)));
    }
    return out;
  }

  private async send(url: string, category: RpcCategory, part: readonly RpcCall[], opts: HttpOptions): Promise<unknown[]> {
    const spacer = this.spacers.get(url);
    if (part.length === 1) {
      await spacer?.acquire(opts.signal);
      this.count(url, category, 1);
      return [await jsonRpc(url, part[0]!.method, part[0]!.params, opts)];
    }
    await spacer?.acquire(opts.signal);
    this.count(url, category, part.length);
    let rejected = false;
    try {
      const res = await jsonRpcBatch(url, part, opts);
      const out: unknown[] = [];
      for (const r of res) {
        if (!r.ok) {
          if (/batch/i.test(r.error.message)) {
            rejected = true;
            break;
          }
          throw r.error;
        }
        out.push(r.result);
      }
      if (!rejected) return out;
    } catch (err) {
      // jsonRpcBatch reports a non-array answer as "batch rejected: <server message>".
      const inner = err instanceof RpcError ? err.message.replace(/^batch rejected:\s*/i, '') : '';
      if (!(err instanceof RpcError) || !/batch|invalid request|parse error|unexpected response/i.test(inner)) throw err;
      rejected = true;
    }
    // The endpoint does not accept (this size of) batches: remember and go sequential.
    log.debug(`${this.network}: batches rejected by ${hostOf(url)}, using sequential calls`);
    this.noBatch.add(url);
    const out: unknown[] = [];
    for (const c of part) {
      await spacer?.acquire(opts.signal);
      this.count(url, category, 1);
      out.push(await jsonRpc(url, c.method, c.params, opts));
    }
    return out;
  }
}
