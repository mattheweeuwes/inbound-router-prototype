// A lead's signals beyond the classifier (decisions 25 and 26): the account's enterprise flag, the deal-size cues in the
// message, and a named referral resolved to an organization. The rules are pure (src/enterprise.ts, src/dealCues.ts,
// src/referral.ts); this file supplies what they read from the world: the CRM mirror, the registry matcher and owners.
// Nothing here calls the network or the model.
import type { Ctx } from './context';
import { findDealCues } from './dealCues';
import { enterpriseOf, type DealSignals } from './enterprise';
import { matchMirror } from './mirror';
import { captureReferrals, referralAnswerOf, resolveReferral, type Referral, type ReferrerAccount, type ReferrerLookups } from './referral';
import { resolveByName } from './resolve';
import type { CrmMirrorEntry, LeadEvent, Normalized, Resolution } from './schema';

/** The account's size and the message's deal-size cues. Read from the resolution and the prospect's own words only. */
export const dealSignalsOf = (res: Resolution, n: Normalized): DealSignals => ({
  enterprise: enterpriseOf(res.segment, res.firmographics),
  cues: findDealCues(n.message),
});

const fromMirror = (m: CrmMirrorEntry): ReferrerAccount => ({
  key: `crm:${m.id}`, name: m.name, customer: m.status === 'customer', owner: m.owner, matchedBy: 'crm',
});

/**
 * The lookups a referrer is resolved with: the CRM mirror's accounts by name first (that is where the fictional customers
 * are), then the registry through the resolver's own name matcher, which links only a unique, strong match. A registry
 * account's owner is a rep who claimed it on an earlier lead; the mirror never holds a real organization.
 */
export function referrerLookups(ctx: Ctx): ReferrerLookups {
  return {
    crm: words => {
      const m = matchMirror(ctx.mirror, null, words);
      return m ? fromMirror(m) : null;
    },
    registry: name => {
      const link = resolveByName(ctx, name, null);
      if (link.status !== 'linked' || !link.accountId) return null;
      const mirrored = matchMirror(ctx.mirror, null, link.accountName);
      if (mirrored) return fromMirror(mirrored);
      return { key: link.accountId, name: link.accountName ?? name, customer: false, owner: ctx.store.accounts.claimedOwner(link.accountId), matchedBy: 'registry' };
    },
  };
}

/** The lead's named referral, from the door's "How did you hear about us?" answer and the message, or null when it names none. */
export function referralOf(ctx: Ctx, ev: LeadEvent, n: Normalized, res: Resolution): Referral | null {
  const captures = captureReferrals(referralAnswerOf(ev.context), n.message);
  return captures.length ? resolveReferral(captures, referrerLookups(ctx), res.accountId) : null;
}
