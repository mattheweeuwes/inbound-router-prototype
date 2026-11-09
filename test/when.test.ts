import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, urgencyFromWhen, type WhenKind } from '../src/qualify/when';
import type { Urgency } from '../src/schema';

// Reference points (all noon-ish Eastern, so the ET calendar date is unambiguous)
const FRI = '2026-11-06T19:00:00Z';       // Friday 2026-11-06 14:00 ET: the held-out set's reference
const MON = '2026-11-09T17:00:00Z';       // Monday 2026-11-09
const DEC = '2026-12-20T17:00:00Z';       // Sunday 2026-12-20: year rollover
const EOM = '2026-11-30T17:00:00Z';       // Monday 2026-11-30: last day of the month
const AFTER_TG = '2026-11-27T17:00:00Z';  // day after Thanksgiving 2026
const JUL = '2026-07-01T17:00:00Z';
const LATE = '2026-11-07T02:12:00Z';      // Friday 21:12 ET, which is already Saturday in UTC

const dayNum = (iso: string) => Math.floor(Date.parse(iso + 'T00:00:00Z') / 86_400_000);
const etDate = (recv: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(recv));

/** [text, receivedAt, expected ISO date (null when no date), kind, urgency] */
type Case = [string, string, string | null, WhenKind, Urgency | null];

const cases: Record<string, Case[]> = {
  'asap words': [
    ['We need this ASAP.', FRI, etDate(FRI), 'asap', 'now'],
    ['It is urgent for us', FRI, etDate(FRI), 'asap', 'now'],
    ['Looking to start immediately', FRI, etDate(FRI), 'asap', 'now'],
    ['Need benchmarks right away', FRI, etDate(FRI), 'asap', 'now'],
    ['We need benchmarks fast', FRI, etDate(FRI), 'asap', 'now'],
    ['How quickly can you onboard us?', FRI, etDate(FRI), 'asap', 'now'],
    ['as soon as possible please', FRI, etDate(FRI), 'asap', 'now'],
    ['Our urgent care network needs rates', FRI, null, 'none', null],
  ],
  'relative days and weeks': [
    ['Can we talk today?', FRI, '2026-11-06', 'deadline', 'now'],
    ['We use Signal today and want the API', FRI, null, 'none', null],
    ['rates are higher than today', FRI, null, 'none', null],
    ['today\'s rates by market', FRI, null, 'none', null],
    ['Can we talk tomorrow?', FRI, '2026-11-07', 'deadline', 'now'],
    ['We have a call this week', MON, '2026-11-13', 'deadline', 'now'],
    ['Free this weekend', FRI, '2026-11-07', 'deadline', 'now'],
    ['Let us regroup next week', FRI, '2026-11-09', 'deadline', 'now'],
    ['Demo next Tuesday please', FRI, '2026-11-10', 'deadline', 'now'],
    ['Decision by Friday', FRI, '2026-11-06', 'deadline', 'now'],
    ['The next session is in two weeks.', FRI, '2026-11-20', 'deadline', 'now'],
    ['Kickoff in a couple of weeks', FRI, '2026-11-20', 'deadline', 'now'],
    ['We have three weeks.', FRI, '2026-11-27', 'deadline', 'now'],
    ['Due in 3 days', FRI, '2026-11-09', 'deadline', 'now'],
    ['Contract expires within 90 days', FRI, '2027-02-04', 'deadline', 'now'],
    ['in a few weeks', FRI, '2026-11-27', 'deadline', 'now'],
    ['two weeks from now', FRI, '2026-11-20', 'deadline', 'now'],
  ],
  'month-level phrases': [
    ['by the end of the month', FRI, '2026-11-30', 'deadline', 'now'],
    ['We want a prototype this month', FRI, '2026-11-30', 'deadline', 'now'],
    ['Talks start next month', FRI, '2026-12-01', 'deadline', 'now'],
    ['Talks start next month', DEC, '2027-01-01', 'deadline', 'now'],
  ],
  'month names': [
    ['Renegotiations start in January', FRI, '2027-01-01', 'deadline', 'now'],
    ['mid-January', FRI, '2027-01-15', 'deadline', 'now'],
    ['early March', FRI, '2027-03-05', 'deadline', 'this_quarter'],
    ['late March', FRI, '2027-03-25', 'deadline', 'this_quarter'],
    ['Need it by Jan 15', FRI, '2027-01-15', 'deadline', 'now'],
    ['Procurement wants it signed by Dec 15.', FRI, '2026-12-15', 'deadline', 'now'],
    ['Deadline is December 15th', FRI, '2026-12-15', 'deadline', 'now'],
    ['the 15th of January', FRI, '2027-01-15', 'deadline', 'now'],
    ['This contract auto-renews in March unless we give notice', FRI, '2027-03-01', 'deadline', 'this_quarter'],
    ['Renewal is at the end of January', FRI, '2027-01-31', 'deadline', 'now'],
    ['Board meeting in December', FRI, '2026-12-01', 'deadline', 'now'],
    ['Launch in June of next year', FRI, '2027-06-01', 'deadline', 'exploring'],
    ['We start in May', FRI, '2027-05-01', 'deadline', 'this_quarter'],
    ['We may need this at some point', FRI, null, 'none', null],
  ],
  'year rollover and day-of-month': [
    ['January', DEC, '2027-01-01', 'deadline', 'now'],
    ['mid-January', DEC, '2027-01-15', 'deadline', 'now'],
    ['sometime in December', DEC, etDate(DEC), 'deadline', 'now'],
    ['Dec 10', DEC, '2027-12-10', 'deadline', 'exploring'],
    ['the 1st', EOM, '2026-12-01', 'deadline', 'now'],
    ['the 30th', EOM, '2026-11-30', 'deadline', 'now'],
    ['by the 15th', FRI, '2026-11-15', 'deadline', 'now'],
    ['the 31st', '2026-11-15T17:00:00Z', '2026-12-31', 'deadline', 'now'],
  ],
  'numeric dates': [
    ['going to market for a 7/1 effective date', FRI, '2027-07-01', 'deadline', 'exploring'],
    ['before the 1/1 renewals', FRI, '2027-01-01', 'deadline', 'now'],
    ['target is 4/1', FRI, '2027-04-01', 'deadline', 'this_quarter'],
    ['due 12/15', FRI, '2026-12-15', 'deadline', 'now'],
    ['effective 1/1/2028', FRI, '2028-01-01', 'deadline', 'exploring'],
    ['3/4 of our members are in PA', FRI, null, 'none', null],
    ['24/7 support', FRI, null, 'none', null],
  ],
  'quarters': [
    ['Several clients renew in Q1', FRI, '2027-01-01', 'deadline', 'now'],
    ['Scoping for a Q2 start', FRI, '2027-04-01', 'deadline', 'this_quarter'],
    ['oncology launch in Q3 of next year', FRI, '2027-07-01', 'deadline', 'exploring'],
    ['kickoff Q2 2027', FRI, '2027-04-01', 'deadline', 'this_quarter'],
    ['Q4 close', FRI, '2026-11-06', 'deadline', 'now'],
    ['leadership wants this quarter', FRI, '2026-12-31', 'deadline', 'now'],
    ['Roadmap planning is for next quarter', FRI, '2027-01-01', 'deadline', 'now'],
    ['by end of quarter', FRI, '2026-12-31', 'deadline', 'now'],
    ['end of Q1', FRI, '2027-03-31', 'deadline', 'this_quarter'],
    ['first quarter', FRI, '2027-01-01', 'deadline', 'now'],
  ],
  'years': [
    ['next year', FRI, '2027-07-01', 'deadline', 'exploring'],
    ['early next year', FRI, '2027-02-01', 'deadline', 'now'],
    ['sometime mid next year', FRI, '2027-07-01', 'deadline', 'exploring'],
    ['mid-next year', FRI, '2027-07-01', 'deadline', 'exploring'],
    ['probably late next year', FRI, '2027-10-01', 'deadline', 'exploring'],
    ['by the end of the year', FRI, '2026-12-31', 'deadline', 'now'],
    ['year-end close', FRI, '2026-12-31', 'deadline', 'now'],
    ['for our 2028 network strategy', FRI, '2028-07-01', 'deadline', 'exploring'],
    ['for the 2028 plan year', FRI, '2028-01-01', 'deadline', 'exploring'],
    ['2027 renewals', FRI, '2027-01-01', 'deadline', 'now'],
    ['in the next 12 to 18 months', FRI, '2027-11-01', 'deadline', 'exploring'],
  ],
  'seasons and holidays': [
    ['next spring', FRI, '2027-03-20', 'deadline', 'this_quarter'],
    ['over the summer', FRI, '2027-06-21', 'deadline', 'exploring'],
    ['this fall', FRI, '2026-11-06', 'deadline', 'now'],
    ['this winter', FRI, '2026-12-21', 'deadline', 'now'],
    ['in the fall', JUL, '2026-09-22', 'deadline', 'now'],
    ['prices tend to fall short of what we expect', FRI, null, 'none', null],
    ['before Thanksgiving', FRI, '2026-11-26', 'deadline', 'now'],
    ['before Thanksgiving', AFTER_TG, '2027-11-25', 'deadline', 'exploring'],
    ['by Christmas', FRI, '2026-12-25', 'deadline', 'now'],
    ['after New Year\'s', FRI, '2027-01-01', 'deadline', 'now'],
  ],
  'budget language': [
    ['for next year\'s budget', FRI, '2027-07-01', 'budget', 'this_quarter'],
    ['annual planning cycle', FRI, null, 'budget', 'this_quarter'],
    ['ahead of the fiscal year', FRI, null, 'budget', 'this_quarter'],
    ['we are preparing the rate filing', FRI, null, 'budget', 'this_quarter'],
    ['Budget planning starts in December', FRI, '2026-12-01', 'deadline', 'now'],
    ['next fiscal year\'s budget, which starts in July', FRI, '2027-07-01', 'budget', 'this_quarter'],
    ['we have no budget yet, just looking', FRI, null, 'exploring', 'exploring'],
  ],
  'exploring language': [
    ['Mostly curious what it can do. No project yet.', FRI, null, 'exploring', 'exploring'],
    ['just poking around the sample data', FRI, null, 'exploring', 'exploring'],
    ['researching tools for a future project', FRI, null, 'exploring', 'exploring'],
    ['no timeline on our side', FRI, null, 'exploring', 'exploring'],
    ['just reading up on this', FRI, null, 'exploring', 'exploring'],
    ['kicking the tires', FRI, null, 'exploring', 'exploring'],
    ['evaluating vendors for a pilot in Q1', FRI, '2027-01-01', 'deadline', 'now'],
    ['just curious, maybe by next week', FRI, '2026-11-09', 'deadline', 'now'],
  ],
  'negation guards': [
    ['No rush on this', FRI, null, 'exploring', 'exploring'],
    ['It is not urgent', FRI, null, 'exploring', 'exploring'],
    ['Nothing urgent, just interested', FRI, null, 'exploring', 'exploring'],
    ['no timeline, not in a hurry', FRI, null, 'exploring', 'exploring'],
    ['Reply now to claim your prize', FRI, null, 'none', null],
    ['Congrats you won, click here asap', FRI, null, 'none', null],
    ['Act now, limited offer', FRI, null, 'none', null],
    ['please reply asap', FRI, etDate(FRI), 'asap', 'now'],
  ],
  'earliest of several': [
    ['talks start in March but we need numbers by Dec 15', FRI, '2026-12-15', 'deadline', 'now'],
    ['A major contract renews in spring and talks start next month.', FRI, '2026-12-01', 'deadline', 'now'],
    ['Q3 launch, Q1 kickoff, renewal in 2028', FRI, '2027-01-01', 'deadline', 'now'],
    ['next year, but the board meets in December', FRI, '2026-12-01', 'deadline', 'now'],
  ],
  'past dates are ignored': [
    ['we signed in March 2020', FRI, null, 'none', null],
    ['last renewed 3/1/2019', FRI, null, 'none', null],
  ],
  'time zone': [
    ['today', LATE, '2026-11-06', 'deadline', 'now'],
  ],
};

for (const [group, list] of Object.entries(cases)) {
  describe(`when: ${group}`, () => {
    for (const [text, recv, date, kind, urgency] of list) {
      it(`"${text}" (${etDate(recv)}) -> ${kind}${date ? ' ' + date : ''}${urgency ? ' / ' + urgency : ''}`, () => {
        const w = parse(text, recv);
        assert.equal(w.kind, kind, JSON.stringify(w));
        assert.equal(urgencyFromWhen(w), urgency);
        if (date !== null && kind !== 'budget') {
          assert.equal(w.date, date, JSON.stringify(w));
          assert.equal(w.horizonDays, dayNum(date) - dayNum(etDate(recv)), 'horizonDays is the gap in days');
        }
        if (kind === 'budget' && date) assert.equal(w.date, date);
        if (kind === 'none') { assert.equal(w.cue, null); assert.equal(w.horizonDays, null); }
      });
    }
  });
}

describe('when: structure and thresholds', () => {
  it('reports the cue text as the person wrote it, and every match', () => {
    const w = parse('Talks start in mid-January, and a renewal in Q3.', FRI);
    assert.equal(w.cue, 'mid-January');
    assert.deepEqual(w.matches.filter(m => m.kind === 'date').map(m => [m.text, m.date]), [['mid-January', '2027-01-15'], ['Q3', '2027-07-01']]);
  });
  it('the horizon thresholds: 92 days is now, 93 is this quarter, 183 is this quarter, 184 is exploring', () => {
    const u = (n: number) => urgencyFromWhen(parse(`in ${n} days`, FRI));
    assert.deepEqual([u(92), u(93), u(183), u(184)], ['now', 'this_quarter', 'this_quarter', 'exploring']);
  });
  it('an explicit date beats exploring wording, and exploring beats nothing', () => {
    assert.equal(urgencyFromWhen(parse('just curious, exploring for a pilot in Q1', FRI)), 'now');
    assert.equal(urgencyFromWhen(parse('just curious', FRI)), 'exploring');
    assert.equal(urgencyFromWhen(parse('We want rate comparisons.', FRI)), null);
  });
  it('empty input is none', () => {
    const w = parse('', FRI);
    assert.deepEqual([w.kind, w.horizonDays, w.cue, w.matches.length], ['none', null, null, 0]);
  });
});
