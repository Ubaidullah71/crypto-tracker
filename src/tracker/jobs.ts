import { getConfig } from '../config.ts';
import { alerts, dailyRuns, snapshots } from '../db/repo.ts';
import { createLogger } from '../logger.ts';
import { buildPortfolio } from '../portfolio/portfolio.ts';
import { getPriceService } from '../prices/prices.ts';
import { getSettings } from '../settings.ts';
import { localDay, parseHhMm, zonedParts } from '../util/time.ts';
import type { Destination, Outbox } from './outbox.ts';
import { priceBacklog } from './pricing.ts';

const log = createLogger('jobs');

/**
 * Periodic jobs: price alerts (every 60s), daily portfolio snapshot + summary, and pricing of
 * imported history. Each job is guarded so one failure never stops the others.
 */
class Jobs {
  private timers: NodeJS.Timeout[] = [];
  private outbox: Outbox | null = null;
  private busy = new Set<string>();

  setOutbox(o: Outbox): void {
    this.outbox = o;
  }

  start(): void {
    // Keep market quotes warm so commands and notifications never wait on a price request.
    this.every('quotes', 60_000, async () => void (await getPriceService().getQuotes()), 5_000);
    this.every('alerts', 60_000, () => this.checkAlerts(), 15_000);
    this.every('daily', 60_000, () => this.daily(), 30_000);
    this.every('pricing', 60_000, async () => void (await priceBacklog(2000)), 20_000);
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private every(name: string, ms: number, fn: () => Promise<void>, firstDelay: number): void {
    const run = async () => {
      if (this.busy.has(name)) return;
      this.busy.add(name);
      try {
        await fn();
      } catch (err) {
        log.warn(`job ${name} failed`, err);
      } finally {
        this.busy.delete(name);
      }
    };
    const first = setTimeout(run, firstDelay);
    first.unref?.();
    const t = setInterval(run, ms);
    t.unref?.();
    this.timers.push(first, t);
  }

  private alertDest(): Destination {
    const s = getSettings();
    return { channelId: s.alertsChannelId ?? s.notifyChannelId, mention: s.mentionOwner };
  }

  async checkAlerts(): Promise<void> {
    const active = alerts.list();
    if (!active.length || !this.outbox) return;
    const quotes = await getPriceService().getQuotes();
    for (const a of active) {
      const q = quotes.get(a.asset);
      if (!q) continue;
      const state: 'above' | 'below' = q.price >= a.target ? 'above' : 'below';
      if (state === a.last_state) continue;
      if (state === a.condition) {
        const ok = await this.outbox.priceAlert(a, q, this.alertDest()).catch(() => false);
        if (ok) alerts.triggered(a.id, state, !a.repeat);
      } else {
        alerts.setState(a.id, state);
      }
    }
  }

  private async daily(): Promise<void> {
    const tz = getConfig().timezone;
    const today = localDay(tz);

    const s = getSettings();
    const needSnapshot = !dailyRuns.has('snapshot', today);
    const needSummary = s.summaryEnabled && !!this.outbox && !dailyRuns.has('summary', today);
    if (!needSnapshot && !needSummary) return;

    // Never record or report values while market prices are missing (providers down):
    // holdings would be valued at $0. Try again on the next minute.
    const p = await buildPortfolio();
    if (p.holdings.some((h) => h.qty > 0 && h.price === null)) {
      log.debug('daily snapshot/summary postponed: prices unavailable');
      return;
    }

    if (needSnapshot) {
      snapshots.put(today, p.totalValue, p.costBasis, p.realized);
      dailyRuns.mark('snapshot', today);
    }

    if (!needSummary || !this.outbox) return;
    const at = parseHhMm(s.summaryTime);
    if (!at) return;
    const now = zonedParts(tz, Date.now());
    if (now.hour * 60 + now.minute < at.hour * 60 + at.minute) return;
    const dest: Destination = { channelId: s.summaryChannelId ?? s.notifyChannelId, mention: false };
    const ok = await this.outbox.dailySummary(dest);
    if (ok) {
      dailyRuns.mark('summary', today);
      log.info('daily summary sent');
    }
  }
}

export const jobs = new Jobs();
