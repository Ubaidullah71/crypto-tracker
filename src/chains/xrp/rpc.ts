/**
 * Minimal rippled / clio JSON-RPC client.
 *
 * The XRP Ledger API is NOT JSON-RPC 2.0: requests are `{"method": "...", "params": [{...}]}` and
 * responses are `{"result": {..., "status": "success" | "error", "error": "actNotFound"}}` with HTTP 200
 * for application errors. Every request pins `api_version: 2`; the parsers still accept v1 shapes.
 */
import { httpJson } from '../../util/http.ts';
import { isRecord, type Json } from './parse.ts';

/** Pinned on every request. rippled >= 2.0 and clio honor it (verified against all default endpoints). */
export const XRPL_API_VERSION = 2;

/**
 * Keyless public servers, all verified to serve full history (complete_ledgers 32570-current and
 * account_tx from ledger 60104 in 2013).
 *   s2.ripple.com   - clio (Ripple), full history.
 *   s1.ripple.com   - clio (Ripple), full history (validated data only).
 *   xrplcluster.com - rippled (XRPL Labs), full history, independent operator. Faster, but enforces a
 *                     "units" quota (10000 per 60 s, ~a few 400-tx pages) reported as tooBusy, and
 *                     rejects account_tx limit > 400. Kept last as the fallback.
 */
export const DEFAULT_XRPL_ENDPOINTS: readonly string[] = [
  'https://s2.ripple.com:51234/',
  'https://s1.ripple.com:51234/',
  'https://xrplcluster.com/',
];

/**
 * An XRPL application error ("actNotFound", "tooBusy", ...) or a malformed response.
 * `fatal: true` makes EndpointPool rethrow immediately without failover and without putting the
 * endpoint on cooldown (used for deterministic errors and for answers the caller expects).
 */
export class XrplError extends Error {
  readonly code: string;
  readonly method: string;
  readonly fatal: boolean;
  /** Server-suggested wait before using this endpoint again (EndpointPool honors it). */
  readonly cooldownMs: number | undefined;
  constructor(method: string, code: string, message: string, fatal: boolean) {
    // Server-controlled text: bound it before storing it or running a regex on it.
    const msg = message.slice(0, 200);
    const safeCode = code.slice(0, 64);
    super(`${method}: ${safeCode}${msg && msg !== safeCode ? ` (${msg})` : ''}`);
    this.name = 'XrplError';
    this.code = safeCode;
    this.method = method;
    this.fatal = fatal;
    if (safeCode === 'tooBusy' || safeCode === 'slowDown') {
      const secs = /(\d{1,6})\s{0,3}s/.exec(msg)?.[1];
      this.cooldownMs = secs ? Math.min(120, Number(secs) + 2) * 1000 : 30_000;
    }
  }
}

/** Errors that are a property of the request itself; another server would answer the same. */
const DETERMINISTIC_ERRORS = new Set(['actMalformed', 'badSyntax']);

/** Sends one request and returns the parsed JSON body. Injectable for offline tests. */
export type XrplTransport = (
  url: string,
  method: string,
  params: Json,
  opts: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<unknown>;

export const httpTransport: XrplTransport = (url, method, params, opts) =>
  httpJson<unknown>(url, {
    method: 'POST',
    body: { method, params: [params] },
    timeoutMs: opts.timeoutMs ?? 20_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

export interface XrplCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Error codes the caller handles itself: thrown as fatal (no failover, no endpoint penalty). */
  expect?: readonly string[];
}

// --- Request statistics (for smoke tests and diagnostics) ---

interface MethodStats {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

const stats = new Map<string, MethodStats>();

export function getXrplStats(): Record<string, MethodStats> {
  return Object.fromEntries([...stats].map(([k, v]) => [k, { ...v }]));
}

export function resetXrplStats(): void {
  stats.clear();
}

function record(key: string, ms: number, ok: boolean): void {
  let s = stats.get(key);
  if (!s) stats.set(key, (s = { count: 0, errors: 0, totalMs: 0, maxMs: 0 }));
  s.count++;
  if (!ok) s.errors++;
  s.totalMs += ms;
  s.maxMs = Math.max(s.maxMs, ms);
}

// --- Call ---

/** Performs one XRPL request against one server. Throws XrplError for application errors. */
export async function xrplCall(
  transport: XrplTransport,
  url: string,
  method: string,
  params: Json,
  opts: XrplCallOptions = {},
): Promise<Json> {
  const started = Date.now();
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  const key = `${method}@${host}`;
  let body: unknown;
  try {
    body = await transport(
      url,
      method,
      { ...params, api_version: XRPL_API_VERSION },
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
    );
  } catch (err) {
    record(key, Date.now() - started, false);
    throw err;
  }
  const result = isRecord(body) ? body.result : undefined;
  if (!isRecord(result)) {
    record(key, Date.now() - started, false);
    throw new XrplError(method, 'malformedResponse', 'response has no result object', false);
  }
  if (result.status === 'error' || typeof result.error === 'string') {
    record(key, Date.now() - started, false);
    const code = typeof result.error === 'string' ? result.error : 'unknownError';
    const message = typeof result.error_message === 'string' ? result.error_message.slice(0, 200) : '';
    const fatal = DETERMINISTIC_ERRORS.has(code) || (opts.expect?.includes(code) ?? false);
    throw new XrplError(method, code, message, fatal);
  }
  if (result.status !== 'success') {
    record(key, Date.now() - started, false);
    throw new XrplError(method, 'malformedResponse', `unexpected status ${String(result.status).slice(0, 40)}`, false);
  }
  record(key, Date.now() - started, true);
  return result;
}
