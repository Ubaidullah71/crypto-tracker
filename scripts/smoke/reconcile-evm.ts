/** Reconcile one EVM address on one network: node scripts/smoke/reconcile-evm.ts <network> <address> */
import { setConfigForTests } from '../../src/config.ts';
import { getConfig } from '../../src/config.ts';
import { createEvmAdapter } from '../../src/chains/evm/adapter.ts';
import { NETWORKS, type EvmNetworkId } from '../../src/core/networks.ts';
import { closeHttp } from '../../src/util/http.ts';
void setConfigForTests;
getConfig();
const [network, address] = process.argv.slice(2) as [EvmNetworkId, string];
const a = createEvmAdapter(network);
const boundary = await a.initCursor(address);
const rows = await a.backfill(address, boundary);
const sums = new Map<string, bigint>();
for (const t of rows) {
  const s = t.direction === 'in' ? t.amount : t.direction === 'out' ? -t.amount : 0n;
  sums.set(t.assetKey, (sums.get(t.assetKey) ?? 0n) + s);
  if (t.chargeFee && t.fee) sums.set(`${network}:native`, (sums.get(`${network}:native`) ?? 0n) - t.fee);
}
console.log('boundary', JSON.stringify(boundary));
const fp = String((boundary as { fp?: string }).fp ?? '');
console.log('history sums', [...sums].map(([k, v]) => `${k}=${v}`).join(' '));
console.log(
  'rows',
  rows.length,
  'synthetic',
  rows.filter((r) => r.meta?.syntheticTxid).length,
  'feeOnly',
  rows.filter((r) => r.meta?.feeOnly).length,
);
console.log('fp at boundary (nonce:balance:tokens)', fp);
const bal = BigInt(fp.split(':')[1] ?? '0');
console.log('native diff (wei) =', bal - (sums.get(`${network}:native`) ?? 0n), NETWORKS[network].native.asset);
await closeHttp();
