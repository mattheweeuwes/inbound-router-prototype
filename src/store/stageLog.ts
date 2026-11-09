// SQL for stage_log: one row per stage per run, plus the rows that sit outside a run (re-deliveries, failed runs, HubSpot deliveries).
import type { Db } from '../db';

export interface StageRow { leadId: string; stage: string; startedAt: string; ms: number; ok: boolean; note: string | null }

export function stageLogStore(db: Db) {
  const insert = db.prepare(`INSERT INTO stage_log (lead_id, stage, started_at, ms, ok, note) VALUES (?, ?, ?, ?, ?, ?)`);
  const clear = db.prepare(`DELETE FROM stage_log WHERE lead_id = ? AND stage IN (SELECT value FROM json_each(?))`);
  return {
    log: (r: StageRow) => { insert.run(r.leadId, r.stage, r.startedAt, r.ms, r.ok ? 1 : 0, r.note); },
    /** Removes a lead's rows for the named stages, so a re-run is timed afresh. Rows for other stages are history and stay. */
    clear: (leadId: string, stages: readonly string[]) => { clear.run(leadId, JSON.stringify(stages)); },
  };
}

export type StageLogStore = ReturnType<typeof stageLogStore>;
