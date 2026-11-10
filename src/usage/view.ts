// API read model for GET /api/attribution: the influence model per feature, the expansion signals, what the data is, and what was
// left out of it (unmapped and unresolved events). Read-only; everything comes from the tables and views the loader and the
// ingest filled.
import type { Ctx } from '../context';
import { askedOf, groupByFeature, interestOf, interestProvenance } from '../interest/view';
import { describeAccount } from './account';
import { attributeFeatures, CAVEAT, DEFINITION, INFLUENCE_WINDOW_DAYS, SMALL_SAMPLE } from './attribution';
import { EXPANSION_MIN_USES, EXPANSION_RULE, EXPANSION_WINDOW_DAYS, expansionSignals } from './expansion';

/** What the page says instead of the tab when there is nothing to show. */
function notLoadedReason(ctx: Ctx): string {
  const u = ctx.usage;
  if (u.status === 'off') return 'The usage fixtures are switched off for this server.';
  if (u.status === 'failed') return `The usage fixtures could not be loaded: ${u.message}`;
  return `No features are loaded. ${u.message}.`;
}

/** GET /api/attribution */
export function attributionPayload(ctx: Ctx) {
  const store = ctx.store.usage;
  const features = store.features();
  if (!features.length) {
    return { loaded: false, status: ctx.usage.status, reason: notLoadedReason(ctx), features: [], signals: [] };
  }
  const asOf = store.asOf();
  const events = store.eventTotals();
  const deals = store.dealTotals();
  const accountName = (key: string) => describeAccount(ctx, key).name;
  const signals = expansionSignals(ctx, asOf);
  const tags = ctx.store.interest.rows();
  const tagsByFeature = groupByFeature(tags);
  const interest = interestProvenance(tags);
  return {
    loaded: true, status: ctx.usage.status, reason: null,
    asOf,
    model: {
      kind: 'influence',
      windowDays: INFLUENCE_WINDOW_DAYS,
      definition: DEFINITION,
      caveat: CAVEAT,
      smallSample: SMALL_SAMPLE,
      note: 'Win rate with use is won / closed among the deals a feature influenced. Win rate without is the same over every other closed deal. Counts are shown beside every rate.',
    },
    // synthetic: how much of what the numbers rest on is invented. allSynthetic is true when every event and deal is.
    synthetic: {
      events: events.synthetic, deals: deals.synthetic, allSynthetic: events.synthetic === events.total && deals.synthetic === deals.total,
      note: 'Usage and deals are invented, on fictional accounts on the reserved .example domain.',
      // interest is read from the router's own lead stream, which is a different kind of data from the usage and deals beside it
      interest: {
        leads: interest.leads, synthetic: interest.synthetic, allSynthetic: interest.allSynthetic,
        note: 'Interest comes from the router\'s own lead stream: its people are invented, and its organizations are the ones in the stream.',
      },
    },
    data: {
      accounts: store.accountsInData(),
      events: { total: events.total, mapped: events.mapped, unmapped: events.unmapped, unresolved: events.unresolved },
      deals: {
        total: deals.total, open: { count: deals.open_count, amount: deals.open_amount }, won: { count: deals.won_count, amount: deals.won_amount },
        lost: { count: deals.lost_count, amount: deals.lost_amount }, influenced: { count: deals.influenced, amount: deals.influenced_amount },
      },
      unmappedByName: store.unmappedByName().map(r => ({ event: r.event, count: r.n })),
    },
    features: attributeFeatures(store.featureInfluence(), store.influencedDeals(), asOf, accountName).map(f => {
      const mine = tagsByFeature.get(f.feature) ?? [];
      return { ...f, interest: interestOf(mine, f.launchedAt), asked: askedOf(ctx, mine) };
    }),
    expansion: { rule: EXPANSION_RULE, minUses: EXPANSION_MIN_USES, windowDays: EXPANSION_WINDOW_DAYS, signals },
  };
}
