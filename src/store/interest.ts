// SQL for feature interest (decision 30): the tags a lead is committed with, the leads still to be looked at (the backfill), and
// the tag rows joined to what the interest and asked reads need. The cues are src/interest; this file only stores and reads.
import type { StatementSync } from 'node:sqlite';
import { allRows, type Db } from '../db';
import type { InterestTag } from '../interest/cues';
import type { Source } from '../schema';

/** A finished lead that has not been looked at for cues. */
export type UntaggedLeadRow = { id: string; source: Source; received_at: string; raw_json: string };

/** One tag with the lead, person and account it belongs to. */
export type InterestRow = {
  feature: string; cue: string; evidence: string; lead_id: string; contact_key: string | null; source: Source; received_at: string; synthetic: number;
  tier: string | null; route_action: string | null; message: string | null; first_name: string | null; last_name: string | null; email: string | null;
  title: string | null; company_name_raw: string | null; company_domain: string | null;
  account_id: string | null; account_name: string | null; account_domain: string | null; claimed_owner: string | null;
};

/** Route actions that mean the person is not a buyer: their words are not demand for a feature, so they are left out of every count. */
export const NOT_A_BUYER = ['drop', 'careers', 'press', 'competitor_flag'] as const;

export function interestStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    clear: p(`DELETE FROM lead_interest WHERE lead_id = ?`),
    insert: p(`INSERT INTO lead_interest (lead_id, feature, cue, evidence) VALUES (?, ?, ?, ?)`),
    tagged: p(`UPDATE leads SET interest_tagged_at = ? WHERE id = ?`),
    untagged: p(`SELECT l.id, e.source, e.received_at, e.raw_json FROM leads l JOIN lead_events e ON e.id = l.id
      WHERE l.status = 'done' AND l.interest_tagged_at IS NULL ORDER BY e.rowid`),
    // the newest first; a window starts at "since" by the lead's own time. Not-buyers are left out here, once, for every reader.
    rows: p(`SELECT t.feature, t.cue, t.evidence, l.id AS lead_id, l.contact_key, e.source, e.received_at, e.synthetic, l.tier, l.route_action, l.message,
        l.first_name, l.last_name, l.email, l.title, l.company_name_raw, l.company_domain,
        l.account_id, a.name AS account_name, a.domain AS account_domain, a.owner AS claimed_owner
      FROM lead_interest t JOIN leads l ON l.id = t.lead_id JOIN lead_events e ON e.id = l.id LEFT JOIN accounts a ON a.id = l.account_id
      WHERE e.received_at >= ? AND COALESCE(l.route_action, '') NOT IN (${NOT_A_BUYER.map(a => `'${a}'`).join(', ')})
      ORDER BY e.received_at DESC, l.id, t.feature, t.cue`),
  };
  return {
    /** Rewrites a lead's tags and marks it looked at. The caller owns the transaction. */
    replace: (leadId: string, tags: readonly InterestTag[], at: string) => {
      s.clear.run(leadId);
      for (const t of tags) s.insert.run(leadId, t.feature, t.cue, t.evidence);
      s.tagged.run(at, leadId);
    },
    /** Finished leads not yet looked at for cues, in acceptance order. */
    untagged: (): UntaggedLeadRow[] => allRows<UntaggedLeadRow>(s.untagged),
    /** Every tag at or after `since` (an ISO time; '' for all), newest lead first. */
    rows: (since = ''): InterestRow[] => allRows<InterestRow>(s.rows, since),
  };
}

export type InterestStore = ReturnType<typeof interestStore>;
