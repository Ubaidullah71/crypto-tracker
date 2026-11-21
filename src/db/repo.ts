import type { AssetId } from '../core/assets.ts';
import { getNetworkAsset, type NetworkFamily, type NetworkId } from '../core/networks.ts';
import type { Cursor, RawTransfer, TransferDirection } from '../core/types.ts';
import { nowSec } from '../util/async.ts';
import { getDb } from './database.ts';

/* ================================ Wallets ================================= */

export interface WalletRow {
  id: number;
  label: string;
  address: string;
  family: NetworkFamily;
  notify_enabled: number;
  notify_channel_id: string | null;
  created_at: number;
  /** Name last applied from wallets.txt (null if never). */
  file_label: string | null;
  /** Sorted network list last applied from wallets.txt (null if never). */
  file_networks: string | null;
}

export interface WalletNetworkRow {
  id: number;
  wallet_id: number;
  network: NetworkId;
  cursor: string | null;
  boundary: string | null;
  tracking_since: number;
  backfill_status: 'pending' | 'running' | 'done' | 'error';
  backfill_progress: string | null;
  backfill_error: string | null;
  backfill_started_at: number | null;
  backfill_finished_at: number | null;
  last_poll_at: number | null;
  last_poll_ok_at: number | null;
  last_error: string | null;
  consecutive_errors: number;
  balances_updated_at: number | null;
}

export interface WalletNetworkJoined extends WalletNetworkRow {
  label: string;
  address: string;
  family: NetworkFamily;
  notify_enabled: number;
  notify_channel_id: string | null;
}

export const wallets = {
  list(): WalletRow[] {
    return getDb().all<WalletRow>('SELECT * FROM wallets ORDER BY label COLLATE NOCASE');
  },
  get(id: number): WalletRow | undefined {
    return getDb().get<WalletRow>('SELECT * FROM wallets WHERE id = ?', [id]);
  },
  byLabel(label: string): WalletRow | undefined {
    return getDb().get<WalletRow>('SELECT * FROM wallets WHERE label = ? COLLATE NOCASE', [label.trim()]);
  },
  byAddress(address: string): WalletRow[] {
    return getDb().all<WalletRow>('SELECT * FROM wallets WHERE address = ? COLLATE NOCASE', [address]);
  },
  create(w: { label: string; address: string; family: NetworkFamily }): number {
    return getDb().run('INSERT INTO wallets (label, address, family, created_at) VALUES (?, ?, ?, ?)', [
      w.label.trim(),
      w.address,
      w.family,
      nowSec(),
    ]).lastInsertRowid;
  },
  rename(id: number, label: string): void {
    getDb().run('UPDATE wallets SET label = ? WHERE id = ?', [label.trim(), id]);
  },
  /** Records what wallets.txt last applied to this wallet. */
  setFileState(id: number, fileLabel: string | null, fileNetworks: string | null): void {
    getDb().run('UPDATE wallets SET file_label = ?, file_networks = ? WHERE id = ?', [fileLabel, fileNetworks, id]);
  },
  setNotify(id: number, enabled: boolean, channelId: string | null | undefined): void {
    if (channelId === undefined) getDb().run('UPDATE wallets SET notify_enabled = ? WHERE id = ?', [enabled, id]);
    else getDb().run('UPDATE wallets SET notify_enabled = ?, notify_channel_id = ? WHERE id = ?', [enabled, channelId, id]);
  },
  remove(id: number): void {
    getDb().run('DELETE FROM wallets WHERE id = ?', [id]);
  },
};

const JOIN_SQL = `SELECT wn.*, w.label, w.address, w.family, w.notify_enabled, w.notify_channel_id
  FROM wallet_networks wn JOIN wallets w ON w.id = wn.wallet_id`;

export const walletNetworks = {
  all(): WalletNetworkJoined[] {
    return getDb().all<WalletNetworkJoined>(`${JOIN_SQL} ORDER BY w.label COLLATE NOCASE, wn.network`);
  },
  forWallet(walletId: number): WalletNetworkJoined[] {
    return getDb().all<WalletNetworkJoined>(`${JOIN_SQL} WHERE wn.wallet_id = ? ORDER BY wn.network`, [walletId]);
  },
  get(id: number): WalletNetworkJoined | undefined {
    return getDb().get<WalletNetworkJoined>(`${JOIN_SQL} WHERE wn.id = ?`, [id]);
  },
  create(walletId: number, network: NetworkId, cursor: Cursor): number {
    const json = JSON.stringify(cursor);
    return getDb().run(`INSERT INTO wallet_networks (wallet_id, network, cursor, boundary, tracking_since) VALUES (?, ?, ?, ?, ?)`, [
      walletId,
      network,
      json,
      json,
      nowSec(),
    ]).lastInsertRowid;
  },
  remove(id: number): void {
    getDb().run('DELETE FROM wallet_networks WHERE id = ?', [id]);
  },
  saveCursor(id: number, cursor: Cursor): void {
    getDb().run('UPDATE wallet_networks SET cursor = ? WHERE id = ?', [JSON.stringify(cursor), id]);
  },
  pollOk(id: number): void {
    const t = nowSec();
    getDb().run(
      'UPDATE wallet_networks SET last_poll_at = ?, last_poll_ok_at = ?, last_error = NULL, consecutive_errors = 0 WHERE id = ?',
      [t, t, id],
    );
  },
  pollFailed(id: number, error: string): void {
    getDb().run('UPDATE wallet_networks SET last_poll_at = ?, last_error = ?, consecutive_errors = consecutive_errors + 1 WHERE id = ?', [
      nowSec(),
      error.slice(0, 500),
      id,
    ]);
  },
  setBackfill(
    id: number,
    status: WalletNetworkRow['backfill_status'],
    fields: { progress?: string | null; error?: string | null } = {},
  ): void {
    const t = nowSec();
    if (status === 'running') {
      getDb().run(
        `UPDATE wallet_networks SET backfill_status = 'running', backfill_started_at = ?, backfill_error = NULL,
         backfill_progress = ? WHERE id = ?`,
        [t, fields.progress ?? null, id],
      );
    } else if (status === 'done' || status === 'error') {
      getDb().run(
        `UPDATE wallet_networks SET backfill_status = ?, backfill_finished_at = ?, backfill_error = ?, backfill_progress = ? WHERE id = ?`,
        [status, t, fields.error ?? null, fields.progress ?? null, id],
      );
    } else {
      getDb().run(`UPDATE wallet_networks SET backfill_status = 'pending', backfill_error = NULL, backfill_progress = NULL WHERE id = ?`, [
        id,
      ]);
    }
  },
  setBackfillProgress(id: number, progress: string): void {
    getDb().run('UPDATE wallet_networks SET backfill_progress = ? WHERE id = ?', [progress, id]);
  },
};

/* ================================ Settings ================================ */

export function getSetting<T>(key: string): T | undefined {
  const row = getDb().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb().run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    JSON.stringify(value),
  ]);
}

/* =============================== Transfers ================================ */

export type TransferStatusDb = 'pending' | 'confirmed' | 'failed' | 'dropped';

export const CATEGORIES = ['auto', 'payment', 'purchase', 'transfer', 'sale', 'spend', 'internal', 'ignored'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface TransferRow {
  id: number;
  wallet_network_id: number;
  network: NetworkId;
  asset_key: string;
  asset: AssetId;
  txid: string;
  sub_id: string;
  direction: TransferDirection;
  amount: string;
  decimals: number;
  fee: string | null;
  charge_fee: number;
  counterparty: string | null;
  counterparties: string | null;
  block_height: number | null;
  block_time: number | null;
  status: TransferStatusDb;
  first_seen_at: number;
  confirmed_at: number | null;
  backfilled: number;
  price_usd: number | null;
  price_source: string | null;
  fee_price_usd: number | null;
  category: Category;
  price_override: number | null;
  note: string | null;
  meta: string | null;
  notify_skipped: number;
  notified_seen_at: number | null;
  notified_confirmed_at: number | null;
  notified_dropped_at: number | null;
  /** 1 = address-poisoning dust: hidden from lists and notifications, still counted. */
  spam: number;
}

export interface TransferWithWallet extends TransferRow {
  wallet_id: number;
  label: string;
  address: string;
}

export interface UpsertResult {
  id: number;
  isNew: boolean;
  /** Status, block or amount changed for an existing row. */
  changed: boolean;
}

const T_JOIN = `SELECT t.*, w.id AS wallet_id, w.label, w.address FROM transfers t
  JOIN wallet_networks wn ON wn.id = t.wallet_network_id
  JOIN wallets w ON w.id = wn.wallet_id`;

export interface TransferFilter {
  walletId?: number;
  asset?: AssetId;
  network?: NetworkId;
  direction?: TransferDirection;
  from?: number;
  to?: number;
  includeIgnored?: boolean;
}

function filterSql(f: TransferFilter): { where: string; params: unknown[] } {
  const parts: string[] = ["t.status != 'dropped'"];
  const params: unknown[] = [];
  if (f.walletId !== undefined) {
    parts.push('w.id = ?');
    params.push(f.walletId);
  }
  if (f.asset) {
    parts.push('t.asset = ?');
    params.push(f.asset);
  }
  if (f.network) {
    parts.push('t.network = ?');
    params.push(f.network);
  }
  if (f.direction) {
    parts.push('t.direction = ?');
    params.push(f.direction);
  }
  if (f.from !== undefined) {
    parts.push('COALESCE(t.block_time, t.first_seen_at) >= ?');
    params.push(f.from);
  }
  if (f.to !== undefined) {
    parts.push('COALESCE(t.block_time, t.first_seen_at) < ?');
    params.push(f.to);
  }
  if (!f.includeIgnored) parts.push("t.category != 'ignored' AND t.spam = 0");
  return { where: parts.join(' AND '), params };
}

export const transfers = {
  /**
   * Inserts or updates a transfer by (wallet network, txid, subId). User edits (category,
   * price override, note), notification flags and prices are never overwritten.
   */
  upsert(walletNetworkId: number, raw: RawTransfer, backfilled: boolean): UpsertResult {
    const db = getDb();
    const asset = getNetworkAsset(raw.assetKey);
    if (!asset) throw new Error(`Unknown asset key ${raw.assetKey}`);
    const existing = db.get<TransferRow>('SELECT * FROM transfers WHERE wallet_network_id = ? AND txid = ? AND sub_id = ?', [
      walletNetworkId,
      raw.txid,
      raw.subId,
    ]);
    const now = nowSec();
    const status: TransferStatusDb = raw.status;
    const meta = raw.meta ? JSON.stringify(raw.meta) : null;
    const cps = raw.counterparties?.length ? JSON.stringify(raw.counterparties.slice(0, 20)) : null;
    if (!existing) {
      const id = db.run(
        `INSERT INTO transfers (wallet_network_id, network, asset_key, asset, txid, sub_id, direction, amount, decimals,
          fee, charge_fee, counterparty, counterparties, block_height, block_time, status, first_seen_at, confirmed_at,
          backfilled, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          walletNetworkId,
          asset.network,
          asset.key,
          asset.asset,
          raw.txid,
          raw.subId,
          raw.direction,
          raw.amount.toString(),
          asset.decimals,
          raw.fee === null ? null : raw.fee.toString(),
          raw.chargeFee,
          raw.counterparty,
          cps,
          raw.blockHeight,
          raw.blockTime,
          status,
          backfilled && raw.blockTime ? raw.blockTime : now,
          status === 'confirmed' ? (backfilled ? raw.blockTime : now) : null,
          backfilled,
          meta,
        ],
      ).lastInsertRowid;
      return { id, isNew: true, changed: true };
    }
    const changed =
      existing.status !== status ||
      existing.block_height !== raw.blockHeight ||
      existing.amount !== raw.amount.toString() ||
      existing.direction !== raw.direction ||
      existing.fee !== (raw.fee === null ? null : raw.fee.toString());
    if (changed) {
      db.run(
        `UPDATE transfers SET direction = ?, amount = ?, fee = ?, charge_fee = ?, counterparty = COALESCE(?, counterparty),
           counterparties = COALESCE(?, counterparties), block_height = ?, block_time = COALESCE(?, block_time), status = ?,
           confirmed_at = CASE WHEN ? = 'confirmed' AND confirmed_at IS NULL THEN ? ELSE confirmed_at END,
           meta = COALESCE(?, meta),
           -- A transaction reported "dropped" that shows up again (e.g. it did confirm): notify again.
           notify_skipped = CASE WHEN status = 'dropped' AND ? != 'dropped' AND backfilled = 0 THEN 0 ELSE notify_skipped END,
           notified_dropped_at = CASE WHEN status = 'dropped' AND ? != 'dropped' THEN NULL ELSE notified_dropped_at END
         WHERE id = ?`,
        [
          raw.direction,
          raw.amount.toString(),
          raw.fee === null ? null : raw.fee.toString(),
          raw.chargeFee,
          raw.counterparty,
          cps,
          raw.blockHeight,
          raw.blockTime,
          status,
          status,
          now,
          meta,
          status,
          status,
          existing.id,
        ],
      );
    }
    return { id: existing.id, isNew: false, changed };
  },

  get(id: number): TransferWithWallet | undefined {
    return getDb().get<TransferWithWallet>(`${T_JOIN} WHERE t.id = ?`, [id]);
  },

  byTxid(txid: string): TransferWithWallet[] {
    return getDb().all<TransferWithWallet>(`${T_JOIN} WHERE t.txid = ? COLLATE NOCASE ORDER BY t.id`, [txid.trim()]);
  },

  setStatus(id: number, status: TransferStatusDb, block?: { height: number | null; time: number | null }): void {
    const now = nowSec();
    getDb().run(
      `UPDATE transfers SET status = ?, block_height = COALESCE(?, block_height), block_time = COALESCE(?, block_time),
         confirmed_at = CASE WHEN ? = 'confirmed' AND confirmed_at IS NULL THEN ? ELSE confirmed_at END WHERE id = ?`,
      [status, block?.height ?? null, block?.time ?? null, status, now, id],
    );
  },

  pendingForWalletNetwork(walletNetworkId: number): TransferRow[] {
    return getDb().all<TransferRow>(`SELECT * FROM transfers WHERE wallet_network_id = ? AND status = 'pending' ORDER BY id`, [
      walletNetworkId,
    ]);
  },

  /** Live (non-backfilled) rows whose notifications are not finished yet. */
  needingNotification(walletNetworkId: number): TransferRow[] {
    return getDb().all<TransferRow>(
      `SELECT * FROM transfers WHERE wallet_network_id = ? AND backfilled = 0 AND notify_skipped = 0
         AND (notified_confirmed_at IS NULL OR (status = 'dropped' AND notified_seen_at IS NOT NULL AND notified_dropped_at IS NULL))
       ORDER BY id`,
      [walletNetworkId],
    );
  },

  markNotified(id: number, kind: 'seen' | 'confirmed' | 'dropped'): void {
    const col = kind === 'seen' ? 'notified_seen_at' : kind === 'confirmed' ? 'notified_confirmed_at' : 'notified_dropped_at';
    getDb().run(`UPDATE transfers SET ${col} = ? WHERE id = ?`, [nowSec(), id]);
  },

  markNotifySkipped(id: number): void {
    getDb().run('UPDATE transfers SET notify_skipped = 1 WHERE id = ?', [id]);
  },

  /** Address-poisoning dust: hidden from lists, never notified. */
  markSpam(id: number): void {
    getDb().run('UPDATE transfers SET spam = 1, notify_skipped = 1 WHERE id = ?', [id]);
  },

  setPrice(id: number, price: number | null, source: string | null, feePrice: number | null): void {
    getDb().run('UPDATE transfers SET price_usd = ?, price_source = ?, fee_price_usd = ? WHERE id = ?', [price, source, feePrice, id]);
  },

  /** Transfers still waiting for a price lookup (excludes ones with no market data at all). */
  unpriced(limit = 500): TransferRow[] {
    return getDb().all<TransferRow>(
      `SELECT * FROM transfers WHERE price_usd IS NULL AND price_override IS NULL AND status != 'dropped'
         AND (price_source IS NULL OR price_source != 'unavailable')
       ORDER BY COALESCE(block_time, first_seen_at) LIMIT ?`,
      [limit],
    );
  },

  markPriceUnavailable(id: number): void {
    getDb().run(`UPDATE transfers SET price_source = 'unavailable' WHERE id = ? AND price_usd IS NULL`, [id]);
  },

  /** Transfers without any price (pending lookups and those with no market data). */
  countUnpriced(): number {
    return (
      getDb().get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transfers WHERE price_usd IS NULL AND price_override IS NULL AND status != 'dropped' AND amount != '0'
           AND (price_source IS NULL OR price_source != 'unavailable')`,
      )?.n ?? 0
    );
  },

  /** A category you set yourself also shows a hidden (spam) transfer again. */
  setCategory(id: number, category: Category): void {
    getDb().run('UPDATE transfers SET category = ?, spam = 0 WHERE id = ?', [category, id]);
  },

  setPriceOverride(id: number, price: number | null): void {
    getDb().run('UPDATE transfers SET price_override = ? WHERE id = ?', [price, id]);
  },

  setNote(id: number, note: string | null): void {
    getDb().run('UPDATE transfers SET note = ? WHERE id = ?', [note, id]);
  },

  /** Every transfer relevant to accounting, oldest first. */
  forLedger(): TransferWithWallet[] {
    return getDb().all<TransferWithWallet>(`${T_JOIN} WHERE t.status != 'dropped' ORDER BY COALESCE(t.block_time, t.first_seen_at), t.id`);
  },

  list(filter: TransferFilter, limit: number, offset: number): TransferWithWallet[] {
    const { where, params } = filterSql(filter);
    return getDb().all<TransferWithWallet>(
      `${T_JOIN} WHERE ${where} AND t.amount != '0'
       ORDER BY COALESCE(t.block_time, t.first_seen_at) DESC, t.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
  },

  count(filter: TransferFilter): number {
    const { where, params } = filterSql(filter);
    return (
      getDb().get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transfers t JOIN wallet_networks wn ON wn.id = t.wallet_network_id
         JOIN wallets w ON w.id = wn.wallet_id WHERE ${where} AND t.amount != '0'`,
        params,
      )?.n ?? 0
    );
  },

  /** All rows matching a filter (used for reports / CSV), oldest first. */
  range(filter: TransferFilter): TransferWithWallet[] {
    const { where, params } = filterSql(filter);
    return getDb().all<TransferWithWallet>(`${T_JOIN} WHERE ${where} ORDER BY COALESCE(t.block_time, t.first_seen_at), t.id`, params);
  },

  countForWalletNetwork(walletNetworkId: number): number {
    return getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM transfers WHERE wallet_network_id = ?', [walletNetworkId])?.n ?? 0;
  },

  total(): number {
    return getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM transfers')?.n ?? 0;
  },
};

/* ================================ Balances ================================ */

export interface BalanceRow {
  wallet_network_id: number;
  asset_key: string;
  amount: string;
  updated_at: number;
}

export const balances = {
  save(walletNetworkId: number, values: Map<string, bigint>): void {
    const db = getDb();
    const t = nowSec();
    db.transaction(() => {
      for (const [key, amount] of values) {
        db.run(
          `INSERT INTO balances (wallet_network_id, asset_key, amount, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(wallet_network_id, asset_key) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at`,
          [walletNetworkId, key, amount.toString(), t],
        );
      }
      db.run('UPDATE wallet_networks SET balances_updated_at = ? WHERE id = ?', [t, walletNetworkId]);
    });
  },
  all(): BalanceRow[] {
    return getDb().all<BalanceRow>('SELECT * FROM balances');
  },
  forWalletNetwork(walletNetworkId: number): BalanceRow[] {
    return getDb().all<BalanceRow>('SELECT * FROM balances WHERE wallet_network_id = ?', [walletNetworkId]);
  },
};

/* ============================== Price cache =============================== */

export const priceCache = {
  get(asset: AssetId, minute: number): { price: number; source: string } | undefined {
    return getDb().get<{ price: number; source: string }>('SELECT price, source FROM price_history WHERE asset = ? AND minute = ?', [
      asset,
      minute,
    ]);
  },
  put(asset: AssetId, minute: number, price: number, source: string): void {
    getDb().run('INSERT OR REPLACE INTO price_history (asset, minute, price, source) VALUES (?, ?, ?, ?)', [asset, minute, price, source]);
  },
};

export const assetMeta = {
  all(): Array<{ asset: AssetId; image_url: string | null }> {
    return getDb().all('SELECT asset, image_url FROM asset_meta');
  },
  put(asset: AssetId, imageUrl: string | null): void {
    getDb().run('INSERT OR REPLACE INTO asset_meta (asset, image_url, updated_at) VALUES (?, ?, ?)', [asset, imageUrl, nowSec()]);
  },
};

/* ================================= Alerts ================================= */

export interface AlertRow {
  id: number;
  asset: AssetId;
  condition: 'above' | 'below';
  target: number;
  repeat: number;
  active: number;
  last_state: 'above' | 'below' | null;
  note: string | null;
  created_at: number;
  triggered_at: number | null;
  trigger_count: number;
}

export const alerts = {
  create(a: {
    asset: AssetId;
    condition: 'above' | 'below';
    target: number;
    repeat: boolean;
    lastState: 'above' | 'below' | null;
    note: string | null;
  }): number {
    return getDb().run(
      'INSERT INTO price_alerts (asset, condition, target, repeat, last_state, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [a.asset, a.condition, a.target, a.repeat, a.lastState, a.note, nowSec()],
    ).lastInsertRowid;
  },
  list(includeInactive = false): AlertRow[] {
    return getDb().all<AlertRow>(`SELECT * FROM price_alerts ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY asset, target`);
  },
  get(id: number): AlertRow | undefined {
    return getDb().get<AlertRow>('SELECT * FROM price_alerts WHERE id = ?', [id]);
  },
  remove(id: number): boolean {
    return getDb().run('DELETE FROM price_alerts WHERE id = ?', [id]).changes > 0;
  },
  setState(id: number, state: 'above' | 'below'): void {
    getDb().run('UPDATE price_alerts SET last_state = ? WHERE id = ?', [state, id]);
  },
  triggered(id: number, state: 'above' | 'below', deactivate: boolean): void {
    getDb().run(
      'UPDATE price_alerts SET last_state = ?, triggered_at = ?, trigger_count = trigger_count + 1, active = CASE WHEN ? THEN 0 ELSE active END WHERE id = ?',
      [state, nowSec(), deactivate, id],
    );
  },
};

/* ============================ Daily runs / snapshots ====================== */

export const dailyRuns = {
  has(kind: string, day: string): boolean {
    return !!getDb().get('SELECT 1 FROM daily_runs WHERE kind = ? AND day = ?', [kind, day]);
  },
  mark(kind: string, day: string): void {
    getDb().run('INSERT OR IGNORE INTO daily_runs (kind, day, ran_at) VALUES (?, ?, ?)', [kind, day, nowSec()]);
  },
};

export interface SnapshotRow {
  day: string;
  total_value: number;
  cost_basis: number | null;
  realized: number | null;
  created_at: number;
}

export const snapshots = {
  put(day: string, totalValue: number, costBasis: number | null, realized: number | null): void {
    getDb().run('INSERT OR REPLACE INTO portfolio_snapshots (day, total_value, cost_basis, realized, created_at) VALUES (?, ?, ?, ?, ?)', [
      day,
      totalValue,
      costBasis,
      realized,
      nowSec(),
    ]);
  },
  before(day: string): SnapshotRow | undefined {
    return getDb().get<SnapshotRow>('SELECT * FROM portfolio_snapshots WHERE day < ? ORDER BY day DESC LIMIT 1', [day]);
  },
  recent(limit: number): SnapshotRow[] {
    return getDb().all<SnapshotRow>('SELECT * FROM portfolio_snapshots ORDER BY day DESC LIMIT ?', [limit]);
  },
};
