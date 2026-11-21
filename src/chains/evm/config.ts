import { NETWORKS, type EvmNetworkId } from '../../core/networks.ts';

/**
 * Endpoint configuration for the EVM adapter. Everything here was verified keyless from a
 * residential connection (see the per-network notes). Lists are in priority order.
 */

export interface EndpointSpec {
  url: string;
  /** Max calls per JSON-RPC batch (1 = send calls one by one). */
  maxBatch: number;
  /** Extra transport retries for retryable failures (http.ts default is 3). */
  retries?: number;
  /** Adapter-side request rate cap (requests/second), applied on top of http.ts host limits. */
  rps?: number;
  /** Use this endpoint in the rotation that spreads archive probes across endpoints. */
  spread?: boolean;
}

export type RpcCategory = 'state' | 'block' | 'receipt' | 'logs';

export interface RouteSpec {
  /**
   * Endpoints that serve recent data (latest state, recent blocks). Tried first for calls at
   * blocks within `window` blocks of the tip; archive endpoints are appended as fallback.
   */
  recent: EndpointSpec[];
  /** Endpoints that serve this category at any height. */
  archive: EndpointSpec[];
  /** How many blocks behind the tip the `recent` endpoints serve. */
  window: number;
}

export interface ExplorerSpec {
  kind: 'etherscan' | 'blockscout';
  /** Base API URL. Etherscan: the V2 endpoint (chainid and apikey are added per request). */
  url: string;
  rps?: number;
}

export interface EvmNetworkConfig {
  network: EvmNetworkId;
  /**
   * Blocks behind the tip at which the cursor/probe is taken. At least the network's
   * confirmation count, so the cursor block (whose fingerprint is stored) is not reorged away;
   * it also sits on a block every load-balanced node already has.
   */
  headLag: number;
  /** Most blocks one poll covers; after downtime the cursor catches up over several polls. */
  pollMaxSpan: number;
  /** OP-stack chain: receipts carry `l1Fee`, deposit transactions (type 0x7e) mint ETH. */
  opStack: boolean;
  /** Explorer (Etherscan-compatible) sources. Empty = "RPC network" (bisection only). */
  explorers: ExplorerSpec[];
  routes: Record<RpcCategory, RouteSpec>;
}

// --- Endpoints ---

const pn = (host: string): EndpointSpec => ({ url: `https://${host}`, maxBatch: 10 });

// drpc free plan: batches of at most 3 calls, low public rate limit (shared per IP across chains).
const drpc = (host: string): EndpointSpec => ({ url: `https://${host}`, maxBatch: 3, retries: 1, rps: 1.5 });

const ETHEREUM_ARCHIVE: EndpointSpec[] = [
  { url: 'https://eth-mainnet.public.blastapi.io', maxBatch: 10, retries: 2, rps: 3, spread: true },
  { url: 'https://eth-pokt.nodies.app', maxBatch: 10, retries: 2, rps: 3, spread: true },
  { url: 'https://rpc.mevblocker.io', maxBatch: 10, retries: 1, rps: 2 },
  drpc('eth.drpc.org'),
];

const POLYGON_ARCHIVE: EndpointSpec[] = [drpc('polygon.drpc.org')];

// BSC: blast is the only keyless archive-state endpoint that held up under sustained load
// (40/40 probe batches at 5 rps). meowrpc and 1rpc answer archive queries intermittently.
const BSC_ARCHIVE_STATE: EndpointSpec[] = [
  { url: 'https://bsc-mainnet.public.blastapi.io', maxBatch: 10, retries: 3, spread: true },
  { url: 'https://bsc.meowrpc.com', maxBatch: 10, retries: 1, rps: 1 },
  { url: 'https://1rpc.io/bnb', maxBatch: 3, retries: 1, rps: 1 },
];

// Base: mainnet.base.org, nodies and blast all held 5 rps with 4-call batches at old blocks.
const BASE_ARCHIVE: EndpointSpec[] = [
  { url: 'https://mainnet.base.org', maxBatch: 10, retries: 2, spread: true },
  { url: 'https://base-pokt.nodies.app', maxBatch: 10, retries: 2, rps: 4, spread: true },
  { url: 'https://base-mainnet.public.blastapi.io', maxBatch: 10, retries: 2, spread: true },
  drpc('base.drpc.org'),
];
// nodies rejects eth_getBlockByNumber with full transactions on the free plan.
const BASE_ARCHIVE_BLOCKS: EndpointSpec[] = BASE_ARCHIVE.filter((e) => !e.url.includes('nodies'));

export const EVM_CONFIG: Record<EvmNetworkId, EvmNetworkConfig> = {
  ethereum: {
    network: 'ethereum',
    headLag: Math.max(1, NETWORKS.ethereum.confirmations),
    pollMaxSpan: 50_000,
    opStack: false,
    explorers: [
      { kind: 'etherscan', url: 'https://api.etherscan.io/v2/api' },
      { kind: 'blockscout', url: 'https://eth.blockscout.com/api' },
    ],
    routes: {
      // publicnode keeps ~127 blocks of state; it serves every historical block and receipt.
      state: { recent: [pn('ethereum-rpc.publicnode.com')], archive: ETHEREUM_ARCHIVE, window: 60 },
      block: { recent: [pn('ethereum-rpc.publicnode.com')], archive: ETHEREUM_ARCHIVE, window: Number.MAX_SAFE_INTEGER },
      receipt: { recent: [pn('ethereum-rpc.publicnode.com')], archive: ETHEREUM_ARCHIVE, window: Number.MAX_SAFE_INTEGER },
      // Logs: explicit "archive" errors beyond ~5k-20k blocks.
      logs: { recent: [pn('ethereum-rpc.publicnode.com')], archive: ETHEREUM_ARCHIVE, window: 8_000 },
    },
  },
  polygon: {
    network: 'polygon',
    headLag: Math.max(1, NETWORKS.polygon.confirmations),
    pollMaxSpan: 100_000,
    opStack: false,
    explorers: [
      { kind: 'etherscan', url: 'https://api.etherscan.io/v2/api' },
      { kind: 'blockscout', url: 'https://polygon.blockscout.com/api', rps: 3 },
    ],
    routes: {
      state: { recent: [pn('polygon-bor-rpc.publicnode.com')], archive: POLYGON_ARCHIVE, window: 60 },
      block: { recent: [pn('polygon-bor-rpc.publicnode.com')], archive: POLYGON_ARCHIVE, window: Number.MAX_SAFE_INTEGER },
      receipt: { recent: [pn('polygon-bor-rpc.publicnode.com')], archive: POLYGON_ARCHIVE, window: Number.MAX_SAFE_INTEGER },
      // Logs verified non-empty 1.5M blocks back, explicit errors beyond ~2.3M.
      logs: { recent: [pn('polygon-bor-rpc.publicnode.com')], archive: POLYGON_ARCHIVE, window: 1_500_000 },
    },
  },
  bsc: {
    network: 'bsc',
    headLag: Math.max(1, NETWORKS.bsc.confirmations),
    pollMaxSpan: 20_000,
    opStack: false,
    explorers: [],
    routes: {
      // publicnode: state ~10k-50k blocks back, receipts and logs ~150k-250k, blocks: all.
      // Beyond its log window publicnode returns EMPTY eth_getLogs results (no error), so the
      // window must stay conservative; block analysis also cross-checks logs against balances.
      state: { recent: [pn('bsc-rpc.publicnode.com')], archive: BSC_ARCHIVE_STATE, window: 8_000 },
      block: {
        recent: [pn('bsc-rpc.publicnode.com')],
        archive: [pn('bsc-rpc.publicnode.com'), { url: 'https://bsc-mainnet.public.blastapi.io', maxBatch: 10, retries: 3 }],
        window: Number.MAX_SAFE_INTEGER,
      },
      receipt: {
        recent: [pn('bsc-rpc.publicnode.com')],
        archive: [
          { url: 'https://bsc-mainnet.public.blastapi.io', maxBatch: 10, retries: 3 },
          { url: 'https://bsc.meowrpc.com', maxBatch: 10, retries: 1, rps: 1 },
        ],
        window: 90_000,
      },
      // Old BSC logs: no reliable keyless source (blast/drpc rate-limit eth_getLogs, dataseeds
      // say "limit exceeded"). tatum answers but has a tiny quota; when it fails the block
      // analysis falls back to scanning receipts of candidate transactions.
      logs: {
        recent: [pn('bsc-rpc.publicnode.com')],
        archive: [{ url: 'https://bsc-mainnet.gateway.tatum.io', maxBatch: 1, retries: 0, rps: 0.5 }],
        window: 140_000,
      },
    },
  },
  base: {
    network: 'base',
    headLag: Math.max(1, NETWORKS.base.confirmations),
    pollMaxSpan: 20_000,
    opStack: true,
    // No explorer on purpose: base.blockscout.com is intermittently behind a Cloudflare challenge /
    // 429, and its Etherscan-style rows omit the OP-stack L1 data fee (fees would be understated).
    // RPC bisection reads receipts (incl. l1Fee) and reconciles to the wei.
    explorers: [],
    routes: {
      // publicnode: state >= 50k blocks back; blocks/receipts ~8.7M back; logs verified 4M back.
      state: { recent: [pn('base-rpc.publicnode.com')], archive: BASE_ARCHIVE, window: 40_000 },
      block: { recent: [pn('base-rpc.publicnode.com')], archive: BASE_ARCHIVE_BLOCKS, window: 8_000_000 },
      receipt: { recent: [pn('base-rpc.publicnode.com')], archive: BASE_ARCHIVE, window: 8_000_000 },
      logs: {
        recent: [pn('base-rpc.publicnode.com')],
        // mainnet.base.org throttles eth_getLogs ("request limit reached"); keep it last.
        archive: [BASE_ARCHIVE[2]!, BASE_ARCHIVE[1]!, BASE_ARCHIVE[3]!, BASE_ARCHIVE[0]!],
        window: 4_000_000,
      },
    },
  },
};

/** ERC-20 Transfer(address,address,uint256) topic. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** balanceOf(address) selector. */
export const BALANCE_OF_SELECTOR = '0x70a08231';

/** Explorer live-poll retries (fingerprint changed but explorer data does not explain it yet). */
export const EXPLORER_MAX_RETRIES = 4;
