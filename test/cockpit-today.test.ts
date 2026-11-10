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
  accountRow, asOfWords, figureValue, msWords, openLabel, SECTION_ORDER, sectionsInOrder, signalsWords, stamp, targetOf, TAB_LABEL,
  type Account, type Brief,
} from '../public/today-model.js';
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

  it('every item opens a tab the cockpit has, with the ids it needs', () => {
    const tabs = Object.keys(TAB_LABEL);
    for (const s of sectionsInOrder(brief)) for (const i of s.items) {
      assert.ok(tabs.includes(i.tab), `${s.id}: ${i.tab} is a tab`);
      assert.ok(Object.keys(i.ids).length > 0, `${s.id}: ${i.title} carries an id`);
      assert.equal(openLabel(i), `Open in ${TAB_LABEL[i.tab]}`);
      assert.deepEqual(targetOf(i), { tab: i.tab, ...i.ids });
    }
    const review = brief.sections.needs_person.items.find(i => i.kind === 'review item')!;
    assert.equal(openLabel(review), 'Open in Needs a person');
  });

  it('words a duration and a count figure', () => {
    assert.deepEqual([msWords(null), msWords(12), msWords(1400), msWords(999.6)], ['no data', '12 ms', '1.4 s', '1.0 s']);
    assert.equal(figureValue({ label: 'x', value: 1234, unit: 'count', tab: 'overview' }), '1,234');
    assert.equal(figureValue({ label: 'x', value: 80, unit: 'ms', tab: 'overview' }), '80 ms');
    assert.equal(figureValue({ label: 'x', value: null, unit: 'ms', tab: 'overview' }), 'no data');
  });

  it('an account row keeps the API order (enterprise first) and reads in plain words', () => {
    const rows = accounts.map(accountRow);
    assert.equal(rows[0].enterprise, true);
    const cs = rows.find(r => r.name === 'CommonSpirit Health')!;
    assert.deepEqual([cs.fact.endsWith('hospitals'), cs.owner, cs.people, cs.signals], [true, 'Avery (claimed)', 1, '1 referral in']);
    const wren = rows.find(r => r.name === 'Wrenfield Health')!;
    assert.deepEqual([wren.owner, wren.signals], ['Avery', '1 referral out']);
    assert.equal(rows.find(r => r.name === 'Kaiser Foundation Health Plan')?.signals, '1 web visit signal');
  });

  it('signals read as a list, or none', () => {
    const base = accounts[0];
    assert.equal(signalsWords({ ...base, referralsIn: 0, referralsOut: 0, webIntentSignals: 0, openReviews: 0, hasRateFact: false }), 'none');
    assert.equal(signalsWords({ ...base, referralsIn: 2, referralsOut: 1, webIntentSignals: 3, openReviews: 1, hasRateFact: true }), '2 referrals in, 1 referral out, 3 web visit signals, 1 open review item, in the rate file');
  });

  it('times read as a date and a UTC time, and the line under the title says what the window is', () => {
    assert.deepEqual([stamp('2026-11-10T21:30:00.000Z'), stamp(null)], ['2026-11-10 21:30 UTC', '—']);
    assert.equal(asOfWords(brief), 'As of 2026-11-10 23:30 UTC. Lead sections look back 24 hours; the rest are shown as they stand.');
  });
});
