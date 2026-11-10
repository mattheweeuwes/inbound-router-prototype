// A person's decision on a review item (decision 33), as pure functions: what a request may ask for, which decisions an
// item takes, the route a decision forces, the model's doubt it clears, and the one line the cockpit shows afterwards.
// src/review/apply.ts reads the database, calls these and starts the re-run; tests call them directly.
// Sign-in is not built, so `by` is the name the person typed, and the route that takes these is served only with the demo
// actions on, like the outbound link decision.
import type { Qualification, Route, Segment, Source } from '../schema';
import { DOUBT_REVIEW_REASON } from '../secondOpinion';
import { MARKETING_OWNER, nurtureTrack, nurtureTrackLabel } from '../route';

export const REVIEW_DECISIONS = ['use_account', 'not_for_sales', 'not_a_buyer', 'is_buyer'] as const;
export type ReviewDecisionKind = typeof REVIEW_DECISIONS[number];

/** The route rule a person's decision records: not one of R1 to R10, so a reader never takes it for the router's own call. */
export const PERSON_RULE = 'person';

/** The longest name, note and reason stored, so a stray paste cannot fill the table. */
const MAX_BY = 80;
const MAX_NOTE = 500;

/** What the request asks for, before the item and the registry are checked. */
export interface ReviewRequest {
  decision: ReviewDecisionKind;
  by: string;
  note: string | null;
  /** use_account: the account key the person chose */
  accountKey: string | null;
  /** not_a_buyer: why, in the person's words */
  reason: string | null;
}

/** Where a chosen account came from: one of the item's candidates, or a key the person named for an unresolved company. */
export type ChosenFrom = 'candidate' | 'registry' | 'crm';

/** The decision as stored on the lead (leads.review_decision_json) and read by every later run of it. */
export interface ReviewDecision {
  kind: ReviewDecisionKind;
  by: string;
  note: string | null;
  at: string;
  /** the review item's reason when it was decided */
  itemReason: string;
  /** use_account only */
  account: { key: string; name: string; from: ChosenFrom } | null;
  /** not_a_buyer only */
  reason: string | null;
}

/** What the lead had before the decision, kept with the decision so the trail can say what it changed. */
export interface RouteSnapshot {
  action: string | null; team: string | null; owner: string | null; tier: string | null; rule: string | null; account: string | null;
}

/** review_queue.decision_json */
export interface StoredReviewDecision extends ReviewDecision { before: RouteSnapshot; rerun: boolean }

/** The kinds of review item, by what a person is asked. */
export type ItemKind = 'company' | 'doubt';

/** A doubt item was raised by the model (held before the route, or opened after the alert); every other item is about the company. */
export const itemKind = (reason: string): ItemKind => (reason === 'llm_only_disqualifier' || reason === DOUBT_REVIEW_REASON ? 'doubt' : 'company');

/** The decisions an item takes. A company item can be given an account; a doubt item can be cleared. Either can be ruled out. */
export function allowedDecisions(reason: string): ReviewDecisionKind[] {
  return itemKind(reason) === 'doubt' ? ['is_buyer', 'not_a_buyer'] : ['use_account', 'not_for_sales', 'not_a_buyer'];
}

/** A decision on a doubt that arrived after the alert, that the lead is a buyer, closes the item and leaves the lead as it was routed. */
export const rerunsLead = (kind: ReviewDecisionKind, itemReason: string) => !(kind === 'is_buyer' && itemReason === DOUBT_REVIEW_REASON);

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Reads the request body, or says what is wrong with it. */
export function parseReviewRequest(body: unknown): ReviewRequest | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const decision = REVIEW_DECISIONS.find(d => d === b.decision);
  if (!decision) return `decision must be one of ${REVIEW_DECISIONS.map(d => `"${d}"`).join(', ')}`;
  const by = text(b.by);
  if (!by) return 'by is required: the name of the person deciding';
  if (by.length > MAX_BY) return `by is longer than ${MAX_BY} characters`;
  const note = text(b.note);
  if (note.length > MAX_NOTE) return `note is longer than ${MAX_NOTE} characters`;
  const accountKey = text(b.accountKey);
  if (decision === 'use_account' && !accountKey) return 'accountKey is required for use_account: one of the item\'s candidates, or an account in the registry or the CRM';
  const reason = text(b.reason);
  if (decision === 'not_a_buyer' && !reason) return 'reason is required for not_a_buyer: why this is not a buyer';
  if (reason.length > MAX_NOTE) return `reason is longer than ${MAX_NOTE} characters`;
  return { decision, by, note: note || null, accountKey: decision === 'use_account' ? accountKey : null, reason: decision === 'not_a_buyer' ? reason : null };
}

/** An account the person may choose: the key, its name, and where it was found. */
export interface AccountChoice { key: string; name: string; from: ChosenFrom }

/** What checking a request against its item needs: the item, and a way to look up a named key that is not a candidate. */
export interface DecisionCheck {
  itemReason: string;
  candidates: { accountId: string; name: string }[];
  at: string;
  /** a key the person named, found in the registry or the CRM mirror, or null */
  lookup: (key: string) => AccountChoice | null;
}

/**
 * Turns a parsed request into the decision the router applies, or says why the item does not take it. A tie is settled
 * only by one of its own candidates; an unresolved company (no candidates) may be given any account the registry or the
 * CRM mirror holds, never a key nothing knows.
 */
export function checkDecision(req: ReviewRequest, c: DecisionCheck): ReviewDecision | string {
  const allowed = allowedDecisions(c.itemReason);
  if (!allowed.includes(req.decision)) {
    return `a ${itemKind(c.itemReason) === 'doubt' ? "model's doubt" : 'company'} item takes ${allowed.join(', ')}, not ${req.decision}`;
  }
  const base = { kind: req.decision, by: req.by, note: req.note, at: c.at, itemReason: c.itemReason, account: null, reason: req.reason };
  if (req.decision !== 'use_account') return base;
  const key = req.accountKey ?? '';
  const candidate = c.candidates.find(x => x.accountId === key);
  if (candidate) return { ...base, account: { key, name: candidate.name, from: 'candidate' } };
  if (c.candidates.length) return `${key} is not one of this item's candidates (${c.candidates.map(x => x.accountId).join(', ')})`;
  const found = c.lookup(key);
  if (!found) return `${key} is not an account in the registry or the CRM`;
  return { ...base, account: found };
}

/** What the forced route needs from the lead. */
export interface ForcedRouteInput { segment: Segment; source: Source; }

/**
 * The route a decision forces: marketing's nurture track for not_for_sales, a drop for not_a_buyer. Null for use_account
 * and is_buyer, which run the router's own rules on the decided account or the cleared doubt.
 */
export function forcedRoute(d: ReviewDecision, i: ForcedRouteInput): Route | null {
  const base = { rule: PERSON_RULE, slaMinutes: null, slaDueAt: null };
  const note = d.note ? ` Their note: "${d.note}".` : '';
  if (d.kind === 'not_for_sales') {
    const track = nurtureTrack(i.segment, i.source);
    return {
      ...base, action: 'nurture', team: 'Nurture', owner: MARKETING_OWNER, sequence: track,
      reason: `${d.by} decided in review that this lead is not for sales, so it goes to marketing's ${nurtureTrackLabel(track)} nurture track.${note}`,
    };
  }
  if (d.kind === 'not_a_buyer') {
    return {
      ...base, action: 'drop', team: 'Nurture', owner: 'unassigned',
      reason: `${d.by} decided in review that this is not a buyer (${d.reason ?? 'no reason given'}), so the lead is dropped and nothing is written to the CRM.${note}`,
    };
  }
  return null;
}

/**
 * The qualification with the model's doubt taken out, after a person said the lead is a buyer: no review reason, and a
 * disqualifier only the model set goes back to what the rules said. What the model said stays in llm and llmDisqualifier.
 */
export function clearModelDoubt(q: Qualification): Qualification {
  const modelSetIt = q.final.sources?.disqualifier === 'model';
  return {
    ...q, reviewReason: null,
    final: modelSetIt ? { ...q.final, disqualifier: q.rules.disqualifier, sources: { ...q.final.sources!, disqualifier: 'rules' } } : q.final,
  };
}

/** What the outcome line reads from the lead after its run. */
export interface Outcome {
  action: string | null; team: string | null; owner: string | null; tier: string | null; sequence?: string | null; rule?: string | null;
}

/**
 * One line saying what happened, for the item's place in the list ("Routed: tier B, Health Systems queue"). teamName turns
 * a team code into its name.
 */
export function outcomeLine(o: Outcome, teamName: (team: string) => string, kind?: ReviewDecisionKind): string {
  const tier = o.tier && o.tier !== 'X' ? `tier ${o.tier}, ` : '';
  switch (o.action) {
    case 'rep_alert':
      return kind === 'is_buyer' && o.rule !== PERSON_RULE ? `Doubt cleared: stays with ${o.owner}` : `Routed: ${tier}alert to ${o.owner}`;
    case 'team_queue': return `Routed: ${tier}${o.team ? teamName(o.team) : 'team'} queue`;
    case 'owner_task': return `Routed: ${tier}task for ${o.owner}, the account owner`;
    case 'attach_to_existing': return `Attached to the contact's earlier lead, with ${o.owner}`;
    case 'nurture': return `Sent to nurture: ${o.sequence ? nurtureTrackLabel(o.sequence) : 'marketing'} track`;
    case 'drop': return 'Dropped: not a buyer';
    case 'review': return 'Still needs a person: the router raised a new question';
    case 'careers': case 'press': case 'competitor_flag': return 'Sent to marketing by rule';
    case null: return 'Running again';
    default: return `Routed: ${o.action}`;
  }
}
