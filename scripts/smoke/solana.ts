/**
 * Live smoke test for the Solana adapter (read-only, public RPCs).
 *   node scripts/smoke/solana.ts [activeAddress] [smallAddress...]
 * - activeAddress: moderately active wallet (poll + limited backfill)
 * - smallAddress: wallets with short full history (reconciliation: movements - fees == balance)
 */
import { createSolanaAdapter, type SolanaCursor } from '../../src/chains/solana/adapter.ts';
import { parseSignatureList } from '../../src/chains/solana/rpc.ts';
import { formatUnits } from '../../src/core/amount.ts';
import { getNetworkAsset } from '../../src/core/networks.ts';
import type { RawTransfer } from '../../src/core/types.ts';
import { closeHttp } from '../../src/util/http.ts';

const ACTIVE = process.argv[2] ?? '89MJwY8Ubadzr5jXqZUuESvideVJc2ZGsd4J2aASgWp5';
const SMALL =
  process.argv.length > 3
    ? process.argv.slice(3)
    : ['3gDeabnozsE6UPyFXMHdCMCXj9p86bmvo1qnrYPBgsWQ', 'J4Krx3PpuM7TfRF5zYCxVsimXdrLZuWLEqEnogiuSmz8'];
/** Owner account last active weeks ago (its USDC account is busy). */
const DORMANT = 'AQqnMFBwGZEoti85aTVRy8XYpKrho7GaMDx9ZB3CEeKA';
const BACKFILL_TX_LIMIT = 60;
const REWIND = 4;

const adapter = createSolanaAdapter();
const rpc = adapter.rpc;
let failures = 0;

function check(cond: boolean, msg: string): void {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const r0 = rpc.stats.requests;
  const c0 = rpc.stats.calls;
  const t = Date.now();
  const res = await fn();
  console.log(`  [${name}] ${Date.now() - t} ms, ${rpc.stats.requests - r0} HTTP requests (${rpc.stats.calls - c0} RPC calls)`);
  return res;
}

function fmt(key: string, v: bigint): string {
  const a = getNetworkAsset(key);
  return a ? `${formatUnits(v, a.decimals)} ${a.asset}` : `${v} ${key}`;
}

function describe(t: RawTransfer): string {
  const tag = t.meta?.feeOnly ? 'fee-only' : `${t.direction} ${fmt(t.assetKey, t.amount)}`;
  return `${t.txid.slice(0, 10)}… ${t.subId.slice(0, 12).padEnd(12)} ${tag}${t.chargeFee ? ` (fee ${t.fee})` : ''} ${t.status} slot=${t.blockHeight} cp=${t.counterparty?.slice(0, 8) ?? '-'}`;
}

function invariants(rows: RawTransfer[], label: string): void {
  const byTx = new Map<string, RawTransfer[]>();
  for (const r of rows) byTx.set(r.txid, [...(byTx.get(r.txid) ?? []), r]);
  let ok = true;
  for (const [, list] of byTx) {
    if (list.filter((r) => r.chargeFee).length > 1) ok = false;
    if (new Set(list.map((r) => r.subId)).size !== list.length) ok = false;
  }
  check(ok, `${label}: <=1 chargeFee row and unique subIds per tx (${byTx.size} txs, ${rows.length} rows)`);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`Active address: ${ACTIVE}`);

  const tip = await step('getTip', () => adapter.getTip());
  check(tip > 470_000_000, `getTip -> slot ${tip}`);

  const bal = await step('getBalances', () => adapter.getBalances(ACTIVE));
  check(bal.size === 3, `getBalances -> ${[...bal].map(([k, v]) => fmt(k, v)).join(', ')}`);

  const cursor = (await step('initCursor', () => adapter.initCursor(ACTIVE))) as SolanaCursor;
  check(
    cursor.heads[ACTIVE] !== undefined,
    `initCursor -> ${Object.keys(cursor.heads).length} watched accounts, ${Object.keys(cursor.tokenAccounts).length} extra token accounts`,
  );
  for (const [a, h] of Object.entries(cursor.heads)) console.log(`    ${a} head=${h.sig?.slice(0, 12) ?? 'none'} slot=${h.slot}`);

  // Rewind every head by a few signatures so poll() has real work to do.
  const rewound: SolanaCursor = structuredClone(cursor);
  const expected = new Set<string>();
  for (const a of Object.keys(rewound.heads)) {
    const list = parseSignatureList(
      await rpc.call(rpc.historyPool(0), 'getSignaturesForAddress', [a, { limit: REWIND + 1, commitment: 'confirmed' }]),
    );
    const older = list[REWIND];
    if (!older) continue;
    for (const s of list.slice(0, REWIND)) expected.add(s.signature);
    rewound.heads[a] = { sig: older.signature, slot: older.slot, at: Date.now() };
  }
  const p1 = await step('poll (rewound)', () => adapter.poll(ACTIVE, rewound));
  const txids = new Set(p1.transfers.map((t) => t.txid));
  check(
    p1.transfers.length > 0,
    `poll returned ${p1.transfers.length} transfers from ${txids.size} txs (${expected.size} rewound signatures)`,
  );
  const minSlot = Math.min(...Object.values(rewound.heads).map((h) => h.slot));
  const inRange = p1.transfers.every((t) => (t.blockHeight ?? 0) >= minSlot);
  const covered = [...txids].filter((t) => expected.has(t)).length;
  check(inRange, `poll transfers are all at/after the rewound heads (${covered}/${txids.size} txids from the rewound range, rest newer)`);
  for (const t of p1.transfers.slice(0, 12)) console.log(`    ${describe(t)}`);
  invariants(p1.transfers, 'poll');

  const p2 = await step('poll (steady state)', () => adapter.poll(ACTIVE, JSON.parse(JSON.stringify(p1.cursor))));
  console.log(`    steady-state poll: ${p2.transfers.length} transfers, pending=${(p2.cursor as SolanaCursor).pending.length}`);

  // Dormant wallet (owner's last activity older than publicnode's ~2.5-day ledger): steady-state
  // polls must stay on the fast endpoint instead of falling back to full history every time.
  {
    const dc = await adapter.initCursor(DORMANT);
    const d1 = await adapter.poll(DORMANT, dc);
    const req0 = rpc.stats.requests;
    const m0 = { ...rpc.stats.byMethod };
    const live0 = rpc.stats.byHost['solana-rpc.publicnode.com'] ?? 0;
    const d2 = await step('poll (dormant wallet, steady state)', () => adapter.poll(DORMANT, d1.cursor));
    // Its USDC account is busy: fetching genuinely new transactions is fine, listing must stay cheap.
    const delta = (m: string) => (rpc.stats.byMethod[m] ?? 0) - (m0[m] ?? 0);
    const listing = rpc.stats.requests - req0 - delta('getTransaction') - delta('getTokenAccountsByOwner') / 2;
    check(
      listing === 1 && (rpc.stats.byHost['solana-rpc.publicnode.com'] ?? 0) > live0 && delta('minimumLedgerSlot') === 0,
      `dormant-wallet poll listed with ${listing} request(s) on publicnode (+${delta('getTransaction')} tx fetches for ${d2.transfers.length} new transfers)`,
    );
  }

  // Limited backfill: abort after BACKFILL_TX_LIMIT transactions.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('smoke timeout')), 180_000);
  const streamed: RawTransfer[] = [];
  let listed = 0;
  let fetched = 0;
  const bfStart = Date.now();
  const r0 = rpc.stats.requests;
  try {
    await adapter.backfill(ACTIVE, cursor, {
      signal: ctrl.signal,
      onBatch: (b) => void streamed.push(...b),
      onProgress: (p) => {
        if (p.stage === 'Listing signatures') listed = p.done ?? listed;
        if (p.stage === 'Fetching transactions') {
          fetched = p.done ?? fetched;
          if (fetched >= BACKFILL_TX_LIMIT) ctrl.abort(new Error('limit reached'));
        }
      },
    });
  } catch (err) {
    if (!ctrl.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  const bfMs = Date.now() - bfStart;
  console.log(
    `  [backfill (limited)] ${bfMs} ms, ${rpc.stats.requests - r0} HTTP requests; listed ${listed} signatures, fetched ${fetched} txs`,
  );
  check(
    streamed.length > 0,
    `backfill streamed ${streamed.length} transfers before abort (oldest slot ${streamed[0]?.blockHeight}, ${new Date((streamed[0]?.blockTime ?? 0) * 1000).toISOString()})`,
  );
  for (const t of streamed.slice(0, 5)) console.log(`    ${describe(t)}`);
  invariants(streamed, 'backfill');

  const someSig = streamed[0]?.txid ?? p1.transfers[0]?.txid;
  if (someSig) {
    const st = await step('getTxStatus', () => adapter.getTxStatus(someSig, ACTIVE));
    check(st.state === 'confirmed' && typeof st.blockTime === 'number', `getTxStatus(${someSig.slice(0, 10)}…) -> ${JSON.stringify(st)}`);
  }
  const unknown = await adapter.getTxStatus('5'.repeat(87), ACTIVE);
  check(unknown.state === 'unknown', `getTxStatus(bogus) -> ${unknown.state}`);

  // Reconciliation on small wallets with full history.
  for (const addr of SMALL) {
    console.log(`\nReconciliation: ${addr}`);
    const c = await adapter.initCursor(addr);
    const rows = await step('backfill (full)', () => adapter.backfill(addr, c));
    const balances = await adapter.getBalances(addr);
    const sums = new Map<string, bigint>();
    for (const r of rows) {
      if (r.status === 'failed' && !r.chargeFee) continue;
      const signed = r.direction === 'in' ? r.amount : r.direction === 'out' ? -r.amount : 0n;
      sums.set(r.assetKey, (sums.get(r.assetKey) ?? 0n) + signed);
      if (r.chargeFee && r.fee) sums.set('solana:native', (sums.get('solana:native') ?? 0n) - r.fee);
    }
    console.log(`    ${new Set(rows.map((r) => r.txid)).size} txs, ${rows.length} rows`);
    invariants(rows, 'reconciliation');
    for (const [key, live] of balances) {
      const derived = sums.get(key) ?? 0n;
      check(derived === live, `${key.slice(0, 20).padEnd(20)} history ${fmt(key, derived)} vs balance ${fmt(key, live)}`);
    }
  }

  console.log(`\nTotals: ${rpc.stats.requests} HTTP requests, ${rpc.stats.calls} RPC calls in ${Date.now() - t0} ms`);
  console.log(`  by host:   ${JSON.stringify(rpc.stats.byHost)}`);
  console.log(`  by method: ${JSON.stringify(rpc.stats.byMethod)}`);
  console.log(
    `  endpoint health: ${JSON.stringify([rpc.live, ...rpc.history].map((p) => ({ pool: p.name, h: p.health().map((e) => `${new URL(e.url).host}:${e.healthy ? 'ok' : 'cooling'}/${e.failures}`) })))}`,
  );
}

try {
  await main();
} catch (err) {
  failures++;
  console.error('Smoke test crashed:', err);
} finally {
  await closeHttp();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
