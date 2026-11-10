// Explainable score: every point is an itemized line. Fit (max 50) + intent (max 50).
import type { Classification, LeadEvent, Normalized, Resolution, Score, ScoreItem, Segment, Tier, TitleFunction, TitleSeniority } from './schema';

export const SEGMENT_POINTS: Record<Segment, number> = {
  health_system: 22, payer: 20, benefits_consultant_broker: 20, tpa: 16, life_sciences: 16, standalone_hospital: 14,
  employer_self_funded: 14, innovator_navigation: 14, innovator_api_data: 14, provider_group: 12, pe_investor: 12,
  consulting_advisory: 12, unknown_org: 6, government: 4, academic: 3, non_us: 2, media: 0, competitor: 0,
};

export const SOURCE_POINTS: Record<string, number> = {
  calendly_demo: 28, marketplace: 20, signal_ask_waitlist: 16, sample_signup: 16, api_key: 14, guide_download: 10, event_scan: 8, web_intent: 6,
};

export const URGENCY_POINTS = { now: 12, this_quarter: 7, exploring: 2, unknown: 0 } as const;

const SENIORITY_MULT: Record<TitleSeniority, number> = { c_level: 1.2, vp: 1.2, director: 1.15, manager: 1.0, individual: 0.85, student: 0.3, unknown: 0.9 };

export function functionWeight(fn: TitleFunction, innovatorish: boolean): number {
  switch (fn) {
    case 'managed_care_contracting': case 'network_strategy': case 'benefits': return 10;
    case 'revenue_cycle_finance': case 'strategy_bd': case 'executive': return 8;
    case 'analytics_data': return 7;
    case 'product_engineering': return innovatorish ? 6 : 2;
    case 'clinical': return 3;
    case 'marketing_sales': return 2;
    case 'other': return 1;
    default: return 0; // research_academic, media, hr_recruiting
  }
}

export function tierFor(total: number): Exclude<Tier, 'X'> {
  return total >= 70 ? 'A' : total >= 50 ? 'B' : total >= 30 ? 'C' : 'D';
}

export interface ScoreInput {
  ev: LeadEvent;
  n: Normalized;
  res: Resolution;
  final: Classification;
  priorTouches: number; // same contact, earlier, within 30 days
  accountIntent: number; // already capped web-intent + other-leads-at-account points
  accountIntentNote?: string;
  /** a named referral (src/referral.ts): its points and the line that says who; absent when the lead names none */
  referral?: { points: number; label: string } | null;
}

function sizePoints(res: Resolution): { points: number; label: string } {
  const f = res.firmographics;
  if (res.segment === 'health_system') {
    const h = f.hospitals ?? 0;
    if (h >= 20) return { points: 16, label: `${h} hospitals (20+)` };
    if (h >= 8) return { points: 12, label: `${h} hospitals (8-19)` };
    if (h >= 3) return { points: 8, label: `${h} hospitals (3-7)` };
    if (h >= 1) return { points: 4, label: `${h} hospital(s) (1-2)` };
    return { points: 0, label: 'hospital count unknown' };
  }
  if (res.segment === 'standalone_hospital') {
    const b = f.beds ?? null;
    if (b != null && b >= 300) return { points: 10, label: `${b} beds (300+)` };
    if (b != null && b >= 100) return { points: 6, label: `${b} beds (100-299)` };
    return { points: 3, label: b == null ? 'beds unknown' : `${b} beds (<100)` };
  }
  if (res.segment === 'payer') {
    const k = f.payerKind ?? 'other';
    return k === 'national' || k === 'blue' ? { points: 14, label: `${k} payer` } : k === 'regional' ? { points: 10, label: 'regional payer' } : { points: 6, label: `${k} payer` };
  }
  if (res.segment === 'benefits_consultant_broker') {
    return f.sizeClass === 'national' ? { points: 14, label: 'national broker/consultant' } : f.sizeClass === 'regional' ? { points: 8, label: 'regional broker/consultant' } : { points: 6, label: 'known broker/consultant' };
  }
  if (res.segment === 'media' || res.segment === 'competitor') return { points: 0, label: 'no size credit' };
  if (res.status === 'resolved' && ['curated_domain', 'org_domain', 'company_name', 'site_title', 'nppes', 'crm'].includes(res.method)) return { points: 6, label: 'known organization' };
  return { points: 0, label: 'unknown size' };
}

export function scoreLead(i: ScoreInput): Score {
  const items: ScoreItem[] = [];
  const { ev, n, res, final } = i;

  // ---- FIT
  const segPts = SEGMENT_POINTS[res.segment];
  items.push({ group: 'fit', label: `Segment: ${res.segment}`, points: segPts });
  const size = sizePoints(res);
  if (size.points) items.push({ group: 'fit', label: `Size: ${size.label}`, points: size.points });
  const innovatorish = res.segment.startsWith('innovator') || ev.source === 'marketplace' || ev.source === 'api_key';
  const fw = functionWeight(n.titleFunction, innovatorish);
  const mult = SENIORITY_MULT[n.titleSeniority];
  const persona = ev.source === 'web_intent' ? 0 : Math.min(12, Math.round(fw * mult));
  if (persona) items.push({ group: 'fit', label: `Persona: ${n.titleFunction} (${fw}) x ${n.titleSeniority} (${mult})`, points: persona });
  let fit = items.filter(x => x.group === 'fit').reduce((a, x) => a + x.points, 0);
  if (fit > 50) { items.push({ group: 'fit', label: 'Cap: fit maximum 50', points: 50 - fit }); fit = 50; }

  // ---- INTENT
  items.push({ group: 'intent', label: `Source: ${ev.source}`, points: SOURCE_POINTS[ev.source] ?? 0 });
  const up = URGENCY_POINTS[final.urgency];
  if (up) items.push({ group: 'intent', label: `Urgency: ${final.urgency}`, points: up });
  if (ev.source === 'sample_signup') {
    const sessions = Number(ev.context.sessions ?? 0), searches = Number(ev.context.searches ?? 0);
    let usage = 0;
    if (sessions >= 3) { items.push({ group: 'intent', label: `Usage: ${sessions} sessions`, points: 6 }); usage += 6; }
    if (searches > 0) { items.push({ group: 'intent', label: `Usage: ${searches} search(es)`, points: 4 }); usage += 4; }
    if (usage > 10) items.push({ group: 'intent', label: 'Cap: product usage maximum 10', points: 10 - usage });
  }
  if (i.priorTouches > 0) {
    const pts = Math.min(8, 4 * i.priorTouches);
    items.push({ group: 'intent', label: `Repeat engagement: ${i.priorTouches} prior touch(es) in 30 days`, points: pts });
  }
  if (i.referral?.points) items.push({ group: 'intent', label: i.referral.label, points: i.referral.points });
  if (i.accountIntent > 0) items.push({ group: 'intent', label: `Account intent: ${i.accountIntentNote ?? 'other activity at this account'}`, points: i.accountIntent });
  let intent = items.filter(x => x.group === 'intent').reduce((a, x) => a + x.points, 0);
  if (intent > 50) { items.push({ group: 'intent', label: 'Cap: intent maximum 50', points: 50 - intent }); intent = 50; }

  const total = fit + intent;
  const disqualified = final.disqualifier !== 'none' || res.segment === 'competitor' || n.isDisposable;
  return { total, fit, intent, tier: disqualified ? 'X' : tierFor(total), items };
}
