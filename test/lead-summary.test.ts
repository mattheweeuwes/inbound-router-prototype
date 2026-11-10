// What GET /api/leads carries on each row so the cockpit can filter and sort without opening a lead: the enterprise flag and its
// fact, a named referral, the list, the rule, the use case, the first deal-size cue, the score and the time to alert. The
// working day's events (fixtures/day/morning.json) give an enterprise referral, a deal cue and an ordinary lead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import leadsApi from '../api/leads';
import { ROOT } from '../src/config';
import type { Source } from '../src/schema';
import type { LeadSummary } from '../src/view';
import { post, testCtx } from './helpers';

const FILE = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'day', 'morning.json'), 'utf8')) as { clock: string; events: { id: string; source: Source; payload: unknown }[] };
const byEvent = new Map<string, LeadSummary>();
let all: LeadSummary[] = [];
// the list endpoint's rows, which is what the cockpit reads (the detail endpoint adds the full referral and deal under the same names)

describe('the lead summary rows', () => {
  before(async () => {
    const ctx = testCtx({ now: () => Date.parse(FILE.clock) });
    const ids = new Map<string, string>();
    for (const id of ['D01', 'D04', 'D06', 'D10']) {
      const e = FILE.events.find(x => x.id === id)!;
      const r = await post(ctx, e.source, e.payload);
      ids.set(id, r.json.leadId);
    }
    all = ((await (await leadsApi(new Request('http://local/api/leads?limit=50'), ctx)).json()) as { leads: LeadSummary[] }).leads;
    for (const [event, leadId] of ids) byEvent.set(event, all.find(l => l.id === leadId)!);
  });

  it('D01 is an enterprise lead with its fact, a customer referral naming the referrer, and the rule that sent it to a rep', () => {
    const l = byEvent.get('D01')!;
    assert.equal(l.enterprise, true);
    assert.match(l.enterpriseFact ?? '', /^\d+ hospitals/);
    assert.deepEqual(l.referral, { kind: 'customer', referrer: 'Wrenfield Health' });
    assert.equal(l.rule, 'R10');
    assert.equal(typeof l.score, 'number');
    assert.equal(typeof l.timeToAlertMs, 'number', 'a lead with its own alert has a time to alert');
  });

  it('D04 carries the deal-size cue as the prospect wrote it', () => {
    const l = byEvent.get('D04')!;
    assert.match(l.dealCue ?? '', /licen[cs]e/i);
    assert.equal(l.referral, null);
  });

  it('every row has every new field, and a lead with nothing to say has them empty, not missing', () => {
    assert.ok(all.length >= 4);
    for (const l of all) {
      for (const k of ['enterprise', 'enterpriseFact', 'referral', 'rule', 'dealCue', 'timeToAlertMs', 'list', 'useCase', 'score']) assert.ok(k in l, `${l.id} has ${k}`);
      assert.equal(typeof l.enterprise, 'boolean');
    }
    const plain = all.find(l => !l.enterprise && !l.referral && !l.dealCue);
    assert.ok(plain, 'the day has an ordinary lead');
    assert.deepEqual([plain.enterpriseFact === null || typeof plain.enterpriseFact === 'string', plain.dealCue], [true, null]);
  });

  it('the enterprise flag on a row is the same as the enterprise flag in its flags', () => {
    for (const l of all) assert.equal(l.enterprise, l.flags.includes('enterprise'), l.id);
    for (const l of all) assert.equal(l.referral !== null, l.flags.includes('referral'), l.id);
  });

  it('a row stays small: no row of the day is over 1.2 KB of JSON', () => {
    for (const l of all) assert.ok(JSON.stringify(l).length < 1200, `${l.id}: ${JSON.stringify(l).length}`);
  });
});
