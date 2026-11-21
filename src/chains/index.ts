import { isEvmNetwork, type NetworkId } from '../core/networks.ts';
import type { ChainAdapter } from '../core/types.ts';
import { createEvmAdapter } from './evm/adapter.ts';
import { createSolanaAdapter } from './solana/adapter.ts';
import { createUtxoAdapter } from './utxo/adapter.ts';
import { createXrpAdapter } from './xrp/adapter.ts';

const adapters = new Map<NetworkId, ChainAdapter>();

/** One shared adapter instance per network (adapters keep only caches, no per-wallet state). */
export function getAdapter(network: NetworkId): ChainAdapter {
  let a = adapters.get(network);
  if (a) return a;
  if (network === 'bitcoin' || network === 'litecoin') a = createUtxoAdapter(network);
  else if (isEvmNetwork(network)) a = createEvmAdapter(network);
  else if (network === 'solana') a = createSolanaAdapter();
  else if (network === 'xrp') a = createXrpAdapter();
  else throw new Error(`No adapter for network ${String(network)}`);
  adapters.set(network, a);
  return a;
}
