// One status per group, which is what a team works from: is there a draft to send, and if not, why. It joins the play
// (plays.ts), the link review (linkReview.ts) and who already has the account (holds.ts). Pure.
import type { Hold } from './holds';
import type { LinkReview } from './linkReview';
import type { PlayChoice } from './plays';
import type { DraftStatus } from './targeting';

/**
 * ready: a draft a rep can review and send. blocked: in a play, but the draft cannot go out yet (the platform mapping is not
 * confirmed). suppressed: someone already has the account, so nobody prospects it. link_to_confirm: a probable link waits for a
 * person, and nothing is claimed until then. not_target: in no play.
 */
export const STATUSES = ['ready', 'blocked', 'suppressed', 'link_to_confirm', 'not_target'] as const;
export type OutboundStatus = typeof STATUSES[number];

export interface GroupStatus { status: OutboundStatus; reason: string }

/**
 * Suppression comes first: a group someone has is never prospected, whatever play it is in. Then the play's own draft state,
 * then a link waiting for a person, then no play.
 */
export function statusOf(choice: PlayChoice, platformDraft: DraftStatus, review: LinkReview, hold: Hold | null, platformDraftReason: string | null): GroupStatus {
  if (hold) return { status: 'suppressed', reason: `Not prospected: ${hold.detail}. The finding is a talking point for ${hold.owner}.` };
  if (choice.play === 'platform') {
    return platformDraft === 'ready'
      ? { status: 'ready', reason: 'Platform play: the mapping is confirmed and the draft is ready for a rep.' }
      : { status: 'blocked', reason: `Platform play, blocked: ${platformDraftReason ?? 'the mapping is not confirmed'}.` };
  }
  if (choice.play === 'system_gap') return { status: 'ready', reason: `System-gap play: ${choice.reason}.` };
  if (review.status === 'probable' && review.probable) {
    const then = choice.ifConfirmed ? ' Confirming it puts the group in the system-gap play.' : ' Confirming it links the group; it would still be in no play.';
    return { status: 'link_to_confirm', reason: `Waiting for a person to confirm or reject ${review.probable.name} (${review.why}).${then}` };
  }
  return { status: 'not_target', reason: `${choice.reason}.` };
}
