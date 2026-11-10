// Applies a person's decision on a review item (decision 33). The decision is checked against the item, recorded on it
// (resolved, with who, the note and when) and stored with the lead in one transaction; then the lead is run again through
// the whole pipeline, so the account they chose is scored, routed, alerted and planned for the CRM like any other lead,
// and every later rule (the owner rule, the enterprise rule, the tier) applies as it would have. The one decision that
// does not run the lead again is "it is a buyer" on a doubt that arrived after the alert: the lead was routed and alerted
// on the rules, and it stays so.
import type { Ctx } from '../context';
import { json, parse, tx } from '../db';
import { enqueue } from '../pipeline';
import { teamName } from '../route';
import type { Candidate, Team } from '../schema';
import {
  checkDecision, outcomeLine, rerunsLead, type ReviewDecision, type ReviewDecisionKind, type ReviewRequest, type RouteSnapshot, type StoredReviewDecision,
} from './decision';
import { lookupAccount } from './resolution';

/** How long a request waits for the re-run to finish before it answers with the lead still running. */
export const DECISION_WAIT_MS = 10_000;

/** Why a decision was not taken: 404 no such lead, 409 nothing open or the lead mid-run, 422 the item does not take it. */
export interface Refusal { ok: false; status: 404 | 409 | 422; error: string }

export type DecideResult =
  | { ok: true; leadId: string; decision: ReviewDecisionKind; rerun: boolean; finished: boolean; outcome: string; route: RouteSnapshot }
  | Refusal;

const fail = (status: Refusal['status'], error: string): Refusal => ({ ok: false, status, error });
const nowIso = (ctx: Ctx) => new Date(ctx.cfg.now()).toISOString();

/** Checks and records the decision, and starts the re-run when it needs one. Does not wait for the run. */
export function recordDecision(ctx: Ctx, leadId: string, req: ReviewRequest): { ok: true; decision: ReviewDecision; rerun: boolean } | Refusal {
  const lead = ctx.store.review.lead(leadId);
  if (!lead) return fail(404, `no lead with id ${leadId}`);
  const item = ctx.store.review.openItemFor(leadId);
  if (!item) return fail(409, alreadyDecided(ctx, leadId));
  if (lead.status !== 'done') return fail(409, `this lead is being processed (status ${lead.status}), so a decision now would race its run; try again when it is done`);
  const at = nowIso(ctx);
  const checked = checkDecision(req, {
    itemReason: item.reason, at, candidates: parse<Candidate[]>(item.candidates_json) ?? [], lookup: key => lookupAccount(ctx, key),
  });
  if (typeof checked === 'string') return fail(422, checked);
  const rerun = rerunsLead(checked.kind, item.reason);
  const before: RouteSnapshot = { action: lead.route_action, team: lead.route_team, owner: lead.owner, tier: lead.tier, rule: lead.rule, account: lead.account_name ?? lead.company_name_raw };
  const stored: StoredReviewDecision = { ...checked, before, rerun };
  const saved = tx(ctx.db, () => {
    if (!ctx.store.review.decide({ itemId: item.id, decision: checked.kind, by: checked.by, note: checked.note, at, json: json(stored)! })) return 'decided';
    ctx.store.leads.setReviewDecision(leadId, at, json(checked)!);
    if (rerun && !ctx.store.leads.requeue(leadId, at)) throw new Error('the lead left the done state while the decision was recorded');
    return 'ok';
  });
  if (saved === 'decided') return fail(409, alreadyDecided(ctx, leadId));
  ctx.bus.emit('lead', { id: leadId, status: rerun ? 'received' : 'done', review: 'decided' });
  if (rerun) rerunWithTouches(ctx, leadId);
  return { ok: true, decision: checked, rerun };
}

/**
 * Runs the lead again, then the later touches from the same contact that attached to it (R2), so they follow its new
 * owner. They are re-run only when finished; one that is not is picked up by its own run.
 */
function rerunWithTouches(ctx: Ctx, leadId: string) {
  const touches = ctx.store.leads.attachedTouches(leadId);
  enqueue(ctx, leadId);
  for (const id of touches) if (ctx.store.leads.requeue(id, nowIso(ctx))) enqueue(ctx, id);
}

function alreadyDecided(ctx: Ctx, leadId: string): string {
  const last = ctx.store.review.lastDecisionFor(leadId);
  return last
    ? `this item was already decided (${last.decision.replace(/_/g, ' ')}) by ${last.decided_by} at ${last.decided_at}; nothing is open for this lead`
    : 'this lead has no open review item';
}

/** Resolves when the lead's run settles (done, failed or waiting for a retry), or after ms. True when it settled. */
export function leadSettled(ctx: Ctx, leadId: string, ms: number): Promise<boolean> {
  return new Promise(done => {
    const finish = (settled: boolean) => { clearTimeout(timer); ctx.bus.off('lead', onLead); done(settled); };
    const onLead = (e: { id: string; status: string; review?: string }) => {
      if (e.id === leadId && !e.review && ['done', 'failed', 'retrying'].includes(e.status)) finish(true);
    };
    const timer = setTimeout(() => finish(false), ms);
    timer.unref?.();
    ctx.bus.on('lead', onLead);
  });
}

/** The lead's route now, and the one line the cockpit shows in the item's place. */
export function outcomeOf(ctx: Ctx, leadId: string, kind: ReviewDecisionKind): { outcome: string; route: RouteSnapshot } {
  const l = ctx.store.review.lead(leadId);
  const route: RouteSnapshot = { action: l?.route_action ?? null, team: l?.route_team ?? null, owner: l?.owner ?? null, tier: l?.tier ?? null, rule: l?.rule ?? null, account: l?.account_name ?? l?.company_name_raw ?? null };
  const running = l?.status !== 'done';
  const outcome = running ? 'Running again with your decision' : outcomeLine({ ...route, sequence: l?.sequence ?? null }, t => teamName(ctx.owners, t as Team), kind);
  return { outcome, route };
}

/**
 * Records the decision, waits for the re-run (up to DECISION_WAIT_MS) and says what happened. The wait is attached right
 * after the re-run is queued and before anything is awaited, so no event of that run is missed: its work starts on a later tick.
 */
export async function decideReview(ctx: Ctx, leadId: string, req: ReviewRequest, waitMs = DECISION_WAIT_MS): Promise<DecideResult> {
  const r = recordDecision(ctx, leadId, req);
  if (!r.ok) return r;
  const finished = r.rerun ? await leadSettled(ctx, leadId, waitMs) : true;
  return { ok: true, leadId, decision: r.decision.kind, rerun: r.rerun, finished, ...outcomeOf(ctx, leadId, r.decision.kind) };
}

/** One list's open unplaced-company rows, each sent to nurture with the same name and note. */
export interface ListDecisionResult {
  list: string; count: number; decided: string[];
  /** rows that could not be decided, with why (a row mid-run, say) */
  skipped: { leadId: string; error: string }[];
  finished: boolean;
}

/** Applies not_for_sales to every open unplaced-company row of a list, and waits for their re-runs. */
export async function decideListNurture(ctx: Ctx, list: string, by: string, note: string | null, waitMs = DECISION_WAIT_MS): Promise<ListDecisionResult> {
  const ids = ctx.store.review.unplacedInList(list);
  const decided: string[] = [], skipped: { leadId: string; error: string }[] = [];
  const waits: Promise<boolean>[] = [];
  for (const id of ids) {
    const r = recordDecision(ctx, id, { decision: 'not_for_sales', by, note, accountKey: null, reason: null });
    if (r.ok) { decided.push(id); waits.push(leadSettled(ctx, id, waitMs)); } else skipped.push({ leadId: id, error: r.error });
  }
  const finished = (await Promise.all(waits)).every(Boolean);
  return { list, count: decided.length, decided, skipped, finished };
}
