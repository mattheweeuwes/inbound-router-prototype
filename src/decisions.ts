// The pipeline's own decisions, as pure functions: which earlier touch owns a repeat contact, how much account intent a
// lead earns, which rep round-robin picks, whether an alert claims the account, whether a route wants a Slack alert, when the
// model runs for a lead, and what its second opinion after the alert would have changed.
// The stages in src/stages.ts read the database, call these, and write the result. Tests call them directly.
import type { DuplicateInfo, Rep } from './route';
import type { DealSignals } from './enterprise';
import type { DigestFold } from './lists';
import type { SlackPayload } from './notify/slack';
import type {
  BuyingRole, CrmMirrorEntry, Disqualifier, Firmographics, Normalized, Owners, Qualification, Resolution, Route, RouteAction, Source, Team,
} from './schema';

export const DAY = 86_400_000;
/** A contact seen again within this many days is a repeat touch of the same lead. */
export const DEDUPE_DAYS = 30;

export const WEB_INTENT_POINTS = 6, WEB_INTENT_CAP = 12, OTHER_LEAD_POINTS = 4, ACCOUNT_INTENT_CAP = 12;

/** What leads.alert_json holds: the Slack payload (null when the route sends none), and, for a lead that was given up, the RevOps alert. */
export interface StoredAlert {
  slack: SlackPayload | null;
  suppressed?: boolean;
  failure?: SlackPayload;
  /** the follow-up a model doubt after the alert sends: where the alert went, and RevOps */
  followUp?: SlackPayload[];
  /** a list lead whose alert was folded into its list's digest for a team (decision 24): no Slack payload of its own */
  digest?: DigestFold;
  /** the short note to the enterprise deals channel, on the first enterprise lead of an account in 30 days (decision 25) */
  enterprise?: SlackPayload;
}

/** An earlier finished lead from the same contact inside the dedupe window. */
export interface PriorTouch { id: string; owner: string; team: Team; action: RouteAction | null; alert: StoredAlert | null; receivedAt: string }

export interface TouchSummary {
  /** the earlier lead this one attaches to, or null when it is routed on its own */
  duplicate: DuplicateInfo | null;
  /** every live earlier touch, for the repeat-engagement points */
  priorTouches: number;
}

const NOT_LIVE: readonly (RouteAction | null)[] = ['drop', 'careers', 'press'];
const WENT_TO_SALES: readonly (RouteAction | null)[] = ['rep_alert', 'owner_task', 'team_queue', 'review'];

/**
 * Which prior touch, if any, owns this lead. Every live touch counts for scoring, but only a touch that went to sales carries
 * an owner worth attaching to: a guide download that went to nurture (Marketing) must not swallow the demo request that
 * follows it, or R2 would attach the demo to Marketing and write no CRM task. `prior` is in acceptance order; the first sales
 * touch owns the lead, and the latest alert that actually went out (not suppressed, or in a list digest) is the one the
 * 24-hour rule measures from.
 */
export function summarizeTouches(prior: PriorTouch[]): TouchSummary {
  const live = prior.filter(p => !NOT_LIVE.includes(p.action));
  const withOwner = live.filter(p => WENT_TO_SALES.includes(p.action));
  if (!withOwner.length) return { duplicate: null, priorTouches: live.length };
  let lastAlertAt: string | null = null;
  // a list lead folded into a digest was alerted through it, so a repeat scan of the same badge stays quiet like any repeat
  for (const p of live) if ((p.alert?.slack && !p.alert.suppressed) || p.alert?.digest) lastAlertAt = p.receivedAt;
  const first = withOwner[0];
  return { duplicate: { leadId: first.id, owner: first.owner, team: first.team, lastAlertAt }, priorTouches: live.length };
}

/** Account-level intent a person lead earns: web-intent signals and other contacts at the same account in the last 30 days, capped. */
export function accountIntent(webSignals: number, otherContacts: number): { points: number; note: string } {
  const web = Math.min(WEB_INTENT_CAP, webSignals * WEB_INTENT_POINTS);
  const notes: string[] = [];
  if (web) notes.push(`${webSignals} web-intent signal(s)`);
  if (otherContacts) notes.push(`${otherContacts} other contact(s) at this account`);
  return { points: Math.min(ACCOUNT_INTENT_CAP, web + otherContacts * OTHER_LEAD_POINTS), note: notes.join(', ') };
}

/** An account's own intent points, from all its web-intent signals. */
export const webIntentPoints = (signals: number) => Math.min(WEB_INTENT_CAP, signals * WEB_INTENT_POINTS);

export interface RepCandidate { name: string; hubspotOwnerId: string; capacity: number }
export interface RepActivity { last: string | null; load: number }

/**
 * Round-robin inside a team: the rep assigned least recently among those under capacity, ties broken by roster order.
 * When everyone is at capacity, the least loaded rep still gets the lead rather than nobody.
 */
export function pickRoundRobin(reps: RepCandidate[], activity: ReadonlyMap<string, RepActivity>): Rep | null {
  if (!reps.length) return null;
  const stats = reps.map((r, order) => ({ r, order, last: activity.get(r.name)?.last ?? '', load: activity.get(r.name)?.load ?? 0 }));
  const open = stats.filter(s => s.load < s.r.capacity);
  const pool = open.length ? open : [...stats].sort((a, b) => a.load - b.load).slice(0, 1);
  pool.sort((a, b) => (a.last < b.last ? -1 : a.last > b.last ? 1 : a.order - b.order));
  return { name: pool[0].r.name, hubspotOwnerId: pool[0].r.hubspotOwnerId };
}

/** A route that puts a lead on a rep's plate: an assignment is recorded, and it counts toward round-robin load. */
export const assignsRep = (route: Route) => route.action === 'rep_alert' && !route.alertSuppressed;

export interface ClaimInput { route: Route; owners: Owners; accountId: string | null; claimedOwner: string | null; mirror: CrmMirrorEntry | null; source: Source }

/** Rules whose rep alert comes from round-robin: R8 (tier A) and R10 (an enterprise deal, decision 25). */
const ROUND_ROBIN_RULES: readonly string[] = ['R8', 'R10'];

/**
 * Whether this lead's rep alert claims the account. Only a round-robin alert (R8, or R10 for an enterprise deal) to a named
 * rep on an account nobody owns, that is not in the CRM mirror, and not a web-intent signal. This stands in for HubSpot's
 * company owner being set by the company upsert, and it is what keeps two reps off one account.
 */
export function claimsAccount(i: ClaimInput): boolean {
  if (!assignsRep(i.route) || !ROUND_ROBIN_RULES.includes(i.route.rule)) return false;
  const namedRep = (i.owners.teams[i.route.team]?.reps ?? []).some(r => r.name === i.route.owner);
  return namedRep && !!i.accountId && !i.claimedOwner && !i.mirror && i.source !== 'web_intent';
}

/** Routes that put a lead in front of sales: a rep, the account owner or a team queue. */
const SALES_ACTIONS: readonly RouteAction[] = ['rep_alert', 'owner_task', 'team_queue'];

export interface EnterpriseNoteDecision {
  deal: DealSignals;
  route: Route;
  /** the lead names a person (not an account-level signal) */
  person: boolean;
  /** it came through a list door: its digest marks it instead */
  listDoor: boolean;
  /** an earlier lead at the account already sent the note in the last 30 days */
  notedRecently: boolean;
}

/**
 * Whether this lead sends the short note to the enterprise deals channel (decision 25): an enterprise lead (at an enterprise
 * account, or an enterprise deal under R10) from a person, routed to sales, not a list row, and the first such lead at the
 * account in 30 days. Sales leadership then sees enterprise demand once per account, without reading every alert.
 */
export function notesEnterprise(i: EnterpriseNoteDecision): boolean {
  const enterpriseLead = i.deal.enterprise.enterprise || i.route.rule === 'R10';
  return enterpriseLead && i.person && !i.listDoor && SALES_ACTIONS.includes(i.route.action) && !i.notedRecently;
}

const SLACK_ACTIONS: readonly RouteAction[] = ['rep_alert', 'team_queue', 'owner_task', 'review', 'competitor_flag'];

/** Whether the route sends a Slack alert. A repeat touch alerts only when routing did not suppress it. */
export const wantsSlackAlert = (route: Route) => SLACK_ACTIONS.includes(route.action) || (route.action === 'attach_to_existing' && !route.alertSuppressed);

/** Why a lead routed to review is there: the classifier's reason when it gave one, otherwise the company match. */
export const reviewReason = (qual: Qualification, res: Resolution) => qual.reviewReason ?? (res.status === 'ambiguous' ? 'ambiguous_company' : 'unresolved_company');

/** The synthetic HubSpot owner id of a rep or queue owner, or null when the name is neither. */
export function hubspotOwnerIdOf(owners: Owners, name: string): string | null {
  for (const t of Object.values(owners.teams)) for (const r of t.reps) if (r.name === name) return r.hubspotOwnerId;
  for (const q of Object.values(owners.queues)) if (q.owner === name) return q.hubspotOwnerId;
  return null;
}

/** The account's ids by kind, from its key and firmographics: { ahrq: 'SYS-1', ccns: [...] }. */
export function accountIds(accountId: string, f: Firmographics): Record<string, unknown> {
  const sep = accountId.indexOf(':');
  const ids: Record<string, unknown> = { [accountId.slice(0, sep)]: accountId.slice(sep + 1) };
  if (f.ccns?.length) ids.ccns = f.ccns;
  if (f.npi) ids.npi = f.npi;
  return ids;
}

/** The human-readable claim line the cockpit shows under the account. Nothing parses it; the claim itself is in account_claims. */
export const claimDetail = (owner: string, n: Normalized) => `${owner} claimed this account on a rep alert to ${[n.firstName, n.lastName].filter(Boolean).join(' ') || n.email}`;

/** The human-readable web-intent line, from the web_intent door's context. */
export function webIntentDetail(context: Record<string, unknown>): string {
  const visits = Array.isArray(context.visits) ? context.visits : [];
  const paths = Array.isArray(context.paths) ? context.paths : [];
  return `${visits.length} page view(s), ${context.visitors ?? '?'} visitor(s): ${paths.join(', ')}`;
}

// ---- when the model runs (decision 19) -------------------------------------------------------------------------------

/** before_route: the route waits for the model. after_alert: the lead is alerted on the rules and the model gives a second opinion. */
export type ModelTiming = 'before_route' | 'after_alert' | 'not_called';

export interface ModelTimingInput {
  setting: 'gated' | 'all';
  /** the lead came through a list door (decision 24) and list doors never wait for the model (LIST_DOOR_MODEL is not 'gated') */
  listDoorAfterAlert?: boolean;
  /** false for the rules provider, which answers at once without a model, so waiting for it costs nothing */
  providerIsModel: boolean;
  freeText: boolean;
  /** rulesUseCaseIsClear: a clear keyword winner, which combine v4 never lets the model replace */
  rulesUseCaseClear: boolean;
}

/**
 * Under combine v4 the model never sets urgency, and it changes the route in only two ways: the use case when the rules have
 * no clear winner (which can change the team), and a disqualifier the rules missed. The first is known before the call, so
 * that lead waits for the model. Every other free-text lead is routed and alerted on the rules, and the same call runs
 * afterwards; a disqualifier it raises then follows the alert as a doubt. The buying role it might fill carries no points
 * and no routing. 'all' puts the model before the route for every free-text lead.
 * A list door is the exception to the gate (decision 24): an uploaded list must not queue on the model, so its leads are
 * routed on the rules whatever the note says, and the model's answer, a different use case included, arrives as the second
 * opinion. The note on a badge scan is written by Serif's own booth staff.
 */
export function modelTiming(i: ModelTimingInput): ModelTiming {
  if (!i.freeText) return 'not_called';
  if (!i.providerIsModel || i.setting === 'all') return 'before_route';
  if (i.listDoorAfterAlert) return 'after_alert';
  return i.rulesUseCaseClear ? 'after_alert' : 'before_route';
}

/** The fields a second opinion is compared on: the three the model can decide under v4, and whether a person would have been asked. */
export const OPINION_FIELDS = ['useCase', 'buyingRole', 'disqualifier', 'reviewReason'] as const;
export type OpinionField = typeof OPINION_FIELDS[number];

/** A disqualifier only the model raised, after the alert. heldForPerson: the old path would have held the lead for RevOps (R6) rather than act on it. */
export interface Doubt { disqualifier: Disqualifier; confidence: number; heldForPerson: boolean }

export interface SecondOpinionFinding {
  /** the model gave a valid answer */
  answered: boolean;
  /** it answered and the full combine would have decided every field the same as the route did */
  agreed: boolean;
  /** what the full combine (rules plus this answer) would have decided differently from what the route used */
  changed: OpinionField[];
  /** the buying role it supplies where the title carried no seniority */
  roleFilled: BuyingRole | null;
  doubt: Doubt | null;
}

/**
 * Compares what the route used (the rules alone) with the full combine of the same rules and the model's answer. A doubt is
 * a disqualifier only the model raised: one the combine would have sent to a person (llm_only_disqualifier), or one it would
 * have counted (job seeker, student or media at 0.8 or above).
 */
export function compareSecondOpinion(used: Qualification, full: Qualification): SecondOpinionFinding {
  const answered = !!full.llm;
  const changed = OPINION_FIELDS.filter(f => (f === 'reviewReason' ? used.reviewReason !== full.reviewReason : used.final[f] !== full.final[f]));
  const roleFilled = changed.includes('buyingRole') && full.final.sources?.buyingRole === 'model' ? full.final.buyingRole : null;
  const modelOnly = full.reviewReason === 'llm_only_disqualifier' || full.final.sources?.disqualifier === 'model';
  const disqualifier = full.llmDisqualifier ?? full.final.disqualifier;
  const doubt = modelOnly && full.llm && disqualifier !== 'none'
    ? { disqualifier, confidence: full.llm.confidence, heldForPerson: !!full.reviewReason }
    : null;
  return { answered, agreed: answered && changed.length === 0, changed, roleFilled, doubt };
}

/**
 * Whether a doubt after the alert needs a follow-up and a review item. Only routes the old order would have changed or
 * annotated: R5 (the owner was told of the doubt in the reason, or R4 took a counted disqualifier first), and R8 and R10
 * (R6 held the lead for RevOps before any rep heard). Earlier rules (a drop, a repeat touch, a competitor, R4) and R6 itself
 * decide the same with or without the doubt, so it is recorded only.
 */
export const doubtNeedsFollowUp = (route: Route) => route.rule === 'R5' || ROUND_ROBIN_RULES.includes(route.rule);
