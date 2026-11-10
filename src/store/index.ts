// The typed data layer. Every statement the pipeline, the HubSpot outbox, the list digests, the outbound module, the usage module, the accounts API and Needs a person run lives behind a named
// function in this folder, one file per concern, prepared once per database and reused. Read models for the API (view.ts, dashboard.ts,
// quality.ts) keep their own SQL next to the shapes they build.
import type { Db } from '../db';
import { accountStore, type AccountStore } from './accounts';
import { accountViewStore, type AccountViewStore } from './accountViews';
import { interestStore, type InterestStore } from './interest';
import { leadStore, type LeadStore } from './leads';
import { listStore, type ListStore } from './lists';
import { outboundStore, type OutboundStore } from './outbound';
import { outboxStore, type OutboxStore } from './outbox';
import { reviewStore, type ReviewStore } from './review';
import { stageLogStore, type StageLogStore } from './stageLog';
import { todayStore, type TodayStore } from './today';
import { usageStore, type UsageStore } from './usage';

export interface Store {
  leads: LeadStore; accounts: AccountStore; stages: StageLogStore; outbox: OutboxStore; outbound: OutboundStore; usage: UsageStore; lists: ListStore; interest: InterestStore;
  /** reads for the team brief (src/todayBrief.ts) */
  today: TodayStore;
  /** reads for the accounts API, over the views in sql/models/v_accounts.sql */
  accountViews: AccountViewStore;
  /** Needs a person: open items, decided ones and the decision write (decision 33) */
  review: ReviewStore;
}

const stores = new WeakMap<Db, Store>();

/** The store for a database, built on first use. The database must be migrated first (openDb does that). */
export function storeFor(db: Db): Store {
  let s = stores.get(db);
  if (!s) {
    s = { leads: leadStore(db), accounts: accountStore(db), stages: stageLogStore(db), outbox: outboxStore(db), outbound: outboundStore(db), usage: usageStore(db), lists: listStore(db), interest: interestStore(db), today: todayStore(db), accountViews: accountViewStore(db), review: reviewStore(db) };
    stores.set(db, s);
  }
  return s;
}
