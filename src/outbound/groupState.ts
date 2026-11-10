// Everything a team needs to know about one group, read on request: its link review, its play, who already has it, its
// status, and the draft (or preview) that goes with that status. The summary, the detail, the export and the HubSpot body
// all read groups through here, so they can never disagree about which groups are ready.
import type { Ctx } from '../context';
import type { OutboundGroup } from '../store/outbound';
import type { Campaign } from './campaign';
import { draftUnavailable, renderDraft, type Draft } from './draft';
import { holdOf, type Hold } from './holds';
import { linkReviewOf, type LinkDecision, type LinkReview } from './linkReview';
import { playOf, type PlayChoice } from './plays';
import { statusOf, type GroupStatus } from './status';
import { renderSystemGapDraft, type SystemGapDraft } from './systemGapDraft';

export interface GroupState {
  group: OutboundGroup;
  review: LinkReview;
  choice: PlayChoice;
  hold: Hold | null;
  status: GroupStatus;
}

/** The account a group is known to belong to: an exact link or a confirmed one. A probable candidate is not. */
export function belongsTo(r: LinkReview): { accountId: string; accountName: string | null } | null {
  return (r.status === 'exact' || r.status === 'confirmed') && r.accountId ? { accountId: r.accountId, accountName: r.accountName } : null;
}

/** One group's state, given its stored decision (read once for the whole file by groupStates). */
function stateWith(ctx: Ctx, g: OutboundGroup, decision: LinkDecision | null): GroupState {
  const review = linkReviewOf(g, ctx.store.outbound.link(g.ein), decision);
  const choice = playOf(g, review);
  const hold = holdOf(ctx, g.name, belongsTo(review));
  return { group: g, review, choice, hold, status: statusOf(choice, g.draftStatus, review, hold, g.draftReason) };
}

export const groupState = (ctx: Ctx, g: OutboundGroup): GroupState => stateWith(ctx, g, ctx.store.outbound.decision(g.ein));

/** Every group's state, in the store's order (state, city, rate). */
export function groupStates(ctx: Ctx, groups: OutboundGroup[] = ctx.store.outbound.allGroups()): GroupState[] {
  const decisions = ctx.store.outbound.decisions();
  return groups.map(g => stateWith(ctx, g, decisions.get(g.ein) ?? null));
}

/** The preview label for a group that gets no draft, when the default one ("not a target") would not say why. */
function previewLabel(s: GroupState): string | undefined {
  if (s.status.status === 'suppressed' && s.hold) return `Preview only: not prospected. ${s.hold.detail}; the finding is a talking point for ${s.hold.owner}, not a draft.`;
  if (s.status.status === 'link_to_confirm') return 'Preview only: a link waits for a person to confirm it, so the draft names the group, not an organization it may belong to.';
  return undefined;
}

export type GroupDraft = Draft | SystemGapDraft;

/**
 * The draft that goes with the group's status: the platform play's draft (ready or blocked), the system-gap draft, or for
 * anything else a labelled preview under the group's own name. Null when the file allows no draft at all.
 */
export function draftOf(s: GroupState, campaign: Campaign): GroupDraft | null {
  if (draftUnavailable(campaign)) return null;
  const g = s.group;
  const preview = () => renderDraft({ finding: g, platform: null, status: 'none', reason: null, hook: g.hook, campaign, previewLabel: previewLabel(s) });
  if (s.status.status === 'suppressed') return preview();
  if (s.choice.play === 'platform') return renderDraft({ finding: g, platform: g.platform, status: g.draftStatus, reason: g.draftReason, hook: g.hook, campaign });
  const system = belongsTo(s.review);
  if (s.choice.play === 'system_gap' && system) {
    return renderSystemGapDraft({ finding: g, system: { name: system.accountName ?? system.accountId, how: s.review.status === 'confirmed' ? 'confirmed' : 'exact' }, campaign });
  }
  return preview();
}
