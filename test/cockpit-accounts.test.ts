// Today's accounts table logic (public/accounts-model.js): the filters, the search, the sort, how many rows show, and the view as an
// address. The accounts are the API's, from the working day's events.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import accountsApi from '../api/accounts';
import { buildAddress, parseAddress } from '../public/address-model.js';
import {
  FIRST_ROWS, MORE_ROWS, activeWords, cleared, countLine, counts, defaultView, fromParams, hasReferral, isFiltered, nextSort, page, sortAccounts, toParams, visible,
  type View,
} from '../public/accounts-model.js';
import type { Account } from '../public/today-model.js';
import { ROOT } from '../src/config';
import type { Source } from '../src/schema';
import { post, testCtx } from './helpers';

const FILE = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'day', 'morning.json'), 'utf8')) as { clock: string; events: { id: string; source: Source; payload: unknown }[] };
let all: Account[];
const view = (over: Partial<View> = {}): View => ({ ...defaultView(), ...over });
const names = (a: Account[]) => a.map(x => x.name);

describe('cockpit accounts', () => {
  before(async () => {
    const ctx = testCtx({ now: () => Date.parse(FILE.clock) });
    for (const id of ['D01', 'D02', 'D04', 'D06', 'D09', 'D10', 'D12']) { const e = FILE.events.find(x => x.id === id)!; await post(ctx, e.source, e.payload); }
    all = ((await (await accountsApi(new Request('http://local/api/accounts?limit=500'), ctx)).json()) as { accounts: Account[] }).accounts;
  });

  it('opens ranked as the API sends it, nothing filtered, with the first rows showing', () => {
    assert.ok(all.length >= 5, `${all.length} accounts`);
    assert.deepEqual(names(visible(all, view())), names(all));
    assert.deepEqual(names(sortAccounts(all, 'rank', 'asc')), names(all));
    assert.equal(defaultView().shown, FIRST_ROWS);
    assert.ok(!isFiltered(defaultView()));
  });

  it('Enterprise only, No owner and Has a referral each keep what they say, and combine', () => {
    const ent = visible(all, view({ enterprise: true }));
    assert.ok(ent.length > 0 && ent.every(a => a.enterprise));
    const none = visible(all, view({ noOwner: true }));
    assert.ok(none.length > 0 && none.every(a => !a.owner));
    const ref = visible(all, view({ referral: true }));
    assert.ok(ref.length > 0 && ref.every(a => a.referralsIn > 0 || a.referralsOut > 0));
    assert.ok(names(ref).includes('Wrenfield Health') && names(ref).includes('CommonSpirit Health'), 'a referral out and a referral in both count');
    const both = visible(all, view({ enterprise: true, referral: true }));
    assert.ok(both.every(a => a.enterprise && hasReferral(a)));
  });

  it('the search reads the name, the fact, the owner and the signals', () => {
    assert.deepEqual(names(visible(all, view({ q: 'wrenfield' }))), ['Wrenfield Health']);
    assert.ok(visible(all, view({ q: 'hospitals in' })).every(a => /hospitals in/.test(a.enterpriseFact ?? '')));
    assert.ok(visible(all, view({ q: 'avery' })).every(a => a.owner === 'Avery' || /avery/i.test(`${a.name} ${a.enterpriseFact}`)));
    assert.deepEqual(visible(all, view({ q: 'referral in' })).map(a => a.referralsIn > 0), visible(all, view({ q: 'referral in' })).map(() => true));
    assert.deepEqual(visible(all, view({ q: 'no such account' })), []);
  });

  it('each filter shows the count it would leave, with the others as they are', () => {
    const c = counts(all, view());
    assert.equal(c.enterprise, visible(all, view({ enterprise: true })).length);
    assert.equal(c.noOwner, visible(all, view({ noOwner: true })).length);
    assert.equal(c.referral, visible(all, view({ referral: true })).length);
    const narrowed = counts(all, view({ enterprise: true }));
    assert.equal(narrowed.referral, visible(all, view({ enterprise: true, referral: true })).length);
    assert.equal(narrowed.enterprise, c.enterprise, 'a filter is not narrowed by itself');
  });

  it('sorts by name, owner, people and latest activity, puts a missing value last, and keeps ties in the API order', () => {
    const byName = sortAccounts(all, 'name', 'asc');
    assert.deepEqual(names(byName).map(n => (n ?? '').toLowerCase()), names(byName).map(n => (n ?? '').toLowerCase()).sort());
    const owners = sortAccounts(all, 'owner', 'asc');
    const firstNoOwner = owners.findIndex(a => !a.owner);
    assert.ok(firstNoOwner === -1 || owners.slice(firstNoOwner).every(a => !a.owner), 'accounts with no owner come last');
    const people = sortAccounts(all, 'people', 'desc').map(a => a.contacts30d);
    assert.deepEqual(people, [...people].sort((a, b) => b - a));
    const latest = sortAccounts(all, 'latest', 'desc').map(a => a.lastActivityAt ?? '');
    assert.deepEqual(latest.filter(Boolean), [...latest.filter(Boolean)].sort().reverse());
    const tied = sortAccounts(all.filter(a => a.contacts30d === 1), 'people', 'asc');
    assert.deepEqual(names(tied), names(all.filter(a => a.contacts30d === 1)), 'equal values keep the API order');
  });

  it('a header click gives the column\'s first direction, then the opposite', () => {
    assert.deepEqual(nextSort(view(), 'name'), { sort: 'name', dir: 'asc' });
    assert.deepEqual(nextSort(view(), 'people'), { sort: 'people', dir: 'desc' });
    assert.deepEqual(nextSort(view({ sort: 'people', dir: 'desc' }), 'people'), { sort: 'people', dir: 'asc' });
  });

  it('shows the first rows, and Show more adds a step until every row is reachable', () => {
    assert.deepEqual(page(158, FIRST_ROWS), { rows: FIRST_ROWS, more: MORE_ROWS, left: 158 - FIRST_ROWS });
    assert.deepEqual(page(158, 125), { rows: 125, more: 33, left: 33 });
    assert.deepEqual(page(158, 175), { rows: 158, more: 0, left: 0 });
    assert.deepEqual(page(3, FIRST_ROWS), { rows: 3, more: 0, left: 0 });
    assert.deepEqual(page(0, FIRST_ROWS), { rows: 0, more: 0, left: 0 });
    let shown = FIRST_ROWS;
    let steps = 0;
    while (page(500, shown).left) { shown += MORE_ROWS; steps++; }
    assert.equal(page(500, shown).rows, 500);
    assert.ok(steps <= 10);
  });

  it('the count line, the active filters in words, and Clear filters keeping the sort', () => {
    assert.equal(countLine(12, 158), '12 of 158 accounts');
    assert.equal(countLine(1, 1), '1 of 1 account');
    assert.deepEqual(activeWords(view({ enterprise: true, noOwner: true, referral: true, q: ' kaiser ' })), ['Enterprise only', 'No owner', 'Has a referral', 'Search "kaiser"']);
    const v = view({ enterprise: true, q: 'x', sort: 'people', dir: 'asc', shown: 125 });
    assert.deepEqual(cleared(v), { ...defaultView(), sort: 'people', dir: 'asc' });
  });

  it('is written to the address without what is the default, and read back', () => {
    assert.equal(buildAddress('today', toParams(view())), '#today');
    const v = view({ enterprise: true, noOwner: true, q: 'kaiser', sort: 'latest', dir: 'desc' });
    const hash = buildAddress('today', toParams(v));
    assert.equal(hash, '#today?enterprise=1&noowner=1&q=kaiser&sort=latest');
    assert.deepEqual(fromParams(parseAddress(hash).params), v);
    assert.equal(buildAddress('today', toParams(view({ sort: 'name', dir: 'desc' }))), '#today?sort=name&dir=desc');
    assert.deepEqual(fromParams(parseAddress('#today?sort=nope&dir=up').params), defaultView());
  });
});
