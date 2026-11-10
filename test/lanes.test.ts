// Commit lanes (decision 23): a lead waiting for the model or a slow lookup holds only its own lane. Leads in one lane commit
// in acceptance order; with no grace (COMMIT_GRACE_MS=never) every lead commits in acceptance order, as before.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextCommit, type Candidate } from '../src/commitOrder';
import type { Ctx } from '../src/context';
import { laneOf } from '../src/lanes';
import { buildPayload } from '../src/payloads';
import { recheckCommitOrder, resumePending, retryDueLeads, whenIdle } from '../src/pipeline';
import { leadView, post, spec, testCtx } from './helpers';

const lookups = { isFreeMail: (d: string) => d === 'gmail.com', isDisposable: (d: string) => d === 'mailinator.com' };

describe('laneOf: the lane is read from what is cheap at accept time', () => {
  it("an organization's email domain is its lane, so its people stay in order with each other", () => {
    assert.equal(laneOf({ email: 'A.Smith@Geisinger.org', context: {} }, lookups, 'x'), 'domain:geisinger.org');
    assert.equal(laneOf({ email: 'b.jones@geisinger.org', context: {} }, lookups, 'y'), 'domain:geisinger.org');
  });
  it('free mail and disposable mail say nothing about the organization: the full address is the lane', () => {
    assert.equal(laneOf({ email: 'Pat.Lee@gmail.com', context: {} }, lookups, 'x'), 'email:pat.lee@gmail.com');
    assert.equal(laneOf({ email: 'x@mailinator.com', context: {} }, lookups, 'x'), 'email:x@mailinator.com');
  });
  it('a door with no person (web intent) uses the company domain, and a lead with nothing uses itself', () => {
    assert.equal(laneOf({ email: null, context: { domain: 'Geisinger.org' } }, lookups, 'x'), 'domain:geisinger.org');
    assert.equal(laneOf({ email: null, context: {} }, lookups, 'lead-1'), 'lead:lead-1');
  });
});

describe('nextCommit: which accepted lead commits next', () => {
  const c = (id: string, lane: string, ready: boolean): Candidate => ({ id, lane, ready });
  const clock = { now: 1_000, headSince: 1_000, graceMs: 250 };
  it('the head goes first when it is ready', () => {
    assert.deepEqual(nextCommit([c('a', 'x', true), c('b', 'y', true)], clock), { kind: 'commit', id: 'a', passed: false });
  });
  it('a waiting head keeps its grace period, and says when it ends', () => {
    assert.deepEqual(nextCommit([c('a', 'x', false), c('b', 'y', true)], { ...clock, now: 1_249 }), { kind: 'wait', recheckAt: 1_250 });
  });
  it('after the grace, the earliest ready lead that is first in its own lane passes', () => {
    const q = [c('a', 'x', false), c('b', 'x', true), c('c', 'y', false), c('d', 'z', true), c('e', 'w', true)];
    assert.deepEqual(nextCommit(q, { ...clock, now: 1_250 }), { kind: 'commit', id: 'd', passed: true }, 'b is behind a in lane x, c is not ready');
  });
  it('a lead never passes an earlier lead of its own lane', () => {
    assert.deepEqual(nextCommit([c('a', 'x', false), c('b', 'x', true)], { ...clock, now: 9_999 }), { kind: 'wait', recheckAt: null });
  });
  it('with no grace the head always goes first: the order of acceptance', () => {
    assert.deepEqual(nextCommit([c('a', 'x', false), c('b', 'y', true)], { ...clock, now: 9_999, graceMs: null }), { kind: 'wait', recheckAt: null });
  });
  it('nothing waiting', () => {
    assert.deepEqual(nextCommit([], clock), { kind: 'empty' });
  });
});

// ---- in the pipeline, with an injected clock and a model the test releases ------------------------------------------------

const UNCLEAR = 'Please get in touch with me.'; // no keyword winner: this lead waits for the model before its route
const START = Date.parse('2026-11-10T15:00:00.000Z');

/** A stand-in for Ollama that holds every call for UNCLEAR until the test releases it, and answers anything else at once. */
function heldModel() {
  let release = () => {};
  const gate = new Promise<void>(r => { release = r; });
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { role: string; content: string }[] };
    const user = body.messages?.filter(m => m.role === 'user').at(-1)?.content ?? '';
    if (user.includes(UNCLEAR)) await gate;
    const content = { reasons: 'stub', use_case: 'rate_benchmarking_market', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'none', confidence: 0.9 };
    return new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, release: () => release() };
}

/** Lets the prepare work of everything posted settle without moving the injected clock. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

function laneCtx(graceMs: number | null) {
  const clock = { now: START };
  const m = heldModel();
  const ctx = testCtx({ llmProvider: 'ollama', commitGraceMs: graceMs, now: () => clock.now }, m.fetch);
  const done: string[] = [];
  ctx.bus.on('lead', (e: { id: string; status: string; secondOpinion?: string }) => { if (e.status === 'done' && !e.secondOpinion) done.push(e.id); });
  return { ctx, clock, m, done };
}

/** A waits for the model (lane geisinger.org); B is a guide download from the same organization; C is from another one. */
async function postThree(ctx: Ctx) {
  const send = async (source: 'calendly_demo' | 'guide_download', over: Parameters<typeof spec>[0]) =>
    (await post(ctx, source, buildPayload(source, spec(over)), { wait: false })).json.leadId as string;
  const a = await send('calendly_demo', { email: 'waits@geisinger.org', company: 'Geisinger', state: 'PA', title: 'Analyst', message: UNCLEAR, seed: 'a' });
  const b = await send('guide_download', { email: 'colleague@geisinger.org', company: 'Geisinger', state: 'PA', message: undefined, seed: 'b', ts: '2026-11-05T15:00:01.000Z' });
  const c = await send('calendly_demo', { email: 'dana@intermountainhealthcare.org', seed: 'c', ts: '2026-11-05T15:00:02.000Z' });
  return { a, b, c };
}

describe('lanes in the pipeline', () => {
  it('a lead waiting for the model holds its own lane only: after the grace a ready lead in another lane passes it', async () => {
    const { ctx, clock, m, done } = laneCtx(250);
    const { a, b, c } = await postThree(ctx);
    await settle();
    assert.deepEqual(done, [], 'inside the grace period nothing passes the waiting head');
    clock.now = START + 300;
    recheckCommitOrder(ctx);
    await settle();
    assert.deepEqual(done, [c], 'C, in another lane, passed; B stays behind A in their shared lane');
    m.release();
    await whenIdle(ctx);
    assert.deepEqual(done, [c, a, b], 'A, then B, in the order they were accepted');
    const [la, lb, lc] = [a, b, c].map(id => leadView(ctx, id));
    assert.equal(lc.timings.passed, 1, 'the lead that passed says so');
    assert.equal(la.timings.passed, undefined);
    assert.match(JSON.stringify(lb.score), /1 other contact/, 'B committed after A in their lane, so it counts A as another contact at the account');
    assert.ok(typeof la.timings.modelBeforeRoute === 'number', 'A waited for its model call before its route');
  });

  it('the same leads with no grace commit exactly in the order they were accepted', async () => {
    const { ctx, clock, m, done } = laneCtx(null);
    const { a, b, c } = await postThree(ctx);
    await settle();
    clock.now = START + 60_000;
    recheckCommitOrder(ctx);
    await settle();
    assert.deepEqual(done, [], 'nothing passes A, however long it waits');
    m.release();
    await whenIdle(ctx);
    assert.deepEqual(done, [a, b, c]);
  });

  it('round-robin and dedupe stay one at a time: a burst from one contact still attaches to its first lead with passing on', async () => {
    const { ctx, m } = laneCtx(0);
    m.release();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await post(ctx, 'calendly_demo', buildPayload('calendly_demo', spec({ seed: `burst-${i}`, ts: `2026-11-05T15:0${i}:00.000Z` })), { wait: false })).json.leadId);
    }
    await whenIdle(ctx);
    const [first, ...rest] = ids.map(id => leadView(ctx, id));
    assert.equal(first.route.action, 'rep_alert');
    for (const l of rest) assert.deepEqual([l.route.rule, l.dedupe.duplicateOf], ['R2', first.id]);
  });

  it('boot recovery re-runs unfinished leads with passing on, in acceptance order within each lane', async () => {
    const { ctx, m, done } = laneCtx(0);
    m.release();
    const ids: string[] = [];
    for (const [i, email] of ['one@geisinger.org', 'two@geisinger.org', 'dana@intermountainhealthcare.org'].entries()) {
      ids.push((await post(ctx, 'guide_download', buildPayload('guide_download', spec({ email, seed: `boot-${i}`, message: undefined })))).json.leadId);
    }
    ctx.db.exec(`UPDATE leads SET status = 'received'`); // as a stopped process would leave them
    done.length = 0;
    assert.equal(resumePending(ctx), 3);
    await whenIdle(ctx);
    assert.deepEqual(done.filter(id => ids.slice(0, 2).includes(id)), ids.slice(0, 2), 'the two Geisinger leads in their order');
    assert.equal(done.length, 3);
  });

  it('the failed-lead retry still runs with passing on', async () => {
    const clock = { now: START };
    const ctx = testCtx({ commitGraceMs: 0, leadRetryDelayMs: 5_000, now: () => clock.now });
    ctx.db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF status ON leads WHEN NEW.status = 'scored' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    const id = (await post(ctx, 'calendly_demo', buildPayload('calendly_demo', spec({ seed: 'retry' })))).json.leadId;
    assert.equal(leadView(ctx, id).status, 'retrying');
    ctx.db.exec('DROP TRIGGER boom');
    clock.now = START + 5_000;
    assert.equal(retryDueLeads(ctx), 1);
    await whenIdle(ctx);
    assert.equal(leadView(ctx, id).status, 'done');
  });
});
