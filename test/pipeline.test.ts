import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/chains/index.ts', () => ({
  getAdapter: () => ({ estimateConfirmationSeconds: async () => 150 }),
}));

vi.mock('../src/prices/prices.ts', () => {
  const quotes = new Map([
    [
      'LTC',
      {
        asset: 'LTC',
        price: 100,
        change24hPct: 10,
        change7dPct: null,
        high24h: null,
        low24h: null,
        marketCap: null,
        image: null,
        source: 'coingecko',
        updatedAt: Date.now(),
      },
    ],
    [
      'ETH',
      {
        asset: 'ETH',
        price: 3000,
        change24hPct: 0,
        change7dPct: null,
        high24h: null,
        low24h: null,
        marketCap: null,
        image: null,
        source: 'coingecko',
        updatedAt: Date.now(),
      },
    ],
    [
      'USDT',
      {
        asset: 'USDT',
        price: 1,
        change24hPct: 0,
        change7dPct: 0,
        high24h: null,
        low24h: null,
        marketCap: null,
        image: null,
        source: 'peg',
        updatedAt: Date.now(),
      },
    ],
  ]);
  const svc = {
    getQuotes: async () => quotes,
    getQuote: async (a: string) => quotes.get(a) ?? null,
    getPrice: async (a: string) => quotes.get(a)?.price ?? null,
    getHistoricalPrice: async (a: string) => ({ price: quotes.get(a)?.price ?? 1, source: 'test' }),
    lastUpdated: () => Date.now(),
    icon: () => 'https://example.com/icon.png',
  };
  return { getPriceService: () => svc, PriceService: class {} };
});

import { setConfigForTests } from '../src/config.ts';
import type { RawTransfer } from '../src/core/types.ts';
import { openDb } from '../src/db/database.ts';
import { balances, transfers, walletNetworks, wallets } from '../src/db/repo.ts';
import { buildPortfolio } from '../src/portfolio/portfolio.ts';
import { flowReport, transactionsCsv } from '../src/portfolio/reports.ts';
import { notifier } from '../src/tracker/notifier.ts';
import type { Outbox, TransferNotice } from '../src/tracker/outbox.ts';
import { priceIds } from '../src/tracker/pricing.ts';
import { updateSettings } from '../src/settings.ts';
import { amount, duration, pct, signedUsd, usd } from '../src/util/format.ts';

const LTC_ADDR = 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9';

function ltcTransfer(p: Partial<RawTransfer>): RawTransfer {
  return {
    txid: '9f2c1e7a4b3d58e60a1c2b3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7b',
    subId: 'native',
    assetKey: 'litecoin:native',
    direction: 'in',
    amount: 576036866n,
    fee: 8530n,
    chargeFee: false,
    counterparty: 'ltc1qalpdfzpzwv9ja499zv8wtaedvzc96ptl280sgt',
    blockHeight: null,
    blockTime: null,
    status: 'pending',
    meta: { feeRate: 5.01, rbf: false },
    ...p,
  };
}

class FakeOutbox implements Outbox {
  sent: TransferNotice[] = [];
  catchUps = 0;
  /** Number of catch-up deliveries that fail before one succeeds. */
  failCatchUps = 0;
  async transfer(n: TransferNotice) {
    this.sent.push(n);
    return true;
  }
  async catchUp() {
    if (this.failCatchUps > 0) {
      this.failCatchUps--;
      return false;
    }
    this.catchUps++;
    return true;
  }
  async priceAlert() {
    return true;
  }
  async dailySummary() {
    return true;
  }
  async importFinished() {
    return true;
  }
  async walletFileSynced() {
    return true;
  }
}

let outbox: FakeOutbox;
let wnId: number;

beforeEach(() => {
  setConfigForTests({ timezone: 'UTC' });
  openDb(':memory:');
  outbox = new FakeOutbox();
  notifier.setOutbox(outbox);
  const wid = wallets.create({ label: 'Main LTC', address: LTC_ADDR, family: 'utxo' });
  wnId = walletNetworks.create(wid, 'litecoin', { height: 100 });
  // Pretend tracking started a minute ago.
  walletNetworks.saveCursor(wnId, { height: 100 });
});

describe('notification pipeline', () => {
  it('sends Seen then Confirmed exactly once', async () => {
    const r = transfers.upsert(wnId, ltcTransfer({}), false);
    expect(r.isNew).toBe(true);
    await priceIds([r.id]);
    await notifier.process(wnId, 100, [r.id]);
    expect(outbox.sent.map((n) => n.kind)).toEqual(['seen']);
    expect(outbox.sent[0]!.etaSec).toBe(150);
    expect(outbox.sent[0]!.valueUsd).toBeCloseTo(576.036866);

    await notifier.process(wnId, 100, []);
    expect(outbox.sent).toHaveLength(1);

    const again = transfers.upsert(
      wnId,
      ltcTransfer({ status: 'confirmed', blockHeight: 101, blockTime: Math.floor(Date.now() / 1000) }),
      false,
    );
    expect(again.changed).toBe(true);
    balances.save(wnId, new Map([['litecoin:native', 576036866n]]));
    await notifier.process(wnId, 101, []);
    expect(outbox.sent.map((n) => n.kind)).toEqual(['seen', 'confirmed']);
    expect(outbox.sent[1]!.balanceAfter?.amount).toBe('5.76036866');

    await notifier.process(wnId, 105, []);
    expect(outbox.sent).toHaveLength(2);
  });

  it('never notifies imported history and skips dust', async () => {
    const hist = transfers.upsert(
      wnId,
      ltcTransfer({ txid: 'a'.repeat(64), status: 'confirmed', blockHeight: 50, blockTime: 1_700_000_000 }),
      true,
    );
    const dust = transfers.upsert(wnId, ltcTransfer({ txid: 'b'.repeat(64), amount: 1000n }), false);
    await priceIds([hist.id, dust.id]);
    await notifier.process(wnId, 100, [dust.id]);
    expect(outbox.sent).toHaveLength(0);
    expect(transfers.get(dust.id)!.notify_skipped).toBe(1);
  });

  it('collapses a flood of new transfers into one catch-up message', async () => {
    const ids: number[] = [];
    for (let k = 0; k < 8; k++) {
      ids.push(
        transfers.upsert(
          wnId,
          ltcTransfer({ txid: String(k).repeat(64), status: 'confirmed', blockHeight: 90, blockTime: 1_800_000_000 }),
          false,
        ).id,
      );
    }
    await priceIds(ids);
    await notifier.process(wnId, 100, ids);
    expect(outbox.catchUps).toBe(1);
    expect(outbox.sent).toHaveLength(0);
    await notifier.process(wnId, 100, []);
    expect(outbox.sent).toHaveLength(0);
  });

  it('retries an undelivered catch-up message instead of sending each transfer', async () => {
    const ids: number[] = [];
    for (let k = 0; k < 8; k++) {
      const txid = (k + 10).toString(16).repeat(32);
      ids.push(transfers.upsert(wnId, ltcTransfer({ txid, status: 'confirmed', blockHeight: 90, blockTime: 1_800_000_000 }), false).id);
    }
    await priceIds(ids);
    outbox.failCatchUps = 1;
    await notifier.process(wnId, 100, ids);
    expect(outbox.catchUps).toBe(0);
    await notifier.process(wnId, 100, []);
    expect(outbox.catchUps).toBe(1);
    expect(outbox.sent).toHaveLength(0);
    await notifier.process(wnId, 100, []);
    expect(outbox.sent).toHaveLength(0);
  });

  it('respects the incoming toggle and wallet mute', async () => {
    updateSettings({ notifyIncoming: false });
    const r = transfers.upsert(wnId, ltcTransfer({}), false);
    await notifier.process(wnId, 100, [r.id]);
    expect(outbox.sent).toHaveLength(0);
    updateSettings({ notifyIncoming: true });
  });

  it('reports dropped transactions that were announced', async () => {
    const r = transfers.upsert(wnId, ltcTransfer({}), false);
    await priceIds([r.id]);
    await notifier.process(wnId, 100, [r.id]);
    transfers.setStatus(r.id, 'dropped');
    await notifier.process(wnId, 100, []);
    expect(outbox.sent.map((n) => n.kind)).toEqual(['seen', 'dropped']);
    await notifier.process(wnId, 100, []);
    expect(outbox.sent).toHaveLength(2);
  });
});

describe('edge cases', () => {
  it('notifies again when a "dropped" transaction confirms after all', async () => {
    const r = transfers.upsert(wnId, ltcTransfer({}), false);
    await priceIds([r.id]);
    await notifier.process(wnId, 100, [r.id]);
    transfers.setStatus(r.id, 'dropped');
    await notifier.process(wnId, 100, []);
    transfers.upsert(wnId, ltcTransfer({ status: 'confirmed', blockHeight: 101, blockTime: Math.floor(Date.now() / 1000) }), false);
    await notifier.process(wnId, 101, []);
    expect(outbox.sent.map((n) => n.kind)).toEqual(['seen', 'dropped', 'confirmed']);
  });

  it('keeps retrying failed deliveries; a stale "seen" never blocks "confirmed"', async () => {
    let up = false;
    const flaky = new FakeOutbox();
    flaky.transfer = async (n: TransferNotice) => {
      if (!up) return false;
      flaky.sent.push(n);
      return true;
    };
    notifier.setOutbox(flaky);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));
      const r = transfers.upsert(wnId, ltcTransfer({ txid: 'e'.repeat(64) }), false);
      await priceIds([r.id]);
      for (let k = 0; k < 10; k++) await notifier.process(wnId, 100, []); // many failed polls
      expect(transfers.get(r.id)!.notify_skipped).toBe(0);
      vi.setSystemTime(new Date('2030-01-01T10:11:00Z'));
      await notifier.process(wnId, 100, []); // seen is stale now: given up, row still active
      expect(transfers.get(r.id)!.notified_seen_at).not.toBeNull();
      up = true;
      transfers.upsert(
        wnId,
        ltcTransfer({ txid: 'e'.repeat(64), status: 'confirmed', blockHeight: 101, blockTime: Math.floor(Date.now() / 1000) }),
        false,
      );
      await notifier.process(wnId, 101, []);
      expect(flaky.sent.map((n) => n.kind)).toEqual(['confirmed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it("per-wallet reports only count that wallet's realized P/L", async () => {
    const wid2 = wallets.create({ label: 'Other', address: 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9', family: 'utxo' });
    const wn2 = walletNetworks.create(wid2, 'litecoin', { height: 1 });
    const buy = transfers.upsert(
      wn2,
      ltcTransfer({
        txid: 'f'.repeat(64),
        status: 'confirmed',
        blockHeight: 1,
        blockTime: 1_700_000_000,
        counterparty: 'ltc1qt2t5ssn9pl7s5mp5khw93wvr9a3gt88v8ywfz2',
      }),
      true,
    );
    transfers.setPrice(buy.id, 10, 'test', 10);
    const sell = transfers.upsert(
      wn2,
      ltcTransfer({
        txid: '9'.repeat(64),
        direction: 'out',
        status: 'confirmed',
        blockHeight: 2,
        blockTime: 1_700_000_100,
        counterparty: 'ltc1qt2t5ssn9pl7s5mp5khw93wvr9a3gt88v8ywfz2',
      }),
      true,
    );
    transfers.setPrice(sell.id, 20, 'test', 20);
    const main = wallets.byLabel('Main LTC')!;
    expect(flowReport(0, 2_000_000_000, { walletId: main.id }).realized).toBe(0);
    expect(flowReport(0, 2_000_000_000, { walletId: wid2 }).realized).toBeCloseTo(5.76036866 * (20 - 10), 6);
  });
});

describe('portfolio and reports', () => {
  it('values holdings from live balances with average cost', async () => {
    const t1 = transfers.upsert(
      wnId,
      ltcTransfer({ txid: 'c'.repeat(64), amount: 200000000n, status: 'confirmed', blockHeight: 1, blockTime: 1_700_000_000 }),
      true,
    );
    transfers.setPrice(t1.id, 50, 'test', 50);
    balances.save(wnId, new Map([['litecoin:native', 200000000n]]));
    const p = await buildPortfolio();
    const ltc = p.holdings.find((h) => h.asset === 'LTC')!;
    expect(ltc.qty).toBe(2);
    expect(ltc.value).toBe(200);
    expect(ltc.avgCost).toBe(50);
    expect(ltc.unrealized).toBe(100);
    expect(p.totalValue).toBe(200);
    expect(p.change24hUsd).toBeCloseTo(200 - 200 / 1.1);

    const r = flowReport(0, 2_000_000_000);
    expect(r.incomingUsd).toBe(100);
    expect(r.incomingCount).toBe(1);
  });

  it('CSV neutralizes formula injection', () => {
    const t = transfers.upsert(
      wnId,
      ltcTransfer({ txid: 'd'.repeat(64), status: 'confirmed', blockHeight: 1, blockTime: 1_700_000_000 }),
      true,
    );
    transfers.setNote(t.id, '=HYPERLINK("http://evil")');
    const csv = transactionsCsv(transfers.range({}));
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });
});

describe('formatting', () => {
  it('formats money and amounts', () => {
    expect(usd(300.0149)).toBe('$300.01');
    expect(usd(1234567.891)).toBe('$1,234,567.89');
    expect(usd(0.0036)).toBe('$0.0036');
    expect(usd(-5)).toBe('-$5.00');
    expect(signedUsd(12.5)).toBe('+$12.50');
    expect(pct(-1.234)).toBe('-1.23%');
    expect(amount('1234.50000000')).toBe('1,234.5');
    expect(amount('0.000000001234', 8)).toBe('0.00000000123');
    expect(duration(266)).toBe('4m 26s');
  });
});
