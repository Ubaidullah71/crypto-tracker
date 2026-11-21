import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createXrpAdapter } from '../../src/chains/xrp/adapter.ts';
import {
  RIPPLE_EPOCH_OFFSET,
  decodeMemos,
  isClassicAddress,
  normalizeTx,
  parseAccountTxEntries,
  parseTxStatus,
  xrpBalanceDelta,
  type Json,
} from '../../src/chains/xrp/parse.ts';
import { XRPL_API_VERSION, type XrplTransport } from '../../src/chains/xrp/rpc.ts';
import type { RawTransfer } from '../../src/core/types.ts';
import { HttpError } from '../../src/util/http.ts';

// --- Fixtures (real account_tx responses, see _source in each file) ---

interface Fixture {
  _account: string;
  result: Json & { transactions: Json[] };
}

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../fixtures/xrp/${name}.json`, import.meta.url), 'utf8')) as Fixture;
}

function entries(name: string): Json[] {
  return fixture(name).result.transactions;
}

/** Parses a fixture for `address` (default: the account it was fetched for) and expects at most one row. */
function parseOne(name: string, address?: string): RawTransfer | null {
  const f = fixture(name);
  const rows = parseAccountTxEntries(f.result.transactions, address ?? f._account);
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

/** Signed effect of a row on the account balance, as the ledger applies it. */
function signed(t: RawTransfer): bigint {
  const v = t.direction === 'in' ? t.amount : t.direction === 'out' ? -t.amount : 0n;
  return v - (t.chargeFee ? (t.fee ?? 0n) : 0n);
}

describe('XRP parsing: payments', () => {
  it('payment received with destination and source tags (API v2)', () => {
    const t = parseOne('payment-received-tags');
    expect(t).toMatchObject({
      txid: '38BCE16A8402126C0080FA475A5DF12734C584C5D26427CBB57F29F4DF602605',
      subId: 'native',
      assetKey: 'xrp:native',
      direction: 'in',
      amount: 31_662_626n,
      fee: 10_068n,
      chargeFee: false,
      counterparty: 'rHYVFond7rjFknLvK3gAkKYxC67KZTEqFY',
      counterparties: ['rHYVFond7rjFknLvK3gAkKYxC67KZTEqFY'],
      blockHeight: 108_450_596,
      blockTime: Date.parse('2026-11-20T08:59:21Z') / 1000,
      status: 'confirmed',
    });
    expect(t?.meta).toMatchObject({ destinationTag: 89_108_507, sourceTag: 1_741_383_633, txType: 'Payment', feeRate: 10_068 });
    expect(t?.meta?.feeOnly).toBeUndefined();
  });

  it('the same payment from the sender side: amount excludes the fee, fee charged', () => {
    const t = parseOne('payment-received-tags', 'rHYVFond7rjFknLvK3gAkKYxC67KZTEqFY');
    expect(t).toMatchObject({
      direction: 'out',
      amount: 31_662_626n,
      fee: 10_068n,
      chargeFee: true,
      counterparty: 'rnqZnvzoJjdg7n1P9pmumJ7FQ5wxNH3gYC',
    });
    // 32672694 -> 1000000 drops
    expect(signed(t!)).toBe(1_000_000n - 32_672_694n);
  });

  it('payment sent (API v1 shape from rippled) with memo and tags', () => {
    const t = parseOne('payment-sent-v1');
    expect(t).toMatchObject({
      txid: '902C4D2831A6EA93F5216FB1EBA221FE2B84E84357A7ED02D2370443AB3D6E94',
      direction: 'out',
      amount: 15_971n,
      fee: 5_106n,
      chargeFee: true,
      counterparty: 'rUNEer3ptfFXnrenuaspvoZ1KsSgvnCpj5',
      blockHeight: 108_450_593,
      blockTime: 848_480_350 + RIPPLE_EPOCH_OFFSET,
      status: 'confirmed',
    });
    expect(t?.meta).toMatchObject({ destinationTag: 230, sourceTag: 13_888_813, memo: 'Zerpmon Mission Reward' });
    // Receiver of the same tx (v1 entry parsed for another address)
    const r = parseOne('payment-sent-v1', 'rUNEer3ptfFXnrenuaspvoZ1KsSgvnCpj5');
    expect(r).toMatchObject({ direction: 'in', amount: 15_971n, chargeFee: false, counterparty: 'rExK8TgtWigYb1vx9uZTrZrPht7pdQzoQm' });
  });

  it('payment that creates the destination account (CreatedNode)', () => {
    expect(parseOne('account-create')).toMatchObject({
      direction: 'in',
      amount: 1_148_277n,
      chargeFee: false,
      counterparty: 'rh3xv8DWPBaU8k8jGjx8KW1xLKpwpwLwdR',
    });
    const sender = parseOne('account-create', 'rh3xv8DWPBaU8k8jGjx8KW1xLKpwpwLwdR');
    expect(sender).toMatchObject({ direction: 'out', amount: 1_148_277n, fee: 10n, chargeFee: true });
  });

  it('IOU payment: no XRP row for the receiver, fee-only row for the sender', () => {
    expect(parseOne('iou-payment')).toBeNull();
    const s = parseOne('iou-payment', 'rXPMusrUYj1t1DM2m3n6y1jjdTv3X81ZQ');
    expect(s).toMatchObject({
      direction: 'out',
      amount: 0n,
      fee: 12n,
      chargeFee: true,
      counterparty: 'r46CTwHN6F2wY6GRWtyVVyJ1WjziFnssPd',
      status: 'confirmed',
    });
    expect(s?.meta?.feeOnly).toBe(true);
  });

  it('partial payment: uses the balance delta, never DeliverMax (real XRP->XRP partial payment, Fee 0 batch inner)', () => {
    const t = parseOne('partial-payment-self');
    // DeliverMax is 29986 drops but the account only gained 14992 (= delivered_amount).
    expect(t).toMatchObject({ direction: 'in', amount: 14_992n, fee: 0n, chargeFee: false, counterparty: null });
    expect(t?.meta?.partialPayment).toBe(true);
  });

  it('partial-payment exploit: a huge Amount with tfPartialPayment cannot inflate the received amount', () => {
    const e = structuredClone(entries('payment-received-tags')[0]!);
    const tx = e.tx_json as Json;
    tx.Flags = 0x0002_0000;
    tx.DeliverMax = '100000000000000000'; // "100 billion XRP"
    tx.Amount = '100000000000000000';
    const [t] = parseAccountTxEntries([e], 'rnqZnvzoJjdg7n1P9pmumJ7FQ5wxNH3gYC');
    expect(t?.amount).toBe(31_662_626n);
    expect(t?.meta?.partialPayment).toBe(true);
  });
});

describe('XRP parsing: fee-only, offers, failures', () => {
  it('TrustSet we sent: fee-only row (amount 0, out, chargeFee)', () => {
    const t = parseOne('trustset-fee-only');
    expect(t).toMatchObject({ direction: 'out', amount: 0n, fee: 12n, chargeFee: true, counterparty: null, status: 'confirmed' });
    expect(t?.meta).toMatchObject({ feeOnly: true, txType: 'TrustSet', feeRate: 12 });
  });

  it('crossed offer, taker receives XRP: in, fee charged separately', () => {
    const t = parseOne('offer-crossed-taker');
    // 1039871102 -> 1065946620 = +26075518, plus the 12 drop fee we paid = +26075530 received
    expect(t).toMatchObject({ direction: 'in', amount: 26_075_530n, fee: 12n, chargeFee: true, counterparty: null });
    expect(signed(t!)).toBe(1_065_946_620n - 1_039_871_102n);
  });

  it("crossed offer, maker side (someone else's tx consumed our offer; API v1)", () => {
    const t = parseOne('offer-crossed-maker-v1');
    expect(t).toMatchObject({ direction: 'out', amount: 26_075_530n, chargeFee: false, counterparty: null });
    expect(t?.counterparties).toEqual(['rwr8aKSd942vZJv8csg1sKdYs33Zco42CD']);
  });

  it('crossed offer, taker spends XRP', () => {
    const t = parseOne('offer-sell-xrp-taker');
    expect(t).toMatchObject({ direction: 'out', amount: 98_920n, fee: 12n, chargeFee: true });
    expect(signed(t!)).toBe(221_141_570n - 221_240_502n);
  });

  it('tec failure: only the fee moves, status failed', () => {
    const t = parseOne('tec-unfunded-payment');
    expect(t).toMatchObject({ direction: 'out', amount: 0n, fee: 11n, chargeFee: true, status: 'failed' });
    expect(t?.meta).toMatchObject({ feeOnly: true, result: 'tecUNFUNDED_PAYMENT' });
    // The destination of a failed payment gets nothing.
    expect(parseOne('tec-unfunded-payment', 'rLQFZ2FFMjHoxSDWbbJneWneTVMNXjFLas')).toBeNull();
    expect(parseOne('tec-killed-offer')).toMatchObject({ amount: 0n, fee: 10n, chargeFee: true, status: 'failed' });
  });

  it('2013 tec TrustSet (API v1, early history): ripple epoch conversion', () => {
    const t = parseOne('genesis-2013-tec-v1');
    expect(t).toMatchObject({ status: 'failed', amount: 0n, fee: 10n, chargeFee: true, blockHeight: 60_104 });
    expect(t?.blockTime).toBe(Date.parse('2013-01-07T21:09:50Z') / 1000);
  });

  it('Delegate pays the fee: no phantom row for Account, fee-only row for the delegate', () => {
    expect(parseOne('delegate-offer')).toBeNull();
    const d = parseOne('delegate-offer', 'rf3Xo1DxCCMCwtLcqd887qBvRagQoacgUe');
    expect(d).toMatchObject({ direction: 'out', amount: 0n, fee: 12n, chargeFee: true });
    expect(d?.meta?.delegate).toBe('rf3Xo1DxCCMCwtLcqd887qBvRagQoacgUe');
  });

  it('AccountDelete: DeletedNode for the sender, XRP to the destination', () => {
    const s = parseOne('account-delete');
    expect(s).toMatchObject({
      direction: 'out',
      amount: 850_326n,
      fee: 200_000n,
      chargeFee: true,
      counterparty: 'raV5bXp9hNe5G4YFxLDSGHExL3bVyYmwZ9',
    });
    expect(signed(s!)).toBe(-1_050_326n); // whole balance gone
    expect(s?.meta?.destinationTag).toBe(1_120_368_642);
    const d = parseOne('account-delete', 'raV5bXp9hNe5G4YFxLDSGHExL3bVyYmwZ9');
    expect(d).toMatchObject({ direction: 'in', amount: 850_326n, chargeFee: false, counterparty: 'rLNkttBqhomaaGxpoy3tBMYM2mUV2Q1xGR' });
  });

  it('Batch: outer pays the fee; an inner "IOU" payment (Fee 0) that auto-bridged through our XRP', () => {
    const rows = parseAccountTxEntries(entries('batch'), 'rGk99J8mmxA2bmgmLNg1vXrCF5VqbRzqd1');
    expect(rows).toHaveLength(2);
    const [outer, inner] = rows;
    expect(outer).toMatchObject({ txid: expect.stringMatching(/^B0E0591E/), amount: 0n, fee: 40n, chargeFee: true });
    // 133965105 -> 133914016 although the payment is denominated in an IOU
    expect(inner).toMatchObject({ txid: expect.stringMatching(/^BFA739FA/), direction: 'out', amount: 51_089n, fee: 0n, chargeFee: false });
  });

  it('AccountRoot ModifiedNode without FinalFields does not break parsing', () => {
    const t = parseOne('modified-no-finalfields');
    expect(t).toMatchObject({ direction: 'out', amount: 151_167_742n - 1_839_022n, fee: 0n, chargeFee: false });
  });

  it('every fixture reconciles: rows equal the AccountRoot balance change for every account touched', () => {
    const names = [
      'payment-received-tags',
      'payment-sent-v1',
      'account-create',
      'account-delete',
      'iou-payment',
      'partial-payment-self',
      'trustset-fee-only',
      'offer-crossed-taker',
      'offer-crossed-maker-v1',
      'offer-sell-xrp-taker',
      'tec-unfunded-payment',
      'tec-killed-offer',
      'genesis-2013-tec-v1',
      'delegate-offer',
      'batch',
      'modified-no-finalfields',
    ];
    for (const name of names) {
      for (const e of entries(name)) {
        const t = normalizeTx(e);
        const accounts = new Set<string>();
        for (const n of t.meta.AffectedNodes as Json[]) {
          for (const node of Object.values(n) as Json[]) {
            const f = (node.FinalFields ?? node.NewFields) as Json | undefined;
            if (node.LedgerEntryType === 'AccountRoot' && typeof f?.Account === 'string') accounts.add(f.Account);
          }
        }
        for (const a of accounts) {
          const rows = parseAccountTxEntries([e], a);
          const total = rows.reduce((s, r) => s + signed(r), 0n);
          expect(total, `${name} ${a}`).toBe(xrpBalanceDelta(t.meta, a).delta);
        }
      }
    }
  });
});

describe('XRP parsing: untrusted data', () => {
  const good = () => structuredClone(entries('payment-received-tags')[0]!);
  const addr = 'rnqZnvzoJjdg7n1P9pmumJ7FQ5wxNH3gYC';

  it('skips malformed and unvalidated entries without throwing', () => {
    const badBalance = good();
    (((badBalance.meta as Json).AffectedNodes as Json[])[0]!.ModifiedNode as Json).FinalFields = { Account: addr, Balance: '12.5' };
    const noFee = good();
    delete (noFee.tx_json as Json).Fee;
    const badHash = good();
    badHash.hash = 'zz';
    const unvalidated = good();
    unvalidated.validated = false;
    const tem = good();
    (tem.meta as Json).TransactionResult = 'temMALFORMED';
    const rows = parseAccountTxEntries([null, 'x', 42, badBalance, noFee, badHash, unvalidated, tem, { meta: 'BINARY' }, good()], addr);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(31_662_626n);
  });

  it('rejects absurd numbers and out-of-range tags', () => {
    const e = good();
    (e.tx_json as Json).DestinationTag = 2 ** 33;
    (e.tx_json as Json).Fee = '-5';
    expect(parseAccountTxEntries([e], addr)).toEqual([]);
    const e2 = good();
    (e2.tx_json as Json).DestinationTag = 2 ** 33;
    expect(parseAccountTxEntries([e2], addr)[0]?.meta?.destinationTag).toBeUndefined();
  });

  it('isClassicAddress accepts only base58check classic r-addresses', () => {
    for (const a of [addr, 'rHYVFond7rjFknLvK3gAkKYxC67KZTEqFY', 'rLNkttBqhomaaGxpoy3tBMYM2mUV2Q1xGR', 'rrrrrrrrrrrrrrrrrrrrBZbvji']) {
      expect(isClassicAddress(a), a).toBe(true);
    }
    const bad = [
      'rHYVFond7rjFknLvK3gAkKYxC67KZTEqFZ', // checksum broken (last char changed)
      'XV5sbjUmgPpvXv4ixFWZ5ptAYZ6PD28Sq49uo34VyjnmK5H', // X-address
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      'r' + '1'.repeat(40),
      '@everyone',
      'rHYVFond7rjFknLvK3gAkKYxC67KZTEqFY ',
      '',
      42,
      null,
    ];
    for (const a of bad) expect(isClassicAddress(a), String(a)).toBe(false);
  });

  it('never reports a malformed counterparty address (the balance movement is still kept)', () => {
    // Received payment whose sender field is junk / has a broken checksum.
    for (const junk of ['rHYVFond7rjFknLvK3gAkKYxC67KZTEqFZ', '<@&123> click here', 'x'.repeat(120)]) {
      const e = good();
      (e.tx_json as Json).Account = junk;
      const [t] = parseAccountTxEntries([e], addr);
      expect(t).toMatchObject({ direction: 'in', amount: 31_662_626n, counterparty: null, chargeFee: false });
      expect(t?.counterparties).toBeUndefined();
    }
    // Sent payment whose Destination is invalid: counterparty null, fee still charged.
    const sent = structuredClone(entries('payment-sent-v1')[0]!);
    (sent.tx as Json).Destination = 'rUNEer3ptfFXnrenuaspvoZ1KsSgvnCpj6';
    const [s] = parseAccountTxEntries([sent], 'rExK8TgtWigYb1vx9uZTrZrPht7pdQzoQm');
    expect(s).toMatchObject({ direction: 'out', amount: 15_971n, chargeFee: true, counterparty: null });
    expect(s?.counterparties).toBeUndefined();
    // Invalid Delegate: not reported, and it cannot make the Account look like the fee payer.
    const del = structuredClone(entries('delegate-offer')[0]!);
    (del.tx_json as Json).Delegate = 'not-an-address';
    const [d] = parseAccountTxEntries([del], 'rEkWpCeherNQv9CDkYw6ZicYHuJuAgLRbt');
    expect(d).toBeUndefined();
    const [payer] = parseAccountTxEntries([del], 'rf3Xo1DxCCMCwtLcqd887qBvRagQoacgUe');
    expect(payer?.meta?.delegate).toBeUndefined();
    expect(payer?.counterparties).toEqual(['rEkWpCeherNQv9CDkYw6ZicYHuJuAgLRbt']);
  });

  it('memo decoding strips control and bidi characters and ignores binary', () => {
    const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
    expect(decodeMemos({ Memos: [{ Memo: { MemoData: hex('hi\u202e\u0000there\n') } }] })).toBe('hi there');
    expect(decodeMemos({ Memos: [{ Memo: { MemoData: 'FFFE' } }] })).toBeUndefined();
    expect(decodeMemos({ Memos: 'nope' })).toBeUndefined();
  });

  it('parseTxStatus maps validated results and pending', () => {
    const ok = entries('payment-received-tags')[0]!;
    expect(parseTxStatus(ok, ok.hash as string)).toEqual({
      state: 'confirmed',
      blockHeight: 108_450_596,
      blockTime: Date.parse('2026-11-20T08:59:21Z') / 1000,
    });
    const tec = entries('tec-unfunded-payment')[0]!;
    expect(parseTxStatus(tec, tec.hash as string).state).toBe('failed');
    const v1 = entries('genesis-2013-tec-v1')[0]!;
    // v1 `tx` method results are flat: fields + meta + validated at top level
    const flat = { ...(v1.tx as Json), meta: v1.meta, validated: true };
    expect(parseTxStatus(flat, 'F1FA613B39A3F67C3D85FB86889BAFC1915116E600F2070D42709E2CD99F3A7A')).toMatchObject({
      state: 'failed',
      blockHeight: 60_104,
    });
    expect(parseTxStatus({ ...ok, validated: false }, ok.hash as string).state).toBe('pending');
    expect(parseTxStatus(ok, '0'.repeat(64)).state).toBe('unknown');
  });
});

// --- Adapter logic against fake rippled / clio servers ---

const ADDR = 'rEjjKetQ168doKmb6q3B1rNUHAAxrwcE2c';
const SENDER = 'rHYVFond7rjFknLvK3gAkKYxC67KZTEqFY';

interface Pos {
  ledger: number;
  seq: number;
}

function payEntry(n: number, ledger: number, seq: number): Json {
  return {
    hash: n.toString(16).toUpperCase().padStart(64, '0'),
    ledger_index: ledger,
    close_time_iso: '2026-01-01T00:00:00Z',
    validated: true,
    tx_json: {
      Account: SENDER,
      Destination: ADDR,
      TransactionType: 'Payment',
      Fee: '12',
      DeliverMax: String(n),
      date: 820_000_000 + ledger,
    },
    meta: {
      TransactionIndex: seq,
      TransactionResult: 'tesSUCCESS',
      AffectedNodes: [
        {
          ModifiedNode: {
            LedgerEntryType: 'AccountRoot',
            FinalFields: { Account: ADDR, Balance: String(1_000_000 + n) },
            PreviousFields: { Balance: '1000000' },
          },
        },
      ],
    },
  };
}

/** n transactions spread over ledgers starting at `firstLedger`, `perLedger` per ledger. */
function history(count: number, firstLedger: number, perLedger: number): Json[] {
  return Array.from({ length: count }, (_, i) => payEntry(i + 1, firstLedger + Math.floor(i / perLedger), i % perLedger));
}

type Style = 'rippled' | 'clio';

interface FakeServer {
  calls: Json[];
  validated: number;
  failOnCall?: number;
}

/** Implements account_tx with each server family's marker semantics (rippled: next item, clio: last returned item). */
function fakeServer(style: Style, txs: Json[], validated: number, opts: { historyStart?: number; failOnCall?: number } = {}) {
  const server: FakeServer & { handle(method: string, params: Json): unknown } = {
    calls: [],
    validated,
    ...(opts.failOnCall !== undefined ? { failOnCall: opts.failOnCall } : {}),
    handle(method, params) {
      server.calls.push({ method, ...params });
      if (server.failOnCall === server.calls.length) throw new HttpError('HTTP 503', 503, 'fake', true);
      expect(params.api_version).toBe(XRPL_API_VERSION);
      const err = (error: string) => ({ result: { status: 'error', error } });
      if (method === 'ledger') return { result: { status: 'success', validated: true, ledger_index: server.validated } };
      if (method !== 'account_tx') return err('unknownCmd');
      const historyStart = opts.historyStart ?? 32_570;
      const min = params.ledger_index_min === -1 ? historyStart : (params.ledger_index_min as number);
      const max = params.ledger_index_max === -1 ? server.validated : (params.ledger_index_max as number);
      if (min > server.validated || max > server.validated) return err(style === 'rippled' ? 'lgrNotFound' : 'lgrIdxMalformed');
      const pos = (e: Json): Pos => ({ ledger: e.ledger_index as number, seq: (e.meta as Json).TransactionIndex as number });
      const cmp = (a: Pos, b: Pos) => a.ledger - b.ledger || a.seq - b.seq;
      const list = txs.filter((e) => pos(e).ledger >= min && pos(e).ledger <= max);
      let start = 0;
      const marker = params.marker as Pos | undefined;
      if (marker) {
        start = list.findIndex((e) => (style === 'rippled' ? cmp(pos(e), marker) >= 0 : cmp(pos(e), marker) > 0));
        if (start < 0) start = list.length;
      }
      const limit = params.limit as number;
      const page = list.slice(start, start + limit);
      const more = start + limit < list.length;
      const next = more ? (style === 'rippled' ? pos(list[start + limit]!) : pos(page[page.length - 1]!)) : undefined;
      return {
        result: {
          status: 'success',
          validated: true,
          account: params.account,
          ledger_index_min: min,
          ledger_index_max: max,
          limit,
          transactions: page,
          ...(next ? { marker: next } : {}),
        },
      };
    },
  };
  return server;
}

function adapterFor(servers: Record<string, ReturnType<typeof fakeServer>>, pageLimit = 3) {
  const transport: XrplTransport = async (url, method, params) => {
    const s = servers[url];
    if (!s) throw new Error(`no fake server ${url}`);
    return s.handle(method, params);
  };
  return createXrpAdapter({ endpoints: Object.keys(servers), transport, pageLimit, rangeRetryDelayMs: 1 });
}

const ids = (rows: RawTransfer[]) => rows.map((r) => Number.parseInt(r.txid, 16));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('XRP adapter: poll', () => {
  it('paginates with markers, skips the cursor ledger and pins the reported ledger_index_max', async () => {
    const txs = history(20, 100, 2); // ledgers 100..109
    const a = fakeServer('rippled', txs, 120);
    const adapter = adapterFor({ 'https://a/': a });
    const r = await adapter.poll(ADDR, { ledger: 100 });
    expect(ids(r.transfers)).toEqual(range(3, 20)); // txs 1-2 are in the cursor ledger
    expect(r.cursor).toEqual({ ledger: 120 });
    expect(a.calls[0]).toMatchObject({ ledger_index_min: 100, ledger_index_max: -1, forward: true });
    for (const c of a.calls.slice(1)) expect(c).toMatchObject({ ledger_index_max: 120, marker: expect.any(Object) });
  });

  for (const [first, second] of [
    ['rippled', 'clio'],
    ['clio', 'rippled'],
  ] as const) {
    it(`failover ${first} -> ${second} mid-pagination: no marker reuse, nothing skipped or repeated`, async () => {
      const txs = history(30, 200, 4); // several txs per ledger, pages split ledgers
      const a = fakeServer(first, txs, 300, { failOnCall: 3 });
      const b = fakeServer(second, txs, 300);
      const adapter = adapterFor({ 'https://a/': a, 'https://b/': b });
      const r = await adapter.poll(ADDR, { ledger: 199 });
      expect(ids(r.transfers)).toEqual(range(1, 30));
      expect(r.cursor).toEqual({ ledger: 300 });
      // B never received A's marker; it resumed from the last seen ledger.
      expect(b.calls[0]?.marker).toBeUndefined();
      expect(b.calls[0]?.ledger_index_min).toBe(200 + Math.floor(5 / 4)); // 6 txs seen (2 pages) -> last ledger 201
    });
  }

  it('reads a large backlog over several polls without skipping anything', async () => {
    const txs = history(200, 1000, 4); // 200 txs, 4 per ledger, pages of 3 split ledgers
    const a = fakeServer('rippled', txs, 2000);
    const adapter = adapterFor({ 'https://a/': a });
    const seen = new Set<number>();
    let cursor: Record<string, unknown> = { ledger: 999 };
    let polls = 0;
    while (cursor.ledger !== 2000 && polls < 10) {
      const before = a.calls.length;
      const r = await adapter.poll(ADDR, cursor);
      expect(a.calls.length - before).toBeLessThanOrEqual(25);
      for (const id of ids(r.transfers)) seen.add(id);
      expect(r.cursor.ledger as number).toBeGreaterThan(cursor.ledger as number);
      cursor = r.cursor;
      polls++;
    }
    expect(polls).toBeGreaterThan(1);
    expect([...seen].sort((x, y) => x - y)).toEqual(range(1, 200));
  });

  it('returns the unchanged cursor when no server has validated the cursor ledger yet', async () => {
    const adapter = adapterFor({ 'https://a/': fakeServer('rippled', [], 99), 'https://b/': fakeServer('clio', [], 98) });
    expect(await adapter.poll(ADDR, { ledger: 100 })).toEqual({ transfers: [], cursor: { ledger: 100 } });
  });

  it('never moves the cursor backwards and rejects invalid cursors', async () => {
    const adapter = adapterFor({ 'https://a/': fakeServer('clio', [], 500) });
    expect((await adapter.poll(ADDR, { ledger: 500 })).cursor).toEqual({ ledger: 500 });
    await expect(adapter.poll(ADDR, { ledger: 'x' })).rejects.toThrow(/Invalid XRP cursor/);
  });
});

describe('XRP adapter: backfill', () => {
  it('streams batches up to the boundary with monotonic progress', async () => {
    const txs = history(25, 40_000, 1);
    const a = fakeServer('clio', txs, 60_000);
    const adapter = adapterFor({ 'https://a/': a }, 4);
    const batches: number[][] = [];
    const fractions: number[] = [];
    const all = await adapter.backfill(
      ADDR,
      { ledger: 40_019 },
      {
        onBatch: (b) => {
          batches.push(ids(b));
        },
        onProgress: (p) => {
          if (p.fraction !== undefined) fractions.push(p.fraction);
        },
      },
    );
    expect(ids(all)).toEqual(range(1, 20));
    expect(batches.flat()).toEqual(range(1, 20));
    expect(batches.length).toBe(5);
    expect(a.calls[0]).toMatchObject({ ledger_index_min: -1, ledger_index_max: 40_019 });
    expect(fractions.at(-1)).toBe(1);
    expect(fractions).toEqual([...fractions].sort((x, y) => x - y));
  });

  it('fails over from a server without full history', async () => {
    const txs = history(5, 40_000, 1);
    const partial = fakeServer('rippled', txs, 60_000, { historyStart: 50_000_000 });
    const full = fakeServer('clio', txs, 60_000);
    const adapter = adapterFor({ 'https://partial/': partial, 'https://full/': full });
    expect(ids(await adapter.backfill(ADDR, { ledger: 59_000 }))).toEqual(range(1, 5));
    expect(full.calls).toHaveLength(2);
  });

  it('retries when the boundary ledger is not validated yet on any server', async () => {
    const a = fakeServer('clio', history(3, 40_000, 1), 49_999);
    const adapter = adapterFor({ 'https://a/': a });
    const p = adapter.backfill(ADDR, { ledger: 50_000 });
    setTimeout(() => (a.validated = 50_000), 0);
    expect(ids(await p)).toEqual([1, 2, 3]);
  });

  it('honors the abort signal', async () => {
    const ac = new AbortController();
    const adapter = adapterFor({ 'https://a/': fakeServer('clio', history(20, 40_000, 1), 60_000) });
    await expect(
      adapter.backfill(ADDR, { ledger: 50_000 }, { signal: ac.signal, onBatch: () => ac.abort(new Error('stop')) }),
    ).rejects.toThrow('stop');
  });
});

describe('XRP adapter: balances, tip, status', () => {
  function single(handler: (method: string, params: Json) => unknown) {
    const calls: string[] = [];
    const transport: XrplTransport = async (url, method, params) => {
      calls.push(`${url} ${method}`);
      return handler(method, params);
    };
    return { calls, adapter: createXrpAdapter({ endpoints: ['https://a/', 'https://b/'], transport }) };
  }

  it('getBalances: validated Balance in drops; actNotFound -> 0 without failover', async () => {
    const ok = single(() => ({ result: { status: 'success', validated: true, account_data: { Account: ADDR, Balance: '25000000' } } }));
    expect(await ok.adapter.getBalances(ADDR)).toEqual(new Map([['xrp:native', 25_000_000n]]));
    const missing = single(() => ({ result: { status: 'error', error: 'actNotFound' } }));
    expect(await missing.adapter.getBalances(ADDR)).toEqual(new Map([['xrp:native', 0n]]));
    expect(missing.calls).toEqual(['https://a/ account_info']);
  });

  it('getBalances fails over on malformed data and server errors', async () => {
    const calls: string[] = [];
    const transport: XrplTransport = async (url) => {
      calls.push(url);
      if (url === 'https://a/') return { result: { status: 'success', account_data: { Account: ADDR, Balance: '1e6' } } };
      if (url === 'https://b/') return { result: { status: 'error', error: 'tooBusy' } };
      return { result: { status: 'success', validated: true, account_data: { Account: ADDR, Balance: '7' } } };
    };
    const adapter = createXrpAdapter({ endpoints: ['https://a/', 'https://b/', 'https://c/'], transport });
    expect((await adapter.getBalances(ADDR)).get('xrp:native')).toBe(7n);
    expect(calls).toEqual(['https://a/', 'https://b/', 'https://c/']);
  });

  it('getTip and initCursor use the validated ledger (number or v1 string)', async () => {
    const { adapter } = single(() => ({ result: { status: 'success', validated: true, ledger: { ledger_index: '108450830' } } }));
    expect(await adapter.getTip()).toBe(108_450_830);
    expect(await adapter.initCursor(ADDR)).toEqual({ ledger: 108_450_830 });
  });

  it('getTxStatus: confirmed, failed, pending, txnNotFound and invalid ids', async () => {
    const ok = entries('payment-received-tags')[0]!;
    const tec = entries('tec-unfunded-payment')[0]!;
    const { adapter, calls } = single((_m, params) => {
      if (params.transaction === ok.hash) return { result: { ...ok, status: 'success' } };
      if (params.transaction === tec.hash) return { result: { ...tec, status: 'success' } };
      return { result: { status: 'error', error: 'txnNotFound' } };
    });
    expect((await adapter.getTxStatus(ok.hash as string, ADDR)).state).toBe('confirmed');
    expect((await adapter.getTxStatus((tec.hash as string).toLowerCase(), ADDR)).state).toBe('failed');
    expect(await adapter.getTxStatus('A'.repeat(64), ADDR)).toEqual({ state: 'unknown' });
    expect(await adapter.getTxStatus('not-a-hash', ADDR)).toEqual({ state: 'unknown' });
    expect(calls.filter((c) => c.startsWith('https://b/'))).toEqual([]); // txnNotFound does not fail over
  });
});
