/**
 * Live smoke test for the XRP Ledger adapter (keyless public servers).
 *   node scripts/smoke/xrp.ts
 *
 * Checks getTip, getBalances, initCursor, poll, backfill (with exact balance reconciliation against
 * account_info at the boundary ledger), cross-server consistency, and getTxStatus.
 */
import { createXrpAdapter } from '../../src/chains/xrp/adapter.ts';
import { DEFAULT_XRPL_ENDPOINTS, XrplError, getXrplStats, httpTransport, xrplCall } from '../../src/chains/xrp/rpc.ts';
import { formatUnits } from '../../src/core/amount.ts';
import type { RawTransfer } from '../../src/core/types.ts';
import { closeHttp, EndpointPool, HttpError } from '../../src/util/http.ts';

const ACCOUNTS = [
  { address: 'rHjzYmzfj1ArvmxcVJgKZSSCgoqt8VJrmo', why: '74 txs since 2013 (full history): offers, trust lines, escrow' },
  { address: 'rLNkttBqhomaaGxpoy3tBMYM2mUV2Q1xGR', why: 'created and deleted twice (AccountDelete): must reconcile to 0' },
  { address: 'rLQFZ2FFMjHoxSDWbbJneWneTVMNXjFLas', why: 'active payment account' },
  { address: 'rputin6xDmCdtC6oLsXYUtLpzfSmYrvqQJ', why: '~1200 txs, multi-page: OfferCreate/TrustSet/Payment' },
];

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
}

function signed(t: RawTransfer): bigint {
  const v = t.direction === 'in' ? t.amount : t.direction === 'out' ? -t.amount : 0n;
  return v - (t.chargeFee ? (t.fee ?? 0n) : 0n);
}

const xrp = (drops: bigint) => `${formatUnits(drops, 6)} XRP`;

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    console.log(`  [${label}: ${Math.round(performance.now() - t0)} ms]`);
  }
}

const balancePool = new EndpointPool('xrp-smoke', DEFAULT_XRPL_ENDPOINTS);

/** Balance at a specific validated ledger (0 when the account does not exist there). */
async function balanceAt(address: string, ledger: number): Promise<bigint> {
  try {
    const r = await balancePool.run((url) =>
      xrplCall(httpTransport, url, 'account_info', { account: address, ledger_index: ledger }, { expect: ['actNotFound'] }),
    );
    const data = r.account_data as { Balance?: string } | undefined;
    return BigInt(data?.Balance ?? 'x');
  } catch (err) {
    if (err instanceof XrplError && err.code === 'actNotFound') return 0n;
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const toJson = (rows: RawTransfer[]) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** xrplcluster answers tooBusy when its per-IP units quota (10000 / 60 s) is used up: wait once. */
async function withQuotaRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof XrplError && err.code === 'tooBusy')) throw err;
    console.log('  (tooBusy: waiting 60 s for the xrplcluster quota)');
    await sleep(60_000);
    return fn();
  }
}

async function main(): Promise<void> {
  const adapter = createXrpAdapter();

  console.log('getTip');
  const tip = await timed('getTip', () => adapter.getTip());
  check(Number.isSafeInteger(tip) && tip > 100_000_000, 'validated ledger index', String(tip));

  console.log('getBalances (unfunded address)');
  const unfunded = await timed('getBalances', () => adapter.getBalances('rEjjKetQ168doKmb6q3B1rNUHAAxrwcE2c'));
  check(unfunded.get('xrp:native') === 0n && unfunded.size === 1, 'actNotFound -> 0');

  const statusSamples: RawTransfer[] = [];
  const backfilled = new Map<string, { boundary: number; json: string }>();
  for (const { address, why } of ACCOUNTS) {
    console.log(`\n${address} (${why})`);
    const boundary = await timed('initCursor', () => adapter.initCursor(address));
    let batches = 0;
    let lastFraction = 0;
    let monotonic = true;
    const rows = await timed('backfill', () =>
      adapter.backfill(address, boundary, {
        onBatch: () => {
          batches++;
        },
        onProgress: (p) => {
          if (p.fraction !== undefined) {
            if (p.fraction < lastFraction) monotonic = false;
            lastFraction = p.fraction;
          }
        },
      }),
    );
    const sum = rows.reduce((s, r) => s + signed(r), 0n);
    const expected = await balanceAt(address, boundary.ledger as number);
    const fees = rows.filter((r) => r.chargeFee).reduce((s, r) => s + (r.fee ?? 0n), 0n);
    const counts = rows.reduce<Record<string, number>>((m, r) => {
      const k = `${String(r.meta?.txType)}/${r.direction}${r.status === 'failed' ? '/failed' : ''}`;
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {});
    console.log(`  ${rows.length} rows in ${batches} batches, fees paid ${xrp(fees)}: ${JSON.stringify(counts)}`);
    check(sum === expected, 'reconciliation: sum(in) - sum(out) - fees == balance at boundary', `${xrp(sum)} vs ${xrp(expected)}`);
    check(monotonic && lastFraction === 1, 'progress monotonic and ends at 1');
    check(new Set(rows.map((r) => r.txid)).size === rows.length, 'one row per transaction');
    check(
      rows.every((r) => r.blockHeight! <= (boundary.ledger as number)),
      'no rows beyond the boundary',
    );
    check(
      rows.every((r, i) => i === 0 || r.blockHeight! >= rows[i - 1]!.blockHeight!),
      'rows in ledger order',
    );
    backfilled.set(address, { boundary: boundary.ledger as number, json: toJson(rows) });

    const live = await timed('getBalances', () => adapter.getBalances(address));
    console.log(`  live balance ${xrp(live.get('xrp:native') ?? -1n)} (boundary ${xrp(expected)})`);

    // Poll from an older cursor must return exactly the backfilled rows after it (plus anything newer).
    if (rows.length >= 3) {
      const from = rows[rows.length - 3]!.blockHeight! - 1;
      const polled = await timed('poll (old cursor)', () => adapter.poll(address, { ledger: from }));
      const want = rows.filter((r) => r.blockHeight! > from);
      const got = new Map(polled.transfers.map((t) => [t.txid, t]));
      check(
        want.every((w) => got.get(w.txid)?.amount === w.amount && got.get(w.txid)?.chargeFee === w.chargeFee),
        'poll returns the same rows as backfill after the cursor',
        `${want.length} expected, ${polled.transfers.length} returned`,
      );
      check((polled.cursor.ledger as number) >= (boundary.ledger as number), 'poll cursor reaches the validated tip');
    }
    statusSamples.push(...rows.slice(0, 1), ...rows.filter((r) => r.status === 'failed').slice(0, 1));
  }

  // Forced failover in the middle of a multi-page backfill: clio (exclusive markers) -> rippled
  // (inclusive markers). The result must be identical to the normal backfill.
  console.log('\nForced failover mid-backfill (s2 fails on its 2nd account_tx page -> xrplcluster)');
  const big = ACCOUNTS[3]!.address;
  const ref3 = backfilled.get(big)!;
  let s2Pages = 0;
  const flaky = createXrpAdapter({
    endpoints: ['https://s2.ripple.com:51234/', 'https://xrplcluster.com/'],
    transport: (url, method, params, opts) => {
      if (url.includes('s2.ripple.com') && method === 'account_tx' && ++s2Pages === 2) {
        return Promise.reject(new HttpError('simulated outage', 503, url, true));
      }
      return httpTransport(url, method, params, opts);
    },
  });
  const failoverRows = await timed('backfill with failover', () => withQuotaRetry(() => flaky.backfill(big, { ledger: ref3.boundary })));
  check(toJson(failoverRows) === ref3.json, 'identical rows after failover', `${failoverRows.length} rows`);

  // Every endpoint on its own must produce identical rows (rippled vs clio, API v2).
  console.log('\nCross-server consistency (each endpoint alone, same boundary)');
  const ref = ACCOUNTS[0]!.address;
  const ref0 = backfilled.get(ref)!;
  for (const url of DEFAULT_XRPL_ENDPOINTS) {
    const single = createXrpAdapter({ endpoints: [url] });
    const rows = await timed(new URL(url).host, () => withQuotaRetry(() => single.backfill(ref, { ledger: ref0.boundary })));
    check(toJson(rows) === ref0.json, `${new URL(url).host} matches`, `${rows.length} rows`);
  }

  console.log('\nLive poll');
  const liveAddr = ACCOUNTS[2]!.address;
  const c0 = await adapter.initCursor(liveAddr);
  await sleep(9_000);
  const p1 = await timed('poll', () => adapter.poll(liveAddr, c0));
  check(
    (p1.cursor.ledger as number) > (c0.ledger as number),
    'cursor advanced',
    `${String(c0.ledger)} -> ${String(p1.cursor.ledger)}, ${p1.transfers.length} new`,
  );
  const p2 = await timed('poll (immediately again)', () => adapter.poll(liveAddr, p1.cursor));
  check((p2.cursor.ledger as number) >= (p1.cursor.ledger as number), 'immediate re-poll does not error or go backwards');

  console.log('\ngetTxStatus');
  for (const r of statusSamples.slice(0, 4)) {
    const s = await timed('getTxStatus', () => adapter.getTxStatus(r.txid, ''));
    check(
      s.state === r.status && s.blockHeight === r.blockHeight,
      `${r.txid.slice(0, 12)}... ${s.state}`,
      `ledger ${String(s.blockHeight)}`,
    );
  }
  const missing = await adapter.getTxStatus('0'.repeat(64), '');
  check(missing.state === 'unknown', 'unknown hash -> unknown');
}

function printStats(started: number): void {
  console.log('\nRequests (method@host: count, errors, avg ms, max ms)');
  let total = 0;
  for (const [k, s] of Object.entries(getXrplStats()).sort()) {
    total += s.count;
    console.log(
      `  ${k.padEnd(44)} ${String(s.count).padStart(4)} ${String(s.errors).padStart(3)} ${String(Math.round(s.totalMs / s.count)).padStart(6)} ${String(s.maxMs).padStart(6)}`,
    );
  }
  console.log(`  total ${total} requests in ${Math.round((performance.now() - started) / 1000)} s`);
}

const t0 = performance.now();
main()
  .catch((err) => {
    console.error('smoke test crashed:', err);
    failures++;
  })
  .finally(async () => {
    printStats(t0);
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exitCode = failures ? 1 : 0;
    await closeHttp();
  });
