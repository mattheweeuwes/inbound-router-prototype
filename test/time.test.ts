import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addBusinessMinutes, iso, isBusinessTime, nextBusinessOpen } from '../src/time';

const t = (s: string) => Date.parse(s);
describe('business-hours math (Mon-Fri 09:00-18:00 ET)', () => {
  it('knows business time', () => {
    assert.equal(isBusinessTime(t('2026-11-05T15:00:00Z')), true);  // Thu 10:00 ET
    assert.equal(isBusinessTime(t('2026-11-07T02:12:00Z')), false); // Fri 21:12 ET
    assert.equal(isBusinessTime(t('2026-11-07T15:00:00Z')), false); // Sat
  });
  it('rolls Friday night to Monday 09:00 ET', () => assert.equal(iso(nextBusinessOpen(t('2026-11-07T02:12:00Z'))), '2026-11-09T14:00:00.000Z'));
  it('adds inside the day', () => assert.equal(iso(addBusinessMinutes(t('2026-11-05T15:00:00Z'), 60)), '2026-11-05T16:00:00.000Z'));
  it('carries over the close into the next morning', () => assert.equal(iso(addBusinessMinutes(t('2026-11-05T22:30:00Z'), 60)), '2026-11-06T14:30:00.000Z'));
  it('survives the fall-back DST change (2026-11-01)', () => {
    assert.equal(iso(addBusinessMinutes(t('2026-10-30T20:00:00Z'), 120)), '2026-10-30T22:00:00.000Z'); // Fri 16:00 EDT + 2h = 18:00 EDT
    assert.equal(iso(addBusinessMinutes(t('2026-10-30T21:30:00Z'), 60)), '2026-11-02T14:30:00.000Z');   // Fri 17:30 EDT + 30 min, then Mon 09:30 EST
  });
});
