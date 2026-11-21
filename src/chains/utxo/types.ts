/** Internal, backend-independent shapes used by the UTXO adapter (Bitcoin, Litecoin). */

export type UtxoNetwork = 'bitcoin' | 'litecoin';
export type BackendKind = 'blockbook' | 'esplora';

/** Returns true when an address string belongs to the tracked address. */
export type AddressMatcher = (candidate: string) => boolean;

export interface NormInput {
  /** Standard addresses of the spent output (empty for coinbase / non-standard scripts). */
  addresses: string[];
  /** Value of the spent output in satoshis; null when the backend did not report it (never for own inputs). */
  value: bigint | null;
  /** nSequence, null when the backend did not report it (Blockbook txslight). */
  sequence: number | null;
  coinbase: boolean;
  /** Spends an output of the tracked address. */
  own: boolean;
}

export interface NormOutput {
  addresses: string[];
  /** Satoshis; null when unknown (never for own outputs). */
  value: bigint | null;
  /** Pays the tracked address. */
  own: boolean;
}

/** One transaction normalized from Blockbook or Esplora, with ownership resolved for one address. */
export interface NormTx {
  txid: string;
  /** null while in the mempool. */
  blockHeight: number | null;
  /** Unix seconds of the block; null while in the mempool. */
  blockTime: number | null;
  /** Unix seconds the backend first saw the unconfirmed tx (Blockbook only). */
  firstSeen: number | null;
  /** Total tx fee in satoshis as reported by the backend. */
  fee: bigint | null;
  vsize: number | null;
  /** BIP125 signalling; null when unknown (no sequence numbers available). */
  rbf: boolean | null;
  vin: NormInput[];
  vout: NormOutput[];
}

/** Cheap per-address counters used for balances and the poll fingerprint. */
export interface AddressSummary {
  /** Confirmed transaction count. */
  txs: number;
  unconfirmedTxs: number;
  /** Confirmed balance in satoshis. */
  balance: bigint;
  /** Net mempool delta in satoshis (may be negative); null when the backend omitted it. */
  unconfirmedBalance: bigint | null;
}

export type TxLookup = { found: false } | { found: true; confirmed: boolean; blockHeight: number | null; blockTime: number | null };

export interface ParsedTxList {
  txs: NormTx[];
  /** Number of items the backend returned (including skipped malformed ones). */
  rawCount: number;
  skipped: number;
}

/** Result of a live read (mempool + confirmed txs at height >= from). */
export interface RecentTxs extends ParsedTxList {
  /**
   * False when the page cap was hit: confirmed txs between `from` and `oldestHeight` (inclusive)
   * may not have been read. The adapter records that window as a gap and reads it in later polls.
   */
  complete: boolean;
  /** Lowest confirmed block height among the transactions read. */
  oldestHeight: number | null;
  /** Esplora: txid after which the confirmed chain continues (set when incomplete). */
  resumeAfter: string | null;
}

/**
 * Confirmed-history window [from, to] (block heights, inclusive) that still has to be read.
 * Its content cannot change (apart from reorgs), so pagination stays stable across polls:
 * `page` continues a Blockbook from/to listing, `after` an Esplora /txs/chain walk.
 */
export interface GapState {
  from: number;
  to: number;
  page?: number;
  after?: string;
}

export interface ProbeResult {
  /** Height of the backend's index (what address queries reflect). */
  tip: number;
  /** Height of the backend's node when reported separately (Blockbook backend.blocks). */
  nodeTip: number | null;
  mempoolSize: number | null;
  inSyncMempool: boolean | null;
  /** Unix seconds of the last block (Esplora) / last index update (Blockbook), if reported. */
  tipTime: number | null;
}

/** Fee-rate estimates: confirmation target in blocks -> sat/vB. */
export type FeeEstimates = ReadonlyMap<number, number>;
