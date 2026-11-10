// The model's second opinion on a lead that was routed and alerted on the rules (decision 19). A worker takes due leads one
// at a time, oldest first, outside the ordered section and only while no lead is waiting in it, and makes the same model call the route would have waited for,
// through the same combine and guard rails. It stores what the model said, whether the full combine agrees with the route,
// which fields it would have changed and the buying role it fills. A disqualifier only the model raised does not un-route
// the lead: on a route the old order would have changed (R5, R8) it opens a review item (model_doubt_after_alert) and sends
// a follow-up to where the alert went and to RevOps. The queue is the leads table itself (second_opinion = 'pending'), so a
// stopped process leaves nothing behind: boot asks again.
import { buildBrief } from './brief';
import type { Ctx } from './context';
import { json, parse, tx } from './db';
import { compareSecondOpinion, doubtNeedsFollowUp, type Doubt, type SecondOpinionFinding, type StoredAlert } from './decisions';
import { secondOpinionCall } from './modelPath';
import { buildDoubtFollowUp, recordSlack, type SlackPayload } from './notify/slack';
import { doubtAfterAlert } from './route';
import type { Classification, LeadEvent, Normalized, Qualification, Resolution, Route, Segment } from './schema';
import { adapt } from './sources';
import type { SecondOpinionInputRow } from './store/leads';

/** The stage_log name of a second opinion's row. It is not one of STAGES: it runs after the lead is done. */
export const SECOND_OPINION_STAGE = 'second_opinion';
/** The review_queue reason a doubt after the alert opens. */
export const DOUBT_REVIEW_REASON = 'model_doubt_after_alert';

/** leads.second_opinion_json once the second opinion is done. */
export interface SecondOpinion extends SecondOpinionFinding {
  at: string;
  provider: string;
  latencyMs: number;
  /** what the model said, or null when it gave no valid answer (fallbackReason says why) */
  llm: Classification | null;
  fallbackReason: string | null;
  /** ms from the alert to this answer, when the alert time is known */
  afterAlertMs: number | null;
  /** the organization type the model was shown: the resolution before the use case refined it, as before the route */
  shownSegment: Segment;
  /** a review item was opened and the follow-up sent */
  followedUp: boolean;
}

/** What second_opinion_json holds once done: the result, or the error that stopped the call (a bug, not a model failure; those are results). */
export type StoredSecondOpinion = SecondOpinion | { at: string; error: string };

interface WorkerState { pass: Promise<void> | null; again: boolean }
const workers = new WeakMap<Ctx, WorkerState>();
const worker = (ctx: Ctx) => {
  let w = workers.get(ctx);
  if (!w) workers.set(ctx, (w = { pass: null, again: false }));
  return w;
};

const nowIso = (ctx: Ctx) => new Date(ctx.cfg.now()).toISOString();

/** Starts a pass over the due second opinions unless one is running; a running pass picks up new ones as it goes. */
export function kickSecondOpinions(ctx: Ctx) {
  const w = worker(ctx);
  if (w.pass) { w.again = true; return; }
  w.again = false;
  w.pass = drain(ctx).finally(() => {
    w.pass = null;
    if (w.again) kickSecondOpinions(ctx);
  });
}

/** Resolves when no pass is running. */
export async function secondOpinionsIdle(ctx: Ctx): Promise<void> {
  const w = workers.get(ctx);
  while (w?.pass) await w.pass;
}

export const secondOpinionsBusy = (ctx: Ctx) => !!workers.get(ctx)?.pass;

/** Boot: second opinions a stopped process left due or in flight are asked again. */
export function resumeSecondOpinions(ctx: Ctx) {
  ctx.store.leads.requeueSecondOpinions();
  kickSecondOpinions(ctx);
}

/**
 * Asks due second opinions one at a time while no lead is waiting in the ordered section. A model call cannot be interrupted,
 * so one started during a burst would hold the next lead whose route needs the model for a whole call; the queue kicks the
 * worker again when it empties (src/pipeline.ts enqueue).
 */
async function drain(ctx: Ctx): Promise<void> {
  for (;;) {
    if (ctx.q.pending > 0) return;
    const id = ctx.store.leads.nextSecondOpinion();
    if (!id) return;
    if (!ctx.store.leads.claimSecondOpinion(id)) continue;
    await giveSecondOpinion(ctx, id);
  }
}

/** One second opinion. A failure is stored as the result, so the lead never stays in flight. */
async function giveSecondOpinion(ctx: Ctx, id: string) {
  const startedAt = nowIso(ctx);
  const t = performance.now();
  const log = (ok: boolean, note: string | null) => ctx.store.stages.log({ leadId: id, stage: SECOND_OPINION_STAGE, startedAt, ms: Math.round(performance.now() - t), ok, note });
  const row = ctx.store.leads.secondOpinionInput(id);
  if (!row) return; // the data was cleared (a replay reset) while it waited
  try {
    const lead = readLead(row);
    const result = await ask(ctx, lead);
    if (!settle(ctx, id, lead, result)) return; // re-run while the call was in flight: the new run decides
    log(true, result.doubt ? `doubt: ${result.doubt.disqualifier}` : result.agreed ? 'agreed' : result.answered ? `would change ${result.changed.join(', ')}` : result.fallbackReason);
    ctx.bus.emit('lead', { id, status: 'done', secondOpinion: result.doubt ? 'doubt' : result.agreed ? 'agreed' : result.answered ? 'differs' : 'no_answer' });
  } catch (e) {
    const error = (e as Error).message.slice(0, 300);
    const failed: StoredSecondOpinion = { at: nowIso(ctx), error };
    ctx.store.leads.saveSecondOpinion(id, failed.at, json(failed)!);
    log(false, error);
  }
}

/** What the worker needs from the stored lead: the inputs to the model call as the route had them, and what the route did. */
interface StoredLead {
  ev: LeadEvent; n: Normalized; res: Resolution; used: Qualification; route: Route; alert: StoredAlert | null;
  /** the organization type the model is shown: the resolution before the use case refined it */
  shownSegment: Segment;
  /** the alert's time on the server clock (epoch ms), when it is known */
  alertAt: number | null;
  synthetic: boolean;
}

function readLead(row: SecondOpinionInputRow): StoredLead {
  const ev = adapt(row.source, JSON.parse(row.raw_json), row.received_at);
  ev.receivedAt = row.received_at;
  const res = required<Resolution>(row.resolution_json, 'resolution');
  const alerted = parse<Record<string, number>>(row.timings_json)?.alerted;
  return {
    ev, n: required<Normalized>(row.normalized_json, 'normalized'), res, used: required<Qualification>(row.qualification_json, 'qualification'),
    route: required<Route>(row.route_json, 'route'), alert: parse<StoredAlert>(row.alert_json),
    shownSegment: parse<{ shownSegment: Segment }>(row.second_opinion_json)?.shownSegment ?? res.segment,
    alertAt: typeof alerted === 'number' ? Date.parse(row.created_at) + alerted : null,
    synthetic: !!row.synthetic,
  };
}

/** Makes the call the route would have waited for, and compares the answer with what the route used. */
async function ask(ctx: Ctx, lead: StoredLead): Promise<SecondOpinion> {
  const full = await secondOpinionCall(ctx, lead.ev, lead.n, { ...lead.res, segment: lead.shownSegment });
  return {
    at: nowIso(ctx), provider: full.provider, latencyMs: full.latencyMs, llm: full.llm, fallbackReason: full.fallbackReason,
    afterAlertMs: lead.alertAt == null ? null : Math.max(0, ctx.cfg.now() - lead.alertAt), shownSegment: lead.shownSegment,
    ...compareSecondOpinion(lead.used, full), followedUp: false,
  };
}

/**
 * Stores the result and, for a doubt on a route the old order would have changed, opens the review item and records the
 * follow-up, in one transaction. Returns false when the lead was re-run while the call was in flight; nothing is written then.
 */
function settle(ctx: Ctx, id: string, lead: StoredLead, result: SecondOpinion): boolean {
  const followUp = result.doubt && doubtNeedsFollowUp(lead.route) ? followUpPayloads(lead, result.doubt) : null;
  if (followUp) result.followedUp = true;
  const at = nowIso(ctx);
  const saved = tx(ctx.db, () => {
    if (!ctx.store.leads.saveSecondOpinion(id, at, json(result)!)) return false;
    if (followUp) {
      ctx.store.accounts.addReview(id, DOUBT_REVIEW_REASON, null, at);
      ctx.store.leads.addFollowUpAlerts(id, at, json(followUp)!);
    }
    return true;
  });
  if (saved && followUp) for (const p of followUp) recordSlack(ctx, id, p, at);
  return saved;
}

/** The follow-up to where the alert went (when one went out) and to RevOps, in the words of doubtAfterAlert. */
function followUpPayloads(lead: StoredLead, doubt: Doubt): SlackPayload[] {
  const brief = buildBrief(lead.ev, lead.n, lead.res, lead.used);
  const sentence = doubtAfterAlert(doubt, lead.route.owner);
  const alerted = lead.alert?.slack && !lead.alert.suppressed ? lead.alert.slack.channel : null;
  const channels = [...new Set([alerted, '#revops-review'].filter((c): c is string => !!c))];
  return channels.map(channel => buildDoubtFollowUp({ channel, person: brief.person, org: brief.org, sentence, quote: brief.quote, synthetic: lead.synthetic }));
}

function required<T>(text: string | null, what: string): T {
  const v = parse<T>(text);
  if (v == null) throw new Error(`the lead has no stored ${what} to give a second opinion on`);
  return v;
}
