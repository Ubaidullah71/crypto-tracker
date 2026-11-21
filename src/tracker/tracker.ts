import { getAdapter } from '../chains/index.ts';
import { NETWORKS, type NetworkId } from '../core/networks.ts';
import type { Cursor, RawTransfer } from '../core/types.ts';
import { getDb } from '../db/database.ts';
import { balances, transfers, walletNetworks, type WalletNetworkJoined } from '../db/repo.ts';
import { createLogger, redact } from '../logger.ts';
import { nowSec, Semaphore } from '../util/async.ts';
import { backfills } from './backfill.ts';
import { notifier } from './notifier.ts';
import { priceIds } from './pricing.ts';

const log = createLogger('tracker');

const BALANCE_REFRESH_SEC = 10 * 60;
/** Pending transfers older than this that were not returned by a poll are re-checked individually. */
const PENDING_RECHECK_SEC = 120;
const POLL_TIMEOUT_MS = 90_000;

export interface PollStats {
  polls: number;
  failures: number;
  lastCycleAt: number | null;
}

class Tracker {
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly inFlight = new Set<number>();
  private readonly sem = new Semaphore(6);
  private readonly tips = new Map<NetworkId, { tip: number; at: number }>();
  private readonly pendingMisses = new Map<number, number>();
  private stopped = true;
  private abort = new AbortController();
  readonly stats: PollStats = { polls: 0, failures: 0, lastCycleAt: null };

  start(): void {
    this.stopped = false;
    this.abort = new AbortController();
    const all = walletNetworks.all();
    all.forEach((wn, i) => this.schedule(wn.id, 2_000 + i * 1_500));
    log.info(`tracking ${all.length} wallet network(s)`);
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort(new Error('shutting down'));
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  schedule(wnId: number, delayMs: number): void {
    if (this.stopped) return;
    const existing = this.timers.get(wnId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(wnId);
      void this.runPoll(wnId);
    }, delayMs);
    t.unref?.();
    this.timers.set(wnId, t);
  }

  unschedule(wnId: number): void {
    const t = this.timers.get(wnId);
    if (t) clearTimeout(t);
    this.timers.delete(wnId);
  }

  /** Registers a new wallet network: live tracking starts now, history is imported in the background. */
  async addWalletNetwork(walletId: number, network: NetworkId, address: string): Promise<number> {
    const adapter = getAdapter(network);
    const cursor = await adapter.initCursor(address, AbortSignal.timeout(60_000));
    const wnId = walletNetworks.create(walletId, network, cursor);
    try {
      balances.save(wnId, await adapter.getBalances(address, AbortSignal.timeout(60_000)));
    } catch (err) {
      log.warn(`initial balance fetch failed for ${network}`, err);
    }
    this.schedule(wnId, NETWORKS[network].pollIntervalSec * 1000);
    backfills.enqueue(wnId);
    return wnId;
  }

  async getTip(network: NetworkId): Promise<number | null> {
    const cached = this.tips.get(network);
    const maxAge = Math.max(5, NETWORKS[network].pollIntervalSec / 2) * 1000;
    if (cached && Date.now() - cached.at < maxAge) return cached.tip;
    try {
      const tip = await getAdapter(network).getTip(AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]));
      this.tips.set(network, { tip, at: Date.now() });
      return tip;
    } catch (err) {
      log.debug(`tip fetch failed for ${network}`, err);
      return cached?.tip ?? null;
    }
  }

  /** Forces an immediate poll (used by /wallet refresh). */
  async pollNow(wnId: number): Promise<void> {
    this.unschedule(wnId);
    await this.runPoll(wnId);
  }

  private async runPoll(wnId: number): Promise<void> {
    if (this.stopped || this.inFlight.has(wnId)) return;
    const wn = walletNetworks.get(wnId);
    if (!wn) return;
    this.inFlight.add(wnId);
    let failed = false;
    try {
      await this.sem.run(() => this.pollOnce(wn));
      walletNetworks.pollOk(wnId);
    } catch (err) {
      // Aborted by shutdown: not a provider problem, so not a failed sync.
      if (this.stopped) return;
      failed = true;
      this.stats.failures++;
      const msg = redact(err instanceof Error ? err.message : String(err));
      walletNetworks.pollFailed(wnId, msg);
      const n = walletNetworks.get(wnId)?.consecutive_errors ?? 1;
      if (n === 1 || n % 10 === 0) log.warn(`poll failed for ${wn.label} on ${wn.network} (${n}x): ${msg}`);
    } finally {
      this.inFlight.delete(wnId);
      this.stats.polls++;
      this.stats.lastCycleAt = nowSec();
      const latest = walletNetworks.get(wnId);
      if (latest) {
        const base = NETWORKS[latest.network].pollIntervalSec * 1000;
        const backoff = failed ? Math.min(20, 2 ** Math.min(latest.consecutive_errors, 5)) : 1;
        const jitter = Math.floor(Math.random() * 2_000);
        this.schedule(wnId, base * backoff + jitter);
      }
    }
  }

  private async pollOnce(wn: WalletNetworkJoined): Promise<void> {
    const adapter = getAdapter(wn.network);
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]);
    const cursor = (wn.cursor ? JSON.parse(wn.cursor) : await adapter.initCursor(wn.address, signal)) as Cursor;
    const res = await adapter.poll(wn.address, cursor, signal);

    const touched: number[] = [];
    const fresh: number[] = [];
    const db = getDb();
    db.transaction(() => {
      for (const t of res.transfers) {
        if (!this.valid(t)) continue;
        const r = transfers.upsert(wn.id, t, false);
        if (r.isNew) fresh.push(r.id);
        if (r.isNew || r.changed) touched.push(r.id);
      }
      walletNetworks.saveCursor(wn.id, res.cursor);
    });

    const returned = new Set(res.transfers.map((t) => t.txid));
    const rechecked = await this.recheckPending(wn, returned, signal);

    if (touched.length) await priceIds(touched);

    const stale = !wn.balances_updated_at || nowSec() - wn.balances_updated_at > BALANCE_REFRESH_SEC;
    if (touched.length || rechecked || stale) {
      try {
        balances.save(wn.id, await adapter.getBalances(wn.address, signal));
      } catch (err) {
        log.debug(`balance refresh failed for ${wn.label}`, err);
      }
    }

    const tip = await this.getTip(wn.network);
    await notifier.process(wn.id, tip, fresh);
  }

  private valid(t: RawTransfer): boolean {
    if (typeof t.txid !== 'string' || t.txid.length < 8 || t.txid.length > 140) return false;
    if (typeof t.amount !== 'bigint' || t.amount < 0n) return false;
    return true;
  }

  /** Pending rows not returned by the last poll: ask the adapter whether they confirmed or were dropped. */
  private async recheckPending(wn: WalletNetworkJoined, returned: Set<string>, signal: AbortSignal): Promise<boolean> {
    const pending = transfers
      .pendingForWalletNetwork(wn.id)
      .filter((t) => !returned.has(t.txid) && nowSec() - t.first_seen_at > PENDING_RECHECK_SEC);
    if (!pending.length) return false;
    const adapter = getAdapter(wn.network);
    let changed = false;
    const byTx = new Map<string, typeof pending>();
    for (const t of pending) byTx.set(t.txid, [...(byTx.get(t.txid) ?? []), t]);
    for (const [txid, rows] of byTx) {
      let st;
      try {
        st = await adapter.getTxStatus(txid, wn.address, signal);
      } catch {
        continue;
      }
      if (st.state === 'pending') {
        // Still in some mempool: "dropped" answers must be consecutive to count.
        this.pendingMisses.delete(rows[0]!.id);
      } else if (st.state === 'confirmed' || st.state === 'failed') {
        this.pendingMisses.delete(rows[0]!.id);
        for (const r of rows) transfers.setStatus(r.id, st.state, { height: st.blockHeight ?? null, time: st.blockTime ?? null });
        changed = true;
      } else if (st.state === 'dropped') {
        // Require two consecutive "dropped" answers before giving up on a transaction.
        const key = rows[0]!.id;
        const misses = (this.pendingMisses.get(key) ?? 0) + 1;
        this.pendingMisses.set(key, misses);
        if (misses >= 2) {
          for (const r of rows) transfers.setStatus(r.id, 'dropped');
          this.pendingMisses.delete(key);
          changed = true;
        }
      }
    }
    return changed;
  }
}

export const tracker = new Tracker();
