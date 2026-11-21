export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE wallets (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        label             TEXT NOT NULL COLLATE NOCASE UNIQUE,
        address           TEXT NOT NULL,
        family            TEXT NOT NULL,
        notify_enabled    INTEGER NOT NULL DEFAULT 1,
        notify_channel_id TEXT,
        created_at        INTEGER NOT NULL
      );

      CREATE TABLE wallet_networks (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_id            INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
        network              TEXT NOT NULL,
        cursor               TEXT,
        boundary             TEXT,
        tracking_since       INTEGER NOT NULL,
        backfill_status      TEXT NOT NULL DEFAULT 'pending',
        backfill_progress    TEXT,
        backfill_error       TEXT,
        backfill_started_at  INTEGER,
        backfill_finished_at INTEGER,
        last_poll_at         INTEGER,
        last_poll_ok_at      INTEGER,
        last_error           TEXT,
        consecutive_errors   INTEGER NOT NULL DEFAULT 0,
        balances_updated_at  INTEGER,
        UNIQUE (wallet_id, network)
      );

      CREATE TABLE transfers (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_network_id     INTEGER NOT NULL REFERENCES wallet_networks(id) ON DELETE CASCADE,
        network               TEXT NOT NULL,
        asset_key             TEXT NOT NULL,
        asset                 TEXT NOT NULL,
        txid                  TEXT NOT NULL,
        sub_id                TEXT NOT NULL,
        direction             TEXT NOT NULL CHECK (direction IN ('in', 'out', 'self')),
        amount                TEXT NOT NULL,
        decimals              INTEGER NOT NULL,
        fee                   TEXT,
        charge_fee            INTEGER NOT NULL DEFAULT 0,
        counterparty          TEXT,
        counterparties        TEXT,
        block_height          INTEGER,
        block_time            INTEGER,
        status                TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed', 'dropped')),
        first_seen_at         INTEGER NOT NULL,
        confirmed_at          INTEGER,
        backfilled            INTEGER NOT NULL DEFAULT 0,
        price_usd             REAL,
        price_source          TEXT,
        fee_price_usd         REAL,
        category              TEXT NOT NULL DEFAULT 'auto',
        price_override        REAL,
        note                  TEXT,
        meta                  TEXT,
        notify_skipped        INTEGER NOT NULL DEFAULT 0,
        notified_seen_at      INTEGER,
        notified_confirmed_at INTEGER,
        notified_dropped_at   INTEGER,
        UNIQUE (wallet_network_id, txid, sub_id)
      );
      CREATE INDEX idx_transfers_time   ON transfers (asset, block_time);
      CREATE INDEX idx_transfers_status ON transfers (status);
      CREATE INDEX idx_transfers_txid   ON transfers (txid);
      CREATE INDEX idx_transfers_seen   ON transfers (first_seen_at);

      CREATE TABLE balances (
        wallet_network_id INTEGER NOT NULL REFERENCES wallet_networks(id) ON DELETE CASCADE,
        asset_key         TEXT NOT NULL,
        amount            TEXT NOT NULL,
        updated_at        INTEGER NOT NULL,
        PRIMARY KEY (wallet_network_id, asset_key)
      );

      CREATE TABLE price_history (
        asset  TEXT NOT NULL,
        minute INTEGER NOT NULL,
        price  REAL NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (asset, minute)
      );

      CREATE TABLE asset_meta (
        asset      TEXT PRIMARY KEY,
        image_url  TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE price_alerts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        asset        TEXT NOT NULL,
        condition    TEXT NOT NULL CHECK (condition IN ('above', 'below')),
        target       REAL NOT NULL,
        repeat       INTEGER NOT NULL DEFAULT 0,
        active       INTEGER NOT NULL DEFAULT 1,
        last_state   TEXT,
        note         TEXT,
        created_at   INTEGER NOT NULL,
        triggered_at INTEGER,
        trigger_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE daily_runs (
        kind    TEXT NOT NULL,
        day     TEXT NOT NULL,
        ran_at  INTEGER NOT NULL,
        PRIMARY KEY (kind, day)
      );

      CREATE TABLE portfolio_snapshots (
        day          TEXT PRIMARY KEY,
        total_value  REAL NOT NULL,
        cost_basis   REAL,
        realized     REAL,
        created_at   INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'remember what wallets.txt last applied',
    sql: `
      -- Name and network list last taken from wallets.txt. The file only renames a wallet or adds
      -- networks when its line changed, so /wallet rename and /wallet networks are not undone.
      ALTER TABLE wallets ADD COLUMN file_label TEXT;
      ALTER TABLE wallets ADD COLUMN file_networks TEXT;
    `,
  },
  {
    version: 3,
    name: 'hide address-poisoning dust',
    sql: `
      -- 1 = dust from a look-alike address (address poisoning). Hidden from lists and notifications
      -- but still counted: it is real, if worthless, balance.
      ALTER TABLE transfers ADD COLUMN spam INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
