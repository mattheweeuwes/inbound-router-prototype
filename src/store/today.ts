// SQL for the team brief (src/todayBrief.ts): the reads that carry the ids a reader opens an item with, and that the dashboard's
// aggregates do not give. Read-only; the brief decides nothing and writes nothing.
import type { StatementSync } from 'node:sqlite';
import { allRows, type Db } from '../db';
import type { Source } from '../schema';

/** A person or account-level visit at an enterprise account, with where the router sent it. */
export type EnterpriseLeadRow = {
  lead_id: string; account_id: string | null; account_name: string | null; enterprise_fact: string | null; first_name: string | null; last_name: string | null;
  title: string | null; source: Source; tier: string | null; route_action: string | null; route_team: string | null; owner: string | null; rule: string | null;
  received_at: string;
};

/** A lead that named a referrer. */
export type ReferralLeadRow = {
  lead_id: string; account_id: string | null; account_name: string | null; first_name: string | null; last_name: string | null; email: string | null;
  company_name_raw: string | null; tier: string | null; referral_json: string; received_at: string;
};

/** A lead whose run failed or is waiting for a retry, or whose HubSpot plan has not been delivered. */
export type TroubledLeadRow = { lead_id: string; source: Source; status: string; attempts: number; delivery: string | null; received_at: string };

/** One digest recorded for a list. */
export type DigestRow = { list_name: string; team: string; channel: string; rows: number; at: string };

export function todayStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    enterprise: p(`SELECT l.id AS lead_id, l.account_id, a.name AS account_name, a.enterprise_fact, l.first_name, l.last_name, l.title, e.source, l.tier,
        l.route_action, l.route_team, l.owner, json_extract(l.route_json, '$.rule') AS rule, e.received_at
      FROM leads l JOIN lead_events e ON e.id = l.id LEFT JOIN accounts a ON a.id = l.account_id
      WHERE l.enterprise = 1 AND e.received_at >= ? ORDER BY e.received_at DESC, l.id`),
    referrals: p(`SELECT l.id AS lead_id, l.account_id, a.name AS account_name, l.first_name, l.last_name, l.email, l.company_name_raw, l.tier, l.referral_json, e.received_at
      FROM leads l JOIN lead_events e ON e.id = l.id LEFT JOIN accounts a ON a.id = l.account_id
      WHERE l.referral_kind IS NOT NULL AND e.received_at >= ? ORDER BY e.received_at DESC, l.id`),
    // a run that is failing, or a live HubSpot plan still waiting or given up on (dry-run leads have no delivery state)
    troubled: p(`SELECT l.id AS lead_id, e.source, l.status, l.attempts, json_extract(l.crm_json, '$.delivery') AS delivery, e.received_at
      FROM leads l JOIN lead_events e ON e.id = l.id
      WHERE l.status IN ('failed', 'retrying') OR json_extract(l.crm_json, '$.delivery') IN ('pending', 'retrying', 'dead')
      ORDER BY e.received_at DESC, l.id`),
    digests: p(`SELECT list_name, team, channel, rows, at FROM list_digests ORDER BY at, id`),
  };
  return {
    /** Leads at enterprise accounts accepted at or after `since`, newest first. */
    enterpriseLeads: (since: string): EnterpriseLeadRow[] => allRows<EnterpriseLeadRow>(s.enterprise, since),
    /** Leads that named a referrer, at or after `since`, newest first. */
    referralLeads: (since: string): ReferralLeadRow[] => allRows<ReferralLeadRow>(s.referrals, since),
    /** Failed or retrying leads, and leads with an undelivered HubSpot plan, whenever they came in. */
    troubledLeads: (): TroubledLeadRow[] => allRows<TroubledLeadRow>(s.troubled),
    /** Every digest recorded, oldest first. */
    digests: (): DigestRow[] => allRows<DigestRow>(s.digests),
  };
}

export type TodayStore = ReturnType<typeof todayStore>;
