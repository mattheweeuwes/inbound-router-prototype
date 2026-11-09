import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeDashboard } from '../src/dashboard';
import { kickOutbox } from '../src/crm/outbox';
import { buildPayload } from '../src/payloads';
import { enqueue, resumePending, whenIdle } from '../src/pipeline';
import type { Ctx } from '../src/context';
import { post, spec, submit, testCtx } from './helpers';

/**
 * A fake HubSpot. `failUpserts` upsert calls fail first, by throwing like a dropped connection or the 10 s timeout, or by
 * answering `failWith` (a status, optionally with Retry-After); after that every call answers 2xx.
 */
function fakeHubspot(failUpserts: number, failWith: { status: number; retryAfter?: string } | null = null) {
  const state = { failUpserts, calls: [] as string[], upsertAttempts: 0 };
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace('https://api.hubapi.com', '');
    state.calls.push(`${init?.method ?? 'GET'} ${u}`);
    if (u.startsWith('/crm/v3/owners')) return new Response(JSON.stringify({ results: [{ id: '777', archived: false }] }), { status: 200 });
    if (u.includes('/batch/upsert')) {
      state.upsertAttempts++;
      if (state.failUpserts > 0) {
        state.failUpserts--;
        if (!failWith) throw new TypeError('fetch failed: ECONNRESET');
        return new Response('{"message":"slow down"}', { status: failWith.status, headers: failWith.retryAfter ? { 'retry-after': failWith.retryAfter } : {} });
      }
    }
    if (u.endsWith('/tasks/search')) return new Response(JSON.stringify({ total: 0, results: [] }), { status: 200 });
    return new Response(JSON.stringify({ results: [{ id: '11' }] }), { status: u.endsWith('/tasks') ? 201 : 200 });
  };
  return { state, fetch: fetch as typeof globalThis.fetch };
}

const START = Date.parse('2026-11-05T15:30:00.000Z');
const MIN = 60_000;

/** A live context on a clock the test moves, with a one-minute first backoff, so no retry happens until the test says so. */
function liveCtx(fetch: typeof globalThis.fetch, over: Parameters<typeof testCtx>[0] = {}) {
  const clock = { now: START };
  const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok', crmRetryDelayMs: MIN, now: () => clock.now, ...over }, fetch);
  return { ctx, clock };
}

/** Moves the clock and lets the outbox deliver whatever is due by then. */
async function after(ctx: Ctx, clock: { now: number }, ms: number) {
  clock.now += ms;
  kickOutbox(ctx);
  await whenIdle(ctx);
}

const lead = (ctx: Ctx, id: string) => ctx.db.prepare(`SELECT status, crm_json, alert_json FROM leads WHERE id = ?`).get(id) as { status: string; crm_json: string; alert_json: string };
const crm = (ctx: Ctx, id: string) => JSON.parse(lead(ctx, id).crm_json);
const outbox = (ctx: Ctx) => (ctx.db.prepare(`SELECT lead_id, state, attempts FROM crm_outbox ORDER BY id`).all() as { lead_id: string; state: string; attempts: number }[]).map(r => ({ ...r }));
const deliveries = (ctx: Ctx, id: string) => ctx.db.prepare(`SELECT ok, note FROM stage_log WHERE lead_id = ? AND stage = 'crm_delivery' ORDER BY rowid`).all(id) as { ok: number; note: string | null }[];

describe('HubSpot delivery goes through an outbox', () => {
  it('a call that throws does not hold the lead: it is done with its alert out, and the plan waits for its retry', async () => {
    const hs = fakeHubspot(99);
    const { ctx } = liveCtx(hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const row = lead(ctx, l.id);
    assert.equal(row.status, 'done');
    assert.ok(JSON.parse(row.alert_json).slack?.blocks, 'the Slack payload was built');
    const c = crm(ctx, l.id);
    assert.deepEqual([c.mode, c.ok, c.delivery, c.attempts], ['live', false, 'retrying', 1]);
    assert.match(c.error, /ECONNRESET/);
    assert.ok(c.error.length <= 300);
    assert.equal(c.nextAttemptAt, new Date(START + MIN).toISOString(), 'the first backoff step');
    assert.ok(c.requests.length > 0, 'the plan is kept so it can be re-sent');
    assert.equal(hs.state.upsertAttempts, 1, 'one try now; the retry waits for its time');
    assert.deepEqual(outbox(ctx), [{ lead_id: l.id, state: 'pending', attempts: 1 }]);
    const log = deliveries(ctx, l.id);
    assert.deepEqual(log.map(r => r.ok), [0]);
    assert.match(log[0].note!, /^attempt 1 of 8: .*ECONNRESET/);
    assert.equal((ctx.db.prepare(`SELECT ok FROM stage_log WHERE lead_id = ? AND stage = 'crm'`).get(l.id) as { ok: number }).ok, 1, 'storing the plan succeeded');
  });

  it('the retry waits for its time, then a success leaves a clean record with every response', async () => {
    const hs = fakeHubspot(1);
    const { ctx, clock } = liveCtx(hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    await after(ctx, clock, MIN - 1);
    assert.equal(hs.state.upsertAttempts, 1, 'not due yet');
    await after(ctx, clock, 1);
    const c = crm(ctx, l.id);
    assert.deepEqual([c.ok, c.delivery, c.attempts], [true, 'delivered', 2]);
    assert.equal('error' in c, false);
    assert.equal(c.responses.length, c.requests.length);
    assert.ok(hs.state.calls.some(x => x === 'POST /crm/v3/objects/tasks'), 'the task goes out too, after its open-task search');
    assert.deepEqual(outbox(ctx).map(r => r.state), ['delivered']);
    assert.deepEqual(deliveries(ctx, l.id).map(r => r.ok), [0, 1]);
  });

  it('the timer retries on its own while the process runs', async () => {
    const hs = fakeHubspot(1);
    const ctx = testCtx({ hubspotLive: true, hubspotToken: 'tok', crmRetryDelayMs: 20 }, hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    assert.equal(crm(ctx, l.id).delivery, 'retrying');
    await new Promise(r => setTimeout(r, 120));
    await whenIdle(ctx);
    assert.equal(crm(ctx, l.id).delivery, 'delivered');
  });

  it('gives up after the last attempt, and the dashboard counts the lead as a failed, not synced, write', async () => {
    const hs = fakeHubspot(99);
    const { ctx, clock } = liveCtx(hs.fetch, { crmMaxAttempts: 3 });
    const { lead: l } = await submit(ctx, 'calendly_demo');
    for (let i = 0; i < 5; i++) await after(ctx, clock, 60 * MIN);
    assert.equal(hs.state.upsertAttempts, 3);
    const c = crm(ctx, l.id);
    assert.deepEqual([c.ok, c.delivery, c.attempts], [false, 'dead', 3]);
    assert.deepEqual(outbox(ctx).map(r => r.state), ['dead']);
    assert.match(deliveries(ctx, l.id).at(-1)!.note!, /^gave up after 3 attempts: .*ECONNRESET/);
    const d = computeDashboard(ctx);
    assert.equal(d.hubspot.failed, c.requests.length);
    assert.equal(d.hubspot.dead, 1);
    assert.equal(d.path.find(p => p.id === 'hubspot')!.status, 'bad');
    assert.match(d.path.find(p => p.id === 'hubspot')!.fact, /1 lead gave up/);
    assert.equal(d.funnel.find(f => f.id === 'synced')!.n, 0);
    assert.ok(d.activity.some((a: { kind: string; stage?: string }) => a.kind === 'failed' && a.stage === 'crm_delivery'), 'the give-up shows in the activity feed');
  });

  it('a plan waiting for a retry shows as waiting on the dashboard, not as failed', async () => {
    const { ctx } = liveCtx(fakeHubspot(99).fetch);
    await submit(ctx, 'calendly_demo');
    const d = computeDashboard(ctx);
    assert.deepEqual([d.hubspot.failed, d.hubspot.waiting, d.hubspot.dead], [0, 1, 0]);
    const line = d.path.find(p => p.id === 'hubspot')!;
    assert.equal(line.status, 'warn');
    assert.match(line.fact, /1 lead waiting to send/);
  });

  it('a 429 stops the plan at that request and honors Retry-After when it asks for longer than the backoff', async () => {
    const hs = fakeHubspot(1, { status: 429, retryAfter: '120' });
    const { ctx, clock } = liveCtx(hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const c = crm(ctx, l.id);
    assert.deepEqual([c.delivery, c.error], ['retrying', 'HubSpot answered 429']);
    assert.equal(c.nextAttemptAt, new Date(START + 2 * MIN).toISOString());
    assert.deepEqual(c.responses.map((r: { status: number }) => r.status), [429], 'nothing after the 429 was sent');
    assert.equal(hs.state.upsertAttempts, 1);
    await after(ctx, clock, MIN);
    assert.equal(hs.state.upsertAttempts, 1, 'the backoff alone would have retried here');
    await after(ctx, clock, MIN);
    assert.equal(crm(ctx, l.id).delivery, 'delivered');
  });

  it('a 5xx is retried', async () => {
    const hs = fakeHubspot(1, { status: 503 });
    const { ctx, clock } = liveCtx(hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    assert.deepEqual([crm(ctx, l.id).delivery, crm(ctx, l.id).error], ['retrying', 'HubSpot answered 503']);
    await after(ctx, clock, MIN);
    assert.deepEqual([crm(ctx, l.id).ok, crm(ctx, l.id).delivery], [true, 'delivered']);
  });

  it('any other 4xx is recorded and not retried: the plan goes on, as before', async () => {
    let upserts = 0;
    const { ctx, clock } = liveCtx((async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/crm/v3/owners')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      if (u.includes('/batch/upsert')) upserts++;
      return new Response('{"message":"bad"}', { status: 400 });
    }) as typeof globalThis.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const c = crm(ctx, l.id);
    assert.deepEqual([c.ok, c.delivery, c.attempts], [false, 'delivered', 1]);
    assert.equal(upserts, 2, 'the company and contact upserts, each sent once');
    await after(ctx, clock, 60 * MIN);
    assert.equal(upserts, 2, 'and never again');
  });

  it('plans go out in order: a later lead\'s plan waits behind the one being retried', async () => {
    const hs = fakeHubspot(1);
    const { ctx, clock } = liveCtx(hs.fetch);
    const first = (await submit(ctx, 'calendly_demo')).lead;
    const second = (await submit(ctx, 'calendly_demo', { email: 'b1@ohiohealth.com', company: 'OhioHealth', seed: '2' })).lead;
    assert.equal(lead(ctx, second.id).status, 'done', 'the second lead was not held up');
    assert.equal(crm(ctx, second.id).delivery, 'pending', 'but its plan has not been sent');
    assert.equal(hs.state.upsertAttempts, 1);
    hs.state.calls.length = 0;
    await after(ctx, clock, MIN);
    assert.deepEqual([crm(ctx, first.id).delivery, crm(ctx, second.id).delivery], ['delivered', 'delivered']);
    const contactUpserts = hs.state.calls.filter(c => c.includes('/contacts/batch/upsert'));
    assert.equal(contactUpserts.length, 2);
    assert.deepEqual(outbox(ctx).map(r => r.lead_id), [first.id, second.id]);
  });

  it('a re-run drops the plan still waiting and queues its own', async () => {
    const { ctx } = liveCtx(fakeHubspot(99).fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    enqueue(ctx, l.id);
    await whenIdle(ctx);
    assert.deepEqual(outbox(ctx).map(r => [r.state, r.attempts]), [['pending', 1]], 'one plan, the new one, already tried once');
  });

  it('boot recovery delivers what is due', async () => {
    const hs = fakeHubspot(1);
    const { ctx, clock } = liveCtx(hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    clock.now += MIN;
    assert.equal(resumePending(ctx), 0, 'the lead itself is done');
    await whenIdle(ctx);
    assert.equal(crm(ctx, l.id).delivery, 'delivered');
  });
});

describe('dry-run never calls fetch and never uses the outbox', () => {
  it('the record is written in the crm stage, and a plan left in the outbox stays there', async () => {
    let calls = 0;
    const ctx = testCtx({}, (async () => { calls++; throw new Error('HubSpot must not be called'); }) as typeof globalThis.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const c = crm(ctx, l.id);
    assert.equal(c.mode, 'dry_run');
    assert.deepEqual(Object.keys(c), ['mode', 'requests', 'skipped'], 'the dry-run record is unchanged');
    assert.equal(outbox(ctx).length, 0);
    // a plan a live run left behind is not sent by a dry-run process
    ctx.store.outbox.enqueue(l.id, JSON.stringify({ requests: c.requests, skipped: null }), 0, new Date().toISOString());
    resumePending(ctx);
    await whenIdle(ctx);
    assert.equal(calls, 0);
    assert.deepEqual(outbox(ctx).map(r => r.state), ['pending']);
  });
});

describe('the alert goes out before the HubSpot write, and HubSpot is outside the one-at-a-time section', () => {
  it('while HubSpot hangs, the lead is done with its alert out, and the next lead is processed too', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let hubspotCalls = 0;
    const hanging = (async (url: string | URL | Request) => {
      if (String(url).includes('/crm/v3/owners')) return new Response(JSON.stringify({ results: [{ id: '777', archived: false }] }), { status: 200 });
      hubspotCalls++;
      await gate; // HubSpot does not answer until the test lets go
      throw new TypeError('fetch failed: ECONNRESET');
    }) as typeof globalThis.fetch;
    const { ctx } = liveCtx(hanging);
    const doneIds: string[] = [];
    type Snapshot = { alert: string | null; crm: string | null };
    let notified: Snapshot | null = null;
    ctx.bus.on('lead', (e: { id: string; status: string; crm?: string }) => {
      if (e.status === 'notified' && !notified) notified = ctx.db.prepare(`SELECT alert_json AS alert, crm_json AS crm FROM leads WHERE id = ?`).get(e.id) as Snapshot;
      if (e.status === 'done' && !e.crm) doneIds.push(e.id);
    });
    const bothDone = new Promise<void>(resolve => ctx.bus.on('lead', () => { if (doneIds.length === 2) resolve(); }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('leads were held up while HubSpot was hanging')), 3000); });
    try {
      assert.equal((await post(ctx, 'calendly_demo', buildPayload('calendly_demo', spec()), { wait: false })).status, 202);
      assert.equal((await post(ctx, 'calendly_demo', buildPayload('calendly_demo', spec({ email: 'b1@ohiohealth.com', company: 'OhioHealth', seed: '2' })), { wait: false })).status, 202);
      await Promise.race([bothDone, giveUp]);
      assert.ok(JSON.parse(notified!.alert!).slack?.blocks, 'the Slack payload was stored');
      assert.equal(notified!.crm, null, 'before the HubSpot record');
      assert.equal(hubspotCalls, 1, 'the first plan is still hanging');
      assert.deepEqual(doneIds.map(id => lead(ctx, id).status), ['done', 'done']);
    } finally {
      clearTimeout(timer);
      release();
    }
    await whenIdle(ctx);
    assert.equal(crm(ctx, doneIds[0]).delivery, 'retrying');
    const stages = (ctx.db.prepare(`SELECT stage FROM stage_log WHERE lead_id = ? AND stage IN ('notify', 'crm', 'crm_delivery') ORDER BY rowid`).all(doneIds[0]) as { stage: string }[]).map(r => r.stage);
    assert.deepEqual(stages, ['notify', 'crm', 'crm_delivery']);
  });

  it('the Slack payload is the same whether HubSpot answers or throws, so it uses nothing from the CRM stage', async () => {
    const ok = (await submit(liveCtx(fakeHubspot(0).fetch).ctx, 'calendly_demo')).lead;
    const down = (await submit(liveCtx(fakeHubspot(99).fetch).ctx, 'calendly_demo')).lead;
    const slack = (a: { alert: { slack: unknown } }) => JSON.stringify(a.alert.slack).replace(/Time to route\*\\n[0-9.]+ s/, 'Time to route'); // the one field that is a wall-clock measurement
    assert.equal(slack(down), slack(ok));
  });

  it('status and stage order: notified before synced before done, then the delivery; the dashboard lists the stages in order', async () => {
    const { ctx } = liveCtx(fakeHubspot(0).fetch);
    const seen: { status: string; crm?: string }[] = [];
    ctx.bus.on('lead', (e: { status: string; crm?: string }) => seen.push(e));
    const { lead: l } = await submit(ctx, 'calendly_demo');
    assert.deepEqual(seen.filter(e => !e.crm).map(e => e.status), ['received', 'normalized', 'resolved', 'qualified', 'scored', 'routed', 'notified', 'synced', 'done']);
    assert.deepEqual(seen.at(-1), { id: l.id, status: 'done', crm: 'delivered' }, 'the delivery is announced last');
    assert.equal(typeof l.timings.alerted, 'number');
    assert.ok(l.timings.alerted <= l.timings.total);
    assert.deepEqual(computeDashboard(ctx).speed.stages.map(s => s.stage), ['normalize', 'resolve', 'qualify', 'score', 'route', 'notify', 'crm']);
  });
});
