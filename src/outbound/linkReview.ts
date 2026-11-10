// Link review: which registry organization a rate group belongs to, and who said so. The loader links a group only on a
// unique, strong name match (rate_links, decision 20), and that stays the rule. On the August 2026 file many large groups
// that miss it have their real parent as the best candidate at a score of 0.50 to 0.67, and others have a wrong one in the
// same range, so the floor cannot drop: a person looks at the probable ones and records a decision. Pure: the stored link
// and the decision in, the status out. The decision is stored apart from rate_links (rate_link_decisions), keyed on the EIN.
import { GENERIC, nameNorm } from '../resolve/match';
import type { NameLink } from '../resolve';
import type { Candidate } from '../schema';
import { STATE_NAMES } from './states';

/**
 * exact: the loader's own link, a unique, strong match by name and state. probable: a best candidate in the group's state
 * that a person should look at. unlinked: nothing worth showing. confirmed and rejected: a person's decision.
 */
export const LINK_STATUSES = ['exact', 'probable', 'unlinked', 'confirmed', 'rejected'] as const;
export type LinkStatus = typeof LINK_STATUSES[number];

/** A best candidate in the group's state scoring at least this is probable. Under the router's 0.7 floor, on purpose. */
export const PROBABLE_MIN_SCORE = 0.5;

export type Decision = 'confirmed' | 'rejected';

/** A person's decision on one group's link, as stored. */
export interface LinkDecision {
  ein: string;
  decision: Decision;
  /** the registry account confirmed, or for a rejection the candidate that was shown (null when none was) */
  accountId: string | null;
  accountName: string | null;
  /** the name the person typed: sign-in is not built, so this is a claim, not an identity */
  decidedBy: string;
  note: string | null;
  decidedAt: string;
}

export interface LinkReview {
  status: LinkStatus;
  /** the registry account the group belongs to: set only for exact and confirmed, the two that may be named anywhere */
  accountId: string | null;
  accountName: string | null;
  /** the candidate a person is asked about (probable), or was (rejected) */
  probable: Candidate | null;
  /** why the status is what it is, in a few words */
  why: string;
  /** for a probable link, what made it probable: the candidate's distinctive name is in the group's name, or only its score; else null */
  basis: 'name' | 'score' | null;
  decision: LinkDecision | null;
  candidates: Candidate[];
}

/**
 * Words that many provider organizations share, so they say nothing about which one a name is. On the August 2026 file,
 * "Physicians Centre, The" (a hospital) would otherwise be contained in every group with "Physicians" in its name, and "The
 * University of Texas System" in every name with "Texas" in it. State names count among them.
 */
const COMMON_WORDS = new Set([
  ...GENERIC, 'physician', 'physicians', 'clinic', 'clinics', 'group', 'groups', 'partners', 'associates', 'network', 'regional',
  'community', 'memorial', 'county', 'university', 'college', 'school', 'care', 'services', 'specialty', 'specialists', 'providers',
  'authority', 'division', 'sciences', 'science', 'centers', 'centres',
  ...STATE_NAMES.flatMap(n => nameNorm(n).split(' ')),
]);

/** The tokens of a name that say which organization it is: its normalized words without the common ones (health, system, Texas). */
export function distinctiveTokens(name: string): string[] {
  return nameNorm(name).split(' ').filter(t => t && !COMMON_WORDS.has(t));
}

/** Whether every distinctive word of the registry name is in the group's name: "OU Health" in "OU HEALTH PARTNERS". */
export function nameContained(registryName: string, groupName: string): boolean {
  const want = distinctiveTokens(registryName);
  const have = new Set(nameNorm(groupName).split(' '));
  return want.length > 0 && want.every(t => have.has(t));
}

/**
 * The candidate to ask a person about, or null: the best candidate in the group's state, when its distinctive name is
 * contained in the group's name or it scores PROBABLE_MIN_SCORE or more. A candidate in another state is never probable.
 */
export function probableCandidate(groupName: string, state: string | null, candidates: Candidate[]): { candidate: Candidate; why: string; basis: 'name' | 'score' } | null {
  if (!state) return null;
  const best = [...candidates].sort((a, b) => b.score - a.score).find(c => c.state === state);
  if (!best) return null;
  if (nameContained(best.name, groupName)) return { candidate: best, why: `"${best.name}" is contained in the group's name`, basis: 'name' };
  if (best.score >= PROBABLE_MIN_SCORE) return { candidate: best, why: `best candidate in ${state}, score ${best.score.toFixed(2)}`, basis: 'score' };
  return null;
}

const none = (link: NameLink | null) => ({ accountId: null, accountName: null, basis: null, candidates: link?.candidates ?? [] });

/**
 * The review status of one group. The loader's exact link stands (a decision cannot be recorded on it); otherwise a stored
 * decision wins; otherwise the candidates decide between probable and unlinked.
 */
export function linkReviewOf(group: { name: string; state: string | null }, link: NameLink | null, decision: LinkDecision | null): LinkReview {
  if (link?.status === 'linked') {
    return { status: 'exact', accountId: link.accountId, accountName: link.accountName, probable: null, why: `matched by name and state (${link.reason})`, basis: null, decision: null, candidates: link.candidates };
  }
  if (decision?.decision === 'confirmed') {
    return { ...none(link), status: 'confirmed', accountId: decision.accountId, accountName: decision.accountName, probable: null, why: `confirmed by ${decision.decidedBy}`, decision };
  }
  const found = probableCandidate(group.name, group.state, link?.candidates ?? []);
  if (decision?.decision === 'rejected') {
    const shown = decision.accountId ? (link?.candidates ?? []).find(c => c.accountId === decision.accountId) ?? null : null;
    return { ...none(link), status: 'rejected', probable: shown, why: `rejected by ${decision.decidedBy}`, decision };
  }
  if (found) return { ...none(link), status: 'probable', probable: found.candidate, why: found.why, basis: found.basis, decision: null };
  return { ...none(link), status: 'unlinked', probable: null, why: link ? link.reason : 'no link was stored', decision: null };
}

/** Whether a person may record a decision on this group: anything but the loader's exact link. */
export const decidable = (r: LinkReview): boolean => r.status !== 'exact';
