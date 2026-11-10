// Uploaded lists (decision 24): a list door never waits for the model, a repeat scan attaches whatever order its times are
// in, and alerts other than a rep's are folded into one digest per list and team, recorded when the list has settled.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../src/context';
import { computeDashboard } from '../src/dashboard';
import { computeScorecard } from '../src/quality';
import { flushListDigests } from '../src/listDigest';
import { cutNote, digestChannel, listNameOf, summarizeDigest, type DigestRow } from '../src/lists';
import { AFTER_ALERT_REASON } from '../src/modelPath';
import { buildListDigest } from '../src/notify/slack';
import { buildPayload, type PayloadSpec } from '../src/payloads';
import { whenIdle } from '../src/pipeline';
import { runReplay } from '../src/replay';
import { leadView, post, spec, testCtx } from './helpers';

const START = Date.parse('2026-11-10T15:00:00.000Z');
const QUIET = 5_000;
const detail = leadView;

/** A context on an injected clock with the default quiet period, so a test decides when the list has settled. */
function listCtx(over: Parameters<typeof testCtx>[0] = {}, fetchImpl?: typeof fetch) {
  const clock = { now: START };
  const ctx = testCtx({ listQuietMs: QUIET, now: () => clock.now, ...over }, fetchImpl);
  return { ctx, clock };
}

/** One badge scan from the list, posted without waiting. */
async function scan(ctx: Ctx, s: Partial<PayloadSpec>, list = 'HLTH') {
  const r = await post(ctx, 'event_scan', buildPayload('event_scan', spec({ event: list, notes: '', message: undefined, ...s })), { wait: false });
  return r.json.leadId as string;
}

const slackLines = (ctx: Ctx) => {
  const dir = join(ctx.cfg.outDir, 'slack');
  try { return readdirSync(dir).flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))); } catch { return []; }
};

// people at registry organizations whose scans route to a team queue (tier B) or a rep (tier A) on the test registry
const QUEUE_SCAN: Partial<PayloadSpec> = { email: 'mcfarland@ohiohealth.com', first: 'Mira', last: 'Calloway', company: 'OhioHealth', state: 'OH', title: 'Manager, Decision Support' };

describe('listNameOf', () => {
  it('a list door names its list from the payload; another door has none', () => {
    assert.equal(listNameOf({ source: 'event_scan', context: { event: ' HLTH 2026 ' } }, ['event_scan']), 'HLTH 2026');
    assert.equal(listNameOf({ source: 'event_scan', context: {} }, ['event_scan']), 'event_scan (no list name)');
    assert.equal(listNameOf({ source: 'calendly_demo', context: { event: 'x' } }, ['event_scan']), null);
    assert.equal(listNameOf({ source: 'event_scan', context: { event: 'HLTH' } }, []), null, 'LIST_DOORS=none');
  });
  it('a team digest goes to the team channel, review to RevOps, nurture to marketing', () => {
    assert.deepEqual(['HSP', 'Review', 'Nurture'].map(digestChannel), ['#leads-hsp', '#revops-review', '#marketing']);
  });
});

describe('a list door never waits for the model', () => {
  const UNCLEAR = 'Please get in touch with me.';
  function stub() {
    const calls: string[] = [];
    const fetch = (async (_u: unknown, init?: RequestInit) => {
      calls.push(String(init?.body ?? ''));
      const content = { reasons: 'stub', use_case: 'rate_benchmarking_market', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'none', confidence: 0.9 };
      return new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it('a badge note the rules cannot settle is routed on the rules, and the model answers after the alert', async () => {
    const m = stub();
    const ctx = testCtx({ llmProvider: 'ollama' }, m.fetch);
    const id = await scan(ctx, { ...QUEUE_SCAN, notes: UNCLEAR });
    await whenIdle(ctx);
    const l = detail(ctx, id);
    assert.equal(l.qualification.fallbackReason, AFTER_ALERT_REASON);
    assert.equal(l.timings.modelBeforeRoute, undefined, 'the route did not wait');
    assert.equal(l.secondOpinion?.state, 'done', 'the same call ran after the alert');
    assert.equal(m.calls.length, 1);
  });

  it('LIST_DOOR_MODEL=gated restores the gate: the same scan waits for the model', async () => {
    const m = stub();
    const ctx = testCtx({ llmProvider: 'ollama', listDoorModel: 'gated' }, m.fetch);
    const id = await scan(ctx, { ...QUEUE_SCAN, notes: UNCLEAR });
    await whenIdle(ctx);
    assert.ok(typeof detail(ctx, id).timings.modelBeforeRoute === 'number');
    assert.equal(detail(ctx, id).secondOpinion, null);
  });
});

describe('a repeat scan attaches to the scan accepted first, whatever order their times are in', () => {
  for (const order of ['earlier time first', 'later time first'] as const) {
    it(order, async () => {
      const ctx = testCtx();
      const times = order === 'earlier time first' ? ['2026-11-10T13:00:00.000Z', '2026-11-10T14:30:00.000Z'] : ['2026-11-10T14:30:00.000Z', '2026-11-10T13:00:00.000Z'];
      const first = await scan(ctx, { ...QUEUE_SCAN, ts: times[0], seed: 'one' });
      const second = await scan(ctx, { ...QUEUE_SCAN, ts: times[1], seed: 'two', notes: 'second session scan' });
      await whenIdle(ctx);
      const [a, b] = [detail(ctx, first), detail(ctx, second)];
      assert.equal(a.dedupe.duplicateOf, null);
      assert.equal(a.route.action, 'team_queue');
      assert.deepEqual([b.route.rule, b.route.action, b.dedupe.duplicateOf], ['R2', 'attach_to_existing', first]);
      assert.equal(b.route.alertSuppressed, true, 'quiet: its first scan was alerted through the list digest');
      const control = computeScorecard(ctx.db, { now: START }).controls.find(c => c.id === 'repeat_not_linked');
      assert.deepEqual([control?.value, control?.denominator], [0, 1], 'the data-quality control reads the pair the way R2 does');
    });
  }

  it('a lead accepted later never becomes the owner of one accepted earlier, even when re-run', async () => {
    const ctx = testCtx();
    const first = await scan(ctx, { ...QUEUE_SCAN, ts: '2026-11-10T14:30:00.000Z', seed: 'one' });
    await scan(ctx, { ...QUEUE_SCAN, ts: '2026-11-10T13:00:00.000Z', seed: 'two' });
    await whenIdle(ctx);
    assert.equal(detail(ctx, first).dedupe.duplicateOf, null);
  });
});

describe('list digests', () => {
  it('a list lead routed to a team queue keeps its route, SLA and CRM plan, posts nothing of its own, and says which digest it is in', async () => {
    const { ctx } = listCtx();
    const id = await scan(ctx, QUEUE_SCAN);
    await whenIdle(ctx);
    const l = detail(ctx, id);
    assert.equal(l.route.action, 'team_queue');
    assert.ok(l.route.slaDueAt);
    assert.ok(l.crm.requests.length > 0, 'the CRM plan is unchanged');
    assert.equal(l.alert.slack, null);
    assert.deepEqual(l.alert.digest, { list: 'HLTH', team: 'HSP', channel: '#leads-hsp', at: null, id: null });
    assert.ok(l.flags.includes('in_digest'));
    assert.equal(l.list, 'HLTH');
    assert.equal(l.timings.alerted, undefined, 'not alerted until the digest goes out');
    assert.equal(slackLines(ctx).length, 0);
  });

  it('a rep alert in a list keeps its own alert', async () => {
    const { ctx } = listCtx();
    const id = await scan(ctx, { notes: 'wants a demo next week, contract renewal in January' });
    await whenIdle(ctx);
    const l = detail(ctx, id);
    assert.equal(l.route.action, 'rep_alert');
    assert.ok(l.alert.slack, 'its own Slack payload');
    assert.equal(l.alert.digest, undefined);
  });

  it('flush waits for the quiet period on the injected clock, then records one digest per team', async () => {
    const { ctx, clock } = listCtx();
    const hsp = await scan(ctx, QUEUE_SCAN);
    const bw = await scan(ctx, { email: 'p.analyst@meritain.com', first: 'Pia', last: 'Ng', company: 'Meritain Health', title: 'Benefits Analyst', state: 'NY' });
    const unknown = await scan(ctx, { email: 'ops@pinecrestlogistics.example', first: 'Ola', last: 'Brandt', company: 'Pinecrest Logistics', title: 'Operations Manager' });
    await whenIdle(ctx);
    assert.deepEqual(flushListDigests(ctx), [], 'accepted just now: the list may still be arriving');
    clock.now = START + QUIET - 1;
    assert.deepEqual(flushListDigests(ctx), []);
    clock.now = START + QUIET;
    const digests = flushListDigests(ctx);
    const teams = digests.map(d => d.team).sort();
    assert.equal(new Set(teams).size, teams.length, 'one digest per team');
    assert.ok(teams.includes('HSP') && teams.includes('Review'), teams.join(','));
    for (const id of [hsp, bw, unknown]) {
      const l = detail(ctx, id);
      if (!l.alert.digest) continue;
      assert.equal(l.alert.digest.at, new Date(START + QUIET).toISOString());
      assert.equal(l.timings.alerted, QUIET, 'time to alert runs to the digest');
    }
    const lines = slackLines(ctx);
    assert.equal(lines.length, digests.length, 'one Slack record per digest, none per row');
    assert.ok(lines.every(x => x.leadId === 'list:HLTH' && x.dryRun === true));
    assert.deepEqual(flushListDigests(ctx), [], 'nothing owed twice');
  });

  it('a list with a lead still in flight is not digested, even forced', async () => {
    const { ctx, clock } = listCtx();
    const id = await scan(ctx, QUEUE_SCAN);
    await whenIdle(ctx);
    await scan(ctx, { email: 'later@geisinger.org', company: 'Geisinger', state: 'PA', title: 'Contract Analyst' });
    await whenIdle(ctx);
    ctx.db.prepare(`UPDATE leads SET status = 'retrying' WHERE id != ?`).run(id);
    clock.now = START + QUIET * 10;
    assert.deepEqual(flushListDigests(ctx, { force: true }), []);
  });

  it('unknown organizations go to RevOps in one digest that lists them; each keeps its own review item', async () => {
    const { ctx, clock } = listCtx();
    const people = ['harrowgatemills', 'tidewaterfreight', 'larkspurhospitality'].map((d, i) => ({ email: `p${i}@${d}.example`, first: `P${i}`, last: 'Quill', company: `${d} Inc`, title: 'Operations Manager' }));
    for (const [i, p] of people.entries()) await scan(ctx, { ...p, seed: `u${i}` });
    await whenIdle(ctx);
    clock.now = START + QUIET;
    const digests = flushListDigests(ctx);
    const review = digests.filter(d => d.team === 'Review');
    assert.equal(review.length, 1);
    assert.equal(review[0].channel, '#revops-review');
    assert.equal(review[0].rows, 3);
    const text = JSON.stringify(slackLines(ctx).find(x => x.channel === '#revops-review'));
    for (const p of people) assert.ok(text.includes(p.company), `lists ${p.company}`);
    const items = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM review_queue`).get() as { n: number }).n;
    assert.equal(items, 3, 'one review item per row, as before');
  });

  it('whenIdle does not wait for the quiet period', async () => {
    const ctx = testCtx({ listQuietMs: 60_000 });
    await scan(ctx, QUEUE_SCAN);
    const t = performance.now();
    await whenIdle(ctx);
    assert.ok(performance.now() - t < 5_000);
  });
});

describe('what a digest says', () => {
  const row = (i: number, over: Partial<DigestRow> = {}): DigestRow => ({
    leadId: `l${i}`, name: `Person ${i}`, title: 'Director', org: `Org ${i}`, companyTyped: null, tier: i % 2 ? 'B' : 'C', score: 40 + i, action: i % 2 ? 'team_queue' : 'nurture',
    note: null, slaDueAt: i % 2 ? `2026-11-10T1${i % 10}:00:00.000Z` : null, reviewReason: null, unknownOrg: false, ...over,
  });

  it('counts by tier and action, the top ten by score, how many more, and the earliest SLA due', () => {
    const rows = Array.from({ length: 13 }, (_, i) => row(i));
    const s = summarizeDigest(rows);
    assert.deepEqual(s.byTier, { C: 7, B: 6 });
    assert.deepEqual(s.byAction, { nurture: 7, team_queue: 6 });
    assert.deepEqual(s.top.map(r => r.leadId), ['l12', 'l11', 'l10', 'l9', 'l8', 'l7', 'l6', 'l5', 'l4', 'l3']);
    assert.equal(s.more, 3);
    assert.equal(s.earliestSlaDueAt, '2026-11-10T11:00:00.000Z');
  });

  it('the payload carries the list, the counts, the top rows with notes cut to 120 characters, repeats and unknown organizations', () => {
    const long = 'x'.repeat(200);
    const rows = [row(1, { note: long }), row(2)];
    const p = buildListDigest({ batch: { list: 'HLTH', rows: 150, repeatsAttached: 6, unknownOrgs: 18, from: 'a', to: 'b' }, teamLabel: 'Health Systems & Providers', channel: '#leads-hsp', summary: summarizeDigest(rows), synthetic: true });
    const text = JSON.stringify(p);
    assert.equal(p.channel, '#leads-hsp');
    assert.match(p.text, /^HLTH: 2 rows for Health Systems & Providers/);
    for (const s of ['150 rows in this upload', 'B 1', 'C 1', 'team queue 1', 'nurture 1', '6 in the list', '18 in the list', '2026-11-10T11:00:00.000Z', 'Person 2']) assert.ok(text.includes(s), s);
    assert.ok(text.includes(cutNote(long)!) && !text.includes(long), 'the note is cut');
    assert.equal(cutNote(long)!.length, 120);
  });
});

describe('the dashboard and the replay', () => {
  it('the lists block counts a list, and a digested row counts as alerted', async () => {
    const { ctx, clock } = listCtx();
    await scan(ctx, QUEUE_SCAN);
    await scan(ctx, { ...QUEUE_SCAN, seed: 'again', ts: '2026-11-05T14:00:00.000Z' });
    await scan(ctx, { email: 'ops@pinecrestlogistics.example', first: 'Ola', last: 'Brandt', company: 'Pinecrest Logistics', title: 'Operations Manager' });
    await whenIdle(ctx);
    let d = computeDashboard(ctx);
    assert.equal(d.lists.length, 1);
    const l = d.lists[0];
    assert.deepEqual([l.name, l.rows, l.repeatsAttached, l.unknownOrgs, l.digests, l.waitingForDigest], ['HLTH', 3, 1, 1, 0, 2]);
    assert.equal(l.byAction.team_queue, 1);
    assert.equal(l.firstAccepted, new Date(START).toISOString());
    assert.ok(d.review.every(r => r.list === 'HLTH'), 'review rows carry their list for grouping');
    const alertedBefore = d.funnel.find(f => f.id === 'alerted')!.n;
    clock.now = START + QUIET;
    flushListDigests(ctx);
    d = computeDashboard(ctx);
    assert.equal(d.lists[0].digests, 2);
    assert.equal(d.lists[0].waitingForDigest, 0);
    assert.equal(d.funnel.find(f => f.id === 'alerted')!.n, alertedBefore + 1, 'the team-queue row is alerted once its digest is out');
    assert.equal(d.sla.salesReady.notAlerted, 0);
  });

  it("the replay posts the day's event scans into digests and records them once everything is posted", async () => {
    const ctx = testCtx();
    const results = await runReplay(ctx, { wait: true });
    const scans = results.filter(r => r.fixture.source === 'event_scan' && r.leadId).map(r => detail(ctx, r.leadId!));
    assert.equal(scans.length, 2);
    for (const l of scans) {
      assert.ok(l.alert.digest?.at, `${l.id} went out in a digest`);
      assert.equal(l.alert.slack, null);
    }
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM list_digests`).get() as { n: number }).n, 2);
  });
});
