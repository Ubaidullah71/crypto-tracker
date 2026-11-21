import type { RpcCall } from '../../util/http.ts';
import { BALANCE_OF_SELECTOR } from './config.ts';
import { BadAnswerError, type EvmRpc } from './rpc.ts';
import { addressTopic, hexQty, toHex } from './util.ts';

/**
 * Account state at one block: nonce, native balance and the balance of every tracked token
 * (in NETWORKS[network].tokens order). Its fingerprint changes whenever anything the adapter
 * tracks changes; the nonce catches outgoing transactions whose effects cancel in balance.
 */
export interface ChainState {
  nonce: bigint;
  balance: bigint;
  tokens: bigint[];
}

export function fingerprint(s: ChainState): string {
  return [s.nonce, s.balance, ...s.tokens].map((v) => v.toString()).join(':');
}

/** Parses a fingerprint produced by `fingerprint`. Null if malformed or for another token set. */
export function parseFingerprint(fp: unknown, tokenCount: number): ChainState | null {
  if (typeof fp !== 'string') return null;
  const parts = fp.split(':');
  if (parts.length !== 2 + tokenCount || !parts.every((p) => /^\d{1,78}$/.test(p))) return null;
  const nums = parts.map((p) => BigInt(p));
  return { nonce: nums[0]!, balance: nums[1]!, tokens: nums.slice(2) };
}

export function zeroState(tokenCount: number): ChainState {
  return { nonce: 0n, balance: 0n, tokens: new Array<bigint>(tokenCount).fill(0n) };
}

export function probeCalls(address: string, tokens: readonly string[], tag: string): RpcCall[] {
  const data = BALANCE_OF_SELECTOR + addressTopic(address).slice(2);
  return [
    { method: 'eth_getBalance', params: [address, tag] },
    { method: 'eth_getTransactionCount', params: [address, tag] },
    ...tokens.map((to) => ({ method: 'eth_call', params: [{ to, data }, tag] })),
  ];
}

/** Parses probe results; throws BadAnswerError (so the endpoint pool tries another endpoint). */
export function parseProbeResults(results: readonly unknown[], tokenCount: number): ChainState {
  if (results.length !== 2 + tokenCount) throw new BadAnswerError('probe: wrong number of results');
  const balance = hexQty(results[0]);
  const nonce = hexQty(results[1]);
  if (balance === null || nonce === null) throw new BadAnswerError('probe: malformed balance/nonce');
  const tokens: bigint[] = [];
  for (let i = 0; i < tokenCount; i++) {
    // "0x" = no code at that block (token not deployed yet) -> 0.
    const v = hexQty(results[2 + i]);
    if (v === null) throw new BadAnswerError('probe: malformed balanceOf result');
    tokens.push(v);
  }
  return { nonce, balance, tokens };
}

/** Probes the account at an exact block (or "latest") in a single batch. */
export async function probeAt(
  rpc: EvmRpc,
  address: string,
  tokens: readonly string[],
  block: number | 'latest',
  signal?: AbortSignal,
): Promise<ChainState> {
  const tag = block === 'latest' ? 'latest' : toHex(block);
  let parsed: ChainState | null = null;
  await rpc.batch('state', block, probeCalls(address, tokens, tag), signal, (res) => {
    parsed = parseProbeResults(res, tokens.length);
  });
  return parsed!;
}
