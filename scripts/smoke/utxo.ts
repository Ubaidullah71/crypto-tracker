/**
 * Live smoke test for the UTXO adapter (Bitcoin + Litecoin). Network access required.
 *   node scripts/smoke/utxo.ts
 * Exits with code 1 when a check fails.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { formatUnits } from '../../src/core/amount.ts';
import type { ChainAdapter, Cursor, RawTransfer } from '../../src/core/types.ts';
import { createUtxoAdapter } from '../../src/chains/utxo/adapter.ts';
import { balanceDelta } from '../../src/chains/utxo/transfers.ts';
import { closeHttp } from '../../src/util/http.ts';

interface SmokeCase {
  network: 'bitcoin' | 'litecoin';
  /** Small addresses (public / seen in recent blocks) whose full history is reconciled. */
  small: string[];
  /** A heavy address for the limited (aborted) backfill. */
  heavy: string;
}

const CASES: SmokeCase[] = [
  {
    network: 'bitcoin',
    small: ['bc1q3v93q22sjrdsljxkmc4rnqnzy7ngh3gy59km5m', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    heavy: '19Tyrb48juLk4owHhDG1CoMu4V4Ai5VAn2',
  },
  {
    network: 'litecoin',
    small: ['LNWP23WrKkFmmfGPB7WsnKuWPsGtrYWyv9', 'MTsnjEsq511LSgKyx8NZA8U9nrMm7TSZ2A'],
    // Busy public address seen in a recent block (19k+ txs).
    heavy: 'Lhuuz1MUgo6q8uEATyY2Adw3JnZaTehdQ2',
  },
];

/** Every outgoing HTTP request (undici diagnostics channel), to verify that idle polls stay cheap. */
const requests: string[] = [];
diagnosticsChannel.subscribe('undici:request:create', (msg) => {
  const r = (msg as { request?: { origin?: unknown; path?: unknown; method?: unknown } }).request;
  if (r?.method === 'CONNECT') return; // proxy tunnel (PROXY_URL), not an API call
  requests.push(`${String(r?.origin)}${String(r?.path)}`);
});
const TX_LIST_RE = /details=txs|\/txs(\/|$|\?)/;
const short = (u: string) => u.replace(/^https?:\/\//, '').slice(0, 90);

const UNKNOWN_TXID = 'f'.repeat(63) + '0';
let failures = 0;

function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
}

function fmt(v: bigint): string {
  return formatUnits(v, 8);
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const r = await fn();
  return [r, Math.round(performance.now() - t0)];
}

/** history + live transfers, deduplicated by (txid, subId) with later rows winning (tracker upsert). */
function merge(...lists: RawTransfer[][]): Map<string, RawTransfer> {
  const m = new Map<string, RawTransfer>();
  for (const list of lists) for (const t of list) m.set(`${t.txid}:${t.subId}`, t);
  return m;
}

async function reconcile(
  adapter: ChainAdapter,
  address: string,
): Promise<{ confirmedTx: RawTransfer | null; pendingTx: RawTransfer | null }> {
  const key = `${adapter.network}:native`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const cursor: Cursor = await adapter.initCursor(address);
    let batches = 0;
    let lastFraction: number | undefined;
    const [history, backfillMs] = await timed(() =>
      adapter.backfill(address, cursor, {
        onBatch: () => {
          batches++;
        },
        onProgress: (p) => {
          lastFraction = p.fraction;
        },
      }),
    );
    const [p1, poll1Ms] = await timed(() => adapter.poll(address, cursor));
    const before = requests.length;
    const [p2, poll2Ms] = await timed(() => adapter.poll(address, p1.cursor));
    const poll2Requests = requests.slice(before);
    const p1Pending = Array.isArray(p1.cursor.pending) ? p1.cursor.pending.length : 0;
    const balances = await adapter.getBalances(address);
    const balance = balances.get(key) ?? -1n;
    const rows = merge(history, p1.transfers, p2.transfers);
    let sum = 0n;
    for (const t of rows.values()) sum += balanceDelta(t);
    const pending = [...rows.values()].filter((t) => t.status === 'pending');
    const counts = { in: 0, out: 0, self: 0, charged: 0 };
    for (const t of rows.values()) {
      counts[t.direction]++;
      if (t.chargeFee) counts.charged++;
    }
    console.log(
      `  ${address}: ${history.length} history rows in ${batches} batch(es) (${backfillMs} ms, progress ${lastFraction}), ` +
        `poll1 ${p1.transfers.length} rows (${poll1Ms} ms), poll2 ${p2.transfers.length} rows (${poll2Ms} ms), pending ${pending.length}`,
    );
    console.log(
      `    in ${counts.in} / out ${counts.out} / self ${counts.self} / fee-charged ${counts.charged}; cursor ${JSON.stringify(p2.cursor)}`,
    );
    if (p1Pending === 0) {
      const fetchedTxs = poll2Requests.some((u) => TX_LIST_RE.test(u));
      check(
        !fetchedTxs || p2.cursor.fp !== p1.cursor.fp,
        `idle poll short-circuit ${address}`,
        `${poll2Requests.length} request(s): ${poll2Requests.map(short).join(', ')}`,
      );
    }
    if (sum === balance || attempt === 2) {
      check(sum === balance, `reconcile ${address}`, `sum(in - out - charged fees) = ${fmt(sum)}, API balance = ${fmt(balance)}`);
      const confirmedTx = history.find((t) => t.status === 'confirmed') ?? null;
      return { confirmedTx, pendingTx: pending[0] ?? null };
    }
    console.log(`    mismatch (${fmt(sum)} vs ${fmt(balance)}), retrying once in case a tx arrived meanwhile`);
  }
  return { confirmedTx: null, pendingTx: null };
}

async function limitedBackfill(adapter: ChainAdapter, address: string): Promise<void> {
  const tip = await adapter.getTip();
  const ctrl = new AbortController();
  let batches = 0;
  let rows = 0;
  let progress = '';
  const t0 = performance.now();
  try {
    await adapter.backfill(
      address,
      { height: tip },
      {
        signal: ctrl.signal,
        onBatch: (b) => {
          batches++;
          rows += b.length;
          if (batches >= 2) ctrl.abort(new Error('smoke: enough pages'));
        },
        onProgress: (p) => {
          progress = `${p.done ?? '?'}/${p.total ?? '?'} (${p.fraction?.toFixed(3) ?? '?'})`;
        },
      },
    );
    check(false, `limited backfill ${address}`, 'expected an abort');
  } catch (err) {
    const aborted = ctrl.signal.aborted;
    check(
      aborted,
      `limited backfill ${address}`,
      `${batches} batches, ${rows} rows, progress ${progress}, ${Math.round(performance.now() - t0)} ms, ${aborted ? 'aborted as requested' : String(err)}`,
    );
  }
}

async function main(): Promise<void> {
  for (const c of CASES) {
    const adapter = createUtxoAdapter(c.network);
    console.log(`\n== ${c.network}`);
    const [tip, tipMs] = await timed(() => adapter.getTip());
    check(Number.isSafeInteger(tip) && tip > 0, 'getTip', `${tip} (${tipMs} ms incl. provider probes)`);

    let confirmed: RawTransfer | null = null;
    let pending: RawTransfer | null = null;
    for (const address of c.small) {
      try {
        const r = await reconcile(adapter, address);
        confirmed ??= r.confirmedTx;
        pending ??= r.pendingTx;
      } catch (err) {
        check(false, `reconcile ${address}`, String(err));
      }
    }

    await limitedBackfill(adapter, c.heavy);

    if (confirmed) {
      const s = await adapter.getTxStatus(confirmed.txid, c.small[0] as string);
      check(
        s.state === 'confirmed' && s.blockHeight === confirmed.blockHeight,
        'getTxStatus confirmed',
        `${confirmed.txid.slice(0, 12)}... -> ${JSON.stringify(s)}`,
      );
    }
    if (pending) {
      const s = await adapter.getTxStatus(pending.txid, c.small[0] as string);
      check(s.state === 'pending' || s.state === 'confirmed', 'getTxStatus pending', `${pending.txid.slice(0, 12)}... -> ${s.state}`);
    }
    const [unknown, unknownMs] = await timed(() => adapter.getTxStatus(UNKNOWN_TXID, c.small[0] as string));
    check(unknown.state === 'dropped', 'getTxStatus unknown txid', `${unknown.state} (${unknownMs} ms)`);

    const rates = [0.05, 1, 2, 5, 20];
    const etas: string[] = [];
    for (const r of rates) {
      const s = await adapter.estimateConfirmationSeconds?.(r);
      etas.push(`${r}/vB -> ${s === null || s === undefined ? 'null' : `${s}s`}`);
    }
    const high = await adapter.estimateConfirmationSeconds?.(500);
    check(typeof high === 'number' && high > 0, 'estimateConfirmationSeconds', etas.join(', '));
  }
}

const started = performance.now();
try {
  await main();
} catch (err) {
  failures++;
  console.error('smoke test crashed:', err);
} finally {
  await closeHttp();
}
const perHost = new Map<string, number>();
for (const u of requests) {
  const host = short(u).split('/')[0] as string;
  perHost.set(host, (perHost.get(host) ?? 0) + 1);
}
console.log(
  `\nHTTP requests: ${requests.length} in ${Math.round((performance.now() - started) / 1000)} s (${[...perHost].map(([h, n]) => `${h} ${n}`).join(', ')})`,
);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
