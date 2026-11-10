// POST /api/outbound/<ein>/link: a person confirms which registry organization a rate group belongs to, or rejects the
// candidate. Sign-in is not built, so the request names who decided and the route is served only with the demo actions
// on (DEMO_ROUTES=1), as the cockpit's other write routes are. A confirmation must name an account from the group's own
// candidates: a person chooses among what the matcher found, never types a key in. DELETE on the same path takes a decision
// back (an undo): the group returns to what the loader found, and nothing else changes.
import type { Ctx } from '../context';
import { groupState } from './groupState';
import { decidable, type LinkDecision } from './linkReview';

/** The longest name and note stored, so a stray paste cannot fill the table. */
const MAX_BY = 80;
const MAX_NOTE = 500;

export interface LinkDecisionRequest { decision: 'confirm' | 'reject'; accountKey?: string; by: string; note?: string }

export type LinkDecisionResult =
  | { ok: true; decision: LinkDecision }
  | { ok: false; status: 404 | 409 | 422; error: string };

const fail = (status: 404 | 409 | 422, error: string): LinkDecisionResult => ({ ok: false, status, error });
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Reads the request body into a decision request, or says what is wrong with it. */
export function parseLinkDecision(body: unknown): LinkDecisionRequest | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const decision = b.decision;
  if (decision !== 'confirm' && decision !== 'reject') return 'decision must be "confirm" or "reject"';
  const by = text(b.by);
  if (!by) return 'by is required: the name of the person deciding';
  if (by.length > MAX_BY) return `by is longer than ${MAX_BY} characters`;
  const note = text(b.note);
  if (note.length > MAX_NOTE) return `note is longer than ${MAX_NOTE} characters`;
  const accountKey = text(b.accountKey);
  if (decision === 'confirm' && !accountKey) return 'accountKey is required to confirm: one of the group\'s candidates';
  return { decision, by, ...(accountKey ? { accountKey } : {}), ...(note ? { note } : {}) };
}

/** Records the decision for one EIN. A later decision replaces an earlier one; the loader's exact link cannot be overruled here. */
export function recordLinkDecision(ctx: Ctx, ein: string, req: LinkDecisionRequest): LinkDecisionResult {
  const g = ctx.store.outbound.file() ? ctx.store.outbound.group(ein) : null;
  if (!g) return fail(404, `no rate group with EIN ${ein}`);
  const { review } = groupState(ctx, g);
  if (!decidable(review)) return fail(409, `EIN ${ein} is already linked to ${review.accountName} by an exact name and state match; a decision is for the groups that are not`);
  const base = { ein, decidedBy: req.by, note: req.note ?? null, decidedAt: new Date(ctx.cfg.now()).toISOString() };
  let decision: LinkDecision;
  if (req.decision === 'confirm') {
    const chosen = review.candidates.find(c => c.accountId === req.accountKey);
    if (!chosen) return fail(422, `${req.accountKey} is not one of this group's candidates (${review.candidates.map(c => c.accountId).join(', ') || 'it has none'})`);
    decision = { ...base, decision: 'confirmed', accountId: chosen.accountId, accountName: chosen.name };
  } else {
    // a rejection records the candidate the person was shown, so a reader knows what was turned down
    // (the probable candidate, the account an earlier confirmation named, or the one the request names)
    const named = req.accountKey ?? (review.status === 'confirmed' ? review.accountId : null);
    const shown = review.probable ?? review.candidates.find(c => c.accountId === named) ?? null;
    decision = { ...base, decision: 'rejected', accountId: shown?.accountId ?? null, accountName: shown?.name ?? null };
  }
  ctx.store.outbound.saveDecision(decision);
  return { ok: true, decision };
}

export type ClearDecisionResult = { ok: true } | { ok: false; status: 404; error: string };

/** Takes back the decision recorded for one EIN. A group with none says so rather than pretending it did something. */
export function clearLinkDecision(ctx: Ctx, ein: string): ClearDecisionResult {
  if (!ctx.store.outbound.file() || !ctx.store.outbound.group(ein)) return { ok: false, status: 404, error: `no rate group with EIN ${ein}` };
  if (!ctx.store.outbound.clearDecision(ein)) return { ok: false, status: 404, error: `EIN ${ein} has no recorded decision to clear` };
  return { ok: true };
}
