import { describe, expect, it } from 'vitest';
import { buildEffectiveMap, buildTrackedIndex, resolveEffective, type PairableRow } from '../src/portfolio/classify.ts';
import { runLedger, type LedgerInput } from '../src/portfolio/ledger.ts';

let id = 0;
const e = (p: Partial<LedgerInput>): LedgerInput => ({
  id: ++id,
  asset: 'ETH',
  time: id,
  effective: 'acquire',
  category: 'auto',
  qty: 0,
  price: null,
  fee: null,
  ...p,
});

describe('average cost ledger', () => {
  it('computes avg cost, realized and remaining basis', () => {
    const r = runLedger([e({ qty: 1, price: 1000 }), e({ qty: 1, price: 2000 }), e({ effective: 'dispose', qty: 1, price: 3000 })]);
    const b = r.books.get('ETH')!;
    expect(b.qty).toBeCloseTo(1);
    expect(b.cost).toBeCloseTo(1500);
    expect(b.realized).toBeCloseTo(1500);
  });

  it('charges fees at cost as a realized loss', () => {
    const r = runLedger([
      e({ qty: 1, price: 2000 }),
      e({ asset: 'USDT', effective: 'dispose', qty: 0, price: 1, fee: { asset: 'ETH', qty: 0.01, price: 3000 } }),
    ]);
    const b = r.books.get('ETH')!;
    expect(b.qty).toBeCloseTo(0.99);
    expect(b.cost).toBeCloseTo(1980);
    expect(b.realized).toBeCloseTo(-20);
    expect(b.feesUsd).toBeCloseTo(30);
    // total P/L at $3000 = unrealized + realized = (0.99*3000 - 1980) - 20 = 970 = value - invested
    expect(0.99 * 3000 - b.cost + b.realized).toBeCloseTo(970);
  });

  it('transfer out removes basis without P/L; internal is neutral', () => {
    const r = runLedger([
      e({ qty: 2, price: 100 }),
      e({ effective: 'internal', qty: 1, price: 500 }),
      e({ effective: 'transfer_out', qty: 1, price: 500 }),
    ]);
    const b = r.books.get('ETH')!;
    expect(b.qty).toBeCloseTo(1);
    expect(b.cost).toBeCloseTo(100);
    expect(b.realized).toBe(0);
  });

  it('processes a receive before its spend when both are in the same block', () => {
    // Imported newest-first: the spend gets the lower row id but the same block time.
    const spend: LedgerInput = { ...e({ effective: 'dispose', qty: 1, price: 200 }), id: 1, time: 500 };
    const receive: LedgerInput = { ...e({ qty: 1, price: 100 }), id: 2, time: 500 };
    const r = runLedger([spend, receive]);
    const b = r.books.get('ETH')!;
    expect(b.qty).toBe(0);
    expect(b.realized).toBeCloseTo(100);
  });

  it('does not invent gains when history is incomplete', () => {
    const r = runLedger([e({ qty: 1, price: 100 }), e({ effective: 'dispose', qty: 3, price: 200 })]);
    const b = r.books.get('ETH')!;
    expect(b.realized).toBeCloseTo(100); // only the known coin has a gain
    expect(b.qty).toBe(0);
  });

  it('ignored rows skip the amount but keep a fee you really paid', () => {
    const r = runLedger([
      e({ qty: 1, price: 100 }),
      e({ effective: 'ignored', qty: 5, price: 1, fee: { asset: 'ETH', qty: 0.5, price: 1 } }),
    ]);
    expect(r.books.get('ETH')!.qty).toBeCloseTo(0.5);
  });

  it('coins sent to and returned from your own untracked wallet keep their original cost', () => {
    const r = runLedger([
      e({ asset: 'BTC', qty: 1, price: 20_000, time: 1 }),
      e({ asset: 'BTC', effective: 'transfer_out', qty: 1, price: 30_000, time: 2 }),
      e({ asset: 'BTC', effective: 'transfer_in', qty: 1, price: 60_000, time: 3 }),
    ]);
    const b = r.books.get('BTC')!;
    expect(b.qty).toBeCloseTo(1);
    expect(b.cost).toBeCloseTo(20_000);
    expect(b.realized).toBe(0);
  });

  it('follows block height when block timestamps go backwards', () => {
    // Receive in block 100 (t=1600), spend in block 101 stamped earlier (t=1300).
    const rows = [
      { ...e({ asset: 'BTC', qty: 1, price: 30_000 }), network: 'bitcoin' as const, height: 100, time: 1600 },
      { ...e({ asset: 'BTC', effective: 'dispose', qty: 1, price: 30_000 }), network: 'bitcoin' as const, height: 101, time: 1600 },
    ];
    const b = runLedger(rows).books.get('BTC')!;
    expect(b.qty).toBe(0);
    expect(b.realized).toBeCloseTo(0);
  });

  it('keeps chain order within a network when other networks share the same second', () => {
    // Newest-first import: the later BSC block got the lower id. An Ethereum row in between
    // used to make the comparison cyclic, so the spend could be booked before the receive.
    const rows: LedgerInput[] = [
      { ...e({ asset: 'BNB', qty: 1, price: 100 }), time: 10 },
      { ...e({ asset: 'BNB', effective: 'dispose', qty: 1, price: 600 }), id: 101, time: 50, network: 'bsc', height: 6 },
      { ...e({ asset: 'ETH', qty: 1, price: 3000 }), id: 102, time: 50, network: 'ethereum', height: 900 },
      { ...e({ asset: 'BNB', qty: 1, price: 500 }), id: 103, time: 50, network: 'bsc', height: 5 },
    ];
    for (const order of [rows, [...rows].reverse(), [rows[2]!, rows[0]!, rows[3]!, rows[1]!]]) {
      const b = runLedger(order).books.get('BNB')!;
      expect(b.realized).toBeCloseTo(300);
      expect(b.cost).toBeCloseTo(300);
    }
  });
});

describe('pairing moves between tracked wallets', () => {
  const row = (p: Partial<PairableRow>): PairableRow => ({
    id: 1,
    network: 'bitcoin',
    txid: 'aa'.repeat(32),
    asset: 'BTC',
    direction: 'out',
    category: 'auto',
    amount: '0',
    decimals: 8,
    meta: null,
    ...p,
  });

  it('a payment with change to another tracked wallet is only a partial sale', () => {
    // R1 pays 0.3 to a merchant and 0.6999 to tracked wallet CH1 (fee excluded from amounts).
    const map = buildEffectiveMap([
      row({ id: 1, direction: 'out', amount: '99990000' }),
      row({ id: 2, direction: 'in', amount: '69990000' }),
    ]);
    expect(map.get(1)!.effective).toBe('dispose');
    expect(map.get(1)!.qty).toBeCloseTo(0.3);
    expect(map.get(2)!.effective).toBe('internal');
  });

  it('a receipt without a recorded sending side is an acquisition; manual categories win', () => {
    const map = buildEffectiveMap([
      row({ id: 1, direction: 'in', amount: '100000000' }),
      row({ id: 2, txid: 'bb'.repeat(32), direction: 'out', amount: '100000000', category: 'transfer' }),
      row({ id: 3, txid: 'block:5:internal', direction: 'in', amount: '5' }),
    ]);
    expect(map.get(1)!.effective).toBe('acquire');
    expect(map.get(2)!.effective).toBe('transfer_out');
    expect(map.get(3)!.effective).toBe('acquire');
  });

  it('a category set on one side still pairs with the other side', () => {
    // "Spend" on a payment with tracked change: only the merchant part is a spend.
    const spend = buildEffectiveMap([
      row({ id: 1, direction: 'out', amount: '100000000', category: 'spend' }),
      row({ id: 2, direction: 'in', amount: '70000000' }),
    ]);
    expect(spend.get(1)).toEqual({ effective: 'dispose', qty: expect.closeTo(0.3, 9) });
    expect(spend.get(2)!.effective).toBe('internal');

    // "Transfer out to my own wallet": the untracked part is parked, the tracked part is a move.
    const transfer = buildEffectiveMap([
      row({ id: 1, direction: 'out', amount: '100000000', category: 'transfer' }),
      row({ id: 2, direction: 'in', amount: '70000000' }),
    ]);
    expect(transfer.get(1)).toEqual({ effective: 'transfer_out', qty: expect.closeTo(0.3, 9) });
    expect(transfer.get(2)!.effective).toBe('internal');

    // "Between my tracked wallets" on one side makes the receiving side a move too.
    const internal = buildEffectiveMap([
      row({ id: 1, direction: 'out', amount: '100000000', category: 'internal' }),
      row({ id: 2, direction: 'in', amount: '70000000' }),
    ]);
    expect(internal.get(1)!.effective).toBe('internal');
    expect(internal.get(2)!.effective).toBe('internal');
  });

  it('an ignored side does not pair', () => {
    const map = buildEffectiveMap([
      row({ id: 1, direction: 'out', amount: '100000000', category: 'ignored' }),
      row({ id: 2, direction: 'in', amount: '70000000' }),
    ]);
    expect(map.get(1)!.effective).toBe('ignored');
    expect(map.get(2)!.effective).toBe('acquire');
  });
});

describe('classification', () => {
  const tracked = buildTrackedIndex([
    { network: 'ethereum', address: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    { network: 'ethereum', address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  ]);
  const base = {
    network: 'ethereum' as const,
    category: 'auto' as const,
    counterparties: null,
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  it('detects transfers between tracked wallets', () => {
    expect(resolveEffective({ ...base, direction: 'in', counterparty: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }, tracked)).toBe(
      'internal',
    );
    expect(resolveEffective({ ...base, direction: 'out', counterparty: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, tracked)).toBe(
      'internal',
    );
    expect(resolveEffective({ ...base, direction: 'in', counterparty: '0xcccccccccccccccccccccccccccccccccccccccc' }, tracked)).toBe(
      'acquire',
    );
    expect(resolveEffective({ ...base, direction: 'out', counterparty: '0xcccccccccccccccccccccccccccccccccccccccc' }, tracked)).toBe(
      'dispose',
    );
  });
  it('respects manual categories', () => {
    expect(resolveEffective({ ...base, direction: 'out', category: 'transfer', counterparty: null }, tracked)).toBe('transfer_out');
    expect(resolveEffective({ ...base, direction: 'in', category: 'ignored', counterparty: null }, tracked)).toBe('ignored');
  });
});
