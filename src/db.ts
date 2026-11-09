import { DatabaseSync } from 'node:sqlite';
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

export function openDb(cfg: Config, registry: RegistryChoice): Db {
  if (cfg.appDb !== ':memory:') mkdirSync(dirname(cfg.appDb), { recursive: true });
  const db = new DatabaseSync(cfg.appDb);
  if (cfg.appDb !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  const migDir = join(cfg.root, 'sql', 'migrations');
  for (const f of readdirSync(migDir).filter(x => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(migDir, f), 'utf8'));
  db.exec(`ATTACH DATABASE 'file:${registry.path}?mode=ro' AS reg`);
  // views are cheap and are redefined on every boot so the SQL files stay the source of truth
  const modelDir = join(cfg.root, 'sql', 'models');
  if (existsSync(modelDir)) for (const f of readdirSync(modelDir).filter(x => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(modelDir, f), 'utf8'));
  return db;
}

export function clearAppData(db: Db) {
  for (const t of ['assignments', 'stage_log', 'review_queue', 'account_signals', 'accounts', 'leads', 'lead_events']) db.exec(`DELETE FROM ${t}`);
}

export const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
export const parse = <T = unknown>(s: unknown): T | null => (typeof s === 'string' ? (JSON.parse(s) as T) : null);
