// When the model runs (decision 19): the route waits for it only when it can change the team; every other free-text lead is
// alerted on the rules and gets the same call afterwards as a second opinion. Leads prepare concurrently and commit in order.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../src/context';
import { computeDashboard } from '../src/dashboard';
import { AFTER_ALERT_REASON } from '../src/modelPath';
import { buildPayload } from '../src/payloads';
import { resumePending, whenIdle } from '../src/pipeline';
import { DOUBT_REVIEW_REASON, kickSecondOpinions, opinionsAtOnce, secondOpinionsIdle } from '../src/secondOpinion';
import { leadDetail } from '../src/view';
import { post, spec, submit, testCtx } from './helpers';

/** What the stub model answers: any field of the classify schema, defaults agreeing with nothing in particular. */
type Answer = Partial<{ use_case: string; urgency: string; buying_role: string; disqualifier: string; confidence: number; reasons: string }>;

interface StubModel {
  fetch: typeof globalThis.fetch;
  /** the prospect message of each call, in the order the calls started */
  calls: string[];
}

/** A stand-in for Ollama: answers by the prospect's message, after an optional delay per message. */
function stubModel(answer: (message: string) => Answer, delayMs: (message: string) => number = () => 0, log?: string[]): StubModel {
  const calls: string[] = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { role: string; content: string }[] };
    const user = body.messages?.filter(m => m.role === 'user').at(-1)?.content ?? ''; // the earlier user turns are the prompt's examples
    const message = /Message: "?([^\n]*?)"?$/m.exec(user)?.[1] ?? user;
    calls.push(message);
    log?.push(`model:${message}`);
    const ms = delayMs(message);
    if (ms) await new Promise(r => setTimeout(r, ms));
    const content = { reasons: 'stub', use_case: 'other', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'none', confidence: 0.9, ...answer(message) };
    return new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const CLEAR = 'Our commercial renegotiations start in January.'; // contract negotiation, a clear keyword winner
const UNCLEAR = 'Please get in touch with me.'; // no keyword winner: the model's use case can change the team

const modelCtx = (m: StubModel, over: Parameters<typeof testCtx>[0] = {}) => testCtx({ llmProvider: 'ollama', ...over }, m.fetch);
const detail = (ctx: Ctx, id: string) => leadDetail(ctx, id) as any;
const statusLog = (ctx: Ctx, log: string[]) => ctx.bus.on('lead', (e: { id: string; status: string; crm?: string; secondOpinion?: string }) => {
  if (!e.crm && !e.secondOpinion) log.push(`${e.status}:${e.id}`);
});

describe('the gate: which leads wait for the model', () => {
  it('a clear keyword use case is routed and alerted on the rules; the model runs after the alert', async () => {
    const log: string[] = [];
    const m = stubModel(() => ({ use_case: 'contract_negotiation' }), () => 0, log);
    const ctx = modelCtx(m);
    statusLog(ctx, log);
    const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR });
    assert.equal(lead.qualification.fallbackReason, AFTER_ALERT_REASON);
    assert.equal(lead.qualification.llm, null, 'the route used the rules alone');
    assert.equal(lead.timings.modelBeforeRoute, undefined);
    assert.equal(lead.route.action, 'rep_alert');
    assert.ok(log.indexOf(`notified:${lead.id}`) < log.indexOf(`model:${CLEAR}`), 'the alert went out before the model was asked');
    assert.deepEqual(m.calls, [CLEAR], 'asked once, afterwards');
  });

  it('a use case the rules cannot settle waits for the model, and the route uses its answer', async () => {
    const m = stubModel(() => ({ use_case: 'rate_benchmarking_market' }));
    const ctx = modelCtx(m);
    const { lead } = await submit(ctx, 'calendly_demo', { message: UNCLEAR, title: 'Analyst' });
    assert.equal(lead.qualification.rules.useCase, 'other', 'no keyword winner');
    assert.ok(typeof lead.timings.modelBeforeRoute === 'number', 'the route waited for the model');
    assert.equal(lead.qualification.final.useCase, 'rate_benchmarking_market');
    assert.equal(lead.qualification.final.sources.useCase, 'model', "the model's use case is what the route used (teamFor can change the team on it)");
    assert.equal(lead.secondOpinion, null, 'no second opinion: the model already ran');
    assert.equal(m.calls.length, 1);
  });

  it('a lead with no free text never calls the model, before or after', async () => {
    const m = stubModel(() => ({}));
    const ctx = modelCtx(m);
    const { lead } = await submit(ctx, 'guide_download', { message: undefined, guide: 'Health System Executive Guide' });
    assert.match(lead.qualification.fallbackReason, /^no_free_text/);
    assert.deepEqual(m.calls, []);
    assert.equal(lead.secondOpinion, null);
  });

  it('rules only is unchanged: the record says the model is disabled and no second opinion is due', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR });
    assert.match(lead.qualification.fallbackReason, /^llm_disabled/);
    assert.equal(lead.secondOpinion, null);
  });

  it('MODEL_BEFORE_ROUTE=all restores the old path: every free-text lead waits for the model, and none gets a second opinion', async () => {
    const log: string[] = [];
    const m = stubModel(() => ({ use_case: 'contract_negotiation' }), () => 0, log);
    const ctx = modelCtx(m, { modelBeforeRoute: 'all' });
    statusLog(ctx, log);
    const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR });
    assert.ok(lead.qualification.llm);
    assert.equal(lead.qualification.fallbackReason, null);
    assert.ok(typeof lead.timings.modelBeforeRoute === 'number');
    assert.ok(log.indexOf(`model:${CLEAR}`) < log.indexOf(`routed:${lead.id}`), 'the model ran before the route');
    assert.equal(lead.secondOpinion, null);
    assert.equal(m.calls.length, 1);
  });
});

describe('the second opinion after the alert', () => {
  it('agreement: stored with the answer, nothing it would change, no review item and no follow-up', async () => {
    const m = stubModel(() => ({ use_case: 'contract_negotiation', buying_role: 'decision_maker' }));
    const ctx = modelCtx(m);
    const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR });
    const so = lead.secondOpinion;
    assert.equal(so.state, 'done');
    assert.equal(so.result.answered, true);
    assert.equal(so.result.agreed, true);
    assert.deepEqual(so.result.changed, []);
    assert.equal(so.result.doubt, null);
    assert.equal(so.result.llm.useCase, 'contract_negotiation');
    assert.ok(typeof so.result.afterAlertMs === 'number');
    assert.equal(lead.review, null);
    assert.equal(lead.alert.followUp, undefined);
  });

  it('a buying role the title did not give is recorded as filled, and nothing else moves', async () => {
    const m = stubModel(() => ({ use_case: 'contract_negotiation', buying_role: 'decision_maker' }));
    const ctx = modelCtx(m);
    const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR, title: '' });
    assert.equal(lead.qualification.rules.evidence.roleFromTitle, false);
    const r = lead.secondOpinion.result;
    assert.deepEqual(r.changed, ['buyingRole']);
    assert.equal(r.roleFilled, 'decision_maker');
    assert.equal(r.agreed, false);
    assert.equal(r.doubt, null);
    assert.equal(lead.qualification.final.buyingRole, lead.qualification.rules.buyingRole, 'the route record keeps what the route used');
    assert.equal(lead.review, null);
  });

  it('a doubt the rules did not share opens a review item and a follow-up to the rep and RevOps; the lead stays routed', async () => {
    const m = stubModel(() => ({ use_case: 'vendor_pitch', disqualifier: 'vendor_pitch', confidence: 0.95 }));
    const ctx = modelCtx(m);
    const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR });
    assert.deepEqual([lead.route.rule, lead.route.action, lead.route.owner], ['R10', 'rep_alert', 'Avery'], 'not quietly un-routed');
    const r = lead.secondOpinion.result;
    assert.deepEqual(r.doubt, { disqualifier: 'vendor_pitch', confidence: 0.95, heldForPerson: true });
    assert.ok(r.changed.includes('reviewReason'));
    assert.equal(r.followedUp, true);
    assert.equal(lead.review.reason, DOUBT_REVIEW_REASON);
    const followUp = lead.alert.followUp;
    assert.deepEqual(followUp.map((p: { channel: string }) => p.channel), ['@Avery', '#revops-review']);
    for (const p of followUp) {
      assert.match(p.text, /RevOps is checking/);
      const what = JSON.stringify(p.blocks);
      assert.match(what, /flagged this lead as vendor pitch but no rule agreed, and vendor pitch is never dropped on the model's word alone, so RevOps is checking it/);
      assert.match(what, /Avery keeps the lead unless RevOps withdraws it/);
      assert.doesNotMatch(what, /stub/, "nothing the model wrote goes into the follow-up");
    }
    assert.ok(lead.alert.slack, 'the original alert is kept as it was');
    const slackDir = join(ctx.cfg.outDir, 'slack');
    const recorded = readdirSync(slackDir).flatMap(f => readFileSync(join(slackDir, f), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
    // the alert, the enterprise deals note (Intermountain is an enterprise account, decision 25) and the two follow-ups
    assert.deepEqual(recorded.filter(p => p.leadId === lead.id).map(p => p.channel), ['@Avery', '#enterprise-deals', '@Avery', '#revops-review']);
  });

  it('a counted disqualifier at 0.8 or above is a doubt too, worded with its confidence', async () => {
    const m = stubModel(() => ({ disqualifier: 'job_seeker', confidence: 0.9 }));
    const ctx = modelCtx(m);
    const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR });
    assert.deepEqual(lead.secondOpinion.result.doubt, { disqualifier: 'job_seeker', confidence: 0.9, heldForPerson: false });
    assert.deepEqual(lead.secondOpinion.result.changed, ['disqualifier']);
    assert.match(JSON.stringify(lead.alert.followUp[0].blocks), /as job seeker but no rule agreed, at 0.90 confidence/);
    assert.equal(lead.route.action, 'rep_alert');
  });

  it('a doubt on a route the old order would not have changed (a repeat touch under R2) is recorded only', async () => {
    const m = stubModel(msg => (msg.includes('again') ? { disqualifier: 'vendor_pitch', confidence: 0.95 } : { use_case: 'contract_negotiation' }));
    const ctx = modelCtx(m);
    await submit(ctx, 'calendly_demo', { message: CLEAR, seed: 'first' });
    const { lead } = await submit(ctx, 'calendly_demo', { message: `${CLEAR} Writing again.`, seed: 'second', ts: '2026-11-05T16:00:00.000Z' });
    assert.equal(lead.route.rule, 'R2');
    assert.ok(lead.secondOpinion.result.doubt);
    assert.equal(lead.secondOpinion.result.followedUp, false);
    assert.equal(lead.review, null);
    assert.equal(lead.alert.followUp, undefined);
  });

  it('a model that does not answer leaves a result that says so, and nothing else', async () => {
    const ctx = testCtx({ llmProvider: 'ollama' }, async () => { throw new TypeError('fetch failed: ECONNREFUSED'); });
    const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR });
    assert.equal(lead.route.action, 'rep_alert');
    const r = lead.secondOpinion.result;
    assert.equal(r.answered, false);
    assert.equal(r.agreed, false);
    assert.match(r.fallbackReason, /llm_unavailable/);
    assert.equal(lead.review, null);
  });
});

describe('prepare concurrently, commit in order', () => {
  it('a later lead prepares while an earlier one waits for the model, and still commits after it', async () => {
    const log: string[] = [];
    const m = stubModel(() => ({ use_case: 'rate_benchmarking_market' }), msg => (msg === UNCLEAR ? 150 : 0));
    const ctx = modelCtx(m);
    statusLog(ctx, log);
    const slow = await post(ctx, 'calendly_demo', buildPayload('calendly_demo', spec({ message: UNCLEAR, title: 'Analyst', email: 'slow@intermountainhealthcare.org', seed: 'slow' })), { wait: false });
    const fast = await post(ctx, 'guide_download', buildPayload('guide_download', spec({ message: undefined, email: 'fast@brookmerehealth.example', seed: 'fast', ts: '2026-11-05T15:00:01.000Z' })), { wait: false });
    await whenIdle(ctx);
    const a = detail(ctx, slow.json.leadId), b = detail(ctx, fast.json.leadId);
    assert.ok(b.timings.prepared < a.timings.prepared, 'the later lead was prepared first');
    for (const status of ['normalized', 'routed', 'notified', 'done']) {
      assert.ok(log.indexOf(`${status}:${a.id}`) < log.indexOf(`${status}:${b.id}`), `${status}: the earlier lead commits first`);
    }
    assert.ok(b.timings.queued >= 100, 'the later lead waited for the earlier one in the ordered section');
    assert.equal(b.timings.waitedForPrepare, 0, 'and not for its own preparation, which was ready');
    assert.ok(a.timings.waitedForPrepare >= 100, 'the earlier lead waited for its model call');
  });

  it('a burst from one contact is still deduped: the first lead owns it, the rest attach to it', async () => {
    const m = stubModel(() => ({ use_case: 'rate_benchmarking_market' }), msg => (msg === UNCLEAR ? 100 : 0));
    const ctx = modelCtx(m);
    const ids: string[] = [];
    // the first message makes its lead wait for the model, so the later ones are prepared before it
    for (const [i, message] of [UNCLEAR, CLEAR, CLEAR].entries()) {
      const r = await post(ctx, 'calendly_demo', buildPayload('calendly_demo', spec({ message, title: 'Analyst', seed: `burst-${i}`, ts: `2026-11-05T15:0${i}:00.000Z` })), { wait: false });
      ids.push(r.json.leadId);
    }
    await whenIdle(ctx);
    const [first, ...rest] = ids.map(id => detail(ctx, id));
    assert.equal(first.dedupe.duplicateOf, null);
    assert.equal(first.route.action, 'rep_alert');
    for (const l of rest) {
      assert.equal(l.dedupe.duplicateOf, first.id);
      assert.deepEqual([l.route.rule, l.route.action, l.route.owner], ['R2', 'attach_to_existing', first.route.owner]);
    }
    const assignments = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM assignments`).get() as { n: number }).n;
    assert.equal(assignments, 1, 'one rep assignment for the contact');
  });
});

describe('second opinions never hold a route', () => {
  it('no second opinion starts while a lead is waiting in the ordered section; it starts when the queue empties', async () => {
    const m = stubModel(() => ({ use_case: 'contract_negotiation' }));
    const ctx = modelCtx(m);
    const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR });
    assert.equal(m.calls.length, 1);
    const due = () => ctx.db.prepare(`UPDATE leads SET second_opinion = 'pending' WHERE id = ?`).run(lead.id);
    due();
    ctx.q.pending = 1; // a lead waiting for its turn
    kickSecondOpinions(ctx);
    await secondOpinionsIdle(ctx);
    assert.equal(m.calls.length, 1, 'not asked while a lead waits: a call cannot be interrupted, and that lead may need the model');
    assert.equal(detail(ctx, lead.id).secondOpinion.state, 'pending');
    ctx.q.pending = 0;
    kickSecondOpinions(ctx);
    await whenIdle(ctx);
    assert.equal(m.calls.length, 2);
    assert.equal(detail(ctx, lead.id).secondOpinion.state, 'done');
  });

  it('the last lead out of the ordered section starts the worker', async () => {
    const m = stubModel(() => ({ use_case: 'contract_negotiation' }));
    const ctx = modelCtx(m);
    const ids: string[] = [];
    for (const i of [1, 2, 3]) ids.push((await post(ctx, 'calendly_demo', buildPayload('calendly_demo', spec({ message: CLEAR, email: `p${i}@intermountainhealthcare.org`, seed: `p${i}` })), { wait: false })).json.leadId);
    await whenIdle(ctx);
    assert.deepEqual(ids.map(id => detail(ctx, id).secondOpinion.state), ['done', 'done', 'done']);
  });
});

describe('second opinions use the model slots a route does not need', () => {
  /** Six leads the rules settle, then their second opinions: the most model calls in flight at any moment. */
  async function mostAtOnce(modelConcurrency: number) {
    let inFlight = 0;
    let most = 0;
    const m = stubModel(() => ({ use_case: 'contract_negotiation' }));
    const counted = (async (url: unknown, init?: RequestInit) => {
      most = Math.max(most, ++inFlight);
      await new Promise(r => setTimeout(r, 15));
      try { return await m.fetch(url as string, init); } finally { inFlight--; }
    }) as typeof globalThis.fetch;
    const ctx = testCtx({ llmProvider: 'ollama', modelConcurrency }, counted);
    const ids: string[] = [];
    // posted one after another with a pause, as a list arrives: the first opinion is in flight before the others are due,
    // so a strand that found nothing to do at the start has to be filled later
    for (const i of [1, 2, 3, 4, 5, 6]) {
      ids.push((await post(ctx, 'calendly_demo', buildPayload('calendly_demo', spec({ message: CLEAR, email: `q${i}@intermountainhealthcare.org`, seed: `q${i}` })), { wait: false })).json.leadId);
      await new Promise(r => setTimeout(r, 4));
    }
    await whenIdle(ctx);
    assert.deepEqual(ids.map(id => detail(ctx, id).secondOpinion.state), Array(6).fill('done'));
    return most;
  }
  it('one slot, the local model: one at a time, as before', async () => assert.equal(await mostAtOnce(1), 1));
  it('four slots, a hosted model: three at a time, with one slot left for a lead whose route is waiting', async () => {
    assert.equal(opinionsAtOnce(testCtx({ modelConcurrency: 4 })), 3);
    assert.equal(await mostAtOnce(4), 3);
  });
});

describe('boot recovery of a second opinion', () => {
  for (const state of ['pending', 'running'] as const) {
    it(`a second opinion a stopped process left ${state} is asked again at boot`, async () => {
      const m = stubModel(() => ({ use_case: 'contract_negotiation', buying_role: 'decision_maker' }));
      const ctx = modelCtx(m);
      const { lead } = await submit(ctx, 'calendly_demo', { message: CLEAR, title: '' });
      assert.equal(m.calls.length, 1);
      // as a stopped process leaves it: done and alerted, the second opinion still due or in flight
      ctx.db.prepare(`UPDATE leads SET second_opinion = ?, second_opinion_json = '{"shownSegment":"health_system"}' WHERE id = ?`).run(state, lead.id);
      assert.equal(resumePending(ctx), 0, 'the lead itself is done and is not re-run');
      await whenIdle(ctx);
      assert.equal(m.calls.length, 2, 'the model was asked again');
      const after = detail(ctx, lead.id);
      assert.equal(after.secondOpinion.state, 'done');
      assert.equal(after.secondOpinion.result.roleFilled, 'decision_maker');
      assert.equal(after.secondOpinion.result.shownSegment, 'health_system');
    });
  }
});

describe('the cockpit speed figures', () => {
  it('time to alert, the leads that waited for the model, and what the second opinions found', async () => {
    const m = stubModel(msg => (msg === UNCLEAR ? { use_case: 'rate_benchmarking_market' } : msg.includes('pitch') ? { disqualifier: 'vendor_pitch', confidence: 0.95 } : { use_case: 'contract_negotiation' }));
    const ctx = modelCtx(m);
    await submit(ctx, 'calendly_demo', { message: UNCLEAR, title: 'Analyst', email: 'a@intermountainhealthcare.org', seed: 'a' });
    await submit(ctx, 'calendly_demo', { message: CLEAR, email: 'b@intermountainhealthcare.org', seed: 'b' });
    await submit(ctx, 'calendly_demo', { message: `${CLEAR} Not a pitch.`, email: 'c@intermountainhealthcare.org', seed: 'c' });
    const d = computeDashboard(ctx);
    assert.equal(d.env.model.called, 1, 'one route waited for the model');
    assert.equal(d.env.model.secondOpinions, 2);
    assert.equal(d.speed.model?.n, 1);
    const so = d.speed.secondOpinion;
    assert.deepEqual([so.due, so.ran, so.answered, so.agreed, so.changed, so.doubts, so.followedUp], [0, 2, 2, 1, 1, 1, 1]);
    assert.equal(d.speed.timeToAlert.n, 3);
    assert.ok(d.kpis.timeToAlert.p90 != null);
    assert.deepEqual(d.review.map(r => r.reason), [DOUBT_REVIEW_REASON]);
  });
});
