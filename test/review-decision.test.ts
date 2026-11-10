// A person's decision on a review item (decision 33): the pure rules (what a request may ask, what an item takes, the route
// a decision forces, the doubt it clears, the outcome line), then each decision through the real pipeline and the API.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import reviewApi from '../api/review';
import type { Ctx } from '../src/context';
import { computeDashboard } from '../src/dashboard';
import { flushListDigests } from '../src/listDigest';
import { buildPayload, type PayloadSpec } from '../src/payloads';
import { resumePending, whenIdle } from '../src/pipeline';
import {
  allowedDecisions, checkDecision, clearModelDoubt, forcedRoute, outcomeLine, parseReviewRequest, PERSON_RULE, rerunsLead, type ReviewDecision,
} from '../src/review/decision';
import { PERSON_METHOD } from '../src/review/resolution';
import { reviewView } from '../src/review/view';
import type { StoredReviewDecision } from '../src/review/decision';
import type { Candidate, Qualification, Resolution, Route } from '../src/schema';
import { DOUBT_REVIEW_REASON } from '../src/secondOpinion';
import { leadDetail } from '../src/view';
import { post, spec, submit, testCtx } from './helpers';

const AT = '2026-11-10T15:00:00.000Z';
const decision = (over: Partial<ReviewDecision> = {}): ReviewDecision => ({ kind: 'not_for_sales', by: 'Riley', note: null, at: AT, itemReason: 'unresolved_company', account: null, reason: null, ...over });
/** The parts of a lead's detail these tests read (leadDetail parses its JSON columns as unknown). */
interface Lead {
  id: string; status: string; route: Route; resolution: Resolution; qualification: Qualification; score: unknown; crm: { requests: unknown[] };
  review: { reason: string; resolved: boolean; candidates: Candidate[] } | null; decisions: StoredReviewDecision[];
  secondOpinion: { result: { doubt: unknown; followedUp: boolean; clearedBy?: string } };
}
const detail = (ctx: Ctx, id: string) => leadDetail(ctx, id) as unknown as Lead;
/** What the decision route answers: the decision's result, or the refusal. */
interface Answer { error: string; rerun: boolean; finished: boolean; outcome: string; count: number; decided: string[] }
const openCount = (ctx: Ctx) => computeDashboard(ctx).review.length;

/** POSTs to the review API the way the cockpit does. */
async function decide(ctx: Ctx, leadId: string, body: Record<string, unknown>) {
  const res = await reviewApi(new Request(`http://local/api/leads/${encodeURIComponent(leadId)}/review`, { method: 'POST', body: JSON.stringify(body) }), ctx);
  const json = (await res.json()) as Answer;
  await whenIdle(ctx);
  return { status: res.status, json };
}

const BAPTIST: Partial<PayloadSpec> = { email: 'lprice@gmail.com', first: 'Lee', last: 'Price', company: 'Baptist Health', state: undefined, message: 'I am benchmarking commercial rates.' };
const UNKNOWN: Partial<PayloadSpec> = { email: 'ops@harrowgatemills.example', first: 'Pat', last: 'Quill', company: 'Harrowgate Mills', state: 'OH', title: 'Operations Manager', message: 'Send me pricing.' };

describe('the decision rules', () => {
  it('a request names who decides, one decision, and what that decision needs', () => {
    assert.match(String(parseReviewRequest({ decision: 'use_account', by: 'Riley' })), /accountKey is required/);
    assert.match(String(parseReviewRequest({ decision: 'not_a_buyer', by: 'Riley' })), /reason is required/);
    assert.match(String(parseReviewRequest({ decision: 'send_it', by: 'Riley' })), /decision must be one of/);
    assert.match(String(parseReviewRequest({ decision: 'not_for_sales', by: ' ' })), /by is required/);
    assert.deepEqual(parseReviewRequest({ decision: 'not_for_sales', by: ' Riley ', note: ' later ', accountKey: 'ahrq:x' }), { decision: 'not_for_sales', by: 'Riley', note: 'later', accountKey: null, reason: null });
  });

  it('a company item takes an account, nurture or a drop; a doubt item takes buyer or not', () => {
    assert.deepEqual(allowedDecisions('ambiguous_company'), ['use_account', 'not_for_sales', 'not_a_buyer']);
    assert.deepEqual(allowedDecisions('llm_only_disqualifier'), ['is_buyer', 'not_a_buyer']);
    assert.deepEqual(allowedDecisions(DOUBT_REVIEW_REASON), ['is_buyer', 'not_a_buyer']);
    assert.equal(rerunsLead('is_buyer', DOUBT_REVIEW_REASON), false, 'a doubt after the alert closes; the lead stays routed');
    assert.equal(rerunsLead('is_buyer', 'llm_only_disqualifier'), true, 'a held lead runs again without the doubt');
  });

  it('a tie is settled only by its own candidates; an unplaced company by an account something holds', () => {
    const req = { decision: 'use_account' as const, by: 'Riley', note: null, accountKey: 'ahrq:B', reason: null };
    const tie = { itemReason: 'ambiguous_company', at: AT, candidates: [{ accountId: 'ahrq:A', name: 'A' }, { accountId: 'ahrq:B', name: 'B' }], lookup: () => null };
    assert.deepEqual((checkDecision(req, tie) as ReviewDecision).account, { key: 'ahrq:B', name: 'B', from: 'candidate' });
    assert.match(String(checkDecision({ ...req, accountKey: 'ahrq:C' }, tie)), /not one of this item's candidates/);
    const unplaced = { itemReason: 'unresolved_company', at: AT, candidates: [], lookup: (k: string) => (k === 'crm:acme' ? { key: k, name: 'Acme', from: 'crm' as const } : null) };
    assert.equal((checkDecision({ ...req, accountKey: 'crm:acme' }, unplaced) as ReviewDecision).account?.from, 'crm');
    assert.match(String(checkDecision({ ...req, accountKey: 'domain:nowhere.example' }, unplaced)), /not an account in the registry or the CRM/);
    assert.match(String(checkDecision({ ...req, decision: 'is_buyer' }, unplaced)), /company item takes use_account, not_for_sales, not_a_buyer, not is_buyer/);
  });

  it('not for sales forces marketing nurture and not a buyer forces a drop, both under the person rule', () => {
    const n = forcedRoute(decision({ note: 'a vendor list' }), { segment: 'health_system', source: 'event_scan' })!;
    assert.deepEqual([n.action, n.team, n.rule, n.sequence], ['nurture', 'Nurture', PERSON_RULE, 'provider_education']);
    assert.match(n.reason, /^Riley decided in review that this lead is not for sales, so it goes to marketing's provider education nurture track\. Their note: "a vendor list"\.$/);
    const d = forcedRoute(decision({ kind: 'not_a_buyer', reason: 'a student project' }), { segment: 'unknown_org', source: 'calendly_demo' })!;
    assert.deepEqual([d.action, d.owner, d.rule], ['drop', 'unassigned', PERSON_RULE]);
    assert.match(d.reason, /not a buyer \(a student project\)/);
    assert.equal(forcedRoute(decision({ kind: 'use_account' }), { segment: 'health_system', source: 'calendly_demo' }), null, 'the rules route a chosen account');
  });

  it('clearing the doubt drops the review reason and a disqualifier only the model set, and keeps what the model said', () => {
    const cls = { reasons: '', useCase: 'other', urgency: 'unknown', buyingRole: 'unknown', confidence: 0.9 } as const;
    const q: Qualification = {
      provider: 'ollama', promptVersion: 'v', combineVersion: 'v4', latencyMs: 1, fallbackReason: null, agreement: null,
      llm: { ...cls, disqualifier: 'job_seeker' }, rules: { ...cls, disqualifier: 'none' },
      final: { ...cls, disqualifier: 'job_seeker', sources: { useCase: 'rules', urgency: 'rules', buyingRole: 'rules', disqualifier: 'model' } },
      reviewReason: 'llm_only_disqualifier', llmDisqualifier: 'job_seeker',
    };
    const c = clearModelDoubt(q);
    assert.equal(c.reviewReason, null);
    assert.equal(c.final.disqualifier, 'none');
    assert.equal(c.final.sources?.disqualifier, 'rules');
    assert.equal(c.llmDisqualifier, 'job_seeker');
  });

  it('the outcome is one line a person reads at a glance', () => {
    const names = (t: string) => ({ HSP: 'Health Systems & Providers' } as Record<string, string>)[t] ?? t;
    assert.equal(outcomeLine({ action: 'team_queue', team: 'HSP', owner: 'HSP queue', tier: 'B' }, names), 'Routed: tier B, Health Systems & Providers queue');
    assert.equal(outcomeLine({ action: 'rep_alert', team: 'HSP', owner: 'Avery', tier: 'A' }, names), 'Routed: tier A, alert to Avery');
    assert.equal(outcomeLine({ action: 'rep_alert', team: 'HSP', owner: 'Avery', tier: 'A', rule: 'R10' }, names, 'is_buyer'), 'Doubt cleared: stays with Avery');
    assert.equal(outcomeLine({ action: 'nurture', team: 'Nurture', owner: 'Marketing (Sam)', tier: 'D', sequence: 'general' }, names), 'Sent to nurture: general track');
    assert.equal(outcomeLine({ action: 'drop', team: 'Nurture', owner: 'unassigned', tier: 'X' }, names), 'Dropped: not a buyer');
  });
});

describe('a decision through the pipeline', () => {
  it('the Baptist Health tie, resolved to one candidate, is scored and routed like any lead, and leaves the queue', async () => {
    const ctx = testCtx({ demoRoutes: true });
    const { lead } = await submit(ctx, 'calendly_demo', BAPTIST);
    assert.equal(lead.route.action, 'review');
    assert.equal(lead.review.reason, 'ambiguous_company');
    const before = openCount(ctx);
    const pick = lead.resolution.candidates.find((c: { state: string }) => c.state === 'AR');
    const r = await decide(ctx, lead.id, { decision: 'use_account', accountKey: pick.accountId, by: 'Riley', note: 'Arkansas, from the call notes' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.rerun, true);
    assert.equal(r.json.finished, true);
    const after = detail(ctx, lead.id);
    assert.equal(after.resolution.method, PERSON_METHOD);
    assert.equal(after.resolution.accountId, pick.accountId);
    assert.equal(after.resolution.status, 'resolved');
    assert.notEqual(after.route.action, 'review');
    assert.notEqual(after.route.rule, 'R6');
    assert.ok(after.score, 'scored');
    assert.ok(after.crm, 'planned for the CRM');
    assert.match(r.json.outcome, /^Routed: tier [A-D], /);
    assert.equal(openCount(ctx), before - 1, 'the open count drops by one');
    assert.equal(after.review?.resolved, true);
    assert.equal(after.decisions.length, 1);
    assert.deepEqual([after.decisions[0].kind, after.decisions[0].by, after.decisions[0].before.action], ['use_account', 'Riley', 'review']);
    const view = reviewView(ctx);
    assert.ok(!view.open.some(i => i.leadId === lead.id));
    assert.equal(view.decided[0].leadId, lead.id);
    assert.equal(view.decided[0].outcome, r.json.outcome);
    assert.equal(computeDashboard(ctx).matching.guessed, 0, 'a person-chosen account is a match, never a guess');
  });

  it('the choice survives a later re-run (boot recovery) without asking the resolver again', async () => {
    const ctx = testCtx({ demoRoutes: true });
    const { lead } = await submit(ctx, 'calendly_demo', BAPTIST);
    const pick = lead.resolution.candidates[1];
    await decide(ctx, lead.id, { decision: 'use_account', accountKey: pick.accountId, by: 'Riley' });
    const first = detail(ctx, lead.id);
    ctx.db.prepare(`UPDATE leads SET status = 'scored' WHERE id = ?`).run(lead.id); // a crash mid-run
    assert.equal(resumePending(ctx), 1);
    await whenIdle(ctx);
    const again = detail(ctx, lead.id);
    assert.equal(again.resolution.accountId, pick.accountId);
    assert.equal(again.resolution.method, PERSON_METHOD);
    assert.deepEqual([again.route.action, again.route.owner], [first.route.action, first.route.owner]);
    assert.equal(again.decisions.length, 1, 'the decided item outlives the re-run');
    assert.equal(again.review?.resolved, true, 'and no new item is opened');
    const claims = ctx.db.prepare(`SELECT COUNT(*) AS n FROM account_claims WHERE lead_id = ?`).get(lead.id) as { n: number };
    assert.ok(Number(claims.n) <= 1, 'a re-run replaces its claim, never adds one');
  });

  it('a later touch from the same person follows the decided lead to its new owner', async () => {
    const ctx = testCtx({ demoRoutes: true });
    const { lead } = await submit(ctx, 'calendly_demo', { ...BAPTIST, seed: 'first' });
    const { lead: touch } = await submit(ctx, 'calendly_demo', { ...BAPTIST, seed: 'second', ts: '2026-11-05T16:00:00.000Z', message: 'Following up on rates.' });
    assert.equal(touch.route.rule, 'R2');
    assert.equal(touch.route.owner, 'RevOps', 'attached to the lead waiting for a person');
    const r = await decide(ctx, lead.id, { decision: 'use_account', accountKey: lead.resolution.candidates[0].accountId, by: 'Riley' });
    assert.equal(r.status, 200);
    assert.equal(detail(ctx, touch.id).route.owner, detail(ctx, lead.id).route.owner);
  });

  it('an unplaced company sent to nurture goes to marketing under the person rule', async () => {
    const ctx = testCtx({ demoRoutes: true });
    const { lead } = await submit(ctx, 'calendly_demo', UNKNOWN);
    assert.equal(lead.review?.reason, 'unresolved_company');
    const r = await decide(ctx, lead.id, { decision: 'not_for_sales', by: 'Riley' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const after = detail(ctx, lead.id);
    assert.deepEqual([after.route.action, after.route.rule, after.route.owner], ['nurture', PERSON_RULE, 'Marketing (Sam)']);
    assert.match(r.json.outcome, /^Sent to nurture: /);
    assert.equal(after.crm.requests.length > 0, true, 'the nurture contact is planned for the CRM');
  });

  it('not a buyer drops the lead with the reason and writes nothing to the CRM', async () => {
    const ctx = testCtx({ demoRoutes: true });
    const { lead } = await submit(ctx, 'calendly_demo', UNKNOWN);
    const r = await decide(ctx, lead.id, { decision: 'not_a_buyer', by: 'Riley', reason: 'a supplier asking for our pricing' });
    assert.equal(r.status, 200);
    const after = detail(ctx, lead.id);
    assert.equal(after.route.action, 'drop');
    assert.match(after.route.reason, /a supplier asking for our pricing/);
    assert.equal(after.crm.requests.length, 0);
    assert.equal(r.json.outcome, 'Dropped: not a buyer');
  });

  it('an unplaced company can be given an account the registry holds, and a key nothing holds is refused', async () => {
    const ctx = testCtx({ demoRoutes: true });
    const { lead } = await submit(ctx, 'calendly_demo', UNKNOWN);
    const bad = await decide(ctx, lead.id, { decision: 'use_account', accountKey: 'ahrq:NOPE', by: 'Riley' });
    assert.equal(bad.status, 422);
    assert.match(bad.json.error, /not an account in the registry or the CRM/);
    const crm = ctx.mirror[0];
    const ok = await decide(ctx, lead.id, { decision: 'use_account', accountKey: `crm:${crm.id}`, by: 'Riley' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const after = detail(ctx, lead.id);
    assert.equal(after.resolution.accountName, crm.name);
    assert.equal(after.route.rule, 'R5', 'the CRM owner rule applies to the chosen account');
    assert.equal(after.route.owner, crm.owner);
  });

  it('a second decision on a decided item is refused and says who decided', async () => {
    const ctx = testCtx({ demoRoutes: true });
    const { lead } = await submit(ctx, 'calendly_demo', UNKNOWN);
    await decide(ctx, lead.id, { decision: 'not_for_sales', by: 'Riley' });
    const again = await decide(ctx, lead.id, { decision: 'not_a_buyer', by: 'Sam', reason: 'x' });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /already decided \(not for sales\) by Riley/);
  });

  it('a decision on a lead that is mid-run is refused', async () => {
    const ctx = testCtx({ demoRoutes: true });
    const { lead } = await submit(ctx, 'calendly_demo', UNKNOWN);
    ctx.db.prepare(`UPDATE leads SET status = 'routed' WHERE id = ?`).run(lead.id);
    const r = await decide(ctx, lead.id, { decision: 'not_for_sales', by: 'Riley' });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /being processed \(status routed\)/);
    assert.equal(detail(ctx, lead.id).review?.resolved, false, 'nothing was recorded');
  });

  it('the API refuses with the demo actions off, a bad body, a missing lead, and a decision the item does not take', async () => {
    const off = testCtx();
    const { lead: l0 } = await submit(off, 'calendly_demo', UNKNOWN);
    assert.equal((await decide(off, l0.id, { decision: 'not_for_sales', by: 'Riley' })).status, 404);
    const ctx = testCtx({ demoRoutes: true });
    const { lead } = await submit(ctx, 'calendly_demo', UNKNOWN);
    assert.equal((await decide(ctx, lead.id, { decision: 'not_for_sales' })).status, 422);
    assert.equal((await decide(ctx, 'no-such-lead', { decision: 'not_for_sales', by: 'Riley' })).status, 404);
    const wrong = await decide(ctx, lead.id, { decision: 'is_buyer', by: 'Riley' });
    assert.equal(wrong.status, 422);
    const { lead: routed } = await submit(ctx, 'calendly_demo', { seed: 'routed' });
    const none = await decide(ctx, routed.id, { decision: 'not_for_sales', by: 'Riley' });
    assert.deepEqual([none.status, none.json.error], [409, 'this lead has no open review item']);
    const get = await reviewApi(new Request('http://local/api/review/list', { method: 'GET' }), ctx);
    assert.equal(get.status, 405);
  });
});

describe("a decision on the model's doubt", () => {
  type Answer = Record<string, unknown>;
  /** A stand-in for Ollama that always answers the same. */
  const model = (answer: Answer) => (async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ reasons: 'stub', use_case: 'other', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'none', confidence: 0.9, ...answer }) } }), { status: 200 })) as typeof fetch;
  const VENDOR = { use_case: 'vendor_pitch', disqualifier: 'vendor_pitch', confidence: 0.95 };

  it('a held lead cleared as a buyer runs again without the disqualifier and is routed', async () => {
    const ctx = testCtx({ demoRoutes: true, llmProvider: 'ollama', modelBeforeRoute: 'all' }, model(VENDOR));
    const { lead } = await submit(ctx, 'calendly_demo', { message: 'We would like to talk about a partnership with your team.' });
    assert.equal(lead.review?.reason, 'llm_only_disqualifier', 'held before the route');
    const r = await decide(ctx, lead.id, { decision: 'is_buyer', by: 'Riley' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.rerun, true);
    const after = detail(ctx, lead.id);
    assert.notEqual(after.route.action, 'review');
    assert.equal(after.qualification.reviewReason, null);
    assert.equal(after.qualification.llmDisqualifier, 'vendor_pitch', 'what the model said is kept');
  });

  it('a doubt after the alert cleared as a buyer closes the item, re-routes nothing, and is not raised again on a re-run', async () => {
    const ctx = testCtx({ demoRoutes: true, llmProvider: 'ollama' }, model(VENDOR));
    const { lead } = await submit(ctx, 'calendly_demo', {});
    assert.equal(lead.review?.reason, DOUBT_REVIEW_REASON);
    const routeBefore = lead.route;
    const r = await decide(ctx, lead.id, { decision: 'is_buyer', by: 'Riley' });
    assert.equal(r.status, 200);
    assert.equal(r.json.rerun, false);
    assert.equal(r.json.outcome, `Doubt cleared: stays with ${routeBefore.owner}`);
    assert.deepEqual(detail(ctx, lead.id).route, routeBefore);
    ctx.db.prepare(`UPDATE leads SET status = 'notified' WHERE id = ?`).run(lead.id);
    resumePending(ctx);
    await whenIdle(ctx);
    const again = detail(ctx, lead.id);
    assert.ok(again.secondOpinion.result.doubt, 'the model still doubts it, and that is recorded');
    assert.equal(again.secondOpinion.result.followedUp, false);
    assert.equal(again.secondOpinion.result.clearedBy, 'Riley');
    assert.equal(again.review?.resolved, true, 'no new item');
  });

  it('a doubt after the alert ruled not a buyer withdraws the lead', async () => {
    const ctx = testCtx({ demoRoutes: true, llmProvider: 'ollama' }, model(VENDOR));
    const { lead } = await submit(ctx, 'calendly_demo', {});
    const r = await decide(ctx, lead.id, { decision: 'not_a_buyer', by: 'Riley', reason: 'a vendor pitch after all' });
    assert.equal(r.status, 200);
    const after = detail(ctx, lead.id);
    assert.equal(after.route.action, 'drop');
    const claims = ctx.db.prepare(`SELECT COUNT(*) AS n FROM account_claims WHERE lead_id = ?`).get(lead.id) as { n: number };
    assert.equal(Number(claims.n), 0, 'the claim its alert made is released');
  });
});

describe("a list's unplaced rows, all to nurture", () => {
  it('one call sends every open unplaced-company row of the list to nurture and says how many', async () => {
    const clock = { now: Date.parse('2026-11-10T15:00:00.000Z') };
    const ctx = testCtx({ demoRoutes: true, listQuietMs: 5_000, now: () => clock.now });
    const people = ['harrowgatemills', 'tidewaterfreight', 'larkspurhospitality'].map((d, i) => ({ email: `p${i}@${d}.example`, first: `P${i}`, last: 'Quill', company: `${d} Inc`, title: 'Operations Manager', seed: `u${i}` }));
    for (const p of people) await post(ctx, 'event_scan', buildPayload('event_scan', spec({ event: 'HLTH', notes: '', message: undefined, ...p })), { wait: false });
    await post(ctx, 'event_scan', buildPayload('event_scan', spec({ event: 'Other list', notes: '', message: undefined, ...people[0], email: 'x@elsewhere.example', seed: 'o' })), { wait: false });
    await whenIdle(ctx);
    clock.now += 5_000;
    flushListDigests(ctx);
    const res = await reviewApi(new Request('http://local/api/review/list', { method: 'POST', body: JSON.stringify({ list: 'HLTH', by: 'Riley', note: 'booth traffic' }) }), ctx);
    const body = (await res.json()) as Answer;
    await whenIdle(ctx);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.count, 3);
    assert.equal(body.finished, true);
    const view = reviewView(ctx);
    assert.equal(view.open.filter(i => i.list === 'HLTH').length, 0);
    assert.equal(view.open.filter(i => i.list === 'Other list').length, 1, 'another list is left alone');
    for (const id of body.decided) assert.equal(detail(ctx, id).route.action, 'nurture');
    clock.now += 5_000;
    const digests = flushListDigests(ctx);
    assert.deepEqual(digests.map(d => [d.team, d.rows]), [['Nurture', 3]], 'the rows are re-folded into one marketing digest, not posted one by one');
    const again = await reviewApi(new Request('http://local/api/review/list', { method: 'POST', body: JSON.stringify({ list: 'HLTH', by: 'Riley' }) }), ctx);
    assert.equal(again.status, 404, 'nothing left to send');
  });
});
