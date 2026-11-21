import { NETWORKS, type EvmNetworkId } from '../../core/networks.ts';
import type { RawTransfer } from '../../core/types.ts';
import { bisect, type BisectProgress, type BisectResult, type Interval } from './bisect.ts';
import { fingerprint, zeroState, type ChainState } from './probe.ts';

/**
 * Explorer-guided verification.
 *
 * Known transfers (from an explorer) imply a state at every block. The difference
 * "chain state - implied state" is piecewise constant and only changes at blocks the known
 * transfers do not fully explain (explorer lag, credits explorers never list). Bisecting on
 * that difference finds exactly those blocks, which are then re-derived from RPC data.
 */

/** Cumulative effect of known transfers with blockHeight <= block. */
export interface EffectIndex {
  at(block: number): ChainState;
}

export function buildEffectIndex(network: EvmNetworkId, transfers: readonly RawTransfer[], sentBlocks: readonly number[]): EffectIndex {
  const info = NETWORKS[network];
  const tokenIdx = new Map(info.tokens.map((t, i) => [t.key, i]));
  const n = info.tokens.length;
  const perBlock = new Map<number, ChainState>();
  const get = (b: number): ChainState => {
    let s = perBlock.get(b);
    if (!s) perBlock.set(b, (s = zeroState(n)));
    return s;
  };
  for (const t of transfers) {
    if (t.blockHeight === null || t.status === 'pending') continue;
    const s = get(t.blockHeight);
    const signed = t.status === 'failed' ? 0n : t.direction === 'in' ? t.amount : t.direction === 'out' ? -t.amount : 0n;
    if (t.assetKey === info.native.key) s.balance += signed;
    else {
      const i = tokenIdx.get(t.assetKey);
      if (i !== undefined) s.tokens[i]! += signed;
    }
    if (t.chargeFee && t.fee) s.balance -= t.fee;
  }
  for (const b of sentBlocks) get(b).nonce += 1n;
  const blocks = [...perBlock.keys()].sort((a, b) => a - b);
  // Prefix sums
  const prefix: ChainState[] = [];
  let acc = zeroState(n);
  for (const b of blocks) {
    const d = perBlock.get(b)!;
    acc = { nonce: acc.nonce + d.nonce, balance: acc.balance + d.balance, tokens: acc.tokens.map((v, i) => v + d.tokens[i]!) };
    prefix.push(acc);
  }
  return {
    at(block: number): ChainState {
      // last index with blocks[i] <= block
      let lo = 0;
      let hi = blocks.length - 1;
      let idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (blocks[mid]! <= block) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return idx < 0 ? zeroState(n) : prefix[idx]!;
    },
  };
}

export function subtractState(a: ChainState, b: ChainState): ChainState {
  return { nonce: a.nonce - b.nonce, balance: a.balance - b.balance, tokens: a.tokens.map((v, i) => v - (b.tokens[i] ?? 0n)) };
}

export interface DiscrepancyParams {
  network: EvmNetworkId;
  lo: number;
  hi: number;
  /** Chain state at lo and hi. */
  loState: ChainState;
  hiState: ChainState;
  /** Known transfers in (lo, hi] and the blocks of the txs the address sent in that range. */
  known: readonly RawTransfer[];
  sentBlocks: readonly number[];
  probe: (block: number, signal?: AbortSignal) => Promise<ChainState>;
  /** RPC analysis of one block (complete replacement for that block's known transfers). */
  analyze: (block: number, before: ChainState, after: ChainState, signal?: AbortSignal) => Promise<RawTransfer[]>;
  /** Optional first split point (e.g. the last block the explorer knows about); probed. */
  pivot?: number;
  /** A split point whose chain state is already known (an interrupted earlier scan); no probe. */
  split?: { block: number; state: ChainState };
  concurrency?: number;
  signal?: AbortSignal;
  maxProbes?: number;
  /** Stop at this time (epoch ms) and report the frontier instead of finishing. */
  deadline?: number;
  retryDelaysMs?: readonly number[];
  onProgress?: (p: BisectProgress) => void;
}

export interface DiscrepancyResult {
  /** Known transfers with the unexplained blocks replaced by their RPC analysis, sorted by block. */
  transfers: RawTransfer[];
  /** Blocks whose known transfers were replaced (merged rows, see mergeRepairedBlock). */
  replaced: Map<number, RawTransfer[]>;
  /** Known rows that no longer belong anywhere, as amount-0 rows (re-emit to cancel them). */
  retracted: RawTransfer[];
  probes: number;
  /**
   * Lowest unprocessed range (raw chain states) when the scan stopped early (deadline, budget,
   * persistent failures); null when complete. Only results <= firstUnresolved.lo are final.
   */
  firstUnresolved: Interval<ChainState> | null;
  stopped?: BisectResult['stopped'];
  error?: unknown;
}

export async function discrepancyScan(p: DiscrepancyParams): Promise<DiscrepancyResult> {
  const inRange = p.known.filter((t) => t.blockHeight !== null && t.blockHeight > p.lo && t.blockHeight <= p.hi);
  const idx = buildEffectIndex(
    p.network,
    inRange,
    p.sentBlocks.filter((b) => b > p.lo && b <= p.hi),
  );
  interface S {
    state: ChainState;
    key: string;
  }
  const mk = (block: number, state: ChainState): S => ({ state, key: fingerprint(subtractState(state, idx.at(block))) });
  const replaced = new Map<number, RawTransfer[]>();
  const retracted: RawTransfer[] = [];
  const knownByBlock = new Map<number, RawTransfer[]>();
  for (const t of inRange) {
    const list = knownByBlock.get(t.blockHeight!) ?? [];
    list.push(t);
    knownByBlock.set(t.blockHeight!, list);
  }
  let probes = 0;
  const probe = async (b: number, signal?: AbortSignal): Promise<S> => mk(b, await p.probe(b, signal));

  const loS = mk(p.lo, p.loState);
  const hiS = mk(p.hi, p.hiState);
  let unresolved: Interval<S>[] = [];
  let stopped: BisectResult['stopped'];
  let error: unknown;
  const split = p.split && p.split.block > p.lo && p.split.block < p.hi ? p.split : null;
  if (loS.key !== hiS.key || split) {
    let intervals: Interval<S>[] = [{ lo: p.lo, hi: p.hi, loState: loS, hiState: hiS }];
    if (split) {
      const mid = mk(split.block, split.state);
      intervals = [
        { lo: p.lo, hi: split.block, loState: loS, hiState: mid },
        { lo: split.block, hi: p.hi, loState: mid, hiState: hiS },
      ];
    } else if (p.pivot !== undefined && p.pivot > p.lo + 1 && p.pivot < p.hi - 1) {
      // Most discrepancies are at the edge (explorer lag): split at the last known block first.
      probes++;
      const mid = await probe(p.pivot, p.signal);
      intervals = [
        { lo: p.lo, hi: p.pivot, loState: loS, hiState: mid },
        { lo: p.pivot, hi: p.hi, loState: mid, hiState: hiS },
      ];
    }
    const r = await bisect<S>({
      intervals,
      key: (s) => s.key,
      probe,
      concurrency: p.concurrency ?? 2,
      ...(p.signal ? { signal: p.signal } : {}),
      ...(p.maxProbes !== undefined ? { maxProbes: Math.max(1, p.maxProbes - probes) } : {}),
      ...(p.deadline !== undefined ? { deadline: p.deadline } : {}),
      ...(p.retryDelaysMs ? { retryDelaysMs: p.retryDelaysMs } : {}),
      ...(p.onProgress ? { onProgress: p.onProgress } : {}),
      onChange: async (block, before, after, signal) => {
        const merged = mergeRepairedBlock(knownByBlock.get(block) ?? [], await p.analyze(block, before.state, after.state, signal));
        replaced.set(block, merged.rows);
        retracted.push(...merged.retract);
      },
    });
    probes += r.probes;
    unresolved = r.unresolved;
    stopped = r.stopped;
    error = r.error;
  }
  const transfers = [...inRange.filter((t) => !replaced.has(t.blockHeight!)), ...[...replaced.values()].flat()];
  transfers.sort((a, b) => (a.blockHeight ?? 0) - (b.blockHeight ?? 0));
  const first = unresolved[0];
  return {
    transfers,
    replaced,
    retracted,
    probes,
    firstUnresolved: first ? { lo: first.lo, hi: first.hi, loState: first.loState.state, hiState: first.hiState.state } : null,
    ...(stopped ? { stopped } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

const rowKey = (t: RawTransfer): string => `${t.txid}|${t.subId}`;
const signedAmount = (t: RawTransfer): bigint => (t.direction === 'in' ? t.amount : t.direction === 'out' ? -t.amount : 0n);

/**
 * Combines the explorer rows of a repaired block with its RPC analysis (which reconciles the
 * block exactly) while keeping txids stable:
 * - a key present in both takes the RPC version (callers re-emit it: upsert by txid/subId);
 * - an explorer-only row (e.g. an internal credit inside someone else's tx, which RPC can only
 *   book as "block:<n>:internal") is kept and the synthetic row of that asset is reduced by it;
 * - when nothing can absorb it, the explorer-only row is retracted (amount 0) so the block is
 *   not counted twice.
 */
export function mergeRepairedBlock(
  known: readonly RawTransfer[],
  rpc: readonly RawTransfer[],
): { rows: RawTransfer[]; retract: RawTransfer[] } {
  const rows = rpc.map((t) => ({ ...t, ...(t.meta ? { meta: { ...t.meta } } : {}) }));
  const rpcKeys = new Set(rows.map(rowKey));
  const retract: RawTransfer[] = [];
  const onlyKnown = known.filter((t) => !rpcKeys.has(rowKey(t)));
  const byAsset = new Map<string, RawTransfer[]>();
  for (const t of onlyKnown) {
    // A fee charged by a row RPC did not reproduce cannot be absorbed safely.
    if (t.chargeFee && t.fee) {
      retract.push(t);
      continue;
    }
    byAsset.set(t.assetKey, [...(byAsset.get(t.assetKey) ?? []), t]);
  }
  for (const [assetKey, list] of byAsset) {
    const absorb = list.reduce((s, t) => s + signedAmount(t), 0n);
    const synthetic = rows.find((r) => r.assetKey === assetKey && r.txid.startsWith('block:') && !r.chargeFee);
    if (absorb === 0n) {
      rows.push(...list);
      continue;
    }
    if (!synthetic) {
      retract.push(...list);
      continue;
    }
    const left = signedAmount(synthetic) - absorb;
    if (left === 0n) rows.splice(rows.indexOf(synthetic), 1);
    else {
      synthetic.amount = left > 0n ? left : -left;
      synthetic.direction = left > 0n ? 'in' : 'out';
    }
    rows.push(...list);
  }
  return {
    rows: rows.sort((a, b) => (a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0)),
    retract: retract.map((t) => ({ ...t, amount: 0n, chargeFee: false, meta: { ...t.meta, superseded: true } })),
  };
}
