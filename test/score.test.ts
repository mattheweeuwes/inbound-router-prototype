import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead, tierFor, type ScoreInput } from '../src/score';
import type { Classification, Resolution } from '../src/schema';
import { adapt } from '../src/sources';
import { buildPayload } from '../src/payloads';
import { normalizeEvent } from '../src/normalize';
import { spec } from './helpers';
import type { Source } from '../src/schema';

const lookups = { isFreeMail: () => false, isDisposable: () => false };
const res = (over: Partial<Resolution>): Resolution => ({ status: 'resolved', accountId: 'x', accountName: 'X', segment: 'health_system', subsegment: null, confidence: 'high', method: 'org_domain', matchScore: null, evidence: [], firmographics: {}, candidates: [], inferred: false, ...over });
const cls = (over: Partial<Classification> = {}): Classification => ({ reasons: '', useCase: 'other', urgency: 'unknown', buyingRole: 'unknown', disqualifier: 'none', confidence: 0.9, ...over });

function lead(source: Source, s: Parameters<typeof spec>[0], r: Resolution, c: Classification, extra: Partial<ScoreInput> = {}) {
  const ev = adapt(source, buildPayload(source, spec(s)));
  const n = normalizeEvent(ev, lookups);
  return scoreLead({ ev, n, res: r, final: c, priorTouches: 0, accountIntent: 0, ...extra });
}

describe('score: three hand-computed leads', () => {
  it('A: VP contracting at a 33-hospital system, demo booked, renegotiating in January = 90', () => {
    const s = lead('calendly_demo', { title: 'VP Managed Care Contracting' }, res({ firmographics: { hospitals: 33 } }), cls({ urgency: 'now' }));
    // fit: segment 22 + size 16 + persona round(10 x 1.2) = 12 -> 50. intent: demo 28 + now 12 = 40
    assert.deepEqual([s.fit, s.intent, s.total, s.tier], [50, 40, 90, 'A']);
    assert.equal(s.items.reduce((a, i) => a + i.points, 0), 90, 'every point is an itemized line');
  });
  it('B: CFO of a 150-bed standalone hospital, demo, this quarter = 65', () => {
    const s = lead('calendly_demo', { title: 'Chief Financial Officer' }, res({ segment: 'standalone_hospital', firmographics: { beds: 150 } }), cls({ urgency: 'this_quarter' }));
    // fit: 14 + 6 + round(8 x 1.2 = 9.6) = 10 -> 30. intent: 28 + 7 = 35
    assert.deepEqual([s.fit, s.intent, s.total, s.tier], [30, 35, 65, 'B']);
  });
  it('C: regional broker advisor downloads a guide = 47', () => {
    const s = lead('guide_download', { title: 'Benefits Advisor' }, res({ segment: 'benefits_consultant_broker', firmographics: { sizeClass: 'regional' } }), cls());
    // fit: 20 + 8 + round(10 x 0.85 = 8.5) = 9 -> 37. intent: guide 10
    assert.deepEqual([s.fit, s.intent, s.total, s.tier], [37, 10, 47, 'C']);
  });
});

describe('score: caps, usage and repeat engagement', () => {
  it('product usage is capped at 10 and repeat touches at 8', () => {
    const usage = [1, 2, 3].map(i => ({ event: 'session_start' as const, at: `2026-11-05T1${i}:00:00Z` })).concat([{ event: 'search' as never, at: '2026-11-05T14:00:00Z' }]);
    const s = lead('sample_signup', { title: 'Product Analyst', usage }, res({ segment: 'unknown_org', method: 'none', confidence: 'low', status: 'unresolved' }), cls({ urgency: 'exploring' }), { priorTouches: 3 });
    const usagePts = s.items.filter(i => i.label.startsWith('Usage') || i.label.startsWith('Cap: product usage')).reduce((a, i) => a + i.points, 0);
    assert.equal(usagePts, 10);
    assert.equal(s.items.find(i => i.label.startsWith('Repeat'))?.points, 8);
    // fit: 6 + 0 + round(7 x 0.9 = 6.3) = 6 -> 12. intent: 16 + 2 + 10 + 8 = 36
    assert.deepEqual([s.fit, s.intent, s.total], [12, 36, 48]);
  });
  it('disqualified leads are tier X whatever the points', () => {
    const s = lead('calendly_demo', { title: 'VP Managed Care Contracting' }, res({ firmographics: { hospitals: 33 } }), cls({ urgency: 'now', disqualifier: 'student' }));
    assert.equal(s.tier, 'X');
  });
  it('tier boundaries', () => {
    assert.deepEqual([70, 69, 50, 49, 30, 29].map(tierFor), ['A', 'B', 'B', 'C', 'C', 'D']);
  });
});
