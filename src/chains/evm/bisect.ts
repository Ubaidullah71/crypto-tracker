/**
 * Bisection over block ranges using a state fingerprint.
 *
 * Given the state at `lo` and at `hi`: equal fingerprints mean nothing tracked changed in
 * (lo, hi]; if hi == lo + 1 then `hi` is a change block; otherwise the range is split at the
 * midpoint and both halves are queued. Intervals are processed lowest-block first by a small
 * pool of workers, so change blocks are found roughly in chronological order.
 *
 * Robustness: a failing interval (probe or change-block analysis) is retried with backoff and
 * never takes the rest of the scan down; a deadline or probe budget stops the scan cleanly. The
 * result lists the intervals left unresolved: every block at or below the lowest unresolved
 * `lo` is fully processed, so (lo, loState) of that interval is a valid resume point.
 *
 * Cost: about k * log2(N / k) probes for k change blocks in N blocks, plus ~log2(N) to skip
 * the empty prefix before the first activity.
 */

export interface BisectProgress {
  /** Blocks of the range whose status is known. */
  resolved: number;
  total: number;
  probes: number;
  changes: number;
}

export interface Interval<S> {
  lo: number;
  hi: number;
  loState: S;
  hiState: S;
}

export interface BisectParams<S> {
  /** Range (lo, hi] with known end states... */
  lo?: number;
  hi?: number;
  loState?: S;
  hiState?: S;
  /** ...or several disjoint intervals (resume). */
  intervals?: Interval<S>[];
  /** The signal is aborted when the scan stops early (deadline / budget / outer abort). */
  probe: (block: number, signal: AbortSignal) => Promise<S>;
  key: (s: S) => string;
  /** Called for each change block with the states at block-1 and block. */
  onChange: (block: number, before: S, after: S, signal: AbortSignal) => Promise<void> | void;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: BisectProgress) => void;
  /** Stop after this many probes (bounded work); remaining intervals are reported unresolved. */
  maxProbes?: number;
  /** Stop at this time (epoch ms); remaining intervals are reported unresolved. */
  deadline?: number;
  /** Backoff before each retry of a failing interval; after the last one it stays unresolved. */
  retryDelaysMs?: readonly number[];
}

export interface BisectResult<S = unknown> {
  probes: number;
  changes: number;
  /** Intervals not processed (sorted by lo). Empty = the whole range is done. */
  unresolved: Interval<S>[];
  /** Why the scan is incomplete: 'deadline' | 'budget' | 'failed' (an interval kept failing). */
  stopped?: 'deadline' | 'budget' | 'failed';
  /** Last error of an interval that gave up. */
  error?: unknown;
}

export class BisectBudgetError extends Error {
  constructor(probes: number) {
    super(`bisection stopped after ${probes} probes (budget exhausted)`);
    this.name = 'BisectBudgetError';
  }
}

/** Raised by callers when a scan stays incomplete (carries the bisection result). */
export class IncompleteScanError extends Error {
  readonly result: BisectResult<unknown>;
  constructor(message: string, result: BisectResult<unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'IncompleteScanError';
    this.result = result;
  }
}

const DEFAULT_RETRY_DELAYS = [2_000, 5_000, 15_000];

interface Work<S> extends Interval<S> {
  attempts: number;
}

export async function bisect<S>(params: BisectParams<S>): Promise<BisectResult<S>> {
  const { key, onChange, signal, onProgress } = params;
  const concurrency = Math.max(1, Math.min(8, params.concurrency ?? 3));
  const delays = params.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
  const initial: Interval<S>[] =
    params.intervals ??
    (params.lo !== undefined && params.hi !== undefined && params.loState !== undefined && params.hiState !== undefined
      ? [{ lo: params.lo, hi: params.hi, loState: params.loState, hiState: params.hiState }]
      : []);
  const queue: Work<S>[] = initial.filter((iv) => iv.hi > iv.lo).map((iv) => ({ ...iv, attempts: 0 }));
  const total = queue.reduce((n, iv) => n + (iv.hi - iv.lo), 0);
  const stats = { resolved: 0, probes: 0, changes: 0 };
  if (queue.length === 0) return { probes: 0, changes: 0, unresolved: [] };
  if (signal?.aborted) throw signal.reason ?? new Error('aborted');

  const sortQueue = () => queue.sort((a, b) => a.lo - b.lo);
  sortQueue();
  const push = (iv: Work<S>): void => {
    let i = queue.length;
    while (i > 0 && queue[i - 1]!.lo > iv.lo) i--;
    queue.splice(i, 0, iv);
  };
  const report = (): void => onProgress?.({ resolved: stats.resolved, total, probes: stats.probes, changes: stats.changes });

  const stop = new AbortController();
  const stepSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;

  const step = async (iv: Work<S>): Promise<Work<S>[]> => {
    if (key(iv.loState) === key(iv.hiState)) {
      stats.resolved += iv.hi - iv.lo;
      return [];
    }
    if (iv.hi - iv.lo === 1) {
      await onChange(iv.hi, iv.loState, iv.hiState, stepSignal);
      stats.changes++;
      stats.resolved += 1;
      return [];
    }
    if (params.maxProbes !== undefined && stats.probes >= params.maxProbes) throw new BisectBudgetError(stats.probes);
    const mid = iv.lo + Math.floor((iv.hi - iv.lo) / 2);
    stats.probes++;
    const midState = await params.probe(mid, stepSignal);
    return [
      { lo: iv.lo, hi: mid, loState: iv.loState, hiState: midState, attempts: 0 },
      { lo: mid, hi: iv.hi, loState: midState, hiState: iv.hiState, attempts: 0 },
    ];
  };

  return new Promise<BisectResult<S>>((resolve, reject) => {
    const active = new Set<Work<S>>();
    const waiting = new Map<Work<S>, NodeJS.Timeout>();
    const failed: Work<S>[] = [];
    let stopped: BisectResult['stopped'];
    let lastError: unknown;
    let done = false;
    let deadlineTimer: NodeJS.Timeout | null = null;

    const finish = (): void => {
      if (done) return;
      done = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
      for (const [iv, t] of waiting) {
        clearTimeout(t);
        queue.push(iv);
      }
      waiting.clear();
      const unresolved = [...queue, ...failed]
        .sort((a, b) => a.lo - b.lo)
        .map(({ lo, hi, loState, hiState }) => ({ lo, hi, loState, hiState }));
      if (unresolved.length && !stopped) stopped = 'failed';
      resolve({
        probes: stats.probes,
        changes: stats.changes,
        unresolved,
        ...(stopped ? { stopped } : {}),
        ...(lastError !== undefined ? { error: lastError } : {}),
      });
    };
    const halt = (why: 'deadline' | 'budget'): void => {
      if (stopped === 'deadline' || stopped === 'budget') return;
      stopped = why;
      stop.abort(new Error(`bisection stopped (${why})`));
      for (const [iv, t] of waiting) {
        clearTimeout(t);
        push(iv);
      }
      waiting.clear();
      pump();
    };
    function onAbort(): void {
      if (done) return;
      done = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      for (const t of waiting.values()) clearTimeout(t);
      stop.abort(signal?.reason);
      reject(signal?.reason ?? new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const pump = (): void => {
      if (done) return;
      const halted = stopped === 'deadline' || stopped === 'budget';
      while (!halted && active.size < concurrency && queue.length > 0) {
        const iv = queue.shift()!;
        active.add(iv);
        step(iv).then(
          (children) => {
            active.delete(iv);
            for (const c of children) push(c);
            report();
            pump();
          },
          (err: unknown) => {
            active.delete(iv);
            if (done) return;
            if (signal?.aborted) return onAbort();
            if (stopped === 'deadline' || stopped === 'budget') {
              push(iv); // cut short by the stop: stays unresolved
            } else if (err instanceof BisectBudgetError) {
              push(iv);
              lastError = err;
              halt('budget');
              return;
            } else if (iv.attempts < delays.length) {
              const delay = delays[iv.attempts]!;
              iv.attempts++;
              lastError = err;
              const t = setTimeout(() => {
                waiting.delete(iv);
                push(iv);
                pump();
              }, delay);
              t.unref?.();
              waiting.set(iv, t);
            } else {
              lastError = err;
              failed.push(iv);
            }
            pump();
          },
        );
      }
      if (active.size === 0 && (queue.length === 0 || halted) && waiting.size === 0) finish();
    };

    if (params.deadline !== undefined) {
      const ms = params.deadline - Date.now();
      if (ms <= 0) {
        stopped = 'deadline';
        finish();
        return;
      }
      deadlineTimer = setTimeout(() => halt('deadline'), ms);
      deadlineTimer.unref?.();
    }
    pump();
  });
}

/**
 * Lowest unresolved interval (null when the scan is complete). Its `lo` is the resume point;
 * (lo, hi] is known to differ, so a later scan can continue from it instead of starting over.
 */
export function frontierOf<S>(result: BisectResult<S>): Interval<S> | null {
  return result.unresolved[0] ?? null;
}

/** Rough probe count estimate for k change blocks in n blocks. */
export function estimateProbes(n: number, k: number): number {
  const kk = Math.max(1, k);
  if (n <= 1) return 0;
  return Math.ceil(kk * Math.max(1, Math.log2(n / kk)) + Math.log2(n));
}
