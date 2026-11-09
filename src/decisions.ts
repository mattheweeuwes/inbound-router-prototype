// The pipeline's own decisions, as pure functions: which earlier touch owns a repeat contact, how much account intent a
// lead earns, which rep round-robin picks, whether an alert claims the account, whether a route wants a Slack alert.
// The stages in src/stages.ts read the database, call these, and write the result. Tests call them directly.
import type { DuplicateInfo, Rep } from './route';
import type { SlackPayload } from './notify/slack';
import type { CrmMirrorEntry, Firmographics, Normalized, Owners, Qualification, Resolution, Route, RouteAction, Source, Team } from './schema';

export const DAY = 86_400_000;
/** A contact seen again within this many days is a repeat touch of the same lead. */
export const DEDUPE_DAYS = 30;

export const WEB_INTENT_POINTS = 6, WEB_INTENT_CAP = 12, OTHER_LEAD_POINTS = 4, ACCOUNT_INTENT_CAP = 12;

/** What leads.alert_json holds: the Slack payload (null when the route sends none), and, for a lead that was given up, the RevOps alert. */
export interface StoredAlert { slack: SlackPayload | null; suppressed?: boolean; failure?: SlackPayload }

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
 * follows it, or R2 would attach the demo to Marketing and write no CRM task. `prior` is oldest first; the oldest sales
 * touch owns the lead, and the newest alert that actually went out (not suppressed) is the one the 24-hour rule measures from.
 */
export function summarizeTouches(prior: PriorTouch[]): TouchSummary {
  const live = prior.filter(p => !NOT_LIVE.includes(p.action));
  const withOwner = live.filter(p => WENT_TO_SALES.includes(p.action));
  if (!withOwner.length) return { duplicate: null, priorTouches: live.length };
  let lastAlertAt: string | null = null;
  for (const p of live) if (p.alert?.slack && !p.alert.suppressed) lastAlertAt = p.receivedAt;
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

/**
 * Whether this lead's rep alert claims the account. Only an R8 round-robin alert to a named rep on an account nobody owns,
 * that is not in the CRM mirror, and not a web-intent signal. This stands in for HubSpot's company owner being set by the
 * company upsert, and it is what keeps two reps off one account.
 */
export function claimsAccount(i: ClaimInput): boolean {
  if (!assignsRep(i.route) || i.route.rule !== 'R8') return false;
  const namedRep = (i.owners.teams[i.route.team]?.reps ?? []).some(r => r.name === i.route.owner);
  return namedRep && !!i.accountId && !i.claimedOwner && !i.mirror && i.source !== 'web_intent';
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
