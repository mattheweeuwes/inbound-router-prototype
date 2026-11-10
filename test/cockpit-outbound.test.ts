// The Outbound tab's logic with no DOM (public/outbound-model.js), run on the groups the API returns for the invented rate file:
// what each filter keeps, how a click sorts, the headline, and where the chart puts things.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import handler from '../api/outbound';
import {
  bandWords, chartGeometry, filterGroups, fitLabel, formCounts, formLabel, headline, median, sortGroups, statesOf, type Group, type Loaded,
} from '../public/outbound-model.js';
import { testCtx } from './helpers';

const load = async (): Promise<Loaded> => (await (await handler(new Request('http://local/api/outbound'), testCtx())).json()) as Loaded;
const want = { filter: 'all', state: '', query: '' } as const;

describe('cockpit outbound: the table', () => {
  it('Targets keeps the targets, All keeps everything, and a group on both forms is on the card and on a factor', async () => {
    const d = await load();
    assert.deepEqual(filterGroups(d.groups, { ...want, filter: 'targets' }).map(g => g.ein).sort(), ['900000008', '900000009']);
    assert.equal(filterGroups(d.groups, want).length, d.groups.length);
    const card = filterGroups(d.groups, { ...want, filter: 'card' });
    const factor = filterGroups(d.groups, { ...want, filter: 'factor' });
    const both = d.groups.filter(g => g.form === 'both');
    assert.ok(both.length > 0 && both.every(g => card.includes(g) && factor.includes(g)));
    assert.equal(card.length, formCounts(d).card);
    assert.equal(factor.length, formCounts(d).factor);
  });
  it('a state and a search narrow the groups, and the search reads name, city and EIN', async () => {
    const d = await load();
    assert.ok(filterGroups(d.groups, { ...want, state: 'OK' }).every(g => g.state === 'OK'));
    assert.deepEqual(filterGroups(d.groups, { ...want, query: ' harborlight ' }).map(g => g.ein).sort(), ['900000008', '900000009']);
    assert.deepEqual(filterGroups(d.groups, { ...want, query: '900000003' }).map(g => g.name), ['NORTHWIND PSYCHIATRY PLLC']);
    assert.deepEqual(filterGroups(d.groups, { ...want, query: 'no such group' }), []);
    assert.deepEqual(statesOf(d.groups).map(([s]) => s), ['OK', 'TX']);
  });
  it('sorts numbers as numbers, words A to Z, and keeps tied rows in a fixed order', async () => {
    const d = await load();
    const clin = sortGroups(d.groups, { key: 'clinicians', dir: 'desc' }).map(g => g.clinicians);
    assert.deepEqual(clin, [...clin].sort((a, b) => b - a));
    const names = sortGroups(d.groups, { key: 'name', dir: 'asc' }).map(g => g.name.toLowerCase());
    assert.deepEqual(names, [...names].sort());
    // two groups with the same rate keep name order, whichever way the column goes
    const tied = d.groups.filter(g => g.rate === 114.57);
    assert.ok(tied.length >= 2);
    for (const dir of ['asc', 'desc'] as const) {
      const order = sortGroups(tied, { key: 'rate', dir }).map(g => g.name);
      assert.deepEqual(order, [...order].sort());
    }
    assert.deepEqual(sortGroups(d.groups, { key: 'fit', dir: 'asc' }).slice(0, 2).map(g => g.draftStatus), ['ready', 'blocked']);
  });
  it('labels the contract form by its tier or multiple, and the fit by its draft state', async () => {
    const d = await load();
    const of = (ein: string) => d.groups.find(g => g.ein === ein) as Group;
    assert.equal(formLabel(of('900000001')), 'Card 80%');
    assert.equal(formLabel({ ...of('900000001'), cardTier: 80, factorMultiple: 35, form: 'both' }), 'Card 80% · Factor ×35');
    assert.equal(formLabel({ ...of('900000001'), cardTier: null, factorMultiple: null, form: 'neither' }), 'Neither');
    assert.deepEqual(['900000008', '900000009', '900000003'].map(e => fitLabel(of(e))), ['Target · draft ready', 'Target · draft blocked', 'Not a target']);
  });
});

describe('cockpit outbound: the headline and the chart', () => {
  it('the headline states the small band card count, the card base and both band medians the API gave, and bands read as words', async () => {
    const d = await load();
    const [small, , large] = d.summary.bands;
    const top = `Groups with over 500 clinicians sit at a median of ${large.medianPctOfMedicare}%.`;
    assert.ok(d.patterns.card && small.card > 0, 'the fixture has a card and small groups on it');
    assert.equal(headline(d), `Of the ${small.groups} groups with 50 or fewer clinicians, ${small.card} are paid a whole percent of one $${d.patterns.card.base.toFixed(2)} base, and the band's median is ${small.medianPctOfMedicare}% of Medicare. ${top}`);
    // no card pattern, or no small group on it: the medians alone
    const mediansOnly = `Groups with 50 or fewer clinicians are paid a median of ${small.medianPctOfMedicare}% of Medicare. ${top}`;
    assert.equal(headline({ ...d, patterns: { ...d.patterns, card: null } }), mediansOnly);
    assert.equal(headline({ ...d, summary: { ...d.summary, bands: [{ ...small, card: 0 }, d.summary.bands[1], large] } }), mediansOnly);
    assert.deepEqual(['1-50', '51-500', '501+'].map(bandWords), ['50 or fewer clinicians', '51 to 500 clinicians', 'over 500 clinicians']);
    assert.equal(headline({ ...d, summary: { ...d.summary, bands: [{ ...small, medianPctOfMedicare: null }, d.summary.bands[1], large] } }), null);
  });
  it('puts every group inside the plot, larger groups to the right and higher rates higher', async () => {
    const d = await load();
    const geo = chartGeometry(d.groups, d.patterns.card, d.summary.bands, { width: 900, height: 420 });
    const { plot } = geo;
    assert.equal(geo.points.length, d.groups.length);
    for (const p of geo.points) assert.ok(p.x >= plot.x0 && p.x <= plot.x1 && p.y >= plot.y0 && p.y <= plot.y1, JSON.stringify(p));
    assert.ok(geo.x(800) > geo.x(8));
    assert.ok(geo.y(200) < geo.y(120), 'a higher rate is nearer the top');
  });
  it('draws the size-band dividers between the bands, a tier line for each tier in use, and Medicare at the median baseline', async () => {
    const d = await load();
    const geo = chartGeometry(d.groups, d.patterns.card, d.summary.bands, { width: 900, height: 420 });
    assert.deepEqual(geo.dividers.map(v => v.at), [50, 500]);
    assert.ok(geo.dividers[0].x > geo.x(50) && geo.dividers[0].x < geo.x(51));
    assert.deepEqual(geo.bandCaptions.map(b => b.band), ['1-50', '51-500', '501+']);
    const tiers = [...new Set(d.groups.map(g => g.cardTier).filter(t => t != null))];
    assert.equal(geo.tierLines.length, tiers.length);
    const base = d.patterns.card!.base;
    for (const t of geo.tierLines) assert.ok(Math.abs(t.y - geo.y((base * t.tier) / 100)) < 1e-9);
    assert.equal(geo.medicare.value, median(d.groups.map(g => g.medicare)));
    assert.deepEqual(chartGeometry(d.groups, null, d.summary.bands, { width: 900, height: 420 }).tierLines, [], 'no card, no tier lines');
  });
  it('never labels two tiers closer than the label gap, and always labels the top one', async () => {
    const d = await load();
    const labelled = chartGeometry(d.groups, d.patterns.card, d.summary.bands, { width: 900, height: 420 }).tierLines.filter(t => t.labelled);
    assert.ok(labelled.length > 0);
    for (let i = 1; i < labelled.length; i++) assert.ok(labelled[i].y - labelled[i - 1].y >= 12);
  });
});
