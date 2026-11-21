/**
 * Provider selection for one UTXO network: an EndpointPool per backend kind plus a freshness
 * check. Every ~30 s all providers' tips are probed in parallel; a provider whose index is more
 * than FRESH_MAX_LAG blocks behind the best tip seen is not used for transaction queries.
 * Blockbook instances whose mempool is far smaller than the best one seen (some public instances
 * only keep a few hundred txs) are ranked after Esplora for mempool-sensitive calls.
 */
import { EndpointPool } from '../../util/http.ts';
import type { Logger } from '../../logger.ts';
import { NETWORKS } from '../../core/networks.ts';
import { BlockbookClient, EsploraClient } from './backends.ts';
import type { BackendKind, ProbeResult, UtxoNetwork } from './types.ts';

export interface ProviderSpec {
  kind: BackendKind;
  /** Blockbook: host root (".../api/v2" is appended). Esplora: API root (e.g. ".../api"). */
  base: string;
}

/** Ordered by preference within each backend kind. */
export const UTXO_PROVIDERS: Record<UtxoNetwork, readonly ProviderSpec[]> = {
  bitcoin: [
    { kind: 'blockbook', base: 'https://btc1.trezor.io' },
    { kind: 'blockbook', base: 'https://btcbook.guarda.co' },
    { kind: 'blockbook', base: 'https://blockbook.btc.zelcore.io' },
    { kind: 'esplora', base: 'https://blockstream.info/api' },
    { kind: 'esplora', base: 'https://mempool.space/api' },
  ],
  litecoin: [
    { kind: 'blockbook', base: 'https://litecoinblockexplorer.net' },
    { kind: 'blockbook', base: 'https://blockbook.ltc.zelcore.io' },
    { kind: 'blockbook', base: 'https://litecoin.atomicwallet.io' },
    { kind: 'esplora', base: 'https://litecoinspace.org/api' },
  ],
};

export const FRESH_MAX_LAG = 3;
const SNAPSHOT_TTL_MS = 30_000;
/** A successful probe older than this no longer counts. */
const TIP_TTL_MS = 5 * 60_000;
/**
 * Do not wait longer than this for slow probes; late answers still update the state. Later rounds
 * can be shorter because providers that are still answering keep their previous tip (<= TIP_TTL).
 */
const FIRST_PROBE_WAIT_MS = 7_000;
const PROBE_WAIT_MS = 2_500;
const FORCED_REFRESH_MIN_GAP_MS = 10_000;
/** Ignore a provider claiming a tip this far above every other provider (bogus data). */
const OUTLIER_BLOCKS = 1_000;
/** Mempool considered degraded below this fraction of the largest recently seen mempool... */
const MEMPOOL_DEGRADED_RATIO = 0.1;
/** ...but only once that reference mempool is big enough for the comparison to mean something. */
const MEMPOOL_REF_MIN = 2_000;
const MEMPOOL_REF_TTL_MS = 6 * 60 * 60_000;
/** No block for this many average block intervals means the provider is stuck (BTC 3 h, LTC 45 min). */
const TIP_AGE_BLOCKS = 18;
/** How long a remembered best tip keeps counting after it last increased. */
const FLOOR_TTL_MS = 24 * 60 * 60_000;

export type Purpose = 'mempool' | 'history';

/** Probe state as seen by the pure ranking function. */
export interface ProviderView {
  id: string;
  kind: BackendKind;
  tip: number | null;
  nodeTip: number | null;
  /** ms timestamp of the last successful probe (0 = never / failed). */
  tipAt: number;
  mempoolSize: number | null;
  inSyncMempool: boolean | null;
  /** Unix seconds of the provider's last block (Esplora) or last indexing (Blockbook), if known. */
  tipTime: number | null;
}

export interface UsableProvider {
  id: string;
  kind: BackendKind;
  tip: number;
  /** False when this Blockbook's mempool looks incomplete (pending txs may be missing). */
  mempoolOk: boolean;
}

export interface Assessment {
  best: number | null;
  /** In spec order. */
  usable: UsableProvider[];
  rejected: Array<{ id: string; reason: string }>;
}

export interface AssessOptions {
  /** Highest tip already known to be real (earlier assessments, persisted cursor heights). */
  floor?: number;
  /** A provider whose last block is older than this (seconds) has stopped following the chain. */
  maxTipAgeSec?: number;
}

const FLOOR_ID = '(known tip)';

/**
 * Pure freshness / mempool assessment of the current probe state. Staleness is judged against
 * the best tip of the other providers and the remembered floor, and by the age of the provider's
 * last block, so a lagging provider is caught even when it is the only one answering.
 */
export function assessProviders(
  views: readonly ProviderView[],
  now: number,
  mempoolRef: number | null,
  opts: AssessOptions = {},
): Assessment {
  const rejected: Assessment['rejected'] = [];
  const live = views.filter((v) => {
    if (v.tip === null || v.tipAt <= 0 || now - v.tipAt > TIP_TTL_MS) {
      rejected.push({ id: v.id, reason: 'no recent successful probe' });
      return false;
    }
    const age = v.tipTime !== null ? now / 1000 - v.tipTime : null;
    if (opts.maxTipAgeSec !== undefined && age !== null && age > opts.maxTipAgeSec) {
      rejected.push({ id: v.id, reason: `stale: last block ${Math.round(age / 60)} min ago` });
      return false;
    }
    return true;
  });
  const claims = live.map((v) => ({ id: v.id, height: Math.max(v.tip as number, v.nodeTip ?? 0) }));
  if (opts.floor !== undefined && opts.floor > 0) claims.push({ id: FLOOR_ID, height: opts.floor });
  claims.sort((a, b) => b.height - a.height);
  while (claims.length >= 2 && (claims[0] as { height: number }).height > (claims[1] as { height: number }).height + OUTLIER_BLOCKS) {
    const bogus = claims.shift() as { id: string; height: number };
    if (bogus.id !== FLOOR_ID) rejected.push({ id: bogus.id, reason: `implausible tip ${bogus.height}` });
  }
  const outliers = new Set(rejected.map((r) => r.id));
  const best = claims[0]?.height ?? null;
  const usable: UsableProvider[] = [];
  for (const v of live) {
    if (outliers.has(v.id) || best === null) continue;
    const tip = v.tip as number;
    if (tip < best - FRESH_MAX_LAG) {
      rejected.push({ id: v.id, reason: `stale: ${best - tip} blocks behind` });
      continue;
    }
    let mempoolOk = true;
    if (v.kind === 'blockbook') {
      if (v.inSyncMempool === false) mempoolOk = false;
      if (
        mempoolRef !== null &&
        mempoolRef >= MEMPOOL_REF_MIN &&
        v.mempoolSize !== null &&
        v.mempoolSize < mempoolRef * MEMPOOL_DEGRADED_RATIO
      ) {
        mempoolOk = false;
      }
    }
    usable.push({ id: v.id, kind: v.kind, tip, mempoolOk });
  }
  return { best, usable, rejected };
}

export interface ProviderGroup {
  kind: BackendKind;
  members: UsableProvider[];
}

/**
 * Preference order. History: Blockbook, then Esplora. Mempool-sensitive calls: Blockbook with a
 * complete mempool, then Esplora, then Blockbook with a degraded mempool.
 */
export function providerGroups(purpose: Purpose, a: Assessment): ProviderGroup[] {
  const bb = a.usable.filter((u) => u.kind === 'blockbook');
  const es = a.usable.filter((u) => u.kind === 'esplora');
  const groups: ProviderGroup[] =
    purpose === 'history'
      ? [
          { kind: 'blockbook', members: bb },
          { kind: 'esplora', members: es },
        ]
      : [
          { kind: 'blockbook', members: bb.filter((u) => u.mempoolOk) },
          { kind: 'esplora', members: es },
          { kind: 'blockbook', members: bb.filter((u) => !u.mempoolOk) },
        ];
  return groups.filter((g) => g.members.length > 0);
}

// --- Runtime ---

export type ActiveProvider =
  | { id: string; kind: 'blockbook'; tip: number; mempoolOk: boolean; client: BlockbookClient }
  | { id: string; kind: 'esplora'; tip: number; mempoolOk: boolean; client: EsploraClient };

interface ProviderState extends ProviderView {
  base: string;
  client: BlockbookClient | EsploraClient;
  probeFailures: number;
  nextProbeAt: number;
}

export class NoFreshProviderError extends Error {
  override name = 'NoFreshProviderError';
}

/** Thrown inside EndpointPool.run for endpoints that are not eligible for this call. */
class SkipProviderError extends Error {
  override name = 'SkipProviderError';
  /** EndpointPool moves on without marking the endpoint unhealthy. */
  readonly skip = true;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

export class ProviderSet {
  readonly network: UtxoNetwork;
  private readonly states: ProviderState[];
  private readonly pools = new Map<BackendKind, EndpointPool>();
  private readonly log: Logger;
  private snapshotAt = 0;
  private lastForcedAt = 0;
  private refreshing: Promise<void> | null = null;
  private mempoolRef: { size: number; at: number } | null = null;
  private floor: { height: number; at: number } | null = null;
  private readonly maxTipAgeSec: number;

  constructor(network: UtxoNetwork, specs: readonly ProviderSpec[], log: Logger) {
    this.network = network;
    this.log = log;
    this.maxTipAgeSec = NETWORKS[network].blockTimeSec * TIP_AGE_BLOCKS;
    this.states = specs.map((s) => {
      const client = s.kind === 'blockbook' ? new BlockbookClient(s.base, log) : new EsploraClient(s.base, log);
      return {
        id: `${s.kind}:${client.host}`,
        kind: s.kind,
        base: client.base,
        client,
        tip: null,
        nodeTip: null,
        tipAt: 0,
        mempoolSize: null,
        inSyncMempool: null,
        tipTime: null,
        probeFailures: 0,
        nextProbeAt: 0,
      };
    });
    for (const kind of ['blockbook', 'esplora'] as const) {
      const urls = this.states.filter((s) => s.kind === kind).map((s) => s.base);
      if (urls.length) this.pools.set(kind, new EndpointPool(`${network}:${kind}`, urls));
    }
  }

  private async probe(s: ProviderState): Promise<void> {
    try {
      const r: ProbeResult = await s.client.probe();
      s.tip = r.tip;
      s.nodeTip = r.nodeTip;
      s.mempoolSize = r.mempoolSize;
      s.inSyncMempool = r.inSyncMempool;
      s.tipTime = r.tipTime;
      s.tipAt = Date.now();
      s.probeFailures = 0;
      s.nextProbeAt = 0;
      if (s.kind === 'blockbook' && r.mempoolSize !== null) {
        const ref = this.mempoolRef;
        if (!ref || r.mempoolSize >= ref.size || Date.now() - ref.at > MEMPOOL_REF_TTL_MS) {
          this.mempoolRef = { size: r.mempoolSize, at: Date.now() };
        }
      }
    } catch (err) {
      s.tipAt = 0;
      s.probeFailures++;
      s.nextProbeAt = Date.now() + Math.min(600_000, 30_000 * 2 ** Math.min(s.probeFailures - 1, 5));
      this.log.debug(`probe failed for ${s.id} (${s.probeFailures}x)`, err);
    }
  }

  private refresh(force: boolean): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const now = Date.now();
      const due = this.states.filter((s) => force || s.nextProbeAt <= now);
      const all = Promise.allSettled(due.map((s) => this.probe(s)));
      await Promise.race([all, waitMs(this.snapshotAt === 0 ? FIRST_PROBE_WAIT_MS : PROBE_WAIT_MS)]);
      this.snapshotAt = Date.now();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Records a height known to be real (e.g. from a persisted cursor). Providers more than
   * FRESH_MAX_LAG blocks below it are stale, even when no fresher provider is answering.
   */
  noteHeight(height: number): void {
    if (!Number.isSafeInteger(height) || height <= 0) return;
    if (!this.floor || height > this.floor.height) this.floor = { height, at: Date.now() };
  }

  private assessNow(): Assessment {
    const now = Date.now();
    const ref = this.mempoolRef && now - this.mempoolRef.at <= MEMPOOL_REF_TTL_MS ? this.mempoolRef.size : null;
    const floor = this.floor && now - this.floor.at <= FLOOR_TTL_MS ? this.floor.height : undefined;
    const a = assessProviders(this.states, now, ref, { maxTipAgeSec: this.maxTipAgeSec, ...(floor ? { floor } : {}) });
    if (a.usable.length > 0 && a.best !== null) this.noteHeight(a.best);
    return a;
  }

  /** Current assessment, re-probing when older than ~30 s (concurrent callers share one round). */
  async assessment(): Promise<Assessment> {
    if (Date.now() - this.snapshotAt > SNAPSHOT_TTL_MS) await this.refresh(false);
    let a = this.assessNow();
    if (a.usable.length === 0 && Date.now() - this.lastForcedAt > FORCED_REFRESH_MIN_GAP_MS) {
      this.lastForcedAt = Date.now();
      await this.refresh(true);
      a = this.assessNow();
    }
    for (const r of a.rejected) this.log.debug(`[${this.network}] not using ${r.id}: ${r.reason}`);
    return a;
  }

  /** Usable providers flattened in preference order for `purpose`. */
  async ordered(purpose: Purpose): Promise<ActiveProvider[]> {
    const a = await this.assessment();
    return providerGroups(purpose, a).flatMap((g) => g.members.map((m) => this.active(m)));
  }

  private active(m: UsableProvider): ActiveProvider {
    const s = this.states.find((x) => x.id === m.id) as ProviderState;
    return s.client.kind === 'blockbook'
      ? { id: s.id, kind: 'blockbook', tip: m.tip, mempoolOk: m.mempoolOk, client: s.client }
      : { id: s.id, kind: 'esplora', tip: m.tip, mempoolOk: m.mempoolOk, client: s.client };
  }

  /**
   * Runs `fn` against the best usable provider, failing over through each backend's EndpointPool
   * (which tracks health / cooldowns) and then to the next group.
   */
  async run<T>(
    purpose: Purpose,
    fn: (p: ActiveProvider) => Promise<T>,
    opts: { signal?: AbortSignal; kinds?: readonly BackendKind[] } = {},
  ): Promise<T> {
    const a = await this.assessment();
    const groups = providerGroups(purpose, a).filter((g) => !opts.kinds || opts.kinds.includes(g.kind));
    if (groups.length === 0) {
      const why = a.rejected.map((r) => `${r.id}: ${r.reason}`).join('; ') || 'none configured';
      throw new NoFreshProviderError(
        `[${this.network}] no fresh ${opts.kinds ? `${opts.kinds.join('/')} ` : ''}provider available (${why})`,
      );
    }
    let lastErr: unknown;
    for (const g of groups) {
      const pool = this.pools.get(g.kind) as EndpointPool;
      const allowed = new Map(g.members.map((m) => [this.active(m).client.base, m]));
      let realErr: unknown;
      try {
        return await pool.run(async (url) => {
          const m = allowed.get(url);
          if (!m) throw new SkipProviderError(`skipped for this ${purpose} call (stale or lower priority)`);
          try {
            return await fn(this.active(m));
          } catch (err) {
            realErr = err;
            throw err;
          }
        }, opts.signal);
      } catch (err) {
        if ((err as { fatal?: boolean } | null)?.fatal || opts.signal?.aborted) throw err;
        lastErr = realErr ?? err;
      }
    }
    throw lastErr;
  }
}

const sets = new Map<UtxoNetwork, ProviderSet>();

/** One shared ProviderSet (and EndpointPools) per network, however many adapters are created. */
export function providerSetFor(network: UtxoNetwork, log: Logger): ProviderSet {
  let s = sets.get(network);
  if (!s) {
    s = new ProviderSet(network, UTXO_PROVIDERS[network], log);
    sets.set(network, s);
  }
  return s;
}
