import type { BackfillOptions, ChainAdapter, Cursor, PollResult, RawTransfer, TxStatusResult } from '../../core/types.ts';
import { createLogger } from '../../logger.ts';
import { chunk, mapLimit, sleep } from '../../util/async.ts';
import type { RpcCall } from '../../util/http.ts';
import { deriveAssociatedTokenAddress, isValidSignature, isValidSolanaAddress, short } from './keys.ts';
import { NATIVE_KEY, SolanaParseError, TRACKED_MINTS, parseSolanaTransaction, type ParseOptions } from './parse.ts';
import {
  EndpointMissError,
  SolanaRpc,
  getTransaction,
  parseLamports,
  parseSignatureList,
  parseSignatureStatuses,
  parseSlot,
  parseTokenAccounts,
  type SignatureInfo,
  type SignatureStatus,
  type TokenAccountInfo,
} from './rpc.ts';

const log = createLogger('solana');

/** First page size when polling from the top (normally the stored head is the first entry). */
const POLL_FIRST_PAGE = 10;
/** A limited-history endpoint is trusted for "no new signatures" only if the head was verified this recently. */
const LIMITED_HISTORY_WINDOW_MS = 6 * 3600_000;
/** Heads this close to a limited node's minimumLedgerSlot (~1 h of slots) may already be pruned there. */
const LEDGER_EDGE_MARGIN = 9_000;
/** Re-list the owner's token accounts every N polls (and whenever the owner has new signatures). */
const TOKEN_REFRESH_EVERY = 20;
/** Reported pending signatures with no status anywhere for this long are dropped (their rows exist). */
const PENDING_UNKNOWN_TTL_MS = 10 * 60_000;
/** Reported pending signatures whose final version stays unfetchable this long are dropped. */
const PENDING_MAX_AGE_MS = 24 * 3600_000;
/** Soft cap for the pending list; only already-reported entries are ever dropped to honour it. */
const MAX_PENDING = 200;
const POLL_TX_CONCURRENCY = 4;
const BACKFILL_CONCURRENCY = 6;
const BACKFILL_CHUNK = 50;
const STATUS_CHUNK = 256;
/** Accounts per batched getSignaturesForAddress request (publicnode caps some methods per batch). */
const SCAN_BATCH = 10;
/** Backfill: signature pages (1000 each) per account before giving up (broken endpoint or non-personal wallet). */
const MAX_BACKFILL_PAGES = 1000;
/** In-flight requests of a poll are aborted after this long (the tracker allows 90 s per poll in total). */
const POLL_HARD_LIMIT_MS = 50_000;
const MAX_FRONTIERS = 1000;

export interface SolanaLimits {
  /** New transactions fetched per poll (oldest first); the rest is picked up by later polls. */
  maxTxPerPoll: number;
  /** No new signature page or transaction chunk is started after this many ms of a poll. */
  pollBudgetMs: number;
  /** Signature pages listed per account and poll (>= 2); bigger backlogs continue next poll. */
  maxScanPages: number;
  /** Pending transactions re-fetched per poll. */
  maxPendingFetches: number;
}

const DEFAULT_LIMITS: SolanaLimits = { maxTxPerPoll: 100, pollBudgetMs: 30_000, maxScanPages: 8, maxPendingFetches: 40 };

// --- Cursor ---

/** Processing position of one watched account. */
export type SolanaHead = {
  /** Newest processed signature (everything older is processed), or null when there is none (up to `slot`). */
  sig: string | null;
  /** Slot of `sig`, or the slot up to which the account was verified empty. */
  slot: number;
  /** Unix ms when `sig` was last verified to be the account's newest signature. */
  at: number;
  /**
   * Catch-up stack for backlogs too large to list in one poll (deepest last). Listing resumes
   * below the deepest entry; once everything between it and the head is processed it is popped.
   */
  frontiers?: string[];
};

export type SolanaPending = {
  sig: string;
  /** Unix ms when first seen. */
  at: number;
  /** Rows were already returned (status "pending"); false = never reported yet, never dropped. */
  emitted: boolean;
  /** Unix ms since when no endpoint reports a status. */
  missingSince?: number;
  /** An error about this entry was already logged. */
  alerted?: boolean;
};

export type SolanaCursor = {
  v: 1;
  /** Confirmed slot when tracking started (backfill boundary for accounts without a head). */
  initSlot: number;
  /** Watched account (owner, its associated token accounts, other token accounts) -> head. */
  heads: Record<string, SolanaHead>;
  /** Non-associated token accounts of the owner for tracked mints -> mint. */
  tokenAccounts: Record<string, string>;
  /** Context slot / time of the last token-account listing. */
  tokenSlot: number;
  tokenAt: number;
  /** Signatures to re-check: not final yet, or not fetchable yet. */
  pending: SolanaPending[];
  polls: number;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const int = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : d);

/** Validates a stored cursor. Throws when it is unusable (tracking must be re-initialized). */
export function readCursor(raw: Cursor): SolanaCursor {
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.heads)) throw new Error('Invalid Solana cursor; re-initialize tracking for this address');
  const heads: Record<string, SolanaHead> = {};
  for (const [k, h] of Object.entries(raw.heads)) {
    if (!isValidSolanaAddress(k) || !isObj(h)) continue;
    if (h.sig !== null && (typeof h.sig !== 'string' || !isValidSignature(h.sig))) continue;
    const head: SolanaHead = { sig: h.sig, slot: int(h.slot), at: int(h.at) };
    if (Array.isArray(h.frontiers)) {
      const f = h.frontiers.filter((s): s is string => typeof s === 'string' && isValidSignature(s)).slice(-MAX_FRONTIERS);
      if (f.length) head.frontiers = f;
    }
    heads[k] = head;
  }
  const tokenAccounts: Record<string, string> = {};
  if (isObj(raw.tokenAccounts)) {
    for (const [k, m] of Object.entries(raw.tokenAccounts)) {
      if (typeof m === 'string' && TRACKED_MINTS.has(m) && isValidSolanaAddress(k)) tokenAccounts[k] = m;
    }
  }
  const pending: SolanaPending[] = [];
  if (Array.isArray(raw.pending)) {
    for (const p of raw.pending) {
      if (!isObj(p) || typeof p.sig !== 'string' || !isValidSignature(p.sig)) continue;
      const e: SolanaPending = { sig: p.sig, at: int(p.at), emitted: p.emitted === true };
      if (typeof p.missingSince === 'number' && Number.isInteger(p.missingSince)) e.missingSince = p.missingSince;
      if (p.alerted === true) e.alerted = true;
      pending.push(e);
    }
  }
  return {
    v: 1,
    initSlot: int(raw.initSlot),
    heads,
    tokenAccounts,
    tokenSlot: int(raw.tokenSlot),
    tokenAt: int(raw.tokenAt),
    pending,
    polls: int(raw.polls),
  };
}

// --- Helpers ---

function assertAddress(address: string): void {
  if (!isValidSolanaAddress(address)) throw new Error('Invalid Solana address');
}

/** Associated token accounts of the owner for every tracked mint (watched even before they exist). */
function derivedAccounts(owner: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const mint of TRACKED_MINTS.keys()) m.set(deriveAssociatedTokenAddress(owner, mint), mint);
  return m;
}

function safeParse(tx: unknown, owner: string, opts: ParseOptions): RawTransfer[] {
  try {
    return parseSolanaTransaction(tx, owner, opts);
  } catch (err) {
    const why = err instanceof SolanaParseError ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    log.warn(`skipping malformed transaction ${short(opts.signature ?? '?')}: ${why}`);
    return [];
  }
}

function sigParams(account: string, limit: number, before?: string): unknown[] {
  return [account, { limit, commitment: 'confirmed', ...(before ? { before } : {}) }];
}

function tokenAccountCalls(owner: string): RpcCall[] {
  return [...TRACKED_MINTS.keys()].map((mint) => ({
    method: 'getTokenAccountsByOwner',
    params: [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
  }));
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('aborted');
}

/** Result of listing one account's new signatures. */
interface Scan {
  /** New signatures, newest first, between the head and the scan start (top or deepest frontier). */
  sigs: SignatureInfo[];
  /** The listing reached the head, so `sigs` is the complete range. */
  complete: boolean;
}

interface PollCtx {
  now: number;
  deadline: number;
  signal: AbortSignal;
  limits: SolanaLimits;
}

type FetchResult = { kind: 'rows'; rows: RawTransfer[] } | { kind: 'missing' } | { kind: 'error' };

// --- Adapter ---

export interface SolanaAdapterOptions {
  /** Custom RPC client (endpoint pools); defaults to a shared client over the built-in endpoints. */
  rpc?: SolanaRpc;
  /** Per-poll work limits (tests / tuning). */
  limits?: Partial<SolanaLimits>;
}

let sharedRpc: SolanaRpc | null = null;

export function createSolanaAdapter(options: SolanaAdapterOptions = {}): ChainAdapter & { readonly rpc: SolanaRpc } {
  const rpc = options.rpc ?? (sharedRpc ??= new SolanaRpc());
  const limits: SolanaLimits = { ...DEFAULT_LIMITS, ...options.limits };
  limits.maxScanPages = Math.max(2, limits.maxScanPages);
  limits.maxTxPerPoll = Math.max(1, limits.maxTxPerPoll);

  /** Current token accounts (tracked mints) owned by `owner`, plus the context slot. */
  async function listTokenAccounts(owner: string, signal?: AbortSignal) {
    const res = await rpc.batch(rpc.indexed, tokenAccountCalls(owner), { signal });
    let slot = 0;
    const accounts: TokenAccountInfo[] = [];
    for (const r of res) {
      const parsed = parseTokenAccounts(r);
      slot = Math.max(slot, parsed.slot);
      for (const a of parsed.accounts) if (a.owner === owner && TRACKED_MINTS.has(a.mint)) accounts.push(a);
    }
    return { slot, accounts };
  }

  /**
   * Lists signatures of `account` newer than its head (below its deepest frontier, if any) on
   * endpoint `url`, at most `maxScanPages` pages. Throws EndpointMissError when a limited-history
   * endpoint cannot prove completeness or makes no paging progress.
   */
  async function scanAccountAt(url: string, account: string, head: SolanaHead, ctx: PollCtx, firstPage?: SignatureInfo[]): Promise<Scan> {
    const ep = rpc.endpoint(url);
    const sigs: SignatureInfo[] = [];
    const frontier = head.frontiers?.[head.frontiers.length - 1];
    let before = frontier;
    let page = frontier === undefined ? firstPage : undefined;
    for (let i = 0; ; i++) {
      if (i >= ctx.limits.maxScanPages || (i >= 2 && Date.now() >= ctx.deadline)) {
        // Backlog too large for this poll. Full history continues below it next poll;
        // a limited endpoint hands over to full history (bigger pages, no gaps).
        if (!ep.fullHistory) throw new EndpointMissError(`large backlog for ${short(account)} at ${new URL(url).host}`);
        return { sigs, complete: false };
      }
      const limit = i === 0 && before === undefined ? POLL_FIRST_PAGE : ep.fullHistory ? 1000 : 100;
      const list =
        page ??
        parseSignatureList(await rpc.callAt(url, 'getSignaturesForAddress', sigParams(account, limit, before), { signal: ctx.signal }));
      page = undefined;
      for (const s of list) {
        if (head.sig !== null && s.signature === head.sig) return { sigs, complete: true };
        if (s.slot < head.slot) return { sigs, complete: true }; // below the head (head itself vanished from the fork)
        sigs.push(s);
      }
      if (list.length === 0) {
        // End of the list without reaching the head. Fine on full history. On a limited endpoint
        // only if the head was verified recently as the newest signature (so every newer one is
        // inside the node's window) and the head itself is older than that window.
        if (ep.fullHistory) return { sigs, complete: true };
        if (frontier === undefined && ctx.now - head.at < LIMITED_HISTORY_WINDOW_MS) {
          if (head.sig === null) return { sigs, complete: true };
          const start = await rpc.ledgerStart(url, ctx.signal);
          if (start === null || head.slot < start + LEDGER_EDGE_MARGIN) return { sigs, complete: true };
        }
        throw new EndpointMissError(`history gap for ${short(account)} at ${new URL(url).host}`);
      }
      const oldest = list[list.length - 1]!.signature;
      if (oldest === before) throw new EndpointMissError(`no paging progress for ${short(account)} at ${new URL(url).host}`);
      before = oldest;
    }
  }

  /** Scans several accounts: one batched request on the live pool, full history for gaps and catch-ups. */
  async function scanAccounts(accounts: string[], heads: Record<string, SolanaHead>, ctx: PollCtx): Promise<Map<string, Scan>> {
    const result = new Map<string, Scan>();
    const fromTop = accounts.filter((a) => !heads[a]!.frontiers?.length);
    const viaHistory = accounts.filter((a) => heads[a]!.frontiers?.length);
    if (fromTop.length) {
      const gaps: string[] = [];
      await rpc.live.run(async (url) => {
        result.clear();
        gaps.length = 0;
        const pages: SignatureInfo[][] = [];
        for (const part of chunk(fromTop, SCAN_BATCH)) {
          const calls = part.map((a) => ({ method: 'getSignaturesForAddress', params: sigParams(a, POLL_FIRST_PAGE) }));
          pages.push(...(await rpc.batchAt(url, calls, { signal: ctx.signal })).map(parseSignatureList));
        }
        for (const [i, a] of fromTop.entries()) {
          try {
            result.set(a, await scanAccountAt(url, a, heads[a]!, ctx, pages[i]));
          } catch (err) {
            if (!(err instanceof EndpointMissError)) throw err;
            gaps.push(a);
          }
        }
      }, ctx.signal);
      viaHistory.push(...gaps);
    }
    for (const a of viaHistory) {
      log.debug(`scanning ${short(a)} on a full-history endpoint`);
      result.set(a, await rpc.historyPool(0).run((url) => scanAccountAt(url, a, heads[a]!, ctx), ctx.signal));
    }
    return result;
  }

  async function signatureStatuses(sigs: string[], signal?: AbortSignal, history = false): Promise<Array<SignatureStatus | null>> {
    const out: Array<SignatureStatus | null> = [];
    for (const part of chunk(sigs, STATUS_CHUNK)) {
      const pool = history ? rpc.historyPool(0) : rpc.live;
      const res = await rpc.call(pool, 'getSignatureStatuses', [part, { searchTransactionHistory: true }], { signal });
      out.push(...parseSignatureStatuses(res, part.length));
    }
    return out;
  }

  /** Statuses from the live pool, re-asking full history for the ones it does not know. */
  async function statusesWithHistory(sigs: string[], signal: AbortSignal): Promise<Array<SignatureStatus | null>> {
    const st = await signatureStatuses(sigs, signal);
    const unknown = sigs.filter((_, i) => !st[i]);
    if (unknown.length) {
      const hist = await signatureStatuses(unknown, signal, true);
      let j = 0;
      for (let i = 0; i < sigs.length; i++) if (!st[i]) st[i] = hist[j++] ?? null;
    }
    return st;
  }

  const adapter: ChainAdapter & { readonly rpc: SolanaRpc } = {
    network: 'solana',
    rpc,

    async getTip(signal) {
      return parseSlot(await rpc.call(rpc.live, 'getSlot', [{ commitment: 'confirmed' }], { signal }));
    },

    async getBalances(address, signal) {
      assertAddress(address);
      const calls: RpcCall[] = [{ method: 'getBalance', params: [address, { commitment: 'confirmed' }] }, ...tokenAccountCalls(address)];
      const [bal, ...tok] = await rpc.batch(rpc.indexed, calls, { signal });
      const out = new Map<string, bigint>([[NATIVE_KEY, parseLamports(bal)]]);
      for (const key of TRACKED_MINTS.values()) out.set(key, 0n);
      for (const r of tok) {
        for (const a of parseTokenAccounts(r).accounts) {
          const key = TRACKED_MINTS.get(a.mint);
          if (key && a.owner === address) out.set(key, (out.get(key) ?? 0n) + a.amount);
        }
      }
      return out;
    },

    async initCursor(address, signal) {
      assertAddress(address);
      const now = Date.now();
      const [tipRaw, ...tokRaw] = await rpc.batch(
        rpc.indexed,
        [{ method: 'getSlot', params: [{ commitment: 'confirmed' }] }, ...tokenAccountCalls(address)],
        { signal },
      );
      const tip = parseSlot(tipRaw);
      const derived = derivedAccounts(address);
      const tokenAccounts: Record<string, string> = {};
      let tokenSlot = tip;
      for (const r of tokRaw) {
        const parsed = parseTokenAccounts(r);
        tokenSlot = Math.max(tokenSlot, parsed.slot);
        for (const a of parsed.accounts) {
          if (a.owner === address && TRACKED_MINTS.has(a.mint) && !derived.has(a.pubkey)) tokenAccounts[a.pubkey] = a.mint;
        }
      }
      const accounts = [address, ...derived.keys(), ...Object.keys(tokenAccounts)];
      // Heads must come from a full-history endpoint: an empty answer then really means "no history".
      const pages = await rpc.batch(
        rpc.historyPool(0),
        accounts.map((a) => ({ method: 'getSignaturesForAddress', params: sigParams(a, 1) })),
        { signal },
      );
      const heads: Record<string, SolanaHead> = {};
      for (const [i, a] of accounts.entries()) {
        const top = parseSignatureList(pages[i])[0];
        heads[a] = top ? { sig: top.signature, slot: top.slot, at: now } : { sig: null, slot: tip, at: now };
      }
      const cursor: SolanaCursor = { v: 1, initSlot: tip, heads, tokenAccounts, tokenSlot, tokenAt: now, pending: [], polls: 0 };
      return cursor;
    },

    async poll(address, rawCursor, signal): Promise<PollResult> {
      assertAddress(address);
      const c = readCursor(rawCursor);
      const now = Date.now();
      const hard = AbortSignal.timeout(POLL_HARD_LIMIT_MS);
      const work = signal ? AbortSignal.any([signal, hard]) : hard;
      const ctx: PollCtx = { now, deadline: now + limits.pollBudgetMs, signal: work, limits };
      const overBudget = () => Date.now() >= ctx.deadline;
      const derived = derivedAccounts(address);
      const watched = [address, ...derived.keys(), ...Object.keys(c.tokenAccounts)];
      // Accounts missing a head (older cursor) start at the init slot and must be verified on full history.
      for (const a of watched) c.heads[a] ??= { sig: null, slot: c.initSlot, at: 0 };

      const scans = await scanAccounts(watched, c.heads, ctx);

      // Token accounts: new ATAs always touch the owner (the ATA program takes the wallet as an
      // account), so refresh on owner activity; non-ATA accounts are caught by the periodic refresh.
      if ((scans.get(address)?.sigs.length ?? 0) > 0 || c.polls % TOKEN_REFRESH_EVERY === 0) {
        const { slot, accounts } = await listTokenAccounts(address, work);
        const next: Record<string, string> = {};
        for (const a of accounts) if (!derived.has(a.pubkey)) next[a.pubkey] = a.mint;
        const added = Object.keys(next).filter((k) => !(k in c.tokenAccounts));
        for (const k of Object.keys(c.tokenAccounts)) if (!(k in next)) delete c.heads[k];
        for (const k of added) c.heads[k] ??= { sig: null, slot: c.tokenSlot, at: c.tokenAt };
        if (added.length) {
          log.debug(`discovered ${added.length} new token account(s) for ${short(address)}`);
          for (const [k, v] of await scanAccounts(added, c.heads, ctx)) scans.set(k, v);
        }
        c.tokenAccounts = next;
        c.tokenSlot = Math.max(c.tokenSlot, slot);
        c.tokenAt = now;
      }

      const ownerTokenAccounts = new Set([...derived.keys(), ...Object.keys(c.tokenAccounts)]);
      const fetchRows = async (sig: string, finalized: boolean): Promise<FetchResult> => {
        let tx: unknown;
        try {
          tx = await getTransaction(rpc, rpc.live, sig, { signal: work });
        } catch (err) {
          if (signal?.aborted) throw err;
          if (!hard.aborted) log.warn(`could not fetch transaction ${short(sig)}; will retry`, err);
          return { kind: 'error' };
        }
        if (tx === null) return { kind: 'missing' };
        return { kind: 'rows', rows: safeParse(tx, address, { finalized, signature: sig, ownerTokenAccounts }) };
      };

      const transfers: RawTransfer[] = [];
      const nextPending: SolanaPending[] = [];
      /** Signatures whose fate is recorded (reported, or kept in pending) -> heads may move past them. */
      const handled = new Set(c.pending.map((p) => p.sig));

      // 1) Re-check pending signatures. Never-reported ones are never dropped.
      if (c.pending.length) {
        const statuses = await statusesWithHistory(
          c.pending.map((p) => p.sig),
          work,
        );
        let fetches = 0;
        for (const [i, p] of c.pending.entries()) {
          const st = statuses[i] ?? null;
          if (st === null) {
            const since = p.missingSince ?? now;
            const stale = now - since > PENDING_UNKNOWN_TTL_MS;
            if (stale && p.emitted) {
              log.warn(`dropping pending transaction ${short(p.sig)}: no status on any endpoint for 10 min`);
              continue;
            }
            if (stale && !p.alerted) {
              log.error(`transaction ${short(p.sig)} of ${short(address)} has had no status for 10 min and was never reported; keeping it`);
            }
            nextPending.push({ ...p, missingSince: since, ...(stale ? { alerted: true } : {}) });
            continue;
          }
          const cur: SolanaPending = { sig: p.sig, at: p.at, emitted: p.emitted, ...(p.alerted ? { alerted: true } : {}) };
          const final = st.confirmationStatus === 'finalized';
          if ((!final && p.emitted) || fetches >= limits.maxPendingFetches || (fetches > 0 && overBudget())) {
            nextPending.push(cur);
            continue;
          }
          fetches++;
          const r = await fetchRows(p.sig, final);
          if (r.kind !== 'rows') {
            const old = now - p.at > PENDING_MAX_AGE_MS;
            if (old && p.emitted) {
              log.warn(`dropping pending transaction ${short(p.sig)}: final version not fetchable for 24 h`);
              continue;
            }
            if (old && !cur.alerted) {
              log.error(
                `transaction ${short(p.sig)} of ${short(address)} has been unfetchable for 24 h and was never reported; keeping it`,
              );
              cur.alerted = true;
            }
            nextPending.push(cur);
            continue;
          }
          transfers.push(...r.rows);
          if (!final && r.rows.some((x) => x.status === 'pending')) nextPending.push({ ...cur, emitted: true });
        }
      }

      // 2) New signatures from fully listed ranges, oldest first, bounded per poll.
      const candidates = new Map<string, SignatureInfo>();
      for (const s of scans.values()) if (s.complete) for (const x of s.sigs) if (!handled.has(x.signature)) candidates.set(x.signature, x);
      const ordered = [...candidates.values()]
        .sort((a, b) => a.slot - b.slot || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0))
        .slice(0, limits.maxTxPerPoll);
      let chunks = 0;
      for (const part of chunk(ordered, POLL_TX_CONCURRENCY)) {
        if (chunks++ > 0 && overBudget()) break;
        const results = await mapLimit(part, POLL_TX_CONCURRENCY, async (s) => ({
          s,
          r: await fetchRows(s.signature, s.confirmationStatus === 'finalized'),
        }));
        let failed = false;
        for (const { s, r } of results) {
          if (r.kind === 'error') {
            failed = true; // not handled: the head stays below it and the next poll retries
            continue;
          }
          handled.add(s.signature);
          if (r.kind === 'missing') {
            log.warn(`transaction ${short(s.signature)} is listed but not fetchable yet; keeping it pending`);
            nextPending.push({ sig: s.signature, at: now, emitted: false });
            continue;
          }
          transfers.push(...r.rows);
          if (r.rows.some((x) => x.status === 'pending')) nextPending.push({ sig: s.signature, at: now, emitted: true });
        }
        if (failed) break;
      }

      // 3) Advance heads over the handled prefix only (oldest first).
      const stillWatched = (a: string) => a === address || derived.has(a) || a in c.tokenAccounts;
      for (const [a, scan] of scans) {
        const h = c.heads[a];
        if (!h || !stillWatched(a)) continue;
        if (!scan.complete) {
          // Continue listing below this range next poll. The new frontier is the second-to-last
          // signature, so re-listing the range later still reaches the head within the page cap.
          const f = scan.sigs[scan.sigs.length - 2];
          if (f) h.frontiers = [...(h.frontiers ?? []), f.signature].slice(-MAX_FRONTIERS);
          continue;
        }
        let caughtUp = true;
        for (let i = scan.sigs.length - 1; i >= 0; i--) {
          const s = scan.sigs[i]!;
          if (!handled.has(s.signature)) {
            caughtUp = false;
            break;
          }
          h.sig = s.signature;
          h.slot = s.slot;
        }
        if (!caughtUp) continue;
        if (h.frontiers?.length) {
          h.frontiers.pop();
          if (!h.frontiers.length) delete h.frontiers;
        } else {
          h.at = now;
        }
      }

      if (nextPending.length > MAX_PENDING) {
        // Drop the oldest already-reported entries only (their rows exist; the tracker re-checks them).
        let excess = nextPending.length - MAX_PENDING;
        const kept = nextPending.filter((p) => !(p.emitted && excess-- > 0));
        log.warn(
          `pending list for ${short(address)} exceeded ${MAX_PENDING}; dropped ${nextPending.length - kept.length} reported entries`,
        );
        if (kept.length > MAX_PENDING)
          log.error(`${kept.length} pending transactions of ${short(address)} are waiting; keeping all unreported ones`);
        nextPending.splice(0, nextPending.length, ...kept);
      }
      c.pending = nextPending;
      c.polls++;
      return { transfers, cursor: c };
    },

    async backfill(address, boundary, opts: BackfillOptions = {}) {
      assertAddress(address);
      const c = readCursor(boundary);
      const signal = opts.signal;
      const derived = derivedAccounts(address);
      const accounts = new Map<string, SolanaHead | null>();
      for (const a of [address, ...derived.keys(), ...Object.keys(c.tokenAccounts)]) accounts.set(a, c.heads[a] ?? null);
      try {
        for (const a of (await listTokenAccounts(address, signal)).accounts) if (!accounts.has(a.pubkey)) accounts.set(a.pubkey, null);
      } catch (err) {
        if (signal?.aborted) throw err;
        log.warn(`backfill: could not refresh token accounts for ${short(address)}`, err);
      }

      /* -- 1. list every signature up to the boundary ------------------------ */
      const all = new Map<string, SignatureInfo>();
      const headSigs = new Map<string, SolanaHead>();
      const listPool = rpc.historyPool(0);
      for (const [account, head] of accounts) {
        let before: string | undefined;
        let maxSlot = c.initSlot;
        if (head?.sig) {
          headSigs.set(head.sig, head);
          before = head.sig;
          maxSlot = Number.MAX_SAFE_INTEGER;
        }
        const seen = new Set<string>();
        for (let pageNo = 0; ; pageNo++) {
          if (signal?.aborted) throw abortError(signal);
          if (pageNo >= MAX_BACKFILL_PAGES) {
            throw new Error(`Backfill stopped: more than ${MAX_BACKFILL_PAGES * 1000} signatures for account ${short(account)}`);
          }
          const from = before;
          const list = await listPool.run(async (url) => {
            const l = parseSignatureList(
              await rpc.callAt(url, 'getSignaturesForAddress', sigParams(account, 1000, from), { signal, retries: 2 }),
            );
            // An endpoint that ignores `before` would repeat the same page forever.
            if (l.length && (l[l.length - 1]!.signature === from || l.every((s) => seen.has(s.signature)))) {
              throw new EndpointMissError(`no paging progress for ${short(account)} at ${new URL(url).host}`);
            }
            // Some endpoints answer [] for a `before` signature they do not know (instead of an
            // error). Only trust an empty first page if this endpoint knows that signature.
            if (!l.length && pageNo === 0 && from) {
              const st = parseSignatureStatuses(
                await rpc.callAt(url, 'getSignatureStatuses', [[from], { searchTransactionHistory: true }], { signal, retries: 2 }),
                1,
              );
              if (!st[0]) throw new EndpointMissError(`${new URL(url).host} does not know ${short(from)}`);
            }
            return l;
          }, signal);
          for (const s of list) {
            seen.add(s.signature);
            if (s.slot <= maxSlot) all.set(s.signature, s);
          }
          opts.onProgress?.({ stage: 'Listing signatures', done: all.size });
          if (list.length === 0) break;
          before = list[list.length - 1]!.signature;
        }
      }
      const missingHeads = [...headSigs.keys()].filter((s) => !all.has(s));
      if (missingHeads.length) {
        const st = await signatureStatuses(missingHeads, signal, true);
        for (const [i, sig] of missingHeads.entries()) {
          const s = st[i] ?? null;
          const head = headSigs.get(sig)!;
          all.set(sig, {
            signature: sig,
            slot: s?.slot ?? head.slot,
            failed: s?.failed ?? false,
            blockTime: null,
            confirmationStatus: s?.confirmationStatus ?? null,
          });
        }
      }

      /* -- 2. fetch and parse, oldest first ---------------------------------- */
      const sigs = [...all.values()].sort((a, b) => a.slot - b.slot);
      const total = sigs.length;
      const ownerTokenAccounts = new Set([...accounts.keys()].filter((a) => a !== address));
      const fetchOne = async (s: SignatureInfo, i: number): Promise<RawTransfer[]> => {
        for (let attempt = 0; ; attempt++) {
          if (signal?.aborted) throw abortError(signal);
          try {
            const tx = await getTransaction(rpc, rpc.historyPool(i), s.signature, { signal, retries: 2 });
            if (tx === null) {
              log.warn(`backfill: transaction ${short(s.signature)} is not available on any endpoint; skipped`);
              return [];
            }
            return safeParse(tx, address, { finalized: s.confirmationStatus === 'finalized', signature: s.signature, ownerTokenAccounts });
          } catch (err) {
            if (signal?.aborted || attempt >= 2) throw err;
            await sleep(2000 * (attempt + 1) ** 2, signal);
          }
        }
      };
      const out: RawTransfer[] = [];
      let done = 0;
      opts.onProgress?.({ stage: 'Fetching transactions', done, total, fraction: total ? 0 : 1 });
      for (const part of chunk(sigs, BACKFILL_CHUNK)) {
        const offset = done;
        const rows = (await mapLimit(part, BACKFILL_CONCURRENCY, (s, i) => fetchOne(s, offset + i))).flat();
        done += part.length;
        out.push(...rows);
        if (rows.length) await opts.onBatch?.(rows);
        opts.onProgress?.({ stage: 'Fetching transactions', done, total, fraction: total ? done / total : 1 });
      }
      return out;
    },

    async getTxStatus(txid, _address, signal): Promise<TxStatusResult> {
      if (!isValidSignature(txid)) return { state: 'unknown' };
      let st = (await signatureStatuses([txid], signal))[0] ?? null;
      st ??= (await signatureStatuses([txid], signal, true))[0] ?? null;
      if (st === null) return { state: 'unknown' };
      if (st.failed) return { state: 'failed', blockHeight: st.slot };
      if (st.confirmationStatus !== 'finalized') return { state: 'pending', blockHeight: st.slot };
      let blockTime: number | null = null;
      try {
        const t = await rpc.call(rpc.indexed, 'getBlockTime', [st.slot], { signal });
        blockTime = typeof t === 'number' && Number.isFinite(t) ? t : null;
      } catch (err) {
        if (signal?.aborted) throw err;
      }
      return { state: 'confirmed', blockHeight: st.slot, blockTime };
    },
  };
  return adapter;
}
