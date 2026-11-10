// The Feature to pipeline tab's logic with no DOM (public/feature-pipeline-model.js), run on what GET /api/attribution returns for the
// shipped usage fixtures: how rates and counts are worded, how the bars split, and what the headline says.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import handler from '../api/attribution';
import { buildAddress, parseAddress } from '../public/address-model.js';
import { ROOT } from '../src/config';
import {
  ASKED_SORTS, FEATURE_SORTS, adoptionWords, askedCountLine, askedCounts, askedHow, barSegments, defaultView, filterAsked, fromParams, isSalesReady, sortAsked, sortFeatures, toParams,
  type Asked, cueSummary, interestWords, launchWords, provenanceBadges, day, evidenceWords, headline, leadTimeWords, money, moneyShort, priceRange, rateWords, sampleNote, type Feature, type Loaded,
} from '../public/feature-pipeline-model.js';
import { testCtx } from './helpers';

const load = async (): Promise<Loaded> =>
  (await (await handler(new Request('http://local/api/attribution'), testCtx({ usageFixtures: join(ROOT, 'fixtures', 'usage') }))).json()) as Loaded;
const feature = (d: Loaded, key: string) => d.features.find(f => f.feature === key) as Feature;

describe('cockpit feature to pipeline: wording', () => {
  it('money in full and short', () => {
    assert.deepEqual([money(2058000), money(0), money(45000.4)], ['$2,058,000', '$0', '$45,000']);
    assert.deepEqual([moneyShort(2188000), moneyShort(1092000), moneyShort(601000), moneyShort(900), moneyShort(2000000)], ['$2.19M', '$1.09M', '$601k', '$900', '$2M']);
  });
  it('a rate is a whole percent with the counts it rests on, and no closed deals is not zero', () => {
    assert.deepEqual(rateWords({ won: 9, closed: 15, rate: 0.6 }), { pct: '60%', counts: '9 of 15 closed' });
    assert.deepEqual(rateWords({ won: 0, closed: 0, rate: null }), { pct: 'n/a', counts: 'no closed deals' });
    assert.deepEqual(rateWords({ won: 0, closed: 4, rate: 0 }), { pct: '0%', counts: '0 of 4 closed' });
  });
  it('the sample note names both counts, and says nothing when both sides have enough', async () => {
    const d = await load();
    assert.match(sampleNote(feature(d, 'signal_search'), d.model.smallSample) ?? '', /15 closed deals with use, 2 closed deals without \(under 5 on a side\)\. Do not read this as an effect\./);
    assert.equal(sampleNote(feature(d, 'api'), d.model.smallSample), null);
  });
  it('adoption and lead time carry their counts, including the deals left out of the median', async () => {
    const d = await load();
    assert.deepEqual(adoptionWords(feature(d, 'signal_search')), { pct: '92%', counts: '11 of 12 accounts' });
    assert.deepEqual(leadTimeWords(feature(d, 'signal_search')), { value: '20 d', counts: '19 deals; 1 used it only after opening' });
    const none = { ...feature(d, 'mcp'), adoption: { accounts: 0, of: 0, share: null }, firstUseToOpportunity: { medianDays: null, deals: 0, usedAfterOpen: 2 } };
    assert.deepEqual(adoptionWords(none), { pct: 'n/a', counts: 'no accounts active since launch' });
    assert.deepEqual(leadTimeWords(none), { value: 'n/a', counts: '2 deals used it only after opening' });
  });
  it('the headline gives the share of deals with a feature around them and the feature around the most pipeline', async () => {
    const d = await load();
    assert.equal(headline(d), '22 of 22 deals had an account using at least one tracked feature in the 90 days before it opened or while it was open. Signal search was around the most pipeline: 20 deals, $2,058,000.');
    assert.equal(headline({ ...d, data: { ...d.data, deals: { ...d.data.deals, total: 0 } } }), 'There are no deals to attribute yet.');
  });
  it('the evidence for a signal reads as one sentence with its dates and counts, and the price range as dollars', async () => {
    const d = await load();
    const s = d.expansion.signals[0];
    assert.equal(evidenceWords(s), '5 uses of Quality data preview in the 30 days to 2026-11-06, by 3 people, the last on 2026-11-04.');
    assert.equal(priceRange(s.addOn), '$30,000 to $50,000');
    assert.equal(day('2026-11-06T21:38:05.000Z'), '2026-11-06');
  });
});

describe('cockpit feature to pipeline: the bars', () => {
  it('each outcome gets its share of the longest bar, won then open then lost, and the longest bar fills the track', async () => {
    const d = await load();
    const max = Math.max(...d.features.map(f => f.opportunities.amount));
    const top = d.features.find(f => f.opportunities.amount === max) as Feature;
    const segs = barSegments(top, max);
    assert.deepEqual(segs.map(s => s.key), ['won', 'open', 'lost']);
    assert.ok(Math.abs(segs.reduce((a, s) => a + s.pct, 0) - 100) < 1e-9);
    for (const f of d.features) {
      const s = barSegments(f, max);
      assert.ok(Math.abs(s.reduce((a, x) => a + x.pct, 0) - (100 * f.opportunities.amount) / max) < 1e-9, f.feature);
      assert.equal(s.some(x => x.count === 0), false, 'a zero outcome has no segment');
    }
  });
  it('with nothing to draw there is no width', async () => {
    const d = await load();
    assert.deepEqual(barSegments({ ...feature(d, 'mcp'), byOutcome: { won: { count: 0, amount: 0 }, open: { count: 0, amount: 0 }, lost: { count: 0, amount: 0 } } }, 0), []);
  });
});

describe('cockpit feature to pipeline: interest from inbound', () => {
  it('a feature in preview says it has no launch date, and its adoption is n/a because it is not launched', async () => {
    const d = await load();
    const ask = feature(d, 'signal_ask');
    assert.equal(launchWords(ask), 'in preview, no launch date');
    assert.equal(launchWords(feature(d, 'api')), 'launched 2025-11-03');
    assert.deepEqual(adoptionWords(ask), { pct: 'n/a', counts: 'not launched' });
  });
  it('the interest column carries the people, accounts and sales-ready behind the count', async () => {
    const d = await load();
    const f = feature(d, 'network_benchmarking');
    assert.deepEqual(interestWords(f), { value: '0', counts: 'nobody has asked' });
    const asked = { ...f, interest: { leads: 3, accounts: 2, salesReady: 1, byTier: {}, byCue: { message: 2, door: 0, path: 1, guide: 0 }, sinceLaunch: 3 } };
    assert.deepEqual(interestWords(asked), { value: '3', counts: '2 accounts, 1 sales-ready' });
    assert.equal(cueSummary(asked), '2 in their message, 1 by pages visited');
    assert.equal(cueSummary(f), '');
  });
  it('an asked-for item says how the person showed it, strongest cue first', () => {
    const a = { leadId: 'l', accountKey: null, accountName: 'X', owner: null, customer: false, tier: null, person: null, door: 'web_intent', cue: 'path' as const, cues: ['path' as const], evidence: ['/p/: 2 visits'], quote: null, at: '2026-11-10T00:00:00.000Z' };
    assert.equal(askedHow(a), 'by pages visited: /p/: 2 visits');
  });
  it('two badges keep usage and deals apart from the lead stream, and say how many people are invented when not all are', async () => {
    const d = await load();
    assert.deepEqual(provenanceBadges(d).map(b => [b.kind, b.text]), [['usage', 'SYNTHETIC: USAGE AND DEALS'], ['interest', 'LEAD STREAM: NO PEOPLE YET']]);
    const mixed = { ...d, synthetic: { ...d.synthetic, interest: { ...d.synthetic.interest, leads: 5, synthetic: 3, allSynthetic: false } } };
    assert.equal(provenanceBadges(mixed)[1].text, 'LEAD STREAM: 3 of 5 people invented');
    assert.equal(provenanceBadges({ ...d, synthetic: { ...d.synthetic, interest: { ...d.synthetic.interest, leads: 5, synthetic: 5, allSynthetic: true } } })[1].text, 'LEAD STREAM: PEOPLE INVENTED');
  });
});

const person = (over: Partial<Asked> & { n: number }): Asked => ({
  leadId: `L${over.n}`, accountKey: `ahrq:${over.n}`, accountName: `Account ${over.n}`, owner: 'Avery', customer: false, tier: 'C', person: { name: `Person ${over.n}`, title: 'Director' },
  door: 'calendly_demo', cue: 'message', cues: ['message'], evidence: ['"x"'], quote: 'a quote', at: new Date(Date.UTC(2026, 10, over.n)).toISOString(), ...over,
});

describe('cockpit feature to pipeline: sorting the features table', () => {
  it('sorts numbers as numbers and words A to Z, and puts a missing value last either way', async () => {
    const d = await load();
    const by = (key: string, dir: 'asc' | 'desc') => sortFeatures(d.features, { key, dir });
    const deals = by('deals', 'desc').map(f => f.opportunities.count);
    assert.deepEqual(deals, [...deals].sort((a, b) => b - a));
    const names = by('feature', 'asc').map(f => f.label.toLowerCase());
    assert.deepEqual(names, [...names].sort());
    for (const dir of ['asc', 'desc'] as const) {
      const rates = by('withRate', dir).map(f => f.winRate.with.rate);
      const firstNull = rates.findIndex(r => r === null);
      assert.ok(firstNull === -1 || rates.slice(firstNull).every(r => r === null), `a feature with no closed deals goes last (${dir})`);
    }
    assert.deepEqual(by('', 'asc').map(f => f.feature), d.features.map(f => f.feature), 'with no column chosen the API order stands');
    assert.deepEqual(Object.keys(FEATURE_SORTS).length, 9, 'every column of the table sorts');
  });
  it('rows that tie keep the API order', async () => {
    const d = await load();
    const tied = sortFeatures(d.features.map(f => ({ ...f, accountsUsing: 1 })), { key: 'accounts', dir: 'asc' });
    assert.deepEqual(tied.map(f => f.feature), d.features.map(f => f.feature));
  });
});

describe('cockpit feature to pipeline: who asked', () => {
  const asked = [
    person({ n: 1, customer: true, tier: 'A', cue: 'message', cues: ['message', 'door'] }),
    person({ n: 2, customer: true, tier: 'D', cue: 'door', cues: ['door'], quote: null }),
    person({ n: 3, customer: false, tier: 'B', cue: 'path', cues: ['path'] }),
    person({ n: 4, customer: false, tier: null, accountName: null, accountKey: null, person: null, cue: 'guide', cues: ['guide'] }),
  ];
  const none = { customers: false, ready: false, cue: '' } as const;
  const ids = (a: Asked[]) => a.map(x => x.leadId);

  it('Customers only, Sales-ready only and one cue each keep what they say, and combine', () => {
    assert.deepEqual(ids(filterAsked(asked, none)), ['L1', 'L2', 'L3', 'L4']);
    assert.deepEqual(ids(filterAsked(asked, { ...none, customers: true })), ['L1', 'L2']);
    assert.deepEqual(ids(filterAsked(asked, { ...none, ready: true })), ['L1', 'L3']);
    assert.deepEqual(ids(filterAsked(asked, { ...none, customers: true, ready: true })), ['L1']);
    assert.deepEqual(ids(filterAsked(asked, { ...none, cue: 'door' })), ['L1', 'L2'], 'a person counts under every cue they showed');
    assert.deepEqual(ids(filterAsked(asked, { customers: true, ready: false, cue: 'message' })), ['L1']);
    assert.deepEqual([asked[0], asked[2], asked[1], asked[3]].map(isSalesReady), [true, true, false, false]);
  });
  it('each filter shows the count it would leave, with the others as they are', () => {
    assert.deepEqual(askedCounts(asked, none), { customers: 2, ready: 2, cue: { message: 1, door: 2, path: 1, guide: 1 } });
    assert.deepEqual(askedCounts(asked, { ...none, customers: true }), { customers: 2, ready: 1, cue: { message: 1, door: 2, path: 0, guide: 0 } });
    assert.equal(askedCountLine(2, 4), '2 of 4 asked');
  });
  it('sorts by when, newest first to start, and by account A to Z with a person who has no account last', () => {
    assert.deepEqual(ids(sortAsked(asked, { key: 'when', dir: 'desc' })), ['L4', 'L3', 'L2', 'L1']);
    assert.deepEqual(ids(sortAsked(asked, { key: 'when', dir: 'asc' })), ['L1', 'L2', 'L3', 'L4']);
    assert.deepEqual(ids(sortAsked(asked, { key: 'account', dir: 'asc' })), ['L1', 'L2', 'L3', 'L4']);
    assert.deepEqual(ids(sortAsked(asked, { key: 'account', dir: 'desc' })), ['L3', 'L2', 'L1', 'L4']);
    assert.deepEqual([ASKED_SORTS.when.first, ASKED_SORTS.account.first], ['desc', 'asc']);
  });
  it('the real asked list carries a tier, so sales-ready can be filtered', async () => {
    const d = await load();
    for (const f of d.features) for (const a of f.asked) assert.ok('tier' in a, `${f.feature}: ${a.leadId}`);
  });
  it('the view is written to the address without its defaults, and read back', () => {
    assert.equal(buildAddress('feature-pipeline', toParams(defaultView())), '#feature');
    const v = { ...defaultView(), feature: 'network_benchmarking', asked: { customers: true, ready: true, cue: 'message' as const }, features: { key: 'deals', dir: 'asc' as const }, askedSort: { key: 'account', dir: 'desc' as const } };
    const hash = buildAddress('feature-pipeline', toParams(v));
    assert.equal(hash, '#feature?f=network_benchmarking&customers=1&ready=1&cue=message&sort=deals&dir=asc&asort=account&adir=desc');
    assert.deepEqual(fromParams(parseAddress(hash).params), v);
    assert.deepEqual(fromParams(parseAddress('#feature?cue=bogus&sort=nope&asort=nope&adir=up').params), defaultView());
  });
});
