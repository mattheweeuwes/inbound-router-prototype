// SQL for product usage and deals: the PostHog events, the deals standing in for HubSpot's, the feature reference data, and
// reads of the views in sql/models (v_usage_*). The ingest, the fixture loader and the attribution read model use these; none
// of them writes SQL of its own.
import type { StatementSync } from 'node:sqlite';
import { allRows, getRow, type Db } from '../db';
import type { AdaptedEvent } from '../usage/posthog';

export type DealOutcome = 'won' | 'lost';
export type UsageSource = 'api' | 'fixture';

export interface FeatureRef { feature: string; label: string; launchedAt: string; team: string; previewOfAddOn: string | null }
export interface AddOnRef { id: string; label: string; priceLow: number; priceHigh: number }

/** A deal as stored. closedAt and outcome are both null while it is open. */
export interface Deal {
  id: string; accountKey: string; stage: string; amount: number; createdAt: string; closedAt: string | null;
  outcome: DealOutcome | null; addOn: string | null; synthetic: boolean;
}

type FeatureRow = { feature: string; label: string; launched_at: string; team: string; preview_of_add_on: string | null };
type AddOnRow = { id: string; label: string; price_low: number; price_high: number };
type DealRow = {
  id: string; account_key: string; stage: string; amount: number; created_at: string; closed_at: string | null;
  outcome: DealOutcome | null; add_on: string | null; synthetic: number;
};

/** One row of v_usage_feature_influence. */
export type FeatureInfluenceRow = {
  feature: string; label: string; launched_at: string; team: string; accounts_using: number; events: number;
  active_since_launch: number; using_since_launch: number;
  won_count: number; won_amount: number; lost_count: number; lost_amount: number; open_count: number; open_amount: number;
  used_after_open: number; median_days: number | null; median_n: number; closed_all: number; won_all: number;
};

/** One row of v_usage_deal_influence joined to its deal. */
export type InfluencedDealRow = {
  feature: string; deal_id: string; account_key: string; stage: string; outcome: DealOutcome | null; amount: number; add_on: string | null;
  created_at: string; closed_at: string | null; uses: number; first_use_in_window: string; last_use_in_window: string;
};

/** One row of v_usage_expansion: the facts behind an expansion signal. */
export type ExpansionRow = {
  account_key: string; add_on: string; feature: string; uses_30d: number; contacts_30d: number; first_use_30d: string; last_use_30d: string;
  is_customer: number; add_on_deals: number;
};

/** One row of v_usage_by_account_feature. */
export type AccountFeatureRow = { account_key: string; feature: string; events: number; first_use_at: string; last_use_at: string; events_30d: number };

export type EventTotals = { total: number; mapped: number; unmapped: number; unresolved: number; synthetic: number };
export type DealTotals = {
  total: number; open_count: number; won_count: number; lost_count: number; open_amount: number; won_amount: number; lost_amount: number;
  synthetic: number; influenced: number; influenced_amount: number;
};

const toFeature = (r: FeatureRow): FeatureRef => ({ feature: r.feature, label: r.label, launchedAt: r.launched_at, team: r.team, previewOfAddOn: r.preview_of_add_on });
const toAddOn = (r: AddOnRow): AddOnRef => ({ id: r.id, label: r.label, priceLow: r.price_low, priceHigh: r.price_high });
const toDeal = (r: DealRow): Deal => ({
  id: r.id, accountKey: r.account_key, stage: r.stage, amount: r.amount, createdAt: r.created_at, closedAt: r.closed_at,
  outcome: r.outcome, addOn: r.add_on, synthetic: !!r.synthetic,
});

export function usageStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    insertEvent: p(`INSERT INTO usage_events (event_id, account_key, group_key, contact_key, feature, event_name, occurred_at, received_at, synthetic, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`),
    insertFeature: p(`INSERT INTO features (feature, label, launched_at, team, preview_of_add_on) VALUES (?, ?, ?, ?, ?)`),
    insertAddOn: p(`INSERT INTO add_ons (id, label, price_low, price_high) VALUES (?, ?, ?, ?)`),
    insertDeal: p(`INSERT INTO deals (id, account_key, stage, amount, created_at, closed_at, outcome, add_on, synthetic, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET account_key = excluded.account_key, stage = excluded.stage, amount = excluded.amount, created_at = excluded.created_at,
        closed_at = excluded.closed_at, outcome = excluded.outcome, add_on = excluded.add_on, synthetic = excluded.synthetic, source = excluded.source`),
    clearFeatures: p(`DELETE FROM features`),
    clearAddOns: p(`DELETE FROM add_ons`),
    clearFixtureEvents: p(`DELETE FROM usage_events WHERE source = 'fixture'`),
    clearFixtureDeals: p(`DELETE FROM deals WHERE source = 'fixture'`),
    clearFixtureSha: p(`DELETE FROM usage_fixture`),
    fixtureSha: p(`SELECT sha256 FROM usage_fixture WHERE id = 1`),
    saveFixtureSha: p(`INSERT INTO usage_fixture (id, sha256, loaded_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET sha256 = excluded.sha256, loaded_at = excluded.loaded_at`),
    features: p(`SELECT feature, label, launched_at, team, preview_of_add_on FROM features ORDER BY launched_at, feature`),
    addOns: p(`SELECT id, label, price_low, price_high FROM add_ons ORDER BY id`),
    asOf: p(`SELECT t FROM v_usage_asof`),
    featureInfluence: p(`SELECT * FROM v_usage_feature_influence`),
    influencedDeals: p(`SELECT i.feature, i.deal_id, i.account_key, d.stage, d.outcome, d.amount, d.add_on, d.created_at, d.closed_at, i.uses,
      i.first_use_in_window, i.last_use_in_window FROM v_usage_deal_influence i JOIN deals d ON d.id = i.deal_id ORDER BY i.feature, d.created_at, d.id`),
    expansion: p(`SELECT account_key, add_on, feature, uses_30d, contacts_30d, first_use_30d, last_use_30d, is_customer, add_on_deals FROM v_usage_expansion
      ORDER BY uses_30d DESC, account_key`),
    byAccountFeature: p(`SELECT account_key, feature, events, first_use_at, last_use_at, events_30d FROM v_usage_by_account_feature ORDER BY account_key, feature`),
    eventTotals: p(`SELECT COUNT(*) AS total, COALESCE(SUM(feature IS NOT NULL), 0) AS mapped, COALESCE(SUM(feature IS NULL), 0) AS unmapped,
      COALESCE(SUM(account_key IS NULL), 0) AS unresolved, COALESCE(SUM(synthetic), 0) AS synthetic FROM usage_events`),
    unmappedByName: p(`SELECT event_name AS event, COUNT(*) AS n FROM usage_events WHERE feature IS NULL GROUP BY event_name ORDER BY n DESC, event_name`),
    dealTotals: p(`SELECT COUNT(*) AS total,
      COALESCE(SUM(outcome IS NULL), 0) AS open_count, COALESCE(SUM(outcome = 'won'), 0) AS won_count, COALESCE(SUM(outcome = 'lost'), 0) AS lost_count,
      COALESCE(SUM(CASE WHEN outcome IS NULL THEN amount END), 0) AS open_amount, COALESCE(SUM(CASE WHEN outcome = 'won' THEN amount END), 0) AS won_amount,
      COALESCE(SUM(CASE WHEN outcome = 'lost' THEN amount END), 0) AS lost_amount, COALESCE(SUM(synthetic), 0) AS synthetic,
      COALESCE(SUM(id IN (SELECT deal_id FROM v_usage_deal_influence)), 0) AS influenced,
      COALESCE(SUM(CASE WHEN id IN (SELECT deal_id FROM v_usage_deal_influence) THEN amount END), 0) AS influenced_amount FROM deals`),
    deals: p(`SELECT id, account_key, stage, amount, created_at, closed_at, outcome, add_on, synthetic FROM deals ORDER BY created_at, id`),
    accountsInData: p(`SELECT COUNT(*) AS n FROM (SELECT account_key FROM usage_events WHERE account_key IS NOT NULL UNION SELECT account_key FROM deals)`),
  };

  return {
    /** Stores an event unless its uuid is already there. Returns whether a row was written. */
    insertEvent: (e: AdaptedEvent, accountKey: string | null, receivedAt: string, source: UsageSource): boolean =>
      Number(s.insertEvent.run(e.eventId, accountKey, e.groupKey, e.contactKey, e.feature, e.eventName, e.occurredAt, receivedAt, e.synthetic ? 1 : 0, source).changes) > 0,
    /** Writes a deal, or brings the stored one up to date: HubSpot is the source of a deal, so the latest copy wins. */
    saveDeal: (d: Deal, source: UsageSource) => {
      s.insertDeal.run(d.id, d.accountKey, d.stage, d.amount, d.createdAt, d.closedAt, d.outcome, d.addOn, d.synthetic ? 1 : 0, source);
    },
    /** Replaces the reference data (features and add-ons) whole. */
    replaceReference: (features: FeatureRef[], addOns: AddOnRef[]) => {
      s.clearFeatures.run();
      s.clearAddOns.run();
      for (const f of features) s.insertFeature.run(f.feature, f.label, f.launchedAt, f.team, f.previewOfAddOn);
      for (const a of addOns) s.insertAddOn.run(a.id, a.label, a.priceLow, a.priceHigh);
    },
    /** Removes everything the fixture files put in, and the record of their hash. Rows from POST /api/usage stay. */
    clearFixture: () => {
      s.clearFixtureEvents.run();
      s.clearFixtureDeals.run();
      s.clearFeatures.run();
      s.clearAddOns.run();
      s.clearFixtureSha.run();
    },
    fixtureSha: (): string | null => getRow<{ sha256: string }>(s.fixtureSha)?.sha256 ?? null,
    saveFixtureSha: (sha256: string, at: string) => { s.saveFixtureSha.run(sha256, at); },
    features: (): FeatureRef[] => allRows<FeatureRow>(s.features).map(toFeature),
    addOns: (): AddOnRef[] => allRows<AddOnRow>(s.addOns).map(toAddOn),
    asOf: (): string => getRow<{ t: string }>(s.asOf)?.t ?? '',
    featureInfluence: (): FeatureInfluenceRow[] => allRows<FeatureInfluenceRow>(s.featureInfluence),
    influencedDeals: (): InfluencedDealRow[] => allRows<InfluencedDealRow>(s.influencedDeals),
    expansion: (): ExpansionRow[] => allRows<ExpansionRow>(s.expansion),
    byAccountFeature: (): AccountFeatureRow[] => allRows<AccountFeatureRow>(s.byAccountFeature),
    eventTotals: (): EventTotals => getRow<EventTotals>(s.eventTotals) as EventTotals,
    unmappedByName: (): { event: string; n: number }[] => allRows<{ event: string; n: number }>(s.unmappedByName).map(r => ({ event: r.event, n: r.n })),
    dealTotals: (): DealTotals => getRow<DealTotals>(s.dealTotals) as DealTotals,
    deals: (): Deal[] => allRows<DealRow>(s.deals).map(toDeal),
    accountsInData: (): number => Number(getRow<{ n: number }>(s.accountsInData)?.n ?? 0),
  };
}

export type UsageStore = ReturnType<typeof usageStore>;
