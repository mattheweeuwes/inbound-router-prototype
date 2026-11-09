import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import dashboardHandler from '../api/dashboard';
import evalHandler from '../api/eval';
import metricsHandler from '../api/metrics';
import type { Ctx } from '../src/context';
import { computeDashboard, MARKETS, MOTIONS, percentile } from '../src/dashboard';
import { computeMetrics, resolutionCount } from '../src/hygiene';
import { ROOT } from '../src/config';
import { buildPayload } from '../src/payloads';
import { SOURCES } from '../src/schema';
import { post, spec, submit, testCtx } from './helpers';

const NOW = Date.parse('2026-11-07T06:00:00.000Z');
const get = (path: string) => new Request(`http://local${path}`);

/** Paths of every number in a value that is NaN or not finite. */
function badNumbers(v: unknown, path = '$', out: string[] = []): string[] {
  if (typeof v === 'number' && !Number.isFinite(v)) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => badNumbers(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) badNumbers(x, `${path}.${k}`, out);
  return out;
}

/** Seven leads and one re-delivery: a tier-A rep alert, its repeat contact, a disposable address, an ambiguous company,
 *  a product signup with no company, a job seeker, and an event scan. */
async function fixture(): Promise<Ctx> {
  const ctx = testCtx();
  const first = spec({ ts: '2026-11-04T14:47:00.000Z', seed: 'd1', utm: { source: 'li', medium: 'paidsocial', campaign: 'q4' } });
  await post(ctx, 'calendly_demo', buildPayload('calendly_demo', first));
  await post(ctx, 'calendly_demo', buildPayload('calendly_demo', first)); // re-delivery of the same Calendly event
  await submit(ctx, 'guide_download', { ts: '2026-11-06T15:20:00.000Z', seed: 'd2', message: undefined, guide: 'Health System Executive Guide' });
  await submit(ctx, 'guide_download', { email: 'xk29@mailinator.com', first: 'asdf', last: 'qwer', company: 'zzzz', title: undefined, ts: '2026-11-06T16:00:00.000Z', seed: 'd3', message: 'Make money with crypto! https://example.invalid/win' });
  await submit(ctx, 'calendly_demo', { email: 'lprice@gmail.com', first: 'Lee', last: 'Price', company: 'Baptist Health', state: undefined, ts: '2026-11-06T17:00:00.000Z', seed: 'd4', message: 'I am benchmarking commercial rates.' });
  await submit(ctx, 'sample_signup', { email: 'noco@gmail.com', first: 'No', last: 'Company', company: undefined, title: undefined, state: undefined, message: undefined, ts: '2026-11-06T18:00:00.000Z', seed: 'd5' });
  await submit(ctx, 'calendly_demo', { email: 'pat.kim@gmail.com', first: 'Pat', last: 'Kim', title: 'Data Analyst', company: undefined, state: undefined, message: "Not a buyer, but I'd love to work at Serif. Are you hiring analysts?", ts: '2026-11-06T19:00:00.000Z', seed: 'd6' });
  await submit(ctx, 'event_scan', { email: 'dlane@tanner.org', first: 'Dee', last: 'Lane', title: 'Director, Revenue Cycle', company: 'Tanner Health', state: 'GA', message: 'Stopped by the booth.', ts: '2026-11-06T20:00:00.000Z', seed: 'd7' });
  return ctx;
}

/** Lead rows written directly, with known timings, for the queue/processing split. */
function insertTimed(ctx: Ctx, id: string, receivedAt: string, ttr: number, queued: number) {
  ctx.db.prepare(`INSERT INTO lead_events (id, source, source_event_id, received_at, synthetic, raw_json) VALUES (?, 'guide_download', ?, ?, 1, '{}')`).run(id, `evt-${id}`, receivedAt);
  ctx.db.prepare(`INSERT INTO leads (id, status, tier, time_to_route_ms, timings_json, created_at, updated_at) VALUES (?, 'done', 'C', ?, ?, ?, ?)`)
    .run(id, ttr, JSON.stringify({ queued, normalize: 1, total: ttr + 5 }), receivedAt, receivedAt);
}

describe('dashboard on an empty database', () => {
  it('gives zeros and empty lists, never NaN, and every path line is idle', () => {
    const d = computeDashboard(testCtx(), { now: NOW });
    assert.equal(d.empty, true);
    assert.deepEqual(badNumbers(d), []);
    assert.equal(d.kpis.leadsIn.value, 0);
    assert.equal(d.kpis.salesReady.value, 0);
    assert.equal(d.kpis.salesReady.pct, null);
    assert.equal(d.kpis.timeToRoute.processingP50, null);
    assert.equal(d.kpis.needsPerson.open, 0);
    assert.equal(d.kpis.matched.pct, null);
    assert.deepEqual(d.funnel.map(f => f.n), [0, 0, 0, 0, 0, 0, 0]);
    assert.ok(d.doors.every(x => x.total === 0));
    for (const list of [d.activity, d.review, d.speed.byDoor, d.speed.byMarket, d.matching.methods, d.notForSales.reasons, d.window.arrivals]) assert.deepEqual(list, []);
    assert.equal(d.window.from, null);
    assert.ok(d.path.every(p => p.status === 'idle'), JSON.stringify(d.path.map(p => [p.id, p.status])));
    assert.equal(d.eval.recorded, false);
    assert.equal(d.hubspot.planned, 0);
    assert.ok(d.reps.length > 0 && d.reps.every(r => r.assigned === 0 && r.alertP50 === null));
  });
});

describe('dashboard groupings', () => {
  it('every door is in exactly one motion and every segment in exactly one market', () => {
    const doors = MOTIONS.flatMap(m => m.doors);
    assert.deepEqual([...doors].sort(), [...SOURCES].sort());
    assert.equal(new Set(doors).size, doors.length);
    const segs = MARKETS.flatMap(m => m.segments);
    assert.equal(new Set(segs).size, segs.length);
    assert.equal(segs.length, 18, 'all 18 segments in src/schema.ts');
  });

  it('door counts sum to the lead total, and each door\'s tiers sum to its count', async () => {
    const ctx = await fixture();
    const d = computeDashboard(ctx, { now: NOW });
    const total = (ctx.db.prepare(`SELECT COUNT(*) c FROM leads`).get() as any).c;
    assert.equal(total, 7);
    assert.equal(d.kpis.leadsIn.value, total);
    assert.equal(d.doors.reduce((a, x) => a + x.total, 0), total);
    assert.equal(d.motions.reduce((a, x) => a + x.total, 0), total);
    for (const x of d.doors) assert.equal(Object.values(x.tiers).reduce((a, n) => a + n, 0), x.total, x.source);
    assert.equal(d.markets.reduce((a, m) => a + m.total, 0) + d.unsegmented, total);
    assert.deepEqual(badNumbers(d), []);
  });

  it('funnel steps never increase, start at the lead total and end at the planned HubSpot syncs', async () => {
    const d = computeDashboard(await fixture(), { now: NOW });
    const ns = d.funnel.map(f => f.n);
    assert.equal(ns[0], 7);
    for (let i = 1; i < ns.length; i++) assert.ok(ns[i] <= ns[i - 1], `step ${d.funnel[i].id} (${ns[i]}) <= ${d.funnel[i - 1].id} (${ns[i - 1]})`);
    for (const f of d.funnel.slice(1)) assert.ok(f.pctOfPrev == null || (f.pctOfPrev >= 0 && f.pctOfPrev <= 100));
    assert.equal(d.kpis.salesReady.value, d.funnel.find(f => f.id === 'sales_ready')!.n, 'the tile and the funnel count the same leads');
    assert.ok(ns[ns.length - 1] >= 1, 'the tier-A lead made it all the way');
  });
});

describe('speed: queue wait and processing are reported separately', () => {
  it('processing is time to route minus the queue wait, lead by lead', () => {
    const ctx = testCtx();
    insertTimed(ctx, 'a', '2026-11-06T15:00:00.000Z', 22_000, 20_000); // processing 2,000
    insertTimed(ctx, 'b', '2026-11-06T15:01:00.000Z', 3_000, 0); //        processing 3,000
    insertTimed(ctx, 'c', '2026-11-06T15:02:00.000Z', 15_000, 14_000); //  processing 1,000
    const d = computeDashboard(ctx, { now: NOW });
    assert.deepEqual([d.speed.processing.p50, d.speed.processing.p90, d.speed.processing.n], [2_000, 3_000, 3]);
    assert.deepEqual([d.speed.queue.p50, d.speed.queue.p90], [14_000, 20_000]);
    assert.deepEqual([d.speed.timeToRoute.p50, d.speed.timeToRoute.p90], [15_000, 22_000]);
    assert.deepEqual([d.kpis.timeToRoute.processingP50, d.kpis.timeToRoute.queueP50, d.kpis.timeToRoute.totalP50], [2_000, 14_000, 15_000]);
    assert.equal(d.speed.byDoor.length, 1);
    assert.deepEqual([d.speed.byDoor[0].processingP50, d.speed.byDoor[0].queueP50, d.speed.byDoor[0].routeP50], [2_000, 14_000, 15_000]);
  });

  it('matches the stored rows after real pipeline runs', async () => {
    const ctx = await fixture();
    const rows = ctx.db.prepare(`SELECT time_to_route_ms t, timings_json j FROM leads WHERE status = 'done'`).all() as any[];
    const proc = rows.map(r => r.t - JSON.parse(r.j).queued);
    const queued = rows.map(r => JSON.parse(r.j).queued);
    const d = computeDashboard(ctx, { now: NOW });
    assert.equal(d.speed.processing.p50, percentile(proc, 50));
    assert.equal(d.speed.queue.p50, percentile(queued, 50));
    assert.equal(d.speed.timeToRoute.p50, computeMetrics(ctx).timeToRouteMs.p50, 'end-to-end time to route agrees with /api/metrics');
    assert.ok(d.speed.stages.every(s => s.n > 0 && s.p50 != null), 'every stage was timed');
    assert.equal(d.speed.model, null, 'the rules provider never calls a model');
  });

  it('nearest-rank percentile', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([5], 90), 5);
    assert.equal(percentile([4, 1, 3, 2], 50), 2);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  });
});

describe('dashboard figures on a small fixture', () => {
  it('path, SLA, review queue, reps and HubSpot agree with the stored rows', async () => {
    const ctx = await fixture();
    const d = computeDashboard(ctx, { now: NOW });
    const line = (id: string) => d.path.find(p => p.id === id)!;
    assert.equal(line('webhooks').status, 'ok');
    assert.match(line('webhooks').fact, /^4 signed deliveries passed/, 'three Calendly leads plus one re-delivery');
    assert.equal(d.window.webhooks, 8);
    assert.equal(d.window.redeliveries, 1);
    assert.match(line('duplicates').fact, /1 re-delivery answered without a new lead · 1 repeat contact attached/);
    assert.equal(line('matching').status, 'ok');
    assert.equal(d.matching.guessed, 0);
    assert.equal(line('eval').status, 'idle');

    assert.equal(d.kpis.sla.aRouted, 1, 'the Intermountain lead is the one tier-A rep alert');
    assert.equal(d.kpis.sla.aWithin, 1);
    assert.equal(d.kpis.sla.atRisk, 0);

    const open = (ctx.db.prepare(`SELECT COUNT(*) c FROM review_queue WHERE resolved = 0`).get() as any).c;
    assert.ok(open >= 1);
    assert.equal(d.kpis.needsPerson.open, open);
    assert.equal(d.review.length, open);
    assert.ok(d.review.every(r => r.waitMs >= 0 && r.leadId));

    const avery = d.reps.filter(r => r.aTier === 1);
    assert.equal(avery.length, 1, 'one rep holds the tier-A lead');
    assert.equal(avery[0].claimed, 1, 'and claimed its account');
    assert.equal(avery[0].team, 'HSP');
    assert.equal(avery[0].load24h, 0, 'the alert was two days before the newest lead, outside the rolling 24 hours the round-robin counts');

    const planned = (ctx.db.prepare(`SELECT crm_json FROM leads WHERE crm_json IS NOT NULL`).all() as any[]).reduce((a, r) => a + JSON.parse(r.crm_json).requests.length, 0);
    assert.equal(d.hubspot.planned, planned);
    assert.equal(d.hubspot.record.lines, planned, 'the dry-run record in out/hubspot has one line per planned request');
    assert.equal(d.hubspot.failed, 0);
    assert.equal(d.hubspot.mode, 'dry_run');
    assert.ok(d.hubspot.leadsNotWritten >= 2, 'the disposable address and the job seeker get no CRM write');
    const seg = d.hubspot.properties.find(p => p.name === 'serif_segment')!;
    assert.equal(seg.of, d.hubspot.contactUpserts);
    assert.ok(seg.written > 0 && seg.written <= seg.of);
    assert.equal(d.hubspot.lifecycle.reduce((a, x) => a + x.n, 0), d.hubspot.contactUpserts);

    assert.ok(d.notForSales.reasons.some(r => r.id === 'job_seeker'));
    assert.ok(d.notForSales.reasons.some(r => r.id === 'disposable'));
    assert.ok(d.activity.length > 0);
    for (let i = 1; i < d.activity.length; i++) assert.ok(d.activity[i - 1].at >= d.activity[i].at, 'newest first');
    assert.ok(d.activity.some(a => a.kind === 'duplicate'));
    assert.ok(d.activity.some(a => a.kind === 'alerted'));
  });

  it('is read-only: computing it changes no row', async () => {
    const ctx = await fixture();
    const changes = () => (ctx.db.prepare(`SELECT total_changes() c`).get() as any).c;
    const before = changes();
    computeDashboard(ctx, { now: NOW });
    await dashboardHandler(get('/api/dashboard'), ctx);
    assert.equal(changes(), before);
  });
});

describe('the numbers on screen add up', () => {
  // Walking tripwire for the class "a summary line whose parts do not sum to its whole": checked on the visible text, not on internals.
  it('the matching line accounts for every lead: matched + held + ruled out + guessed', async () => {
    const ctx = await fixture();
    const d: any = computeDashboard(ctx);
    const line = d.path.find((p: any) => p.id === 'matching');
    const m = /^(\d+) on a stable ID · (\d+) held for a person · (\d+) ruled out · (\d+) guessed$/.exec(line.fact);
    assert.ok(m, `unexpected matching line: ${line.fact}`);
    const [matched, held, ruledOut, guessed] = m.slice(1).map(Number);
    assert.ok(ruledOut >= 0);
    assert.equal(matched + held + ruledOut + guessed, d.kpis.matched.of, line.fact);
  });

  it('the match tile methods sum to the matched count', async () => {
    const ctx = await fixture();
    const k: any = computeDashboard(ctx).kpis.matched;
    const listed = k.topMethods.reduce((a: number, t: any) => a + t.n, 0) + (k.otherMethods ?? 0);
    assert.equal(listed, k.matched);
  });
});

describe('HubSpot figures from stored responses', () => {
  it('counts a live failure, a reused open task, and keeps live sends apart from dry-run plans', () => {
    const ctx = testCtx();
    const crm = {
      mode: 'live', ok: false,
      requests: [
        { method: 'POST', path: '/crm/v3/objects/contacts/batch/upsert', body: { inputs: [{ id: 'a@b.org', idProperty: 'email', properties: { email: 'a@b.org', lifecyclestage: 'salesqualifiedlead', serif_segment: 'payer' } }] } },
        { method: 'POST', path: '/crm/v3/objects/companies/batch/upsert', body: { inputs: [{ id: 'payer:x', idProperty: 'serif_account_key', properties: { serif_account_key: 'payer:x' } }] } },
        { method: 'POST', path: '/crm/v3/objects/tasks', body: { properties: {} } },
      ],
      responses: [{ path: '/crm/v3/objects/contacts/batch/upsert', status: 200 }, { path: '/crm/v3/objects/companies/batch/upsert', status: 400, error: 'bad property' }, { path: '/crm/v3/objects/tasks', status: 200, reused: '123' }],
    };
    ctx.db.prepare(`INSERT INTO lead_events (id, source, source_event_id, received_at, synthetic, raw_json) VALUES ('L1', 'calendly_demo', 'e1', '2026-11-06T15:00:00.000Z', 1, '{}')`).run();
    ctx.db.prepare(`INSERT INTO leads (id, status, tier, crm_json, created_at, updated_at) VALUES ('L1', 'done', 'A', ?, '2026-11-06T15:00:00.000Z', '2026-11-06T15:00:00.000Z')`).run(JSON.stringify(crm));
    const d = computeDashboard(ctx, { now: NOW });
    assert.deepEqual([d.hubspot.planned, d.hubspot.sentLive, d.hubspot.plannedDryRun, d.hubspot.failed, d.hubspot.reused], [3, 3, 0, 1, 1]);
    assert.equal(d.hubspot.requests.find(r => r.id === 'companies_upsert')!.failed, 1);
    assert.equal(d.hubspot.requests.find(r => r.id === 'task_create')!.reused, 1);
    const line = d.path.find(p => p.id === 'hubspot')!;
    assert.equal(line.status, 'bad');
    assert.match(line.fact, /^3 requests sent live for 1 lead · 1 failed/);
    assert.deepEqual(d.hubspot.lifecycle.find(x => x.stage === 'salesqualifiedlead'), { stage: 'salesqualifiedlead', n: 1 });
    assert.equal(d.funnel.find(f => f.id === 'synced')!.n, 0, 'a lead whose live write failed is not counted as synced');
  });
});

describe('/api/metrics is unchanged (control)', () => {
  it('has the same shape and values, before and after the dashboard is read, and agrees with the dashboard where they overlap', async () => {
    const ctx = await fixture();
    const read = async () => { const j: any = await (await metricsHandler(get('/api/metrics'), ctx)).json(); delete j.generatedAt; return j; };
    const before = await read();
    assert.deepEqual(Object.keys(before), ['total', 'bySource', 'byTier', 'byAction', 'byTeam', 'timeToRouteMs', 'resolvedPct', 'reviewCount', 'hygiene', 'registry']);
    assert.deepEqual(Object.keys(before.hygiene), ['utmFixed', 'duplicatesMerged', 'idempotentReplays', 'freeMailResolved', 'spamDropped', 'titlesNormalized', 'nonUs']);
    const res = await dashboardHandler(get('/api/dashboard'), ctx);
    assert.equal(res.status, 200);
    const d: any = await res.json();
    assert.deepEqual(await read(), before);
    assert.equal(before.total, 7);
    assert.equal(d.kpis.leadsIn.value, before.total);
    for (const x of d.doors) assert.equal(x.total, before.bySource[x.source] ?? 0, x.source);
    assert.equal(d.kpis.needsPerson.open, before.reviewCount);
    assert.deepEqual(d.hygiene, before.hygiene);
    assert.equal(before.hygiene.idempotentReplays, 1);
  });
});

describe('/api/eval and the classifier gate line', () => {
  const evalJson = (ok: Record<string, [number, number, number]>, modelCalls = 76) => ({
    generatedAt: '2026-11-07T16:36:58.154Z', model: 'llama3.2:3b', combineVersion: 'v4', modelCalls,
    sets: Object.entries(ok).map(([name, [u, c, q]]) => ({ name, n: 24, fields: { urgency: { finalOk: u, finalN: 24 }, useCase: { finalOk: c, finalN: 24 }, disqualifier: { finalOk: q, finalN: 24 } } })),
  });
  const write = (ctx: Ctx, body: unknown) => { mkdirSync(ctx.cfg.outDir, { recursive: true }); writeFileSync(join(ctx.cfg.outDir, 'eval.json'), JSON.stringify(body)); };

  it('answers 200 with recorded: false before any eval has run', async () => {
    const res = await evalHandler(get('/api/eval'), testCtx());
    assert.equal(res.status, 200);
    const j: any = await res.json();
    assert.equal(j.recorded, false);
    assert.match(j.reason, /npm run eval/);
  });

  it('serves out/eval.json as written, and the gate line scores it against the floors', async () => {
    const ctx = testCtx();
    const body = evalJson({ sealed: [23, 18, 22], heldout: [22, 20, 23] });
    write(ctx, body);
    assert.deepEqual(await (await evalHandler(get('/api/eval'), ctx)).json(), body);
    const d = computeDashboard(ctx, { now: NOW });
    assert.equal(d.eval.recorded, true);
    if (d.eval.recorded) { assert.equal(d.eval.pass, true); assert.equal(d.eval.floors, 'model'); assert.equal(d.eval.rows.length, 6); }
    assert.equal(d.path.find(p => p.id === 'eval')!.status, 'ok');
  });

  it('a result under a floor turns the gate line red', () => {
    const ctx = testCtx();
    write(ctx, evalJson({ sealed: [20, 18, 22], heldout: [22, 20, 23] }));
    const d = computeDashboard(ctx, { now: NOW });
    const line = d.path.find(p => p.id === 'eval')!;
    assert.equal(line.status, 'bad');
    assert.match(line.fact, /^1 of 6 floors missed/);
  });
});

describe('match and resolve shares print as counts, never as percentages', () => {
  it('resolutionCount is the same pair as resolvedPct in /api/metrics', async () => {
    const ctx = await fixture();
    const rc = resolutionCount(ctx);
    assert.ok(rc.resolved > 0 && rc.resolved < rc.of, 'the fixture mixes resolved and unresolved leads');
    assert.equal(Math.round((rc.resolved / rc.of) * 1000) / 10, computeMetrics(ctx).resolvedPct);
  });

  it('no line in the cockpit, the scripts or src prints a matched or resolved share as a percentage', () => {
    const files = [join(ROOT, 'public', 'app.js')];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(ROOT, 'scripts'));
    walk(join(ROOT, 'src'));
    const offenders: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // An interpolated value followed by "%" on a line about matching or resolving, or pctTxt() of a matched or resolved value.
        if (/match|resolv/i.test(line) && /\$\{[^}]*\}\s*%|pctTxt\([^)]*(match|resolv)/i.test(line)) offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
      });
    }
    assert.ok(files.length > 20, `walked ${files.length} files`);
    assert.deepEqual(offenders, []);
  });
});
