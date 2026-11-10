// The Lead stream's logic with no DOM (public/stream-model.js): which leads the filters and the search keep, the count beside each
// filter, the sort, an uploaded list folded into one group row, and the view as an address. The leads here are written by hand so each
// case says what it is about; test/lead-summary.test.ts checks the real rows carry the fields these read.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAddress, parseAddress } from '../public/address-model.js';
import {
  GROUP_MIN, activeFilters, cleared, countLine, defaultView, facetCounts, fromParams, groupLabel, isFiltered, nextSort, passes, rowsWithGroups,
  searchText, sortLeads, toParams, visible, without, type Lead, type View,
} from '../public/stream-model.js';

let n = 0;
/** A lead with nothing special about it, overridden by what a case is about. The newest has the highest number. */
function lead(over: Partial<Lead> & { at?: number } = {}): Lead {
  n++;
  const at = over.at ?? n;
  return {
    id: `L${String(n).padStart(3, '0')}`, receivedAt: new Date(Date.UTC(2026, 10, 10, 12, 0, at)).toISOString(), source: 'calendly_demo', status: 'done',
    person: { name: `Person ${n}`, title: 'Director', email: `p${n}@x.example` }, org: { name: `Org ${n}`, accountId: `ahrq:ORG-${n}`, segment: 'health_system' },
    tier: 'C', score: 50, routeAction: 'team_queue', routeTeam: 'HSP', owner: 'HSP queue', useCase: 'other', timeToAlertMs: 40, flags: [], list: null,
    enterprise: false, enterpriseFact: null, referral: null, rule: 'R8', dealCue: null, ...over,
  };
}
const view = (over: Partial<View> = {}): View => ({ ...defaultView(), ...over });
const ids = (ls: Lead[]) => ls.map(l => l.id);

const ent = lead({ enterprise: true, enterpriseFact: '145 hospitals in 20 states', tier: 'A', score: 91, routeAction: 'rep_alert', owner: 'Avery', rule: 'R10', timeToAlertMs: 120, at: 50 });
const ref = lead({ referral: { kind: 'customer', referrer: 'Wrenfield Health' }, flags: ['referral'], tier: 'B', score: 70, routeAction: 'owner_task', owner: 'Avery', at: 40 });
const cue = lead({ dealCue: 'bulk license', tier: 'B', score: 66, useCase: 'data_platform_api', routeTeam: 'API', source: 'api_key', at: 30 });
const nurture = lead({ tier: 'D', score: 12, routeAction: 'nurture', routeTeam: 'Nurture', owner: null, timeToAlertMs: null, source: 'guide_download', at: 20 });
const noOrg = lead({ org: { name: null, accountId: null, segment: null }, tier: null, score: null, routeAction: null, routeTeam: null, owner: null, timeToAlertMs: null, at: 10 });
const day = [ent, ref, cue, nurture, noOrg];

describe('cockpit stream: what the filters keep', () => {
  it('with nothing chosen everything shows, and each route chip keeps its own actions', () => {
    assert.equal(visible(day, view()).length, 5);
    assert.deepEqual(ids(visible(day, view({ route: 'alert' }))), [ent.id, ref.id]);
    assert.deepEqual(ids(visible(day, view({ route: 'nurture' }))), [nurture.id]);
    assert.deepEqual(ids(visible(day, view({ route: 'other' }))), [noOrg.id], 'a lead with no route yet is in Other');
  });

  it('Enterprise, Referral, Tier, Team and Door combine, and the search narrows what they leave', () => {
    assert.deepEqual(ids(visible(day, view({ enterprise: true }))), [ent.id]);
    assert.deepEqual(ids(visible(day, view({ referral: true }))), [ref.id]);
    assert.deepEqual(ids(visible(day, view({ tier: 'B' }))), [ref.id, cue.id]);
    assert.deepEqual(ids(visible(day, view({ tier: 'B', team: 'API' }))), [cue.id]);
    assert.deepEqual(ids(visible(day, view({ door: 'guide_download' }))), [nurture.id]);
    assert.deepEqual(ids(visible(day, view({ route: 'alert', tier: 'B' }))), [ref.id]);
    assert.deepEqual(ids(visible(day, view({ tier: 'B', q: 'bulk' }))), [cue.id]);
    assert.deepEqual(visible(day, view({ enterprise: true, tier: 'D' })), []);
  });

  it('an account and a named referrer narrow to the people behind them', () => {
    assert.deepEqual(ids(visible(day, view({ account: ref.org.accountId! }))), [ref.id]);
    assert.deepEqual(ids(visible(day, view({ referral: true, referrer: 'Wrenfield Health' }))), [ref.id]);
    assert.deepEqual(visible(day, view({ referral: true, referrer: 'Nobody Health' })), []);
  });

  it('the List filter is all, not from a list, or one list', () => {
    const a = lead({ list: 'HLTH' });
    const b = lead({ list: 'HLTH' });
    const c = lead({ list: 'AHIP' });
    const plain = lead();
    const all = [a, b, c, plain];
    assert.equal(visible(all, view()).length, 4);
    assert.deepEqual(ids(visible(all, view({ list: 'none' }))), [plain.id]);
    assert.deepEqual(ids(visible(all, view({ list: 'HLTH' }))), [a.id, b.id]);
    assert.deepEqual(visible(all, view({ list: 'ZZZ' })), []);
  });
});

describe('cockpit stream: the count beside each filter', () => {
  it('each count is what the list would hold with that filter chosen and the others as they are', () => {
    const base = facetCounts(day, view());
    assert.deepEqual([base.enterprise, base.referral, base.tier.A, base.tier.B, base.tier.C, base.tier.D], [1, 1, 1, 2, 0, 1]);
    assert.deepEqual(base.route, { all: 5, alert: 2, queue: 1, nurture: 1, review: 0, other: 1 });
    // with Tier B chosen, Enterprise counts the enterprise leads that are tier B (none), and the tier chips still count their own tiers
    const b = facetCounts(day, view({ tier: 'B' }));
    assert.equal(b.enterprise, 0);
    assert.deepEqual([b.tier.A, b.tier.B, b.tier.D], [1, 2, 1], 'a tier chip is not narrowed by the tier already chosen');
    assert.equal(b.route.all, 2);
    // each option's count equals the length of the list it would give
    for (const t of ['A', 'B', 'C', 'D'] as const) assert.equal(base.tier[t], visible(day, view({ tier: t })).length);
    for (const [team, k] of base.team) assert.equal(k, visible(day, view({ team })).length, team);
    for (const [door, k] of base.door) assert.equal(k, visible(day, view({ door })).length, door);
  });

  it('the list option counts say how many rows are from a list, from none, and from each', () => {
    const a = lead({ list: 'HLTH' });
    const b = lead({ list: 'HLTH', tier: 'B' });
    const c = lead({ list: 'AHIP' });
    const plain = lead();
    const f = facetCounts([a, b, c, plain], view({ tier: 'B' }));
    assert.deepEqual([f.list.all, f.list.none, f.list.byName], [1, 0, [['HLTH', 1]]]);
    const g = facetCounts([a, b, c, plain], view());
    assert.deepEqual([g.list.all, g.list.none, g.list.byName], [4, 1, [['HLTH', 2], ['AHIP', 1]]]);
  });

  it('the count line reads "12 of 205 leads", and says how many lists are folded when some are', () => {
    assert.equal(countLine(12, 205), '12 of 205 leads');
    assert.equal(countLine(1, 1), '1 of 1 lead');
    assert.equal(countLine(205, 205, 1), '205 of 205 leads · 1 list folded');
    assert.equal(countLine(1204, 1204, 2), '1,204 of 1,204 leads · 2 lists folded');
  });
});

describe('cockpit stream: search', () => {
  it('matches the list name, the rule, the use case, the referrer, the flags and the deal cue, as well as the words on the row', () => {
    const l = lead({ list: 'HLTH', rule: 'R10', useCase: 'contract_negotiation', referral: { kind: 'customer', referrer: 'Wrenfield Health' }, flags: ['free_mail', 'after_hours', 'enterprise'], dealCue: 'bulk license', owner: 'Quinn' });
    for (const q of ['hlth', 'r10', 'contract negotiation', 'wrenfield', 'free-mail', 'after hours', 'enterprise', 'bulk license', 'quinn', 'tier c', 'demo request', 'health system']) {
      assert.ok(passes(l, view({ q })), `"${q}" finds it`);
    }
    assert.ok(!passes(l, view({ q: 'zzz' })));
    assert.match(searchText(l), /contract negotiation/);
  });
  it('is not case sensitive and ignores spaces around it', () => {
    assert.ok(passes(ent, view({ q: '  R10 ' })));
  });
});

describe('cockpit stream: sorting', () => {
  it('Received is newest first to start, and the opposite on the second click', () => {
    assert.deepEqual(ids(sortLeads(day, 'received', 'desc')), [ent.id, ref.id, cue.id, nurture.id, noOrg.id]);
    assert.deepEqual(ids(sortLeads(day, 'received', 'asc')), [noOrg.id, nurture.id, cue.id, ref.id, ent.id]);
    assert.deepEqual(nextSort(view(), 'received'), { sort: 'received', dir: 'asc' });
    assert.deepEqual(nextSort(view(), 'score'), { sort: 'score', dir: 'desc' });
    assert.deepEqual(nextSort(view({ sort: 'score', dir: 'desc' }), 'score'), { sort: 'score', dir: 'asc' });
    assert.deepEqual(nextSort(view(), 'org'), { sort: 'org', dir: 'asc' });
  });
  it('Score, Tier, Time to alert and Organization sort on their own column and put a missing value last, either way', () => {
    assert.deepEqual(ids(sortLeads(day, 'score', 'desc')), [ent.id, ref.id, cue.id, nurture.id, noOrg.id]);
    assert.deepEqual(ids(sortLeads(day, 'score', 'asc')), [nurture.id, cue.id, ref.id, ent.id, noOrg.id]);
    assert.deepEqual(ids(sortLeads(day, 'tier', 'asc')), [ent.id, ref.id, cue.id, nurture.id, noOrg.id]);
    assert.deepEqual(ids(sortLeads(day, 'tier', 'desc')).at(-1), noOrg.id);
    assert.deepEqual(ids(sortLeads(day, 'alert', 'desc')).slice(0, 3), [ent.id, ref.id, cue.id], 'slowest first; the tie keeps newest first');
    assert.deepEqual(ids(sortLeads(day, 'alert', 'asc')).slice(-2).sort(), [nurture.id, noOrg.id].sort(), 'leads with no alert go last');
    const named = sortLeads(day, 'org', 'asc');
    assert.equal(named.at(-1)!.id, noOrg.id, 'a lead with no organization goes last');
    assert.deepEqual(named.slice(0, 4).map(l => l.org.name), [...named.slice(0, 4).map(l => l.org.name)].sort());
  });
  it('rows that tie keep newest first, so a click never shuffles them', () => {
    const a = lead({ score: 70, at: 1 });
    const b = lead({ score: 70, at: 2 });
    for (const dir of ['asc', 'desc'] as const) assert.deepEqual(ids(sortLeads([a, b], 'score', dir)), [b.id, a.id]);
  });
});

describe('cockpit stream: an uploaded list as one group row', () => {
  const list = (name: string, tiers: string[], at: number) => tiers.map((t, i) => lead({ list: name, tier: t, score: 40 + i, at: at + i, routeAction: 'team_queue' }));
  const hlth = list('HLTH', ['B', 'B', 'C', 'C', 'C', 'D'], 100);
  const single = lead({ at: 500, tier: 'A', score: 95 });
  const older = lead({ at: 5, tier: 'C', score: 20 });
  const all = [single, ...hlth, older];
  const sorted = (v: View) => sortLeads(visible(all, v), v.sort, v.dir);

  it('is one collapsed row at the position of its newest row, labelled with its size and its tier mix', () => {
    const rows = rowsWithGroups(sorted(view()), view(), new Set());
    assert.deepEqual(rows.map(r => (r.kind === 'group' ? r.name : r.lead.id)), [single.id, 'HLTH', older.id]);
    const g = rows[1];
    assert.equal(g.kind, 'group');
    if (g.kind === 'group') {
      assert.equal(groupLabel(g), 'HLTH, 6 rows: 2 B, 3 C, 1 D');
      assert.equal(g.newest, hlth.at(-1)!.receivedAt);
      assert.equal(g.open, false);
    }
  });

  it('opens in place: its rows follow its row, in the current order, and nothing else moves', () => {
    const rows = rowsWithGroups(sorted(view()), view(), new Set(['HLTH']));
    assert.deepEqual(rows.map(r => (r.kind === 'group' ? r.name : r.lead.id)), [single.id, 'HLTH', ...[...hlth].reverse().map(l => l.id), older.id]);
    assert.ok(rows.filter(r => r.kind === 'lead' && r.inGroup).length === 6);
  });

  it('sits where its best row sits under another sort', () => {
    const v = view({ sort: 'score', dir: 'asc' });
    const rows = rowsWithGroups(sorted(v), v, new Set());
    assert.deepEqual(rows.map(r => (r.kind === 'group' ? r.name : r.lead.id)), [older.id, 'HLTH', single.id]);
  });

  it('counts only the rows that pass the filters, and folds nothing when too few are left', () => {
    const v = view({ tier: 'B' });
    assert.equal(rowsWithGroups(sorted(v), v, new Set()).filter(r => r.kind === 'group').length, 0, `two rows are under ${GROUP_MIN}, so they show as rows`);
    const w = view({ tier: 'C' });
    const rows = rowsWithGroups(sorted(w), w, new Set());
    assert.equal(rows.filter(r => r.kind === 'group').length, 0, 'three C rows from the list and one outside it');
    const many = list('BIG', Array(GROUP_MIN).fill('B'), 300);
    const m = rowsWithGroups(sortLeads(many, 'received', 'desc'), view(), new Set());
    assert.equal(m.length, 1);
    assert.equal(groupLabel(m[0] as never), `BIG, ${GROUP_MIN} rows: ${GROUP_MIN} B`);
  });

  it('choosing the list in the List filter shows its rows alone, as ordinary rows', () => {
    const v = view({ list: 'HLTH' });
    const rows = rowsWithGroups(sorted(v), v, new Set());
    assert.equal(rows.length, 6);
    assert.ok(rows.every(r => r.kind === 'lead' && !r.inGroup));
    const none = view({ list: 'none' });
    assert.deepEqual(rowsWithGroups(sorted(none), none, new Set()).map(r => r.kind === 'lead' && r.lead.id), [single.id, older.id]);
  });
});

describe('cockpit stream: clearing, and the view as an address', () => {
  it('Clear filters takes off every filter and the search and keeps the sort; one filter can be taken off alone', () => {
    const v = view({ enterprise: true, tier: 'A', q: 'x', sort: 'score', dir: 'asc', list: 'HLTH', account: 'ahrq:X' });
    assert.ok(isFiltered(v));
    assert.deepEqual(cleared(v), { ...defaultView(), sort: 'score', dir: 'asc' });
    assert.ok(!isFiltered(cleared(v)));
    assert.equal(without(v, 'tier').tier, '');
    assert.equal(without(v, 'q').q, '');
    assert.equal(without(v, 'enterprise').tier, 'A');
    assert.ok(!isFiltered(view({ sort: 'tier', dir: 'asc' })), 'a sort is not a filter');
  });
  it('words what is narrowing the list, for the empty message', () => {
    const v = view({ enterprise: true, tier: 'B', list: 'none', door: 'event_scan', team: 'HSP', q: ' hello ', account: 'ahrq:X', referrer: 'Wren', route: 'alert' });
    assert.deepEqual(activeFilters(v, k => `acct ${k}`).map(f => f.label), ['Rep alerts', 'Enterprise', 'Referred by Wren', 'Tier B', 'Team Health Systems & Providers', 'Door Event scan', 'Not from a list', 'Account acct ahrq:X', 'Search "hello"']);
    assert.deepEqual(activeFilters(view()), []);
  });
  it('writes only what is not the default, so a plain list is a plain #stream, and reads it back', () => {
    assert.equal(buildAddress('stream', toParams(view())), '#stream');
    const v = view({ enterprise: true, sort: 'score', tier: 'B', list: 'HLTH 2026', q: 'r10' });
    const hash = buildAddress('stream', { lead: 'abc', ...toParams(v) });
    assert.equal(hash, '#stream?lead=abc&enterprise=1&tier=B&list=HLTH%202026&q=r10&sort=score');
    const back = parseAddress(hash);
    assert.equal(back.tab, 'stream');
    assert.deepEqual(fromParams(back.params), v);
    assert.equal(buildAddress('stream', toParams(view({ sort: 'score', dir: 'asc' }))), '#stream?sort=score&dir=asc');
    assert.deepEqual(fromParams(parseAddress('#stream?sort=score&dir=asc').params), view({ sort: 'score', dir: 'asc' }));
  });
  it('an address that names a word the page does not have falls back to the default for it', () => {
    const v = fromParams(parseAddress('#stream?tier=E&route=bogus&sort=nope&dir=sideways&enterprise=maybe').params);
    assert.deepEqual(v, defaultView());
    assert.equal(fromParams({ referrer: 'Wren' }).referral, true, 'a named referrer means a referral');
  });
});
