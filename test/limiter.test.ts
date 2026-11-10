import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter } from '../src/limiter';

const tick = () => new Promise(r => setTimeout(r, 1));

describe('Limiter', () => {
  it('runs at most max at once, and frees the slot when the work throws', async () => {
    const l = new Limiter(2);
    let running = 0, peak = 0;
    const job = (fail = false) => l.run(async () => { running++; peak = Math.max(peak, running); await tick(); running--; if (fail) throw new Error('boom'); return 1; });
    const results = await Promise.allSettled([job(), job(true), job(), job(), job(true)]);
    assert.equal(peak, 2);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'rejected']);
    assert.deepEqual(l.size, { running: 0, waiting: 0 });
  });

  it('waiting work starts by priority, then first come first served', async () => {
    const l = new Limiter(1);
    const order: string[] = [];
    let release!: () => void;
    const first = l.run(() => new Promise<void>(r => { release = r; }));
    const later = [
      l.run(async () => { order.push('second opinion 1'); }, 1),
      l.run(async () => { order.push('route a'); }, 0),
      l.run(async () => { order.push('second opinion 2'); }, 1),
      l.run(async () => { order.push('route b'); }, 0),
    ];
    assert.deepEqual(l.size, { running: 1, waiting: 4 });
    await tick(); // the first job has started and holds the slot
    release();
    await Promise.all([first, ...later]);
    assert.deepEqual(order, ['route a', 'route b', 'second opinion 1', 'second opinion 2']);
  });

  it('refuses zero slots', () => assert.throws(() => new Limiter(0), /at least one slot/));
});
