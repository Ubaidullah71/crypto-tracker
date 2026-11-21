/**
 * Live check of extended-public-key tracking: node scripts/smoke/xpub.ts
 * Uses the public BIP44/BIP84 test accounts ("abandon ... about"), which have real mainnet activity.
 */
import { setConfigForTests } from '../../src/config.ts';
import { createUtxoAdapter } from '../../src/chains/utxo/adapter.ts';
import { closeHttp } from '../../src/util/http.ts';

setConfigForTests({});
const CASES = [
  {
    name: 'BIP84 zpub (Native SegWit)',
    key: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
    expect: 'wpkh',
  },
  {
    name: 'BIP44 xpub (Ledger-style, type unknown)',
    key: 'xpub6BosfCnifzxcFwrSzQiqu2DBVTshkCXacvNsWGYJVVhhawA7d4R5WSWGFNbi8Aw6ZRc1brxMyWMzG3DSSSSoekkudhUd9yLb6qx39T9nMdj',
    expect: 'pkh',
  },
];

let failures = 0;
const btc = createUtxoAdapter('bitcoin');
for (const c of CASES) {
  const t0 = Date.now();
  const cursor = await btc.initCursor(c.key);
  const ok1 = cursor.xtype === c.expect;
  console.log(
    `${ok1 ? 'PASS' : 'FAIL'} ${c.name}: detected ${String(cursor.xtype)} (confident ${String(cursor.xconfident)}), ${(cursor.ownAddresses as string[] | undefined)?.length ?? 0} used addresses`,
  );
  if (!ok1) failures++;
  const rows = await btc.backfill(c.key, cursor);
  let sum = 0n;
  for (const t of rows) {
    sum += t.direction === 'in' ? t.amount : t.direction === 'out' ? -t.amount : 0n;
    if (t.chargeFee && t.fee) sum -= t.fee;
  }
  const bal = (await btc.getBalances(c.key)).get('bitcoin:native') ?? 0n;
  const ok2 = sum === bal;
  console.log(
    `${ok2 ? 'PASS' : 'FAIL'} ${c.name}: ${rows.length} transfers, history sum ${sum} sats vs balance ${bal} sats (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );
  if (!ok2) failures++;
  const withOwn = rows.filter((r) => typeof r.meta?.ownAddress === 'string').length;
  console.log(`      ${withOwn}/${rows.length} transfers name the receiving/spending address`);
  const polled = await btc.poll(c.key, cursor);
  console.log(`PASS ${c.name}: live poll ok (${polled.transfers.length} new)`);
}
await closeHttp();
console.log(failures ? `${failures} FAILED` : 'All xpub checks passed');
process.exit(failures ? 1 : 0);
