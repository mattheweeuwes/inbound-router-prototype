// Which accepted lead commits next (decision 23), as a pure function the pipeline's queue calls and tests call directly.
// The ordered section still commits one lead at a time. The lead at the head of the acceptance order goes first when its
// prepared result is ready. When it is not, it gets a grace period; after that, the earliest-accepted ready lead that is first
// in its own lane passes it. A lead never passes an earlier lead of its own lane. With no grace (null) the head always goes
// first, which is exactly the order of acceptance.

export interface Candidate {
  id: string;
  lane: string;
  /** its prepared result has settled (ok or failed), so its commit would not wait */
  ready: boolean;
}

export type NextCommit =
  | { kind: 'commit'; id: string; /** it went ahead of an earlier-accepted lead that was still waiting */ passed: boolean }
  /** nothing can commit yet; recheckAt is when the head's grace runs out, or null to wait for a prepared result */
  | { kind: 'wait'; recheckAt: number | null }
  | { kind: 'empty' };

export interface OrderClock {
  now: number;
  /** when the current head became the head */
  headSince: number;
  /** null: never pass the head */
  graceMs: number | null;
}

/** The next lead to commit from `waiting`, which is in acceptance order. */
export function nextCommit(waiting: readonly Candidate[], c: OrderClock): NextCommit {
  const head = waiting[0];
  if (!head) return { kind: 'empty' };
  if (head.ready) return { kind: 'commit', id: head.id, passed: false };
  if (c.graceMs == null) return { kind: 'wait', recheckAt: null };
  const graceEnds = c.headSince + c.graceMs;
  if (c.now < graceEnds) return { kind: 'wait', recheckAt: graceEnds };
  const passer = firstReadyLaneHead(waiting);
  return passer ? { kind: 'commit', id: passer.id, passed: true } : { kind: 'wait', recheckAt: null };
}

/** The earliest-accepted lead that is first in its lane and ready. A lead behind an earlier one of its own lane is never picked. */
function firstReadyLaneHead(waiting: readonly Candidate[]): Candidate | null {
  const seen = new Set<string>();
  for (const w of waiting) {
    if (seen.has(w.lane)) continue;
    seen.add(w.lane);
    if (w.ready) return w;
  }
  return null;
}
