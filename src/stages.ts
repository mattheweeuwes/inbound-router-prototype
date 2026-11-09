// The seven stages of a run, in order: normalize, resolve, qualify, score, route, notify, crm.
// Each takes what the earlier stages produced, writes its result on the lead in one UPDATE, announces the new status on
// the bus for the cockpit, and returns what the later stages need. Every stage is timed into stage_log and run.timings.
// Decisions that need no database are in src/decisions.ts; the SQL is in src/store.
import { buildBrief, type Brief } from './brief';
import type { Ctx } from './context';
import { json } from './db';
import {
  accountIds, accountIntent, assignsRep, claimDetail, claimsAccount, DAY, DEDUPE_DAYS, hubspotOwnerIdOf, pickRoundRobin,
  reviewReason, summarizeTouches, wantsSlackAlert, webIntentDetail, webIntentPoints, type PriorTouch, type StoredAlert, type TouchSummary,
} from './decisions';
import { crmMode, planCrm, recordDryRun } from './crm/hubspot';
import { enqueuePlan, type CrmRecord } from './crm/outbox';
import { crmIdentity, matchMirror } from './mirror';
import { normalizeEvent } from './normalize';
import { buildSlackPayload, recordSlack } from './notify/slack';
import { qualify } from './qualify';
import { inferEmployer, resolve } from './resolve';
import { registryLookups } from './resolve/domain';
import { afterHours, decideRoute, type Rep } from './route';
import type { CrmMirrorEntry, LeadEvent, Normalized, Qualification, Resolution, Route, Score, Team } from './schema';
import { scoreLead } from './score';
import type { NormalizedColumns } from './store/leads';

/** The pipeline stages, in order, as stage_log names them. */
export const STAGES = ['normalize', 'resolve', 'qualify', 'score', 'route', 'notify', 'crm'] as const;
export type Stage = typeof STAGES[number];

/** One run of one lead. t0 is when the lead was accepted (the 202): time to route is measured from there. */
export interface Run {
  ctx: Ctx;
  id: string;
  ev: LeadEvent;
  t0: number;
  /** milliseconds per stage, plus queued (the wait before the run started), alerted and total */
  timings: Record<string, number>;
  /** known once scored and routed, and carried on every later status event */
  tier?: string;
  routeAction?: string;
}

const nowIso = (ctx: Ctx) => new Date(ctx.cfg.now()).toISOString();

/** The live 'lead' event the cockpit listens to: the id and the new status, plus the tier and route once they are known. */
function announce(run: Run, status: string) {
  run.ctx.bus.emit('lead', { id: run.id, status, ...(run.tier ? { tier: run.tier } : {}), ...(run.routeAction ? { routeAction: run.routeAction } : {}) });
}

/** Runs a stage, records its time (or its error) in stage_log and run.timings, and rethrows a failure. */
async function timed<T>(run: Run, stage: Stage, fn: () => Promise<T> | T): Promise<T> {
  const startedAt = nowIso(run.ctx);
  const t = performance.now();
  const log = (ok: boolean, note: string | null) => {
    const ms = Math.round(performance.now() - t);
    run.ctx.store.stages.log({ leadId: run.id, stage, startedAt, ms, ok, note });
    return ms;
  };
  try {
    const out = await fn();
    run.timings[stage] = log(true, null);
    return out;
  } catch (e) {
    log(false, (e as Error).message.slice(0, 300));
    throw e;
  }
}

// ---- normalize -----------------------------------------------------------------------------------------------------

export interface Normalize { n: Normalized; touches: TouchSummary }

export function normalizeStage(run: Run): Promise<Normalize> {
  return timed(run, 'normalize', () => {
    const { ctx, id, ev } = run;
    const n = normalizeEvent(ev, registryLookups(ctx.db));
    const touches = n.contactKey ? summarizeTouches(priorTouches(ctx, id, n.contactKey, ev.receivedAt)) : { duplicate: null, priorTouches: 0 };
    ctx.store.leads.markNormalized(id, nowIso(ctx), normalizedColumns(n, touches.duplicate?.leadId ?? null));
    announce(run, 'normalized');
    return { n, touches };
  });
}

/** Finished leads from the same contact in the dedupe window before this one, oldest first. */
function priorTouches(ctx: Ctx, id: string, contactKey: string, receivedAt: string): PriorTouch[] {
  const since = new Date(Date.parse(receivedAt) - DEDUPE_DAYS * DAY).toISOString();
  return ctx.store.leads.priorTouches(contactKey, id, receivedAt, since).map(r => ({
    id: r.id, owner: r.owner ?? '', team: r.route_team as Team, action: r.route_action as PriorTouch['action'],
    alert: r.alert_json ? (JSON.parse(r.alert_json) as StoredAlert) : null, receivedAt: r.received_at,
  }));
}

function normalizedColumns(n: Normalized, duplicateOf: string | null): NormalizedColumns {
  return {
    email: n.email, email_domain: n.emailDomain, is_free_mail: n.isFreeMail ? 1 : 0, is_disposable: n.isDisposable ? 1 : 0,
    first_name: n.firstName, last_name: n.lastName, title: n.title, title_function: n.titleFunction, title_seniority: n.titleSeniority,
    company_name_raw: n.companyRaw, company_domain: n.companyDomain, state: n.state, country: n.country, message: n.message,
    utm_source: n.utm.source ?? null, utm_medium: n.utm.medium ?? null, utm_campaign: n.utm.campaign ?? null, utm_content: n.utm.content ?? null, utm_term: n.utm.term ?? null,
    channel: n.channel, landing_page: n.landingPage, referrer: n.referrer, contact_key: n.contactKey, duplicate_of: duplicateOf,
    normalized_json: json(n),
  };
}

// ---- resolve -------------------------------------------------------------------------------------------------------

export async function resolveStage(run: Run, n: Normalized): Promise<Resolution> {
  const { ctx, id, ev } = run;
  // an account in the CRM that no public registry knows keeps the CRM record's identity and segment (before anything stores or scores it)
  const res = await timed(run, 'resolve', async () => crmIdentity(await resolve(ctx, ev, n), n, ctx.mirror));
  saveAccount(ctx, res, n, ev.receivedAt);
  ctx.store.leads.markResolved(id, nowIso(ctx), json(res), res.accountId, res.segment);
  announce(run, 'resolved');
  return res;
}

/** Creates or refreshes the resolved account. Its owner is never set here; only a claim sets it. */
function saveAccount(ctx: Ctx, res: Resolution, n: Normalized, at: string) {
  if (!res.accountId) return;
  ctx.store.accounts.upsert({
    id: res.accountId, name: res.accountName, segment: res.segment, subsegment: res.subsegment, domain: n.companyDomain,
    idsJson: json(accountIds(res.accountId, res.firmographics)), firmographicsJson: json(res.firmographics), at,
  });
}

// ---- qualify -------------------------------------------------------------------------------------------------------

export interface Qualify { qual: Qualification; res: Resolution }

/** Classifies the lead, then lets the use case refine an unplaced resolution (a benefits contact at an unknown company). */
export async function qualifyStage(run: Run, n: Normalized, resolved: Resolution): Promise<Qualify> {
  const { ctx, id, ev } = run;
  const qual = await timed(run, 'qualify', () => qualify(ctx, ev, n, resolved));
  const res = inferEmployer(resolved, n, qual.final.useCase);
  if (res !== resolved) saveAccount(ctx, res, n, ev.receivedAt);
  ctx.store.leads.markQualified(id, nowIso(ctx), json(qual), json(res), res.segment);
  announce(run, 'qualified');
  return { qual, res };
}

// ---- score ---------------------------------------------------------------------------------------------------------

export interface Scored { n: Normalized; res: Resolution; qual: Qualification; touches: TouchSummary }

export function scoreStage(run: Run, i: Scored): Promise<Score> {
  return timed(run, 'score', () => {
    const { ctx, id, ev } = run;
    const intent = accountIntentFor(run, i.n, i.res);
    const s = scoreLead({ ev, n: i.n, res: i.res, final: i.qual.final, priorTouches: i.touches.priorTouches, accountIntent: intent.points, accountIntentNote: intent.note });
    ctx.store.leads.markScored(id, nowIso(ctx), json(s), s.total, s.tier);
    run.tier = s.tier;
    announce(run, 'scored');
    return s;
  });
}

/** Web intent and other contacts at the same account in the 30 days before this lead. A web-intent lead earns none from itself. */
function accountIntentFor(run: Run, n: Normalized, res: Resolution): { points: number; note: string } {
  const { ctx, id, ev } = run;
  if (!res.accountId || ev.source === 'web_intent') return { points: 0, note: '' };
  const since = new Date(Date.parse(ev.receivedAt) - DEDUPE_DAYS * DAY).toISOString();
  const web = ctx.store.accounts.webIntentSignalsBetween(res.accountId, since, ev.receivedAt);
  const others = ctx.store.leads.otherContactsAt(res.accountId, id, n.contactKey, since, ev.receivedAt);
  return accountIntent(web, others);
}

// ---- route ---------------------------------------------------------------------------------------------------------

export interface RouteInputs extends Scored { score: Score }
export interface Routed { route: Route; /** the rep whose alert claimed the account on this lead, if any */ claimed: string | null; ttr: number }

export function routeStage(run: Run, i: RouteInputs): Promise<Routed> {
  return timed(run, 'route', () => {
    const { ctx, id, ev } = run;
    const mirror = matchMirror(ctx.mirror, i.n.companyDomain, i.res.accountName);
    const claimedOwner = i.res.accountId ? ctx.store.accounts.claimedOwner(i.res.accountId) : null;
    const route = decideRoute({
      ev, n: i.n, res: i.res, qual: i.qual, score: i.score, mirror, claimedOwner, owners: ctx.owners, duplicate: i.touches.duplicate,
      pickRep: team => pickRep(ctx, team, ev.receivedAt),
    });
    const claimed = recordAssignment(run, route, i, claimedOwner, mirror);
    if (route.action === 'review') ctx.store.accounts.addReview(id, reviewReason(i.qual, i.res), json(i.res.candidates.slice(0, 5)), nowIso(ctx));
    if (route.action === 'account_signal' && i.res.accountId) recordWebIntent(run, i.res.accountId);
    const ttr = ctx.cfg.now() - run.t0;
    ctx.store.leads.markRouted(id, nowIso(ctx), { route_json: json(route), route_action: route.action, route_team: route.team, owner: route.owner, sla_due_at: route.slaDueAt, time_to_route_ms: ttr });
    run.routeAction = route.action;
    announce(run, 'routed');
    return { route, claimed, ttr };
  });
}

/** Round-robin inside a team, from the assignments table (the last 24 hours count toward capacity). */
function pickRep(ctx: Ctx, team: Team, atIso: string): Rep | null {
  const reps = ctx.owners.teams[team]?.reps ?? [];
  if (!reps.length) return null;
  const since = new Date(Date.parse(atIso) - DAY).toISOString();
  const activity = new Map(ctx.store.accounts.repActivity(reps.map(r => r.name), since).map(a => [a.owner, { last: a.last, load: Number(a.load) }]));
  return pickRoundRobin(reps, activity);
}

/** Records the rep assignment of a rep alert and, when this alert claims the account, the claim, in one transaction. Returns the claiming rep. */
function recordAssignment(run: Run, route: Route, i: RouteInputs, claimedOwner: string | null, mirror: CrmMirrorEntry | null): string | null {
  if (!assignsRep(route)) return null;
  const { ctx, id, ev } = run;
  const accountId = i.res.accountId;
  const claim = accountId && claimsAccount({ route, owners: ctx.owners, accountId, claimedOwner, mirror, source: ev.source })
    ? { accountId, owner: route.owner, signalDetail: claimDetail(route.owner, i.n) }
    : null;
  return ctx.store.accounts.assign({ owner: route.owner, team: route.team, leadId: id, at: ev.receivedAt }, claim) ? route.owner : null;
}

function recordWebIntent(run: Run, accountId: string) {
  const { ctx, id, ev } = run;
  const signals = ctx.store.accounts.addWebIntentSignal(accountId, id, webIntentDetail(ev.context), ev.receivedAt);
  ctx.store.accounts.setIntentPoints(accountId, webIntentPoints(signals));
}

// ---- notify --------------------------------------------------------------------------------------------------------

export interface NotifyInputs extends RouteInputs { routed: Routed }

/**
 * Builds and records the Slack alert. It goes out before the HubSpot write, so Slack never waits on HubSpot: the payload is
 * built from the brief, the score and the route, and nothing in it comes from the CRM stage. Returns the brief for the CRM task.
 */
export async function notifyStage(run: Run, i: NotifyInputs): Promise<Brief> {
  const { ctx, id, ev } = run;
  const { route, ttr } = i.routed;
  const brief = buildBrief(ev, i.n, i.res, i.qual);
  await timed(run, 'notify', () => {
    const alert: StoredAlert = { slack: null, suppressed: route.alertSuppressed ?? false };
    if (wantsSlackAlert(route)) {
      alert.slack = buildSlackPayload({ brief, score: i.score, route, timeToRouteMs: ttr, synthetic: ev.synthetic, afterHours: afterHours(ev.receivedAt) });
      recordSlack(ctx, id, alert.slack, nowIso(ctx));
    }
    ctx.store.leads.markNotified(id, nowIso(ctx), json(alert));
    announce(run, 'notified');
  });
  run.timings.alerted = ctx.cfg.now() - run.t0; // when the alert was out, which is what the response-time clock measures
  return brief;
}

// ---- crm -----------------------------------------------------------------------------------------------------------

export interface CrmInputs extends NotifyInputs { brief: Brief }

/**
 * Plans the HubSpot requests and stores them. Dry-run records them to out/hubspot/ and is finished. Live stores the plan
 * in the outbox for the delivery worker and returns true; nothing here touches the network.
 */
export function crmStage(run: Run, i: CrmInputs): Promise<boolean> {
  return timed(run, 'crm', () => {
    const { ctx, id, ev } = run;
    const { route, claimed } = i.routed;
    const plan = planCrm({
      leadId: id, ev, n: i.n, res: i.res, qual: i.qual, score: i.score, route, isFirstTouch: !i.touches.duplicate,
      ownerId: hubspotOwnerIdOf(ctx.owners, route.owner), companyOwnerId: claimed ? hubspotOwnerIdOf(ctx.owners, claimed) : null, brief: i.brief.text,
    });
    let record: CrmRecord;
    if (crmMode(ctx.cfg) === 'dry_run') {
      recordDryRun(ctx, id, plan.requests, nowIso(ctx));
      record = { mode: 'dry_run', ...plan };
    } else {
      record = enqueuePlan(ctx, id, plan);
    }
    ctx.store.leads.markSynced(id, nowIso(ctx), json(record));
    announce(run, 'synced');
    return record.delivery === 'pending';
  });
}

// ---- done ----------------------------------------------------------------------------------------------------------

export function finishRun(run: Run) {
  const { ctx, id } = run;
  run.timings.total = ctx.cfg.now() - run.t0;
  ctx.store.leads.markDone(id, nowIso(ctx), json(run.timings));
  announce(run, 'done');
}
