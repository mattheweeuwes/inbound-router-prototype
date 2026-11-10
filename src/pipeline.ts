// Ingest, the queue, and the runner: normalize -> resolve -> qualify -> score -> route -> notify -> crm (src/stages.ts).
// Prepare concurrently, commit one at a time. A lead's order-independent work (adapt, normalize, resolve, the rules and, when
// the route needs it, the model) starts as soon as it is accepted; its lookups take one of a bounded number of slots, and a
// model call waits in the model's own slots (src/modelPath.ts), so a lead waiting for the model holds no lookup slot. The
// ordered section takes one lead at a time: it waits for that lead's prepared result, then does what depends on earlier
// leads (dedupe and prior touches, the account, score, route, round-robin and claim, alert, the CRM plan), so round-robin
// and dedupe never race. Which lead goes next is src/commitOrder.ts (decision 23): the order of acceptance, except that a
// lead still waiting for its prepared result after a short grace is passed by ready leads in other lanes (src/lanes.ts).
// Leads in one lane always commit in the order they were accepted. The HubSpot delivery runs outside the ordered section,
// in the outbox worker (src/crm/outbox.ts), and so do the model's second opinion on a lead alerted on the rules
// (src/secondOpinion.ts) and the list digests (src/listDigest.ts).
// Re-running a lead replaces its derived rows and the CRM writes upsert, but a re-run can repeat an alert; boot recovery
// and the failed-lead retry accept that.
// A run that throws is retried with backoff up to cfg.leadMaxAttempts; the last failure gives the lead up (status
// failed) and alerts RevOps through the same Slack recorder as every other alert.
import { randomUUID } from 'node:crypto';
import { nextCommit } from './commitOrder';
import type { Ctx } from './context';
import { tx } from './db';
import { kickOutbox, outboxBusy, outboxIdle } from './crm/outbox';
import { laneOf } from './lanes';
import { Limiter } from './limiter';
import { armListDigests } from './listDigest';
import { listNameOf } from './lists';
import { buildFailureAlert, recordSlack } from './notify/slack';
import { registryLookups } from './resolve/domain';
import { nextAttempt, WakeUp } from './retry';
import type { LeadEvent } from './schema';
import { kickSecondOpinions, resumeSecondOpinions, secondOpinionsBusy, secondOpinionsIdle, SECOND_OPINION_STAGE } from './secondOpinion';
import { adapt } from './sources';
import {
  commitPrepared, crmStage, finishRun, logPrepared, notifyStage, prepareLead, routeStage, scoreStage, STAGES, type Prepared,
  type PrepareOutcome, type Run, type Slot,
} from './stages';
import type { LeadInputRow } from './store/leads';

export interface IngestResult { leadId: string; duplicate: boolean }

/** An accepted lead waiting for its commit: its lane, its prepared work and whether that work has settled. */
export interface QueuedLead {
  id: string; lane: string; ready: boolean; outcome: Promise<PrepareOutcome> | null;
  /** when its prepared work settled, on the injected clock */
  readyAt: number | null;
}

/** The ordered section's state, owned by this file. */
export interface CommitQueue {
  /** accepted and not yet committing, in acceptance order */
  waiting: QueuedLead[];
  committing: boolean;
  /** waiting plus committing: second opinions start only when this is 0 */
  pending: number;
  /** the lead at the head of the acceptance order and when it got there, which its grace is measured from */
  head: { id: string; since: number } | null;
  /** whenIdle callers waiting for the queue to empty */
  idle: (() => void)[];
}

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
  const listName = listNameOf(ev, ctx.cfg.listDoors);
  ctx.store.leads.accept({ id, source: ev.source, sourceEventId: ev.sourceEventId, receivedAt: ev.receivedAt, synthetic: ev.synthetic, rawJson: JSON.stringify(ev.raw), acceptedAt: nowIso(ctx), listName });
  ctx.bus.emit('lead', { id, status: 'received' });
  enqueue(ctx, id);
  return { leadId: id, duplicate: false };
}

/** Puts an accepted lead in the commit order and starts its order-independent work. */
export function enqueue(ctx: Ctx, leadId: string) {
  const input = ctx.store.leads.input(leadId);
  const entry: QueuedLead = { id: leadId, lane: laneFor(ctx, leadId, input), ready: !input, outcome: null, readyAt: null };
  if (input) {
    const outcome = startPrepare(ctx, input);
    entry.outcome = outcome;
    const settled = () => { entry.ready = true; entry.readyAt = ctx.cfg.now(); pump(ctx); };
    outcome.then(settled, settled);
  }
  ctx.q.waiting.push(entry);
  ctx.q.pending++;
  pump(ctx);
}

/** The lead's lane, from its stored payload. A payload the adapter refuses gets a lane of its own and fails in its turn. */
function laneFor(ctx: Ctx, id: string, input: LeadInputRow | undefined): string {
  if (!input) return `lead:${id}`;
  try {
    return laneOf(adapt(input.source, JSON.parse(input.raw_json), input.received_at), registryLookups(ctx.db), id);
  } catch {
    return `lead:${id}`;
  }
}

const graceTimers = new WeakMap<Ctx, WakeUp>();
const graceTimer = (ctx: Ctx) => {
  let w = graceTimers.get(ctx);
  if (!w) graceTimers.set(ctx, (w = new WakeUp(() => pump(ctx))));
  return w;
};

/**
 * Starts the next commit when the ordered section is free and src/commitOrder.ts names a lead; otherwise waits for a
 * prepared result or, when the head's grace is running, for the moment it ends. Called on every enqueue, every prepared
 * result, every finished commit and when the grace timer fires.
 */
function pump(ctx: Ctx) {
  const q = ctx.q;
  if (q.committing) return;
  const head = q.waiting[0];
  if (!head) { q.head = null; return; }
  const now = ctx.cfg.now();
  if (q.head?.id !== head.id) q.head = { id: head.id, since: now };
  const next = nextCommit(q.waiting, { now, headSince: q.head.since, graceMs: ctx.cfg.commitGraceMs });
  if (next.kind === 'wait') {
    if (next.recheckAt != null) graceTimer(ctx).at(next.recheckAt, now);
    return;
  }
  if (next.kind === 'empty') return;
  const [entry] = q.waiting.splice(q.waiting.findIndex(w => w.id === next.id), 1);
  // the head's turn began when it reached the head, so its wait for its own prepared result reads as waitedForPrepare
  const turnMs = next.passed ? now : q.head.since;
  q.committing = true;
  processLead(ctx, entry.id, { started: entry.outcome, passed: next.passed, turnMs, readyAt: entry.readyAt }).catch(() => {}).finally(() => {
    q.committing = false;
    q.pending--;
    armListDigests(ctx);
    if (q.pending === 0) {
      // second opinions wait while leads are waiting, so a burst never queues a route's model call behind one
      kickSecondOpinions(ctx);
      for (const done of q.idle.splice(0)) done();
    }
    pump(ctx);
  });
}

/** Re-evaluates the commit order now. The grace timer does this on its own; a test that moves an injected clock calls it. */
export const recheckCommitOrder = (ctx: Ctx) => pump(ctx);

const prepareSlots = new WeakMap<Ctx, Limiter>();
const prepareLimiter = (ctx: Ctx) => {
  let l = prepareSlots.get(ctx);
  if (!l) prepareSlots.set(ctx, (l = new Limiter(ctx.cfg.prepareConcurrency)));
  return l;
};

/** Starts the lead's order-independent work now; its lookups take one of cfg.prepareConcurrency slots, first accepted first. */
function startPrepare(ctx: Ctx, input: LeadInputRow): Promise<PrepareOutcome> {
  const lookupSlot: Slot = fn => prepareLimiter(ctx).run(fn);
  return prepareLead(ctx, input, lookupSlot);
}

/**
 * Resolves when the queue is empty and no HubSpot delivery pass or second opinion is running. Dry-run records and crm_json
 * are written by then; a live plan has had its first delivery attempt; every second opinion that was due has its answer.
 * Retries scheduled for later (a lead's or a delivery's) are not waited for, and neither is a list's quiet period: a digest
 * goes out when its timer fires, or when flushListDigests is called.
 */
export async function whenIdle(ctx: Ctx) {
  for (;;) {
    if (ctx.q.pending > 0) await new Promise<void>(done => ctx.q.idle.push(done));
    else if (outboxBusy(ctx)) await outboxIdle(ctx);
    else if (secondOpinionsBusy(ctx)) await secondOpinionsIdle(ctx);
    else return;
  }
}

/**
 * Boot recovery: anything accepted (202) but not finished is processed again, in the order it was accepted. That includes
 * leads waiting for a retry, which run now rather than at their old time. Live HubSpot plans a stopped process left in the
 * outbox are delivered, second opinions it left due or in flight are asked again, and list digests it left owed are armed.
 * Returns the number of leads re-run.
 */
export function resumePending(ctx: Ctx): number {
  const ids = ctx.store.leads.unfinishedIds();
  for (const id of ids) enqueue(ctx, id);
  kickOutbox(ctx);
  resumeSecondOpinions(ctx);
  armListDigests(ctx);
  return ids.length;
}

/** How a turn was reached: the work begun at enqueue, whether it passed a waiting lead, and when the turn began. */
export interface Turn {
  /** the prepared work begun at enqueue; prepared now when there is none */
  started: Promise<PrepareOutcome> | null;
  /** the turn came ahead of an earlier-accepted lead in another lane that was still waiting */
  passed: boolean;
  /** when the lead reached the head of the order (or passed); now when not given */
  turnMs?: number;
  /** when its prepared work settled; its turn waited from turnMs to then, or not at all if it was ready first */
  readyAt?: number | null;
}

/** One lead's turn in the ordered section. */
export async function processLead(ctx: Ctx, id: string, turn: Turn = { started: null, passed: false }): Promise<void> {
  const input = ctx.store.leads.input(id);
  if (!input) return;
  const turnMs = turn.turnMs ?? ctx.cfg.now();
  const prepared = await (turn.started ?? prepareLead(ctx, input));
  const waitedMs = Math.max(0, (turn.readyAt ?? ctx.cfg.now()) - turnMs);
  try {
    wipeDerived(ctx, id);
    if (!prepared.ok) {
      logPrepared(ctx, id, prepared.records);
      throw prepared.error;
    }
    const p = prepared.value;
    const run = startRun(ctx, id, input, p, turnMs, waitedMs);
    if (turn.passed) run.timings.passed = 1;
    const committed = commitPrepared(run, p);
    const score = await scoreStage(run, committed);
    const routed = await routeStage(run, { ...committed, score });
    const brief = await notifyStage(run, { ...committed, score, routed });
    const planStored = await crmStage(run, { ...committed, score, routed, brief });
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
  return { ctx, id, ev: p.ev, t0, timings, listName: input.list_name };
}

/**
 * Clears what an earlier run of this lead wrote outside its own row: the account it claimed (if still held by the rep it
 * named), its signals, assignment, open review items, a HubSpot plan still waiting to go out, a second opinion due or done,
 * its place in a list digest, and the timings of its stages. Rows that record history (re-deliveries, failed runs, HubSpot
 * delivery attempts, a digest already recorded, a review item a person decided) stay, and so does a person's decision on
 * the lead, which the re-run applies (src/review/).
 */
function wipeDerived(ctx: Ctx, id: string) {
  tx(ctx.db, () => {
    ctx.store.accounts.releaseLead(id);
    ctx.store.outbox.dropPending(id);
    ctx.store.leads.clearSecondOpinion(id);
    ctx.store.leads.clearDigest(id);
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
