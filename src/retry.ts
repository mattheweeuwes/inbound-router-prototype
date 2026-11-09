// Retry policy shared by the two things that retry: a lead whose pipeline threw, and a HubSpot delivery that did not go through.
// The decisions are pure; WakeUp is the one timer each of them keeps.

export interface RetryPolicy { baseMs: number; maxMs: number; maxAttempts: number }

/** A Retry-After header is honored up to an hour; past that it is more likely a bad header than a plan. */
export const RETRY_AFTER_CAP_MS = 60 * 60_000;

/** Wait before the next attempt after `attempts` failed ones: base, doubling, capped at maxMs. */
export function backoffMs(attempts: number, p: Pick<RetryPolicy, 'baseMs' | 'maxMs'>): number {
  return Math.min(p.maxMs, p.baseMs * 2 ** Math.max(0, attempts - 1));
}

export type RetryDecision = { retry: true; atMs: number } | { retry: false };

/** After `attempts` failed attempts: try again at a time, or give up. A server's Retry-After wins when it asks for longer. */
export function nextAttempt(attempts: number, p: RetryPolicy, nowMs: number, retryAfterMs: number | null = null): RetryDecision {
  if (attempts >= p.maxAttempts) return { retry: false };
  const wait = Math.max(backoffMs(attempts, p), Math.min(retryAfterMs ?? 0, RETRY_AFTER_CAP_MS));
  return { retry: true, atMs: nowMs + wait };
}

/**
 * Retry-After as milliseconds from now: either delta-seconds or an HTTP date. Null when absent or unreadable.
 * https://www.rfc-editor.org/rfc/rfc9110#field.retry-after
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  if (!/^[A-Za-z]{3}, /.test(v)) return null; // an HTTP date starts with the day name; Date.parse would read "-5" as a year
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/**
 * One timer that fires `fn` at the earliest time anyone asked for. It is unref'd, so a pending retry never keeps the
 * process or the test runner alive; a server stays up for its socket anyway, and boot recovery picks up what a stopped
 * process left.
 */
export class WakeUp {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private atMs = Infinity;

  constructor(private readonly fn: () => void) {}

  at(atMs: number, nowMs: number) {
    if (this.timer && this.atMs <= atMs) return;
    this.cancel();
    this.atMs = atMs;
    this.timer = setTimeout(() => { this.timer = null; this.atMs = Infinity; this.fn(); }, Math.max(0, atMs - nowMs));
    this.timer.unref();
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.atMs = Infinity;
  }
}
