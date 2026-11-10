import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeConfig, type Config } from './config';
import { chooseRegistry, openDb, type Db, type RegistryChoice } from './db';
import { backfillInterest, type InterestBackfill } from './interest/tag';
import { loadOutbound, type OutboundLoad } from './outbound/load';
import { loadUsage, type UsageLoad } from './usage/load';
import type { CrmMirrorEntry, Owners } from './schema';
import type { CommitQueue } from './pipeline';
import { storeFor, type Store } from './store';

export type FetchFn = typeof fetch;

/** Calls answered by the hosted model and their token counts, as the API reported them. */
export interface ModelUsage { calls: number; inputTokens: number; outputTokens: number }

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
  /** pipeline queue state, owned by pipeline.ts: the leads waiting for their commit, in acceptance order, with their lanes and prepared work */
  q: CommitQueue;
  /** how the rate file was loaded at startup (src/outbound/load.ts); the outbound API explains an empty state from it */
  outbound: OutboundLoad;
  /** how the synthetic usage fixtures were loaded at startup (src/usage/load.ts); the attribution API explains an empty state from it */
  usage: UsageLoad;
  /** hosted model calls made through this context and the tokens they used, for the eval record and the replay's cost line */
  modelUsage: ModelUsage;
  /** the start-up pass that tagged leads committed before feature interest existed (src/interest/tag.ts) */
  interest: InterestBackfill;
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
    q: { waiting: [], committing: false, pending: 0, head: null, idle: [] },
    outbound: { status: 'missing', path: cfg.ratesCsv, message: 'not loaded yet', rows: 0, groups: 0, ms: 0 },
    usage: { status: 'off', message: 'not loaded yet', features: 0, deals: 0, events: 0, ms: 0 },
    modelUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    interest: { checked: 0, tagged: 0, ms: 0 },
  };
  ctx.outbound = loadOutbound(ctx);
  ctx.usage = loadUsage(ctx);
  ctx.interest = backfillInterest(ctx);
  return ctx;
}

let shared: Ctx | null = null;
/** Process-wide context used by the HTTP handlers. Tests install their own with setCtx. */
export function getCtx(): Ctx {
  if (!shared) shared = createCtx();
  return shared;
}
export function setCtx(c: Ctx | null) { shared = c; }
