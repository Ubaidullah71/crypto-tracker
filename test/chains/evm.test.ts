import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvmAdapterInternal } from '../../src/chains/evm/adapter.ts';
import { mergeRecord, reconcile, toRawTransfers, type TxRecord } from '../../src/chains/evm/aggregate.ts';
import { bisect, BisectBudgetError, frontierOf } from '../../src/chains/evm/bisect.ts';
import { analyzeBlockData, collectLogs, parseBlock, parseReceipt, type BlockData } from '../../src/chains/evm/blocks.ts';
import { EVM_CONFIG, TRANSFER_TOPIC, type EvmNetworkConfig } from '../../src/chains/evm/config.ts';
import { mergeRepairedBlock } from '../../src/chains/evm/guided.ts';
import {
  Explorer,
  ExplorerError,
  KeyProblemError,
  KeyRing,
  SourceUnavailableError,
  fetchHistory,
  PAGE_SIZE,
  parseExplorerResponse,
  parseInternalRow,
  parseTokenRow,
  parseTxlistRow,
} from '../../src/chains/evm/explorer.ts';
import { fingerprint, parseFingerprint, parseProbeResults, type ChainState } from '../../src/chains/evm/probe.ts';
import { addressTopic } from '../../src/chains/evm/util.ts';
import { setConfigForTests } from '../../src/config.ts';
import { EVM_NETWORKS, NETWORKS } from '../../src/core/networks.ts';
import type { RawTransfer } from '../../src/core/types.ts';
import { closeHttp } from '../../src/util/http.ts';

const FIX = new URL('../fixtures/evm/', import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (name: string): any => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));

const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';

function oneChargePerTx(rows: readonly RawTransfer[]): void {
  const byTx = new Map<string, number>();
  for (const r of rows) byTx.set(r.txid, (byTx.get(r.txid) ?? 0) + (r.chargeFee ? 1 : 0));
  for (const [, n] of byTx) expect(n).toBeLessThanOrEqual(1);
}

/* ============================================================================================ */

describe('fingerprint and probe parsing', () => {
  it('round-trips and rejects other token sets', () => {
    const s: ChainState = { nonce: 7n, balance: 123456789012345678901234n, tokens: [0n, 5n] };
    const fp = fingerprint(s);
    expect(fp).toBe('7:123456789012345678901234:0:5');
    expect(parseFingerprint(fp, 2)).toEqual(s);
    expect(parseFingerprint(fp, 3)).toBeNull();
    expect(parseFingerprint('7:x:0:5', 2)).toBeNull();
    expect(parseFingerprint(undefined, 2)).toBeNull();
  });

  it('treats "0x" eth_call results (contract not deployed yet) as zero and rejects garbage', () => {
    const s = parseProbeResults(['0x10', '0x2', '0x', '0x00000000000000000000000000000000000000000000000000000000000003e8'], 2);
    expect(s).toEqual({ balance: 16n, nonce: 2n, tokens: [0n, 1000n] });
    expect(() => parseProbeResults(['0x10', '0x2', 'nope', '0x0'], 2)).toThrow();
    expect(() => parseProbeResults(['0x10', null, '0x', '0x'], 2)).toThrow();
  });
});

/* ============================================================================================ */

describe('Etherscan rows -> RawTransfers (real rows, vitalik.eth)', () => {
  const fx = load('etherscan-vitalik.json');
  const me: string = fx.address;
  const records = new Map<string, TxRecord>();
  for (const r of fx.txlist) mergeRecord(records, parseTxlistRow(r)!);
  for (const r of fx.txlistinternal) mergeRecord(records, parseInternalRow(r)!);
  for (const r of fx.tokentx) {
    const rec = parseTokenRow(r, USDT_ETH);
    if (rec) mergeRecord(records, rec);
  }
  const rows = toRawTransfers('ethereum', me, records.values());
  const byTx = (h: string) => rows.filter((r) => r.txid === h);
  const txRow = (h: string) => fx.txlist.find((r: { hash: string }) => r.hash === h);
  const feeOf = (h: string) => BigInt(txRow(h).gasUsed) * BigInt(txRow(h).gasPrice);

  it('failed tx we sent -> one fee-only row with status failed', () => {
    const h = fx.picks.failed[0];
    const r = byTx(h);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      subId: 'native',
      assetKey: 'ethereum:native',
      direction: 'out',
      amount: 0n,
      chargeFee: true,
      status: 'failed',
    });
    expect(r[0]!.fee).toBe(feeOf(h));
    expect(r[0]!.meta?.feeOnly).toBe(true);
  });

  it('internal ETH returned to our own contract call merges into the native row', () => {
    const h = fx.picks.internalBack[0];
    const r = byTx(h);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ subId: 'native', direction: 'in', amount: 10000000000000000n, chargeFee: true, status: 'confirmed' });
    expect(r[0]!.fee).toBe(feeOf(h));
    expect(r[0]!.meta?.internal).toBe(true);
    expect(r[0]!.counterparty).toBe('0x4e3f4b4373692d0169a71d29a45754a7ee9d06ea');
    expect(r[0]!.meta?.feeRate).toBeCloseTo(0.113185378, 9);
  });

  it('plain send / receive', () => {
    const out = byTx(fx.picks.plainOut[0]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      direction: 'out',
      amount: 41534000000000000n,
      chargeFee: true,
      counterparty: txRow(fx.picks.plainOut[0]).to,
    });
    const inn = byTx(fx.picks.plainIn[0]);
    expect(inn).toHaveLength(1);
    expect(inn[0]).toMatchObject({ direction: 'in', amount: 100000n, chargeFee: false, counterparty: txRow(fx.picks.plainIn[0]).from });
    expect(inn[0]!.fee).toBe(feeOf(fx.picks.plainIn[0])); // informational: the sender paid it
  });

  it('zero-value self call -> fee-only native row', () => {
    const r = byTx(fx.picks.selfZero[0]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ direction: 'out', amount: 0n, chargeFee: true });
    expect(r[0]!.meta?.feeOnly).toBe(true);
  });

  it('tracked token in; zero-value poisoning transfer ignored', () => {
    const r = byTx(fx.picks.usdtIn[0]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      subId: `token:${USDT_ETH}`,
      assetKey: `ethereum:${USDT_ETH}`,
      direction: 'in',
      amount: 5000000n,
      chargeFee: false,
    });
    expect(byTx(fx.picks.zeroSpam[0])).toHaveLength(0);
  });

  it('exactly one fee charge per transaction; all rows confirmed with block info', () => {
    oneChargePerTx(rows);
    for (const r of rows) {
      expect(r.blockHeight).toBeGreaterThan(0);
      expect(r.blockTime).toBeGreaterThan(1_400_000_000);
    }
    expect(rows).toHaveLength(6);
  });

  it('Blockscout internal rows (transactionHash field) parse like Etherscan rows', () => {
    const bs = parseInternalRow(fx.blockscoutInternal.result[0])!;
    const es = parseInternalRow(fx.txlistinternal[0])!;
    expect(bs.hash).toBe(es.hash);
    expect(bs.legs).toEqual(es.legs);
  });

  it('malformed rows are skipped, not thrown', () => {
    expect(parseTxlistRow({ hash: '0x12', blockNumber: '1' })).toBeNull();
    expect(parseTxlistRow({ ...fx.txlist[0], value: '-5' })).toBeNull();
    expect(parseTokenRow({ ...fx.tokentx[1], contractAddress: '0x0000000000000000000000000000000000000001' }, USDT_ETH)).toBeNull();
  });
});

/* ============================================================================================ */

describe('explorer responses (real envelopes)', () => {
  const env = load('etherscan-vitalik.json').envelopes;
  it('"No transactions found" is an empty result', () => {
    expect(parseExplorerResponse(env.empty)).toEqual({ rows: [], incomplete: false });
  });
  it('an unsupported chain only disables that source (not fatal); an invalid key only retires that key', () => {
    try {
      parseExplorerResponse(env.unsupportedChain);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SourceUnavailableError);
      expect((err as { fatal?: boolean }).fatal).toBeUndefined();
    }
    try {
      parseExplorerResponse(env.badKey);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(KeyProblemError);
      expect((err as KeyProblemError).kind).toBe('invalid');
    }
  });
  it('daily limits rest a key; the ring rotates and skips resting or invalid keys', () => {
    expect(() => parseExplorerResponse({ status: '0', message: 'NOTOK', result: 'Max daily rate limit reached. 100000 (100%)' })).toThrow(
      KeyProblemError,
    );
    const ring = new KeyRing(['A'.repeat(34), 'B'.repeat(34), 'C'.repeat(34)]);
    const first = ring.next()!;
    const second = ring.next()!;
    expect(first.index).not.toBe(second.index);
    ring.invalidKey(first);
    ring.dailyLimit(second);
    const left = new Set([ring.next()!.index, ring.next()!.index]);
    expect(left.size).toBe(1);
    expect(
      ring
        .health()
        .map((h) => h.status)
        .sort(),
    ).toEqual(['invalid', 'ok', 'resting']);
  });
  it('rate limits are retryable, other errors are not', () => {
    const rl = { status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' };
    expect(() => parseExplorerResponse(rl)).toThrow(ExplorerError);
    try {
      parseExplorerResponse(rl);
    } catch (err) {
      expect((err as ExplorerError).retryable).toBe(true);
    }
    try {
      parseExplorerResponse(env.windowTooLarge);
    } catch (err) {
      expect((err as ExplorerError).retryable).toBe(false);
    }
    expect(() => parseExplorerResponse('<html>')).toThrow();
  });
  it('flags Blockscout "not yet processed" pages as incomplete', () => {
    const p = parseExplorerResponse({
      message: 'Some internal transactions within this block range have not yet been processed',
      result: [],
      status: '1',
    });
    expect(p.incomplete).toBe(true);
  });
});

/* ============================================================================================ */

describe('explorer pagination (windowed by startblock)', () => {
  const me = '0x1111111111111111111111111111111111111111';
  const other = '0x2222222222222222222222222222222222222222';
  // 3 txs per block for blocks 1..900 (2700 rows), plus 1500 rows in block 1000 (more than a page).
  const rows: Record<string, string>[] = [];
  let n = 0;
  const add = (block: number) =>
    rows.push({
      hash: '0x' + (++n).toString(16).padStart(64, '0'),
      blockNumber: String(block),
      timeStamp: String(1_600_000_000 + block),
      from: other,
      to: me,
      value: '1',
      gasUsed: '21000',
      gasPrice: '1',
      isError: '0',
      txreceipt_status: '1',
    });
  for (let b = 1; b <= 900; b++) for (let i = 0; i < 3; i++) add(b);
  for (let i = 0; i < 1500; i++) add(1000);
  const queries: Record<string, string | number>[] = [];
  const fake = {
    network: 'ethereum',
    async query(p: Record<string, string | number>) {
      queries.push(p);
      if (Number(p.page) * Number(p.offset) > 10_000) throw new Error('window too large');
      if (p.action !== 'txlist') return { rows: [], incomplete: false };
      const sel = rows.filter((r) => Number(r.blockNumber) >= Number(p.startblock) && Number(r.blockNumber) <= Number(p.endblock));
      const start = (Number(p.page) - 1) * Number(p.offset);
      return { rows: sel.slice(start, start + Number(p.offset)), incomplete: false };
    },
  } as unknown as Explorer;

  it('fetches every row exactly once and streams complete blocks', async () => {
    const flushed: TxRecord[] = [];
    let lastCovered = -1;
    const res = await fetchHistory(fake, me, [USDT_ETH], {
      from: 0,
      to: 2000,
      onFlush: (recs, covered) => {
        expect(covered).toBeGreaterThanOrEqual(lastCovered);
        lastCovered = covered;
        for (const r of recs) expect(r.block).toBeLessThanOrEqual(covered);
        flushed.push(...recs);
      },
    });
    const all = [...flushed, ...res.records];
    expect(all).toHaveLength(rows.length);
    expect(new Set(all.map((r) => r.hash)).size).toBe(rows.length);
    expect(all.every((r) => r.legs.length === 1)).toBe(true);
    expect(PAGE_SIZE).toBe(1000);
    expect(queries.every((q) => Number(q.page) * Number(q.offset) <= 10_000)).toBe(true);
    expect(res.requests).toBe(queries.length);
  });

  it('honors a request budget', async () => {
    await expect(fetchHistory(fake, me, [], { from: 0, to: 2000, maxRequests: 2 })).rejects.toThrow(/budget/);
  });
});

/* ============================================================================================ */

function blockData(fx: { block: unknown; blockNumber: number; logs: unknown[][]; receipts: unknown[] }, opStack: boolean): BlockData {
  const receipts = new Map();
  for (const raw of fx.receipts) {
    const r = parseReceipt(raw, opStack)!;
    receipts.set(r.hash, r);
  }
  return { block: parseBlock(fx.block, fx.blockNumber), logs: collectLogs(fx.logs, fx.blockNumber), receipts };
}

function stateOf(p: { balance: string; nonce: string; tokens: string[] }): ChainState {
  return { balance: BigInt(p.balance), nonce: BigInt(p.nonce), tokens: p.tokens.map((t) => BigInt(t)) };
}

const ctxOf = (network: 'bsc' | 'base', address: string, opStack = network === 'base') => ({
  network,
  address,
  tokens: NETWORKS[network].tokens.map((t) => t.contract!),
  opStack,
});

describe('RPC change-block analysis (real blocks)', () => {
  it('Base: USDC send -> fee-only native row (gas + l1Fee) and token row; reconciles exactly', () => {
    const fx = load('base-usdc-send.json');
    const data = blockData(fx, true);
    const before = stateOf(fx.before);
    const after = stateOf(fx.after);
    const rows = toRawTransfers('base', fx.address, analyzeBlockData(ctxOf('base', fx.address), data, before, after));
    const rc = fx.receipts[0];
    const expectedFee = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice) + BigInt(rc.l1Fee);
    expect(BigInt(rc.l1Fee)).toBeGreaterThan(0n);
    expect(rows).toHaveLength(2);
    const native = rows.find((r) => r.subId === 'native')!;
    expect(native).toMatchObject({
      direction: 'out',
      amount: 0n,
      chargeFee: true,
      fee: expectedFee,
      txid: rc.transactionHash,
      status: 'confirmed',
      blockHeight: fx.blockNumber,
    });
    expect(native.meta?.feeOnly).toBe(true);
    expect(native.meta?.internal).toBeUndefined();
    const usdc = NETWORKS.base.tokens[0]!;
    const tok = rows.find((r) => r.subId === `token:${usdc.contract}`)!;
    expect(tok).toMatchObject({ assetKey: usdc.key, direction: 'out', amount: before.tokens[0]! - after.tokens[0]!, chargeFee: false });
    expect(reconcile('base', before, after, rows, 1)).toEqual([]);
  });

  it('Base: without the l1Fee the balance would not reconcile (shows up as a residual)', () => {
    const fx = load('base-usdc-send.json');
    const recs = analyzeBlockData(ctxOf('base', fx.address, false), blockData(fx, false), stateOf(fx.before), stateOf(fx.after));
    const native = toRawTransfers('base', fx.address, recs).find((r) => r.subId === 'native')!;
    expect(native.meta?.internal).toBe(true);
    expect(native.amount).toBe(BigInt(fx.receipts[0].l1Fee));
  });

  it('BSC: token -> BNB swap; internal BNB from the router merges into our native row', () => {
    const fx = load('bsc-swap-internal.json');
    const before = stateOf(fx.before);
    const after = stateOf(fx.after);
    const rows = toRawTransfers('bsc', fx.address, analyzeBlockData(ctxOf('bsc', fx.address), blockData(fx, false), before, after));
    expect(rows).toHaveLength(1); // the sold token is not tracked -> ignored
    const rc = fx.receipts[0];
    const fee = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
    expect(rows[0]).toMatchObject({ subId: 'native', direction: 'in', chargeFee: true, fee, txid: rc.transactionHash });
    expect(rows[0]!.amount).toBe(after.balance - before.balance + fee);
    expect(rows[0]!.meta?.internal).toBe(true);
    expect(rows[0]!.meta?.syntheticTxid).toBeUndefined();
    expect(reconcile('bsc', before, after, rows, 1)).toEqual([]);
  });

  it('BSC: failed tx -> fee-only row with status failed', () => {
    const fx = load('bsc-failed-tx.json');
    const before = stateOf(fx.before);
    const after = stateOf(fx.after);
    const rows = toRawTransfers('bsc', fx.address, analyzeBlockData(ctxOf('bsc', fx.address), blockData(fx, false), before, after));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'out', amount: 0n, chargeFee: true, status: 'failed', fee: before.balance - after.balance });
    expect(reconcile('bsc', before, after, rows, 1)).toEqual([]);
  });

  it('balance change without any tx of ours -> synthetic block:<n>:internal rows (native and token)', () => {
    const fx = load('bsc-failed-tx.json');
    const stranger = '0x9999999999999999999999999999999999999999';
    const before: ChainState = { nonce: 0n, balance: 10n ** 18n, tokens: [5n, 0n] };
    const after: ChainState = { nonce: 0n, balance: 15n * 10n ** 17n, tokens: [7n, 0n] };
    const rows = toRawTransfers('bsc', stranger, analyzeBlockData(ctxOf('bsc', stranger), blockData(fx, false), before, after));
    const txid = `block:${fx.blockNumber}:internal`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      txid,
      subId: 'native',
      direction: 'in',
      amount: 5n * 10n ** 17n,
      chargeFee: false,
      counterparty: null,
    });
    expect(rows[0]!.meta).toMatchObject({ syntheticTxid: true, internal: true });
    expect(rows[1]).toMatchObject({ txid, subId: `token:${NETWORKS.bsc.tokens[0]!.contract}`, direction: 'in', amount: 2n });
    expect(reconcile('bsc', before, after, rows)).toEqual([]);
  });

  it('residual without own tx is keyed block:<n>:internal whatever the log source (no attribution hints)', () => {
    const fx = load('bsc-swap-internal.json');
    // The pair contract is mentioned by an (untracked) token log of the swap tx: that is not
    // evidence for the native movement, and the key must not depend on which log source answered.
    const transferLog = fx.logs[0][0];
    const pair = '0x' + transferLog.topics[2].slice(26);
    const before: ChainState = { nonce: 0n, balance: 1000n, tokens: [0n, 0n] };
    const after: ChainState = { nonce: 0n, balance: 400n, tokens: [0n, 0n] };
    const viaLogs = blockData(fx, false);
    viaLogs.logs = collectLogs([[transferLog]], fx.blockNumber);
    const viaScan = blockData(fx, false);
    viaScan.logs = null;
    for (const data of [viaLogs, viaScan]) {
      const rows = toRawTransfers('bsc', pair, analyzeBlockData(ctxOf('bsc', pair), data, before, after));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ txid: `block:${fx.blockNumber}:internal`, direction: 'out', amount: 600n, chargeFee: false });
      expect(rows[0]!.meta).toMatchObject({ syntheticTxid: true, internal: true });
    }
  });

  it('pre-Byzantium receipts (root, no status) parse as successful', () => {
    const fx = load('eth-pre-byzantium-receipt.json');
    expect(fx.receipt.status).toBeUndefined();
    expect(typeof fx.receipt.root).toBe('string');
    const r = parseReceipt(fx.receipt, false)!;
    expect(r).not.toBeNull();
    expect(r.success).toBe(true);
    expect(r.gasUsed).toBe(BigInt(fx.receipt.gasUsed));
    expect(parseReceipt({ ...fx.receipt, status: 'garbage' }, false)).toBeNull();
  });

  it('zero-value tracked Transfer logs (poisoning) are ignored', () => {
    const fx = load('base-usdc-send.json');
    const data = blockData(fx, true);
    const me = fx.address as string;
    const usdc = NETWORKS.base.tokens[0]!.contract!;
    data.logs = [
      ...data.logs!,
      {
        address: usdc,
        topics: [TRANSFER_TOPIC, addressTopic(me), addressTopic('0x00000000000000000000000000000000000000aa')],
        data: '0x' + '0'.repeat(64),
        txHash: '0x' + 'ab'.repeat(32),
        logIndex: 99,
        blockHash: null,
        removed: false,
      },
    ];
    const rows = toRawTransfers('base', me, analyzeBlockData(ctxOf('base', me), data, stateOf(fx.before), stateOf(fx.after)));
    expect(rows.some((r) => r.txid === '0x' + 'ab'.repeat(32))).toBe(false);
    expect(rows).toHaveLength(2);
  });
});

/* ============================================================================================ */

describe('bisection', () => {
  type S = { nonce: bigint; balance: bigint };
  /** Fake chain: map block -> state delta; returns state at any block. */
  const chain = (events: Array<[number, bigint, bigint]>) => {
    const sorted = [...events].sort((a, b) => a[0] - b[0]);
    let probes = 0;
    const at = async (b: number): Promise<S> => {
      probes++;
      let nonce = 0n;
      let balance = 0n;
      for (const [blk, dn, db] of sorted)
        if (blk <= b) {
          nonce += dn;
          balance += db;
        }
      return { nonce, balance };
    };
    return {
      at,
      probes: () => probes,
      stateSync: (b: number) =>
        sorted
          .filter((e) => e[0] <= b)
          .reduce((s, e) => ({ nonce: s.nonce + e[1], balance: s.balance + e[2] }), { nonce: 0n, balance: 0n }),
    };
  };
  const key = (s: S) => `${s.nonce}:${s.balance}`;

  it('finds every change block with the right before/after states', async () => {
    const c = chain([
      [5, 0n, 100n],
      [17, 1n, -30n],
      [18, 0n, 7n],
      [1000, 0n, 1n],
      [1001, 1n, -1n],
    ]);
    const found: Array<[number, S, S]> = [];
    const res = await bisect<S>({
      lo: 0,
      hi: 5000,
      loState: await c.at(0),
      hiState: await c.at(5000),
      probe: c.at,
      key,
      onChange: (b, x, y) => void found.push([b, x, y]),
      concurrency: 3,
    });
    expect(found.map((f) => f[0]).sort((a, b) => a - b)).toEqual([5, 17, 18, 1000, 1001]);
    for (const [b, x, y] of found) {
      expect(x).toEqual(c.stateSync(b - 1));
      expect(y).toEqual(c.stateSync(b));
    }
    expect(res.changes).toBe(5);
  });

  it('catches an in + out pair that cancels in balance thanks to the nonce', async () => {
    // +1 at block 40 (received), -1 at block 60 (we sent it: nonce +1). Fee ignored for the test.
    const c = chain([
      [40, 0n, 1n],
      [60, 1n, -1n],
    ]);
    const found: number[] = [];
    await bisect<S>({
      lo: 0,
      hi: 100,
      loState: await c.at(0),
      hiState: await c.at(100),
      probe: c.at,
      key,
      onChange: (b) => void found.push(b),
    });
    expect(found.sort((a, b) => a - b)).toEqual([40, 60]);
    // Balance-only fingerprint would miss both.
    const missed: number[] = [];
    await bisect<S>({
      lo: 0,
      hi: 100,
      loState: await c.at(0),
      hiState: await c.at(100),
      probe: c.at,
      key: (s) => String(s.balance),
      onChange: (b) => void missed.push(b),
    });
    expect(missed).toEqual([]);
  });

  it('is cheap on a huge, sparse range (BSC-sized)', async () => {
    const N = 134_000_000;
    const c = chain([
      [120_000_000, 0n, 5n],
      [120_000_123, 1n, -2n],
      [133_999_000, 0n, 9n],
    ]);
    const lo = await c.at(0);
    const hi = await c.at(N);
    const before = c.probes();
    const found: number[] = [];
    let lastFraction = 0;
    const res = await bisect<S>({
      lo: 0,
      hi: N,
      loState: lo,
      hiState: hi,
      probe: c.at,
      key,
      onChange: (b) => void found.push(b),
      onProgress: (p) => {
        lastFraction = p.resolved / p.total;
      },
    });
    expect(found.sort((a, b) => a - b)).toEqual([120_000_000, 120_000_123, 133_999_000]);
    expect(c.probes() - before).toBe(res.probes);
    expect(res.probes).toBeLessThan(3 * 28);
    expect(lastFraction).toBe(1);
  });

  it('no change -> no probes; respects abort and probe budgets', async () => {
    const c = chain([[10, 0n, 1n]]);
    const s = await c.at(5);
    expect(await bisect<S>({ lo: 0, hi: 1_000_000, loState: s, hiState: s, probe: c.at, key, onChange: () => {} })).toEqual({
      probes: 0,
      changes: 0,
      unresolved: [],
    });
    const ctrl = new AbortController();
    ctrl.abort(new Error('stop'));
    await expect(
      bisect<S>({
        lo: 0,
        hi: 100,
        loState: await c.at(0),
        hiState: await c.at(100),
        probe: c.at,
        key,
        onChange: () => {},
        signal: ctrl.signal,
      }),
    ).rejects.toThrow('stop');
    // A budget stops cleanly and leaves a resume point instead of throwing.
    const budget = await bisect<S>({
      lo: 0,
      hi: 1 << 20,
      loState: await c.at(0),
      hiState: await c.at(1 << 20),
      probe: c.at,
      key,
      onChange: () => {},
      maxProbes: 3,
    });
    expect(budget.stopped).toBe('budget');
    expect(budget.error).toBeInstanceOf(BisectBudgetError);
    expect(budget.unresolved.length).toBeGreaterThan(0);
  });

  it('retries a failing interval with backoff instead of failing the whole scan', async () => {
    const c = chain([
      [100, 0n, 1n],
      [900, 1n, -1n],
    ]);
    let fails = 2;
    const flaky = async (b: number): Promise<S> => {
      if (b === 512 && fails-- > 0) throw new Error('missing trie node');
      return c.at(b);
    };
    const found: number[] = [];
    const res = await bisect<S>({
      lo: 0,
      hi: 1024,
      loState: await c.at(0),
      hiState: await c.at(1024),
      probe: flaky,
      key,
      onChange: (b) => void found.push(b),
      retryDelaysMs: [1, 1, 1],
    });
    expect(res.unresolved).toEqual([]);
    expect(found.sort((a, b) => a - b)).toEqual([100, 900]);
  });

  it('a permanently failing interval stays unresolved while the rest completes; lowest lo is the resume point', async () => {
    const c = chain([
      [100, 0n, 1n],
      [900, 1n, -1n],
    ]);
    const found: number[] = [];
    // Analysis of block 900 always fails.
    const res = await bisect<S>({
      lo: 0,
      hi: 1024,
      loState: await c.at(0),
      hiState: await c.at(1024),
      probe: c.at,
      key,
      onChange: (b) => {
        if (b === 900) throw new Error('receipts unavailable');
        found.push(b);
      },
      retryDelaysMs: [1, 1],
    });
    expect(found).toEqual([100]);
    expect(res.stopped).toBe('failed');
    expect(res.unresolved).toMatchObject([{ lo: 899, hi: 900 }]);
    expect(frontierOf(res)).toMatchObject({ lo: 899, hi: 900, loState: c.stateSync(899), hiState: c.stateSync(900) });
    // Resuming from the unresolved intervals finishes the job.
    const resumed = await bisect<S>({ intervals: res.unresolved, probe: c.at, key, onChange: (b) => void found.push(b) });
    expect(resumed.unresolved).toEqual([]);
    expect(found).toEqual([100, 900]);
  });

  it('a deadline returns a consistent frontier: everything at or below it is processed', async () => {
    const events: Array<[number, bigint, bigint]> = [];
    for (let b = 10; b <= 1000; b += 10) events.push([b, 0n, 1n]);
    const c = chain(events);
    const found: number[] = [];
    const slow = async (b: number): Promise<S> => {
      await new Promise((r) => setTimeout(r, 3));
      return c.at(b);
    };
    const res = await bisect<S>({
      lo: 0,
      hi: 1000,
      loState: await c.at(0),
      hiState: await c.at(1000),
      probe: slow,
      key,
      onChange: (b) => void found.push(b),
      deadline: Date.now() + 60,
    });
    expect(res.stopped).toBe('deadline');
    const f = frontierOf(res)!;
    expect(f.loState).toEqual(c.stateSync(f.lo));
    expect(f.hiState).toEqual(c.stateSync(f.hi));
    const expected = events.map((e) => e[0]).filter((b) => b <= f.lo);
    expect(found.filter((b) => b <= f.lo).sort((a, b) => a - b)).toEqual(expected);
  });
});

/* ============================================================================================ */
/* End-to-end against a fake chain (JSON-RPC + Blockscout-style explorer on localhost)           */
/* ============================================================================================ */

interface FakeLog {
  address: string;
  from: string;
  to: string;
  value: bigint;
}
interface FakeTx {
  hash: string;
  from: string;
  to: string;
  value: bigint;
  gasUsed: bigint;
  gasPrice: bigint;
  ok: boolean;
  logs: FakeLog[];
  input: string;
}
interface FakeInternal {
  /** Parent tx (shown by the explorer) or null (not shown anywhere, e.g. a system credit). */
  hash: string | null;
  /** Has a parent tx but the explorer does not list it. */
  hidden?: boolean;
  from: string;
  to: string;
  value: bigint;
}
interface FakeBlock {
  txs: FakeTx[];
  internals: FakeInternal[];
}

const hex = (n: number | bigint) => '0x' + n.toString(16);
const pad = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');

class FakeChain {
  tip = 0;
  explorerHead = 0;
  silentEmptyLogs = false;
  /** State reads (balance / nonce / eth_call) at blocks in this range fail ("missing trie node"). */
  failStateRange: [number, number] | null = null;
  readonly blocks = new Map<number, FakeBlock>();
  private n = 0;
  readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }
  newHash(): string {
    return '0x' + (++this.n).toString(16).padStart(64, 'f');
  }
  block(b: number): FakeBlock {
    let blk = this.blocks.get(b);
    if (!blk) this.blocks.set(b, (blk = { txs: [], internals: [] }));
    return blk;
  }
  tx(b: number, t: Partial<FakeTx> & { from: string; to: string }): FakeTx {
    const full: FakeTx = {
      hash: this.newHash(),
      value: 0n,
      gasUsed: 21000n,
      gasPrice: 3n * 10n ** 9n,
      ok: true,
      logs: [],
      input: '0x',
      ...t,
    };
    this.block(b).txs.push(full);
    return full;
  }
  sorted(): Array<[number, FakeBlock]> {
    return [...this.blocks.entries()].sort((a, b) => a[0] - b[0]);
  }
  state(addr: string, b: number): { balance: bigint; nonce: bigint; tokens: Map<string, bigint> } {
    let balance = 0n;
    let nonce = 0n;
    const tokens = new Map<string, bigint>();
    for (const [n, blk] of this.sorted()) {
      if (n > b) break;
      for (const t of blk.txs) {
        if (t.from === addr) {
          nonce++;
          balance -= t.gasUsed * t.gasPrice;
        }
        if (!t.ok) continue;
        if (t.from === addr) balance -= t.value;
        if (t.to === addr) balance += t.value;
        for (const l of t.logs) {
          if (l.from === addr) tokens.set(l.address, (tokens.get(l.address) ?? 0n) - l.value);
          if (l.to === addr) tokens.set(l.address, (tokens.get(l.address) ?? 0n) + l.value);
        }
      }
      for (const i of blk.internals) {
        if (i.from === addr) balance -= i.value;
        if (i.to === addr) balance += i.value;
      }
    }
    return { balance, nonce, tokens };
  }
  findTx(hash: string): [number, FakeTx, number] | null {
    for (const [n, blk] of this.blocks) {
      const i = blk.txs.findIndex((t) => t.hash === hash);
      if (i >= 0) return [n, blk.txs[i]!, i];
    }
    return null;
  }
  rpcTx(n: number, t: FakeTx, i: number) {
    return {
      hash: t.hash,
      from: t.from,
      to: t.to,
      value: hex(t.value),
      input: t.input,
      type: '0x2',
      transactionIndex: hex(i),
      gasPrice: hex(t.gasPrice),
      blockNumber: hex(n),
    };
  }
  rpcLogs(n: number, t: FakeTx, i: number) {
    return t.logs.map((l, k) => ({
      address: l.address,
      topics: [TRANSFER_TOPIC, addressTopic(l.from), addressTopic(l.to)],
      data: pad(l.value),
      transactionHash: t.hash,
      transactionIndex: hex(i),
      logIndex: hex(k),
      blockNumber: hex(n),
      blockHash: pad(BigInt(n)),
      removed: false,
    }));
  }
  handle(method: string, params: unknown[]): unknown {
    const tag = (v: unknown) => {
      const b = v === 'latest' ? this.tip : Number(BigInt(v as string));
      if (b > this.tip) throw new Error('header not found');
      return b;
    };
    if (method === 'eth_getBalance' || method === 'eth_getTransactionCount' || method === 'eth_call') {
      const b = tag(params[1]);
      if (this.failStateRange && b >= this.failStateRange[0] && b <= this.failStateRange[1]) throw new Error('missing trie node');
    }
    switch (method) {
      case 'eth_blockNumber':
        return hex(this.tip);
      case 'eth_getBalance':
        return hex(this.state(String(params[0]).toLowerCase(), tag(params[1])).balance);
      case 'eth_getTransactionCount':
        return hex(this.state(String(params[0]).toLowerCase(), tag(params[1])).nonce);
      case 'eth_call': {
        const { to, data } = params[0] as { to: string; data: string };
        const who = '0x' + data.slice(-40);
        return pad(this.state(who, tag(params[1])).tokens.get(to) ?? 0n);
      }
      case 'eth_getBlockByNumber': {
        const n = tag(params[0]);
        const blk = this.blocks.get(n);
        return {
          number: hex(n),
          hash: pad(BigInt(n)),
          timestamp: hex(1_700_000_000 + n),
          transactions: (blk?.txs ?? []).map((t, i) => (params[1] ? this.rpcTx(n, t, i) : t.hash)),
        };
      }
      case 'eth_getLogs': {
        const f = params[0] as { fromBlock: string; toBlock: string; topics: (string | null)[] };
        const out: unknown[] = [];
        // Like a pruned publicnode node: "success" with an empty list.
        if (this.silentEmptyLogs) return out;
        for (const [n, blk] of this.blocks) {
          if (n < Number(BigInt(f.fromBlock)) || n > Number(BigInt(f.toBlock))) continue;
          blk.txs.forEach((t, i) => {
            if (!t.ok) return;
            for (const l of this.rpcLogs(n, t, i)) if (f.topics.every((tp, k) => tp === null || l.topics[k] === tp)) out.push(l);
          });
        }
        return out;
      }
      case 'eth_getTransactionReceipt': {
        const found = this.findTx(String(params[0]));
        if (!found) return null;
        const [n, t, i] = found;
        return {
          transactionHash: t.hash,
          blockNumber: hex(n),
          status: t.ok ? '0x1' : '0x0',
          gasUsed: hex(t.gasUsed),
          effectiveGasPrice: hex(t.gasPrice),
          contractAddress: null,
          logs: t.ok ? this.rpcLogs(n, t, i) : [],
        };
      }
      case 'eth_getTransactionByHash': {
        const found = this.findTx(String(params[0]));
        return found ? this.rpcTx(...found) : null;
      }
      default:
        throw new Error(`method ${method} not supported`);
    }
  }
  explorer(q: URLSearchParams): unknown {
    const me = (q.get('address') ?? '').toLowerCase();
    const start = Number(q.get('startblock'));
    const end = Math.min(Number(q.get('endblock')), this.explorerHead);
    const rows: Record<string, string>[] = [];
    for (const [n, blk] of this.sorted()) {
      if (n < start || n > end) continue;
      blk.txs.forEach((t, i) => {
        const base = {
          blockNumber: String(n),
          timeStamp: String(1_700_000_000 + n),
          hash: t.hash,
          transactionIndex: String(i),
          gasUsed: String(t.gasUsed),
          gasPrice: String(t.gasPrice),
        };
        if (q.get('action') === 'txlist' && (t.from === me || t.to === me)) {
          rows.push({
            ...base,
            from: t.from,
            to: t.to,
            value: String(t.value),
            isError: t.ok ? '0' : '1',
            txreceipt_status: t.ok ? '1' : '0',
            contractAddress: '',
          });
        }
        if (q.get('action') === 'tokentx' && t.ok) {
          for (const l of t.logs)
            if (l.address === q.get('contractaddress') && (l.from === me || l.to === me))
              rows.push({ ...base, from: l.from, to: l.to, value: String(l.value), contractAddress: l.address });
        }
      });
      if (q.get('action') === 'txlistinternal') {
        for (const i of blk.internals) {
          if (i.hash && !i.hidden && (i.from === me || i.to === me))
            rows.push({
              blockNumber: String(n),
              timeStamp: String(1_700_000_000 + n),
              transactionHash: i.hash,
              from: i.from,
              to: i.to,
              value: String(i.value),
              isError: '0',
              contractAddress: '',
            });
        }
      }
    }
    const page = Number(q.get('page'));
    const offset = Number(q.get('offset'));
    const slice = rows.slice((page - 1) * offset, page * offset);
    return slice.length ? { status: '1', message: 'OK', result: slice } : { status: '0', message: 'No transactions found', result: [] };
  }
}

describe('adapter end-to-end against a fake chain', () => {
  const mk = (prefix: string) => '0x' + prefix.padEnd(40, '0');
  const ME = mk('1111111111111111111111111111111111111111');
  const ALICE = mk('a11ce');
  const ROUTER = mk('7007e7');
  const SYSTEM = mk('5555');
  const bscTokens = NETWORKS.bsc.tokens.map((t) => t.contract!);
  const USDT = bscTokens[0]!;
  const chain = new FakeChain(bscTokens);
  let server: Server;
  let base = '';
  const counts = { http: 0, batches: 0, etherscan: 0 };
  let rejectBatches = false;
  let latencyMs = 0;
  const env = load('etherscan-vitalik.json').envelopes;

  beforeAll(async () => {
    setConfigForTests({ httpRateMultiplier: 20, etherscanApiKey: null });
    server = createServer((req, res) => {
      counts.http++;
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/es') {
        // Etherscan answering with the real "free plan does not cover this chain" envelope.
        counts.etherscan++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(env.unsupportedChain));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(chain.explorer(url.searchParams)));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const msg = JSON.parse(body);
        const one = (m: { id: number; method: string; params: unknown[] }) => {
          try {
            return { jsonrpc: '2.0', id: m.id, result: chain.handle(m.method, m.params) };
          } catch (err) {
            return { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: (err as Error).message } };
          }
        };
        res.setHeader('content-type', 'application/json');
        if (latencyMs > 0) {
          const reply = Array.isArray(msg) ? JSON.stringify(msg.map(one)) : JSON.stringify(one(msg));
          setTimeout(() => res.end(reply), latencyMs);
          return;
        }
        if (Array.isArray(msg)) {
          counts.batches++;
          if (rejectBatches)
            return res.end(
              JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch requests are not supported' } }),
            );
          return res.end(JSON.stringify(msg.map(one)));
        }
        res.end(JSON.stringify(one(msg)));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await closeHttp();
    await new Promise((r) => server.close(r));
  });

  const configFor = (network: 'bsc' | 'ethereum', explorer: boolean): EvmNetworkConfig => {
    const ep = { url: `${base}/rpc`, maxBatch: 10, retries: 0 };
    const route = { recent: [ep], archive: [ep], window: 1_000_000_000 };
    return {
      ...EVM_CONFIG[network],
      headLag: 0,
      explorers: explorer ? [{ kind: 'blockscout', url: `${base}/api` }] : [],
      routes: { state: route, block: route, receipt: route, logs: route },
    };
  };

  /** Applies all transfers to a balance sheet and compares with the chain state. */
  const expectLedgerMatches = (rows: RawTransfer[], at: number) => {
    const s = chain.state(ME, at);
    let native = 0n;
    const tok = new Map<string, bigint>();
    for (const r of rows) {
      const signed = r.direction === 'in' ? r.amount : r.direction === 'out' ? -r.amount : 0n;
      if (r.subId === 'native') native += signed;
      else tok.set(r.subId.slice(6), (tok.get(r.subId.slice(6)) ?? 0n) + signed);
      if (r.chargeFee && r.fee) native -= r.fee;
    }
    expect(native).toBe(s.balance);
    for (const c of bscTokens) expect(tok.get(c) ?? 0n).toBe(s.tokens.get(c) ?? 0n);
    oneChargePerTx(rows);
  };

  it('RPC network: initCursor, unchanged poll, change detection, backfill and tx status', async () => {
    // History before the cursor.
    chain.tx(1_000, { from: ALICE, to: ME, value: 5n * 10n ** 18n });
    chain.tx(250_000, { from: ME, to: USDT, input: '0xa9059cbb', logs: [] }); // approve-like call, fee only
    chain.tx(250_000, { from: ALICE, to: USDT, input: '0xa9059cbb', logs: [{ address: USDT, from: ALICE, to: ME, value: 700n }] });
    chain.tip = 300_000;

    const a = createEvmAdapterInternal('bsc', { config: configFor('bsc', false), tipMaxAgeMs: 0 });
    expect(await a.getTip()).toBe(300_000);
    const cursor = await a.initCursor(ME);
    expect(cursor).toMatchObject({ v: 1, block: 300_000 });

    // Nothing new: cheap no-op that only advances the block.
    chain.tip = 300_050;
    const before = a.rpc.stats.requests;
    const idle = await a.poll(ME, cursor);
    expect(idle.transfers).toEqual([]);
    expect(idle.cursor).toMatchObject({ block: 300_050, fp: cursor.fp });
    expect(a.rpc.stats.requests - before).toBeLessThanOrEqual(2);

    // New activity.
    const tIn = chain.tx(300_060, { from: ALICE, to: ME, value: 10n ** 18n });
    const tFail = chain.tx(300_070, { from: ME, to: ROUTER, value: 10n ** 17n, ok: false, input: '0x1234' });
    const tSwap = chain.tx(300_080, {
      from: ME,
      to: ROUTER,
      input: '0x18cbafe5',
      logs: [{ address: USDT, from: ME, to: ROUTER, value: 300n }],
    });
    chain.block(300_080).internals.push({ hash: tSwap.hash, from: ROUTER, to: ME, value: 2n * 10n ** 17n });
    chain.block(300_090).internals.push({ hash: null, from: SYSTEM, to: ME, value: 123n }); // no tx of ours
    // Received and forwarded the same amount: cancels in balance, nonce reveals it.
    chain.tx(300_095, { from: ALICE, to: ME, value: 4n * 10n ** 17n, gasPrice: 0n });
    const tFwd = chain.tx(300_097, { from: ME, to: ALICE, value: 4n * 10n ** 17n, gasPrice: 0n });
    chain.tip = 300_120;

    const p = await a.poll(ME, idle.cursor);
    expect(p.cursor).toMatchObject({ block: 300_120 });
    const ids = (h: string) => p.transfers.filter((t) => t.txid === h);
    expect(ids(tIn.hash)).toMatchObject([
      { direction: 'in', amount: 10n ** 18n, chargeFee: false, counterparty: ALICE, blockHeight: 300_060, blockTime: 1_700_300_060 },
    ]);
    expect(ids(tFail.hash)).toMatchObject([{ status: 'failed', amount: 0n, chargeFee: true, fee: 21000n * 3n * 10n ** 9n }]);
    const swap = ids(tSwap.hash);
    expect(swap).toHaveLength(2);
    expect(swap.find((t) => t.subId === 'native')).toMatchObject({
      direction: 'in',
      amount: 2n * 10n ** 17n,
      chargeFee: true,
      meta: { internal: true },
    });
    expect(swap.find((t) => t.subId === `token:${USDT}`)).toMatchObject({ direction: 'out', amount: 300n, chargeFee: false });
    expect(p.transfers.find((t) => t.txid === 'block:300090:internal')).toMatchObject({
      direction: 'in',
      amount: 123n,
      meta: { syntheticTxid: true, internal: true },
    });
    expect(ids(tFwd.hash)).toMatchObject([{ direction: 'out', amount: 4n * 10n ** 17n }]);

    // Backfill up to the original cursor finds the history.
    const batches: RawTransfer[][] = [];
    const progress: number[] = [];
    const hist = await a.backfill(ME, cursor, {
      onBatch: (b) => void batches.push(b),
      onProgress: (pr) => progress.push(pr.fraction ?? 0),
    });
    expect(batches.flat()).toHaveLength(hist.length);
    expect(hist.map((t) => [t.blockHeight, t.subId, t.direction])).toEqual([
      [1_000, 'native', 'in'],
      [250_000, 'native', 'out'],
      [250_000, `token:${USDT}`, 'in'],
    ]);
    expect(progress.at(-1)).toBe(1);
    expectLedgerMatches([...hist, ...p.transfers], 300_120);

    expect(await a.getTxStatus(tIn.hash, ME)).toEqual({ state: 'confirmed', blockHeight: 300_060, blockTime: 1_700_300_060 });
    expect((await a.getTxStatus(tFail.hash, ME)).state).toBe('failed');
    expect((await a.getTxStatus('0x' + '42'.repeat(32), ME)).state).toBe('unknown');
    expect((await a.getTxStatus('block:300090:internal', ME)).state).toBe('confirmed');

    const bal = await a.getBalances(ME);
    expect(bal.get('bsc:native')).toBe(chain.state(ME, 300_120).balance);
    expect(bal.get(`bsc:${USDT}`)).toBe(400n);
  });

  it('distrusts empty eth_getLogs answers that do not explain a token balance change', async () => {
    const a = createEvmAdapterInternal('bsc', { config: configFor('bsc', false), tipMaxAgeMs: 0 });
    const CAROL = mk('ca401');
    chain.tip = 350_000;
    const cursor = await a.initCursor(CAROL);
    const t = chain.tx(350_010, {
      from: ALICE,
      to: USDT,
      input: '0xa9059cbb' + addressTopic(CAROL).slice(2) + pad(42n).slice(2),
      logs: [{ address: USDT, from: ALICE, to: CAROL, value: 42n }],
    });
    chain.tip = 350_020;
    chain.silentEmptyLogs = true;
    try {
      const p = await a.poll(CAROL, cursor);
      expect(p.transfers).toMatchObject([{ txid: t.hash, subId: `token:${USDT}`, direction: 'in', amount: 42n, counterparty: ALICE }]);
      expect(p.transfers[0]!.meta?.residual).toBeUndefined();
    } finally {
      chain.silentEmptyLogs = false;
    }
  });

  it('falls back to sequential calls when an endpoint rejects batches', async () => {
    rejectBatches = true;
    try {
      const a = createEvmAdapterInternal('bsc', { config: configFor('bsc', false), tipMaxAgeMs: 0 });
      const bal = await a.getBalances(ME);
      expect(bal.get('bsc:native')).toBe(chain.state(ME, chain.tip).balance);
    } finally {
      rejectBatches = false;
    }
  });

  it('explorer network: waits for a lagging explorer, then falls back to bisection for what it never shows', async () => {
    const a = createEvmAdapterInternal('ethereum', { config: configFor('ethereum', true), tipMaxAgeMs: 0 });
    // The fake chain uses BSC token contracts; Ethereum tracks different ones, so only native matters here.
    chain.tip = 400_000;
    chain.explorerHead = 400_000;
    const cursor = await a.initCursor(ME);

    const t1 = chain.tx(400_010, { from: ALICE, to: ME, value: 7n });
    chain.tip = 400_020;
    chain.explorerHead = 400_005; // explorer has not indexed block 400010 yet
    const lag = await a.poll(ME, cursor);
    expect(lag.transfers).toEqual([]);
    expect(lag.cursor).toMatchObject({ block: cursor.block, fp: cursor.fp, retries: 1 });

    chain.explorerHead = 400_020;
    const ok = await a.poll(ME, lag.cursor);
    expect(ok.transfers).toMatchObject([{ txid: t1.hash, direction: 'in', amount: 7n }]);
    expect(ok.cursor).toMatchObject({ block: 400_020 });
    expect(ok.cursor.retries).toBeUndefined();

    // A credit the explorer never shows (no parent tx): retried, then found by bisection.
    chain.block(400_030).internals.push({ hash: null, from: SYSTEM, to: ME, value: 55n });
    chain.tip = 400_040;
    chain.explorerHead = 400_040;
    let c = ok.cursor;
    for (let i = 1; i <= 4; i++) {
      const r = await a.poll(ME, c);
      expect(r.transfers).toEqual([]);
      expect(r.cursor.retries).toBe(i);
      c = r.cursor;
    }
    const fb = await a.poll(ME, c);
    expect(fb.transfers).toMatchObject([{ txid: 'block:400030:internal', direction: 'in', amount: 55n }]);
    expect(fb.cursor).toMatchObject({ block: 400_040 });

    // Busy address, explorer one tx behind: accept what it has (exactly reconciled) right away.
    const tA = chain.tx(400_050, { from: ME, to: ALICE, value: 3n });
    const tB = chain.tx(400_052, { from: ALICE, to: ME, value: 9n });
    chain.tip = 400_060;
    chain.explorerHead = 400_051;
    const part = await a.poll(ME, fb.cursor);
    expect(part.transfers.map((t) => t.txid)).toEqual([tA.hash]);
    expect(part.cursor).toMatchObject({ block: 400_050 });
    expect(part.cursor.retries).toBeUndefined();
    chain.explorerHead = 400_060;
    const rest = await a.poll(ME, part.cursor);
    expect(rest.transfers.map((t) => t.txid)).toEqual([tB.hash]);
    expect(rest.cursor).toMatchObject({ block: 400_060 });
  });

  it('explorer backfill: a tx the explorer has not indexed yet is repaired from chain data', async () => {
    const a = createEvmAdapterInternal('ethereum', { config: configFor('ethereum', true), tipMaxAgeMs: 0 });
    const BOB = mk('b0b');
    chain.tx(500_000, { from: ALICE, to: BOB, value: 10n ** 18n });
    chain.tx(500_100, { from: BOB, to: ALICE, value: 10n ** 17n });
    const late = chain.tx(500_150, { from: BOB, to: ALICE, value: 10n ** 16n });
    chain.tip = 500_160;
    chain.explorerHead = 500_120; // the last tx is not indexed yet
    const boundary = await a.initCursor(BOB);
    const batches: RawTransfer[][] = [];
    const hist = await a.backfill(BOB, boundary, { onBatch: (b) => void batches.push(b) });
    expect(hist.map((t) => t.blockHeight)).toEqual([500_000, 500_100, 500_150]);
    expect(hist.find((t) => t.txid === late.hash)).toMatchObject({ direction: 'out', amount: 10n ** 16n, chargeFee: true });
    // Everything near the boundary was held back and delivered once, after verification.
    const delivered = batches.flat();
    expect(delivered.map((t) => t.txid).sort()).toEqual(hist.map((t) => t.txid).sort());
    const s = chain.state(BOB, 500_160);
    let native = 0n;
    for (const t of hist) native += (t.direction === 'in' ? t.amount : -t.amount) - (t.chargeFee && t.fee ? t.fee : 0n);
    expect(native).toBe(s.balance);
  });

  /** Fingerprint of the fake chain state (what a correct cursor must carry). */
  const fpAt = (who: string, b: number): string => {
    const s = chain.state(who, b);
    return fingerprint({ nonce: s.nonce, balance: s.balance, tokens: bscTokens.map((c) => s.tokens.get(c) ?? 0n) });
  };
  /** Native balance implied by delivered rows, applying later versions of a txid/subId over earlier ones (upsert). */
  const upsertLedger = (rows: RawTransfer[]): bigint => {
    const last = new Map<string, RawTransfer>();
    for (const t of rows) last.set(`${t.txid}|${t.subId}`, t);
    let native = 0n;
    for (const t of last.values()) {
      if (t.subId === 'native') native += t.direction === 'in' ? t.amount : t.direction === 'out' ? -t.amount : 0n;
      if (t.chargeFee && t.fee) native -= t.fee;
    }
    return native;
  };

  it('cursor block stays at least `confirmations` behind the tip (reorg safety)', async () => {
    for (const n of EVM_NETWORKS) expect(EVM_CONFIG[n].headLag).toBeGreaterThanOrEqual(NETWORKS[n].confirmations);
    const a = createEvmAdapterInternal('bsc', { config: { ...configFor('bsc', false), headLag: EVM_CONFIG.bsc.headLag }, tipMaxAgeMs: 0 });
    chain.tip = 590_000;
    expect((await a.initCursor(ME)).block).toBe(590_000 - NETWORKS.bsc.confirmations);
  });

  it('poll: a long range is covered over several polls (span cap + time budget), every cursor consistent', async () => {
    const DAVE = mk('da4e');
    chain.tip = 600_000;
    const a = createEvmAdapterInternal('bsc', {
      config: { ...configFor('bsc', false), pollMaxSpan: 5_000 },
      tipMaxAgeMs: 0,
      pollBudgetMs: 80,
    });
    let c = await a.initCursor(DAVE);
    const sent = [];
    for (let k = 1; k <= 10; k++) sent.push(chain.tx(600_000 + k * 1_100, { from: ALICE, to: DAVE, value: BigInt(k) }));
    chain.tip = 612_100;
    latencyMs = 10;
    const got: RawTransfer[] = [];
    let polls = 0;
    let interrupted = 0;
    try {
      while ((c.block as number) < 612_100 && polls < 80) {
        const p = await a.poll(DAVE, c);
        polls++;
        expect((p.cursor.block as number) - (c.block as number)).toBeLessThanOrEqual(5_000);
        expect(p.cursor.fp).toBe(fpAt(DAVE, p.cursor.block as number));
        for (const t of p.transfers) expect(t.blockHeight).toBeLessThanOrEqual(p.cursor.block as number);
        const scan = p.cursor.scan as { hi: number; fp: string } | undefined;
        if (scan) {
          // The pending range is real: its end state is what the chain says.
          interrupted++;
          expect(scan.fp).toBe(fpAt(DAVE, scan.hi));
        }
        got.push(...p.transfers);
        c = p.cursor;
      }
    } finally {
      latencyMs = 0;
    }
    expect(c.block).toBe(612_100);
    expect(polls).toBeGreaterThan(3);
    expect(interrupted).toBeGreaterThan(0);
    expect(got.map((t) => t.txid).sort()).toEqual(sent.map((t) => t.hash).sort());
  });

  it('backfill: endpoint failures leave a resume point; the next attempt continues from it', async () => {
    const ERIN = mk('e414');
    chain.tx(650_100, { from: ALICE, to: ERIN, value: 5n });
    chain.tx(650_900, { from: ALICE, to: ERIN, value: 6n });
    chain.tip = 651_000;
    const a = createEvmAdapterInternal('bsc', { config: configFor('bsc', false), tipMaxAgeMs: 0, retryDelaysMs: [1, 1] });
    const boundary = await a.initCursor(ERIN);
    const batches: RawTransfer[][] = [];
    chain.failStateRange = [650_500, 650_999];
    try {
      await expect(a.backfill(ERIN, boundary, { onBatch: (b) => void batches.push(b) })).rejects.toThrow(/next attempt resumes/);
    } finally {
      chain.failStateRange = null;
    }
    expect(batches.flat().map((t) => t.blockHeight)).toEqual([650_100]);
    const before = a.rpc.stats.requests;
    const rest = await a.backfill(ERIN, boundary, { onBatch: (b) => void batches.push(b) });
    const resumed = a.rpc.stats.requests - before;
    expect(rest.map((t) => t.blockHeight)).toEqual([650_900]);
    expect(batches.flat().map((t) => t.blockHeight)).toEqual([650_100, 650_900]);
    expect(upsertLedger(batches.flat())).toBe(chain.state(ERIN, 651_000).balance);
    const fresh = createEvmAdapterInternal('bsc', { config: configFor('bsc', false), tipMaxAgeMs: 0 });
    await fresh.backfill(ERIN, boundary);
    expect(resumed).toBeLessThan(fresh.rpc.stats.requests);
  });

  it('Etherscan refusing the chain on the free plan is skipped and Blockscout answers (not fatal)', async () => {
    chain.explorerHead = chain.tip;
    const ex = new Explorer(
      'polygon',
      [
        { kind: 'etherscan', url: `${base}/es` },
        { kind: 'blockscout', url: `${base}/api` },
      ],
      ['TESTKEY00000000000000'],
    );
    const q = { module: 'account', action: 'txlist', address: ME, startblock: 0, endblock: chain.tip, page: 1, offset: 1000, sort: 'asc' };
    const hitsBefore = counts.etherscan;
    const first = await ex.query(q);
    expect(first.rows.length).toBeGreaterThan(0);
    const second = await ex.query(q);
    expect(second.rows.length).toBe(first.rows.length);
    expect(counts.etherscan - hitsBefore).toBe(1); // disabled for this chain after the refusal
  });

  it('explorer backfill: a delivered row the chain contradicts is re-emitted corrected (upsert)', async () => {
    const FRAN = mk('f4a4');
    const a = createEvmAdapterInternal('ethereum', { config: configFor('ethereum', true), tipMaxAgeMs: 0 });
    chain.tx(700_000, { from: ALICE, to: FRAN, value: 10n ** 18n });
    const call = chain.tx(700_100, { from: FRAN, to: ROUTER, input: '0x12345678' });
    // The explorer never lists this internal payout of FRAN's own call.
    chain.block(700_100).internals.push({ hash: call.hash, hidden: true, from: ROUTER, to: FRAN, value: 3n * 10n ** 17n });
    chain.tip = 710_000;
    chain.explorerHead = 710_000;
    const boundary = await a.initCursor(FRAN);
    const batches: RawTransfer[][] = [];
    const hist = await a.backfill(FRAN, boundary, { onBatch: (b) => void batches.push(b) });
    const versions = batches.flat().filter((t) => t.txid === call.hash && t.subId === 'native');
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ direction: 'out', amount: 0n, chargeFee: true });
    expect(versions[1]).toMatchObject({ direction: 'in', amount: 3n * 10n ** 17n, chargeFee: true, meta: { internal: true } });
    expect(hist.find((t) => t.txid === call.hash)).toMatchObject({ amount: 3n * 10n ** 17n });
    expect(upsertLedger(batches.flat())).toBe(chain.state(FRAN, boundary.block as number).balance);
  });

  it('empty eth_getLogs is distrusted when our own receipts have logs (token in and out cancel in one block)', async () => {
    const GUS = mk('6a5');
    const a = createEvmAdapterInternal('bsc', { config: configFor('bsc', false), tipMaxAgeMs: 0 });
    const transfer = (to: string, v: bigint) => '0xa9059cbb' + addressTopic(to).slice(2) + pad(v).slice(2);
    chain.tx(719_000, { from: ALICE, to: USDT, input: transfer(GUS, 100n), logs: [{ address: USDT, from: ALICE, to: GUS, value: 100n }] });
    chain.tip = 720_000;
    const cursor = await a.initCursor(GUS);
    const tIn = chain.tx(720_010, {
      from: ALICE,
      to: USDT,
      input: transfer(GUS, 7n),
      logs: [{ address: USDT, from: ALICE, to: GUS, value: 7n }],
    });
    const tOut = chain.tx(720_010, {
      from: GUS,
      to: USDT,
      gasPrice: 0n,
      input: transfer(ALICE, 7n),
      logs: [{ address: USDT, from: GUS, to: ALICE, value: 7n }],
    });
    chain.tip = 720_020;
    chain.silentEmptyLogs = true;
    try {
      const p = await a.poll(GUS, cursor);
      expect(p.transfers.map((t) => [t.txid, t.direction, t.amount])).toEqual(
        [
          [tIn.hash, 'in', 7n],
          [tOut.hash, 'out', 7n],
        ].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
      );
    } finally {
      chain.silentEmptyLogs = false;
    }
  });
});

describe('repaired-block merge', () => {
  const row = (txid: string, signed: bigint, extra: Partial<RawTransfer> = {}): RawTransfer => ({
    txid,
    subId: 'native',
    assetKey: 'ethereum:native',
    direction: signed >= 0n ? 'in' : 'out',
    amount: signed >= 0n ? signed : -signed,
    fee: null,
    chargeFee: false,
    counterparty: null,
    blockHeight: 10,
    blockTime: 1,
    status: 'confirmed',
    ...extra,
  });
  const S = '0x' + 'aa'.repeat(32);
  const T = '0x' + 'bb'.repeat(32);
  it('keeps explorer txids: an explorer-only credit is carved out of the synthetic row', () => {
    const m = mergeRepairedBlock([row(S, 5n)], [row('block:10:internal', 8n)]);
    expect(m.retract).toEqual([]);
    expect(m.rows.map((r) => [r.txid, r.direction, r.amount])).toEqual([
      [S, 'in', 5n],
      ['block:10:internal', 'in', 3n],
    ]);
  });
  it('RPC version wins for the same key; an unabsorbable explorer-only row is retracted (amount 0)', () => {
    const m = mergeRepairedBlock(
      [row(T, 0n, { direction: 'out', chargeFee: true, fee: 21n }), row(S, 5n)],
      [row(T, 3n, { chargeFee: true, fee: 21n })],
    );
    expect(m.rows.map((r) => [r.txid, r.direction, r.amount])).toEqual([[T, 'in', 3n]]);
    expect(m.retract).toMatchObject([{ txid: S, amount: 0n, chargeFee: false, meta: { superseded: true } }]);
  });
});

describe('explorer-guided discrepancy scan', () => {
  it('re-derives only the blocks the known transfers do not explain', async () => {
    const { discrepancyScan } = await import('../../src/chains/evm/guided.ts');
    // Chain: +10 at block 100 (known), +5 at block 700 (unknown to the explorer).
    const stateAt = (b: number): ChainState => ({ nonce: 0n, balance: (b >= 100 ? 10n : 0n) + (b >= 700 ? 5n : 0n), tokens: [0n, 0n] });
    const known: RawTransfer[] = [
      {
        txid: '0x' + '01'.repeat(32),
        subId: 'native',
        assetKey: 'ethereum:native',
        direction: 'in',
        amount: 10n,
        fee: null,
        chargeFee: false,
        counterparty: null,
        blockHeight: 100,
        blockTime: 1,
        status: 'confirmed',
      },
    ];
    const analyzed: number[] = [];
    let probes = 0;
    const res = await discrepancyScan({
      network: 'ethereum',
      lo: 0,
      hi: 1_000_000,
      loState: stateAt(0),
      hiState: stateAt(1_000_000),
      known,
      sentBlocks: [],
      probe: async (b) => {
        probes++;
        return stateAt(b);
      },
      analyze: async (b, before, after) => {
        analyzed.push(b);
        return [{ ...known[0]!, txid: `block:${b}:internal`, amount: after.balance - before.balance, blockHeight: b }];
      },
      pivot: 100,
    });
    expect(analyzed).toEqual([700]);
    expect(res.transfers.map((t) => [t.blockHeight, t.amount])).toEqual([
      [100, 10n],
      [700, 5n],
    ]);
    expect(probes).toBeLessThan(25);
  });
});
