// SQL for crm_outbox: live HubSpot plans waiting to be delivered, oldest first.
import type { StatementSync } from 'node:sqlite';
import { getRow, type Db } from '../db';

export type OutboxState = 'pending' | 'delivered' | 'dead';
export type OutboxRow = { id: number; lead_id: string; plan_json: string; state: OutboxState; attempts: number; next_attempt_at: number; last_error: string | null };

export function outboxStore(db: Db) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  const s = {
    insert: p(`INSERT INTO crm_outbox (lead_id, plan_json, state, attempts, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?, ?)`),
    head: p(`SELECT id, lead_id, plan_json, state, attempts, next_attempt_at, last_error FROM crm_outbox WHERE state = 'pending' ORDER BY id LIMIT 1`),
    // every write below is conditional on the row still being pending, so a plan a re-run superseded is never settled
    retry: p(`UPDATE crm_outbox SET attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'pending'`),
    settle: p(`UPDATE crm_outbox SET state = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'pending'`),
    dropPending: p(`DELETE FROM crm_outbox WHERE lead_id = ? AND state = 'pending'`),
  };
  return {
    enqueue: (leadId: string, planJson: string, dueAtMs: number, at: string): number => Number(s.insert.run(leadId, planJson, dueAtMs, at, at).lastInsertRowid),
    /** The oldest plan still to deliver. Plans go out strictly in this order, so a later write never lands before an earlier one. */
    head: () => getRow<OutboxRow>(s.head),
    /** Returns false when the row is no longer pending. */
    scheduleRetry: (id: number, attempts: number, nextAtMs: number, error: string, at: string): boolean => Number(s.retry.run(attempts, nextAtMs, error, at, id).changes) > 0,
    settle: (id: number, state: Exclude<OutboxState, 'pending'>, attempts: number, error: string | null, at: string): boolean =>
      Number(s.settle.run(state, attempts, error, at, id).changes) > 0,
    /** A re-run replaces the lead's plan; one still waiting to go out is dropped. Delivered and dead rows stay as history. */
    dropPending: (leadId: string) => { s.dropPending.run(leadId); },
  };
}

export type OutboxStore = ReturnType<typeof outboxStore>;
