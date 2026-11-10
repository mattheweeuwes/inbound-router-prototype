// SQL for uploaded lists (decision 24): which lists owe a digest, the rows of a list's current batch, and the digest record.
import type { StatementSync } from 'node:sqlite';
import { allRows, getRow, type Db } from '../db';

/** A list with at least one folded lead whose digest has not gone out. */
export type PendingListRow = { list: string; last_accepted: string; unfinished: number };

/** One lead of a list's current batch, with what its digest line needs. */
export type ListBatchRow = {
  id: string; status: string; first_name: string | null; last_name: string | null; email: string | null; title: string | null;
  company_name_raw: string | null; tier: string | null; score: number | null; route_action: string | null; route_team: string | null;
  sla_due_at: string | null; digest_team: string | null; digest_id: number | null; resolution_json: string | null; message: string | null;
  created_at: string; accepted_at: string; synthetic: number; review_reason: string | null; enterprise: number;
};

export interface DigestRecord { list: string; team: string; channel: string; rows: number; batchFrom: string; batchTo: string; at: string; payloadJson: string }

export function listStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    pending: p(`SELECT e.list_name AS list, MAX(e.accepted_at) AS last_accepted, SUM(l.status NOT IN ('done', 'failed')) AS unfinished
      FROM lead_events e JOIN leads l ON l.id = e.id
      WHERE e.list_name IN (SELECT e2.list_name FROM leads l2 JOIN lead_events e2 ON e2.id = l2.id WHERE l2.digest_team IS NOT NULL AND l2.digest_id IS NULL)
      GROUP BY e.list_name ORDER BY MIN(e.accepted_at)`),
    watermark: p(`SELECT MAX(batch_to) AS at FROM list_digests WHERE list_name = ?`),
    // the batch: rows accepted after the list's last digest, plus any folded row still owed one (a re-run of an older row)
    batch: p(`SELECT l.id, l.status, l.first_name, l.last_name, l.email, l.title, l.company_name_raw, l.tier, l.score, l.route_action, l.route_team,
        l.sla_due_at, l.digest_team, l.digest_id, l.resolution_json, l.message, l.created_at, e.accepted_at, e.synthetic, l.enterprise,
        (SELECT r.reason FROM review_queue r WHERE r.lead_id = l.id ORDER BY r.id LIMIT 1) AS review_reason
      FROM leads l JOIN lead_events e ON e.id = l.id
      WHERE e.list_name = ? AND (e.accepted_at > ? OR (l.digest_team IS NOT NULL AND l.digest_id IS NULL))
      ORDER BY e.accepted_at, e.rowid`),
    insert: p(`INSERT INTO list_digests (list_name, team, channel, rows, batch_from, batch_to, at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    // the digest is the lead's alert: its time goes on the lead, and time to alert is measured to it
    digested: p(`UPDATE leads SET digest_id = ?, alert_json = json_set(alert_json, '$.digest.at', ?, '$.digest.id', ?),
        timings_json = json_set(COALESCE(timings_json, '{}'), '$.alerted', ?)
      WHERE id = ? AND digest_team IS NOT NULL AND digest_id IS NULL`),
    folded: p(`UPDATE leads SET digest_team = ?, digest_id = NULL WHERE id = ?`),
  };

  return {
    /** Lists owing a digest, with their latest acceptance and how many of their leads are not finished. */
    pending: (): PendingListRow[] => allRows<PendingListRow>(s.pending).map(r => ({ ...r, unfinished: Number(r.unfinished) })),
    /** The last acceptance time the list's previous digests covered, or '' when it has none. */
    watermark: (list: string): string => getRow<{ at: string | null }>(s.watermark, list)?.at ?? '',
    batch: (list: string, after: string): ListBatchRow[] => allRows<ListBatchRow>(s.batch, list, after),
    insertDigest: (d: DigestRecord): number => Number(s.insert.run(d.list, d.team, d.channel, d.rows, d.batchFrom, d.batchTo, d.at, d.payloadJson).lastInsertRowid),
    markDigested: (leadId: string, digestId: number, at: string, alertedMs: number) => { s.digested.run(digestId, at, digestId, alertedMs, leadId); },
    /** The lead waits for its list's digest for this team. */
    markFolded: (leadId: string, team: string) => { s.folded.run(team, leadId); },
  };
}

export type ListStore = ReturnType<typeof listStore>;
