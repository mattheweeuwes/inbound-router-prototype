import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeDashboard } from '../src/dashboard';
import { buildPayload } from '../src/payloads';
import { retryCrmWrites, resumePending, whenIdle } from '../src/pipeline';
import { post, spec, submit, testCtx } from './helpers';

/** A fake HubSpot. `failUpserts` upsert calls throw like a dropped connection or the 10 s timeout; after that every call answers 2xx. */
function fakeHubspot(failUpserts: number) {
  const state = { failUpserts, calls: [] as string[], upsertAttempts: 0 };
  const fetch = async (url: any, init: any) => {
    const u = String(url).replace('https://api.hubapi.com', '');
    state.calls.push(`${init?.method ?? 'GET'} ${u}`);
    if (u.startsWith('/crm/v3/owners')) return new Response(JSON.stringify({ results: [{ id: '777', archived: false }] }), { status: 200 });
    if (u.includes('/batch/upsert')) {
      state.upsertAttempts++;
      if (state.failUpserts > 0) { state.failUpserts--; throw new TypeError('fetch failed: ECONNRESET'); }
    }
    if (u.endsWith('/tasks/search')) return new Response(JSON.stringify({ total: 0, results: [] }), { status: 200 });
    return new Response(JSON.stringify({ results: [{ id: '11' }] }), { status: u.endsWith('/tasks') ? 201 : 200 });
  };
  return { state, fetch: fetch as typeof globalThis.fetch };
}

const live = { hubspotLive: true, hubspotToken: 'tok', crmRetryDelayMs: 0 };
const lead = (ctx: ReturnType<typeof testCtx>, id: string) => ctx.db.prepare(`SELECT status, crm_json, alert_json FROM leads WHERE id = ?`).get(id) as { status: string; crm_json: string; alert_json: string };

describe('a HubSpot call that throws does not stop the rep alert', () => {
  it('after two throws the lead still alerts, ends done, and its write is marked for retry', async () => {
    const hs = fakeHubspot(99);
    const ctx = testCtx(live, hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const row = lead(ctx, l.id);
    assert.equal(row.status, 'done');
    const alert = JSON.parse(row.alert_json);
    assert.ok(alert.slack?.blocks, 'the Slack payload was built');
    const crm = JSON.parse(row.crm_json);
    assert.equal(crm.ok, false);
    assert.equal(crm.retryPending, true);
    assert.match(crm.error, /ECONNRESET/);
    assert.ok(crm.error.length <= 300);
    assert.ok(crm.requests.length > 0, 'the plan is kept so it can be re-sent');
    assert.equal(hs.state.upsertAttempts, 2, 'one try and one retry');
    const log = ctx.db.prepare(`SELECT ok, note FROM stage_log WHERE lead_id = ? AND stage = 'crm'`).all(l.id) as any[];
    assert.deepEqual(log.map(r => r.ok), [0]);
    assert.match(log[0].note, /ECONNRESET/);
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM stage_log WHERE lead_id = ? AND stage = 'notify' AND ok = 1`).get(l.id) as any).c, 1);
  });

  it('the dashboard counts the stored record as a failed HubSpot write and the lead as not synced', async () => {
    const ctx = testCtx(live, fakeHubspot(99).fetch);
    await submit(ctx, 'calendly_demo');
    const d = computeDashboard(ctx);
    const planned = JSON.parse((ctx.db.prepare(`SELECT crm_json FROM leads`).get() as any).crm_json).requests.length;
    assert.equal(d.hubspot.failed, planned);
    assert.equal(d.path.find(p => p.id === 'hubspot')!.status, 'bad');
    assert.equal(d.funnel.find(f => f.id === 'synced')!.n, 0);
  });

  it('a throw on the first try and a success on the second leaves a clean, ok record', async () => {
    const hs = fakeHubspot(1);
    const ctx = testCtx(live, hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const row = lead(ctx, l.id);
    const crm = JSON.parse(row.crm_json);
    assert.equal(row.status, 'done');
    assert.equal(crm.ok, true);
    assert.equal('retryPending' in crm, false);
    assert.equal('error' in crm, false);
    assert.ok(JSON.parse(row.alert_json).slack?.blocks);
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM stage_log WHERE lead_id = ? AND ok = 0`).get(l.id) as any).c, 0);
  });

  it('an HTTP error response still does not throw or retry: it is recorded and the pipeline continues, as before', async () => {
    let upserts = 0;
    const ctx = testCtx(live, (async (url: any) => {
      const u = String(url);
      if (u.includes('/crm/v3/owners')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      if (u.includes('/batch/upsert')) upserts++;
      return new Response('{"message":"bad"}', { status: 400 });
    }) as typeof globalThis.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const crm = JSON.parse(lead(ctx, l.id).crm_json);
    assert.equal(crm.ok, false);
    assert.equal('retryPending' in crm, false);
    assert.equal(upserts, 2, 'the company and contact upserts, each sent once');
  });
});

describe('retryCrmWrites', () => {
  it('re-sends the stored plan of a pending lead and clears retryPending when it goes through', async () => {
    const hs = fakeHubspot(2);
    const ctx = testCtx(live, hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const stored = JSON.parse(lead(ctx, l.id).crm_json);
    assert.equal(stored.retryPending, true);
    hs.state.calls.length = 0;
    const out = await retryCrmWrites(ctx);
    assert.deepEqual(out, { attempted: 1, sent: 1 });
    const crm = JSON.parse(lead(ctx, l.id).crm_json);
    assert.equal(crm.ok, true);
    assert.equal('retryPending' in crm, false);
    assert.equal('error' in crm, false);
    assert.deepEqual(crm.requests, stored.requests, 'the stored plan is unchanged');
    assert.ok(hs.state.calls.some(c => c.startsWith('POST /crm/v3/objects/contacts/batch/upsert')));
    assert.ok(hs.state.calls.some(c => c === 'POST /crm/v3/objects/tasks'), 'the task goes out too, after its open-task search');
    assert.equal((ctx.db.prepare(`SELECT ok FROM stage_log WHERE lead_id = ? AND stage = 'crm_retry'`).get(l.id) as any).ok, 1);
    assert.deepEqual(await retryCrmWrites(ctx), { attempted: 0, sent: 0 }, 'nothing is left to retry');
  });

  it('leaves retryPending in place and logs the attempt when HubSpot is still down', async () => {
    const hs = fakeHubspot(99);
    const ctx = testCtx(live, hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const before = lead(ctx, l.id).crm_json;
    const out = await retryCrmWrites(ctx);
    assert.deepEqual(out, { attempted: 1, sent: 0 });
    assert.equal(lead(ctx, l.id).crm_json, before);
    assert.equal(JSON.parse(lead(ctx, l.id).crm_json).retryPending, true);
    const log = ctx.db.prepare(`SELECT ok, note FROM stage_log WHERE lead_id = ? AND stage = 'crm_retry'`).all(l.id) as any[];
    assert.equal(log.length, 1);
    assert.equal(log[0].ok, 0);
    assert.match(log[0].note, /ECONNRESET/);
  });

  it('boot recovery (resumePending) runs it', async () => {
    const hs = fakeHubspot(2);
    const ctx = testCtx(live, hs.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    resumePending(ctx);
    await whenIdle(ctx);
    assert.equal(JSON.parse(lead(ctx, l.id).crm_json).ok, true);
  });
});

describe('dry-run never calls fetch on either path', () => {
  it('the pipeline records the plan and the retry does nothing', async () => {
    let calls = 0;
    const ctx = testCtx({ crmRetryDelayMs: 0 }, (async () => { calls++; throw new Error('HubSpot must not be called'); }) as typeof globalThis.fetch);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    const crm = JSON.parse(lead(ctx, l.id).crm_json);
    assert.equal(crm.mode, 'dry_run');
    assert.equal('retryPending' in crm, false);
    // even a record that claims a pending retry is left alone when the context is not live
    ctx.db.prepare(`UPDATE leads SET crm_json = ? WHERE id = ?`).run(JSON.stringify({ ...crm, retryPending: true }), l.id);
    assert.deepEqual(await retryCrmWrites(ctx), { attempted: 0, sent: 0 });
    resumePending(ctx); await whenIdle(ctx);
    assert.equal(calls, 0);
  });
});

describe('the alert goes out before the HubSpot write', () => {
  it('while HubSpot hangs, alert_json is already stored and crm_json is not; the lead finishes when the call finally fails', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let hubspotCalls = 0;
    const hanging = (async (url: any) => {
      if (String(url).includes('/crm/v3/owners')) return new Response(JSON.stringify({ results: [{ id: '777', archived: false }] }), { status: 200 });
      hubspotCalls++;
      await gate; // HubSpot does not answer until the test lets go
      throw new TypeError('fetch failed: ECONNRESET');
    }) as typeof globalThis.fetch;
    const ctx = testCtx(live, hanging);
    const atNotified = new Promise<{ status: string; alert: string | null; crm: string | null }>(resolve => {
      ctx.bus.on('lead', (e: any) => {
        if (e.status === 'notified') resolve(ctx.db.prepare(`SELECT status, alert_json AS alert, crm_json AS crm FROM leads WHERE id = ?`).get(e.id) as any);
      });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the alert did not go out while HubSpot was hanging')), 3000); });
    try {
      const sent = await post(ctx, 'calendly_demo', buildPayload('calendly_demo', spec()), { wait: false });
      assert.equal(sent.status, 202);
      const snap = await Promise.race([atNotified, giveUp]);
      assert.ok(JSON.parse(snap.alert!).slack?.blocks, 'the Slack payload is stored');
      assert.equal(snap.crm, null, 'and the HubSpot record is not written yet');
      assert.equal(hubspotCalls, 0, 'the CRM stage has not even started');
    } finally {
      clearTimeout(timer);
      release();
    }
    await whenIdle(ctx);
    const id = (ctx.db.prepare(`SELECT id FROM leads`).get() as any).id as string;
    const row = lead(ctx, id);
    assert.equal(row.status, 'done');
    assert.equal(JSON.parse(row.crm_json).retryPending, true);
    assert.ok(hubspotCalls >= 2, 'one try and one retry');
    const stages = (ctx.db.prepare(`SELECT stage FROM stage_log WHERE lead_id = ? AND stage IN ('notify', 'crm') ORDER BY rowid`).all(id) as any[]).map(r => r.stage);
    assert.deepEqual(stages, ['notify', 'crm']);
  });

  it('the Slack payload is the same whether HubSpot answers or throws, so it uses nothing from the CRM stage', async () => {
    const ok = (await submit(testCtx(live, fakeHubspot(0).fetch), 'calendly_demo')).lead;
    const down = (await submit(testCtx(live, fakeHubspot(99).fetch), 'calendly_demo')).lead;
    const slack = (a: any) => JSON.stringify(a.alert.slack).replace(/Time to route\*\\n[0-9.]+ s/, 'Time to route'); // the one field that is a wall-clock measurement
    assert.equal(slack(down), slack(ok));
  });

  it('status and stage order: notified comes before synced, the alert time is recorded, and the dashboard lists the stages in that order', async () => {
    const ctx = testCtx(live, fakeHubspot(0).fetch);
    const seen: string[] = [];
    ctx.bus.on('lead', (e: any) => seen.push(e.status));
    const { lead: l } = await submit(ctx, 'calendly_demo');
    assert.deepEqual(seen, ['received', 'normalized', 'resolved', 'qualified', 'scored', 'routed', 'notified', 'synced', 'done']);
    assert.equal(typeof l.timings.alerted, 'number');
    assert.ok(l.timings.alerted <= l.timings.total);
    assert.deepEqual(computeDashboard(ctx).speed.stages.map(s => s.stage), ['normalize', 'resolve', 'qualify', 'score', 'route', 'notify', 'crm']);
  });
});
