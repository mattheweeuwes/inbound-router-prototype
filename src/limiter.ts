// A bound on how much of something runs at once. Waiting work starts in priority order (lower first), first come first
// served within a priority. The pipeline uses one for lead preparation and one for model calls, where a call a route is
// waiting on goes ahead of a second opinion.

interface Waiter { priority: number; seq: number; start: () => void }

export class Limiter {
  private running = 0;
  private seq = 0;
  private readonly waiting: Waiter[] = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`a limiter needs at least one slot, got ${max}`);
  }

  /** Runs fn once a slot is free and returns its result. The slot is released when fn settles, whether it resolved or threw. */
  async run<T>(fn: () => Promise<T>, priority = 0): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** Work running now and work waiting for a slot. */
  get size() { return { running: this.running, waiting: this.waiting.length }; }

  private acquire(priority: number): Promise<void> {
    if (this.running < this.max) { this.running++; return Promise.resolve(); }
    return new Promise(start => {
      this.waiting.push({ priority, seq: this.seq++, start });
      this.waiting.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    });
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next.start(); // the slot passes straight to the next waiter, so running stays the same
    else this.running--;
  }
}
