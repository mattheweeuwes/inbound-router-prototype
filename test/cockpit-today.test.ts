// The Today tab's logic with no DOM (public/today-model.js), run on what GET /api/brief and GET /api/accounts return for a few of
// the working day's events: the section order, how figures and accounts are worded, and where each item opens.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import accountsApi from '../api/accounts';
import briefApi from '../api/brief';
import { ROOT } from '../src/config';
import type { Source } from '../src/schema';
import {
  accountRow, addressOf, figureValue, indexEntries, lookbackWords, moreAddress, moreTarget, msWords, openLabel, rowsHidden, rowsShown, SECTION_ORDER,
  sectionsInOrder, signalsWords, stamp, targetOf, TAB_LABEL, TOP_ROWS,
  type Account, type Brief, type Item,
} from '../public/today-model.js';
import { parseAddress } from '../public/address-model.js';
import { withLocalTimes } from '../public/time.js';
import { post, testCtx } from './helpers';

const FILE = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'day', 'morning.json'), 'utf8')) as { clock: string; events: { id: string; source: Source; payload: unknown }[] };
let brief: Brief;
let accounts: Account[];

describe('cockpit Today: wording and targets', () => {
  before(async () => {
    const ctx = testCtx({ now: () => Date.parse(FILE.clock), usageFixtures: join(ROOT, 'fixtures', 'usage') });
    for (const id of ['D01', 'D06', 'D09', 'D10', 'D12']) { const e = FILE.events.find(x => x.id === id)!; await post(ctx, e.source, e.payload); }
    brief = (await (await briefApi(new Request('http://local/api/brief'), ctx)).json()) as Brief;
    accounts = ((await (await accountsApi(new Request('http://local/api/accounts?limit=25'), ctx)).json()) as { accounts: Account[] }).accounts;
  });

  it('shows the eight sections in the order the page reads them, and skips one the API did not send', () => {
    assert.deepEqual(sectionsInOrder(brief).map(s => s.id), [...SECTION_ORDER]);
    const without = { ...brief, sections: { ...brief.sections } };
    delete without.sections.health;
    assert.equal(sectionsInOrder(without).length, 7);
  });

  it('every item opens an address the cockpit has, with the ids it needs, and the label names the tab it lands in', () => {
    const tabs = Object.keys(TAB_LABEL);
    for (const s of sectionsInOrder(brief)) for (const i of s.items) {
      const t = targetOf(i);
      assert.ok(tabs.includes(t.tab), `${s.id}: ${t.tab} is a tab`);
      assert.ok(Object.keys(i.ids).length > 0, `${s.id}: ${i.title} carries an id`);
      assert.equal(openLabel(i), `Open in ${TAB_LABEL[t.tab]}`);
      // the address names that tab and those parameters, and reads back to them
      assert.deepEqual(parseAddress(addressOf(i)), { tab: t.tab, params: t.params });
    }
    const review = brief.sections.needs_person.items.find(i => i.kind === 'review item')!;
    assert.equal(openLabel(review), 'Open in Needs a person');
    assert.equal(addressOf(review), `#review?lead=${review.ids.leadId}`);
  });

  it('a lead opens by id, a group by EIN, a feature by key, and an uploaded list opens the Lead stream with that list chosen', () => {
    const item = (tab: Item['tab'], ids: Item['ids']): Item => ({ kind: 'x', title: 't', detail: 'd', tab, ids });
    assert.equal(addressOf(item('stream', { leadId: 'L1', accountKey: 'ahrq:SYS-1' })), '#stream?lead=L1');
    assert.equal(addressOf(item('outbound', { ein: '900000014' })), '#outbound?ein=900000014');
    assert.equal(addressOf(item('feature-pipeline', { feature: 'network_benchmarking', accountKey: 'a' })), '#feature?f=network_benchmarking');
    assert.equal(addressOf(item('overview', { list: 'HLTH 2026' })), '#stream?list=HLTH%202026');
    assert.equal(openLabel(item('overview', { list: 'HLTH' })), 'Open in Lead stream');
    assert.deepEqual(targetOf(item('overview', {})), { tab: 'overview', params: {} });
  });

  it('a section shows its top rows, opens up to every row it was sent, and says how many it has hidden', () => {
    const s = brief.sections.needs_person;
    assert.equal(rowsShown(s, false).length, Math.min(TOP_ROWS, s.items.length));
    assert.equal(rowsShown(s, true).length, s.items.length);
    assert.equal(rowsHidden(s), Math.max(0, s.items.length - TOP_ROWS));
    const many = { ...s, items: Array.from({ length: 10 }, () => s.items[0] ?? { kind: 'x', title: 't', detail: 'd', tab: 'stream' as const, ids: { leadId: 'a' } }), more: 8 };
    assert.deepEqual([rowsShown(many, false).length, rowsShown(many, true).length, rowsHidden(many)], [TOP_ROWS, 10, 10 - TOP_ROWS]);
  });

  it('"and N more" opens the tab that holds the rest with the filter that matches the section', () => {
    const sec = (id: string, kind = 'x') => ({ ...brief.sections.needs_person, id, items: [{ kind, title: 't', detail: 'd', tab: 'stream' as const, ids: { leadId: 'a' } }], more: 3 }) as Brief['sections'][keyof Brief['sections']];
    const at = (s: ReturnType<typeof sec>) => moreAddress(s);
    assert.equal(at(sec('enterprise')), '#stream?enterprise=1');
    assert.equal(at(sec('referrals')), '#stream?referral=1');
    assert.equal(at(sec('outbound', 'link to confirm')), '#outbound?status=link');
    assert.equal(at(sec('outbound', 'suppressed')), '#outbound?status=suppressed');
    assert.equal(at(sec('needs_person', 'review item')), '#review');
    assert.equal(at(sec('needs_person', 'SLA clock')), '#stream');
    assert.equal(at(sec('expansion')), '#feature');
    assert.equal(at(sec('interest')), '#feature');
    assert.match(moreTarget(sec('enterprise')).words, /enterprise only/);
  });

  it('the index lists every section with its count, then the accounts with the total', () => {
    const entries = indexEntries(brief, 158);
    assert.deepEqual(entries.map(e => e.id), [...SECTION_ORDER, 'accounts']);
    assert.deepEqual(entries.slice(0, -1).map(e => e.count), sectionsInOrder(brief).map(s => s.count));
    assert.deepEqual(entries.at(-1), { id: 'accounts', label: 'Accounts', count: 158 });
  });

  it('words a duration and a count figure', () => {
    assert.deepEqual([msWords(null), msWords(12), msWords(1400), msWords(999.6)], ['no data', '12 ms', '1.4 s', '1.0 s']);
    // a wait of minutes or hours reads in minutes and hours, as the section's own sentence does
    assert.deepEqual([msWords(59_900), msWords(1_070_000), msWords(3_600_000), msWords(7_800_000)], ['59.9 s', '17 min', '1 h', '2 h 10 min']);
    assert.equal(figureValue({ label: 'x', value: 1234, unit: 'count', tab: 'overview' }), '1,234');
    assert.equal(figureValue({ label: 'x', value: 80, unit: 'ms', tab: 'overview' }), '80 ms');
    assert.equal(figureValue({ label: 'x', value: null, unit: 'ms', tab: 'overview' }), 'no data');
  });

  it('an account row keeps the API order (enterprise first) and reads in plain words', () => {
    const rows = accounts.map(accountRow);
    assert.equal(rows[0].enterprise, true);
    const cs = rows.find(r => r.name === 'CommonSpirit Health')!;
    assert.deepEqual([cs.fact.endsWith('hospitals'), cs.owner, cs.people, cs.signals], [true, 'Avery (claimed)', 1, '1 referral in']);
    assert.ok(cs.latestAt && !Number.isNaN(Date.parse(cs.latestAt)), 'the row keeps the time itself, which the page prints as a local time');
    const wren = rows.find(r => r.name === 'Wrenfield Health')!;
    assert.deepEqual([wren.owner, wren.signals], ['Avery', '1 referral out']);
    assert.equal(rows.find(r => r.name === 'Kaiser Foundation Health Plan')?.signals, '1 web visit signal');
  });

  it('signals read as a list, or none', () => {
    const base = accounts[0];
    assert.equal(signalsWords({ ...base, referralsIn: 0, referralsOut: 0, webIntentSignals: 0, openReviews: 0, hasRateFact: false }), 'none');
    assert.equal(signalsWords({ ...base, referralsIn: 2, referralsOut: 1, webIntentSignals: 3, openReviews: 1, hasRateFact: true }), '2 referrals in, 1 referral out, 3 web visit signals, 1 open review item, in the rate file');
  });

  it('the exact time is a date and a UTC time, and the line under the title says what the window is', () => {
    assert.deepEqual([stamp('2026-11-10T21:30:00.000Z'), stamp(null)], ['2026-11-10 21:30 UTC', '—']);
    assert.equal(lookbackWords(brief), 'Lead sections look back 24 hours; the rest are shown as they stand.');
    assert.equal(lookbackWords({ ...brief, window: { ...brief.window, hours: 336 } }), 'Lead sections look back 14 days; the rest are shown as they stand.');
    assert.equal(lookbackWords({ ...brief, window: { ...brief.window, hours: 36 } }), 'Lead sections look back 36 hours; the rest are shown as they stand.');
  });

  it('a time in the brief\'s own words reads as a local time with the UTC time on hover, and nothing else in the text is touched', () => {
    const html = withLocalTimes('Tier A, rep alert to Avery, due 2026-11-10 21:30 UTC. <b>Not markup</b> & more.');
    assert.match(html, /^Tier A, rep alert to Avery, due <time datetime="2026-11-10T21:30:00.000Z" title="2026-11-10 21:30:00 UTC">Tue 4:30 PM<\/time>\. &lt;b&gt;Not markup&lt;\/b&gt; &amp; more\.$/);
    assert.equal(withLocalTimes('no time here'), 'no time here');
  });
});
