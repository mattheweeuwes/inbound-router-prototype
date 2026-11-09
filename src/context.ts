import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig, type Config } from './config';
import { chooseRegistry, openDb, type Db, type RegistryChoice } from './db';
import type { CrmMirrorEntry, Owners } from './schema';

export type FetchFn = typeof fetch;

export interface Ctx {
  cfg: Config;
  db: Db;
  registry: RegistryChoice;
  fetch: FetchFn;
  bus: EventEmitter;
  owners: Owners;
  mirror: CrmMirrorEntry[];
  /** pipeline queue state, owned by pipeline.ts */
  q: { chain: Promise<unknown>; pending: number; };
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

export function createCtx(over: Partial<Config> = {}, fetchImpl?: FetchFn): Ctx {
  const cfg = makeConfig(over);
  const registry = chooseRegistry(cfg);
  const db = openDb(cfg, registry);
  return {
    cfg,
    db,
    registry,
    fetch: fetchImpl ?? globalThis.fetch,
    bus: new EventEmitter(),
    owners: readJson<Owners>(join(cfg.fixturesDir, 'owners.json')),
    mirror: existsSync(join(cfg.fixturesDir, 'crm-mirror.json')) ? readJson<CrmMirrorEntry[]>(join(cfg.fixturesDir, 'crm-mirror.json')) : [],
    q: { chain: Promise.resolve(), pending: 0 },
  };
}

let shared: Ctx | null = null;
/** Process-wide context used by the HTTP handlers. Tests install their own with setCtx. */
export function getCtx(): Ctx {
  if (!shared) shared = createCtx();
  return shared;
}
export function setCtx(c: Ctx | null) { shared = c; }
