// SQL for lead_events and leads: acceptance, the per-stage status writes, recovery and the reads the pipeline makes.
// Each status change is one UPDATE with fixed columns; nothing reads the row back.
import type { StatementSync } from 'node:sqlite';
import { allRows, getRow, tx, type Db } from '../db';
import type { Source } from '../schema';

/** What processLead needs to start a run. */
export type LeadInputRow = { source: Source; received_at: string; raw_json: string; synthetic: number; created_at: string; attempts: number };

/** An earlier lead from the same contact inside the dedupe window, oldest first. */
export type PriorTouchRow = { id: string; owner: string | null; route_team: string | null; route_action: string | null; alert_json: string | null; received_at: string };

export interface AcceptedEvent { id: string; source: string; sourceEventId: string; receivedAt: string; synthetic: boolean; rawJson: string; acceptedAt: string }

/** Columns written when a lead is normalized. */
export interface NormalizedColumns {
  email: string | null; email_domain: string | null; is_free_mail: number; is_disposable: number;
  first_name: string | null; last_name: string | null; title: string | null; title_function: string | null; title_seniority: string | null;
  company_name_raw: string | null; company_domain: string | null; state: string | null; country: string | null; message: string | null;
  utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; utm_content: string | null; utm_term: string | null;
  channel: string | null; landing_page: string | null; referrer: string | null; contact_key: string | null; duplicate_of: string | null;
  normalized_json: string | null;
}

/** What the second-opinion worker reads to make the model call again and to word a follow-up. */
export type SecondOpinionInputRow = {
  source: Source; received_at: string; raw_json: string; synthetic: number; normalized_json: string | null; resolution_json: string | null;
  qualification_json: string | null; route_json: string | null; alert_json: string | null; timings_json: string | null; second_opinion_json: string | null;
  created_at: string;
};

export interface RoutedColumns { route_json: string | null; route_action: string; route_team: string; owner: string; sla_due_at: string | null; time_to_route_ms: number }

const NORMALIZED_COLS: (keyof NormalizedColumns)[] = [
  'email', 'email_domain', 'is_free_mail', 'is_disposable', 'first_name', 'last_name', 'title', 'title_function', 'title_seniority',
  'company_name_raw', 'company_domain', 'state', 'country', 'message', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'channel', 'landing_page', 'referrer', 'contact_key', 'duplicate_of', 'normalized_json',
];

export function leadStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    eventByKey: p(`SELECT id FROM lead_events WHERE source = ? AND source_event_id = ?`),
    insertEvent: p(`INSERT INTO lead_events (id, source, source_event_id, received_at, synthetic, raw_json, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertLead: p(`INSERT INTO leads (id, status, created_at, updated_at) VALUES (?, 'received', ?, ?)`),
    unfinished: p(`SELECT l.id FROM leads l JOIN lead_events e ON e.id = l.id WHERE l.status NOT IN ('done', 'failed') ORDER BY e.accepted_at, e.rowid`),
    dueRetries: p(`SELECT id FROM leads WHERE status = 'retrying' AND retry_at <= ? ORDER BY retry_at, rowid`),
    nextRetryAfter: p(`SELECT MIN(retry_at) AS at FROM leads WHERE status = 'retrying' AND retry_at > ?`),
    input: p(`SELECT e.source, e.received_at, e.raw_json, e.synthetic, l.created_at, l.attempts FROM lead_events e JOIN leads l ON l.id = e.id WHERE e.id = ?`),
    priorTouches: p(`SELECT l.id, l.owner, l.route_team, l.route_action, l.alert_json, e.received_at FROM leads l JOIN lead_events e ON e.id = l.id
      WHERE l.contact_key = ? AND l.id != ? AND e.received_at < ? AND e.received_at >= ? AND l.status = 'done' ORDER BY e.received_at ASC`),
    otherContacts: p(`SELECT COUNT(DISTINCT l.contact_key) AS n FROM leads l JOIN lead_events e ON e.id = l.id
      WHERE l.account_id = ? AND l.id != ? AND l.contact_key IS NOT NULL AND l.contact_key != ? AND e.received_at >= ? AND e.received_at < ?
        AND l.status = 'done' AND COALESCE(l.route_action, '') NOT IN ('drop', 'careers', 'press')`),
    normalized: p(`UPDATE leads SET status = 'normalized', updated_at = ?, ${NORMALIZED_COLS.map(c => `${c} = ?`).join(', ')} WHERE id = ?`),
    resolved: p(`UPDATE leads SET status = 'resolved', updated_at = ?, resolution_json = ?, account_id = ?, segment = ? WHERE id = ?`),
    qualified: p(`UPDATE leads SET status = 'qualified', updated_at = ?, qualification_json = ?, resolution_json = ?, segment = ? WHERE id = ?`),
    scored: p(`UPDATE leads SET status = 'scored', updated_at = ?, score_json = ?, score = ?, tier = ? WHERE id = ?`),
    routed: p(`UPDATE leads SET status = 'routed', updated_at = ?, route_json = ?, route_action = ?, route_team = ?, owner = ?, sla_due_at = ?, time_to_route_ms = ? WHERE id = ?`),
    notified: p(`UPDATE leads SET status = 'notified', updated_at = ?, alert_json = ?, rate_fact_json = ? WHERE id = ?`),
    synced: p(`UPDATE leads SET status = 'synced', updated_at = ?, crm_json = ? WHERE id = ?`),
    done: p(`UPDATE leads SET status = 'done', updated_at = ?, timings_json = ?, retry_at = NULL WHERE id = ?`),
    retrying: p(`UPDATE leads SET status = 'retrying', updated_at = ?, attempts = ?, retry_at = ? WHERE id = ?`),
    failed: p(`UPDATE leads SET status = 'failed', updated_at = ?, attempts = ?, retry_at = NULL WHERE id = ?`),
    crm: p(`UPDATE leads SET crm_json = ?, updated_at = ? WHERE id = ?`),
    secondOpinionDue: p(`UPDATE leads SET second_opinion = 'pending', second_opinion_json = ? WHERE id = ?`),
    clearSecondOpinion: p(`UPDATE leads SET second_opinion = NULL, second_opinion_json = NULL WHERE id = ?`),
    // only a finished lead: its alert is out, which is the point of asking afterwards
    nextSecondOpinion: p(`SELECT l.id FROM leads l JOIN lead_events e ON e.id = l.id WHERE l.second_opinion = 'pending' AND l.status = 'done' ORDER BY e.accepted_at, e.rowid LIMIT 1`),
    claimSecondOpinion: p(`UPDATE leads SET second_opinion = 'running' WHERE id = ? AND second_opinion = 'pending' AND status = 'done'`),
    secondOpinionInput: p(`SELECT e.source, e.received_at, e.raw_json, e.synthetic, l.normalized_json, l.resolution_json, l.qualification_json, l.route_json,
      l.alert_json, l.timings_json, l.second_opinion_json, l.created_at FROM leads l JOIN lead_events e ON e.id = l.id WHERE l.id = ?`),
    // a re-run of the lead resets the column, so a call that was in flight for the earlier run is not stored over the new one
    saveSecondOpinion: p(`UPDATE leads SET second_opinion = 'done', second_opinion_json = ?, updated_at = ? WHERE id = ? AND second_opinion = 'running'`),
    requeueSecondOpinions: p(`UPDATE leads SET second_opinion = 'pending' WHERE second_opinion = 'running'`),
    followUpAlerts: p(`UPDATE leads SET alert_json = json_set(COALESCE(alert_json, '{"slack":null}'), '$.followUp', json(?)), updated_at = ? WHERE id = ?`),
    failureAlert: p(`UPDATE leads SET alert_json = json_set(COALESCE(alert_json, '{"slack":null}'), '$.failure', json(?)), updated_at = ? WHERE id = ?`),
  };

  return {
    eventLeadId: (source: string, sourceEventId: string): string | null => getRow<{ id: string }>(s.eventByKey, source, sourceEventId)?.id ?? null,
    /** The event and its lead in one transaction: an event recorded without its lead would block the re-delivery (same key) and never be processed. */
    accept(e: AcceptedEvent) {
      tx(db, () => {
        s.insertEvent.run(e.id, e.source, e.sourceEventId, e.receivedAt, e.synthetic ? 1 : 0, e.rawJson, e.acceptedAt);
        s.insertLead.run(e.id, e.acceptedAt, e.acceptedAt);
      });
    },
    unfinishedIds: (): string[] => allRows<{ id: string }>(s.unfinished).map(r => r.id),
    dueRetryIds: (nowMs: number): string[] => allRows<{ id: string }>(s.dueRetries, nowMs).map(r => r.id),
    /** The earliest retry still in the future; the due ones are already queued. */
    nextRetryAfter: (nowMs: number): number | null => getRow<{ at: number | null }>(s.nextRetryAfter, nowMs)?.at ?? null,
    input: (id: string) => getRow<LeadInputRow>(s.input, id),
    priorTouches: (contactKey: string, leadId: string, receivedAt: string, since: string) => allRows<PriorTouchRow>(s.priorTouches, contactKey, leadId, receivedAt, since),
    /** Other contacts at the account with a finished, live lead in [since, until). */
    otherContactsAt: (accountId: string, leadId: string, contactKey: string | null, since: string, until: string): number =>
      Number(getRow<{ n: number }>(s.otherContacts, accountId, leadId, contactKey ?? '', since, until)?.n ?? 0),

    markNormalized: (id: string, at: string, c: NormalizedColumns) => { s.normalized.run(at, ...NORMALIZED_COLS.map(k => c[k]), id); },
    markResolved: (id: string, at: string, resolutionJson: string | null, accountId: string | null, segment: string | null) => { s.resolved.run(at, resolutionJson, accountId, segment, id); },
    markQualified: (id: string, at: string, qualificationJson: string | null, resolutionJson: string | null, segment: string | null) => { s.qualified.run(at, qualificationJson, resolutionJson, segment, id); },
    markScored: (id: string, at: string, scoreJson: string | null, score: number, tier: string) => { s.scored.run(at, scoreJson, score, tier, id); },
    markRouted: (id: string, at: string, c: RoutedColumns) => { s.routed.run(at, c.route_json, c.route_action, c.route_team, c.owner, c.sla_due_at, c.time_to_route_ms, id); },
    /** The alert, and the rate line the brief carried (null when the organization has no rate group). */
    markNotified: (id: string, at: string, alertJson: string | null, rateFactJson: string | null) => { s.notified.run(at, alertJson, rateFactJson, id); },
    markSynced: (id: string, at: string, crmJson: string | null) => { s.synced.run(at, crmJson, id); },
    markDone: (id: string, at: string, timingsJson: string | null) => { s.done.run(at, timingsJson, id); },
    markRetrying: (id: string, at: string, attempts: number, retryAtMs: number) => { s.retrying.run(at, attempts, retryAtMs, id); },
    markFailed: (id: string, at: string, attempts: number) => { s.failed.run(at, attempts, id); },
    /** The HubSpot record, rewritten by the outbox worker as delivery moves on. The status is not touched. */
    setCrm: (id: string, at: string, crmJson: string) => { s.crm.run(crmJson, at, id); },
    /** Marks the lead for a second opinion after its alert. shownJson is what the model call will be shown that the lead row does not keep. */
    markSecondOpinionDue: (id: string, shownJson: string) => { s.secondOpinionDue.run(shownJson, id); },
    clearSecondOpinion: (id: string) => { s.clearSecondOpinion.run(id); },
    /** The oldest finished lead whose second opinion is due, or null. */
    nextSecondOpinion: (): string | null => getRow<{ id: string }>(s.nextSecondOpinion)?.id ?? null,
    /** Takes the lead's second opinion for this worker. False when it is no longer due (done, re-run, or taken). */
    claimSecondOpinion: (id: string): boolean => Number(s.claimSecondOpinion.run(id).changes) > 0,
    secondOpinionInput: (id: string) => getRow<SecondOpinionInputRow>(s.secondOpinionInput, id),
    /** Stores the result. False when the lead was re-run while the call was in flight; nothing is written then. */
    saveSecondOpinion: (id: string, at: string, resultJson: string): boolean => Number(s.saveSecondOpinion.run(resultJson, at, id).changes) > 0,
    /** Boot: a call a stopped process left in flight is due again. Returns how many. */
    requeueSecondOpinions: (): number => Number(s.requeueSecondOpinions.run().changes),
    /** Adds the follow-up a doubt after the alert sends, under alert_json.followUp, leaving the alert itself as it was. */
    addFollowUpAlerts: (id: string, at: string, payloadsJson: string) => { s.followUpAlerts.run(payloadsJson, at, id); },
    /** Adds the RevOps give-up alert under alert_json.failure, leaving any rep alert in alert_json.slack as it was. */
    addFailureAlert: (id: string, at: string, payloadJson: string) => { s.failureAlert.run(payloadJson, at, id); },
  };
}

export type LeadStore = ReturnType<typeof leadStore>;
