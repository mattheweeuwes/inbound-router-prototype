// Ingest, the queue, and the runner: normalize -> resolve -> qualify -> score -> route -> notify -> crm (src/stages.ts).
// Prepare concurrently, commit in order. A lead's order-independent work (adapt, normalize, resolve, the rules and, when the
// route needs it, the model) starts as soon as it is accepted, a bounded number at a time. The ordered section takes one
// lead at a time, in the order they were accepted: it waits for that lead's prepared result, then does what depends on
// earlier leads (dedupe and prior touches, the account, score, route, round-robin and claim, alert, the CRM plan), so
// round-robin and dedupe never race. The HubSpot delivery runs outside it, in the outbox worker (src/crm/outbox.ts), and
// so does the model's second opinion on a lead alerted on the rules (src/secondOpinion.ts).
// Re-running a lead replaces its derived rows and the CRM writes upsert, but a re-run can repeat an alert; boot recovery
// and the failed-lead retry accept that.
// A run that throws is retried with backoff up to cfg.leadMaxAttempts; the last failure gives the lead up (status
// failed) and alerts RevOps through the same Slack recorder as every other alert.
import { randomUUID } from 'node:crypto';
import type { Ctx } from './context';
import { tx } from './db';
import { kickOutbox, outboxBusy, outboxIdle } from './crm/outbox';
import { Limiter } from './limiter';
import { buildFailureAlert, recordSlack } from './notify/slack';
import { nextAttempt, WakeUp } from './retry';
import type { LeadEvent } from './schema';
import { kickSecondOpinions, resumeSecondOpinions, secondOpinionsBusy, secondOpinionsIdle, SECOND_OPINION_STAGE } from './secondOpinion';
import {
  commitPrepared, crmStage, finishRun, logPrepared, notifyStage, prepareLead, routeStage, scoreStage, STAGES, type Prepared,
  type PrepareOutcome, type Run,
} from './stages';
import type { LeadInputRow } from './store/leads';

export interface IngestResult { leadId: string; duplicate: boolean }

const nowIso = (ctx: Ctx) => new Date(ctx.cfg.now()).toISOString();

export function ingest(ctx: Ctx, ev: LeadEvent): IngestResult {
  const existing = ctx.store.leads.eventLeadId(ev.source, ev.sourceEventId);
  if (existing) {
    // Idempotent replay: no new lead, no new work. Only a stage_log row so the cockpit can show it happened.
    ctx.store.stages.log({ leadId: existing, stage: 'idempotent_replay', startedAt: nowIso(ctx), ms: 0, ok: true, note: `duplicate delivery of ${ev.source}:${ev.sourceEventId}` });
    ctx.bus.emit('lead', { id: existing, status: 'idempotent_replay' });
    return { leadId: existing, duplicate: true };
  }
  const id = randomUUID();
  ctx.store.leads.accept({ id, source: ev.source, sourceEventId: ev.sourceEventId, receivedAt: ev.receivedAt, synthetic: ev.synthetic, rawJson: JSON.stringify(ev.raw), acceptedAt: nowIso(ctx) });
  ctx.bus.emit('lead', { id, status: 'received' });
  enqueue(ctx, id);
  return { leadId: id, duplicate: false };
}

export function enqueue(ctx: Ctx, leadId: string) {
  startPrepare(ctx, leadId);
  ctx.q.pending++;
  ctx.q.chain = ctx.q.chain.then(() => processLead(ctx, leadId)).catch(() => {}).finally(() => {
    // second opinions wait while leads are waiting, so a burst never queues a route's model call behind one
    if (--ctx.q.pending === 0) kickSecondOpinions(ctx);
  });
}

const prepareSlots = new WeakMap<Ctx, Limiter>();
const prepareLimiter = (ctx: Ctx) => {
  let l = prepareSlots.get(ctx);
  if (!l) prepareSlots.set(ctx, (l = new Limiter(ctx.cfg.prepareConcurrency)));
  return l;
};

/** Starts the lead's order-independent work now, at most cfg.prepareConcurrency at once, first accepted first. Its turn picks the result up. */
function startPrepare(ctx: Ctx, id: string) {
  const input = ctx.store.leads.input(id);
  if (input) ctx.q.prepared.set(id, prepareLimiter(ctx).run(() => prepareLead(ctx, input)));
}

/** The lead's prepared result: the one started at enqueue, or, when there is none, prepared now. */
function takePrepared(ctx: Ctx, id: string, input: LeadInputRow): Promise<PrepareOutcome> {
  const started = ctx.q.prepared.get(id);
  ctx.q.prepared.delete(id);
  return started ?? prepareLead(ctx, input);
}

/**
 * Resolves when the queue is empty and no HubSpot delivery pass or second opinion is running. Dry-run records and crm_json
 * are written by then; a live plan has had its first delivery attempt; every second opinion that was due has its answer.
 * Retries scheduled for later (a lead's or a delivery's) are not waited for.
 */
export async function whenIdle(ctx: Ctx) {
  for (;;) {
    if (ctx.q.pending > 0) await ctx.q.chain;
    else if (outboxBusy(ctx)) await outboxIdle(ctx);
    else if (secondOpinionsBusy(ctx)) await secondOpinionsIdle(ctx);
    else return;
  }
}

/**
 * Boot recovery: anything accepted (202) but not finished is processed again, in the order it was accepted. That includes
 * leads waiting for a retry, which run now rather than at their old time. Live HubSpot plans a stopped process left in the
 * outbox are delivered, and second opinions it left due or in flight are asked again. Returns the number of leads re-run.
 */
export function resumePending(ctx: Ctx): number {
  const ids = ctx.store.leads.unfinishedIds();
  for (const id of ids) enqueue(ctx, id);
  kickOutbox(ctx);
  resumeSecondOpinions(ctx);
  return ids.length;
}

/** One lead's turn in the ordered section. */
export async function processLead(ctx: Ctx, id: string): Promise<void> {
  const input = ctx.store.leads.input(id);
  if (!input) { ctx.q.prepared.delete(id); return; }
  const turnMs = ctx.cfg.now();
  const prepared = await takePrepared(ctx, id, input);
  const waitedMs = Math.max(0, ctx.cfg.now() - turnMs);
  try {
    wipeDerived(ctx, id);
    if (!prepared.ok) {
      logPrepared(ctx, id, prepared.records);
      throw prepared.error;
    }
    const p = prepared.value;
    const run = startRun(ctx, id, input, p, turnMs, waitedMs);
    const { n, res, qual, touches } = commitPrepared(run, p);
    const score = await scoreStage(run, { n, res, qual, touches });
    const routed = await routeStage(run, { n, res, qual, touches, score });
    const brief = await notifyStage(run, { n, res, qual, touches, score, routed });
    const planStored = await crmStage(run, { n, res, qual, touches, score, routed, brief });
    finishRun(run);
    if (planStored) kickOutbox(ctx);
  } catch (e) {
    recordFailure(ctx, id, input, e);
  }
}

/**
 * Time to route is measured from receipt (the 202), because that is what the prospect experiences. queued is the part spent
 * waiting for earlier leads in the ordered section; waitedForPrepare is the part this lead's turn then waited for its own
 * prepared result (a model call, a slow lookup).
 */
function startRun(ctx: Ctx, id: string, input: LeadInputRow, p: Prepared, turnMs: number, waitedMs: number): Run {
  const t0 = Date.parse(input.created_at);
  const timings: Record<string, number> = { queued: Math.max(0, turnMs - t0), prepared: p.readyMs, waitedForPrepare: waitedMs, prepare: p.workMs };
  if (p.timing === 'before_route' && p.qual.provider !== 'rules') timings.modelBeforeRoute = p.qual.latencyMs;
  return { ctx, id, ev: p.ev, t0, timings };
}

/**
 * Clears what an earlier run of this lead wrote outside its own row: the account it claimed (if still held by the rep it
 * named), its signals, assignment, review items, a HubSpot plan still waiting to go out, a second opinion due or done, and
 * the timings of its stages. Rows that record history (re-deliveries, failed runs, HubSpot delivery attempts) stay.
 */
function wipeDerived(ctx: Ctx, id: string) {
  tx(ctx.db, () => {
    ctx.store.accounts.releaseLead(id);
    ctx.store.outbox.dropPending(id);
    ctx.store.leads.clearSecondOpinion(id);
    ctx.store.stages.clear(id, [...STAGES, SECOND_OPINION_STAGE]);
  });
}

// ---- failed runs ---------------------------------------------------------------------------------------------------

/** Longest wait between runs. Three attempts at the default 5 s base never reach it; it bounds a raised leadMaxAttempts. */
const LEAD_RETRY_CAP_MS = 5 * 60_000;

const leadRetryTimers = new WeakMap<Ctx, WakeUp>();
const leadRetryTimer = (ctx: Ctx) => {
  let w = leadRetryTimers.get(ctx);
  if (!w) leadRetryTimers.set(ctx, (w = new WakeUp(() => retryDueLeads(ctx))));
  return w;
};

/**
 * A run threw. The lead is retried with backoff while it has attempts left (status retrying, which the dashboard counts
 * as in flight and boot recovery picks up). After the last one it is given up: status failed, and RevOps is alerted.
 */
function recordFailure(ctx: Ctx, id: string, input: LeadInputRow, e: unknown) {
  const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const at = nowIso(ctx);
  const attempts = input.attempts + 1;
  const max = ctx.cfg.leadMaxAttempts;
  ctx.store.stages.log({ leadId: id, stage: 'pipeline', startedAt: at, ms: 0, ok: false, note: `attempt ${attempts} of ${max}: ${error}` });
  const next = nextAttempt(attempts, { baseMs: ctx.cfg.leadRetryDelayMs, maxMs: LEAD_RETRY_CAP_MS, maxAttempts: max }, ctx.cfg.now());
  if (next.retry) {
    ctx.store.leads.markRetrying(id, at, attempts, next.atMs);
    ctx.bus.emit('lead', { id, status: 'retrying' });
    leadRetryTimer(ctx).at(next.atMs, ctx.cfg.now());
    return;
  }
  ctx.store.leads.markFailed(id, at, attempts);
  const alert = buildFailureAlert({ leadId: id, source: input.source, receivedAt: input.received_at, attempts, error, synthetic: !!input.synthetic });
  recordSlack(ctx, id, alert, at);
  ctx.store.leads.addFailureAlert(id, at, JSON.stringify(alert));
  ctx.bus.emit('lead', { id, status: 'failed' });
}

/** Queues every lead whose retry is due, and sets the timer for the next one. Returns how many were queued. */
export function retryDueLeads(ctx: Ctx): number {
  const now = ctx.cfg.now();
  const ids = ctx.store.leads.dueRetryIds(now);
  for (const id of ids) enqueue(ctx, id);
  const next = ctx.store.leads.nextRetryAfter(now);
  if (next != null) leadRetryTimer(ctx).at(next, now);
  return ids.length;
}
