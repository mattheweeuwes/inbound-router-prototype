import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, nextAttempt, parseRetryAfter, RETRY_AFTER_CAP_MS, WakeUp } from '../src/retry';

const policy = { baseMs: 1000, maxMs: 8000, maxAttempts: 5 };

describe('backoff', () => {
  it('doubles from the base and stops at the cap', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => backoffMs(n, policy)), [1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it('retries until the last attempt, then gives up', () => {
    assert.deepEqual(nextAttempt(1, policy, 0), { retry: true, atMs: 1000 });
    assert.deepEqual(nextAttempt(4, policy, 0), { retry: true, atMs: 8000 });
    assert.deepEqual(nextAttempt(5, policy, 0), { retry: false });
  });

  it('a Retry-After longer than the backoff wins; a shorter one does not shorten it; an absurd one is capped', () => {
    assert.deepEqual(nextAttempt(1, policy, 100, 30_000), { retry: true, atMs: 30_100 });
    assert.deepEqual(nextAttempt(3, policy, 100, 10), { retry: true, atMs: 4100 });
    assert.deepEqual(nextAttempt(1, policy, 0, 10 * RETRY_AFTER_CAP_MS), { retry: true, atMs: RETRY_AFTER_CAP_MS });
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-05T15:00:00.000Z');
  it('reads delta-seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('120', now), 120_000);
    assert.equal(parseRetryAfter(' 0 ', now), 0);
    assert.equal(parseRetryAfter('Thu, 05 Nov 2026 15:00:30 GMT', now), 30_000);
    assert.equal(parseRetryAfter('Thu, 05 Nov 2026 14:00:00 GMT', now), 0, 'a date in the past means now');
  });
  it('ignores what it cannot read', () => {
    assert.deepEqual([parseRetryAfter(null, now), parseRetryAfter('', now), parseRetryAfter('soon', now), parseRetryAfter('-5', now)], [null, null, null, null]);
  });
});

describe('WakeUp', () => {
  it('fires once, at the earliest time asked for', async () => {
    const fired: number[] = [];
    const w = new WakeUp(() => fired.push(Date.now()));
    const now = Date.now();
    w.at(now + 200, now);
    w.at(now + 10, now); // earlier: replaces
    w.at(now + 100, now); // later than the one set: ignored
    await new Promise(r => setTimeout(r, 60));
    assert.equal(fired.length, 1);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(fired.length, 1, 'the later requests did not fire on their own');
  });

  it('can be set again after it fired, and cancelled', async () => {
    let n = 0;
    const w = new WakeUp(() => { n++; });
    w.at(Date.now(), Date.now());
    await new Promise(r => setTimeout(r, 20));
    w.at(Date.now() + 5, Date.now());
    w.cancel();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(n, 1);
  });
});
