// HubSpot delivery through an outbox. The pipeline plans a lead's requests and stores them here (and on the lead, as
// crm_json) in the same step; the lead is done once its alert is out and its plan is stored. This worker then delivers
// plans one at a time, oldest first, outside the pipeline's one-at-a-time section, so a slow or unreachable HubSpot holds
// no lead behind it.
//
// A call that throws (network error, the 10 s timeout) or a 429 or 5xx answer is retried with backoff, honoring
// Retry-After, up to cfg.crmMaxAttempts; then the plan is dead and the dashboard shows it. Any other answer settles the
// plan: a 4xx is recorded on the lead and not retried, because the same request would get the same answer.
// Plans go out strictly in order: while the oldest one waits for its retry, the ones behind it wait too, so a later write
// for a contact never lands before an earlier one. Dry-run never comes here; it has nothing to deliver.
import type { Ctx } from '../context';
import { nextAttempt, WakeUp } from '../retry';
import type { CrmRequest } from '../schema';
import type { OutboxRow } from '../store/outbox';
import { crmMode, executeCrm, type CrmExecution } from './hubspot';

/** The plan as stored in crm_outbox.plan_json and copied into crm_json. */
export interface CrmPlan { requests: CrmRequest[]; skipped: string | null }

/** Where a live plan stands, as crm_json.delivery tells the cockpit and the dashboard. */
export type Delivery = 'pending' | 'retrying' | 'delivered' | 'dead';

/**
 * leads.crm_json. mode, requests, skipped, ok, responses and ownerMapped are the fields the cockpit, the dashboard, the
 * replay and the reverse ETL read; ok and responses are filled when a live delivery settles. Dry-run records carry no
 * delivery fields.
 */
export interface CrmRecord extends CrmPlan {
  mode: 'dry_run' | 'live';
  ok?: boolean;
  responses?: CrmExecution['responses'];
  ownerMapped?: CrmExecution['ownerMapped'];
  delivery?: Delivery;
  attempts?: number;
  error?: string;
  nextAttemptAt?: string;
}

interface WorkerState { pass: Promise<void> | null; again: boolean; wake: WakeUp }
const workers = new WeakMap<Ctx, WorkerState>();

function worker(ctx: Ctx): WorkerState {
  let w = workers.get(ctx);
  if (!w) {
    w = { pass: null, again: false, wake: new WakeUp(() => kickOutbox(ctx)) };
    workers.set(ctx, w);
  }
  return w;
}

const nowIso = (ctx: Ctx) => new Date(ctx.cfg.now()).toISOString();

/**
 * Stores a live plan for delivery and returns the lead's record as it stands until delivery settles. An empty plan has
 * nothing to send and settles at once.
 */
export function enqueuePlan(ctx: Ctx, leadId: string, plan: CrmPlan): CrmRecord {
  if (!plan.requests.length) return { mode: 'live', ...plan, ok: true, responses: [] };
  ctx.store.outbox.enqueue(leadId, JSON.stringify(plan), ctx.cfg.now(), nowIso(ctx));
  return { mode: 'live', ...plan, ok: false, delivery: 'pending' };
}

/** Starts a delivery pass unless one is running; a running pass picks up new plans as it goes. */
export function kickOutbox(ctx: Ctx) {
  const w = worker(ctx);
  if (w.pass) { w.again = true; return; }
  w.again = false;
  w.pass = deliverDue(ctx).finally(() => {
    w.pass = null;
    if (w.again) kickOutbox(ctx);
  });
}

/** Resolves when no delivery pass is running. Scheduled retries are not waited for. */
export async function outboxIdle(ctx: Ctx): Promise<void> {
  const w = workers.get(ctx);
  while (w?.pass) await w.pass;
}

/** Whether a delivery pass is running right now. */
export const outboxBusy = (ctx: Ctx) => !!workers.get(ctx)?.pass;

/**
 * Delivers due plans, oldest first, until the queue is empty or the oldest plan is waiting for a retry; then sets the
 * timer for it. A context that is not live leaves every plan where it is, for a live boot to send.
 */
async function deliverDue(ctx: Ctx): Promise<void> {
  if (crmMode(ctx.cfg) !== 'live') return;
  for (;;) {
    const head = ctx.store.outbox.head();
    if (!head) return;
    if (head.next_attempt_at > ctx.cfg.now()) { worker(ctx).wake.at(head.next_attempt_at, ctx.cfg.now()); return; }
    const settled = await attempt(ctx, head);
    if (!settled) return; // waiting for a retry: everything behind it waits too
  }
}

/** One delivery attempt. Returns true when the plan settled (delivered or dead), false when it is waiting for a retry. */
async function attempt(ctx: Ctx, row: OutboxRow): Promise<boolean> {
  const plan = JSON.parse(row.plan_json) as CrmPlan;
  const attempts = row.attempts + 1;
  const startedAt = nowIso(ctx);
  const t = performance.now();
  let exec: CrmExecution | null = null;
  let error: string;
  try {
    exec = await executeCrm(ctx, plan.requests);
    if (!exec.transient) {
      settle(ctx, row, attempts, { mode: 'live', ...plan, ok: exec.ok, responses: exec.responses, ...(exec.ownerMapped ? { ownerMapped: exec.ownerMapped } : {}), delivery: 'delivered', attempts });
      logDelivery(ctx, row.lead_id, startedAt, t, true, exec.ok ? null : 'HubSpot answered with an error status; recorded, not retried');
      return true;
    }
    error = `HubSpot answered ${exec.transient.status}`;
  } catch (e) {
    error = (e as Error).message.slice(0, 300);
  }
  const next = nextAttempt(attempts, { baseMs: ctx.cfg.crmRetryDelayMs, maxMs: ctx.cfg.crmMaxDelayMs, maxAttempts: ctx.cfg.crmMaxAttempts }, ctx.cfg.now(), exec?.transient?.retryAfterMs ?? null);
  const base: CrmRecord = { mode: 'live', ...plan, ok: false, ...(exec?.responses ? { responses: exec.responses } : {}), attempts, error };
  if (!next.retry) {
    settle(ctx, row, attempts, { ...base, delivery: 'dead' }, error);
    logDelivery(ctx, row.lead_id, startedAt, t, false, `gave up after ${attempts} attempts: ${error}`);
    return true;
  }
  const record: CrmRecord = { ...base, delivery: 'retrying', nextAttemptAt: new Date(next.atMs).toISOString() };
  if (ctx.store.outbox.scheduleRetry(row.id, attempts, next.atMs, error, nowIso(ctx))) writeRecord(ctx, row.lead_id, record);
  logDelivery(ctx, row.lead_id, startedAt, t, false, `attempt ${attempts} of ${ctx.cfg.crmMaxAttempts}: ${error}`);
  worker(ctx).wake.at(next.atMs, ctx.cfg.now());
  return false;
}

function settle(ctx: Ctx, row: OutboxRow, attempts: number, record: CrmRecord, error: string | null = null) {
  const state = record.delivery === 'dead' ? 'dead' : 'delivered';
  // a plan a re-run replaced while this attempt was in flight is no longer pending: its result must not overwrite the new record
  if (ctx.store.outbox.settle(row.id, state, attempts, error, nowIso(ctx))) writeRecord(ctx, row.lead_id, record);
}

function writeRecord(ctx: Ctx, leadId: string, record: CrmRecord) {
  ctx.store.leads.setCrm(leadId, nowIso(ctx), JSON.stringify(record));
  ctx.bus.emit('lead', { id: leadId, status: 'done', crm: record.delivery });
}

function logDelivery(ctx: Ctx, leadId: string, startedAt: string, t: number, ok: boolean, note: string | null) {
  ctx.store.stages.log({ leadId, stage: 'crm_delivery', startedAt, ms: Math.round(performance.now() - t), ok, note });
}
