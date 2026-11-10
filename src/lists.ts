// Uploaded lists (decision 24), as pure functions: which list an event belongs to, which routes fold into the list's digest
// instead of posting their own alert, where a team's digest goes, and what a digest says. src/listDigest.ts reads the
// database, calls these and records the digest; tests call them directly.
import type { LeadEvent, Route, RouteAction } from './schema';

/** On a folded lead's alert_json: the digest it waits for, then the one it went out in. */
export interface DigestFold {
  list: string;
  team: string;
  channel: string;
  /** when the digest was recorded, on the server clock; null while the list is still arriving */
  at: string | null;
  /** list_digests.id once recorded */
  id: number | null;
}

/** Longest list name kept: it is a label from a payload, not a document. */
const LIST_NAME_MAX = 120;

/**
 * The list an event belongs to, when it came through a list door: the payload's own list or event name, or a stand-in
 * naming the door when it has neither, so a nameless upload still groups. Null for every other door.
 */
export function listNameOf(ev: Pick<LeadEvent, 'source' | 'context'>, listDoors: readonly string[]): string | null {
  if (!listDoors.includes(ev.source)) return null;
  const named = [ev.context.list, ev.context.event].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return named ? named.trim().slice(0, LIST_NAME_MAX) : `${ev.source} (no list name)`;
}

/** Routes whose alert a list folds into its digest. A rep alert (and a repeat that re-alerts its rep) keeps its own alert. */
export const FOLDED_ACTIONS: readonly RouteAction[] = ['team_queue', 'owner_task', 'nurture', 'review'];

export const foldsIntoDigest = (route: Route) => FOLDED_ACTIONS.includes(route.action);

/** Where a team's digest goes: the team's lead channel, RevOps for review, marketing for the nurture team. */
export function digestChannel(team: string): string {
  if (team === 'Review') return '#revops-review';
  if (team === 'Nurture') return '#marketing';
  return `#leads-${team.toLowerCase()}`;
}

/** One list lead as a digest shows it. */
export interface DigestRow {
  leadId: string;
  name: string;
  title: string | null;
  org: string | null;
  /** the company as the badge gave it, for a row the router could not place */
  companyTyped: string | null;
  tier: string | null;
  score: number | null;
  action: string | null;
  /** the booth note, as written */
  note: string | null;
  slaDueAt: string | null;
  /** why a review row is waiting for a person */
  reviewReason: string | null;
  /** the router could not place the organization (unresolved or ambiguous), or inferred it */
  unknownOrg: boolean;
  /** the row is at an enterprise account (decision 25): it stays in the digest, marked and listed first */
  enterprise: boolean;
}

/** What a list batch holds across all teams: the rows accepted since its last digest. */
export interface ListBatch {
  list: string;
  rows: number;
  repeatsAttached: number;
  unknownOrgs: number;
  /** first and last acceptance time in the batch, on the server clock */
  from: string;
  to: string;
}

export const TOP_ROWS = 10;
export const NOTE_CHARS = 120;
/** Review rows listed by name in the RevOps digest; the rest are counted. */
export const REVIEW_ROWS_LISTED = 30;

export interface DigestSummary {
  rows: number;
  byTier: Record<string, number>;
  byAction: Record<string, number>;
  /** enterprise rows first, then the highest scores, ties in acceptance order */
  top: DigestRow[];
  more: number;
  earliestSlaDueAt: string | null;
}

/** Counts, the top rows by score and the earliest SLA due time among one team's folded rows (given in acceptance order). */
export function summarizeDigest(rows: readonly DigestRow[], topN = TOP_ROWS): DigestSummary {
  const byTier: Record<string, number> = {}, byAction: Record<string, number> = {};
  for (const r of rows) {
    const tier = r.tier ?? 'pending', action = r.action ?? 'none';
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    byAction[action] = (byAction[action] ?? 0) + 1;
  }
  const ranked = rows.map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.enterprise) - Number(a.r.enterprise) || (b.r.score ?? -1) - (a.r.score ?? -1) || a.i - b.i).map(x => x.r);
  const due = rows.map(r => r.slaDueAt).filter((d): d is string => !!d).sort();
  return { rows: rows.length, byTier, byAction, top: ranked.slice(0, topN), more: Math.max(0, rows.length - topN), earliestSlaDueAt: due[0] ?? null };
}

/** The booth note cut for a digest line. */
export const cutNote = (note: string | null, max = NOTE_CHARS) => (!note ? null : note.length <= max ? note : `${note.slice(0, max - 3).trimEnd()}...`);
