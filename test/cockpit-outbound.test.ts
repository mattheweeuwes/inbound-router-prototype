// The Outbound tab's logic with no DOM (public/outbound-model.js), run on the groups the API returns for the invented rate file:
// what each filter keeps, how a click sorts, the status words, the work tiles and the links to confirm, the headline, and where
// the chart puts things.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import handler from '../api/outbound';
import { buildAddress, parseAddress } from '../public/address-model.js';
import {
  bandWords, chartGeometry, chipCounts, confirmWords, filterGroups, formCounts, firstLinks, formLabel, fromParams, headline, linkValue, linksToConfirm, median, panelRows,
  pickStatus, sortGroups, statesOf, statusLabel, statusOfWord, toParams, wordOfStatus, workCounts,
  type Group, type Loaded,
} from '../public/outbound-model.js';
import { outboundDetail } from '../src/outbound/view';
import { testCtx } from './helpers';

const load = async (): Promise<Loaded> => (await (await handler(new Request('http://local/api/outbound'), testCtx())).json()) as Loaded;
const want = { filter: 'all', state: '', query: '' } as const;

describe('cockpit outbound: the table', () => {
  it('In a play keeps both plays, each play chip keeps its own, All keeps everything, and a group on both forms is on the card and on a factor', async () => {
    const d = await load();
    const eins = (filter: 'in_play' | 'platform' | 'system_gap') => filterGroups(d.groups, { ...want, filter }).map(g => g.ein).sort();
    assert.deepEqual(eins('in_play'), ['900000008', '900000009', '900000013']);
    assert.deepEqual(eins('platform'), ['900000008', '900000009']);
    assert.deepEqual(eins('system_gap'), ['900000013']);
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
    assert.deepEqual(sortGroups(d.groups, { key: 'status', dir: 'asc' }).slice(0, 5).map(g => g.status), ['ready', 'ready', 'blocked', 'link_to_confirm', 'suppressed']);
  });
  it('labels the contract form by its tier or multiple, and the status by its play and who has it', async () => {
    const d = await load();
    const of = (ein: string) => d.groups.find(g => g.ein === ein) as Group;
    assert.equal(formLabel(of('900000001')), 'Card 80%');
    assert.equal(formLabel({ ...of('900000001'), cardTier: 80, factorMultiple: 35, form: 'both' }), 'Card 80% · Factor ×35');
    assert.equal(formLabel({ ...of('900000001'), cardTier: null, factorMultiple: null, form: 'neither' }), 'Neither');
    assert.deepEqual(['900000008', '900000013', '900000009', '900000015', '900000014', '900000003'].map(e => statusLabel(of(e))),
      ['Ready · Platform', 'Ready · System gap', 'Blocked · Platform', 'Suppressed · Jordan has it', 'Link to confirm', 'Not a target']);
  });
});

describe('cockpit outbound: the work', () => {
  it('the tiles count drafts ready by play, groups someone has and links waiting, as the API gave them', async () => {
    const d = await load();
    assert.deepEqual(workCounts(d), { ready: { platform: 1, system_gap: 1, total: 2 }, suppressed: 1, linksWaiting: 1 });
    assert.deepEqual(d.actions, { linkDecisions: false, export: '/api/outbound/export.csv' });
  });
  it('Links to confirm lists each probable link with its candidate, largest group first', async () => {
    const d = await load();
    const rows = linksToConfirm(d.groups);
    assert.deepEqual(rows.map(g => [g.ein, g.link.probable?.name, g.link.probable?.state, g.link.ifConfirmed]), [['900000014', 'Pecos Vale Health System', 'TX', 'system_gap']]);
    const bigger = { ...rows[0], ein: '900000099', clinicians: 900 };
    assert.deepEqual(linksToConfirm([rows[0], bigger, { ...rows[0], ein: '900000098', link: { ...rows[0].link, status: 'unlinked' } }]).map(g => g.ein), ['900000099', '900000014']);
  });
  it('the list and the detail agree on a group\'s status', async () => {
    const d = await load();
    const ctx = testCtx();
    for (const g of d.groups) assert.equal(outboundDetail(ctx, g.ein)!.work.status, g.status, g.ein);
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

/** A probable link on a group, with just what the panel's order reads. */
const probable = (g: Group, over: { ein: string; clinicians: number; ifConfirmed: Group['link']['ifConfirmed']; basis: 'name' | 'score' }): Group => ({
  ...g, ein: over.ein, clinicians: over.clinicians, link: { ...g.link, status: 'probable', basis: over.basis, ifConfirmed: over.ifConfirmed, probable: g.link.probable ?? { accountId: 'a', name: 'A', kind: 'k', state: 'TX', score: 0.5 } },
});

describe('cockpit outbound: links to confirm', () => {
  it('orders by what confirming would do: a group into a play, then a name contained in the group\'s, then a score alone; the largest group first within each', async () => {
    const d = await load();
    const base = linksToConfirm(d.groups)[0];
    const inPlaySmall = probable(base, { ein: '1', clinicians: 60, ifConfirmed: 'system_gap', basis: 'score' });
    const inPlayBig = probable(base, { ein: '2', clinicians: 900, ifConfirmed: 'system_gap', basis: 'score' });
    const nameBig = probable(base, { ein: '3', clinicians: 5000, ifConfirmed: null, basis: 'name' });
    const nameSmall = probable(base, { ein: '4', clinicians: 40, ifConfirmed: null, basis: 'name' });
    const scoreBig = probable(base, { ein: '5', clinicians: 9000, ifConfirmed: null, basis: 'score' });
    const rows = linksToConfirm([scoreBig, nameSmall, inPlaySmall, nameBig, inPlayBig]);
    assert.deepEqual(rows.map(g => g.ein), ['2', '1', '3', '4', '5']);
    assert.deepEqual(rows.map(linkValue), [0, 0, 1, 1, 2]);
  });
  it('says what confirming does: it puts the group in a play, or only links it', async () => {
    const d = await load();
    const base = linksToConfirm(d.groups)[0];
    assert.equal(confirmWords(base), 'Confirming puts it in the System gap play');
    assert.equal(confirmWords({ ...base, link: { ...base.link, ifConfirmed: null } }), 'Confirming links it to the organization; it stays in no play');
  });
  it('the API says whether a probable link is probable by name or by score alone', async () => {
    const d = await load();
    const pecos = d.groups.find(g => g.ein === '900000014')!;
    assert.ok(pecos.link.basis === 'name' || pecos.link.basis === 'score');
    assert.equal(d.groups.filter(g => g.link.status !== 'probable').every(g => g.link.basis === null), true);
  });
  it('shows the first link by default and all of them on request, and keeps a decision where its row was', async () => {
    const d = await load();
    const base = linksToConfirm(d.groups)[0];
    const links = ['a', 'b', 'c', 'd'].map(ein => probable(base, { ein, clinicians: 10, ifConfirmed: null, basis: 'score' }));
    const names = (rows: Array<{ kind: 'link'; group: Group } | { kind: 'line'; line: { ein: string; index: number } }>) => rows.map(r => (r.kind === 'link' ? r.group.ein : `line:${r.line.ein}`));
    assert.deepEqual(names(panelRows(links, [], false)), ['a']);
    assert.deepEqual(names(panelRows(links, [], true)), ['a', 'b', 'c', 'd']);
    // every link that would put its group in a play shows without asking: those are the ones worth a person's minute
    const useful = [probable(base, { ein: 'p1', clinicians: 10, ifConfirmed: 'system_gap', basis: 'name' }), probable(base, { ein: 'p2', clinicians: 9, ifConfirmed: 'system_gap', basis: 'name' }), ...links];
    assert.equal(firstLinks(useful), 2);
    assert.deepEqual(names(panelRows(useful, [], false)), ['p1', 'p2']);
    // "b" was the second row when it was decided; it has left the waiting links, and its line takes its place
    const line = { ein: 'b0', index: 1, decision: 'confirm' as const, name: 'B', candidate: null };
    assert.deepEqual(names(panelRows([links[0], links[2], links[3]], [line], true)), ['a', 'line:b0', 'c', 'd']);
    // decided first with only the first shown: the line stands where the row was, and the next link shows beneath it
    const first = { ein: 'a0', index: 0, decision: 'reject' as const, name: 'A', candidate: 'X' };
    assert.deepEqual(names(panelRows([links[1], links[2]], [first], false)), ['line:a0', 'b']);
    // two decisions keep their own places, whatever order they were made in
    const second = { ein: 'c0', index: 2, decision: 'confirm' as const, name: 'C', candidate: null };
    assert.deepEqual(names(panelRows([links[0], links[3]], [second, line], true)), ['a', 'line:b0', 'line:c0', 'd']);
    assert.deepEqual(names(panelRows([], [], false)), []);
  });
});

describe('cockpit outbound: status chips and the address', () => {
  const want = { filter: 'in_play', status: '', state: '', query: '' } as const;
  it('every status has its chip, its count, and its word in the address', async () => {
    const d = await load();
    const c = chipCounts(d.groups, want);
    // with In a play chosen: the ready and blocked platform and system-gap groups, and the suppressed group in a play
    assert.deepEqual(c.status, { ready: 2, blocked: 1, suppressed: 0, link_to_confirm: 0, not_target: 0 });
    const all = chipCounts(d.groups, { ...want, filter: 'all' });
    assert.equal(all.status.link_to_confirm, 1);
    assert.equal(all.status.suppressed, 1);
    assert.equal(Object.values(all.status).reduce((a, b) => a + b, 0), d.groups.length, 'every group has exactly one status');
    assert.deepEqual(['ready', 'blocked', 'suppressed', 'link', 'not_target'].map(w => statusOfWord(w)), ['ready', 'blocked', 'suppressed', 'link_to_confirm', 'not_target']);
    assert.equal(statusOfWord('bogus'), '');
    assert.equal(wordOfStatus('link_to_confirm'), 'link');
  });
  it('a status chip combines with the play chips, the state and the search', async () => {
    const d = await load();
    assert.deepEqual(filterGroups(d.groups, { ...want, filter: 'all', status: 'link_to_confirm' }).map(g => g.ein), ['900000014']);
    assert.deepEqual(filterGroups(d.groups, { ...want, filter: 'platform', status: 'ready' }).map(g => g.ein), ['900000008']);
    assert.deepEqual(filterGroups(d.groups, { ...want, filter: 'platform', status: 'ready', state: 'OK' }), []);
    assert.deepEqual(filterGroups(d.groups, { ...want, filter: 'all', status: 'suppressed', query: 'tallowmere' }).map(g => g.ein), ['900000015']);
    for (const [status, n] of Object.entries(chipCounts(d.groups, { ...want, filter: 'all' }).status)) {
      assert.equal(filterGroups(d.groups, { ...want, filter: 'all', status: status as never }).length, n, status);
    }
  });
  it('picking a status that sits outside the chosen play widens the play to All, and picking it again turns it off', async () => {
    const d = await load();
    const linked = pickStatus(want, 'link_to_confirm', d.groups);
    assert.deepEqual([linked.status, linked.filter], ['link_to_confirm', 'all']);
    const ready = pickStatus(want, 'ready', d.groups);
    assert.deepEqual([ready.status, ready.filter], ['ready', 'in_play']);
    assert.deepEqual(pickStatus(linked, 'link_to_confirm', d.groups), { ...linked, status: '' });
  });
  it('writes the view to the address without its defaults, and reads it back', () => {
    const sort = { key: 'clinicians', dir: 'desc' } as const;
    assert.equal(buildAddress('outbound', toParams(want, sort)), '#outbound');
    // with a status the play defaults to All, so #outbound?status=link shows the links
    assert.equal(buildAddress('outbound', { ein: '900000014', ...toParams({ ...want, filter: 'all', status: 'link_to_confirm' }, sort) }), '#outbound?ein=900000014&status=link');
    assert.equal(buildAddress('outbound', toParams({ ...want, status: 'ready' }, sort)), '#outbound?status=ready&play=in_play');
    const view = { want: { filter: 'platform', status: 'blocked', state: 'TX', query: 'harbor' }, sort: { key: 'rate', dir: 'asc' } } as const;
    const hash = buildAddress('outbound', toParams(view.want, view.sort));
    assert.equal(hash, '#outbound?status=blocked&play=platform&state=TX&q=harbor&sort=rate&dir=asc');
    assert.deepEqual(fromParams(parseAddress(hash).params), view);
    assert.deepEqual(fromParams(parseAddress('#outbound?status=link').params).want, { filter: 'all', status: 'link_to_confirm', state: '', query: '' });
    assert.deepEqual(fromParams(parseAddress('#outbound?play=bogus&sort=nope&dir=sideways&status=zzz').params), { want, sort });
  });
});
