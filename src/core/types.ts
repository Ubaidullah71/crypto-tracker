import type { NetworkId } from './networks.ts';

/**
 * Adapter-specific sync position, persisted as JSON between polls (e.g. last block,
 * last signature, last ledger index, balance fingerprint). Must be JSON-serializable.
 */
export type Cursor = Record<string, unknown>;

export type TransferDirection = 'in' | 'out' | 'self';

/**
 * pending   - seen but not yet included / not final (mempool tx, Solana "confirmed" commitment).
 * confirmed - included in a block (UTXO/EVM: the tracker applies the confirmation threshold),
 *             or final (Solana "finalized", XRP validated ledger).
 * failed    - included but reverted / unsuccessful. The fee is still paid (emit as fee-only).
 */
export type TransferStatus = 'pending' | 'confirmed' | 'failed';

/**
 * One balance movement of ONE asset for the tracked address, produced by a chain adapter.
 * A single transaction may produce several RawTransfers (e.g. native + token).
 */
export interface RawTransfer {
  /** Transaction hash / signature. */
  txid: string;
  /**
   * Distinguishes multiple transfers inside one transaction. Must be deterministic across polls.
   * Conventions: "native" (net native movement), "token:<contract>" (net token movement),
   * "internal:<n>", "fee" (fee-only transaction).
   */
  subId: string;
  /** NetworkAsset.key, e.g. "bsc:0x55d3...". */
  assetKey: string;
  direction: TransferDirection;
  /**
   * Absolute amount in base units that moved to/from the tracked address, EXCLUDING the network fee.
   * 0 is allowed for fee-only rows (direction "out" or "self", chargeFee true).
   */
  amount: bigint;
  /** Total network fee of the transaction in NATIVE base units (informational), or null if unknown. */
  fee: bigint | null;
  /**
   * True on exactly one transfer per transaction when the tracked address paid the fee.
   * The ledger deducts `fee` from the network's native asset for that row only.
   */
  chargeFee: boolean;
  /** Main counterparty (sender for "in", recipient for "out"), or null if unknown. */
  counterparty: string | null;
  /** All counterparty addresses involved (used for internal-transfer and poisoning detection). */
  counterparties?: string[];
  /** Block height / slot / ledger index, null while pending. */
  blockHeight: number | null;
  /** Unix seconds of the block, null while pending. */
  blockTime: number | null;
  status: TransferStatus;
  meta?: TransferMeta;
}

export interface TransferMeta {
  /** Fee rate in the network's feeRateUnit (sat/vB, lit/vB, gwei, ...). */
  feeRate?: number;
  /** UTXO: transaction signals replace-by-fee. */
  rbf?: boolean;
  /** UTXO: virtual size in vbytes. */
  vsize?: number;
  /** XRP destination tag. */
  destinationTag?: number;
  /** XRP source tag. */
  sourceTag?: number;
  /** Free-form memo when the chain provides one. */
  memo?: string;
  /** EVM: value moved via an internal (contract) call; txid may be synthetic when unknown. */
  internal?: boolean;
  /** True when the txid is synthetic (e.g. "block:123:internal") because the real hash is unknown. */
  syntheticTxid?: boolean;
  /** Fee-only transaction (contract call, failed tx, approval). */
  feeOnly?: boolean;
  /** Number of the tracked address's own outputs and other adapter-specific extras. */
  [key: string]: unknown;
}

export interface TxStatusResult {
  state: 'pending' | 'confirmed' | 'failed' | 'dropped' | 'unknown';
  blockHeight?: number | null;
  blockTime?: number | null;
}

export interface BackfillProgress {
  /** Human readable stage, e.g. "Scanning blocks", "Fetching transactions". */
  stage: string;
  /** 0..1 when known. */
  fraction?: number;
  /** Items processed so far (transactions, pages, blocks...). */
  done?: number;
  total?: number;
}

export interface BackfillOptions {
  /** Called with progress updates (throttle internally is not required). */
  onProgress?: (p: BackfillProgress) => void;
  /** Called with batches of discovered transfers as they are found (lets the caller persist incrementally). */
  onBatch?: (transfers: RawTransfer[]) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface PollResult {
  /** New or updated transfers since the cursor (pending ones may be repeated; the tracker dedupes). */
  transfers: RawTransfer[];
  cursor: Cursor;
}

/**
 * One implementation per network family. Adapters are stateless apart from caches; all
 * persistent state lives in the Cursor the tracker stores.
 */
export interface ChainAdapter {
  readonly network: NetworkId;

  /** Current chain height (block height / slot / validated ledger index). */
  getTip(signal?: AbortSignal): Promise<number>;

  /**
   * Live balances for every supported asset on this network (NetworkAsset.key -> base units).
   * Include assets with zero balance. UTXO: confirmed + unconfirmed (mempool) balance.
   */
  getBalances(address: string, signal?: AbortSignal): Promise<Map<string, bigint>>;

  /** Creates the starting cursor for live tracking: "everything up to now is history". */
  initCursor(address: string, signal?: AbortSignal): Promise<Cursor>;

  /** Returns transfers that happened after the cursor (plus currently pending ones) and the new cursor. */
  poll(address: string, cursor: Cursor, signal?: AbortSignal): Promise<PollResult>;

  /**
   * Imports the full history up to (and including) the boundary cursor returned by initCursor.
   * Must stream results through opts.onBatch and also return everything found.
   */
  backfill(address: string, boundary: Cursor, opts?: BackfillOptions): Promise<RawTransfer[]>;

  /** Re-checks a transaction (pending -> confirmed / dropped / failed). */
  getTxStatus(txid: string, address: string, signal?: AbortSignal): Promise<TxStatusResult>;

  /** UTXO only: estimated seconds until confirmation for a fee rate (sat/vB), or null if unknown. */
  estimateConfirmationSeconds?(feeRate: number, signal?: AbortSignal): Promise<number | null>;
}
