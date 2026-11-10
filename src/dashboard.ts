// Read model for GET /api/dashboard, the cockpit's Overview tab.
// Every number is computed on request from the app database, fixtures/owners.json (via ctx.owners), or an artifact that already
// exists (out/eval.json, out/hubspot/*.jsonl, docs/hubspot-properties.json). Nothing is hard-coded, and nothing here writes.
//
// Timing: time_to_route_ms runs from the 202 to the routing decision, so it includes the wait for earlier leads in the ordered
// section (timings.queued). Processing is reported as time_to_route_ms minus queued; the queue wait is reported on its own.
// A lead's order-independent work (src/stages.ts prepareLead) runs alongside that wait, so stage times overlap it. Time to
// alert (timings.alerted) is what the rep experiences; the model's second opinion runs after it and is reported apart.
// Clocks: received_at is the lead's own time (a replay keeps the fixture times); stage_log, review_queue.created_at and
// generatedAt are the server's wall clock. Each figure below says which one it uses.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateGate, FLOORS, RULES_FLOORS, type SetCounts } from '../scripts/lib/eval-gate';
import type { Ctx } from './context';
import { parse } from './db';
import { computeMetrics } from './hygiene';
import { waitedForModel } from './modelPath';
import { computeScorecard } from './quality';
import { SOURCES, type Segment, type Source } from './schema';
import type { SecondOpinion, StoredSecondOpinion } from './secondOpinion';
import { SIGNED_DOORS, unkeyedSignedDoors } from './sources';
import { isBusinessTime } from './time';

type Tier = 'A' | 'B' | 'C' | 'D' | 'X';
export type TierCounts = Record<Tier | 'pending', number>;
export type Status = 'ok' | 'warn' | 'bad' | 'idle';
const emptyTiers = (): TierCounts => ({ A: 0, B: 0, C: 0, D: 0, X: 0, pending: 0 });

/** Serif's go-to-market motions, and the doors that feed each one. Every door in SOURCES belongs to exactly one motion. */
export const MOTIONS: { id: 'sales' | 'product' | 'marketing'; label: string; doors: Source[] }[] = [
  { id: 'sales', label: 'Sales-led', doors: ['calendly_demo', 'event_scan'] },
  { id: 'product', label: 'Product-led', doors: ['sample_signup', 'api_key', 'signal_ask_waitlist', 'marketplace'] },
  { id: 'marketing', label: 'Marketing', doors: ['guide_download', 'web_intent'] },
];

/** Serif's markets, as groups of resolved segments. Every segment belongs to exactly one market. */
export const MARKETS: { id: string; label: string; segments: Segment[] }[] = [
  { id: 'providers', label: 'Providers & health systems', segments: ['health_system', 'standalone_hospital', 'provider_group'] },
  { id: 'payers', label: 'Payers', segments: ['payer'] },
  { id: 'benefits', label: 'Employers, brokers & TPAs', segments: ['employer_self_funded', 'benefits_consultant_broker', 'tpa', 'government'] },
  { id: 'data_api', label: 'Data & API buyers', segments: ['innovator_api_data', 'innovator_navigation'] },
  { id: 'other', label: 'Other', segments: ['life_sciences', 'pe_investor', 'consulting_advisory', 'academic', 'media', 'competitor', 'non_us', 'unknown_org'] },
];

const SALES_ROUTES = new Set(['rep_alert', 'owner_task', 'team_queue']);
const ASSIGNED_ROUTES = new Set(['rep_alert', 'owner_task', 'team_queue', 'attach_to_existing']);
const STAGES = ['normalize', 'resolve', 'qualify', 'score', 'route', 'notify', 'crm'] as const;

/** Nearest-rank percentile (k = ceil(p/100 * n), the k-th smallest), the same rule as /api/metrics and the data-quality scorecard. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const spread = (values: number[]) => ({ n: values.length, p50: percentile(values, 50), p90: percentile(values, 90) });
const share = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null); // percent, one decimal; null when there is no base

interface Lead {
  id: string; status: string; tier: Tier | null; segment: Segment | null; action: string | null; team: string | null; owner: string | null;
  slaDueAt: string | null; ttr: number | null; accountId: string | null; duplicateOf: string | null; isDisposable: boolean;
  source: Source; receivedAt: string; createdAt: string | null; updatedAt: string | null; synthetic: boolean;
  name: string | null; title: string | null; companyRaw: string | null;
  res: any; qual: any; route: any; crm: any; alert: any; timings: Record<string, number> | null;
  secondOpinionState: 'pending' | 'running' | 'done' | null; secondOpinion: StoredSecondOpinion | null;
}

/** The columns loadLeads selects. */
type LeadRow = {
  id: string; status: string; tier: Tier | null; segment: Segment | null; route_action: string | null; route_team: string | null; owner: string | null;
  sla_due_at: string | null; time_to_route_ms: number | null; account_id: string | null; duplicate_of: string | null; is_disposable: number | null;
  first_name: string | null; last_name: string | null; email: string | null; title: string | null; company_name_raw: string | null;
  created_at: string | null; updated_at: string | null; resolution_json: string | null; qualification_json: string | null; route_json: string | null;
  crm_json: string | null; alert_json: string | null; timings_json: string | null; source: Source; received_at: string; synthetic: number;
  second_opinion: 'pending' | 'running' | 'done' | null; second_opinion_json: string | null;
};
type ActivityRow = { rid: number; lead_id: string; stage: string; started_at: string; ok: number; note: string | null };

function loadLeads(ctx: Ctx): Lead[] {
  const rows = ctx.db.prepare(`SELECT l.id, l.status, l.tier, l.segment, l.route_action, l.route_team, l.owner, l.sla_due_at, l.time_to_route_ms,
      l.account_id, l.duplicate_of, l.is_disposable, l.first_name, l.last_name, l.email, l.title, l.company_name_raw, l.created_at, l.updated_at,
      l.resolution_json, l.qualification_json, l.route_json, l.crm_json, l.alert_json, l.timings_json, l.second_opinion, l.second_opinion_json,
      e.source, e.received_at, e.synthetic
    FROM leads l JOIN lead_events e ON e.id = l.id ORDER BY e.received_at, l.created_at`).all() as LeadRow[];
  return rows.map(r => ({
    id: r.id, status: r.status, tier: r.tier ?? null, segment: r.segment ?? null, action: r.route_action ?? null, team: r.route_team ?? null,
    owner: r.owner ?? null, slaDueAt: r.sla_due_at ?? null, ttr: typeof r.time_to_route_ms === 'number' ? r.time_to_route_ms : null,
    accountId: r.account_id ?? null, duplicateOf: r.duplicate_of ?? null, isDisposable: !!r.is_disposable,
    source: r.source, receivedAt: r.received_at, createdAt: r.created_at ?? null, updatedAt: r.updated_at ?? null, synthetic: !!r.synthetic,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || null, title: r.title ?? null, companyRaw: r.company_name_raw ?? null,
    res: parse(r.resolution_json), qual: parse(r.qualification_json), route: parse(r.route_json), crm: parse(r.crm_json), alert: parse(r.alert_json),
    timings: parse<Record<string, number>>(r.timings_json),
    secondOpinionState: r.second_opinion ?? null, secondOpinion: r.second_opinion === 'done' ? parse<StoredSecondOpinion>(r.second_opinion_json) : null,
  }));
}

const isMatched = (l: Lead) => l.res?.status === 'resolved' && !!l.accountId;
const alertSent = (l: Lead) => !!l.alert?.slack && !l.alert?.suppressed;
const suppressedRepeat = (l: Lead) => l.action === 'attach_to_existing' && !!l.route?.alertSuppressed;
/** The route waited for a model call (decision 19: only when it could change the team, unless MODEL_BEFORE_ROUTE=all). */
const modelCalled = (l: Lead) => !!l.qual && waitedForModel(l.qual);
/** A second opinion that finished with a result (an error stored instead is a bug in the worker, counted apart). */
const secondOpinionOf = (l: Lead): SecondOpinion | null => (l.secondOpinion && !('error' in l.secondOpinion) ? l.secondOpinion : null);
const processingMs = (l: Lead) => (l.ttr != null && typeof l.timings?.queued === 'number' ? Math.max(0, l.ttr - l.timings.queued) : null);
const marketOf = (seg: Segment | null) => (seg ? MARKETS.find(m => m.segments.includes(seg))?.id ?? 'other' : null);

/** Why a lead left the sales path, or null when it did not. */
function notForSalesReason(l: Lead): string | null {
  const dq = l.qual?.final?.disqualifier;
  switch (l.action) {
    case 'drop': return l.isDisposable ? 'disposable' : dq === 'spam' ? 'spam' : dq === 'vendor_pitch' ? 'vendor_pitch' : 'dropped';
    case 'careers': return 'job_seeker';
    case 'press': return 'press';
    case 'competitor_flag': return 'competitor';
    case 'nurture':
      if (l.route?.rule !== 'R4') return 'below_threshold';
      return l.segment === 'non_us' ? 'non_us' : 'student_academic';
    default: return null;
  }
}
const REASON_LABEL: Record<string, string> = {
  below_threshold: 'Below rep threshold (C, D)', job_seeker: 'Job seeker', press: 'Press inquiry', competitor: 'Competitor',
  spam: 'Spam', disposable: 'Disposable email', vendor_pitch: 'Vendor pitch', student_academic: 'Student or academic', non_us: 'Outside the US', dropped: 'Dropped',
};

/** HubSpot request plan entries by object and operation. */
function crmKind(path: string): string {
  if (path.includes('/companies/batch/upsert')) return 'companies_upsert';
  if (path.includes('/contacts/batch/upsert')) return 'contacts_upsert';
  if (path.includes('/associations/')) return 'association';
  if (path.includes('/objects/tasks')) return 'task_create';
  return 'other';
}
const CRM_KINDS: { id: string; object: string; op: string }[] = [
  { id: 'contacts_upsert', object: 'Contacts', op: 'batch upsert on email' },
  { id: 'companies_upsert', object: 'Companies', op: 'batch upsert on account key' },
  { id: 'association', object: 'Associations', op: 'contact to company' },
  { id: 'task_create', object: 'Tasks', op: 'create, due at the SLA' },
];

function readJsonFile<T>(path: string): T | null {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null; } catch { return null; }
}

/** Lines in out/hubspot/*.jsonl: the dry-run record, one line per planned request. */
function dryRunRecord(outDir: string): { files: number; lines: number } {
  const dir = join(outDir, 'hubspot');
  let files = 0, lines = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      files++;
      lines += readFileSync(join(dir, f), 'utf8').split('\n').filter(x => x.trim()).length;
    }
  } catch { /* no record yet */ }
  return { files, lines };
}

/** The last eval run in out/eval.json, scored against the gate floors in scripts/lib/eval-gate.ts. */
function evalSummary(outDir: string) {
  const e = readJsonFile<any>(join(outDir, 'eval.json'));
  if (!e || !Array.isArray(e.sets)) return { recorded: false as const };
  const withModel = Number(e.modelCalls ?? 0) > 0;
  const sets: SetCounts[] = e.sets.map((x: any) => ({
    name: x.name, n: x.n,
    v4: Object.fromEntries(['urgency', 'useCase', 'disqualifier'].map(f => [f, { ok: Number(x.fields?.[f]?.finalOk ?? NaN), n: Number(x.fields?.[f]?.finalN ?? NaN) }])),
  }));
  const valid = sets.map(s => ({ ...s, v4: Object.fromEntries(Object.entries(s.v4).filter(([, c]) => Number.isFinite(c.ok) && Number.isFinite(c.n))) })) as SetCounts[];
  const gate = evaluateGate(valid, withModel ? FLOORS : RULES_FLOORS);
  return {
    recorded: true as const, generatedAt: String(e.generatedAt ?? ''), model: withModel ? String(e.model ?? '') : null, combineVersion: String(e.combineVersion ?? ''),
    floors: withModel ? 'model' as const : 'rules' as const, pass: gate.pass, passed: gate.rows.filter(r => r.pass).length,
    rows: gate.rows.map(r => ({ set: r.set, field: r.field, ok: r.ok, n: r.n, floor: r.floor, pass: r.pass })),
  };
}

export function computeDashboard(ctx: Ctx, opts: { now?: number } = {}) {
  const now = opts.now ?? ctx.cfg.now();
  const db = ctx.db;
  const leads = loadLeads(ctx);
  const done = leads.filter(l => l.status === 'done');
  const byId = new Map(leads.map(l => [l.id, l]));
  const scorecard = computeScorecard(db, { now });
  const control = (id: string) => scorecard.controls.find(c => c.id === id);
  const metrics = computeMetrics(ctx);

  // ---- environment and data window --------------------------------------------------------------
  const hubspotMode: 'live' | 'dry_run' = ctx.cfg.hubspotLive && ctx.cfg.hubspotToken ? 'live' : 'dry_run';
  const people = leads.filter(l => l.source !== 'web_intent');
  const redeliveryRows = db.prepare(`SELECT e.source AS source, COUNT(*) AS n FROM stage_log s JOIN lead_events e ON e.id = s.lead_id WHERE s.stage = 'idempotent_replay' GROUP BY e.source`).all() as { source: string; n: number }[];
  const redeliveries = redeliveryRows.reduce((a, r) => a + Number(r.n), 0);
  const received = leads.map(l => l.receivedAt).filter(Boolean).sort();
  const processed = leads.map(l => l.updatedAt).filter((x): x is string => !!x).sort();
  const env = {
    hubspot: hubspotMode,
    model: {
      provider: ctx.cfg.llmProvider, name: ctx.cfg.llmProvider === 'ollama' ? ctx.cfg.ollamaModel : null, beforeRoute: ctx.cfg.modelBeforeRoute,
      called: leads.filter(modelCalled).length, answered: leads.filter(l => !!l.qual?.llm).length, secondOpinions: leads.filter(l => !!secondOpinionOf(l)).length,
    },
    registry: ctx.registry.kind,
    people: { total: people.length, synthetic: people.filter(l => l.synthetic).length },
    signedDoorsMissingKey: unkeyedSignedDoors(ctx.cfg).map(d => d.setting),
  };
  const dataWindow = {
    from: received[0] ?? null, to: received[received.length - 1] ?? null,
    processedFrom: leads.map(l => l.createdAt).filter((x): x is string => !!x).sort()[0] ?? null, processedTo: processed[processed.length - 1] ?? null,
    events: leads.length, redeliveries, webhooks: leads.length + redeliveries, leads: leads.length,
    doors: new Set(leads.map(l => l.source)).size, doorsTotal: SOURCES.length,
    // failed: given up after the last retry; a lead waiting for its next run (status retrying) is still in flight
    inFlight: leads.filter(l => l.status !== 'done' && l.status !== 'failed').length, failed: leads.filter(l => l.status === 'failed').length,
    retrying: leads.filter(l => l.status === 'retrying').length,
    afterHours: leads.filter(l => !isBusinessTime(Date.parse(l.receivedAt))).length, // Mon-Fri 09:00-18:00 ET, as src/time.ts defines business hours
    arrivals: leads.slice(-1000).map(l => ({ at: l.receivedAt, tier: l.tier, source: l.source })),
  };

  // ---- tiers, doors, markets -----------------------------------------------------------------------
  const tierKey = (l: Lead): Tier | 'pending' => (l.tier && ['A', 'B', 'C', 'D', 'X'].includes(l.tier) ? l.tier : 'pending');
  const doorRows = SOURCES.map(source => {
    const mine = leads.filter(l => l.source === source);
    const tiers = emptyTiers();
    for (const l of mine) tiers[tierKey(l)]++;
    return { source, motion: MOTIONS.find(m => m.doors.includes(source))!.id, total: mine.length, tiers };
  });
  const motions = MOTIONS.map(m => {
    const rows = doorRows.filter(d => d.motion === m.id);
    return { id: m.id, label: m.label, total: rows.reduce((a, d) => a + d.total, 0), salesReady: rows.reduce((a, d) => a + d.tiers.A + d.tiers.B, 0) };
  });
  const markets = MARKETS.map(m => {
    const mine = leads.filter(l => marketOf(l.segment) === m.id);
    const tiers = emptyTiers();
    const teams: Record<string, number> = {};
    for (const l of mine) { tiers[tierKey(l)]++; if (l.team) teams[l.team] = (teams[l.team] ?? 0) + 1; }
    return { id: m.id, label: m.label, segments: m.segments, total: mine.length, tiers, teams: Object.entries(teams).map(([team, n]) => ({ team, n })).sort((a, b) => b.n - a.n || a.team.localeCompare(b.team)) };
  });
  const unsegmented = leads.filter(l => !l.segment).length;

  // ---- funnel: each step is a subset of the one before, so it can never grow ------------------------------
  const sDry = hubspotMode === 'dry_run';
  const steps: { id: string; label: string; def: string; keep: (l: Lead) => boolean }[] = [
    { id: 'received', label: 'Received', def: 'Leads the doors accepted: first deliveries only.', keep: () => true },
    { id: 'matched', label: 'Matched to an organization', def: 'Resolved to an account on a stable key: AHRQ system, CMS CCN, payer, NPI or domain.', keep: isMatched },
    { id: 'qualified', label: 'Qualified', def: 'Matched, scored and not disqualified (tier A to D).', keep: l => !!l.tier && l.tier !== 'X' },
    { id: 'sales_ready', label: 'Sales-ready', def: 'Qualified and scored A or B.', keep: l => l.tier === 'A' || l.tier === 'B' },
    { id: 'assigned', label: 'Assigned to a rep or team', def: 'Sales-ready and routed to a rep, the account owner or a team queue (a repeat contact stays with its first owner).', keep: l => ASSIGNED_ROUTES.has(l.action ?? '') },
    { id: 'alerted', label: 'Alerted', def: 'Assigned and a Slack alert went to the rep or the team channel. A repeat contact inside 24 hours is attached without a new alert.', keep: alertSent },
    { id: 'synced', label: sDry ? 'HubSpot sync planned' : 'Synced to HubSpot', def: sDry ? 'Alerted, and the HubSpot requests for it were built and recorded (dry-run: nothing is sent).' : 'Alerted, and every HubSpot request for it answered 2xx.', keep: l => (l.crm?.requests?.length ?? 0) > 0 && (l.crm?.mode !== 'live' || l.crm?.ok === true) },
  ];
  let pool = leads;
  const funnel = steps.map((s, i) => {
    const prev = pool.length;
    pool = pool.filter(s.keep);
    return { id: s.id, label: s.label, def: s.def, n: pool.length, pctOfFirst: share(pool.length, leads.length), pctOfPrev: i === 0 ? null : share(pool.length, prev) };
  });

  // ---- not for sales ------------------------------------------------------------------------------
  const reasons: Record<string, number> = {};
  for (const l of leads) { const r = notForSalesReason(l); if (r) reasons[r] = (reasons[r] ?? 0) + 1; }
  const notForSales = {
    total: Object.values(reasons).reduce((a, n) => a + n, 0),
    nurture: reasons.below_threshold ?? 0,
    reasons: Object.entries(reasons).map(([id, n]) => ({ id, label: REASON_LABEL[id] ?? id, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
  };

  // ---- speed ------------------------------------------------------------------------------------------
  const timed = done.filter(l => l.timings && typeof l.timings.queued === 'number' && l.ttr != null);
  const queue = timed.map(l => l.timings!.queued);
  const processing = timed.map(l => processingMs(l)!).filter(x => x != null);
  const routeTotal = timed.map(l => l.ttr!);
  const stageRows = db.prepare(`SELECT stage, ms FROM stage_log WHERE ok = 1 AND stage IN (${STAGES.map(s => `'${s}'`).join(',')})`).all() as { stage: string; ms: number }[];
  const stageSpread = STAGES.map(stage => ({ stage, ...spread(stageRows.filter(r => r.stage === stage).map(r => Number(r.ms))) }));
  const modelLeads = leads.filter(modelCalled);
  const timedSet = new Set(timed);
  const speedFor = (rows: Lead[]) => {
    const t = rows.filter(l => timedSet.has(l));
    return { n: t.length, processingP50: percentile(t.map(l => processingMs(l)!), 50), queueP50: percentile(t.map(l => l.timings!.queued), 50), routeP50: percentile(t.map(l => l.ttr!), 50) };
  };
  // time to alert: the 202 to the alert on a sales route (a rep, the account owner or a team queue), which is what a rep feels
  const alertedSales = done.filter(l => SALES_ROUTES.has(l.action ?? '') && alertSent(l) && typeof l.timings?.alerted === 'number');
  const opinions = leads.map(secondOpinionOf).filter((o): o is SecondOpinion => !!o);
  const speed = {
    processing: spread(processing), queue: spread(queue), timeToRoute: spread(routeTotal),
    timeToAlert: spread(alertedSales.map(l => l.timings!.alerted)),
    stages: stageSpread,
    // the model call a route waited for
    model: modelLeads.length ? { ...spread(modelLeads.map(l => Number(l.qual.latencyMs ?? 0))), answered: modelLeads.filter(l => !!l.qual?.llm).length } : null,
    // the same call after the alert, off the path, for leads routed on the rules
    secondOpinion: {
      due: leads.filter(l => l.secondOpinionState === 'pending' || l.secondOpinionState === 'running').length,
      ran: opinions.length,
      answered: opinions.filter(o => o.answered).length,
      agreed: opinions.filter(o => o.agreed).length,
      changed: opinions.filter(o => o.changed.length > 0).length,
      roleFilled: opinions.filter(o => !!o.roleFilled).length,
      doubts: opinions.filter(o => !!o.doubt).length,
      followedUp: opinions.filter(o => o.followedUp).length,
      ...spread(opinions.filter(o => o.answered).map(o => o.latencyMs)),
      afterAlert: spread(opinions.map(o => o.afterAlertMs).filter((x): x is number => x != null)),
    },
    byDoor: SOURCES.map(source => ({ source, ...speedFor(leads.filter(l => l.source === source)) })).filter(r => r.n > 0),
    byMarket: MARKETS.map(m => ({ id: m.id, label: m.label, ...speedFor(leads.filter(l => marketOf(l.segment) === m.id)) })).filter(r => r.n > 0),
  };

  // ---- SLA (lead's own clock: received_at + the time the alert went out against sla_due_at) ---------------------------------------
  const salesReady = leads.filter(l => (l.tier === 'A' || l.tier === 'B') && (SALES_ROUTES.has(l.action ?? '') || l.action === 'attach_to_existing'));
  const slaRows = salesReady.filter(l => !suppressedRepeat(l) && l.status === 'done');
  // The alert goes out before the HubSpot write, so its time is timings.alerted. Leads stored before that was recorded fall back to the whole run.
  const alertedMs = (l: Lead) => (typeof l.timings?.alerted === 'number' ? l.timings.alerted : typeof l.timings?.total === 'number' ? l.timings.total : null);
  const alertAt = (l: Lead) => (alertedMs(l) != null ? Date.parse(l.receivedAt) + alertedMs(l)! : null);
  const within = (l: Lead) => alertSent(l) && !!l.slaDueAt && alertAt(l) != null && alertAt(l)! <= Date.parse(l.slaDueAt);
  const late = (l: Lead) => alertSent(l) && !!l.slaDueAt && alertAt(l) != null && alertAt(l)! > Date.parse(l.slaDueAt);
  const missed = (l: Lead) => !alertSent(l);
  const failedReady = leads.filter(l => l.status === 'failed' && (l.tier === 'A' || l.tier === 'B'));
  const aRows = slaRows.filter(l => l.tier === 'A');
  const upcoming = slaRows.map(l => l.slaDueAt).filter((d): d is string => !!d && Date.parse(d) > now).sort();
  const sla = {
    salesReady: { routed: slaRows.length, within: slaRows.filter(within).length, late: slaRows.filter(late).length, notAlerted: slaRows.filter(missed).length, attachedQuietly: salesReady.filter(suppressedRepeat).length },
    aTier: { routed: aRows.length, within: aRows.filter(within).length, late: aRows.filter(late).length, notAlerted: aRows.filter(missed).length },
    atRisk: slaRows.filter(l => late(l) || missed(l)).length + failedReady.length,
    nextDueAt: upcoming[0] ?? null,
    // SLA clocks still running on this server's clock: the router cannot see the rep's follow-up, so these are deadlines, not misses
    open: slaRows.filter(l => !!l.slaDueAt && Date.parse(l.slaDueAt) > now).sort((a, b) => a.slaDueAt!.localeCompare(b.slaDueAt!)).slice(0, 6)
      .map(l => ({ leadId: l.id, name: l.name, org: l.res?.accountName ?? l.companyRaw ?? null, tier: l.tier, owner: l.owner, team: l.team, action: l.action, dueAt: l.slaDueAt })),
    openCount: slaRows.filter(l => !!l.slaDueAt && Date.parse(l.slaDueAt) > now).length,
  };

  // ---- matching ---------------------------------------------------------------------------------------------
  const reached = leads.filter(l => !!l.res);
  const methods: Record<string, { n: number; high: number; medium: number; low: number }> = {};
  const keyKinds: Record<string, number> = {};
  for (const l of reached.filter(isMatched)) {
    const m = (methods[l.res.method] ??= { n: 0, high: 0, medium: 0, low: 0 });
    m.n++;
    if (l.res.confidence === 'high' || l.res.confidence === 'medium' || l.res.confidence === 'low') m[l.res.confidence as 'high' | 'medium' | 'low']++;
    const kind = String(l.accountId).split(':')[0];
    keyKinds[kind] = (keyKinds[kind] ?? 0) + 1;
  }
  const matched = reached.filter(isMatched).length;
  const matching = {
    reached: reached.length, matched, pct: share(matched, reached.length),
    ambiguous: reached.filter(l => l.res.status === 'ambiguous').length, unresolved: reached.filter(l => l.res.status === 'unresolved').length,
    methods: Object.entries(methods).map(([method, v]) => ({ method, ...v })).sort((a, b) => b.n - a.n || a.method.localeCompare(b.method)),
    keyKinds: Object.entries(keyKinds).map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n || a.kind.localeCompare(b.kind)),
    held: leads.filter(l => l.action === 'review').length,
    // a lead the router could not place but still sent to a rep or a team on tier alone: R6 exists so this stays 0
    guessed: reached.filter(l => !isMatched(l) && SALES_ROUTES.has(l.action ?? '') && l.route?.rule !== 'R5').length,
  };

  // ---- review queue (wall clock: how long each item has waited for a person) -------------------------------------
  const reviewRows = db.prepare(`SELECT lead_id, reason, created_at FROM review_queue WHERE resolved = 0 ORDER BY created_at, id`).all() as { lead_id: string; reason: string; created_at: string }[];
  const review = reviewRows.map(r => {
    const l = byId.get(r.lead_id);
    return {
      leadId: r.lead_id, reason: r.reason, createdAt: r.created_at, waitMs: Math.max(0, now - Date.parse(r.created_at)),
      name: l?.name ?? null, title: l?.title ?? null, company: l?.companyRaw ?? null, tier: l?.tier ?? null, source: l?.source ?? null,
    };
  });

  // ---- reps and queues (owners.json); load is the router's own rolling 24 hours before the newest lead -------------------
  const anchor = dataWindow.to ? Date.parse(dataWindow.to) : now;
  const since24 = new Date(anchor - 86_400_000).toISOString();
  const claims = new Map((db.prepare(`SELECT owner, COUNT(*) AS n FROM accounts WHERE owner IS NOT NULL GROUP BY owner`).all() as { owner: string; n: number }[]).map(r => [r.owner, Number(r.n)]));
  const loads = new Map((db.prepare(`SELECT owner, COUNT(*) AS n FROM assignments WHERE at >= ? AND at <= ? GROUP BY owner`).all(since24, dataWindow.to ?? new Date(now).toISOString()) as { owner: string; n: number }[]).map(r => [r.owner, Number(r.n)]));
  const ownerRow = (name: string, team: string, kind: 'rep' | 'queue', capacity: number | null) => {
    const mine = leads.filter(l => l.owner === name);
    const alerted = mine.filter(l => alertSent(l) && alertedMs(l) != null);
    const next = mine.map(l => l.slaDueAt).filter((d): d is string => !!d && Date.parse(d) > now).sort()[0] ?? null;
    return {
      name, team, kind, assigned: mine.length, aTier: mine.filter(l => l.tier === 'A').length, claimed: claims.get(name) ?? 0,
      load24h: kind === 'rep' ? loads.get(name) ?? 0 : null, capacity, nextSlaDue: next, alertP50: percentile(alerted.map(l => alertedMs(l)!), 50),
    };
  };
  const reps = Object.entries(ctx.owners.teams).flatMap(([team, t]) => t.reps.map(r => ownerRow(r.name, team, 'rep', r.capacity)));
  const queues = [
    ...Object.keys(ctx.owners.teams).map(team => ownerRow(`${team} queue`, team, 'queue', null)),
    ...Object.entries(ctx.owners.queues).map(([team, q]) => ownerRow(q.owner, team, 'queue', null)),
  ];

  // ---- HubSpot: the request plan stored on each lead, the dry-run record, and the property catalog ----------------------
  const kinds: Record<string, { planned: number; failed: number; reused: number }> = Object.fromEntries(CRM_KINDS.map(k => [k.id, { planned: 0, failed: 0, reused: 0 }]));
  const lifecycle: Record<string, number> = {};
  const catalog = readJsonFile<{ contacts?: { name: string; label: string; description?: string }[]; companies?: { name: string; label: string; description?: string }[] }>(join(ctx.cfg.root, 'docs', 'hubspot-properties.json'));
  const filled = { contacts: new Map<string, number>(), companies: new Map<string, number>() };
  let contactUpserts = 0, companyUpserts = 0, leadsWritten = 0, leadsNotWritten = 0, liveLeads = 0, plannedDryRun = 0, sentLive = 0;
  let waiting = 0, dead = 0; // live leads whose plan is still in the outbox, and those whose delivery gave up
  for (const l of done) {
    const reqs: any[] = Array.isArray(l.crm?.requests) ? l.crm.requests : [];
    if (!l.crm) continue;
    if (reqs.length) leadsWritten++; else leadsNotWritten++;
    if (l.crm.mode === 'live') { liveLeads++; sentLive += reqs.length; } else plannedDryRun += reqs.length;
    if (l.crm.delivery === 'pending' || l.crm.delivery === 'retrying') waiting++;
    if (l.crm.delivery === 'dead') dead++;
    reqs.forEach((r, i) => {
      const k = crmKind(String(r.path ?? ''));
      const slot = (kinds[k] ??= { planned: 0, failed: 0, reused: 0 });
      slot.planned++;
      const resp = l.crm.mode === 'live' ? l.crm.responses?.[i] : null;
      if (resp?.reused) slot.reused++;
      else if ((resp && Number(resp.status) >= 300) || l.crm.delivery === 'dead') slot.failed++; // dead: delivery gave up, so no request was confirmed
      const props = r.body?.inputs?.[0]?.properties;
      if (k === 'contacts_upsert' && props) {
        contactUpserts++;
        const stage = props.lifecyclestage ?? 'not_set';
        lifecycle[stage] = (lifecycle[stage] ?? 0) + 1;
        for (const [p, v] of Object.entries(props)) if (v !== null && v !== undefined && v !== '') filled.contacts.set(p, (filled.contacts.get(p) ?? 0) + 1);
      }
      if (k === 'companies_upsert' && props) {
        companyUpserts++;
        for (const [p, v] of Object.entries(props)) if (v !== null && v !== undefined && v !== '') filled.companies.set(p, (filled.companies.get(p) ?? 0) + 1);
      }
    });
  }
  const planned = Object.values(kinds).reduce((a, k) => a + k.planned, 0);
  const record = dryRunRecord(ctx.cfg.outDir);
  const hubspot = {
    mode: hubspotMode, planned, failed: Object.values(kinds).reduce((a, k) => a + k.failed, 0), reused: Object.values(kinds).reduce((a, k) => a + k.reused, 0),
    leadsWritten, leadsNotWritten, liveLeads, plannedDryRun, sentLive, redeliveriesWithoutWrites: redeliveries, waiting, dead,
    requests: [...CRM_KINDS.map(k => ({ ...k, ...kinds[k.id] })), ...Object.entries(kinds).filter(([id]) => !CRM_KINDS.some(k => k.id === id)).map(([id, v]) => ({ id, object: id, op: '', ...v }))],
    record,
    lifecycle: ['salesqualifiedlead', 'marketingqualifiedlead', 'lead', 'not_set'].map(stage => ({ stage, n: lifecycle[stage] ?? 0 })).concat(Object.entries(lifecycle).filter(([s]) => !['salesqualifiedlead', 'marketingqualifiedlead', 'lead', 'not_set'].includes(s)).map(([stage, n]) => ({ stage, n }))),
    contactUpserts, companyUpserts,
    properties: [
      ...(catalog?.contacts ?? []).map(p => ({ object: 'contact' as const, name: p.name, label: p.label, writer: /reverse-etl/i.test(p.description ?? '') ? 'reverse_etl' as const : 'router' as const, written: filled.contacts.get(p.name) ?? 0, of: contactUpserts })),
      ...(catalog?.companies ?? []).map(p => ({ object: 'company' as const, name: p.name, label: p.label, writer: /reverse-etl/i.test(p.description ?? '') ? 'reverse_etl' as const : 'router' as const, written: filled.companies.get(p.name) ?? 0, of: companyUpserts })),
    ],
  };

  // ---- the path: one line per promise the router makes ------------------------------------------------------------
  const signedSources = Object.keys(SIGNED_DOORS);
  const signedChecked = leads.filter(l => signedSources.includes(l.source)).length + redeliveryRows.filter(r => signedSources.includes(r.source)).reduce((a, r) => a + Number(r.n), 0);
  const notLinked = control('repeat_not_linked')?.value ?? 0;
  const repeatAttached = control('repeat_attached')?.value ?? 0;
  const stageFailures = control('stage_failures')?.value ?? 0;
  const ev = evalSummary(ctx.cfg.outDir);
  const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  // Unmatched leads that were neither held for a person nor guessed into a sales route: disqualified (job seeker, vendor, spam) without needing an org.
  const ruledOut = reached.filter(l => !isMatched(l) && l.action !== 'review').length - matching.guessed;
  const path: { id: string; status: Status; label: string; fact: string; detail: string }[] = [
    env.signedDoorsMissingKey.length
      ? { id: 'webhooks', status: 'bad', label: 'Webhooks verified', fact: `${env.signedDoorsMissingKey.join(', ')} is not set, so the signed door answers 503`, detail: 'A signed door with no key refuses every request rather than accept unsigned traffic.' }
      : { id: 'webhooks', status: signedChecked ? 'ok' : 'idle', label: 'Webhooks verified', fact: signedChecked ? `${plural(signedChecked, 'signed delivery', 'signed deliveries')} passed the signature check` : 'No signed deliveries yet', detail: 'Calendly is the signed door: HMAC-SHA256 over the timestamp and body, five-minute tolerance, constant-time compare. A delivery that fails gets a 401 and nothing is stored, so rejects are not counted here.' },
    { id: 'duplicates', status: notLinked ? 'warn' : redeliveries + repeatAttached ? 'ok' : 'idle', label: 'Duplicates absorbed', fact: leads.length ? `${plural(redeliveries, 're-delivery', 're-deliveries')} answered without a new lead · ${plural(repeatAttached, 'repeat contact')} attached${notLinked ? ` · ${notLinked} not linked` : ''}` : 'No deliveries yet', detail: 'A re-delivered webhook (same source and event id) gets a 200 and does nothing. A contact seen in the last 30 days is attached to their first lead and keeps its owner.' },
    { id: 'matching', status: matching.guessed ? 'bad' : reached.length ? 'ok' : 'idle', label: 'Every lead matched, held or ruled out', fact: reached.length ? `${matched.toLocaleString('en-US')} on a stable ID · ${matching.held} held for a person · ${ruledOut} ruled out · ${matching.guessed} guessed` : 'No leads yet', detail: 'Guessed: a lead that matched no organization but was still sent to a rep or a team on its score. Rule R6 holds those for a person instead.' },
    { id: 'sla', status: sla.atRisk ? 'warn' : sla.salesReady.routed ? 'ok' : 'idle', label: 'Sales-ready leads alerted within SLA', fact: sla.salesReady.routed ? `${sla.salesReady.within} of ${sla.salesReady.routed} alerted inside their SLA${sla.atRisk ? ` · ${sla.atRisk} at risk` : ''}${sla.salesReady.attachedQuietly ? ` · ${sla.salesReady.attachedQuietly} repeat attached, no new alert` : ''}` : 'No sales-ready leads yet', detail: "Tier A or B leads routed to a rep, an owner or a team queue. Inside SLA: received time plus the measured time to the alert is no later than the SLA due time. A repeat contact inside 24 hours is attached without a new alert and is not counted." },
    { id: 'hubspot', status: hubspot.failed ? 'bad' : waiting ? 'warn' : planned ? 'ok' : 'idle', label: 'HubSpot sync', fact: (!planned ? 'No CRM writes yet' : sentLive && plannedDryRun ? `${plural(sentLive, 'request')} sent live, ${plural(plannedDryRun, 'request')} planned in dry-run · ${hubspot.failed} failed` : sentLive ? `${plural(sentLive, 'request')} sent live for ${plural(leadsWritten, 'lead')} · ${hubspot.failed} failed` : `${plural(planned, 'request')} planned for ${plural(leadsWritten, 'lead')} · ${hubspot.failed} failed · dry-run`) + (waiting ? ` · ${plural(waiting, 'lead')} waiting to send` : '') + (dead ? ` · ${plural(dead, 'lead')} gave up` : ''), detail: 'Dry-run: each request is built exactly as it would be sent, stored on the lead and appended to out/hubspot/; nothing reaches HubSpot. Live: each lead\'s plan goes to an outbox and is sent in order; a network error, a 429 or a 5xx is retried with backoff and gives up after the last attempt, and every response status is stored on the lead. Counted from the leads as they were processed.' },
    ev.recorded
      ? { id: 'eval', status: ev.pass ? 'ok' : 'bad', label: 'Classifier gate', fact: `${ev.pass ? `v${ev.combineVersion.replace(/^v/, '')} clears all ${ev.rows.length} floors` : `${ev.rows.length - ev.passed} of ${ev.rows.length} floors missed`} on the sealed and held-out sets${ev.floors === 'rules' ? ' (rules only)' : ''}`, detail: `Last run ${ev.generatedAt}${ev.model ? `, model ${ev.model}` : ', no model'}. Floors from scripts/lib/eval-gate.ts, applied to out/eval.json.` }
      : { id: 'eval', status: 'idle', label: 'Classifier gate', fact: 'No eval recorded yet', detail: '`npm run eval` scores the classifier and writes out/eval.json; the gate floors live in scripts/lib/eval-gate.ts.' },
  ];

  // ---- activity (wall clock, newest first) ------------------------------------------------------------------------
  const actRows = db.prepare(`SELECT rowid AS rid, lead_id, stage, started_at, ok, note FROM stage_log
      WHERE stage IN ('route', 'crm', 'notify', 'idempotent_replay', 'pipeline') OR ok = 0 ORDER BY started_at DESC, rowid DESC LIMIT 600`).all() as ActivityRow[];
  const activity: any[] = [];
  for (const r of actRows) {
    if (activity.length >= 30) break;
    const l = byId.get(r.lead_id);
    if (!l) continue;
    const base = { at: r.started_at, leadId: l.id, person: l.source === 'web_intent' ? null : l.name, org: l.res?.accountName ?? l.companyRaw ?? null, tier: l.tier, source: l.source, owner: l.owner, team: l.team, action: l.action };
    if (!r.ok) { activity.push({ ...base, kind: 'failed', stage: r.stage, note: r.note }); continue; }
    if (r.stage === 'idempotent_replay') activity.push({ ...base, kind: 'duplicate' });
    else if (r.stage === 'crm') { const n = l.crm?.requests?.length ?? 0; if (n) activity.push({ ...base, kind: 'crm', requests: n, mode: l.crm.mode }); }
    else if (r.stage === 'notify') { if (alertSent(l)) activity.push({ ...base, kind: 'alerted', channel: l.alert.slack.channel ?? null }); }
    else if (r.stage === 'route' && !(alertSent(l) && l.status === 'done')) {
      const kind = l.action === 'review' ? 'review' : l.action === 'nurture' ? 'nurture' : l.action === 'account_signal' ? 'signal'
        : l.action === 'attach_to_existing' ? 'attached' : ['drop', 'careers', 'press', 'competitor_flag'].includes(l.action ?? '') ? 'not_for_sales' : 'routed';
      activity.push({ ...base, kind, reason: kind === 'not_for_sales' ? REASON_LABEL[notForSalesReason(l) ?? ''] ?? null : null });
    }
  }

  // ---- headline tiles ---------------------------------------------------------------------------------------------
  const ready = funnel.find(f => f.id === 'sales_ready')!.n;
  const readyLeads = leads.filter(l => isMatched(l) && (l.tier === 'A' || l.tier === 'B'));
  const oldest = review[0] ?? null;
  const kpis = {
    leadsIn: { value: leads.length, doors: dataWindow.doors, webhooks: dataWindow.webhooks },
    salesReady: { value: ready, pct: share(ready, leads.length), a: readyLeads.filter(l => l.tier === 'A').length, b: readyLeads.filter(l => l.tier === 'B').length, heldForPerson: leads.filter(l => (l.tier === 'A' || l.tier === 'B') && l.action === 'review').length },
    timeToRoute: { processingP50: speed.processing.p50, processingP90: speed.processing.p90, queueP50: speed.queue.p50, queueP90: speed.queue.p90, totalP50: speed.timeToRoute.p50, totalP90: speed.timeToRoute.p90, n: speed.processing.n },
    timeToAlert: { p50: speed.timeToAlert.p50, p90: speed.timeToAlert.p90, n: speed.timeToAlert.n },
    sla: { aRouted: sla.aTier.routed, aWithin: sla.aTier.within, atRisk: sla.atRisk, nextDueAt: sla.nextDueAt },
    matched: { pct: matching.pct, matched, of: reached.length, topMethods: matching.methods.slice(0, 3).map(m => ({ method: m.method, n: m.n })), otherMethods: matching.methods.slice(3).reduce((a, m) => a + m.n, 0) },
    needsPerson: { open: review.length, oldestWaitMs: oldest?.waitMs ?? null, oldestSince: oldest?.createdAt ?? null },
  };

  return {
    generatedAt: new Date(now).toISOString(),
    empty: leads.length === 0,
    env, window: dataWindow, path, kpis,
    motions, doors: doorRows, funnel, markets, unsegmented, notForSales,
    speed, sla, reps, queues,
    hubspot, matching, hygiene: metrics.hygiene, stageFailures,
    activity, review,
    eval: ev,
  };
}

export type Dashboard = ReturnType<typeof computeDashboard>;
