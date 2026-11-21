import { getConfig } from '../config.ts';
import { getAdapter } from '../chains/index.ts';
import type { NetworkId } from '../core/networks.ts';
import type { BackfillProgress, Cursor, RawTransfer } from '../core/types.ts';
import { getDb } from '../db/database.ts';
import { balances, transfers, walletNetworks } from '../db/repo.ts';
import { createLogger, redact } from '../logger.ts';
import { getSettings } from '../settings.ts';
import { nowSec } from '../util/async.ts';
import { walletDestination } from './notifier.ts';
import type { Outbox } from './outbox.ts';
import { priceBacklog } from './pricing.ts';

const log = createLogger('backfill');

export interface StoredProgress {
  stage: string;
  fraction: number | null;
  found: number;
  updatedAt: number;
}

export function readProgress(json: string | null): StoredProgress | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as StoredProgress;
  } catch {
    return null;
  }
}

/** Minutes to wait before automatic retries of a failed import (then it is reported as stopped). */
const RETRY_DELAYS_MIN = [2, 10, 30, 60];

/**
 * History imports. One queue per network so a slow BNB Chain scan never blocks a Bitcoin import.
 * Imported rows are flagged "backfilled" and never trigger notifications.
 */
class BackfillQueue {
  private readonly chains = new Map<NetworkId, Promise<void>>();
  private readonly queued = new Set<number>();
  private readonly controllers = new Map<number, AbortController>();
  private outbox: Outbox | null = null;
  private stopped = false;
  /** Automatic retries after a failed import (public nodes have bad moments). */
  private readonly attempts = new Map<number, number>();
  private readonly retryTimers = new Map<number, NodeJS.Timeout>();

  setOutbox(o: Outbox): void {
    this.outbox = o;
  }

  /** Re-queues imports that were pending or interrupted by a restart. */
  resumeAll(): void {
    this.stopped = false;
    for (const wn of walletNetworks.all()) {
      if (wn.backfill_status === 'pending' || wn.backfill_status === 'running') this.enqueue(wn.id);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.controllers.values()) c.abort(new Error('shutting down'));
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }

  cancel(wnId: number): void {
    this.controllers.get(wnId)?.abort(new Error('cancelled'));
    this.queued.delete(wnId);
    const t = this.retryTimers.get(wnId);
    if (t) clearTimeout(t);
    this.retryTimers.delete(wnId);
    this.attempts.delete(wnId);
  }

  /** An import is running or waiting in the queue right now (not just a retry timer). */
  isActive(wnId: number): boolean {
    return this.queued.has(wnId) || this.controllers.has(wnId);
  }

  isQueued(wnId: number): boolean {
    return this.queued.has(wnId) || this.retryTimers.has(wnId);
  }

  /** Starts (or restarts) an import now. Resets the automatic retry counter. */
  enqueue(wnId: number): void {
    const t = this.retryTimers.get(wnId);
    if (t) clearTimeout(t);
    this.retryTimers.delete(wnId);
    this.attempts.delete(wnId);
    this.enqueueInternal(wnId);
  }

  private enqueueInternal(wnId: number): void {
    const wn = walletNetworks.get(wnId);
    if (!wn || this.queued.has(wnId)) return;
    this.queued.add(wnId);
    if (wn.backfill_status !== 'running') walletNetworks.setBackfill(wnId, 'pending');
    const prev = this.chains.get(wn.network) ?? Promise.resolve();
    const next = prev.then(() => this.run(wnId)).catch((err) => log.error('backfill chain error', err));
    this.chains.set(wn.network, next);
  }

  private async run(wnId: number): Promise<void> {
    if (this.stopped || !this.queued.has(wnId)) return;
    const wn = walletNetworks.get(wnId);
    if (!wn) {
      this.queued.delete(wnId);
      return;
    }
    const controller = new AbortController();
    this.controllers.set(wnId, controller);
    const started = nowSec();
    let found = 0;
    let lastWrite = 0;
    const progress = (p: BackfillProgress) => {
      if (Date.now() - lastWrite < 2_000) return;
      lastWrite = Date.now();
      const stored: StoredProgress = { stage: p.stage, fraction: p.fraction ?? null, found, updatedAt: nowSec() };
      walletNetworks.setBackfillProgress(wnId, JSON.stringify(stored));
    };
    const db = getDb();
    const cap = getConfig().maxHistoryTransactions;
    // Retries and reimports scan from the start again, so rows stored earlier count toward the cap.
    const stored = transfers.countForWalletNetwork(wnId);
    let capped = false;
    const save = (batch: RawTransfer[]) => {
      db.transaction(() => {
        for (const t of batch) {
          if (typeof t.amount !== 'bigint' || t.amount < 0n) continue;
          if (transfers.upsert(wnId, t, true).isNew) found++;
        }
      });
      // Very large histories (exchange wallets) would hammer free APIs for hours: stop at the cap.
      if (stored + found >= cap && !capped) {
        capped = true;
        controller.abort(new Error('history limit reached'));
      }
    };

    log.info(`importing history for ${wn.label} on ${wn.network}`);
    walletNetworks.setBackfill(wnId, 'running', {
      progress: JSON.stringify({ stage: 'Starting', fraction: 0, found: 0, updatedAt: started }),
    });
    let error: string | null = null;
    let willRetry = false;
    try {
      const boundary = (wn.boundary ? JSON.parse(wn.boundary) : JSON.parse(wn.cursor ?? '{}')) as Cursor;
      let streamed = false;
      const all = await getAdapter(wn.network).backfill(wn.address, boundary, {
        signal: controller.signal,
        onProgress: progress,
        onBatch: (batch) => {
          streamed = true;
          save(batch);
        },
      });
      if (!streamed && all.length) save(all);
      const done: StoredProgress = { stage: 'Complete', fraction: 1, found, updatedAt: nowSec() };
      walletNetworks.setBackfill(wnId, 'done', { progress: JSON.stringify(done) });
      this.attempts.delete(wnId);
      log.info(`history import finished for ${wn.label} on ${wn.network}: ${found} transfers in ${nowSec() - started}s`);
    } catch (err) {
      error = redact(err instanceof Error ? err.message : String(err));
      const aborted = controller.signal.aborted;
      if (capped) {
        const stage = `Stopped at the ${cap.toLocaleString('en-US')} transaction limit (MAX_HISTORY_TRANSACTIONS)`;
        walletNetworks.setBackfill(wnId, 'done', { progress: JSON.stringify({ stage, fraction: 1, found, updatedAt: nowSec() }) });
        this.attempts.delete(wnId);
        log.warn(`history import for ${wn.label} on ${wn.network} stopped at the limit of ${cap} transactions`);
        error = null;
      } else if (aborted && this.stopped) {
        // Shutting down: leave it "running" so it resumes on next start.
        this.controllers.delete(wnId);
        this.queued.delete(wnId);
        return;
      }
      const attempt = this.attempts.get(wnId) ?? 0;
      const delayMin = RETRY_DELAYS_MIN[attempt];
      // Permanent problems (rejected address, unsupported plan) are reported at once, not retried.
      const permanent = (err as { fatal?: boolean } | null)?.fatal === true;
      if (capped) {
        // Finished as "done" above (history limit reached).
      } else if (!aborted && !permanent && delayMin !== undefined) {
        // Temporary provider trouble is common: try again later, keeping everything found so far.
        willRetry = true;
        this.attempts.set(wnId, attempt + 1);
        walletNetworks.setBackfill(wnId, 'pending');
        walletNetworks.setBackfillProgress(
          wnId,
          JSON.stringify({
            stage: `Retrying in ${delayMin} min (attempt ${attempt + 2} of ${RETRY_DELAYS_MIN.length + 1})`,
            fraction: null,
            found,
            updatedAt: nowSec(),
          }),
        );
        const timer = setTimeout(() => {
          this.retryTimers.delete(wnId);
          this.enqueueInternal(wnId);
        }, delayMin * 60_000);
        timer.unref?.();
        this.retryTimers.set(wnId, timer);
        log.warn(`history import for ${wn.label} on ${wn.network} failed (${error}); retrying in ${delayMin} min`);
      } else {
        this.attempts.delete(wnId);
        walletNetworks.setBackfill(wnId, 'error', {
          error: aborted ? 'Cancelled' : error,
          progress: JSON.stringify({ stage: 'Stopped', fraction: null, found, updatedAt: nowSec() }),
        });
        log.warn(`history import failed for ${wn.label} on ${wn.network}: ${error}`);
      }
    } finally {
      this.controllers.delete(wnId);
      this.queued.delete(wnId);
    }

    try {
      balances.save(wnId, await getAdapter(wn.network).getBalances(wn.address, AbortSignal.timeout(60_000)));
    } catch {
      /* next poll refreshes */
    }
    void (async () => {
      while ((await priceBacklog(2000)) > 0) {
        /* keep pricing until nothing is left */
      }
    })().catch((e) => log.warn('pricing backlog failed', e));

    const s = getSettings();
    const latest = walletNetworks.get(wnId);
    if (this.outbox && latest && s.importNotices && (!controller.signal.aborted || capped) && !willRetry) {
      // Report the total stored for this wallet network (retries add to earlier attempts).
      const total = transfers.countForWalletNetwork(wnId);
      await this.outbox
        .importFinished(
          { wallet: latest, transfers: total, durationSec: nowSec() - started, error, ...(capped ? { capped: cap } : {}) },
          walletDestination(latest, s),
        )
        .catch((e) => log.warn('import notice failed', e));
    }
  }
}

export const backfills = new BackfillQueue();
