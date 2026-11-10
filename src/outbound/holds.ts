// Suppression: who already has a group's account. Outbound must not prospect an account that is a customer, owned by a rep,
// or talking to sales inbound; its finding is then a talking point for whoever has it. Read on request, never stored, because
// the CRM mirror, the router's claims and its leads change after the rate file loads.
// Only an account the group belongs to counts (an exact link or a confirmed one): a probable candidate's owner is not the
// group's owner until a person says so. The CRM mirror is also matched on the group's own name, as the router matches a company.
import type { Ctx } from '../context';
import { matchMirror } from '../mirror';

/** An inbound lead at the account this many days back or less means sales is already in conversation. */
export const INBOUND_WINDOW_DAYS = 90;

const STATUS_WORDS: Record<string, string> = { customer: 'a customer', open_opportunity: 'an open opportunity', partner: 'a partner' };

export interface Hold {
  /** crm: the CRM mirror has the account. claim: a rep claimed it on a lead. inbound: a lead came in within the window. */
  by: 'crm' | 'claim' | 'inbound';
  /** who has it: a rep, or the queue an inbound lead went to */
  owner: string;
  /** the account key that holds it (crm:<id>, or the registry key) */
  accountKey: string;
  /** one sentence a person reads: "Tallowmere Health is a customer in the CRM, owned by Jordan" */
  detail: string;
  /** the inbound lead, when that is the reason */
  leadId: string | null;
}

/** The newest lead at an account since a time, as the outbound store reads it. */
export interface RecentLead { id: string; owner: string | null; routeTeam: string | null; receivedAt: string; name: string | null }

const day = (iso: string) => iso.slice(0, 10);

/**
 * Who has this group, or null. Checked in this order: the CRM mirror (on the linked account's name, then the group's own),
 * a rep's claim on the linked account, then an inbound lead at it in the last INBOUND_WINDOW_DAYS days.
 */
export function holdOf(ctx: Ctx, groupName: string, linked: { accountId: string; accountName: string | null } | null): Hold | null {
  const crm = (linked ? matchMirror(ctx.mirror, null, linked.accountName) : null) ?? matchMirror(ctx.mirror, null, groupName);
  if (crm) {
    return { by: 'crm', owner: crm.owner, accountKey: `crm:${crm.id}`, leadId: null, detail: `${crm.name} is ${STATUS_WORDS[crm.status] ?? crm.status} in the CRM, owned by ${crm.owner}` };
  }
  if (!linked) return null;
  const claimed = ctx.store.accounts.claimedOwner(linked.accountId);
  const name = linked.accountName ?? linked.accountId;
  if (claimed) return { by: 'claim', owner: claimed, accountKey: linked.accountId, leadId: null, detail: `${claimed} claimed ${name} on an inbound lead` };
  const since = new Date(ctx.cfg.now() - INBOUND_WINDOW_DAYS * 86_400_000).toISOString();
  const lead = ctx.store.outbound.recentLead(linked.accountId, since);
  if (lead) {
    const owner = lead.owner ?? (lead.routeTeam ? `the ${lead.routeTeam} queue` : 'the router, not yet routed');
    return { by: 'inbound', owner, accountKey: linked.accountId, leadId: lead.id, detail: `${lead.name ?? 'Someone'} at ${name} came in on ${day(lead.receivedAt)}, routed to ${owner}` };
  }
  return null;
}
