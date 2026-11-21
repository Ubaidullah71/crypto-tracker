import { Agent, ProxyAgent, fetch, type Dispatcher } from 'undici';
import { getConfig } from '../config.ts';
import { createLogger, redact } from '../logger.ts';
import { sleep } from './async.ts';

const log = createLogger('http');

// --- Errors ---

export class HttpError extends Error {
  readonly status: number | null;
  readonly url: string;
  readonly retryable: boolean;
  readonly bodySnippet: string | undefined;
  constructor(message: string, status: number | null, url: string, retryable: boolean, bodySnippet?: string) {
    super(redact(message));
    this.name = 'HttpError';
    this.status = status;
    this.url = redact(url);
    this.retryable = retryable;
    this.bodySnippet = bodySnippet ? redact(bodySnippet.slice(0, 300)) : undefined;
  }
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(redact(message));
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Throw inside EndpointPool.run to move on to the next endpoint without counting a failure
 * (e.g. the endpoint is stale or lower priority for this particular call).
 */
export class SkipEndpointError extends Error {
  readonly skip = true;
  constructor(message: string) {
    super(message);
    this.name = 'SkipEndpointError';
  }
}

/** Throw (or wrap) with this to stop EndpointPool from trying other endpoints. */
export class FatalRequestError extends Error {
  readonly fatal = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(redact(message), options);
    this.name = 'FatalRequestError';
  }
}

// --- Rate limiting (token bucket per host) ---

/** Requests per second allowed per host (before HTTP_RATE_MULTIPLIER). */
const HOST_RPS: Record<string, number> = {
  'api.etherscan.io': 4,
  'eth.blockscout.com': 3,
  'api.coingecko.com': 0.2,
  'data-api.binance.vision': 8,
  'api.exchange.coinbase.com': 3,
  'api.mainnet-beta.solana.com': 1,
  'sol.trezor.io': 6,
  'solana.coin.ledger.com': 6,
  'solana-rpc.publicnode.com': 5,
  'xrplcluster.com': 4,
  's1.ripple.com': 4,
  's2.ripple.com': 4,
  'btc1.trezor.io': 2,
  'btcbook.guarda.co': 4,
  'blockbook.btc.zelcore.io': 4,
  'litecoinblockexplorer.net': 4,
  // Answers 429 to bursts of ~5 requests; 2/s sustained is fine.
  'blockbook.ltc.zelcore.io': 1.5,
  'litecoin.atomicwallet.io': 3,
  'litecoinspace.org': 3,
  'blockstream.info': 4,
  'mempool.space': 4,
  'ethereum-rpc.publicnode.com': 6,
  'bsc-rpc.publicnode.com': 6,
  'polygon-bor-rpc.publicnode.com': 6,
  'base-rpc.publicnode.com': 6,
  '1rpc.io': 3,
  'bsc-mainnet.public.blastapi.io': 4,
  'base-mainnet.public.blastapi.io': 4,
  'eth-mainnet.public.blastapi.io': 3,
  'eth-pokt.nodies.app': 3,
  'base-pokt.nodies.app': 4,
  'rpc.mevblocker.io': 2,
  'mainnet.base.org': 5,
  'base.drpc.org': 2,
  'bsc.drpc.org': 1,
  'eth.drpc.org': 1.5,
  'polygon.drpc.org': 1.5,
  'polygon.blockscout.com': 3,
  'bsc.meowrpc.com': 1,
  'bsc-mainnet.gateway.tatum.io': 0.5,
};
const DEFAULT_RPS = 4;

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private readonly waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly rps: number;
  private readonly burst: number;

  constructor(rps: number) {
    this.rps = rps;
    this.burst = Math.max(1, Math.ceil(rps));
    this.tokens = this.burst;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rps);
    this.last = now;
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }

  private drain(): void {
    this.refill();
    while (this.waiters.length && this.tokens >= 1) {
      this.tokens -= 1;
      this.waiters.shift()!();
    }
    if (this.waiters.length && !this.timer) {
      const waitMs = Math.max(5, Math.ceil(((1 - this.tokens) / this.rps) * 1000));
      // Keep the process alive while requests are queued (short-lived timer).
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, waitMs);
    }
  }
}

const buckets = new Map<string, TokenBucket>();

/** Bucket keys look like "host", "host@route" or "api.etherscan.io#key2"; limits come from the host. */
function bucketFor(key: string): TokenBucket {
  let b = buckets.get(key);
  if (!b) {
    const host = key.split('@')[0]!.split('#')[0]!;
    const base = HOST_RPS[host] ?? DEFAULT_RPS;
    b = new TokenBucket(base * getConfig().httpRateMultiplier);
    buckets.set(key, b);
  }
  return b;
}

// --- Routes: your own connection and/or proxies ---

/**
 * Requests are spread over routes (direct + each proxy slot). Every route has its own per-host
 * rate limits, so each exit IP stays within a provider's per-IP limits while total throughput
 * grows with the number of routes. A failing proxy is cooled down and skipped.
 */
interface Route {
  id: string;
  /** "direct" or "proxy 2/3" (never the proxy URL, which may contain credentials). */
  label: string;
  dispatcher: Dispatcher;
  failures: number;
  cooldownUntil: number;
  lastError: string | null;
  requests: number;
}

let routes: Route[] | null = null;
let directOnly: Route | null = null;
let routeCursor = 0;

function makeDirect(): Route {
  return {
    id: 'direct',
    label: 'direct',
    dispatcher: new Agent({ connections: 32, keepAliveTimeout: 30_000, connect: { timeout: 15_000 } }),
    failures: 0,
    cooldownUntil: 0,
    lastError: null,
    requests: 0,
  };
}

function allRoutes(): Route[] {
  if (routes) return routes;
  const cfg = getConfig();
  const list: Route[] = [];
  if (cfg.proxyIncludeDirect || cfg.proxyUrls.length === 0) {
    directOnly ??= makeDirect();
    list.push(directOnly);
  }
  let n = 0;
  const total = cfg.proxyUrls.length * cfg.proxySlots;
  cfg.proxyUrls.forEach((uri, pi) => {
    for (let s = 0; s < cfg.proxySlots; s++) {
      n++;
      list.push({
        id: `p${pi}s${s}`,
        label: `proxy ${n}/${total}`,
        // A separate agent per slot = separate tunnels, so rotating gateways assign separate IPs.
        dispatcher: new ProxyAgent({ uri, connections: 16 }),
        failures: 0,
        cooldownUntil: 0,
        lastError: null,
        requests: 0,
      });
    }
  });
  routes = list;
  return routes;
}

/** Number of parallel routes (used to scale per-IP pacing elsewhere). */
export function routeCount(): number {
  return allRoutes().length;
}

function pickRoute(useProxies: boolean, avoid: string | null): Route {
  if (!useProxies) {
    directOnly ??= makeDirect();
    return directOnly;
  }
  const list = allRoutes();
  const now = Date.now();
  const ready = list.filter((r) => r.cooldownUntil <= now && r.id !== avoid);
  const pool = ready.length ? ready : list.filter((r) => r.id !== avoid).length ? list.filter((r) => r.id !== avoid) : list;
  const r = pool[routeCursor++ % pool.length]!;
  return r;
}

function routeFailed(r: Route, err: unknown): void {
  if (r.id === 'direct') return;
  r.failures++;
  r.lastError = redact(err instanceof Error ? err.message : String(err));
  r.cooldownUntil = Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(r.failures - 1, 5));
}

function routeOk(r: Route): void {
  r.failures = 0;
  r.cooldownUntil = 0;
}

/** Proxy/route health for /status (no URLs or credentials). */
export function routeHealth(): Array<{ label: string; healthy: boolean; requests: number; lastError: string | null }> {
  const now = Date.now();
  return allRoutes().map((r) => ({ label: r.label, healthy: r.cooldownUntil <= now, requests: r.requests, lastError: r.lastError }));
}

export async function closeHttp(): Promise<void> {
  const all = [...(routes ?? []), ...(directOnly && !routes?.includes(directOnly) ? [directOnly] : [])];
  await Promise.allSettled(all.map((r) => r.dispatcher.close()));
  routes = null;
  directOnly = null;
}

// --- Requests ---

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Objects are sent as JSON. */
  body?: unknown;
  /** Per-attempt timeout. Default 20s. */
  timeoutMs?: number;
  /** Extra attempts after the first for retryable failures. Default 3. */
  retries?: number;
  signal?: AbortSignal;
  /** Maximum response size in bytes. Default 16 MB. */
  maxBytes?: number;
  /** Override the rate-limit bucket (defaults to the URL host). */
  rateKey?: string;
  /** Spread over the configured proxies (and direct connection). Default true. */
  proxy?: boolean;
}

const USER_AGENT = 'Mozilla/5.0 (compatible; crypto-portfolio-bot/1.0; self-hosted)';

/**
 * Backends run by wallet vendors for their own apps (not offered as public APIs). They always
 * share ONE rate bucket, so proxies never multiply the load on them.
 */
const VENDOR_HOSTS = new Set([
  'btc1.trezor.io',
  'btcbook.guarda.co',
  'blockbook.btc.zelcore.io',
  'blockbook.ltc.zelcore.io',
  'litecoin.atomicwallet.io',
  'sol1.trezor.io',
  'sol2.trezor.io',
  'sol.trezor.io',
  'solana.coin.ledger.com',
]);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(60_000, Math.max(0, secs * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  return null;
}

async function readLimited(body: AsyncIterable<Uint8Array> | null, maxBytes: number, url: string): Promise<string> {
  if (!body) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new HttpError(`Response too large (> ${maxBytes} bytes)`, null, url, false);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function attempt(url: string, opts: HttpOptions, dispatcher: Dispatcher): Promise<string> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/json', ...opts.headers };
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
  }
  let res;
  try {
    res = await fetch(url, {
      method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      signal,
      dispatcher,
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const msg = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
    throw new HttpError(`Network error: ${msg}`, null, url, true);
  }
  const text = await readLimited(res.body as AsyncIterable<Uint8Array> | null, opts.maxBytes ?? 16 * 1024 * 1024, url);
  if (!res.ok) {
    const retryable = RETRYABLE_STATUS.has(res.status);
    const err = new HttpError(`HTTP ${res.status} from ${new URL(url).host}`, res.status, url, retryable, text);
    (err as HttpError & { retryAfterMs?: number | null }).retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    throw err;
  }
  return text;
}

/** Performs a request with per-host rate limiting, timeouts and retries. Returns the raw body text. */
export async function httpText(url: string, opts: HttpOptions = {}): Promise<string> {
  const host = new URL(url).host;
  const useProxies = opts.proxy !== false;
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  let avoid: string | null = null;
  for (let i = 0; i <= retries; i++) {
    const route = pickRoute(useProxies, avoid);
    // Keyed limits (e.g. one Etherscan key) are global; everything else is per exit IP.
    const shared = route.id === 'direct' || VENDOR_HOSTS.has(host);
    const bucket = bucketFor(opts.rateKey ?? (shared ? host : `${host}@${route.id}`));
    await bucket.acquire();
    route.requests++;
    try {
      const text = await attempt(url, opts, route.dispatcher);
      routeOk(route);
      return text;
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      const status = err instanceof HttpError ? err.status : null;
      // The proxy itself failed (unreachable, auth): cool it down and use another route.
      if (route.id !== 'direct' && (status === null || status === 407)) routeFailed(route, err);
      const retryable = err instanceof HttpError ? err.retryable || status === 407 : true;
      if (!retryable || i === retries) break;
      avoid = route.id;
      // With other routes available, switch immediately instead of waiting out a 429.
      const multi = useProxies && allRoutes().length > 1;
      const hinted = (err as { retryAfterMs?: number | null }).retryAfterMs ?? null;
      const backoff = multi
        ? 250 + Math.floor(Math.random() * 250)
        : (hinted ?? Math.min(15_000, 800 * 2 ** i) + Math.floor(Math.random() * 400));
      log.debug(`retry ${i + 1}/${retries} for ${host} via ${route.label} in ${backoff}ms`, err);
      await sleep(backoff, opts.signal);
    }
  }
  throw lastErr;
}

/** Like httpText but parses JSON. HTML (e.g. a Cloudflare challenge page) is reported as a retryable error. */
export async function httpJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  // Parsing failures (HTML challenge pages) get one extra retry cycle on top of transport retries.
  for (let i = 0; i < 2; i++) {
    const text = await httpText(url, { ...opts, retries });
    try {
      return JSON.parse(text) as T;
    } catch {
      lastErr = new HttpError(`Invalid JSON from ${new URL(url).host}`, 200, url, true, text);
      await sleep(1000, opts.signal);
    }
  }
  throw lastErr;
}

// --- JSON-RPC ---

interface RpcResponse {
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let rpcId = 1;

export async function jsonRpc<T = unknown>(url: string, method: string, params: unknown, opts: HttpOptions = {}): Promise<T> {
  const res = await httpJson<RpcResponse>(url, { ...opts, method: 'POST', body: { jsonrpc: '2.0', id: rpcId++, method, params } });
  if (res.error) throw new RpcError(`${method}: ${res.error.message}`, res.error.code, res.error.data);
  return res.result as T;
}

export interface RpcCall {
  method: string;
  params: unknown;
}

export type RpcResult = { ok: true; result: unknown } | { ok: false; error: RpcError };

/** Sends a JSON-RPC batch. Results are returned in the same order as `calls`. */
export async function jsonRpcBatch(url: string, calls: readonly RpcCall[], opts: HttpOptions = {}): Promise<RpcResult[]> {
  if (calls.length === 0) return [];
  const base = rpcId;
  rpcId += calls.length;
  const payload = calls.map((c, i) => ({ jsonrpc: '2.0', id: base + i, method: c.method, params: c.params }));
  const res = await httpJson<RpcResponse[] | RpcResponse>(url, { ...opts, method: 'POST', body: payload });
  if (!Array.isArray(res)) {
    const e = res.error;
    throw new RpcError(`batch rejected: ${e?.message ?? 'unexpected response'}`, e?.code ?? -1, e?.data);
  }
  const byId = new Map<number, RpcResponse>();
  for (const r of res) if (typeof r.id === 'number') byId.set(r.id, r);
  return calls.map((c, i) => {
    const r = byId.get(base + i);
    if (!r) return { ok: false, error: new RpcError(`${c.method}: missing response in batch`, -1) };
    if (r.error) return { ok: false, error: new RpcError(`${c.method}: ${r.error.message}`, r.error.code, r.error.data) };
    return { ok: true, result: r.result };
  });
}

// --- Endpoint failover ---

interface EndpointState {
  url: string;
  failures: number;
  cooldownUntil: number;
  lastError: string | null;
  lastOkAt: number | null;
}

export interface EndpointHealth {
  url: string;
  healthy: boolean;
  failures: number;
  lastError: string | null;
  lastOkAt: number | null;
}

const allPools = new Set<EndpointPool>();

/**
 * A prioritized list of interchangeable endpoints. Failing endpoints are put on an
 * exponential cooldown and the next one is tried. Throw FatalRequestError (or any error
 * with `fatal: true`) from the callback to stop failover for deterministic errors.
 */
export class EndpointPool {
  readonly name: string;
  private readonly states: EndpointState[];

  constructor(name: string, urls: readonly string[]) {
    if (urls.length === 0) throw new Error(`EndpointPool ${name} needs at least one URL`);
    this.name = name;
    this.states = urls.map((url) => ({ url, failures: 0, cooldownUntil: 0, lastError: null, lastOkAt: null }));
    allPools.add(this);
  }

  get urls(): string[] {
    return this.states.map((s) => s.url);
  }

  private ordered(): EndpointState[] {
    const now = Date.now();
    const ready = this.states.filter((s) => s.cooldownUntil <= now);
    const cooling = this.states.filter((s) => s.cooldownUntil > now).sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return [...ready, ...cooling];
  }

  async run<T>(fn: (url: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastErr: unknown;
    for (const state of this.ordered()) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      try {
        const result = await fn(state.url);
        state.failures = 0;
        state.cooldownUntil = 0;
        state.lastOkAt = Date.now();
        return result;
      } catch (err) {
        if ((err as { fatal?: boolean })?.fatal) throw err;
        if (signal?.aborted) throw err;
        lastErr = err;
        // Not eligible for this call (stale, low priority...): try the next one without penalty.
        if ((err as { skip?: boolean })?.skip) continue;
        state.failures++;
        state.lastError = redact(err instanceof Error ? err.message : String(err));
        const backoff = Math.min(300_000, 5_000 * 2 ** Math.min(state.failures - 1, 6));
        // Honor a server-suggested wait ("retry in 24s", Retry-After) when it is longer.
        const hinted =
          (err as { cooldownMs?: number; retryAfterMs?: number | null })?.cooldownMs ??
          (err as { retryAfterMs?: number | null })?.retryAfterMs ??
          0;
        state.cooldownUntil = Date.now() + Math.max(backoff, Math.min(300_000, hinted ?? 0));
        log.debug(`[${this.name}] endpoint failed (${state.failures}x): ${redact(state.url)}`, err);
      }
    }
    throw lastErr ?? new Error(`[${this.name}] no endpoints available`);
  }

  health(): EndpointHealth[] {
    const now = Date.now();
    return this.states.map((s) => ({
      url: redact(s.url),
      healthy: s.cooldownUntil <= now,
      failures: s.failures,
      lastError: s.lastError,
      lastOkAt: s.lastOkAt,
    }));
  }
}

export function allEndpointHealth(): Array<{ pool: string; endpoints: EndpointHealth[] }> {
  return [...allPools].map((p) => ({ pool: p.name, endpoints: p.health() }));
}
