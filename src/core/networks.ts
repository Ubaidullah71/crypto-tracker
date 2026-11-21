import type { AssetId } from './assets.ts';

export const NETWORK_IDS = ['bitcoin', 'litecoin', 'ethereum', 'bsc', 'polygon', 'base', 'solana', 'xrp'] as const;
export type NetworkId = (typeof NETWORK_IDS)[number];
export type NetworkFamily = 'utxo' | 'evm' | 'solana' | 'xrp';

export const EVM_NETWORKS = ['ethereum', 'bsc', 'polygon', 'base'] as const satisfies readonly NetworkId[];
export type EvmNetworkId = (typeof EVM_NETWORKS)[number];

/** A specific asset on a specific network (e.g. USDT on BNB Chain). */
export interface NetworkAsset {
  /** Stable unique key, e.g. "ethereum:native", "bsc:0x55d3...", "solana:Es9v...". */
  key: string;
  network: NetworkId;
  asset: AssetId;
  kind: 'native' | 'token';
  /** EVM contract address (lowercase) or Solana mint (case-sensitive). */
  contract?: string;
  decimals: number;
  /** Short display label when it differs from the asset symbol, e.g. "USDC.e". */
  label?: string;
}

export interface NetworkInfo {
  id: NetworkId;
  name: string;
  shortName: string;
  family: NetworkFamily;
  /** EVM chain ID. */
  chainId?: number;
  native: NetworkAsset;
  tokens: NetworkAsset[];
  /**
   * Confirmations before a transaction is reported as "Confirmed".
   * For Solana/XRP the adapter reports finality directly and this is 1.
   */
  confirmations: number;
  /** Average block / slot / ledger time in seconds. */
  blockTimeSec: number;
  /** Unit shown for fee rates. */
  feeRateUnit: string;
  /** Seconds between live polls for each tracked address. */
  pollIntervalSec: number;
  explorer: {
    name: string;
    tx: (txid: string) => string;
    address: (address: string) => string;
    block: (height: number) => string;
  };
}

function native(network: NetworkId, asset: AssetId, decimals: number): NetworkAsset {
  return { key: `${network}:native`, network, asset, kind: 'native', decimals };
}

function token(network: NetworkId, asset: AssetId, contract: string, decimals: number, label?: string): NetworkAsset {
  const c = network === 'solana' ? contract : contract.toLowerCase();
  return { key: `${network}:${c}`, network, asset, kind: 'token', contract: c, decimals, ...(label ? { label } : {}) };
}

export const NETWORKS: Record<NetworkId, NetworkInfo> = {
  bitcoin: {
    id: 'bitcoin',
    name: 'Bitcoin',
    shortName: 'BTC',
    family: 'utxo',
    native: native('bitcoin', 'BTC', 8),
    tokens: [],
    confirmations: 1,
    blockTimeSec: 600,
    feeRateUnit: 'sat/vB',
    pollIntervalSec: 30,
    explorer: {
      name: 'mempool.space',
      tx: (id) => `https://mempool.space/tx/${id}`,
      address: (a) => `https://mempool.space/address/${a}`,
      block: (h) => `https://mempool.space/block/${h}`,
    },
  },
  litecoin: {
    id: 'litecoin',
    name: 'Litecoin',
    shortName: 'LTC',
    family: 'utxo',
    native: native('litecoin', 'LTC', 8),
    tokens: [],
    confirmations: 1,
    blockTimeSec: 150,
    feeRateUnit: 'lit/vB',
    pollIntervalSec: 20,
    explorer: {
      name: 'Blockchair',
      tx: (id) => `https://blockchair.com/litecoin/transaction/${id}`,
      address: (a) => `https://blockchair.com/litecoin/address/${a}`,
      block: (h) => `https://blockchair.com/litecoin/block/${h}`,
    },
  },
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    shortName: 'ETH',
    family: 'evm',
    chainId: 1,
    native: native('ethereum', 'ETH', 18),
    tokens: [
      token('ethereum', 'USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
      token('ethereum', 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
    ],
    confirmations: 3,
    blockTimeSec: 12,
    feeRateUnit: 'gwei',
    pollIntervalSec: 15,
    explorer: {
      name: 'Etherscan',
      tx: (id) => `https://etherscan.io/tx/${id}`,
      address: (a) => `https://etherscan.io/address/${a}`,
      block: (h) => `https://etherscan.io/block/${h}`,
    },
  },
  bsc: {
    id: 'bsc',
    name: 'BNB Smart Chain',
    shortName: 'BSC',
    family: 'evm',
    chainId: 56,
    native: native('bsc', 'BNB', 18),
    tokens: [
      token('bsc', 'USDT', '0x55d398326f99059fF775485246999027B3197955', 18),
      token('bsc', 'USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 18),
    ],
    confirmations: 5,
    blockTimeSec: 0.75,
    feeRateUnit: 'gwei',
    pollIntervalSec: 15,
    explorer: {
      name: 'BscScan',
      tx: (id) => `https://bscscan.com/tx/${id}`,
      address: (a) => `https://bscscan.com/address/${a}`,
      block: (h) => `https://bscscan.com/block/${h}`,
    },
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon',
    shortName: 'Polygon',
    family: 'evm',
    chainId: 137,
    native: native('polygon', 'POL', 18),
    tokens: [
      token('polygon', 'USDT', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6, 'USDT0'),
      token('polygon', 'USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6),
      token('polygon', 'USDC', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6, 'USDC.e'),
    ],
    confirmations: 5,
    blockTimeSec: 2,
    feeRateUnit: 'gwei',
    pollIntervalSec: 15,
    explorer: {
      name: 'PolygonScan',
      tx: (id) => `https://polygonscan.com/tx/${id}`,
      address: (a) => `https://polygonscan.com/address/${a}`,
      block: (h) => `https://polygonscan.com/block/${h}`,
    },
  },
  base: {
    id: 'base',
    name: 'Base',
    shortName: 'Base',
    family: 'evm',
    chainId: 8453,
    native: native('base', 'ETH', 18),
    tokens: [
      token('base', 'USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
      token('base', 'USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6, 'USDT (bridged)'),
    ],
    confirmations: 5,
    blockTimeSec: 2,
    feeRateUnit: 'gwei',
    pollIntervalSec: 15,
    explorer: {
      name: 'BaseScan',
      tx: (id) => `https://basescan.org/tx/${id}`,
      address: (a) => `https://basescan.org/address/${a}`,
      block: (h) => `https://basescan.org/block/${h}`,
    },
  },
  solana: {
    id: 'solana',
    name: 'Solana',
    shortName: 'SOL',
    family: 'solana',
    native: native('solana', 'SOL', 9),
    tokens: [
      token('solana', 'USDT', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6),
      token('solana', 'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6),
    ],
    confirmations: 1,
    blockTimeSec: 0.4,
    feeRateUnit: 'lamports',
    pollIntervalSec: 15,
    explorer: {
      name: 'Solscan',
      tx: (id) => `https://solscan.io/tx/${id}`,
      address: (a) => `https://solscan.io/account/${a}`,
      block: (h) => `https://solscan.io/block/${h}`,
    },
  },
  xrp: {
    id: 'xrp',
    name: 'XRP Ledger',
    shortName: 'XRP',
    family: 'xrp',
    native: native('xrp', 'XRP', 6),
    tokens: [],
    confirmations: 1,
    blockTimeSec: 4,
    feeRateUnit: 'drops',
    pollIntervalSec: 15,
    explorer: {
      name: 'XRPScan',
      tx: (id) => `https://xrpscan.com/tx/${id}`,
      address: (a) => `https://xrpscan.com/account/${a}`,
      block: (h) => `https://xrpscan.com/ledger/${h}`,
    },
  },
};

export function isNetworkId(v: string): v is NetworkId {
  return (NETWORK_IDS as readonly string[]).includes(v);
}

export function isEvmNetwork(n: NetworkId): n is EvmNetworkId {
  return (EVM_NETWORKS as readonly string[]).includes(n);
}

/** All assets (native + tokens) supported on a network. */
export function networkAssets(network: NetworkId): NetworkAsset[] {
  const n = NETWORKS[network];
  return [n.native, ...n.tokens];
}

const assetByKey = new Map<string, NetworkAsset>();
for (const n of Object.values(NETWORKS)) for (const a of [n.native, ...n.tokens]) assetByKey.set(a.key, a);

export function getNetworkAsset(key: string): NetworkAsset | undefined {
  return assetByKey.get(key);
}

/** Finds the token on a network by contract/mint. EVM lookups are case-insensitive. */
export function findToken(network: NetworkId, contract: string): NetworkAsset | undefined {
  const c = network === 'solana' ? contract : contract.toLowerCase();
  return NETWORKS[network].tokens.find((t) => t.contract === c);
}

/** Display label for an asset on a network, e.g. "USDT (BNB Smart Chain)". */
export function assetLabel(a: NetworkAsset): string {
  return a.label ?? a.asset;
}
