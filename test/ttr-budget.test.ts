// The CI time-to-route budget: pass at or under, fail over, fail when nothing was routed, error on an unusable budget.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTtrBudget, parseBudget } from '../scripts/lib/ttr-budget';

describe('checkTtrBudget', () => {
  it('passes under the budget and prints the one-line verdict', () => {
    const r = checkTtrBudget(41, 1000);
    assert.equal(r.pass, true);
    assert.equal(r.line, 'time-to-route budget: p90 41ms <= 1000ms PASS');
    assert.deepEqual([r.p90Ms, r.budgetMs], [41, 1000]);
  });
  it('passes when equal to the budget', () => assert.equal(checkTtrBudget(1000, 1000).pass, true));
  it('fails over the budget', () => {
    const r = checkTtrBudget(1001, 1000);
    assert.equal(r.pass, false);
    assert.equal(r.line, 'time-to-route budget: p90 1001ms > 1000ms FAIL');
  });
  it('fails when nothing was routed (null p90), never a silent pass', () => {
    const r = checkTtrBudget(null, 1000);
    assert.equal(r.pass, false);
    assert.equal(r.p90Ms, null);
    assert.match(r.line, /FAIL/);
  });
  it('fails on a p90 that is not a finite number', () => {
    assert.equal(checkTtrBudget(Number.NaN, 1000).pass, false);
    assert.equal(checkTtrBudget(undefined as unknown as number, 1000).pass, false);
  });
  it('passes a zero p90 (a measured result, however fast)', () => assert.equal(checkTtrBudget(0, 1000).pass, true));
  it('throws on a budget that is not a positive finite number', () => {
    for (const bad of [0, -5, Number.NaN, Infinity, '1000' as unknown as number]) assert.throws(() => checkTtrBudget(10, bad), /budget/, String(bad));
  });
});

describe('parseBudget', () => {
  it('reads plain positive numbers', () => {
    assert.equal(parseBudget('1000'), 1000);
    assert.equal(parseBudget(' 250.5 '), 250.5);
  });
  it('throws on anything else: blank, words, zero, negative, signs, exponents, hex, Infinity', () => {
    for (const bad of ['', '  ', 'abc', '0', '0.0', '-1', '+5', '1e3', '0x10', 'Infinity', 'NaN', '10ms', '1,000']) assert.throws(() => parseBudget(bad), /TTR_P90_BUDGET_MS/, JSON.stringify(bad));
  });
});
