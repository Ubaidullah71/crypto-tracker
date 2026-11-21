import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RawTransfer } from '../../src/core/types.ts';
import { HttpError } from '../../src/util/http.ts';
import {
  ESPLORA_GAP_PAGES_PER_POLL,
  GAP_PAGES_PER_POLL,
  GAP_PAGE_SIZE,
  REORG_MARGIN,
  REORG_WATCH_DEPTH,
  createUtxoAdapter,
  mergeGap,
  pollNeedsFetch,
  readCursor,
} from '../../src/chains/utxo/adapter.ts';
import { ESPLORA_CHAIN_PAGE, POLL_MAX_PAGES, POLL_PAGE_SIZE, redactKeys } from '../../src/chains/utxo/backends.ts';
import { resolveTxStatus, type TxStatusSource } from '../../src/chains/utxo/status.ts';

/*
 * Network access is replaced by a router for the adapter-level tests below (the pure tests never
 * touch it). Everything else in util/http (HttpError, EndpointPool) is the real implementation.
 */
const net = vi.hoisted(() => ({
  route: (url: string): unknown => {
    throw new Error(`unexpected request ${url}`);
  },
  log: [] as string[],
}));
vi.mock('../../src/util/http.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/util/http.ts')>();
  return {
    ...orig,
    httpJson: async (url: string) => {
      net.log.push(url);
      return net.route(url);
    },
  };
});
import { coinPerKbToSatPerVb, parseEsploraFeeEstimates, secondsForFeeRate } from '../../src/chains/utxo/fees.ts';
import {
  MalformedDataError,
  addressMatcher,
  blockbookTxLookup,
  esploraTxLookup,
  fingerprint,
  parseBlockbookSummary,
  parseBlockbookTx,
  parseEsploraSummary,
  parseEsploraTx,
  parseSats,
  parseSignedSats,
  parseTxList,
  rawTxSizes,
  type TxParser,
} from '../../src/chains/utxo/parse.ts';
import { FRESH_MAX_LAG, assessProviders, providerGroups, type ProviderView } from '../../src/chains/utxo/providers.ts';
import { balanceDelta, computeTransfer } from '../../src/chains/utxo/transfers.ts';
import type { NormTx, TxLookup } from '../../src/chains/utxo/types.ts';

/* All fixtures are real Blockbook / Esplora responses captured from the public endpoints. */
function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/utxo/${name}`, import.meta.url), 'utf8')) as T;
}

const BTC = { assetKey: 'bitcoin:native' };
const LTC = { assetKey: 'litecoin:native' };

function transfer(raw: unknown, address: string, parser: TxParser, ctx = BTC): RawTransfer {
  const t = computeTransfer(parser(raw, addressMatcher(address)), ctx);
  if (!t) throw new Error('expected a transfer');
  return t;
}
const bb = (raw: unknown, address: string, ctx = BTC) => transfer(raw, address, parseBlockbookTx, ctx);
const es = (raw: unknown, address: string, ctx = BTC) => transfer(raw, address, parseEsploraTx, ctx);

/** Fields that must not depend on the backend (meta may differ: e.g. txslight has no sequences). */
function core(t: RawTransfer) {
  const { meta: _meta, ...rest } = t;
  return rest;
}

/** The ledger effect must equal the tracked address's own outputs minus own inputs. */
function expectReconciles(tx: NormTx, t: RawTransfer | null): void {
  const ourIn = tx.vin.filter((i) => i.own).reduce((s, i) => s + (i.value as bigint), 0n);
  const ourOut = tx.vout.filter((o) => o.own).reduce((s, o) => s + (o.value as bigint), 0n);
  expect(t ? balanceDelta(t) : 0n).toBe(ourOut - ourIn);
}

describe('incoming', () => {
  const addr = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const bbRaw = fixture('btc-blockbook-address-txslight-in.json').transactions[0];
  const esRaw = fixture('btc-esplora-tx-in.json');

  it('Blockbook txslight', () => {
    const t = bb(bbRaw, addr);
    expect(t).toMatchObject({
      txid: 'd6b7d494f225f568e717e8ebb7e7b4c86700091c5784c97a3bcc2805fa9a3829',
      subId: 'native',
      assetKey: 'bitcoin:native',
      direction: 'in',
      amount: 1796n,
      fee: 211n,
      chargeFee: false,
      counterparty: 'bc1q4j4f5jrewvy7mvu9n3p683k4xhreqgw902ed6rfdgyahcu40453q6fpjgk',
      counterparties: ['bc1q4j4f5jrewvy7mvu9n3p683k4xhreqgw902ed6rfdgyahcu40453q6fpjgk'],
      blockHeight: 976090,
      blockTime: 1794812322,
      status: 'confirmed',
    });
    expect(t.meta).toEqual({ vsize: 215, feeRate: 0.98 });
  });

  it('Esplora gives the same transfer (plus rbf from sequences)', () => {
    const t = es(esRaw, addr);
    expect(core(t)).toEqual(core(bb(bbRaw, addr)));
    expect(t.meta).toEqual({ vsize: 215, feeRate: 0.98, rbf: true });
  });

  it('is seen as outgoing from the sender side', () => {
    const t = es(esRaw, 'bc1q4j4f5jrewvy7mvu9n3p683k4xhreqgw902ed6rfdgyahcu40453q6fpjgk');
    expect(t).toMatchObject({ direction: 'out', amount: 1796n, fee: 211n, chargeFee: true });
    expect(t.counterparties).toEqual(['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq']); // OP_RETURN output excluded
  });
});

describe('outgoing with change', () => {
  const sender = 'bc1q2399cffnyjle2ct4l4849ussajlf2kyyk67jsu';
  const recipient = 'bc1qxfnuu7ezgrxst62tx9hdjygcfyyw00csdgfccc';
  const mempoolRaw = fixture('btc-blockbook-tx-out-change-mempool.json');
  const confirmedRaw = fixture('btc-blockbook-tx-out-change.json');
  const esRaw = fixture('btc-esplora-tx-out-change.json');

  it('confirmed on both backends', () => {
    const expected = {
      direction: 'out',
      amount: 16300n,
      fee: 338n,
      chargeFee: true,
      counterparty: recipient,
      counterparties: [recipient],
      blockHeight: 976713,
      blockTime: 1795165488,
      status: 'confirmed',
    };
    const a = bb(confirmedRaw, sender);
    const b = es(esRaw, sender);
    expect(a).toMatchObject(expected);
    expect(core(b)).toEqual(core(a));
    expect(a.meta).toEqual({ vsize: 141, feeRate: 2.4, rbf: false });
    expect(b.meta).toEqual(a.meta);
  });

  it('pending snapshot from the mempool (Blockbook /tx without isOwn flags)', () => {
    const t = bb(mempoolRaw, sender);
    expect(t).toMatchObject({
      direction: 'out',
      amount: 16300n,
      fee: 338n,
      chargeFee: true,
      status: 'pending',
      blockHeight: null,
      blockTime: null,
    });
    expect(t.meta).toEqual({ vsize: 141, feeRate: 2.4, rbf: false, firstSeen: 1795165367 });
  });

  it('recipient side', () => {
    const t = bb(confirmedRaw, recipient);
    expect(t).toMatchObject({ direction: 'in', amount: 16300n, fee: 338n, chargeFee: false, counterparty: sender });
  });
});

describe('self / consolidation', () => {
  it('BTC self-send with OP_RETURN (Blockbook and Esplora)', () => {
    const addr = '17Fv7httdZvqMubbvMkQ9KLPiTSPobxAqF';
    const a = bb(fixture('btc-blockbook-tx-self.json'), addr);
    const b = es(fixture('btc-esplora-tx-self.json'), addr);
    expect(a).toMatchObject({ direction: 'self', amount: 0n, fee: 40n, chargeFee: true, counterparty: null, counterparties: [] });
    expect(a.meta).toMatchObject({ feeOnly: true, vsize: 284, feeRate: 0.14 });
    expect(core(b)).toEqual(core(a));
  });

  it('LTC 5-input consolidation; vsize computed from hex (old Blockbook has no vsize)', () => {
    const raw = fixture('ltc-blockbook-tx-consolidation.json');
    const t = bb(raw, 'LdEpCY222hxfVjsNvVLKPXJG77fiD5LRzn', LTC);
    expect(t).toMatchObject({
      assetKey: 'litecoin:native',
      direction: 'self',
      amount: 0n,
      fee: 10000n,
      chargeFee: true,
      blockHeight: 3216230,
    });
    expect(t.meta).toMatchObject({ feeOnly: true, vsize: 782, feeRate: 12.79, rbf: true }); // nSequence 0x80000000
  });
});

describe('mixed inputs (tracked address is one of several input owners)', () => {
  const addr = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  it('reports the net movement without charging the fee', () => {
    const a = bb(fixture('btc-blockbook-txslight-mixed-inputs.json'), addr);
    const b = es(fixture('btc-esplora-tx-mixed-inputs.json'), addr);
    expect(a).toMatchObject({
      direction: 'out',
      amount: 14293n,
      fee: 35066n,
      chargeFee: false,
      counterparty: '17tqfbMfpEdycyor5yJN2xCGtUtGs7MtrS',
    });
    expect(a.counterparties).toHaveLength(6); // recipient + the five other input owners
    expect(a.meta).toMatchObject({ mixedInputs: true });
    expect(core(b)).toEqual(core(a));
  });
});

describe('mempool and RBF', () => {
  it('pending incoming on both backends', () => {
    const addr = 'bc1qx77equjgjskt0dm66yg2em2un8luv5ray8d9xe';
    const a = bb(fixture('btc-blockbook-address-txs-mempool-in.json').transactions[0], addr);
    const b = es(fixture('btc-esplora-address-txs-mempool-in.json')[0], addr);
    expect(a).toMatchObject({ direction: 'in', amount: 71719n, fee: 110n, status: 'pending', blockHeight: null, blockTime: null });
    expect(a.meta).toEqual({ vsize: 110, feeRate: 1, rbf: false, firstSeen: 1795165423 });
    expect(core(b)).toEqual(core(a));
    expect(b.meta).toEqual({ vsize: 110, feeRate: 1, rbf: false });
  });

  it('RBF signalling self-send (Blockbook rbf flag and Esplora sequence)', () => {
    const addr = 'bc1qavwefl5azjwjggg86hlum4lccs586p7tcdvrer';
    const a = bb(fixture('btc-blockbook-tx-rbf.json'), addr);
    const b = es(fixture('btc-esplora-tx-rbf.json'), addr);
    expect(a).toMatchObject({ direction: 'self', amount: 0n, fee: 15n, chargeFee: true, status: 'pending' });
    expect(a.meta).toMatchObject({ rbf: true, vsize: 125, feeRate: 0.12, feeOnly: true });
    expect(b.meta).toMatchObject({ rbf: true, vsize: 125, feeRate: 0.12 });
  });
});

describe('litecoin address page (details=txs vs txslight)', () => {
  const addr = 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9';
  const full = fixture('ltc-blockbook-address-txs.json').transactions;
  const light = fixture('ltc-blockbook-address-txslight.json').transactions;

  it('outgoing without change and incoming', () => {
    const out = bb(full[0], addr, LTC);
    expect(out).toMatchObject({
      direction: 'out',
      amount: 4295813n,
      fee: 6780n,
      chargeFee: true,
      counterparty: 'LUZ2LCTPZgKhrCwptrE6dGLbHPBN7dgmSo',
    });
    expect(out.meta).toEqual({ vsize: 192, feeRate: 35.31, rbf: false });
    const inc = bb(full[1], addr, LTC);
    expect(inc).toMatchObject({
      direction: 'in',
      amount: 23201856n,
      fee: 1130n,
      chargeFee: false,
      counterparty: 'Lc44RhRZqEU1m7yHybUfDBho71NZTemwYx',
    });
    expect(inc.counterparties).toEqual(['Lc44RhRZqEU1m7yHybUfDBho71NZTemwYx']);
  });

  it('txslight gives the same core transfers (no sequences / size data)', () => {
    for (let i = 0; i < 2; i++) {
      const a = bb(full[i], addr, LTC);
      const b = bb(light[i], addr, LTC);
      expect(core(b)).toEqual(core(a));
      expect(b.meta).toEqual({});
    }
  });
});

describe('history reconciles with the reported balance', () => {
  it('LTC Blockbook txslight, full history incl. one mempool tx', () => {
    const addr = 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9';
    const page = fixture('ltc-blockbook-address-txslight-reconcile.json');
    const { txs, skipped } = parseTxList(page.transactions, parseBlockbookTx, addressMatcher(addr));
    expect(skipped).toBe(0);
    expect(txs).toHaveLength(26);
    let confirmed = 0n;
    let unconfirmed = 0n;
    for (const tx of txs) {
      const t = computeTransfer(tx, LTC);
      expectReconciles(tx, t);
      if (!t) continue;
      if (t.status === 'confirmed') confirmed += balanceDelta(t);
      else unconfirmed += balanceDelta(t);
    }
    const s = parseBlockbookSummary(page);
    expect(confirmed).toBe(s.balance);
    expect(unconfirmed).toBe(s.unconfirmedBalance);
    expect(confirmed).toBe(20737543n);
  });

  it('BTC Esplora chain history', () => {
    const addr = 'bc1q3v93q22sjrdsljxkmc4rnqnzy7ngh3gy59km5m';
    const { txs } = parseTxList(fixture('btc-esplora-address-txs-chain-reconcile.json'), parseEsploraTx, addressMatcher(addr));
    expect(txs).toHaveLength(15);
    let sum = 0n;
    for (const tx of txs) {
      const t = computeTransfer(tx, BTC);
      expectReconciles(tx, t);
      if (t) sum += balanceDelta(t);
    }
    expect(sum).toBe(parseEsploraSummary(fixture('btc-esplora-address-reconcile.json')).balance);
    expect(sum).toBe(10940n);
  });
});

describe('untrusted data', () => {
  const addr = 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9';
  const good = fixture('ltc-blockbook-address-txs.json').transactions;
  const clone = (i: number) => structuredClone(good[i]);

  it('rejects malformed transactions', () => {
    const m = addressMatcher(addr);
    const badValue = clone(0);
    badValue.vin[0].value = '12abc';
    const badTxid = clone(0);
    badTxid.txid = 'xyz';
    const noOwnValue = clone(1);
    delete noOwnValue.vout[1].value;
    const negFee = clone(0);
    negFee.fees = '-5';
    for (const raw of [badValue, badTxid, noOwnValue, negFee, null, 42, { txid: good[0].txid }]) {
      expect(() => parseBlockbookTx(raw, m)).toThrow(MalformedDataError);
    }
    expect(() => parseEsploraTx({ txid: good[0].txid, vin: [], vout: [{ value: 1.5 }] }, m)).toThrow(MalformedDataError);
  });

  it('skips bad entries without failing the batch', () => {
    const bad = clone(0);
    bad.vout[0].value = { $gt: 1 };
    const skippedIds: Array<string | null> = [];
    const res = parseTxList([bad, good[1], 'junk'], parseBlockbookTx, addressMatcher(addr), (id) => skippedIds.push(id));
    expect(res).toMatchObject({ rawCount: 3, skipped: 2 });
    expect(res.txs.map((t) => t.txid)).toEqual([good[1].txid]);
    expect(skippedIds).toEqual([good[0].txid, null]);
    expect(parseTxList(undefined, parseBlockbookTx, addressMatcher(addr)).rawCount).toBe(0);
    expect(() => parseTxList({}, parseBlockbookTx, addressMatcher(addr))).toThrow(MalformedDataError);
  });

  it('flags inconsistent amounts in the transfer computation', () => {
    const tx = parseBlockbookTx(clone(0), addressMatcher(addr));
    const inflated: NormTx = { ...tx, vout: tx.vout.map((o) => ({ ...o, value: (o.value as bigint) * 2n })) };
    expect(() => computeTransfer(inflated, LTC)).toThrow(MalformedDataError);
    expect(computeTransfer({ ...tx, vin: tx.vin.map((i) => ({ ...i, own: false })) }, LTC)).toBeNull();
  });

  it('parses satoshi values strictly', () => {
    expect(parseSats('61015640')).toBe(61015640n);
    expect(parseSats(18645620)).toBe(18645620n);
    for (const v of ['', '1.5', '-1', '1e8', ' 1', 1.5, -1, Number.MAX_SAFE_INTEGER + 1, null, '99999999999999999999']) {
      expect(parseSats(v)).toBeNull();
    }
    expect(parseSignedSats('-236876')).toBe(-236876n);
  });

  it('matches bech32 addresses case-insensitively, base58 exactly', () => {
    expect(addressMatcher('BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ')('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    expect(addressMatcher('LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9')('lnwp23wrkkfmmfgpb7wsnkuwpsgtrywyv9')).toBe(false);
  });
});

describe('raw transaction sizes', () => {
  it('segwit', () => {
    expect(rawTxSizes(fixture('btc-blockbook-tx-out-change-mempool.json').hex)).toEqual({ size: 222, weight: 561, vsize: 141 });
  });
  it('legacy', () => {
    const hex = fixture('ltc-blockbook-address-txs.json').transactions[0].hex as string;
    expect(rawTxSizes(hex)).toEqual({ size: 192, weight: 768, vsize: 192 });
  });
  it('rejects unknown serialization flags and garbage', () => {
    const hex = fixture('btc-blockbook-tx-out-change-mempool.json').hex as string;
    expect(rawTxSizes(hex.slice(0, 10) + '08' + hex.slice(12))).toBeNull(); // e.g. Litecoin MWEB flag
    expect(rawTxSizes(hex.slice(0, -2))).toBeNull();
    expect(rawTxSizes('zz'.repeat(20))).toBeNull();
    expect(rawTxSizes(undefined)).toBeNull();
  });
});

describe('summaries and fingerprint', () => {
  const s = fixture('btc-summaries-mempool-in.json');

  it('parses Blockbook and Esplora counters', () => {
    expect(parseBlockbookSummary(s.blockbookTxidsTrezor)).toEqual({
      txs: 2766,
      unconfirmedTxs: 1,
      balance: 70000n,
      unconfirmedBalance: 71719n,
    });
    expect(parseBlockbookSummary(s.blockbookBasicTrezor)).toEqual({
      txs: 2766,
      unconfirmedTxs: 1,
      balance: 70000n,
      unconfirmedBalance: null,
    });
    expect(parseEsploraSummary(s.esplora)).toEqual({ txs: 2766, unconfirmedTxs: 1, balance: 70000n, unconfirmedBalance: 71719n });
    expect(parseBlockbookSummary(fixture('ltc-blockbook-address-basic-reconcile.json')).unconfirmedBalance).toBe(-12000000n);
    expect(() => parseBlockbookSummary({ txs: 1, balance: 'x' })).toThrow(MalformedDataError);
  });

  it('is identical across backends for the same state', () => {
    expect(fingerprint(parseBlockbookSummary(s.blockbookTxidsTrezor))).toBe(fingerprint(parseEsploraSummary(s.esplora)));
    expect(fingerprint(parseBlockbookSummary(s.blockbookTxidsTrezor))).toBe('2766:1:70000:71719');
    // basic omits unconfirmedBalance on trezor's Blockbook: still deterministic, just different.
    expect(fingerprint(parseBlockbookSummary(s.blockbookBasicTrezor))).toBe('2766:1:70000:?');
  });

  it('changes when anything relevant changes', () => {
    const base = { txs: 10, unconfirmedTxs: 0, balance: 5n, unconfirmedBalance: 0n };
    const fp = fingerprint(base);
    expect(fingerprint({ ...base, unconfirmedBalance: null })).toBe(fp);
    for (const changed of [{ txs: 11 }, { unconfirmedTxs: 1 }, { balance: 6n }]) {
      expect(fingerprint({ ...base, ...changed })).not.toBe(fp);
    }
  });

  it('decides when a poll must fetch transactions', () => {
    const summary = { txs: 10, unconfirmedTxs: 0, balance: 5n, unconfirmedBalance: 0n };
    const fp = fingerprint(summary);
    const cursor = readCursor({ height: 100, fp });
    expect(pollNeedsFetch(cursor, fp, summary, 100)).toBe(false);
    expect(pollNeedsFetch(cursor, fp, summary, 101)).toBe(false); // new block, nothing to re-check
    expect(pollNeedsFetch(cursor, '11:0:5:0', summary, 100)).toBe(true);
    expect(pollNeedsFetch({ ...cursor, pending: ['a'.repeat(64)] }, fp, summary, 100)).toBe(true);
    expect(pollNeedsFetch(cursor, fp, { ...summary, unconfirmedTxs: 1 }, 100)).toBe(true);
    expect(pollNeedsFetch(readCursor({}), fp, summary, 100)).toBe(true);
    expect(pollNeedsFetch({ ...cursor, gap: { from: 10, to: 50 } }, fp, summary, 100)).toBe(true);
  });

  it('re-reads recently confirmed txs on each new block until they are deep enough (reorgs)', () => {
    const summary = { txs: 10, unconfirmedTxs: 0, balance: 5n, unconfirmedBalance: 0n };
    const fp = fingerprint(summary);
    const watched = readCursor({ height: 100, fp, watch: 99 });
    expect(pollNeedsFetch(watched, fp, summary, 100)).toBe(false); // same tip: no reorg possible since
    expect(pollNeedsFetch(watched, fp, summary, 101)).toBe(true);
    expect(pollNeedsFetch(watched, fp, summary, 99 + REORG_WATCH_DEPTH)).toBe(false); // deep enough
  });

  it('keeps the reorg margin above the allowed provider lag', () => {
    expect(REORG_MARGIN).toBeGreaterThanOrEqual(FRESH_MAX_LAG + 1);
  });

  it('merges unread windows without losing pagination progress', () => {
    const g = { from: 100, to: 200, page: 5 };
    expect(mergeGap(null, { from: 1, to: 2 })).toEqual({ from: 1, to: 2 });
    expect(mergeGap(g, { from: 150, to: 180 })).toBe(g); // inside: keeps page 5
    expect(mergeGap(g, { from: 190, to: 260 })).toEqual({ from: 100, to: 260 }); // widened: re-read from the top
  });

  it('reads persisted cursors defensively', () => {
    const tx = 'A'.repeat(64);
    expect(
      readCursor({ height: 976711, fp: '1:0:2:0', pending: [tx, 'nope', 5], gap: { from: 5, to: 9, page: 3, after: tx }, watch: 976710 }),
    ).toEqual({
      height: 976711,
      fp: '1:0:2:0',
      pending: [tx],
      gap: { from: 5, to: 9, page: 3, after: tx },
      watch: 976710,
    });
    const empty = { height: null, fp: null, pending: [], gap: null, watch: null };
    expect(readCursor({ height: -1, fp: 3, pending: 'x', gap: { from: 9, to: 5 }, watch: 'x' })).toEqual(empty);
    expect(readCursor({ gap: { from: 1, to: 2, page: 0, after: 'zz' } }).gap).toEqual({ from: 1, to: 2 });
    expect(readCursor(undefined)).toEqual(empty);
  });

  it('shortens keys echoed in provider error bodies', () => {
    expect(redactKeys('{"error":"Invalid address bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"}')).toBe(
      '{"error":"Invalid address bc1qar0s...5mdq"}',
    );
  });
});

describe('tx status responses', () => {
  const id = '886e5039652f0da084656777e4ba8e384e2f03cff63adce442070c572801ab3d';
  it('Blockbook', () => {
    expect(blockbookTxLookup(fixture('btc-blockbook-tx-out-change-mempool.json'), id)).toEqual({
      found: true,
      confirmed: false,
      blockHeight: null,
      blockTime: null,
    });
    expect(blockbookTxLookup(fixture('btc-blockbook-tx-out-change.json'), id.toUpperCase())).toEqual({
      found: true,
      confirmed: true,
      blockHeight: 976713,
      blockTime: 1795165488,
    });
    expect(() => blockbookTxLookup(fixture('btc-blockbook-tx-self.json'), id)).toThrow(MalformedDataError);
  });
  it('Esplora', () => {
    expect(esploraTxLookup(fixture('btc-esplora-tx-out-change.json'), id)).toMatchObject({
      found: true,
      confirmed: true,
      blockHeight: 976713,
    });
    expect(esploraTxLookup(fixture('btc-esplora-tx-rbf.json'), '0222ee4bbefd8314fef3f54fa5b8db28abece4aea023a022644ab025595eba27')).toEqual(
      {
        found: true,
        confirmed: false,
        blockHeight: null,
        blockTime: null,
      },
    );
  });
});

describe('fee estimates', () => {
  it('converts Blockbook coin/kB to sat/vB', () => {
    expect(coinPerKbToSatPerVb({ result: '0.00000986' })).toBe(0.986);
    expect(coinPerKbToSatPerVb({ result: '0.00001' })).toBe(1);
    expect(coinPerKbToSatPerVb({ result: '-1' })).toBeNull();
    expect(coinPerKbToSatPerVb({ result: '0' })).toBeNull();
    expect(coinPerKbToSatPerVb({ result: 5 })).toBeNull();
    expect(coinPerKbToSatPerVb(null)).toBeNull();
  });

  it('maps fee rates to confirmation times (LTC Blockbook fixture)', () => {
    const raw = fixture<Record<string, unknown>>('ltc-blockbook-estimatefee.json');
    const est = new Map(Object.entries(raw).map(([k, v]) => [Number(k), coinPerKbToSatPerVb(v) as number]));
    expect(secondsForFeeRate(est, 5, 150)).toBe(150);
    expect(secondsForFeeRate(est, 0.99, 150)).toBe(150);
    expect(secondsForFeeRate(est, 0.5, 150)).toBeNull();
  });

  it('maps fee rates to confirmation times (BTC Esplora fixture)', () => {
    const est = parseEsploraFeeEstimates(fixture('btc-esplora-fee-estimates.json'));
    expect([...est.keys()]).toEqual([1, 2, 3, 6, 12, 24, 144]);
    expect(secondsForFeeRate(est, 2, 600)).toBe(600);
    expect(secondsForFeeRate(est, 0.5, 600)).toBe(6 * 600); // below the 1-3 block estimate (1.072)
    expect(secondsForFeeRate(est, 0.112, 600)).toBe(144 * 600);
    expect(secondsForFeeRate(est, 0.1, 600)).toBeNull();
    expect(secondsForFeeRate(est, Number.NaN, 600)).toBeNull();
    expect(secondsForFeeRate(new Map(), 10, 600)).toBeNull();
  });
});

describe('provider freshness', () => {
  const now = 1_000_000_000;
  const view = (id: string, kind: 'blockbook' | 'esplora', tip: number, extra: Partial<ProviderView> = {}): ProviderView => ({
    id,
    kind,
    tip,
    nodeTip: null,
    tipAt: now - 1_000,
    mempoolSize: null,
    inSyncMempool: null,
    tipTime: null,
    ...extra,
  });

  it('rejects a provider whose last block is too old, even when it is the only one answering', () => {
    // litecoinspace.org observed frozen at 3216005 for 16 hours while the LTC Blockbook was down.
    const stuck = view('esplora:ltcspace', 'esplora', 3216005, { tipTime: now / 1000 - 966 * 60 });
    const a = assessProviders([stuck], now, null, { maxTipAgeSec: 150 * 18 });
    expect(a.usable).toEqual([]);
    expect(a.rejected[0]?.reason).toBe('stale: last block 966 min ago');
    const recent = view('esplora:ltcspace', 'esplora', 3216005, { tipTime: now / 1000 - 10 * 60 });
    expect(assessProviders([recent], now, null, { maxTipAgeSec: 150 * 18 }).usable).toHaveLength(1);
  });

  it('judges a lone provider against the remembered tip (floor)', () => {
    const lone = [view('esplora:ltcspace', 'esplora', 3216005)];
    expect(assessProviders(lone, now, null, { floor: 3216260 }).rejected[0]?.reason).toBe('stale: 255 blocks behind');
    expect(assessProviders(lone, now, null, { floor: 3216007 }).usable).toHaveLength(1);
    // A bogus floor far above every live provider is ignored instead of blocking everything.
    expect(assessProviders(lone, now, null, { floor: 99_999_999 }).usable).toHaveLength(1);
  });

  it('rejects a lagging Esplora (litecoinspace ~215 blocks behind)', () => {
    const ltc = fixture('ltc-blockbook-status.json');
    const a = assessProviders(
      [
        view('blockbook:ltc', 'blockbook', ltc.blockbook.bestHeight, { nodeTip: ltc.backend.blocks }),
        view('esplora:ltcspace', 'esplora', 3216005),
      ],
      now,
      null,
    );
    expect(a.best).toBe(ltc.blockbook.bestHeight);
    expect(a.usable.map((u) => u.id)).toEqual(['blockbook:ltc']);
    expect(a.rejected[0]?.reason).toMatch(/^stale: \d+ blocks behind$/);
  });

  it('allows up to 3 blocks of lag, ignores expired probes and implausible tips', () => {
    const a = assessProviders(
      [
        view('a', 'blockbook', 1000),
        view('b', 'blockbook', 997),
        view('c', 'esplora', 996),
        view('d', 'esplora', 1001, { tipAt: now - 10 * 60_000 }),
        view('e', 'esplora', 99_999_999),
      ],
      now,
      null,
    );
    expect(a.best).toBe(1000);
    expect(a.usable.map((u) => u.id)).toEqual(['a', 'b']);
    expect(a.rejected.map((r) => r.id).sort()).toEqual(['c', 'd', 'e']);
  });

  it('ranks Blockbooks with a tiny mempool after Esplora for mempool-sensitive calls', () => {
    const trezor = fixture('btc-blockbook-status-trezor.json').blockbook;
    const guarda = fixture('btc-blockbook-status-guarda.json').blockbook;
    const views = [
      view('blockbook:trezor', 'blockbook', trezor.bestHeight, { mempoolSize: trezor.mempoolSize, inSyncMempool: true }),
      view('blockbook:guarda', 'blockbook', guarda.bestHeight, { mempoolSize: guarda.mempoolSize, inSyncMempool: true }),
      view('esplora:blockstream', 'esplora', trezor.bestHeight),
    ];
    const a = assessProviders(views, now, trezor.mempoolSize);
    expect(a.usable.find((u) => u.id === 'blockbook:guarda')?.mempoolOk).toBe(false);
    const order = (p: 'mempool' | 'history') => providerGroups(p, a).flatMap((g) => g.members.map((m) => m.id));
    expect(order('mempool')).toEqual(['blockbook:trezor', 'esplora:blockstream', 'blockbook:guarda']);
    expect(order('history')).toEqual(['blockbook:trezor', 'blockbook:guarda', 'esplora:blockstream']);
  });
});

describe('tx status across providers', () => {
  const ID = 'ab'.repeat(32);
  const NF: TxLookup = { found: false };
  const PENDING: TxLookup = { found: true, confirmed: false, blockHeight: null, blockTime: null };
  const CONFIRMED: TxLookup = { found: true, confirmed: true, blockHeight: 900, blockTime: 1_700_000_000 };
  type Answer = TxLookup | 'error';

  /** Fake providers answering in sequence (the last answer repeats); records who was asked. */
  function fakes(spec: Array<[id: string, mempoolOk: boolean, ...answers: Answer[]]>) {
    const asked: string[] = [];
    const list: TxStatusSource[] = spec.map(([id, mempoolOk, ...answers]) => {
      let i = 0;
      return {
        id,
        mempoolOk,
        client: {
          tx: async () => {
            asked.push(id);
            const a = answers[Math.min(i++, answers.length - 1)];
            if (a === undefined || a === 'error') throw new Error('provider down');
            return a;
          },
        },
      };
    });
    return { list, asked };
  }

  it('keeps asking after two "not found": a provider with a larger mempool still has the tx', async () => {
    const { list, asked } = fakes([
      ['trezor', true, NF],
      ['blockstream', true, NF],
      ['mempool.space', true, PENDING],
      ['guarda', false, NF],
    ]);
    expect(await resolveTxStatus(list, ID, { recheckMs: 0 })).toEqual({ state: 'pending' });
    expect(asked).toEqual(['trezor', 'blockstream', 'mempool.space']);
  });

  it('is dropped only when every provider says not found', async () => {
    const { list, asked } = fakes([
      ['trezor', true, NF],
      ['blockstream', true, NF],
      ['mempool.space', true, NF],
      ['guarda', false, NF],
    ]);
    expect(await resolveTxStatus(list, ID, { recheckMs: 0 })).toEqual({ state: 'dropped' });
    expect(asked).toEqual(['trezor', 'blockstream', 'mempool.space', 'guarda']);
  });

  it('any failed answer makes it unknown', async () => {
    const { list } = fakes([
      ['trezor', true, NF],
      ['blockstream', true, 'error'],
      ['mempool.space', true, NF],
    ]);
    expect(await resolveTxStatus(list, ID, { recheckMs: 0 })).toEqual({ state: 'unknown' });
  });

  it('a "found" from an incomplete-mempool Blockbook still wins', async () => {
    const { list } = fakes([
      ['trezor', true, NF],
      ['guarda', false, CONFIRMED],
    ]);
    expect(await resolveTxStatus(list, ID, { recheckMs: 0 })).toEqual({ state: 'confirmed', blockHeight: 900, blockTime: 1_700_000_000 });
  });

  it('incomplete mempools alone cannot prove a drop', async () => {
    const { list } = fakes([
      ['guarda', false, NF],
      ['zelcore', false, NF],
    ]);
    expect(await resolveTxStatus(list, ID, { recheckMs: 0 })).toEqual({ state: 'unknown' });
  });

  it('the only complete-mempool provider must say not found twice', async () => {
    const twice = fakes([['ltc', true, NF, NF]]);
    expect(await resolveTxStatus(twice.list, ID, { recheckMs: 0 })).toEqual({ state: 'dropped' });
    expect(twice.asked).toEqual(['ltc', 'ltc']);
    expect(await resolveTxStatus(fakes([['ltc', true, NF, PENDING]]).list, ID, { recheckMs: 0 })).toEqual({ state: 'pending' });
    expect(await resolveTxStatus(fakes([['ltc', true, NF, 'error']]).list, ID, { recheckMs: 0 })).toEqual({ state: 'unknown' });
  });
});

describe('poll page caps (simulated providers)', () => {
  const BTC_TIP = 1000;
  const LTC_TIP = 2000;
  const OUR_BTC = 'bc1qxfnuu7ezgrxst62tx9hdjygcfyyw00csdgfccc';
  const OTHER_BTC = 'bc1q2399cffnyjle2ct4l4849ussajlf2kyyk67jsu';
  const OUR_LTC = 'LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9';
  const OTHER_LTC = 'LYeCuc1NXEqqzsK57iJpR2GAQKzGSZV6ie';

  /** height -1 = mempool. */
  interface Synth {
    txid: string;
    height: number;
  }

  /** n confirmed txs spread evenly over [low, high], newest first, after `mempool` unconfirmed ones. */
  function synthChain(n: number, low: number, high: number, mempool = 0): Synth[] {
    const blocks = high - low + 1;
    const out: Synth[] = [];
    for (let j = 0; j < mempool; j++) out.push({ txid: `e${j.toString(16).padStart(63, '0')}`, height: -1 });
    for (let i = 0; i < n; i++) out.push({ txid: (i + 1).toString(16).padStart(64, '0'), height: high - Math.floor((i * blocks) / n) });
    return out;
  }

  function bbTx(s: Synth, tip: number, our: string, other: string) {
    return {
      txid: s.txid,
      vin: [{ n: 0, addresses: [other], isAddress: true, value: '3000' }],
      vout: [
        { n: 0, value: '1000', addresses: [our], isAddress: true, isOwn: true },
        { n: 1, value: '1900', addresses: [other], isAddress: true },
      ],
      blockHeight: s.height,
      confirmations: s.height < 0 ? 0 : tip - s.height + 1,
      blockTime: 1_700_000_000 + Math.max(0, s.height),
      fees: '100',
      vsize: 141,
    };
  }

  function esTx(s: Synth, our: string, other: string) {
    return {
      txid: s.txid,
      vin: [{ prevout: { scriptpubkey_address: other, value: 3000 }, sequence: 0xffffffff, is_coinbase: false }],
      vout: [
        { scriptpubkey_address: our, value: 1000 },
        { scriptpubkey_address: other, value: 1900 },
      ],
      fee: 100,
      weight: 561,
      status: s.height < 0 ? { confirmed: false } : { confirmed: true, block_height: s.height, block_time: 1_700_000_000 + s.height },
    };
  }

  /** Blockbook /api/v2 and /api/v2/address semantics (from/to filters, page clamping). */
  function blockbook(u: URL, chain: Synth[], tip: number, our: string, other: string): unknown {
    if (u.pathname === '/api/v2') {
      return {
        blockbook: { bestHeight: tip, inSync: true, inSyncMempool: true, mempoolSize: 50_000, lastBlockTime: new Date().toISOString() },
        backend: { blocks: tip },
      };
    }
    const q = u.searchParams;
    const confirmed = chain.filter((s) => s.height >= 0).length;
    const mempool = chain.length - confirmed;
    const head = { balance: String(confirmed * 1000), unconfirmedBalance: String(mempool * 1000), unconfirmedTxs: mempool, txs: confirmed };
    if (q.get('details') === 'basic') return head;
    const from = Number(q.get('from') ?? 0);
    const to = q.has('to') ? Number(q.get('to')) : Infinity;
    const list = chain.filter((s) => (s.height < 0 ? !q.has('to') : s.height >= from && s.height <= to));
    const size = Number(q.get('pageSize'));
    const last = Math.max(1, Math.ceil(list.length / size));
    const page = Math.min(Number(q.get('page') ?? 1), last);
    return {
      ...head,
      page,
      totalPages: q.has('to') ? -1 : last,
      itemsOnPage: size,
      transactions: list.slice((page - 1) * size, page * size).map((s) => bbTx(s, tip, our, other)),
    };
  }

  /** Esplora: /txs = mempool + newest 25 confirmed, /txs/chain[/{last}] = 25 confirmed per page. */
  function esplora(u: URL, chain: Synth[], tip: number, our: string, other: string): unknown {
    const path = u.pathname.replace(/^\/api/, '');
    if (path === '/blocks') return [{ height: tip, timestamp: Math.floor(Date.now() / 1000) - 60 }];
    const confirmedList = chain.filter((s) => s.height >= 0);
    const mempool = chain.filter((s) => s.height < 0);
    const m = /^\/address\/[^/]+(\/txs(\/chain(\/([0-9a-f]{64}))?)?)?$/.exec(path);
    if (!m) throw new Error(`unexpected Esplora path ${path}`);
    if (!m[1]) {
      return {
        chain_stats: { funded_txo_sum: confirmedList.length * 1000, spent_txo_sum: 0, tx_count: confirmedList.length },
        mempool_stats: { funded_txo_sum: mempool.length * 1000, spent_txo_sum: 0, tx_count: mempool.length },
      };
    }
    const start = m[4] ? confirmedList.findIndex((s) => s.txid === m[4]) + 1 : 0;
    const page = confirmedList.slice(start, start + ESPLORA_CHAIN_PAGE);
    return [...(m[2] ? [] : mempool.slice(0, 50)), ...page].map((s) => esTx(s, our, other));
  }

  function router(btc: Synth[], ltc: Synth[]) {
    return (url: string): unknown => {
      const u = new URL(url);
      switch (u.host) {
        case 'btc1.trezor.io':
        case 'btcbook.guarda.co':
        case 'blockbook.btc.zelcore.io':
          return blockbook(u, btc, BTC_TIP, OUR_BTC, OTHER_BTC);
        case 'blockstream.info':
        case 'mempool.space':
          return esplora(u, btc, BTC_TIP, OUR_BTC, OTHER_BTC);
        case 'litecoinblockexplorer.net':
          // Down: Litecoin polls are served by Esplora in these tests.
          throw new HttpError(`HTTP 503 from ${u.host}`, 503, url, true);
        case 'litecoinspace.org':
          return esplora(u, ltc, LTC_TIP, OUR_LTC, OTHER_LTC);
        default:
          throw new Error(`unexpected host ${u.host}`);
      }
    };
  }

  it('Blockbook: txs beyond the live page cap are read as a gap in later polls, never skipped', async () => {
    const chain = synthChain(3000, 990 - REORG_MARGIN, BTC_TIP); // 200 txs per block since the cursor
    net.route = router(chain, []);
    const adapter = createUtxoAdapter('bitcoin');
    const seen = new Set<string>();

    const p1 = await adapter.poll(OUR_BTC, { height: 990, fp: 'stale' });
    for (const t of p1.transfers) seen.add(t.txid);
    // Live read: the newest POLL_MAX_PAGES x POLL_PAGE_SIZE (down to the middle of block 998). The
    // unread window [986, 998] includes that partly read block; 8 light pages of it follow.
    const live = chain.slice(0, POLL_MAX_PAGES * POLL_PAGE_SIZE);
    const window = chain.filter((s) => s.height >= 990 - REORG_MARGIN && s.height <= 998);
    expect(seen).toEqual(new Set([...live, ...window.slice(0, GAP_PAGES_PER_POLL * GAP_PAGE_SIZE)].map((s) => s.txid)));
    expect(p1.cursor).toMatchObject({ height: BTC_TIP, gap: { from: 990 - REORG_MARGIN, to: 998, page: GAP_PAGES_PER_POLL + 1 } });

    const p2 = await adapter.poll(OUR_BTC, p1.cursor);
    for (const t of p2.transfers) seen.add(t.txid);
    expect(p2.cursor.gap).toBeUndefined();
    expect(seen).toEqual(new Set(chain.map((s) => s.txid)));

    // Caught up and idle: only the cheap summary is requested.
    net.log.length = 0;
    const p3 = await adapter.poll(OUR_BTC, p2.cursor);
    expect(p3.transfers).toEqual([]);
    expect(net.log.some((u) => /details=(txs|txslight)/.test(u))).toBe(false);
  });

  it('Esplora: the walk continues from the last txid read, mempool txs stay pending', async () => {
    const chain = synthChain(1200, 1990 - REORG_MARGIN, LTC_TIP, 2);
    net.route = router([], chain);
    const adapter = createUtxoAdapter('litecoin');
    const seen = new Set<string>();

    const p1 = await adapter.poll(OUR_LTC, { height: 1990, fp: 'stale' });
    for (const t of p1.transfers) seen.add(t.txid);
    expect(p1.cursor.pending).toHaveLength(2);
    expect(p1.transfers.filter((t) => t.status === 'pending')).toHaveLength(2);
    const liveRead = (POLL_MAX_PAGES + 1) * ESPLORA_CHAIN_PAGE; // /txs + chain pages
    expect(seen.size).toBe(2 + liveRead + ESPLORA_GAP_PAGES_PER_POLL * ESPLORA_CHAIN_PAGE);
    expect(p1.cursor.gap).toMatchObject({ from: 1990 - REORG_MARGIN, after: expect.stringMatching(/^[0-9a-f]{64}$/) });

    let cursor = p1.cursor;
    for (let i = 0; i < 5 && cursor.gap; i++) {
      const p = await adapter.poll(OUR_LTC, cursor);
      for (const t of p.transfers) seen.add(t.txid);
      cursor = p.cursor;
    }
    expect(cursor.gap).toBeUndefined();
    expect(seen).toEqual(new Set(chain.map((s) => s.txid)));
  });
});
