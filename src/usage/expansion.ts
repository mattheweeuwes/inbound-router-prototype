// The expansion rule for customer success. One rule, no routing change, nothing sent:
//
//   a customer account used an add-on's preview at least 3 times in the last 30 days and has no deal for that add-on.
//
// A customer is an account with a closed-won deal for the base product. "No deal" means no deal of any stage for that add-on: a
// won one means they bought it, an open one means sales is on it, and a lost one means they have already said no. The facts
// (uses, people, dates, customer, add-on deals) come from v_usage_expansion; this file is the rule over them, the evidence it
// lists, and the dry-run HubSpot task for the account's owner.
import type { Ctx } from '../context';
import type { CrmRecord } from '../crm/outbox';
import { planExpansionTask } from '../crm/hubspot';
import { hubspotOwnerIdOf } from '../decisions';
import type { AddOnRef, ExpansionRow } from '../store/usage';
import { describeAccount, type AccountInfo } from './account';

export const EXPANSION_MIN_USES = 3;
/** The same number is in sql/models/v_usage_asof_30d.sql; a test moves an event across its edge. */
export const EXPANSION_WINDOW_DAYS = 30;

export const EXPANSION_RULE =
  `A customer account that used an add-on's preview at least ${EXPANSION_MIN_USES} times in the last ${EXPANSION_WINDOW_DAYS} days and has no deal, of any stage, for that add-on. ` +
  `A customer is an account with a closed-won deal for the base product. It lists accounts for customer success to look at; it changes no routing and sends nothing.`;

/** The rule, over one row of v_usage_expansion. */
export const isExpansionSignal = (r: ExpansionRow): boolean =>
  r.is_customer === 1 && r.add_on_deals === 0 && r.uses_30d >= EXPANSION_MIN_USES;

export interface ExpansionSignal {
  account: AccountInfo;
  addOn: AddOnRef;
  feature: { key: string; label: string };
  evidence: { uses: number; people: number; windowFrom: string; windowTo: string; firstUse: string; lastUse: string };
  /** the task and company the reverse ETL would write, built the way a lead's plan is and never sent */
  hubspot: CrmRecord;
}

const DAY_MS = 86_400_000;
const FOLLOW_UP_DAYS = 2;

/** Signals for the as-of date, most use first. Needs the feature and add-on reference rows to name what it lists. */
export function expansionSignals(ctx: Ctx, asOf: string): ExpansionSignal[] {
  const addOns = new Map(ctx.store.usage.addOns().map(a => [a.id, a]));
  const features = new Map(ctx.store.usage.features().map(f => [f.feature, f]));
  const windowFrom = new Date(Date.parse(asOf) - EXPANSION_WINDOW_DAYS * DAY_MS).toISOString();
  const dueAt = new Date(Date.parse(asOf) + FOLLOW_UP_DAYS * DAY_MS).toISOString();
  const out: ExpansionSignal[] = [];
  for (const r of ctx.store.usage.expansion().filter(isExpansionSignal)) {
    const addOn = addOns.get(r.add_on);
    const feature = features.get(r.feature);
    if (!addOn || !feature) continue;
    const account = describeAccount(ctx, r.account_key);
    const plan = planExpansionTask({
      accountKey: account.key, accountName: account.name, segment: account.segment, ownerId: account.owner ? hubspotOwnerIdOf(ctx.owners, account.owner) : null,
      addOnLabel: addOn.label, priceLow: addOn.priceLow, priceHigh: addOn.priceHigh, featureLabel: feature.label,
      uses: r.uses_30d, people: r.contacts_30d, windowFrom, windowTo: asOf, lastUseAt: r.last_use_30d, dueAt,
    });
    out.push({
      account, addOn, feature: { key: feature.feature, label: feature.label },
      evidence: { uses: r.uses_30d, people: r.contacts_30d, windowFrom, windowTo: asOf, firstUse: r.first_use_30d, lastUse: r.last_use_30d },
      hubspot: { mode: 'dry_run', ...plan },
    });
  }
  return out;
}
