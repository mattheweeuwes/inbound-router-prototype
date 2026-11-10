// Parity with the take-home's analysis (Part 1, results.md) on Serif's real rate file. It runs only when the file is on
// disk (npm run rates:fetch puts it there); CI and the gates use the synthetic fixture and skip it.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT } from '../src/config';
import { factor, tier } from '../src/outbound/patterns';
import { outboundDetail, outboundSummary } from '../src/outbound/view';
import { testCtx } from './helpers';

const REAL = join(ROOT, 'data', 'rates', 'mrf_rate_search_export.csv');
const skip = existsSync(REAL) ? false : 'the real rate file is not on disk (npm run rates:fetch)';

describe('outbound parity with the take-home on the real rate file', { skip }, () => {
  it('reproduces every number the take-home reports', () => {
    const ctx = testCtx({ ratesCsv: REAL, outboundPlatforms: join(ROOT, 'fixtures', 'outbound-platforms.json') });
    const s = outboundSummary(ctx);
    assert.deepEqual([ctx.outbound.rows, s.groups.length], [205, 127]);

    const bands = s.summary!.bands;
    assert.deepEqual(bands.map(b => b.groups), [35, 45, 47]);
    assert.deepEqual(bands.map(b => b.medianPctOfMedicare), [81, 86, 127]);

    // the card: 15 of the 89 distinct rates are a whole percent of $141.47 to the cent
    const p = ctx.store.outbound.patterns();
    assert.deepEqual([p.card?.value, p.card?.hits, p.card?.distinctRates], [141.47, 15, 89]);
    assert.deepEqual(p.card?.runnersUp.map(h => [h.value, h.hits]), [[138.8, 9], [124.92, 8]]);
    assert.deepEqual(bands.map(b => b.card), [22, 18, 6]);

    // the factor: 16 distinct rates are whole-dollar multiples of $3.47, from 33 to 97 times
    assert.deepEqual([p.factor?.value, p.factor?.hits], [3.47, 16]);
    const multiples = ctx.store.outbound.distinctRates().map(r => factor(r, 3.47)).filter((k): k is number => k !== null);
    assert.deepEqual([Math.min(...multiples), Math.max(...multiples)], [33, 97]);
    assert.deepEqual(bands.map(b => b.factor), [1, 10, 7]);

    // 3 groups at $183.91 fit both: 130% of the card and 53 x $3.47
    const both = s.groups.filter(g => g.form === 'both');
    assert.deepEqual(both.map(g => [g.rate, g.cardTier, g.factorMultiple]), [[183.91, 130, 53], [183.91, 130, 53], [183.91, 130, 53]]);
    assert.equal(tier(183.91, 141.47), 130);
  });
  it('writes the rate line and the drafts the take-home describes', () => {
    const ctx = testCtx({ ratesCsv: REAL, outboundPlatforms: join(ROOT, 'fixtures', 'outbound-platforms.json') });
    assert.equal(outboundDetail(ctx, '756004221')!.rateLine,
      'Their UHC Choice Plus rate for 90837 (Aug 2026): $163.09, 97% of Medicare, a $47 conversion factor; top rate in Dallas $378.38.');
    const psychplus = outboundDetail(ctx, '992536327')!;
    assert.deepEqual([psychplus.finding.rate, psychplus.finding.pctOfMedicare, psychplus.finding.clinicians, psychplus.draft?.status], [116.07, 69, 929, 'ready']);
    assert.equal(psychplus.draft?.subject, "PsychPlus's UHC rate in Texas: 69% of Medicare");
    // its EIN draws the rate-range hook, whose second sentence is the take-home's
    assert.equal(psychplus.draft?.hook, 'rate_range');
    assert.match(psychplus.draft!.body, /inside the \$106 to \$149 range where most small psychiatry groups sit, which looks like one UHC fee schedule paid at 75% to 105%/);
    assert.equal(outboundDetail(ctx, '851628740')!.draft?.status, 'blocked');
    assert.equal(outboundDetail(ctx, '462718719')!.draft?.status, 'ready');
  });
});
