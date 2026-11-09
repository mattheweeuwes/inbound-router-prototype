// Metrics and hygiene stats computed from the app database.
import type { Ctx } from './context';
import { parse } from './db';

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);

const LEAD_ROWS = `SELECT l.*, e.source, (SELECT COUNT(*) FROM stage_log s WHERE s.lead_id = l.id AND s.stage = 'idempotent_replay') AS replays FROM leads l JOIN lead_events e ON e.id = l.id`;

/** Resolution is counted over the leads a person sent: not web intent (an account-level visit) and not dropped. */
function resolution(rows: any[]): { resolved: number; of: number } {
  const person = rows.filter(r => r.source !== 'web_intent' && !['drop'].includes(r.route_action));
  return { resolved: person.filter(r => parse<any>(r.resolution_json)?.status === 'resolved').length, of: person.length };
}

/** The pair behind computeMetrics' resolvedPct, as counts, for output that says "32 of 36" instead of a percentage. */
export function resolutionCount(ctx: Ctx): { resolved: number; of: number } {
  return resolution(ctx.db.prepare(LEAD_ROWS).all() as any[]);
}

export function computeMetrics(ctx: Ctx) {
  const rows = ctx.db.prepare(LEAD_ROWS).all() as any[];
  const tally = (key: (r: any) => string | null) => {
    const out: Record<string, number> = {};
    for (const r of rows) { const k = key(r); if (k) out[k] = (out[k] ?? 0) + 1; }
    return out;
  };
  const times = rows.map(r => r.time_to_route_ms).filter((x: unknown): x is number => typeof x === 'number').sort((a, b) => a - b);
  const { resolved, of } = resolution(rows);
  let utmFixed = 0, titlesNormalized = 0;
  for (const r of rows) {
    const n = parse<any>(r.normalized_json);
    utmFixed += n?.utmFixes?.length ?? 0;
    if (r.title && r.title_function && r.title_function !== 'other') titlesNormalized++;
  }
  const review = (ctx.db.prepare(`SELECT COUNT(*) c FROM review_queue WHERE resolved = 0`).get() as any).c as number;
  return {
    total: rows.length,
    bySource: tally(r => r.source),
    byTier: tally(r => r.tier),
    byAction: tally(r => r.route_action),
    byTeam: tally(r => r.route_team),
    timeToRouteMs: { p50: pct(times, 50), p90: pct(times, 90), max: times.length ? times[times.length - 1] : null },
    resolvedPct: of ? Math.round((resolved / of) * 1000) / 10 : null,
    reviewCount: review,
    hygiene: {
      utmFixed,
      duplicatesMerged: rows.filter(r => r.duplicate_of).length,
      idempotentReplays: rows.reduce((a, r) => a + r.replays, 0),
      freeMailResolved: rows.filter(r => r.is_free_mail && parse<any>(r.resolution_json)?.status === 'resolved').length,
      spamDropped: rows.filter(r => r.route_action === 'drop' && (r.is_disposable || parse<any>(r.qualification_json)?.final?.disqualifier === 'spam')).length,
      titlesNormalized,
      nonUs: rows.filter(r => r.segment === 'non_us').length,
    },
    registry: ctx.registry.kind,
    generatedAt: new Date(ctx.cfg.now()).toISOString(),
  };
}
