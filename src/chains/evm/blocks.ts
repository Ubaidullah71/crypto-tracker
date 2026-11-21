import type { EvmNetworkId } from '../../core/networks.ts';
import type { TransferMeta } from '../../core/types.ts';
import { createLogger } from '../../logger.ts';
import { mergeRecord, NATIVE, type Leg, type TxRecord } from './aggregate.ts';
import { TRANSFER_TOPIC } from './config.ts';
import type { ChainState } from './probe.ts';
import { BadAnswerError, type EvmRpc } from './rpc.ts';
import { addr, addressTopic, hexNum, hexQty, isRecord, toHex, topicAddress, txHash } from './util.ts';

const log = createLogger('evm:blocks');

// --- Parsed RPC objects ---

export interface RpcTx {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  input: string;
  type: number;
  index: number | null;
  /** For mined txs this is the effective gas price. */
  gasPrice: bigint | null;
  /** OP-stack deposit: ETH minted to `from`. */
  mint: bigint;
}

export interface RpcBlock {
  number: number;
  hash: string | null;
  timestamp: number;
  txs: RpcTx[];
}

export interface RpcReceipt {
  hash: string;
  block: number | null;
  success: boolean;
  gasUsed: bigint;
  effectiveGasPrice: bigint | null;
  l1Fee: bigint;
  blobFee: bigint;
  contractAddress: string | null;
  logs: RpcLog[];
}

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  txHash: string;
  logIndex: number | null;
  blockHash: string | null;
  removed: boolean;
}

export function parseTx(v: unknown): RpcTx | null {
  if (!isRecord(v)) return null;
  const hash = txHash(v.hash);
  const from = addr(v.from);
  const value = hexQty(v.value);
  if (!hash || !from || value === null) return null;
  return {
    hash,
    from,
    to: addr(v.to),
    value,
    input: typeof v.input === 'string' ? v.input.toLowerCase() : '0x',
    type: hexNum(v.type) ?? 0,
    index: hexNum(v.transactionIndex),
    gasPrice: hexQty(v.gasPrice),
    mint: hexQty(v.mint) ?? 0n,
  };
}

export function parseBlock(v: unknown, expected: number): RpcBlock {
  if (!isRecord(v)) throw new BadAnswerError(`block ${expected}: not found`);
  const number = hexNum(v.number);
  const timestamp = hexNum(v.timestamp);
  if (number !== expected || timestamp === null || !Array.isArray(v.transactions)) {
    throw new BadAnswerError(`block ${expected}: malformed answer`);
  }
  const txs: RpcTx[] = [];
  for (const t of v.transactions) {
    const tx = parseTx(t);
    if (tx) txs.push(tx);
    else log.debug(`block ${expected}: skipped malformed transaction`);
  }
  return { number, hash: txHash(v.hash), timestamp, txs };
}

export function parseLog(v: unknown): RpcLog | null {
  if (!isRecord(v)) return null;
  const address = addr(v.address);
  const tx = txHash(v.transactionHash);
  if (!address || !tx || !Array.isArray(v.topics) || typeof v.data !== 'string') return null;
  const topics = v.topics.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
  return {
    address,
    topics,
    data: v.data.toLowerCase(),
    txHash: tx,
    logIndex: hexNum(v.logIndex),
    blockHash: txHash(v.blockHash),
    removed: v.removed === true,
  };
}

export function parseReceipt(v: unknown, opStack: boolean): RpcReceipt | null {
  if (!isRecord(v)) return null;
  const hash = txHash(v.transactionHash);
  const gasUsed = hexQty(v.gasUsed);
  // Pre-Byzantium receipts (Ethereum < 4,370,000) carry a state `root` and no `status`: treat
  // them as successful; the balance residual corrects the rare reverted value transfer.
  const noStatus = v.status === undefined || v.status === null;
  const status = noStatus ? 1 : hexNum(v.status);
  if (!hash || gasUsed === null || status === null) return null;
  const blobGasUsed = hexQty(v.blobGasUsed);
  const blobGasPrice = hexQty(v.blobGasPrice);
  const logs: RpcLog[] = [];
  if (Array.isArray(v.logs))
    for (const l of v.logs) {
      const p = parseLog(l);
      if (p) logs.push(p);
    }
  return {
    hash,
    block: hexNum(v.blockNumber),
    success: status === 1,
    gasUsed,
    effectiveGasPrice: hexQty(v.effectiveGasPrice),
    l1Fee: opStack ? (hexQty(v.l1Fee) ?? 0n) : 0n,
    // Blob gas is charged on top of execution gas (EIP-4844). OP-stack receipts report blobGasUsed
    // as DA footprint without a price, so this only applies when a price is present.
    blobFee: blobGasUsed !== null && blobGasPrice !== null ? blobGasUsed * blobGasPrice : 0n,
    contractAddress: addr(v.contractAddress),
    logs,
  };
}

/** Total fee paid by the sender: execution gas (+ blob gas) (+ OP-stack L1 data fee). */
export function receiptFee(r: RpcReceipt, tx: RpcTx | undefined): bigint {
  const price = r.effectiveGasPrice ?? tx?.gasPrice ?? 0n;
  return r.gasUsed * price + r.blobFee + r.l1Fee;
}

// --- Fetching ---

export interface BlockData {
  block: RpcBlock;
  /** Logs that mention the address in topic1 or topic2; null if no log source answered. */
  logs: RpcLog[] | null;
  receipts: Map<string, RpcReceipt>;
}

export interface AnalyzeContext {
  rpc: EvmRpc;
  network: EvmNetworkId;
  /** Lowercase tracked address. */
  address: string;
  /** Lowercase tracked token contracts, in NETWORKS order (matches ChainState.tokens). */
  tokens: readonly string[];
  opStack: boolean;
  signal?: AbortSignal;
}

/** Parses and merges eth_getLogs answers (topic1 / topic2 queries), dropping removed, foreign-block and duplicate logs. */
export function collectLogs(lists: readonly unknown[][], block: number): RpcLog[] {
  const seen = new Set<string>();
  const out: RpcLog[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const l = parseLog(raw);
      if (!l || l.removed) continue;
      if (isRecord(raw) && raw.blockNumber !== undefined && hexNum(raw.blockNumber) !== block) continue;
      const k = `${l.txHash}:${l.logIndex ?? out.length}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(l);
    }
  }
  return out;
}

/** Remembers when archive log sources failed so old blocks skip straight to the receipt scan. */
const logsDownUntil = new WeakMap<EvmRpc, number>();
const MAX_CANDIDATES = 100;

async function fetchLogs(ctx: AnalyzeContext, block: number, blockHash: string | null): Promise<RpcLog[] | null> {
  const { rpc } = ctx;
  const archive = rpc.knownTip !== null && rpc.knownTip - block > rpc.cfg.routes.logs.window;
  if (archive && (logsDownUntil.get(rpc) ?? 0) > Date.now()) return null;
  const me = addressTopic(ctx.address);
  const range = blockHash ? { blockHash } : { fromBlock: toHex(block), toBlock: toHex(block) };
  const calls = [
    { method: 'eth_getLogs', params: [{ ...range, topics: [null, me] }] },
    { method: 'eth_getLogs', params: [{ ...range, topics: [null, null, me] }] },
  ];
  try {
    const res = await rpc.batch('logs', block, calls, ctx.signal, (r) => {
      if (!Array.isArray(r[0]) || !Array.isArray(r[1])) throw new BadAnswerError('eth_getLogs: not an array');
    });
    return collectLogs(res as unknown[][], block);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    if (archive) logsDownUntil.set(rpc, Date.now() + 3 * 60_000);
    log.debug(`${ctx.network}: logs unavailable for block ${block}; scanning receipts instead`, err);
    return null;
  }
}

async function fetchReceipts(ctx: AnalyzeContext, block: number, hashes: readonly string[]): Promise<Map<string, RpcReceipt>> {
  const out = new Map<string, RpcReceipt>();
  if (hashes.length === 0) return out;
  const calls = hashes.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] }));
  await ctx.rpc.batch('receipt', block, calls, ctx.signal, (res) => {
    out.clear();
    res.forEach((raw, i) => {
      const r = parseReceipt(raw, ctx.opStack);
      if (!r || r.hash !== hashes[i] || (r.block !== null && r.block !== block)) {
        throw new BadAnswerError(`receipt ${hashes[i]}: missing or inconsistent`);
      }
      out.set(r.hash, r);
    });
  });
  return out;
}

/**
 * Fetches the block, the logs mentioning the address, and the receipts the analysis needs.
 * `skipLogs` forces the receipt scan (used when eth_getLogs answered but looks incomplete).
 */
export async function fetchBlockData(
  ctx: AnalyzeContext,
  blockNumber: number,
  opts: { block?: RpcBlock; skipLogs?: boolean } = {},
): Promise<BlockData> {
  const me = ctx.address;
  const [block, logs0] = await Promise.all([
    opts.block
      ? Promise.resolve(opts.block)
      : ctx.rpc
          .call('block', blockNumber, 'eth_getBlockByNumber', [toHex(blockNumber), true], ctx.signal, (r) => {
            parseBlock(r, blockNumber);
          })
          .then((raw) => parseBlock(raw, blockNumber)),
    opts.skipLogs ? Promise.resolve(null) : fetchLogs(ctx, blockNumber, null),
  ]);
  let logs = logs0;
  // Logs from a different block hash (reorg / node disagreement): re-query by hash.
  if (logs && block.hash && logs.some((l) => l.blockHash && l.blockHash !== block.hash)) {
    logs = await fetchLogs(ctx, blockNumber, block.hash);
  }
  const needle = me.slice(2);
  const own = block.txs.filter((t) => t.from === me || t.to === me);
  let targets = own;
  if (logs === null) {
    // No log source: receipts of every tx that is ours or mentions our address in calldata.
    targets = block.txs.filter((t) => t.from === me || t.to === me || t.input.includes(needle));
    if (targets.length > MAX_CANDIDATES) {
      log.warn(`${ctx.network}: block ${blockNumber}: ${targets.length} candidate txs, scanning the first ${MAX_CANDIDATES}`);
      targets = [...own, ...targets.filter((t) => !own.includes(t)).slice(0, MAX_CANDIDATES - own.length)];
    }
  }
  const receipts = await fetchReceipts(
    ctx,
    blockNumber,
    targets.map((t) => t.hash),
  );
  return { block, logs, receipts };
}

// --- Analysis (pure) ---

function mentions(l: RpcLog, me: string): boolean {
  return topicAddress(l.topics[1]) === me || topicAddress(l.topics[2]) === me;
}

/** Zero-value Transfer events (address-poisoning spam) are never evidence of anything. */
function isZeroTransfer(l: RpcLog): boolean {
  return l.topics[0] === TRANSFER_TOPIC && /^0x0*$/.test(l.data);
}

/**
 * Turns one change block into records. Token movements come from Transfer logs of tracked
 * contracts; native movements from our transactions (value, fee, status). Whatever the balance
 * delta (before -> after) still does not explain is an internal transfer: attributed to one of
 * our successful txs in the block, else to the single tx whose logs mention us, else to the
 * synthetic txid "block:<n>:internal".
 */
export function analyzeBlockData(
  ctx: Pick<AnalyzeContext, 'network' | 'address' | 'tokens' | 'opStack'>,
  data: BlockData,
  before: ChainState,
  after: ChainState,
): TxRecord[] {
  const me = ctx.address;
  const { block, receipts } = data;
  const b = block.number;
  const time = block.timestamp;
  const txByHash = new Map(block.txs.map((t) => [t.hash, t]));
  const recs = new Map<string, TxRecord>();
  const tracked = new Set(ctx.tokens);

  // 1. Our transactions (sender or recipient).
  const own = block.txs.filter((t) => t.from === me || t.to === me);
  for (const t of own) {
    const r = receipts.get(t.hash);
    if (!r) {
      log.warn(`${ctx.network}: block ${b}: no receipt for ${t.hash}`);
      continue;
    }
    const deposit = ctx.opStack && t.type === 0x7e;
    const legs: Leg[] = [];
    const meta: TransferMeta = {};
    if (deposit && t.mint > 0n) {
      // L1 -> L2 deposit: ETH is minted to the sender even if the L2 execution fails.
      legs.push({ asset: NATIVE, from: '', to: t.from, value: t.mint });
      meta.l1Deposit = true;
    }
    if (r.success && t.value > 0n) legs.push({ asset: NATIVE, from: t.from, to: t.to ?? r.contractAddress ?? '', value: t.value });
    mergeRecord(recs, {
      hash: t.hash,
      block: b,
      time,
      index: t.index,
      sender: t.from,
      target: t.to ?? r.contractAddress,
      failed: !r.success && !deposit,
      fee: deposit ? 0n : receiptFee(r, t),
      gasPrice: deposit ? null : (r.effectiveGasPrice ?? t.gasPrice),
      legs,
      ...(Object.keys(meta).length ? { meta } : {}),
    });
  }

  // 2. Logs mentioning us: eth_getLogs plus the logs of the receipts we fetched (our own txs, or
  // every candidate of a receipt scan), so both paths see the same Transfer events.
  const logs = blockLogs(data, me);
  for (const l of logs) {
    if (!tracked.has(l.address) || l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
    if (!/^0x[0-9a-f]{64}$/.test(l.data)) continue;
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    const value = hexQty(l.data);
    if (!from || !to || value === null || value === 0n || (from !== me && to !== me)) continue;
    const t = txByHash.get(l.txHash);
    mergeRecord(recs, {
      hash: l.txHash,
      block: b,
      time,
      index: t?.index ?? null,
      sender: t?.from ?? null,
      target: t?.to ?? null,
      failed: false,
      fee: null,
      gasPrice: t?.gasPrice ?? null,
      legs: [{ asset: l.address, from, to, value }],
    });
  }

  // 3. Residuals: balance delta not explained by the above.
  const successfulOwn = own.filter((t) => receipts.get(t.hash)?.success);
  const pickOwn = (): RpcTx | undefined => {
    const sent = successfulOwn.filter((t) => t.from === me);
    const calls = sent.filter((t) => t.input.length > 2);
    return calls[0] ?? sent[0] ?? successfulOwn[0];
  };
  const syntheticHash = `block:${b}:internal`;
  const recordFor = (hash: string): TxRecord => {
    const existing = recs.get(hash);
    if (existing) return existing;
    const t = txByHash.get(hash);
    return mergeRecord(recs, {
      hash,
      block: b,
      time,
      index: t?.index ?? null,
      sender: t?.from ?? null,
      target: t?.to ?? null,
      failed: false,
      fee: null,
      gasPrice: t?.gasPrice ?? null,
      legs: [],
    });
  };
  // Deterministic keys whatever the log source: native residual -> one of our own successful txs
  // in this block, else "block:<n>:internal"; token residual -> "block:<n>:internal".
  const attach = (asset: string, signed: bigint): void => {
    const incoming = signed > 0n;
    const value = incoming ? signed : -signed;
    let rec: TxRecord;
    let cp = '';
    const ownTx = asset === NATIVE ? pickOwn() : undefined;
    if (ownTx) {
      rec = recordFor(ownTx.hash);
      cp = ownTx.from === me ? (ownTx.to ?? '') : ownTx.from;
    } else {
      rec = recordFor(syntheticHash);
      rec.meta = { ...rec.meta, syntheticTxid: true };
    }
    rec.meta = { ...rec.meta, ...(asset === NATIVE ? { internal: true } : { residual: true }) };
    rec.legs.push({ asset, value, internal: asset === NATIVE, from: incoming ? cp : me, to: incoming ? me : cp });
  };

  // Native
  let explained = 0n;
  for (const r of recs.values()) {
    if (!r.failed) {
      for (const l of r.legs) {
        if (l.asset !== NATIVE || l.from === l.to) continue;
        if (l.to === me) explained += l.value;
        else if (l.from === me) explained -= l.value;
      }
    }
    if (r.sender === me && r.fee) explained -= r.fee;
  }
  const nativeResidual = after.balance - before.balance - explained;
  if (nativeResidual !== 0n) {
    attach(NATIVE, nativeResidual);
    log.debug(`${ctx.network}: block ${b}: internal native movement ${nativeResidual}`);
  }

  // Tokens
  ctx.tokens.forEach((c, i) => {
    let ex = 0n;
    for (const r of recs.values()) {
      for (const l of r.legs) {
        if (l.asset !== c || l.from === l.to) continue;
        if (l.to === me) ex += l.value;
        else if (l.from === me) ex -= l.value;
      }
    }
    const residual = (after.tokens[i] ?? 0n) - (before.tokens[i] ?? 0n) - ex;
    if (residual === 0n) return;
    const msg = `${ctx.network}: block ${b}: token ${c} balance moved ${residual} without a matching Transfer log`;
    if (data.logs) log.warn(msg);
    else log.debug(msg);
    attach(c, residual);
  });

  return [...recs.values()];
}

/** Logs of the successful receipts we fetched that mention the address. */
function receiptLogs(receipts: ReadonlyMap<string, RpcReceipt>, me: string): RpcLog[] {
  return [...receipts.values()].flatMap((r) => (r.success ? r.logs : [])).filter((l) => mentions(l, me));
}

/** eth_getLogs results (if any) merged with the logs of the fetched receipts, deduplicated. */
export function blockLogs(data: BlockData, me: string): RpcLog[] {
  const seen = new Set<string>();
  const out: RpcLog[] = [];
  for (const l of [...(data.logs ?? []), ...receiptLogs(data.receipts, me)]) {
    if (isZeroTransfer(l)) continue;
    const k = `${l.txHash}:${l.logIndex ?? `${l.address}:${l.topics.join(',')}:${l.data}`}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

/**
 * eth_getLogs looks complete: it contains every log of our own receipts that mentions us (a
 * token in and out in separate txs of one block cancels in the balance check, so this catches
 * an empty answer there).
 */
export function logsCoverReceipts(data: BlockData, me: string): boolean {
  if (!data.logs) return false;
  const have = new Set(data.logs.map((l) => `${l.txHash}:${l.logIndex}`));
  return receiptLogs(data.receipts, me).every((l) => isZeroTransfer(l) || have.has(`${l.txHash}:${l.logIndex}`));
}

/** True when the tracked-token Transfer logs account for every token balance change. */
export function logsExplainTokens(
  ctx: Pick<AnalyzeContext, 'address' | 'tokens'>,
  logs: readonly RpcLog[],
  before: ChainState,
  after: ChainState,
): boolean {
  const me = ctx.address;
  return ctx.tokens.every((c, i) => {
    const delta = (after.tokens[i] ?? 0n) - (before.tokens[i] ?? 0n);
    let explained = 0n;
    for (const l of logs) {
      if (l.address !== c || l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
      const from = topicAddress(l.topics[1]);
      const to = topicAddress(l.topics[2]);
      const v = hexQty(l.data) ?? 0n;
      if (from === to) continue;
      if (to === me) explained += v;
      else if (from === me) explained -= v;
    }
    return explained === delta;
  });
}

/**
 * Fetch + analyze one change block. Some nodes answer eth_getLogs for blocks they no longer
 * index with an empty list instead of an error, so logs that do not explain the token balance
 * change are distrusted and the block is re-read through receipts.
 */
export async function analyzeChangeBlock(ctx: AnalyzeContext, block: number, before: ChainState, after: ChainState): Promise<TxRecord[]> {
  let data = await fetchBlockData(ctx, block);
  if (data.logs && (!logsCoverReceipts(data, ctx.address) || !logsExplainTokens(ctx, blockLogs(data, ctx.address), before, after))) {
    log.debug(`${ctx.network}: block ${block}: eth_getLogs answer looks incomplete; scanning receipts`);
    data = await fetchBlockData(ctx, block, { block: data.block, skipLogs: true });
  }
  return analyzeBlockData(ctx, data, before, after);
}
