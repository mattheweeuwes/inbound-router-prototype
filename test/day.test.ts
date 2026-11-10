// The working day (scripts/lib/day.ts, docs/day-in-the-life.md) as a test: the same scenario `npm run day` plays, on the test
// registry and the invented rate file. Every event of fixtures/day/morning.json has the sentence a seller or marketer would
// expect of it, and an assertion that checks what the router did against it.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { join } from 'node:path';
import { ROOT } from '../src/config';
import { briefText } from '../src/todayBrief';
import { checkDay, decisionFingerprint, loadDay, playDay, reportText, type Assertion, type DayReport, type PlayedDay } from '../scripts/lib/day';
import { testCtx } from './helpers';

const day = loadDay();
const dayCtx = () => testCtx({ now: () => Date.parse(day.clock), usageFixtures: join(ROOT, 'fixtures', 'usage') });

let played: PlayedDay;
let report: DayReport;

const failures = (list: readonly Assertion[]) => list.filter(a => !a.pass).map(a => `${a.what} (got ${a.got})`);

describe('a working day at Serif', () => {
  before(async () => {
    played = await playDay(dayCtx());
    const again = await playDay(dayCtx());
    report = checkDay(played, day, decisionFingerprint(again.list.leads));
  });

  for (const e of day.events) {
    it(`${e.id}: ${e.expect}`, () => {
      const r = report.events.find(x => x.id === e.id)!;
      assert.ok(r.assertions.length > 0, 'the event has an assertion');
      assert.deepEqual(failures(r.assertions), [], r.happened);
    });
  }

  it('the 150-scan list: every row finished, nothing alerted on its own but a rep alert, one digest per team, repeats attached, the same decisions on the same seed', () => {
    const g = report.groups.find(x => x.title.endsWith('list'))!;
    assert.deepEqual(failures(g.assertions), []);
  });
  it('outbound counts add up to the groups and the export has a row per ready draft', () => {
    assert.deepEqual(failures(report.groups.find(x => x.title === 'Outbound')!.assertions), []);
  });
  it('accounts come back with enterprise ones first', () => {
    assert.deepEqual(failures(report.groups.find(x => x.title === 'Accounts')!.assertions), []);
  });
  it('feature interest from the day reaches the attribution API', () => {
    assert.deepEqual(failures(report.groups.find(x => x.title === 'Feature interest')!.assertions), []);
  });
  it('the brief has every section', () => {
    assert.deepEqual(failures(report.groups.find(x => x.title === 'The brief')!.assertions), []);
  });

  it('the report and the brief print as plain text, with every event in the report', () => {
    const text = reportText(played, report);
    for (const e of day.events) assert.match(text, new RegExp(`^${e.id}  (PASS|FAIL)`, 'm'));
    assert.match(text, /assertions passed, 0 failed/);
    assert.match(briefText(played.brief), /NEEDS A PERSON NOW/);
  });
});
