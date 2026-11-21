/** Transaction status across providers (pending -> confirmed / dropped). */
import type { TxStatusResult } from '../../core/types.ts';
import { sleep } from '../../util/async.ts';
import type { TxLookup } from './types.ts';

export interface TxStatusSource {
  id: string;
  /** False for a Blockbook with an incomplete mempool: its "not found" proves nothing on its own. */
  mempoolOk: boolean;
  client: { tx(txid: string, signal?: AbortSignal): Promise<TxLookup> };
}

export interface ResolveTxStatusOptions {
  signal?: AbortSignal;
  /** Pause before asking the only complete-mempool provider a second time. */
  recheckMs?: number;
  onError?: (sourceId: string, err: unknown) => void;
}

type Found = Extract<TxLookup, { found: true }>;

function foundResult(r: Found): TxStatusResult {
  return r.confirmed ? { state: 'confirmed', blockHeight: r.blockHeight, blockTime: r.blockTime } : { state: 'pending' };
}

/**
 * Asks every usable provider in preference order and stops at the first one that knows the tx
 * (mempools differ in size and eviction policy, so any "found" wins). "dropped" requires every
 * provider to answer "not found" without errors, and at least two of them to keep a complete
 * mempool, or the only such provider to say so twice. Anything else is "unknown".
 */
export async function resolveTxStatus(
  sources: readonly TxStatusSource[],
  txid: string,
  opts: ResolveTxStatusOptions = {},
): Promise<TxStatusResult> {
  const ask = async (s: TxStatusSource): Promise<TxLookup | null> => {
    try {
      return await s.client.tx(txid, opts.signal);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      opts.onError?.(s.id, err);
      return null;
    }
  };
  let errors = 0;
  for (const s of sources) {
    const r = await ask(s);
    if (r === null) errors++;
    else if (r.found) return foundResult(r);
  }
  const definitive = sources.filter((s) => s.mempoolOk);
  if (errors > 0 || definitive.length === 0) return { state: 'unknown' };
  if (definitive.length >= 2) return { state: 'dropped' };
  const only = definitive[0];
  if (!only) return { state: 'unknown' };
  await sleep(opts.recheckMs ?? 3_000, opts.signal);
  const again = await ask(only);
  if (again === null) return { state: 'unknown' };
  return again.found ? foundResult(again) : { state: 'dropped' };
}
