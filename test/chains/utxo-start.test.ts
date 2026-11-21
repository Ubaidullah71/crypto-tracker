import { expect, it, vi } from 'vitest';
import type { RawTransfer } from '../../src/core/types.ts';

// The provider's cached tip (1000) is one block behind the address summary, which already
// counts a payment confirmed in block 1001.
const OUR = 'bc1qxfnuu7ezgrxst62tx9hdjygcfyyw00csdgfccc';
const OTHER = 'bc1q2399cffnyjle2ct4l4849ussajlf2kyyk67jsu';
const net = vi.hoisted(() => ({ probeTip: 1000, chainTip: 1001 }));

vi.mock('../../src/util/http.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/util/http.ts')>();
  const chain = [
    { txid: 'a'.repeat(64), height: 1001 },
    { txid: 'b'.repeat(64), height: 900 },
  ];
  const bbTx = (s: { txid: string; height: number }) => ({
    txid: s.txid,
    vin: [{ n: 0, addresses: [OTHER], isAddress: true, value: '3000' }],
    vout: [
      { n: 0, value: '1000', addresses: [OUR], isAddress: true, isOwn: true },
      { n: 1, value: '1900', addresses: [OTHER], isAddress: true },
    ],
    blockHeight: s.height,
    confirmations: net.chainTip - s.height + 1,
    blockTime: 1_700_000_000 + s.height,
    fees: '100',
    vsize: 141,
  });
  return {
    ...orig,
    httpJson: async (url: string) => {
      const u = new URL(url);
      if (u.host !== 'btc1.trezor.io') throw new orig.HttpError(`HTTP 503 from ${u.host}`, 503, url, true);
      if (u.pathname === '/api/v2') {
        return {
          blockbook: {
            bestHeight: net.probeTip,
            inSync: true,
            inSyncMempool: true,
            mempoolSize: 50_000,
            lastBlockTime: new Date().toISOString(),
          },
          backend: { blocks: net.probeTip },
        };
      }
      const q = u.searchParams;
      const visible = chain.filter((s) => s.height <= net.chainTip);
      const head = { balance: String(visible.length * 1000), unconfirmedTxs: 0, txs: visible.length };
      if (q.get('details') === 'basic') return head;
      const from = Number(q.get('from') ?? 0);
      const to = q.has('to') ? Number(q.get('to')) : Infinity;
      const list = visible.filter((s) => s.height >= from && s.height <= to);
      return { ...head, page: 1, totalPages: 1, itemsOnPage: Number(q.get('pageSize')), transactions: list.map(bbTx) };
    },
  };
});

const { createUtxoAdapter } = await import('../../src/chains/utxo/adapter.ts');

it('finds a payment confirmed just before tracking started', async () => {
  const adapter = createUtxoAdapter('bitcoin');
  const cursor = await adapter.initCursor(OUR);
  const found: RawTransfer[] = [...(await adapter.backfill(OUR, cursor))];
  net.probeTip = 1001;
  let c = cursor;
  for (let i = 0; i < 2; i++) {
    const p = await adapter.poll(OUR, c);
    found.push(...p.transfers);
    c = p.cursor;
  }
  const txids = new Set(found.map((t) => t.txid));
  expect(txids).toEqual(new Set(['a'.repeat(64), 'b'.repeat(64)]));
});
