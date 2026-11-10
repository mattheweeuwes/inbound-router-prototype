// Seeding for the usage tests: a context with no fixtures, and rows written through the store the loader uses.
import type { Ctx } from '../src/context';
import type { Deal } from '../src/store/usage';
import type { AdaptedEvent } from '../src/usage/posthog';
import type { Feature } from '../src/usage/taxonomy';
import { testCtx } from './helpers';

export const DAY = 86_400_000;
export const iso = (ms: number) => new Date(ms).toISOString();
/** A UTC time from a date or a time string, in ms. */
export const t = (s: string) => Date.parse(s);

export const ACCT = 'crm:mirror-wrenfield';
export const OTHER = 'crm:mirror-brookmere';

let n = 0;
/** A mapped event on an account; `at` is an ISO time or ms. */
export function usage(ctx: Ctx, account: string | null, feature: Feature | null, at: string | number, over: Partial<AdaptedEvent> = {}) {
  n += 1;
  const when = typeof at === 'number' ? at : t(at);
  ctx.store.usage.insertEvent({
    eventId: `evt-${n}`, eventName: feature ?? '$pageview', feature, groupKey: null, contactKey: null, occurredAt: iso(when), synthetic: true, ...over,
  }, account, iso(when), 'api');
}

/** A deal; closedAt is null for an open one. */
export function deal(ctx: Ctx, id: string, account: string, createdAt: string, closedAt: string | null, outcome: 'won' | 'lost' | null, over: Partial<Deal> = {}) {
  ctx.store.usage.saveDeal({
    id, accountKey: account, stage: outcome === 'won' ? 'closed_won' : outcome === 'lost' ? 'closed_lost' : 'proposal', amount: 100_000,
    createdAt: iso(t(createdAt)), closedAt: closedAt ? iso(t(closedAt)) : null, outcome, addOn: null, synthetic: true, ...over,
  }, 'api');
}

/** Reference data: the six features (all launched on 2026-01-01 unless said) and the one add-on, with quality_preview previewing it. */
export function reference(ctx: Ctx, launched = '2026-01-01T00:00:00.000Z') {
  const f = (feature: string, previewOfAddOn: string | null = null) => ({ feature, label: feature, launchedAt: launched, team: 'T', previewOfAddOn });
  ctx.store.usage.replaceReference(
    [f('signal_search'), f('signal_watch'), f('api'), f('mcp'), f('network_benchmarking'), f('quality_preview', 'provider_quality_data')],
    [{ id: 'provider_quality_data', label: 'Provider quality data', priceLow: 30_000, priceHigh: 50_000 }],
  );
}

/** A context with reference data and a clock event that fixes the as-of date (the newest event) at `asOf`. */
export function seeded(asOf: string): Ctx {
  const ctx = testCtx();
  reference(ctx);
  usage(ctx, null, null, asOf);
  return ctx;
}
