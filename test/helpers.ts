import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import inbound from '../api/inbound';
import { ROOT } from '../src/config';
import { createCtx, type Ctx, type FetchFn } from '../src/context';
import { whenIdle } from '../src/pipeline';
import { buildPayload, type PayloadSpec } from '../src/payloads';
import type { StoredAlert } from '../src/decisions';
import type { Qualification, Route, Source } from '../src/schema';
import { signCalendly } from '../src/sources';
import { leadDetail } from '../src/view';

export const KEY = 'test-signing-key';
export const RATES_MINI = join(ROOT, 'test', 'fixtures', 'rates-mini.csv');
export const PLATFORMS_MINI = join(ROOT, 'test', 'fixtures', 'outbound-platforms-mini.json');

/** A context on the hand-made mini registry, in-memory app DB, no network, no model unless asked. */
export function testCtx(over: Parameters<typeof createCtx>[0] = {}, fetchImpl?: FetchFn): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'router-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return createCtx({
    appDb: ':memory:', registryDb: join(dir, 'no-registry.sqlite'), cacheDir: join(dir, 'cache'), outDir: join(dir, 'out'),
    network: false, llmProvider: 'rules', calendlyKey: KEY, demoRoutes: false, anthropicKey: null, modelRetryWaitMs: 0,
    // the synthetic rate file and its platform mapping, never the real export, which may or may not be on disk
    ratesCsv: RATES_MINI, outboundPlatforms: PLATFORMS_MINI,
    // no usage fixtures unless a test asks: the usage tests seed exactly the events and deals they mean to read
    usageFixtures: null,
    // never inherit the real .env: live HubSpot and its key are opt-in per test
    hubspotLive: false, hubspotToken: null,
    // commits follow acceptance order exactly, so every pipeline test is reproducible; the lane tests turn passing on
    commitGraceMs: null,
    // the list digest timer never fires inside a test on its own: digest tests call flushListDigests with their clock
    listDoors: ['event_scan'], listDoorModel: 'after_alert', listQuietMs: 3_600_000,
    ...over,
  }, fetchImpl ?? (async () => { throw new Error('network is off in tests'); }));
}

export const spec = (over: Partial<PayloadSpec> = {}): PayloadSpec => ({
  first: 'Dana', last: 'Whitfield', email: 'dwhitfield@intermountainhealthcare.org', title: 'VP Managed Care Contracting', company: 'Intermountain Health', state: 'UT',
  message: 'Our commercial renegotiations start in January.', ts: '2026-11-05T15:00:00.000Z', seed: 'seed-1', ...over,
});

export async function post(ctx: Ctx, source: Source, payload: unknown, opts: { sign?: boolean | 'bad'; wait?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (source === 'calendly_demo' && opts.sign !== false) headers['calendly-webhook-signature'] = opts.sign === 'bad' ? signCalendly('wrong-key', body) : signCalendly(KEY, body);
  const res = await inbound(new Request(`http://local/api/inbound?source=${source}`, { method: 'POST', headers, body }), ctx);
  const json: any = await res.json();
  if (opts.wait !== false) await whenIdle(ctx);
  return { status: res.status, json };
}

export async function submit(ctx: Ctx, source: Source, s: Partial<PayloadSpec> = {}) {
  const r = await post(ctx, source, buildPayload(source, spec(s)));
  return { ...r, lead: r.json.leadId ? (leadDetail(ctx, r.json.leadId) as any) : null };
}

/** The parts of a lead detail the lane and list tests read, typed (leadDetail parses its JSON columns as unknown). */
export interface LeadView {
  id: string; status: string; list: string | null; flags: string[];
  person: { name: string; title: string | null; email: string | null } | null;
  route: Route; dedupe: { duplicateOf: string | null }; alert: StoredAlert; timings: Record<string, number>;
  qualification: Qualification; secondOpinion: { state: string; result: unknown } | null; crm: { requests: unknown[] }; score: unknown;
}
export const leadView = (ctx: Ctx, id: string): LeadView => leadDetail(ctx, id) as unknown as LeadView;
