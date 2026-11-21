import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { createLogger } from '../logger.ts';
import { MIGRATIONS } from './schema.ts';

const log = createLogger('db');

export type Params = Record<string, unknown> | unknown[] | undefined;

function toSql(v: unknown): SQLInputValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v);
}

/** Thin, synchronous wrapper around node:sqlite with statement caching and safe parameter handling. */
export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(path: string) {
    if (path !== ':memory:') {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') {
        // The database and its -wal/-shm side files hold your addresses and history: owner-only.
        process.umask(0o077);
        try {
          chmodSync(dir, 0o700);
        } catch {
          /* best effort (e.g. directory owned by another user) */
        }
      }
    }
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:' && process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best effort */
      }
    }
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.raw.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    let current = row?.version ?? 0;
    if (!row) this.raw.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(m.sql);
        this.raw.prepare('UPDATE schema_version SET version = ?').run(m.version);
        this.raw.exec('COMMIT');
        current = m.version;
        log.info(`applied migration ${m.version}: ${m.name}`);
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private bind(params: Params): { named?: Record<string, SQLInputValue>; positional: SQLInputValue[] } {
    if (params === undefined) return { positional: [] };
    if (Array.isArray(params)) return { positional: params.map(toSql) };
    const named: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(params)) named[k] = toSql(v);
    return { named, positional: [] };
  }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
    const { named, positional } = this.bind(params);
    const r = named ? this.stmt(sql).run(named) : this.stmt(sql).run(...positional);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T>(sql: string, params?: Params): T | undefined {
    const { named, positional } = this.bind(params);
    return (named ? this.stmt(sql).get(named) : this.stmt(sql).get(...positional)) as T | undefined;
  }

  all<T>(sql: string, params?: Params): T[] {
    const { named, positional } = this.bind(params);
    return (named ? this.stmt(sql).all(named) : this.stmt(sql).all(...positional)) as T[];
  }

  /** Runs fn inside a transaction (nested calls join the outer transaction). */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth++;
      try {
        return fn();
      } finally {
        this.txDepth--;
      }
    }
    this.raw.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  close(): void {
    this.cache.clear();
    try {
      this.raw.exec('PRAGMA optimize;');
    } catch {
      /* ignore */
    }
    this.raw.close();
  }
}

let instance: Db | null = null;

export function openDb(path: string): Db {
  instance?.close();
  instance = new Db(path);
  return instance;
}

export function getDb(): Db {
  if (!instance) throw new Error('Database not opened');
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}
