// Stores a PostHog batch: adapt it, resolve each event's company group to an account key, and write one row per event uuid.
// Idempotent: an event whose uuid is already stored changes nothing and is counted as a duplicate. Nothing is dropped
// silently: an event the taxonomy does not know is stored with no feature and counted as unmapped, an event whose group
// resolves to no account is stored with no account and counted as unresolved, and an event that cannot be used is
// listed in `rejected` with its position and reason.
import type { Ctx } from '../context';
import { tx } from '../db';
import type { UsageSource } from '../store/usage';
import { accountForGroup } from './account';
import { adaptBatch, type AdaptedEvent, type RejectedEvent } from './posthog';

export interface UsageIngestResult {
  /** events in the request: stored + duplicates + rejected */
  received: number;
  /** events written now */
  stored: number;
  /** events whose uuid was already stored */
  duplicates: number;
  /** of the stored events, those whose name is not in the taxonomy */
  unmapped: number;
  /** of the stored events, those whose company group named no account the router knows */
  unresolved: number;
  rejected: RejectedEvent[];
}

/** Writes adapted events and counts what happened. The caller owns the transaction. */
export function storeEvents(ctx: Ctx, events: AdaptedEvent[], rejected: RejectedEvent[], source: UsageSource): UsageIngestResult {
  const receivedAt = new Date(ctx.cfg.now()).toISOString();
  const out: UsageIngestResult = { received: events.length + rejected.length, stored: 0, duplicates: 0, unmapped: 0, unresolved: 0, rejected };
  for (const e of events) {
    const accountKey = accountForGroup(ctx, e.groupKey);
    if (!ctx.store.usage.insertEvent(e, accountKey, receivedAt, source)) { out.duplicates++; continue; }
    out.stored++;
    if (e.feature === null) out.unmapped++;
    if (accountKey === null) out.unresolved++;
  }
  return out;
}

/** POST /api/usage: adapt a request body and store it in one transaction. Throws PayloadError for a body that is not a batch. */
export function ingestUsage(ctx: Ctx, payload: unknown): UsageIngestResult {
  const { events, rejected } = adaptBatch(payload);
  return tx(ctx.db, () => storeEvents(ctx, events, rejected, 'api'));
}
