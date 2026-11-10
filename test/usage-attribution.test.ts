// The attribution model (sql/models/v_usage_deal_influence.sql and v_usage_feature_influence.sql) on data built to sit on the edges
// of its windows, and the expansion rule (v_usage_expansion.sql and src/usage/expansion.ts) the same way.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import attribution from '../api/attribution';
import { INFLUENCE_WINDOW_DAYS, SMALL_SAMPLE, attributeFeature } from '../src/usage/attribution';
import { EXPANSION_MIN_USES, EXPANSION_WINDOW_DAYS, expansionSignals, isExpansionSignal } from '../src/usage/expansion';
import type { Ctx } from '../src/context';
import { testCtx } from './helpers';
import { ACCT, DAY, OTHER, deal, iso, seeded, t, usage } from './usage-helpers';

const ASOF = '2026-11-06T12:00:00.000Z';
const CREATED = '2026-06-01T12:00:00.000Z';
const CLOSED = '2026-07-01T12:00:00.000Z';

/** The feature rows by key, and the deals each one influenced. */
const influence = (ctx: Ctx) => new Map(ctx.store.usage.featureInfluence().map(r => [r.feature, r]));
const influencedBy = (ctx: Ctx, feature: string) => ctx.store.usage.influencedDeals().filter(d => d.feature === feature).map(d => d.deal_id);

describe('attribution: the window around a deal', () => {
  it('the window is 90 days before creation, both ends included, as the code says', () => {
    assert.equal(INFLUENCE_WINDOW_DAYS, 90);
    const ctx = seeded(ASOF);
    deal(ctx, 'D1', ACCT, CREATED, CLOSED, 'won');
    const edge = t(CREATED) - 90 * DAY;
    usage(ctx, ACCT, 'signal_search', edge); // exactly 90 days before: in
    usage(ctx, ACCT, 'signal_watch', edge - 1); // one millisecond earlier: out
    usage(ctx, ACCT, 'api', edge + 1); // one millisecond inside: in
    assert.deepEqual(influencedBy(ctx, 'signal_search'), ['D1']);
    assert.deepEqual(influencedBy(ctx, 'signal_watch'), []);
    assert.deepEqual(influencedBy(ctx, 'api'), ['D1']);
  });
  it('a closed deal\'s window ends at its close, included: use after it counts for nothing', () => {
    const ctx = seeded(ASOF);
    deal(ctx, 'D1', ACCT, CREATED, CLOSED, 'won');
    usage(ctx, ACCT, 'signal_search', t(CLOSED)); // at the close: in
    usage(ctx, ACCT, 'signal_watch', t(CLOSED) + 1); // just after: out
    usage(ctx, ACCT, 'api', t(CREATED) + 5 * DAY); // while it was open: in
    assert.deepEqual(influencedBy(ctx, 'signal_search'), ['D1']);
    assert.deepEqual(influencedBy(ctx, 'signal_watch'), []);
    assert.deepEqual(influencedBy(ctx, 'api'), ['D1']);
  });
  it('an open deal\'s window runs to the newest event, included', () => {
    const ctx = seeded(ASOF);
    deal(ctx, 'D1', ACCT, CREATED, null, null);
    usage(ctx, ACCT, 'signal_search', ASOF); // the as-of date itself
    usage(ctx, ACCT, 'api', t(CREATED) + 60 * DAY);
    assert.deepEqual(influencedBy(ctx, 'signal_search'), ['D1']);
    assert.deepEqual(influencedBy(ctx, 'api'), ['D1']);
    assert.equal(ctx.store.usage.asOf(), ASOF);
  });
  it('another account\'s use, an unmapped event and an event with no account influence nothing', () => {
    const ctx = seeded(ASOF);
    deal(ctx, 'D1', ACCT, CREATED, CLOSED, 'won');
    usage(ctx, OTHER, 'signal_search', t(CREATED) + DAY);
    usage(ctx, ACCT, null, t(CREATED) + DAY);
    usage(ctx, null, 'signal_search', t(CREATED) + DAY);
    assert.deepEqual(ctx.store.usage.influencedDeals(), []);
    assert.equal(ctx.store.usage.dealTotals().influenced, 0);
  });
  it('counts the uses in the window and reports the first and last of them', () => {
    const ctx = seeded(ASOF);
    deal(ctx, 'D1', ACCT, CREATED, CLOSED, 'won');
    for (const d of [3, 10, 20]) usage(ctx, ACCT, 'api', t(CREATED) + d * DAY);
    usage(ctx, ACCT, 'api', t(CLOSED) + DAY); // after the close: not counted
    const [r] = ctx.store.usage.influencedDeals();
    assert.deepEqual([r.uses, r.first_use_in_window, r.last_use_in_window], [3, iso(t(CREATED) + 3 * DAY), iso(t(CREATED) + 20 * DAY)]);
  });
});

describe('attribution: per feature', () => {
  /** Three closed deals and one open one on the account, all influenced by the API, with first use set per deal. */
  function scenario() {
    const ctx = seeded(ASOF);
    // first use of the API is 2026-03-01 for ACCT and 2026-09-10 for OTHER
    usage(ctx, ACCT, 'api', t('2026-03-01T12:00:00.000Z'));
    usage(ctx, OTHER, 'api', t('2026-09-10T12:00:00.000Z'));
    deal(ctx, 'W1', ACCT, '2026-03-11T12:00:00.000Z', '2026-04-11T12:00:00.000Z', 'won', { amount: 100_000 }); // first use 10 days before it opened
    deal(ctx, 'W2', ACCT, '2026-03-31T12:00:00.000Z', '2026-05-01T12:00:00.000Z', 'won', { amount: 50_000 }); // 30 days
    deal(ctx, 'L1', ACCT, '2026-04-20T12:00:00.000Z', '2026-05-20T12:00:00.000Z', 'lost', { amount: 20_000 }); // 50 days
    deal(ctx, 'O1', OTHER, '2026-09-05T12:00:00.000Z', null, null, { amount: 70_000 }); // first use five days AFTER it opened
    deal(ctx, 'N1', 'crm:mirror-alderfinch', '2026-04-01T12:00:00.000Z', '2026-05-01T12:00:00.000Z', 'won', { amount: 10_000 }); // never used it
    deal(ctx, 'N2', 'crm:mirror-alderfinch', '2026-04-02T12:00:00.000Z', '2026-05-02T12:00:00.000Z', 'lost', { amount: 10_000 });
    return ctx;
  }
  it('splits the influenced deals by outcome with their amounts', () => {
    const r = influence(scenario()).get('api')!;
    assert.deepEqual([r.won_count, r.won_amount, r.lost_count, r.lost_amount, r.open_count, r.open_amount], [2, 150_000, 1, 20_000, 1, 70_000]);
    assert.deepEqual([r.accounts_using, r.events], [2, 2]);
  });
  it('the win rate with use is won over closed among influenced deals; the rate without is every other closed deal', () => {
    const ctx = scenario();
    const f = attributeFeature(influence(ctx).get('api')!, ctx.store.usage.influencedDeals(), ASOF, k => k);
    assert.deepEqual(f.winRate.with, { won: 2, closed: 3, rate: 2 / 3 });
    assert.deepEqual(f.winRate.without, { won: 1, closed: 2, rate: 0.5 }, 'N1 won and N2 lost');
    assert.equal(f.winRate.small, true, 'under 5 closed deals on a side is a small sample');
    assert.equal(SMALL_SAMPLE, 5);
  });
  it('the median days from first use to the deal opening leaves out a deal whose first use came after it opened', () => {
    const ctx = scenario();
    const r = influence(ctx).get('api')!;
    assert.deepEqual([r.median_days, r.median_n, r.used_after_open], [30, 3, 1], 'the median of 10, 30 and 50 days; O1 is counted apart');
  });
  it('the median of an even number of deals is the mean of the middle two', () => {
    const ctx = seeded(ASOF);
    usage(ctx, ACCT, 'api', t('2026-03-01T12:00:00.000Z'));
    deal(ctx, 'A', ACCT, '2026-03-11T12:00:00.000Z', null, null); // 10 days
    deal(ctx, 'B', ACCT, '2026-03-21T12:00:00.000Z', null, null); // 20
    deal(ctx, 'C', ACCT, '2026-04-10T12:00:00.000Z', null, null); // 40
    deal(ctx, 'D', ACCT, '2026-05-10T12:00:00.000Z', null, null); // 70
    assert.equal(influence(ctx).get('api')!.median_days, 30);
  });
  it('a feature nobody used has zero everywhere and no median', () => {
    const r = influence(scenario()).get('mcp')!;
    assert.deepEqual([r.accounts_using, r.events, r.won_count, r.open_count, r.median_days, r.median_n], [0, 0, 0, 0, null, 0]);
  });
  it('adoption since launch is the accounts using the feature of the accounts active since it launched', () => {
    const ctx = seeded(ASOF);
    ctx.store.usage.replaceReference([{ feature: 'api', label: 'API', launchedAt: '2026-05-01T00:00:00.000Z', team: 'T', previewOfAddOn: null }], []);
    usage(ctx, ACCT, 'signal_search', '2026-04-30T23:59:59.999Z'); // before launch: not active since launch
    usage(ctx, ACCT, 'api', '2026-04-30T12:00:00.000Z'); // before launch: not counted as adoption
    usage(ctx, OTHER, 'signal_search', '2026-05-01T00:00:00.000Z'); // at launch: active
    usage(ctx, 'crm:mirror-alderfinch', 'api', '2026-05-02T00:00:00.000Z'); // adopted
    const r = influence(ctx).get('api')!;
    assert.deepEqual([r.active_since_launch, r.using_since_launch, r.accounts_using], [2, 1, 2]);
    const f = attributeFeature(r, [], ASOF, k => k);
    assert.deepEqual(f.adoption, { accounts: 1, of: 2, share: 0.5 });
    assert.equal(f.daysSinceLaunch, 189);
  });
  it('with no deals at all every rate is null, not zero', () => {
    const ctx = seeded(ASOF);
    usage(ctx, ACCT, 'api', '2026-05-02T00:00:00.000Z');
    const f = attributeFeature(influence(ctx).get('api')!, [], ASOF, k => k);
    assert.deepEqual([f.winRate.with.rate, f.winRate.without.rate, f.firstUseToOpportunity.medianDays], [null, null, null]);
  });
});

describe('attribution: the API', () => {
  it('says what the numbers are, shows the counts, and labels the data synthetic', async () => {
    const ctx = seeded(ASOF);
    deal(ctx, 'D1', ACCT, CREATED, CLOSED, 'won');
    usage(ctx, ACCT, 'api', t(CREATED) + DAY);
    const body = await (await attribution(new Request('http://local/api/attribution'), ctx)).json();
    assert.equal(body.loaded, true);
    assert.match(body.model.caveat, /influence, not proof of cause/i);
    assert.match(body.model.definition, /90 days/);
    assert.equal(body.model.windowDays, 90);
    assert.equal(body.synthetic.allSynthetic, true);
    assert.deepEqual(body.data.deals.influenced, { count: 1, amount: 100_000 });
    const api = body.features.find((f: { feature: string }) => f.feature === 'api');
    assert.deepEqual([api.opportunities, api.winRate.with], [{ count: 1, amount: 100_000 }, { won: 1, closed: 1, rate: 1 }]);
    assert.equal(api.deals[0].id, 'D1');
  });
  it('a row that is not synthetic turns the flag off, and the counts say how many are', async () => {
    const ctx = seeded(ASOF);
    usage(ctx, ACCT, 'api', t(CREATED), { synthetic: false });
    const body = await (await attribution(new Request('http://local/api/attribution'), ctx)).json();
    assert.deepEqual([body.synthetic.allSynthetic, body.synthetic.events, body.data.events.total], [false, 1, 2]);
  });
  it('with no features loaded it answers loaded false and says why, and only GET is allowed', async () => {
    const ctx = testCtx();
    const body = await (await attribution(new Request('http://local/api/attribution'), ctx)).json();
    assert.deepEqual([body.loaded, body.features], [false, []]);
    assert.match(body.reason, /switched off/);
    assert.equal((await attribution(new Request('http://local/api/attribution', { method: 'POST' }), ctx)).status, 405);
  });
});

describe('expansion signals', () => {
  /** A customer: a closed-won base-product deal. */
  const customer = (ctx: Ctx, account: string) => deal(ctx, `base-${account}`, account, '2026-01-05T12:00:00.000Z', '2026-02-05T12:00:00.000Z', 'won');
  const previews = (ctx: Ctx, account: string, n: number, from = t(ASOF) - 5 * DAY) => { for (let i = 0; i < n; i++) usage(ctx, account, 'quality_preview', from + i * 60_000); };
  const signals = (ctx: Ctx) => expansionSignals(ctx, ctx.store.usage.asOf()).map(s => s.account.key);

  it('a customer with three preview uses in 30 days and no add-on deal is listed, with its evidence', () => {
    const ctx = seeded(ASOF);
    customer(ctx, ACCT);
    previews(ctx, ACCT, 3);
    assert.equal(EXPANSION_MIN_USES, 3);
    const [s] = expansionSignals(ctx, ASOF);
    assert.equal(s.account.name, 'Wrenfield Health');
    assert.deepEqual([s.evidence.uses, s.addOn.id, s.feature.key, s.evidence.windowFrom, s.evidence.windowTo], [3, 'provider_quality_data', 'quality_preview', iso(t(ASOF) - 30 * DAY), ASOF]);
  });
  it('two uses are not enough', () => {
    const ctx = seeded(ASOF);
    customer(ctx, ACCT);
    previews(ctx, ACCT, 2);
    assert.deepEqual(signals(ctx), []);
  });
  it('the window is 30 days to the newest event, both ends included', () => {
    assert.equal(EXPANSION_WINDOW_DAYS, 30);
    const ctx = seeded(ASOF);
    customer(ctx, ACCT);
    usage(ctx, ACCT, 'quality_preview', t(ASOF) - 30 * DAY); // exactly 30 days back: in
    usage(ctx, ACCT, 'quality_preview', t(ASOF)); // the as-of date: in
    usage(ctx, ACCT, 'quality_preview', t(ASOF) - 30 * DAY - 1); // one millisecond outside
    assert.deepEqual(signals(ctx), [], 'two inside, one outside');
    usage(ctx, ACCT, 'quality_preview', t(ASOF) - 2 * DAY);
    assert.deepEqual(signals(ctx), [ACCT]);
  });
  it('an account that is not a customer is not listed: no deal, an open deal, a lost deal and a won add-on deal alone do not make one', () => {
    const ctx = seeded(ASOF);
    previews(ctx, ACCT, 4);
    assert.deepEqual(signals(ctx), [], 'no deal at all');
    deal(ctx, 'o', ACCT, '2026-09-01T12:00:00.000Z', null, null);
    deal(ctx, 'l', ACCT, '2026-02-01T12:00:00.000Z', '2026-03-01T12:00:00.000Z', 'lost');
    deal(ctx, 'a', ACCT, '2026-03-01T12:00:00.000Z', '2026-04-01T12:00:00.000Z', 'won', { addOn: 'provider_quality_data' });
    assert.deepEqual(signals(ctx), []);
  });
  for (const [label, outcome, closed] of [['won', 'won', '2026-10-01T12:00:00.000Z'], ['lost', 'lost', '2026-10-01T12:00:00.000Z'], ['open', null, null]] as const) {
    it(`a ${label} deal for the add-on, of any stage, takes the account off the list`, () => {
      const ctx = seeded(ASOF);
      customer(ctx, ACCT);
      previews(ctx, ACCT, 5);
      assert.deepEqual(signals(ctx), [ACCT]);
      deal(ctx, 'addon', ACCT, '2026-09-20T12:00:00.000Z', closed, outcome, { addOn: 'provider_quality_data' });
      assert.deepEqual(signals(ctx), []);
    });
  }
  it('a deal for another purpose does not take it off the list, and the rule reads only the add-on\'s preview feature', () => {
    const ctx = seeded(ASOF);
    customer(ctx, ACCT);
    deal(ctx, 'seats', ACCT, '2026-09-20T12:00:00.000Z', null, null);
    for (let i = 0; i < 6; i++) usage(ctx, ACCT, 'signal_search', t(ASOF) - i * DAY);
    assert.deepEqual(signals(ctx), [], 'search is not a preview');
    previews(ctx, ACCT, 3);
    assert.deepEqual(signals(ctx), [ACCT]);
  });
  it('lists the most use first and builds the dry-run task for the owner without sending anything', () => {
    const ctx = seeded(ASOF);
    customer(ctx, ACCT); customer(ctx, OTHER);
    previews(ctx, ACCT, 3); previews(ctx, OTHER, 6);
    const list = expansionSignals(ctx, ASOF);
    assert.deepEqual(list.map(s => s.account.key), [OTHER, ACCT]);
    const h = list[1].hubspot;
    assert.equal(h.mode, 'dry_run');
    assert.deepEqual(h.requests.map(r => r.path), ['/crm/v3/objects/companies/batch/upsert', '/crm/v3/objects/tasks']);
    const props = (h.requests[1].body as { properties: Record<string, string> }).properties;
    assert.equal(props.hubspot_owner_id, '900001', 'Avery, the mirror owner of Wrenfield');
    assert.match(props.hs_task_body, /Wrenfield Health used quality_preview 3 times/);
    assert.match(props.hs_task_body, /It has no Provider quality data deal at any stage/);
    assert.match(props.hs_task_body, /\$30,000 to \$50,000/);
    assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS n FROM crm_outbox`).get()!.n, 0, 'never put in the outbox, so a live boot cannot send it');
  });
  it('the rule is the three conditions over one row of the view', () => {
    const row = { account_key: 'k', add_on: 'a', feature: 'f', uses_30d: 3, contacts_30d: 1, first_use_30d: '', last_use_30d: '', is_customer: 1, add_on_deals: 0 };
    assert.equal(isExpansionSignal(row), true);
    assert.equal(isExpansionSignal({ ...row, uses_30d: 2 }), false);
    assert.equal(isExpansionSignal({ ...row, is_customer: 0 }), false);
    assert.equal(isExpansionSignal({ ...row, add_on_deals: 1 }), false);
  });
});
