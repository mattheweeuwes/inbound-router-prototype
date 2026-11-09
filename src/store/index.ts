// The typed data layer. Every statement the pipeline and the HubSpot outbox run lives behind a named function in this
// folder, one file per concern, prepared once per database and reused. Read models for the API (view.ts, dashboard.ts,
// quality.ts) keep their own SQL next to the shapes they build.
import type { Db } from '../db';
import { accountStore, type AccountStore } from './accounts';
import { leadStore, type LeadStore } from './leads';
import { outboxStore, type OutboxStore } from './outbox';
import { stageLogStore, type StageLogStore } from './stageLog';

export interface Store { leads: LeadStore; accounts: AccountStore; stages: StageLogStore; outbox: OutboxStore }

const stores = new WeakMap<Db, Store>();

/** The store for a database, built on first use. The database must be migrated first (openDb does that). */
export function storeFor(db: Db): Store {
  let s = stores.get(db);
  if (!s) {
    s = { leads: leadStore(db), accounts: accountStore(db), stages: stageLogStore(db), outbox: outboxStore(db) };
    stores.set(db, s);
  }
  return s;
}
