import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackfillOptions, RawTransfer } from '../src/core/types.ts';

let calls = 0;
let mode: 'flaky' | 'large' = 'flaky';

const transfer = (n: number): RawTransfer => ({
  txid: n.toString(16).padStart(64, '0'),
  subId: 'native',
  assetKey: 'bsc:native',
  direction: 'in',
  amount: 1000n,
  fee: null,
  chargeFee: false,
  counterparty: null,
  blockHeight: n + 1,
  blockTime: 1_700_000_000 + n,
  status: 'confirmed',
});

vi.mock('../src/chains/index.ts', () => ({
  getAdapter: () => ({
    backfill: async (_address: string, _boundary: unknown, opts: BackfillOptions) => {
      calls++;
      if (mode === 'large') {
        // An endless history in batches of 10, like an exchange wallet.
        for (let b = 0; ; b++) {
          if (opts.signal?.aborted) throw opts.signal.reason;
          opts.onBatch?.(Array.from({ length: 10 }, (_, i) => transfer(b * 10 + i)));
          await Promise.resolve();
        }
      }
      if (calls === 1) throw new Error('eth_getBalance: missing trie node');
      return [];
    },
    getBalances: async () => new Map([['bsc:native', 0n]]),
  }),
}));
vi.mock('../src/prices/prices.ts', () => ({
  getPriceService: () => ({
    getQuotes: async () => new Map(),
    getPrice: async () => null,
    getHistoricalPrice: async () => null,
    prefetchHourly: async () => 0,
  }),
}));

import { setConfigForTests } from '../src/config.ts';
import { openDb } from '../src/db/database.ts';
import { transfers, walletNetworks, wallets } from '../src/db/repo.ts';
import { backfills, readProgress } from '../src/tracker/backfill.ts';
import type { ImportNotice, Outbox } from '../src/tracker/outbox.ts';

afterEach(() => {
  vi.useRealTimers();
  backfills.stop();
});

function setup(config: Parameters<typeof setConfigForTests>[0] = {}) {
  setConfigForTests(config);
  openDb(':memory:');
  const notices: ImportNotice[] = [];
  backfills.setOutbox({ importFinished: async (n: ImportNotice) => (notices.push(n), true) } as unknown as Outbox);
  backfills.resumeAll();
  const wid = wallets.create({ label: 'EVM', address: '0x28C6c06298d514Db089934071355E5743bf21d60', family: 'evm' });
  const wnId = walletNetworks.create(wid, 'bsc', { block: 1 });
  return { notices, wnId };
}

describe('history import', () => {
  it('retries a failed import automatically and reports only the final result', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    mode = 'flaky';
    calls = 0;
    const { notices, wnId } = setup();

    backfills.enqueue(wnId);
    await vi.waitFor(() => expect(walletNetworks.get(wnId)!.backfill_status).toBe('pending'));
    await vi.waitFor(() => expect(readProgress(walletNetworks.get(wnId)!.backfill_progress)?.stage).toMatch(/Retrying in 2 min/));
    expect(notices).toHaveLength(0);
    expect(backfills.isQueued(wnId)).toBe(true);

    await vi.advanceTimersByTimeAsync(2 * 60_000 + 10);
    await vi.waitFor(() => expect(walletNetworks.get(wnId)!.backfill_status).toBe('done'));
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]!.error).toBeNull();
    expect(calls).toBe(2);
  });

  it('stops at MAX_HISTORY_TRANSACTIONS, says so, and a reimport does not go past it', async () => {
    mode = 'large';
    const { notices, wnId } = setup({ maxHistoryTransactions: 100 });

    backfills.enqueue(wnId);
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(walletNetworks.get(wnId)!.backfill_status).toBe('done');
    expect(notices[0]!.capped).toBe(100);
    expect(notices[0]!.error).toBeNull();
    expect(transfers.countForWalletNetwork(wnId)).toBe(100);

    backfills.enqueue(wnId);
    await vi.waitFor(() => expect(notices).toHaveLength(2));
    expect(notices[1]!.capped).toBe(100);
    expect(transfers.countForWalletNetwork(wnId)).toBeLessThanOrEqual(110);
  });
});
