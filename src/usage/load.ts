// Loads the synthetic usage fixtures at startup: the features file, the deals (standing in for HubSpot's) and a PostHog-shaped
// export of events. The events go through the same adapter and the same writer as POST /api/usage. It runs only when the
// hash of the three files differs from the one stored, and then replaces everything an earlier load put in (rows from
// POST /api/usage are left alone). With no folder, or a file it cannot read, the fixture rows are removed and the API says why.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context';
import { tx } from '../db';
import type { AddOnRef, Deal, DealOutcome, FeatureRef } from '../store/usage';
import { accountForGroup } from './account';
import { storeEvents } from './ingest';
import { adaptBatch } from './posthog';
import { isFeature } from './taxonomy';

export interface UsageLoad {
  /** loaded: read now. unchanged: the stored load matches. off: no folder configured. missing: no features file. failed: a file could not be used. */
  status: 'loaded' | 'unchanged' | 'off' | 'missing' | 'failed';
  message: string;
  features: number;
  deals: number;
  events: number;
  ms: number;
}

const FILES = ['features.json', 'deals.json', 'events.json'] as const;

/** The deal stages a fixture may use. Closed stages carry the outcome; the rest are open. */
const STAGE_OUTCOME: Readonly<Record<string, DealOutcome | null>> = {
  qualified: null, proposal: null, negotiation: null, closed_won: 'won', closed_lost: 'lost',
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** UTC ISO with milliseconds from a date or a time, the only form the database holds. */
export function isoTime(v: unknown, what: string): string {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new Error(`${what} must be a date or an ISO time`);
  return new Date(v).toISOString();
}

const need = (o: Obj, k: string, what: string): string => {
  const v = o[k];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what}: ${k} is required`);
  return v.trim();
};
const money = (o: Obj, k: string, what: string): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${what}: ${k} must be a whole number of dollars, 0 or more`);
  return v;
};

function readJson(dir: string, file: string): unknown {
  try { return JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch (e) { throw new Error(`${file}: ${(e as Error).message}`); }
}

function parseFeatures(raw: unknown): { features: FeatureRef[]; addOns: AddOnRef[] } {
  if (!isObj(raw) || !Array.isArray(raw.features)) throw new Error('features.json: expected { features: [...], addOns: [...] }');
  const addOns = (Array.isArray(raw.addOns) ? raw.addOns : []).map((a, i): AddOnRef => {
    const what = `features.json addOns[${i}]`;
    if (!isObj(a)) throw new Error(`${what}: expected an object`);
    return { id: need(a, 'id', what), label: need(a, 'label', what), priceLow: money(a, 'priceLow', what), priceHigh: money(a, 'priceHigh', what) };
  });
  const features = raw.features.map((f, i): FeatureRef => {
    const what = `features.json features[${i}]`;
    if (!isObj(f)) throw new Error(`${what}: expected an object`);
    const feature = need(f, 'feature', what);
    if (!isFeature(feature)) throw new Error(`${what}: ${feature} is not in the taxonomy (src/usage/taxonomy.ts)`);
    const previewOfAddOn = typeof f.previewOfAddOn === 'string' ? f.previewOfAddOn : null;
    if (previewOfAddOn && !addOns.some(a => a.id === previewOfAddOn)) throw new Error(`${what}: previewOfAddOn ${previewOfAddOn} is not in addOns`);
    return { feature, label: need(f, 'label', what), launchedAt: isoTime(f.launchedAt, `${what}: launchedAt`), team: need(f, 'team', what), previewOfAddOn };
  });
  return { features, addOns };
}

function parseDeals(ctx: Ctx, raw: unknown, addOns: AddOnRef[]): Deal[] {
  if (!Array.isArray(raw)) throw new Error('deals.json: expected an array of deals');
  return raw.map((d, i): Deal => {
    if (!isObj(d)) throw new Error(`deals.json[${i}]: expected an object`);
    const id = need(d, 'id', `deals.json[${i}]`);
    const what = `deal ${id}`;
    const accountKey = need(d, 'accountKey', what);
    if (accountForGroup(ctx, accountKey) !== accountKey) throw new Error(`${what}: ${accountKey} is not an account the router knows (a CRM mirror entry, or an account a lead created)`);
    const stage = need(d, 'stage', what);
    if (!Object.hasOwn(STAGE_OUTCOME, stage)) throw new Error(`${what}: stage ${stage} is not one of ${Object.keys(STAGE_OUTCOME).join(', ')}`);
    const outcome = STAGE_OUTCOME[stage];
    const createdAt = isoTime(d.createdAt, `${what}: createdAt`);
    const closedAt = d.closedAt == null ? null : isoTime(d.closedAt, `${what}: closedAt`);
    if ((closedAt === null) !== (outcome === null)) throw new Error(`${what}: closedAt is set exactly when the stage is closed_won or closed_lost`);
    if (closedAt !== null && closedAt < createdAt) throw new Error(`${what}: closedAt is before createdAt`);
    const addOn = typeof d.addOn === 'string' ? d.addOn : null;
    if (addOn && !addOns.some(a => a.id === addOn)) throw new Error(`${what}: addOn ${addOn} is not in addOns`);
    return { id, accountKey, stage, amount: money(d, 'amount', what), createdAt, closedAt, outcome, addOn, synthetic: d.synthetic === true };
  });
}

export function loadUsage(ctx: Ctx): UsageLoad {
  const t = performance.now();
  const done = (status: UsageLoad['status'], message: string, counts = { features: 0, deals: 0, events: 0 }): UsageLoad =>
    ({ status, message, ...counts, ms: Math.round(performance.now() - t) });
  const store = ctx.store.usage;
  const dir = ctx.cfg.usageFixtures;

  if (dir === null) return done('off', 'usage fixtures are switched off');
  if (!FILES.every(f => existsSync(join(dir, f)))) {
    tx(ctx.db, () => store.clearFixture());
    return done('missing', `no usage fixtures in ${dir} (features.json, deals.json and events.json)`);
  }
  const sha = createHash('sha256');
  for (const f of FILES) sha.update(f).update(readFileSync(join(dir, f)));
  const hash = sha.digest('hex');
  if (store.fixtureSha() === hash) return done('unchanged', 'the stored usage fixtures match the files');

  try {
    const { features, addOns } = parseFeatures(readJson(dir, 'features.json'));
    const deals = parseDeals(ctx, readJson(dir, 'deals.json'), addOns);
    const { events, rejected } = adaptBatch(readJson(dir, 'events.json'));
    if (rejected.length) throw new Error(`events.json: event ${rejected[0].index} is unusable: ${rejected[0].reason}`);
    tx(ctx.db, () => {
      store.clearFixture();
      store.replaceReference(features, addOns);
      for (const d of deals) store.saveDeal(d, 'fixture');
      storeEvents(ctx, events, [], 'fixture');
      store.saveFixtureSha(hash, new Date(ctx.cfg.now()).toISOString());
    });
    return done('loaded', `${features.length} features, ${deals.length} deals, ${events.length} events`, { features: features.length, deals: deals.length, events: events.length });
  } catch (e) {
    tx(ctx.db, () => store.clearFixture());
    return done('failed', (e as Error).message);
  }
}
