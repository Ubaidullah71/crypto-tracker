import { beforeEach, describe, expect, it } from 'vitest';
import { setConfigForTests } from '../src/config.ts';
import type { RawTransfer } from '../src/core/types.ts';
import { NETWORKS } from '../src/core/networks.ts';
import { openDb } from '../src/db/database.ts';
import { transfers, walletNetworks, wallets } from '../src/db/repo.ts';
import { imitates, markPoisoningDust, POISONING_NOTE } from '../src/tracker/poisoning.ts';

const USDT = NETWORKS.bsc.tokens.find((t) => t.asset === 'USDT')!;
const OURS = '0x28C6c06298d514Db089934071355E5743bf21d60';
// Someone we paid, and the look-alikes a scammer generates for it.
const PAID = '0x7a1fc2d3e4f5061728394a5b6c7d8e9f0a1b9c3e';
const LOOK_HEAD3 = '0x7a2fffffffffffffffffffffffffffffffff9c3e';
const LOOK_TAIL3 = '0x7a1feeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee8c3e';
const LOOK_TAIL_ONLY = '0x4b0edddddddddddddddddddddddddddddddd9c3e';
const UNRELATED = '0x1111222233334444555566667777888899990000';

let n = 0;
function usdt(direction: 'in' | 'out', counterparty: string, amount: number): RawTransfer {
  n++;
  return {
    txid: `0x${n.toString(16).padStart(64, '0')}`,
    subId: `log:${n}`,
    assetKey: USDT.key,
    direction,
    amount: BigInt(Math.round(amount * 1e6)) * 10n ** BigInt(USDT.decimals - 6),
    fee: null,
    chargeFee: false,
    counterparty,
    blockHeight: 100 + n,
    blockTime: 1_790_000_000 + n,
    status: 'confirmed',
  };
}

describe('address poisoning', () => {
  it('recognises look-alike addresses', () => {
    const k = PAID.toLowerCase();
    expect(imitates(k, LOOK_HEAD3)).toBe(true);
    expect(imitates(k, LOOK_TAIL3)).toBe(true);
    expect(imitates(k, LOOK_TAIL_ONLY)).toBe(false);
    expect(imitates(k, LOOK_TAIL_ONLY, true)).toBe(true);
    expect(imitates(k, UNRELATED, true)).toBe(false);
    expect(imitates(k, k, true)).toBe(false);
    // Base58 addresses (Solana, XRP, legacy BTC) are compared as they are.
    expect(imitates('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', '9WzDqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAWWM')).toBe(true);
    expect(imitates('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', '9wZdqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqawwm')).toBe(false);
    // The shared type prefix (ltc1q, bc1q, L, r ...) does not count as a match.
    expect(imitates('ltc1qalpdfzpzwv9ja499zv8wtaedvzc96ptl280sgt', 'ltc1qzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz0sgt')).toBe(false);
    expect(imitates('ltc1qalpdfzpzwv9ja499zv8wtaedvzc96ptl280sgt', 'ltc1qalpdzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz80sgt')).toBe(true);
    expect(imitates('LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9', 'Lqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqyv9')).toBe(false);
  });

  describe('dust sweep', () => {
    let wnId: number;
    beforeEach(() => {
      setConfigForTests({});
      openDb(':memory:');
      const wid = wallets.create({ label: 'EVM', address: OURS, family: 'evm' });
      wnId = walletNetworks.create(wid, 'bsc', { block: 1 });
    });
    const add = (t: RawTransfer) => transfers.upsert(wnId, t, false).id;

    it('hides dust from look-alikes of people you paid, and nothing else', async () => {
      add(usdt('out', PAID, 1000));
      const dust1 = add(usdt('in', LOOK_HEAD3, 0.000001));
      const dust2 = add(usdt('in', LOOK_TAIL_ONLY, 0.00005));
      const realFromLookalike = add(usdt('in', LOOK_TAIL3, 50));
      const dustUnrelated = add(usdt('in', UNRELATED, 0.00001));
      const dustFromPaid = add(usdt('in', PAID, 0.00001));

      expect(await markPoisoningDust()).toBe(2);
      for (const id of [dust1, dust2]) {
        const t = transfers.get(id)!;
        expect([t.spam, t.category, t.note, t.notify_skipped]).toEqual([1, 'auto', POISONING_NOTE, 1]);
      }
      for (const id of [realFromLookalike, dustUnrelated, dustFromPaid]) expect(transfers.get(id)!.spam).toBe(0);

      // Hidden from lists, but still part of the balance history (the ledger reads every row).
      const listed = transfers.list({}, 50, 0).map((t) => t.id);
      expect(listed).not.toContain(dust1);
      expect(listed).toContain(dustUnrelated);
      expect(transfers.forLedger().map((t) => t.id)).toContain(dust1);
    });

    it('checks each transfer once, so your own change is kept', async () => {
      add(usdt('out', PAID, 1000));
      const dust = add(usdt('in', LOOK_HEAD3, 0.000001));
      await markPoisoningDust();
      expect(transfers.get(dust)!.spam).toBe(1);
      transfers.setCategory(dust, 'auto'); // you looked at it and kept it: shown again
      expect(await markPoisoningDust()).toBe(0);
      expect(transfers.get(dust)!.spam).toBe(0);

      const later = add(usdt('in', LOOK_TAIL3, 0.00001));
      expect(await markPoisoningDust()).toBe(1);
      expect(transfers.get(later)!.spam).toBe(1);
    });
  });
});
