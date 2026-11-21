/**
 * Live smoke test for the EVM adapter (Ethereum, BSC, Polygon, Base).
 *
 *   node scripts/smoke/evm.ts [ethereum,bsc,polygon,base]
 *
 * Per network:
 *  1. getTip / getBalances / initCursor / poll on a busy, well-known address.
 *  2. Poll across a real, recent token transfer (cursor rewound to just before it): the tx must
 *     be reported and the transfers must reconcile exactly with the state change.
 *  3. Bounded backfill of a small address (found on the fly) and reconciliation of the computed
 *     history with the live state; request counts and timings for cost estimates.
 *  4. (BSC) a backfill of a huge address is aborted after a few seconds.
 * Exit code 1 if any check fails.
 */
import { createEvmAdapterInternal, type EvmAdapter } from '../../src/chains/evm/adapter.ts';
import { reconcile } from '../../src/chains/evm/aggregate.ts';
import { estimateProbes } from '../../src/chains/evm/bisect.ts';
import { fingerprint, parseFingerprint, probeAt, zeroState, type ChainState } from '../../src/chains/evm/probe.ts';
import { toHex } from '../../src/chains/evm/util.ts';
import { formatUnits } from '../../src/core/amount.ts';
import { EVM_NETWORKS, NETWORKS, type EvmNetworkId } from '../../src/core/networks.ts';
import type { RawTransfer } from '../../src/core/types.ts';
import { closeHttp } from '../../src/util/http.ts';

const BUSY: Record<EvmNetworkId, string> = {
  ethereum: '0x28C6c06298d514Db089934071355E5743bf21d60',
  bsc: '0x8894E0a0c962CB723c1976a4421c95949bE2D4E3',
  polygon: '0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245',
  base: '0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A',
};
/** How far back the rewound-cursor test looks for a token transfer (explorers must have indexed it). */
const LOOKBACK: Record<EvmNetworkId, number> = { ethereum: 15, polygon: 30, bsc: 40, base: 40 };
/** "Small address" = nothing tracked at tip - window (whole history is recent). */
const FRESH_WINDOW: Record<EvmNetworkId, number> = { ethereum: 0, polygon: 0, bsc: 1_000_000, base: 1_000_000 };
const MAX_PROBES = 400;
const BACKFILL_TIME_BUDGET_MS = 120_000;
const MAX_EXPLORER_REQUESTS = 30;

let failures = 0;
const lines: string[] = [];
function check(net: string, ok: boolean, what: string): void {
  const line = `${ok ? 'PASS' : 'FAIL'} ${net.padEnd(8)} ${what}`;
  if (!ok) failures++;
  lines.push(line);
  console.log(line);
}
const secs = (t0: number) => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hostSummary(a: EvmAdapter): string {
  const rpc = Object.entries(a.rpc.stats.byHost).map(([h, n]) => `${h}=${n}`);
  const ex = Object.entries(a.explorer()?.stats.byHost ?? {}).map(([h, n]) => `${h}=${n}`);
  return [...rpc, ...ex].join(' ');
}

interface Found {
  block: number;
  hash: string;
  from: string;
  recipient: string;
  others: string[];
}

/** Finds a recent `transfer(address,uint256)` call on a tracked token. */
async function findTokenTransfer(a: EvmAdapter, tip: number, back: number): Promise<Found | null> {
  const tokens = new Set(NETWORKS[a.network].tokens.map((t) => t.contract!));
  for (let off = 0; off < 40; off++) {
    const b = tip - back - off;
    const blk = (await a.rpc.call('block', b, 'eth_getBlockByNumber', [toHex(b), true])) as {
      transactions: Array<{ hash: string; from: string; to: string | null; input: string; value: string }>;
    };
    const transfers = blk.transactions.filter(
      (t) => t.to && tokens.has(t.to.toLowerCase()) && t.input.startsWith('0xa9059cbb') && t.input.length >= 138,
    );
    const tx = transfers[0];
    if (!tx) continue;
    const recipientOf = (input: string) => '0x' + input.slice(34, 74);
    const plain = blk.transactions.filter((t) => t.input === '0x' && BigInt(t.value) > 0n && t.to).map((t) => t.to!.toLowerCase());
    // More backfill candidates from a few neighbouring blocks.
    const extra: string[] = [];
    for (let k = 1; k <= 4; k++) {
      const nb = (await a.rpc.call('block', b - k * 7, 'eth_getBlockByNumber', [toHex(b - k * 7), true])) as typeof blk;
      for (const t of nb.transactions) {
        if (t.to && tokens.has(t.to.toLowerCase()) && t.input.startsWith('0xa9059cbb') && t.input.length >= 138)
          extra.push(recipientOf(t.input));
        else if (t.input === '0x' && BigInt(t.value) > 0n && t.to) extra.push(t.to.toLowerCase());
      }
    }
    return {
      block: b,
      hash: tx.hash.toLowerCase(),
      from: tx.from.toLowerCase(),
      recipient: recipientOf(tx.input),
      others: [...new Set([...transfers.slice(1).map((t) => recipientOf(t.input)), ...plain, ...extra])].slice(0, 40),
    };
  }
  return null;
}

function describeTransfer(net: EvmNetworkId, t: RawTransfer): string {
  const asset = [NETWORKS[net].native, ...NETWORKS[net].tokens].find((x) => x.key === t.assetKey)!;
  const fee = t.chargeFee && t.fee ? ` fee ${formatUnits(t.fee, 18)}` : '';
  return `${t.txid.slice(0, 12)} ${t.subId.slice(0, 14).padEnd(14)} ${t.direction.padEnd(4)} ${formatUnits(t.amount, asset.decimals)} ${asset.label ?? asset.asset}${fee} @${t.blockHeight}${t.status === 'failed' ? ' FAILED' : ''}${t.meta?.internal ? ' internal' : ''}${t.meta?.syntheticTxid ? ' synthetic' : ''}`;
}

async function smoke(net: EvmNetworkId): Promise<void> {
  const a = createEvmAdapterInternal(net);
  const tokens = NETWORKS[net].tokens.map((t) => t.contract!);

  // 1. Basics on a busy address.
  let t0 = Date.now();
  const tip = await a.getTip();
  check(net, tip > 1_000_000, `getTip ${tip} (${secs(t0)})`);
  t0 = Date.now();
  const bal = await a.getBalances(BUSY[net]);
  check(
    net,
    bal.size === 1 + tokens.length,
    `getBalances ${[...bal].map(([k, v]) => `${k.split(':')[1]!.slice(0, 8)}=${v}`).join(' ')} (${secs(t0)})`,
  );
  t0 = Date.now();
  const cur = await a.initCursor(BUSY[net]);
  check(net, typeof cur.block === 'number' && typeof cur.fp === 'string', `initCursor ${JSON.stringify(cur)} (${secs(t0)})`);
  await sleep(6_000);
  t0 = Date.now();
  const r0 = a.rpc.stats.requests;
  const e0 = a.explorer()?.stats.requests ?? 0;
  const p0 = await a.poll(BUSY[net], cur);
  check(
    net,
    (p0.cursor.block as number) >= (cur.block as number),
    `poll busy address: ${p0.transfers.length} transfers, cursor -> ${p0.cursor.block}${p0.cursor.retries ? ` (explorer retry ${p0.cursor.retries})` : ''}, ` +
      `${a.rpc.stats.requests - r0} rpc + ${(a.explorer()?.stats.requests ?? 0) - e0} explorer requests (${secs(t0)})`,
  );

  // 2. Poll across a real recent token transfer.
  const found = await findTokenTransfer(a, await a.getTip(), LOOKBACK[net]);
  if (!found) {
    check(net, false, 'no recent token transfer found for the rewound-cursor test');
    return;
  }
  const lo = found.block - 3;
  const before = await probeAt(a.rpc, found.from, tokens, lo);
  let cursor: Record<string, unknown> = { v: 1, block: lo, fp: fingerprint(before) };
  t0 = Date.now();
  const r1 = a.rpc.stats.requests;
  const e1 = a.explorer()?.stats.requests ?? 0;
  let polls = 0;
  const got: RawTransfer[] = [];
  for (;;) {
    const p = await a.poll(found.from, cursor);
    polls++;
    got.push(...p.transfers);
    cursor = p.cursor;
    if (!cursor.retries || polls >= 8) break;
    await sleep(5_000);
  }
  const after = parseFingerprint(cursor.fp, tokens.length)!;
  const problems = reconcile(net, before, after, got);
  check(
    net,
    got.some((t) => t.txid === found.hash) && problems.length === 0,
    `poll across ${found.hash.slice(0, 12)} from ${found.from.slice(0, 10)} (${lo}..${cursor.block}): ${got.length} transfers in ${polls} poll(s), ` +
      `${a.rpc.stats.requests - r1} rpc + ${(a.explorer()?.stats.requests ?? 0) - e1} explorer requests (${secs(t0)})` +
      (problems.length ? ` RECONCILE: ${problems.join('; ')}` : ', reconciles'),
  );
  for (const t of got.slice(0, 4)) console.log(`           ${describeTransfer(net, t)}`);

  // 3. Bounded backfill of a small address.
  const bf = createEvmAdapterInternal(net, { maxProbes: MAX_PROBES, maxExplorerRequests: MAX_EXPLORER_REQUESTS });
  const tipNow = await bf.getTip();
  let target: string | null = null;
  let fallback: string | null = null;
  const empty = fingerprint(zeroState(tokens.length));
  const candidates = [...new Set([found.recipient, ...found.others, found.from])];
  for (const c of candidates.slice(0, 30)) {
    if (!/^0x[0-9a-f]{40}$/.test(c)) continue;
    const now = await probeAt(bf.rpc, c, tokens, 'latest');
    if (now.nonce > 20n) continue;
    if (FRESH_WINDOW[net] === 0) {
      target = c;
      break;
    }
    // Empty 1M blocks ago = short history; empty 200k blocks ago too = very short (preferred).
    if (fingerprint(await probeAt(bf.rpc, c, tokens, tipNow - FRESH_WINDOW[net])) !== empty) continue;
    if (fingerprint(await probeAt(bf.rpc, c, tokens, tipNow - FRESH_WINDOW[net] / 5)) === empty) {
      target = c;
      break;
    }
    fallback ??= c;
  }
  target ??= fallback;
  if (!target) {
    check(net, false, 'no small address found for the backfill test');
    return;
  }
  const boundary = await bf.initCursor(target);
  const boundaryState = parseFingerprint(boundary.fp, tokens.length) as ChainState;
  t0 = Date.now();
  let batches = 0;
  let lastProgress = '';
  try {
    const hist = await bf.backfill(target, boundary, {
      // Wall-clock bound: a "fresh" address can still be very busy.
      signal: AbortSignal.timeout(BACKFILL_TIME_BUDGET_MS),
      onBatch: () => void batches++,
      onProgress: (p) => {
        lastProgress = `${p.stage} ${((p.fraction ?? 0) * 100).toFixed(1)}%`;
      },
    });
    const rec = reconcile(net, zeroState(tokens.length), boundaryState, hist);
    const changes = new Set(hist.map((t) => t.blockHeight)).size;
    check(
      net,
      rec.length === 0,
      `backfill ${target} (nonce ${boundaryState.nonce}) to ${boundary.block}: ${hist.length} transfers, ${changes} blocks, ${batches} batches, ` +
        `${bf.rpc.stats.requests} rpc + ${bf.explorer()?.stats.requests ?? 0} explorer requests, ${secs(t0)} [${lastProgress}]` +
        (rec.length ? ` RECONCILE: ${rec.join('; ')}` : ', reconciles with live state'),
    );
    for (const t of hist.slice(0, 5)) console.log(`           ${describeTransfer(net, t)}`);
    if (!bf.explorer() && changes > 0) {
      const perProbeMs = (Date.now() - t0) / Math.max(1, bf.rpc.stats.byCategory.state ?? 1);
      const est = (k: number) => estimateProbes(tipNow, k);
      console.log(
        `           cost model: ${bf.rpc.stats.byCategory.state ?? 0} state requests for ${changes} change blocks over ${boundary.block} blocks; ` +
          `~${perProbeMs.toFixed(0)} ms wall per probe; estimate 10/100/1000 changes -> ~${est(10)}/${est(100)}/${est(1000)} probes ` +
          `+ ~3 requests per change block`,
      );
    }
  } catch (err) {
    const e = err as Error;
    const budget = /budget/.test(e.message) || e.name === 'TimeoutError';
    check(
      net,
      budget,
      `backfill ${target} stopped (bounded work, address too busy for a full run): ${e.message} after ${secs(t0)}, ` +
        `${bf.rpc.stats.requests} rpc requests, ${batches} batches delivered [${lastProgress}]`,
    );
  }
  console.log(`           requests by host: ${hostSummary(bf)}`);

  // 4. Abort: a huge address must stop promptly.
  if (net === 'bsc') {
    const ab = createEvmAdapterInternal(net);
    const boundaryBusy = await ab.initCursor(BUSY[net]);
    const ctrl = new AbortController();
    t0 = Date.now();
    setTimeout(() => ctrl.abort(new Error('smoke abort')), 6_000);
    let aborted = false;
    try {
      await ab.backfill(BUSY[net], boundaryBusy, { signal: ctrl.signal });
    } catch (err) {
      aborted = (err as Error).message === 'smoke abort';
    }
    check(
      net,
      aborted && Date.now() - t0 < 30_000,
      `backfill of a huge address aborted after ${secs(t0)} (${ab.rpc.stats.requests} requests)`,
    );
  }
}

const nets = (process.argv[2]?.split(',') ?? [...EVM_NETWORKS]) as EvmNetworkId[];
const started = Date.now();
const results = await Promise.allSettled(nets.map((n) => smoke(n)));
results.forEach((r, i) => {
  if (r.status === 'rejected') check(nets[i]!, false, `crashed: ${(r.reason as Error)?.stack ?? String(r.reason)}`);
});
console.log(`\n===== EVM smoke summary (${secs(started)}) =====`);
for (const l of lines) console.log(l);
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
await closeHttp();
process.exit(failures ? 1 : 0);
