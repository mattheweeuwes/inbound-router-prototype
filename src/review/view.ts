// GET /api/review: what Needs a person draws (decision 33). Every open item, with what a person decides from (the reason,
// the router's sentence, the candidates) and the decisions it takes; the last twenty decisions with who, when and what
// they led to; and whether the decision route is served at all.
import type { Ctx } from '../context';
import { parse } from '../db';
import { teamName } from '../route';
import type { Candidate, Team } from '../schema';
import { allowedDecisions, itemKind, outcomeLine, type ItemKind, type ReviewDecisionKind, type StoredReviewDecision } from './decision';
import type { DecidedItemRow, OpenItemRow } from '../store/review';

/** How many decisions the Decided list shows. */
export const DECIDED_SHOWN = 20;

export interface OpenItem {
  leadId: string; reason: string; kind: ItemKind; createdAt: string; receivedAt: string; source: string; synthetic: boolean;
  /** the uploaded list the lead came in on, or null */
  list: string | null;
  person: string; title: string | null; email: string | null;
  /** the company as the lead typed it, and the organization the router placed it on, when it did */
  companyTyped: string | null; org: string | null;
  tier: string | null; route: { action: string | null; team: string | null; owner: string | null; rule: string | null; reason: string | null };
  candidates: Candidate[];
  decisions: ReviewDecisionKind[];
  /** the lead is still running: a decision is refused until it is done */
  busy: boolean;
}

export interface DecidedItem {
  leadId: string; reason: string; decision: string; by: string; note: string | null; at: string;
  person: string; company: string | null; list: string | null;
  /** what the lead has now, in one line ("Routed: tier B, Health Systems queue") */
  outcome: string;
  /** the route before the decision, when it was recorded */
  before: StoredReviewDecision['before'] | null;
  account: StoredReviewDecision['account'];
  notBuyerReason: string | null;
}

export interface ReviewView { demoActions: boolean; open: OpenItem[]; decided: DecidedItem[] }

const personName = (r: { first_name: string | null; last_name: string | null; email: string | null }) =>
  [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'Account signal';

function openItem(r: OpenItemRow): OpenItem {
  return {
    leadId: r.lead_id, reason: r.reason, kind: itemKind(r.reason), createdAt: r.created_at, receivedAt: r.received_at, source: r.source, synthetic: !!r.synthetic,
    list: r.list_name, person: personName(r), title: r.title, email: r.email, companyTyped: r.company_name_raw, org: r.account_name,
    tier: r.tier, route: { action: r.route_action, team: r.route_team, owner: r.owner, rule: r.rule, reason: r.route_reason },
    candidates: parse<Candidate[]>(r.candidates_json) ?? [], decisions: allowedDecisions(r.reason), busy: r.status !== 'done',
  };
}

function decidedItem(ctx: Ctx, r: DecidedItemRow): DecidedItem {
  const stored = parse<StoredReviewDecision>(r.decision_json);
  const kind = stored?.kind;
  const outcome = r.status === 'done'
    ? outcomeLine({ action: r.route_action, team: r.route_team, owner: r.owner, tier: r.tier, sequence: r.sequence, rule: r.rule }, t => teamName(ctx.owners, t as Team), kind)
    : 'Running again with the decision';
  return {
    leadId: r.lead_id, reason: r.reason, decision: r.decision, by: r.decided_by, note: r.decision_note, at: r.decided_at,
    person: personName(r), company: r.company_name_raw, list: r.list_name, outcome, before: stored?.before ?? null,
    account: stored?.account ?? null, notBuyerReason: stored?.reason ?? null,
  };
}

export function reviewView(ctx: Ctx): ReviewView {
  return {
    demoActions: ctx.cfg.demoRoutes,
    open: ctx.store.review.openItems().map(openItem),
    decided: ctx.store.review.decided(DECIDED_SHOWN).map(r => decidedItem(ctx, r)),
  };
}
