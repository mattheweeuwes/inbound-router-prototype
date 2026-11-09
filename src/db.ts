import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config';

export type Db = DatabaseSync;

export interface RegistryChoice { path: string; kind: 'real' | 'mini'; status: string | null }

/** Real registry only when its meta.status is 'complete'. Otherwise rebuild and use the hand-made mini registry. */
export function chooseRegistry(cfg: Config): RegistryChoice {
  if (existsSync(cfg.registryDb)) {
    try {
      const r = new DatabaseSync(cfg.registryDb, { readOnly: true });
      try {
        const row = r.prepare(`SELECT value FROM meta WHERE key='status'`).get() as { value?: string } | undefined;
        if (row?.value === 'complete') return { path: cfg.registryDb, kind: 'real', status: 'complete' };
      } finally { r.close(); }
    } catch { /* partial or being written: fall through to mini */ }
  }
  mkdirSync(cfg.cacheDir, { recursive: true });
  const miniPath = join(cfg.cacheDir, 'registry-mini.sqlite');
  rmSync(miniPath, { force: true });
  const m = new DatabaseSync(miniPath);
  m.exec(readFileSync(cfg.registryMiniSql, 'utf8'));
  m.close();
  return { path: miniPath, kind: 'mini', status: null };
}

/** Runs fn inside one transaction: everything it writes lands together or not at all. Not re-entrant. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Applies each file in sql/migrations once, in name order, and records it in schema_migrations, each file in its own
 * transaction so a failed migration leaves nothing half-applied. A later file can therefore ALTER a table safely.
 * A database created before this runner existed has 001 applied but not recorded; 001 is all CREATE ... IF NOT EXISTS,
 * so it runs again as a no-op, is recorded, and 002 onward migrate the old rows.
 */
export function migrate(db: Db, dir: string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const done = new Set((db.prepare(`SELECT name FROM schema_migrations`).all() as { name: string }[]).map(r => r.name));
  const record = db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`);
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    tx(db, () => {
      db.exec(readFileSync(join(dir, file), 'utf8'));
      record.run(file, new Date().toISOString());
    });
    applied.push(file);
  }
  return applied;
}

export function openDb(cfg: Config, registry: RegistryChoice): Db {
  if (cfg.appDb !== ':memory:') mkdirSync(dirname(cfg.appDb), { recursive: true });
  const db = new DatabaseSync(cfg.appDb);
  if (cfg.appDb !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db, join(cfg.root, 'sql', 'migrations'));
  db.exec(`ATTACH DATABASE 'file:${registry.path}?mode=ro' AS reg`);
  // views are cheap and are redefined on every boot so the SQL files stay the source of truth
  const modelDir = join(cfg.root, 'sql', 'models');
  if (existsSync(modelDir)) for (const f of readdirSync(modelDir).filter(x => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(modelDir, f), 'utf8'));
  return db;
}

/** Every table the router writes, children first. schema_migrations is not app data and stays. */
const APP_TABLES = ['crm_outbox', 'account_claims', 'assignments', 'stage_log', 'review_queue', 'account_signals', 'accounts', 'leads', 'lead_events'];

export function clearAppData(db: Db) {
  for (const t of APP_TABLES) db.exec(`DELETE FROM ${t}`);
}

export const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
export const parse = <T = unknown>(s: unknown): T | null => (typeof s === 'string' ? (JSON.parse(s) as T) : null);

/**
 * The one place a database row gets its TypeScript type. node:sqlite returns plain records of SQL values; the row
 * types in src/store name the columns each statement selects.
 */
export const getRow = <T>(stmt: StatementSync, ...params: SQLInputValue[]): T | undefined => stmt.get(...params) as T | undefined;
export const allRows = <T>(stmt: StatementSync, ...params: SQLInputValue[]): T[] => stmt.all(...params) as T[];
