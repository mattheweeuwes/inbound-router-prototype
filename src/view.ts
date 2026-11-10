// API read models: LeadSummary and LeadDetail.
import type { Ctx } from './context';
import { parse } from './db';
import { adapt } from './sources';
import { matchMirror } from './mirror';
import { afterHours } from './route';
import type { RateFact } from './outbound/fact';
import type { Qualification, Resolution, Route, Source } from './schema';
import type { StoredSecondOpinion } from './secondOpinion';

type SecondOpinionState = 'pending' | 'running' | 'done';

export interface LeadSummary {
  id: string; receivedAt: string; source: string; synthetic: boolean; status: string;
  person: { name: string; title: string | null; email: string | null } | null;
  org: { name: string | null; accountId: string | null; segment: string | null; matchedBy: string | null; confidence: string | null };
  tier: string | null; score: number | null; routeAction: string | null; routeTeam: string | null; owner: string | null;
  useCase: string | null; urgency: string | null; timeToRouteMs: number | null; flags: string[];
}

/** A leads row joined with its event, as SELECT below returns it. */
export type LeadViewRow = {
  id: string; status: string; email: string | null; is_free_mail: number | null; first_name: string | null; last_name: string | null; title: string | null;
  company_name_raw: string | null; contact_key: string | null; duplicate_of: string | null; account_id: string | null; segment: string | null;
  normalized_json: string | null; resolution_json: string | null; qualification_json: string | null; score_json: string | null; route_json: string | null;
  crm_json: string | null; alert_json: string | null; timings_json: string | null; second_opinion: SecondOpinionState | null; second_opinion_json: string | null;
  rate_fact_json: string | null;
  tier: string | null; score: number | null; route_action: string | null; route_team: string | null; owner: string | null; time_to_route_ms: number | null;
  source: Source; received_at: string; synthetic: number; raw_json: string; replays: number;
};
type AccountRow = { name: string | null; domain: string | null; owner: string | null };
type OtherLeadRow = { id: string; first_name: string | null; last_name: string | null; title: string | null; source: string; received_at: string };
type SignalRow = { type: string; detail: string; at: string };
type ReviewRow = { reason: string; candidates_json: string | null; resolved: number };

const SELECT = `SELECT l.*, e.source, e.received_at, e.synthetic, e.raw_json,
  (SELECT COUNT(*) FROM stage_log s WHERE s.lead_id = l.id AND s.stage = 'idempotent_replay') AS replays
  FROM leads l JOIN lead_events e ON e.id = l.id`;

export function toSummary(r: LeadViewRow): LeadSummary {
  const res = parse<Resolution>(r.resolution_json);
  const qual = parse<Qualification>(r.qualification_json);
  const route = parse<Route>(r.route_json);
  let first = r.first_name, last = r.last_name, email = r.email, title = r.title;
  if (!r.normalized_json && r.source !== 'web_intent') { // still queued: show the raw sender rather than a blank
    try { const ev = adapt(r.source, JSON.parse(r.raw_json), r.received_at); first = ev.firstName; last = ev.lastName; email = ev.email; title = ev.title; } catch { /* leave blank */ }
  }
  const name = [first, last].filter(Boolean).join(' ');
  const flags: string[] = [];
  if (r.is_free_mail) flags.push('free_mail');
  if (r.duplicate_of) flags.push('duplicate');
  if (r.route_action === 'review') flags.push('review');
  if (r.segment === 'competitor') flags.push('competitor');
  if (afterHours(r.received_at)) flags.push('after_hours');
  if (route?.rule === 'R5') flags.push('existing_account');
  if (r.replays > 0) flags.push('idempotent_replay');
  return {
    id: r.id, receivedAt: r.received_at, source: r.source, synthetic: !!r.synthetic, status: r.status,
    person: r.source === 'web_intent' ? null : { name: name || email || 'Unknown', title: title ?? null, email: email ?? null },
    org: { name: res?.accountName ?? r.company_name_raw ?? null, accountId: r.account_id, segment: r.segment, matchedBy: res?.method ?? null, confidence: res?.confidence ?? null },
    tier: r.tier, score: r.score, routeAction: r.route_action, routeTeam: r.route_team, owner: r.owner,
    useCase: qual?.final?.useCase ?? null, urgency: qual?.final?.urgency ?? null, timeToRouteMs: r.time_to_route_ms, flags,
  };
}

export function listLeads(ctx: Ctx, limit = 200): LeadSummary[] {
  const rows = ctx.db.prepare(`${SELECT} ORDER BY e.received_at DESC, l.created_at DESC LIMIT ?`).all(Math.max(1, Math.min(1000, limit))) as LeadViewRow[];
  return rows.map(toSummary);
}

export function leadDetail(ctx: Ctx, id: string) {
  const r = ctx.db.prepare(`${SELECT} WHERE l.id = ?`).get(id) as LeadViewRow | undefined;
  if (!r) return null;
  const summary = toSummary(r);
  const since = new Date(Date.parse(r.received_at) - 30 * 86_400_000).toISOString();
  const priorTouches = r.contact_key
    ? (ctx.db.prepare(`SELECT COUNT(*) c FROM leads l JOIN lead_events e ON e.id = l.id WHERE l.contact_key = ? AND l.id != ? AND e.received_at < ? AND e.received_at >= ?`).get(r.contact_key, id, r.received_at, since) as { c: number }).c
    : 0;
  let account: unknown = null;
  if (r.account_id) {
    const a = ctx.db.prepare(`SELECT name, domain, owner FROM accounts WHERE id = ?`).get(r.account_id) as AccountRow | undefined;
    const others = ctx.db.prepare(`SELECT l.id, l.first_name, l.last_name, l.title, e.source, e.received_at FROM leads l JOIN lead_events e ON e.id = l.id WHERE l.account_id = ? AND l.id != ? ORDER BY e.received_at DESC LIMIT 25`).all(r.account_id, id) as OtherLeadRow[];
    const signals = ctx.db.prepare(`SELECT type, detail, at FROM account_signals WHERE account_id = ? ORDER BY at DESC`).all(r.account_id) as SignalRow[];
    account = {
      id: r.account_id, name: a?.name ?? null, owner: matchMirror(ctx.mirror, a?.domain ?? null, a?.name ?? null)?.owner ?? a?.owner ?? null,
      otherLeads: others.map(o => ({ id: o.id, name: [o.first_name, o.last_name].filter(Boolean).join(' ') || null, title: o.title, source: o.source, receivedAt: o.received_at })),
      signals: signals.map(s => ({ type: s.type, detail: s.detail, at: s.at })),
    };
  }
  const stages = ctx.db.prepare(`SELECT stage, started_at AS startedAt, ms, ok, note FROM stage_log WHERE lead_id = ? ORDER BY rowid`).all(id);
  const review = ctx.db.prepare(`SELECT reason, candidates_json, resolved FROM review_queue WHERE lead_id = ?`).get(id) as ReviewRow | undefined;
  return {
    ...summary,
    raw: parse(r.raw_json),
    normalized: parse(r.normalized_json),
    dedupe: { contactKey: r.contact_key, duplicateOf: r.duplicate_of, priorTouches },
    resolution: parse(r.resolution_json),
    qualification: parse(r.qualification_json),
    score: parse(r.score_json),
    route: parse(r.route_json),
    crm: parse(r.crm_json),
    alert: parse(r.alert_json),
    timings: parse(r.timings_json),
    // the organization's own rate from the rate file, the line the brief, alert and task carried; null when it has no rate group
    rateFact: parse<RateFact>(r.rate_fact_json),
    // the model's answer after the alert, for a lead routed on the rules (decision 19); null when none was due
    secondOpinion: r.second_opinion ? { state: r.second_opinion, result: r.second_opinion === 'done' ? parse<StoredSecondOpinion>(r.second_opinion_json) : null } : null,
    account,
    stages,
    replays: r.replays,
    review: review ? { reason: review.reason, candidates: parse(review.candidates_json), resolved: !!review.resolved } : null,
  };
}
