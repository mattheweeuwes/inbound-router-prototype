// SQL for the accounts API (src/accounts.ts): reads of the views in sql/models/v_accounts.sql, which hold the logic.
import type { StatementSync } from 'node:sqlite';
import { allRows, getRow, type Db } from '../db';

/** One v_accounts row. */
export type AccountRow = {
  account_key: string; name: string | null; segment: string | null; domain: string | null; enterprise: number; enterprise_fact: string | null;
  claimed_owner: string | null; account_score: number; top_tier: string | null; leads_30d: number; contacts_30d: number; last_activity_at: string | null;
  referrals_in: number; referrals_out: number; web_intent_signals: number; has_rate_fact: number; open_reviews: number;
};
export type AccountPersonRow = {
  lead_id: string; first_name: string | null; last_name: string | null; email: string | null; title: string | null; source: string;
  tier: string | null; score: number | null; route_action: string | null; owner: string | null; received_at: string;
};
export type AccountSignalRow = { kind: string; detail: string; lead_id: string | null; at: string };
export type AccountReviewRow = { lead_id: string; reason: string; created_at: string };

/** The ranking the list uses: enterprise accounts first, then the account score, then the latest activity. */
const RANKED = `ORDER BY enterprise DESC, account_score DESC, last_activity_at IS NULL, last_activity_at DESC, account_key`;

export function accountViewStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    ranked: p(`SELECT * FROM v_accounts ${RANKED} LIMIT ?`),
    count: p(`SELECT COUNT(*) AS n FROM v_accounts`),
    one: p(`SELECT * FROM v_accounts WHERE account_key = ?`),
    people: p(`SELECT lead_id, first_name, last_name, email, title, source, tier, score, route_action, owner, received_at
      FROM v_account_people WHERE account_key = ? ORDER BY received_at DESC, lead_id LIMIT ?`),
    signals: p(`SELECT kind, detail, lead_id, at FROM v_account_signals WHERE account_key = ? ORDER BY at DESC, kind LIMIT ?`),
    reviews: p(`SELECT r.lead_id, r.reason, r.created_at FROM review_queue r JOIN leads l ON l.id = r.lead_id
      WHERE l.account_id = ? AND r.resolved = 0 ORDER BY r.created_at`),
    rateLine: p(`SELECT json_extract(rate_fact_json, '$.line') AS line FROM leads WHERE account_id = ? AND rate_fact_json IS NOT NULL ORDER BY updated_at DESC LIMIT 1`),
  };
  return {
    ranked: (limit: number): AccountRow[] => allRows<AccountRow>(s.ranked, limit),
    count: (): number => Number(getRow<{ n: number }>(s.count)?.n ?? 0),
    one: (key: string): AccountRow | null => getRow<AccountRow>(s.one, key) ?? null,
    people: (key: string, limit: number): AccountPersonRow[] => allRows<AccountPersonRow>(s.people, key, limit),
    signals: (key: string, limit: number): AccountSignalRow[] => allRows<AccountSignalRow>(s.signals, key, limit),
    reviews: (key: string): AccountReviewRow[] => allRows<AccountReviewRow>(s.reviews, key),
    /** The rate line the latest lead at the account carried (src/outbound/fact.ts), or null. */
    rateLine: (key: string): string | null => getRow<{ line: string | null }>(s.rateLine, key)?.line ?? null,
  };
}

export type AccountViewStore = ReturnType<typeof accountViewStore>;
