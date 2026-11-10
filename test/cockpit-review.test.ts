// The Needs a person tab's logic with no DOM (public/review-model.js), on what GET /api/review returns for a tie, an
// unplaced company and a list: how items group, which buttons each gets, where focus goes after a decision, and the words.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  arrivedLine, arrivedSince, decidedHeading, decidedRow, displayOrder, groupItems, itemButtons, nextFocus, nurtureAllConfirm, nurtureAllLabel, nurtureAllYes, openHeadline, reasonWords, rowsLeft,
  type OpenItem, type ReviewView,
} from '../public/review-model.js';
import reviewApi from '../api/review';
import { buildPayload } from '../src/payloads';
import { whenIdle } from '../src/pipeline';
import { post, spec, submit, testCtx } from './helpers';

async function view(): Promise<ReviewView> {
  const ctx = testCtx({ demoRoutes: true });
  await submit(ctx, 'calendly_demo', { email: 'lprice@gmail.com', first: 'Lee', last: 'Price', company: 'Baptist Health', state: undefined, message: 'I am benchmarking commercial rates.' });
  for (const [i, d] of ['harrowgatemills', 'tidewaterfreight'].entries()) {
    await post(ctx, 'event_scan', buildPayload('event_scan', spec({ event: 'HLTH', notes: '', message: undefined, email: `p${i}@${d}.example`, company: `${d} Inc`, title: 'Operations Manager', seed: `u${i}` })), { wait: false });
  }
  await whenIdle(ctx);
  return (await (await reviewApi(new Request('http://local/api/review'), ctx)).json()) as ReviewView;
}

describe('cockpit Needs a person: grouping, buttons and focus', () => {
  it('groups a list under its name, counts the rows Send all would decide, and keeps the others apart', async () => {
    const v = await view();
    assert.equal(v.demoActions, true);
    const { lists, single } = groupItems(v.open);
    assert.deepEqual(lists.map(l => [l.name, l.items.length, l.unplaced]), [['HLTH', 2, 2]]);
    assert.deepEqual(single.map(i => i.reason), ['ambiguous_company']);
    assert.deepEqual(displayOrder(v.open).map(i => i.list ?? 'single'), ['HLTH', 'HLTH', 'single'], 'the list rows first, as the page draws them');
  });

  it('a tie gets its candidates and nurture or not a buyer; a doubt gets it is a buyer', async () => {
    const v = await view();
    const tie = v.open.find(i => i.reason === 'ambiguous_company')!;
    assert.ok(tie.candidates.length >= 2, 'the tied candidates, each with its own Use this account');
    assert.deepEqual(itemButtons(tie).map(b => b.label), ['Send to nurture', 'Not a buyer']);
    const doubt: OpenItem = { ...tie, reason: 'model_doubt_after_alert', kind: 'doubt', decisions: ['is_buyer', 'not_a_buyer'] };
    assert.deepEqual(itemButtons(doubt).map(b => b.label), ['It is a buyer', 'Not a buyer']);
  });

  it('focus goes to the next open item, then back, then nowhere', () => {
    const order = ['a', 'b', 'c'];
    assert.equal(nextFocus(order, 'a', new Set(['a'])), 'b');
    assert.equal(nextFocus(order, 'b', new Set(['a', 'b'])), 'c');
    assert.equal(nextFocus(order, 'c', new Set(['c'])), 'b', 'the last one hands focus to the one before it');
    assert.equal(nextFocus(order, 'c', new Set(['a', 'b', 'c'])), null);
  });

  it('words: counts, the list button and its question, a reason, a decided row', () => {
    assert.equal(openHeadline(0), 'Nothing is waiting for a person right now.');
    assert.equal(openHeadline(1), '1 item needs a person');
    assert.equal(openHeadline(18), '18 items need a person');
    assert.equal(rowsLeft(1), '1 row from this list needs a person');
    assert.equal(rowsLeft(0), 'every row decided');
    assert.equal(nurtureAllLabel(16), 'Send all 16 to nurture');
    assert.equal(nurtureAllYes(16), 'Yes, send 16 to nurture');
    assert.deepEqual(arrivedSince(['a', 'b', 'c'], ['a', 'c']), ['b'], 'an item decided in the tab is still one the tab has shown');
    assert.deepEqual([arrivedLine(1), arrivedLine(3)], ['1 more item arrived while this was open.', '3 more items arrived while this was open.']);
    assert.match(nurtureAllConfirm(16, 'HLTH'), /^Send all 16 rows from HLTH that nobody could place to marketing's nurture track\?/);
    assert.equal(reasonWords('ambiguous_company'), 'Which organization is it?');
    assert.equal(decidedHeading(3), 'Decided, newest first (3)');
    const row = decidedRow({ leadId: 'x', reason: 'ambiguous_company', decision: 'use_account', by: 'Riley', note: null, at: '2026-11-10T15:00:00.000Z', person: 'Lee Price', company: 'Baptist Health', list: null, outcome: 'Routed: tier B, Health Systems & Providers queue' }, () => 'Nov 10');
    assert.deepEqual(row, { person: 'Lee Price', company: 'Baptist Health', what: 'Used an account', outcome: 'Routed: tier B, Health Systems & Providers queue', who: 'Riley', when: 'Nov 10', note: '' });
  });
});
