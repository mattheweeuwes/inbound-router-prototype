// The outbound plays: which team can work a group, and why a group is in none. Two plays, each a rule in one place.
// - platform (decision 20): a behavioral health platform from the hand-made mapping; its targets, hooks, drafts and blocked
//   states are the loader's, unchanged.
// - system_gap (decision 27): a group that belongs to a registry hospital or health system, is not small, and is paid well
//   under another group in its own city. That is the Health Systems team's opening: the system holds the leverage the take-home
//   describes, and its own physician group is not getting it.
// Pure: the stored group and its link review in, the play out. Who already has the account is decided after (status.ts).
import { cents } from './campaign';
import type { LinkReview } from './linkReview';
import type { OutboundGroup } from '../store/outbound';

export const PLAYS = ['platform', 'system_gap'] as const;
export type Play = typeof PLAYS[number];

/** The words for each play, for the API and the cockpit. */
export const PLAY_NAMES: Record<Play, string> = { platform: 'Platform', system_gap: 'System gap' };

/**
 * The team that works each play. A behavioral health platform is a provider group and a health system is a health system,
 * and the router sends both segments to Health Systems & Providers (teamFor in src/route.ts).
 */
export const PLAY_TEAMS: Record<Play, string> = { platform: 'HSP', system_gap: 'HSP' };

/**
 * The system-gap rule. A group qualifies when it links to a registry hospital or health system (an exact link or a confirmed
 * one), has more than MIN_CLINICIANS clinicians, and another group in the same city is paid at least MIN_GAP_PCT percent more
 * for the code. The city's top rate is the comparison, so the gap is the largest one in the city.
 */
export const SYSTEM_GAP = { minClinicians: 50, minGapPct: 20 } as const;

/** Registry account kinds that are hospitals or health systems (AHRQ systems and CMS hospitals). */
export const isHospitalAccount = (accountId: string | null): boolean => !!accountId && /^(ahrq|ccn):/.test(accountId);

/** How far the city's top rate is above the group's, in whole percent rounded down so the draft never overstates it; null when the group holds the top. */
export function cityGap(g: Pick<OutboundGroup, 'ein' | 'rate' | 'cityTopRate' | 'cityTopEin'>): number | null {
  if (g.cityTopEin === g.ein || g.cityTopRate <= g.rate) return null;
  return Math.floor((g.cityTopRate / g.rate - 1) * 100 + 1e-9);
}

export interface PlayChoice {
  play: Play | null;
  /** why it is in its play, or in none */
  reason: string;
  /** a play the group would join if a person confirmed its probable link */
  ifConfirmed: Play | null;
}

/** Why a group with this registry account does or does not meet the system-gap rule; null when it does. */
function systemGapMiss(g: OutboundGroup, accountId: string | null, accountName: string | null): string | null {
  if (!accountId) return 'it is not linked to a registry organization';
  if (!isHospitalAccount(accountId)) return `${accountName ?? accountId} is not a hospital or health system`;
  if (g.clinicians <= SYSTEM_GAP.minClinicians) return `it has ${SYSTEM_GAP.minClinicians} or fewer clinicians`;
  const gap = cityGap(g);
  const place = g.city || 'its city';
  if (gap === null) return `it holds the top rate in ${place}`;
  if (gap < SYSTEM_GAP.minGapPct) return `the top rate in ${place} (${cents(g.cityTopRate)}) is only ${gap}% above its own, under ${SYSTEM_GAP.minGapPct}%`;
  return null;
}

/** The group's play. The platform play comes first and is the loader's; the system-gap play reads the link review. */
export function playOf(g: OutboundGroup, review: LinkReview): PlayChoice {
  if (g.fit === 'target') return { play: 'platform', reason: g.fitReason, ifConfirmed: null };
  const linked = review.status === 'exact' || review.status === 'confirmed';
  const miss = systemGapMiss(g, linked ? review.accountId : null, linked ? review.accountName : null);
  if (!miss) {
    const gap = cityGap(g);
    return { play: 'system_gap', ifConfirmed: null, reason: `Part of ${review.accountName}, ${g.clinicians.toLocaleString('en-US')} clinicians, and the top rate in ${g.city} (${cents(g.cityTopRate)}) is ${gap}% above its own` };
  }
  const probable = review.status === 'probable' ? review.probable : null;
  const wouldQualify = probable !== null && !systemGapMiss(g, probable.accountId, probable.name);
  return { play: null, reason: `${g.fitReason}. Not in the system-gap play: ${miss}`, ifConfirmed: wouldQualify ? 'system_gap' : null };
}
