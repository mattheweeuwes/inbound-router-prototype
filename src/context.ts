import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig, type Config } from './config';
import { chooseRegistry, openDb, type Db, type RegistryChoice } from './db';
import { loadOutbound, type OutboundLoad } from './outbound/load';
import type { CrmMirrorEntry, Owners } from './schema';
import type { PrepareOutcome } from './stages';
import { storeFor, type Store } from './store';

export type FetchFn = typeof fetch;

export interface Ctx {
  cfg: Config;
  db: Db;
  /** every statement the pipeline and the HubSpot outbox run, prepared once for db */
  store: Store;
  registry: RegistryChoice;
  fetch: FetchFn;
  bus: EventEmitter;
  owners: Owners;
  mirror: CrmMirrorEntry[];
  /** pipeline queue state, owned by pipeline.ts: the ordered section's chain, leads in it, and each lead's prepared work by id */
  q: { chain: Promise<unknown>; pending: number; prepared: Map<string, Promise<PrepareOutcome>> };
  /** how the rate file was loaded at startup (src/outbound/load.ts); the outbound API explains an empty state from it */
  outbound: OutboundLoad;
}

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

export function createCtx(over: Partial<Config> = {}, fetchImpl?: FetchFn): Ctx {
  const cfg = makeConfig(over);
  const registry = chooseRegistry(cfg);
  const db = openDb(cfg, registry);
  const ctx: Ctx = {
    cfg,
    db,
    store: storeFor(db),
    registry,
    fetch: fetchImpl ?? globalThis.fetch,
    bus: new EventEmitter(),
    owners: readJson<Owners>(join(cfg.fixturesDir, 'owners.json')),
    mirror: existsSync(join(cfg.fixturesDir, 'crm-mirror.json')) ? readJson<CrmMirrorEntry[]>(join(cfg.fixturesDir, 'crm-mirror.json')) : [],
    q: { chain: Promise.resolve(), pending: 0, prepared: new Map() },
    outbound: { status: 'missing', path: cfg.ratesCsv, message: 'not loaded yet', rows: 0, groups: 0, ms: 0 },
  };
  ctx.outbound = loadOutbound(ctx);
  return ctx;
}

let shared: Ctx | null = null;
/** Process-wide context used by the HTTP handlers. Tests install their own with setCtx. */
export function getCtx(): Ctx {
  if (!shared) shared = createCtx();
  return shared;
}
export function setCtx(c: Ctx | null) { shared = c; }
