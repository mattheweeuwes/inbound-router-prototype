// Writes a lead's interest tags: as it is committed (src/stages.ts), and for leads committed before tagging existed, at start.
// The cues are pure (src/interest/cues.ts); this file reads the lead's event, calls them, and stores the result.
import type { Ctx } from '../context';
import { tx } from '../db';
import type { LeadEvent } from '../schema';
import { adapt } from '../sources';
import { interestTags, type CueSource, type InterestTag } from './cues';

/** Tags the lead from its event and stores them, replacing any an earlier run wrote. Returns the tags. */
export function tagLead(ctx: Ctx, leadId: string, ev: CueSource, at: string): InterestTag[] {
  const tags = interestTags(ev);
  tx(ctx.db, () => ctx.store.interest.replace(leadId, tags, at));
  return tags;
}

/** What the start-up pass did: finished leads it looked at, how many of them got at least one tag, and how long it took. */
export interface InterestBackfill { checked: number; tagged: number; ms: number }

/**
 * Looks at every finished lead that has not been looked at, so a database from before tagging is covered. A lead is marked
 * looked at whether or not it has a cue, so the next start finds nothing to do. The lead's event is rebuilt from the payload
 * it was accepted with, the way the pipeline does, so the tags are the ones the commit would have written.
 */
export function backfillInterest(ctx: Ctx): InterestBackfill {
  const t = performance.now();
  const at = new Date(ctx.cfg.now()).toISOString();
  let checked = 0, tagged = 0;
  tx(ctx.db, () => {
    for (const row of ctx.store.interest.untagged()) {
      let ev: LeadEvent;
      try { ev = adapt(row.source, JSON.parse(row.raw_json), row.received_at); } catch { continue; } // a payload the adapter refuses has no event to read
      const tags = interestTags(ev);
      ctx.store.interest.replace(row.id, tags, at);
      checked++;
      if (tags.length) tagged++;
    }
  });
  return { checked, tagged, ms: Math.round(performance.now() - t) };
}
