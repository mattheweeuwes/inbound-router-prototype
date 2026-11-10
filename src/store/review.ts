// SQL for Needs a person (decision 33): the open review items with what a person decides from, the decided ones, and the
// write that records a decision on its item.
import type { StatementSync } from 'node:sqlite';
import { allRows, getRow, type Db } from '../db';
import type { Source } from '../schema';

/** An open review item with the lead it holds, as the Needs a person tab draws it. */
export type OpenItemRow = {
  item_id: number; lead_id: string; reason: string; candidates_json: string | null; created_at: string;
  status: string; source: Source; received_at: string; synthetic: number; list_name: string | null;
  first_name: string | null; last_name: string | null; email: string | null; title: string | null; company_name_raw: string | null;
  account_name: string | null; tier: string | null; route_action: string | null; route_team: string | null; owner: string | null;
  route_reason: string | null; rule: string | null;
};

/** A decided item, newest first, with the lead's route now (what the decision led to). */
export type DecidedItemRow = {
  item_id: number; lead_id: string; reason: string; decision: string; decided_by: string; decision_note: string | null; decided_at: string;
  decision_json: string | null; first_name: string | null; last_name: string | null; email: string | null; company_name_raw: string | null;
  list_name: string | null; status: string; tier: string | null; route_action: string | null; route_team: string | null; owner: string | null;
  sequence: string | null; rule: string | null;
};

/** What a decision is checked against: the lead's state and its route before the decision. */
export type DecisionLeadRow = {
  id: string; status: string; tier: string | null; route_action: string | null; route_team: string | null; owner: string | null;
  rule: string | null; account_name: string | null; company_name_raw: string | null; segment: string | null; sequence: string | null;
};

export interface DecisionWrite { itemId: number; decision: string; by: string; note: string | null; at: string; json: string }

const PERSON = `l.first_name, l.last_name, l.email, l.company_name_raw`;

export function reviewStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    open: p(`SELECT r.id AS item_id, r.lead_id, r.reason, r.candidates_json, r.created_at, l.status, e.source, e.received_at, e.synthetic, e.list_name,
        ${PERSON}, l.title, json_extract(l.resolution_json, '$.accountName') AS account_name, l.tier, l.route_action, l.route_team, l.owner,
        json_extract(l.route_json, '$.reason') AS route_reason, json_extract(l.route_json, '$.rule') AS rule
      FROM review_queue r JOIN leads l ON l.id = r.lead_id JOIN lead_events e ON e.id = l.id
      WHERE r.resolved = 0 ORDER BY r.created_at, r.id`),
    openFor: p(`SELECT id, reason, candidates_json FROM review_queue WHERE lead_id = ? AND resolved = 0 ORDER BY id LIMIT 1`),
    lastDecidedFor: p(`SELECT decision, decided_by, decided_at FROM review_queue WHERE lead_id = ? AND resolved = 1 ORDER BY decided_at DESC, id DESC LIMIT 1`),
    decided: p(`SELECT r.id AS item_id, r.lead_id, r.reason, r.decision, r.decided_by, r.decision_note, r.decided_at, r.decision_json, ${PERSON}, e.list_name,
        l.status, l.tier, l.route_action, l.route_team, l.owner, json_extract(l.route_json, '$.sequence') AS sequence, json_extract(l.route_json, '$.rule') AS rule
      FROM review_queue r JOIN leads l ON l.id = r.lead_id JOIN lead_events e ON e.id = l.id
      WHERE r.resolved = 1 AND r.decided_at IS NOT NULL ORDER BY r.decided_at DESC, r.id DESC LIMIT ?`),
    decidedFor: p(`SELECT decision_json FROM review_queue WHERE lead_id = ? AND resolved = 1 AND decision_json IS NOT NULL ORDER BY decided_at, id`),
    lead: p(`SELECT l.id, l.status, l.tier, l.route_action, l.route_team, l.owner, json_extract(l.route_json, '$.rule') AS rule,
        json_extract(l.resolution_json, '$.accountName') AS account_name, l.company_name_raw, l.segment,
        json_extract(l.route_json, '$.sequence') AS sequence FROM leads l WHERE l.id = ?`),
    // only an open item: a second decision on the same item changes nothing
    decide: p(`UPDATE review_queue SET resolved = 1, decision = ?, decided_by = ?, decision_note = ?, decided_at = ?, decision_json = ? WHERE id = ? AND resolved = 0`),
    // a list's open items about a company nobody could place, oldest first
    unplacedInList: p(`SELECT r.lead_id FROM review_queue r JOIN lead_events e ON e.id = r.lead_id
      WHERE r.resolved = 0 AND r.reason = 'unresolved_company' AND e.list_name = ? ORDER BY e.accepted_at, e.rowid`),
  };
  return {
    openItems: (): OpenItemRow[] => allRows<OpenItemRow>(s.open),
    /** The lead's open item, or null. */
    openItemFor: (leadId: string) => getRow<{ id: number; reason: string; candidates_json: string | null }>(s.openFor, leadId) ?? null,
    /** The lead's latest decided item, for the message that refuses a second decision. */
    lastDecisionFor: (leadId: string) => getRow<{ decision: string; decided_by: string; decided_at: string }>(s.lastDecidedFor, leadId) ?? null,
    /** The latest decisions, newest first. */
    decided: (limit: number): DecidedItemRow[] => allRows<DecidedItemRow>(s.decided, limit),
    /** Every decision made on the lead, oldest first, as decision_json. */
    decisionsFor: (leadId: string): string[] => allRows<{ decision_json: string }>(s.decidedFor, leadId).map(r => r.decision_json),
    lead: (leadId: string): DecisionLeadRow | null => getRow<DecisionLeadRow>(s.lead, leadId) ?? null,
    /** Records the decision on its item. False when the item was already decided. */
    decide: (w: DecisionWrite): boolean => Number(s.decide.run(w.decision, w.by, w.note, w.at, w.json, w.itemId).changes) > 0,
    /** The leads of a list whose open item is an unplaced company. */
    unplacedInList: (list: string): string[] => allRows<{ lead_id: string }>(s.unplacedInList, list).map(r => r.lead_id),
  };
}

export type ReviewStore = ReturnType<typeof reviewStore>;
