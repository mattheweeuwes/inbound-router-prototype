import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import inbound from '../api/inbound';
import { buildPayload } from '../src/payloads';
import { enqueue, ingest, resumePending, whenIdle } from '../src/pipeline';
import { listLeads } from '../src/view';
import { post, spec, submit, testCtx, KEY } from './helpers';
import { adapt, signCalendly, verifyCalendly } from '../src/sources';
import { computeMetrics } from '../src/hygiene';

describe('Calendly signature', () => {
  const body = '{"a":1}';
  it('accepts a good signature', () => assert.equal(verifyCalendly(KEY, body, signCalendly(KEY, body)).ok, true));
  it('rejects a wrong key, a tampered body, a stale timestamp and a missing header', () => {
    assert.equal(verifyCalendly(KEY, body, signCalendly('other', body)).ok, false);
    assert.equal(verifyCalendly(KEY, '{"a":2}', signCalendly(KEY, body)).ok, false);
    assert.equal(verifyCalendly(KEY, body, signCalendly(KEY, body, 1000)).ok, false);
    assert.equal(verifyCalendly(KEY, body, null).ok, false);
    assert.equal(verifyCalendly(KEY, body, 'garbage').ok, false);
  });
  it('the inbound handler returns 401 for unsigned and badly signed Calendly posts, and creates nothing', async () => {
    const ctx = testCtx();
    const payload = buildPayload('calendly_demo', spec());
    assert.equal((await post(ctx, 'calendly_demo', payload, { sign: false })).status, 401);
    assert.equal((await post(ctx, 'calendly_demo', payload, { sign: 'bad' })).status, 401);
    assert.equal(listLeads(ctx).length, 0);
    assert.equal((await post(ctx, 'calendly_demo', payload)).status, 202);
  });
  it('other sources are not signature-gated, and bad input gets a 4xx', async () => {
    const ctx = testCtx();
    assert.equal((await post(ctx, 'guide_download', buildPayload('guide_download', spec()))).status, 202);
    assert.equal((await post(ctx, 'guide_download', { fields: {} })).status, 422);
    const bad = await inbound(new Request('http://local/api/inbound?source=nope', { method: 'POST', body: '{}' }), ctx);
    assert.equal(bad.status, 400);
  });
});

describe('idempotency and contact dedupe', () => {
  it('a re-delivered webhook returns 200 duplicate and does nothing else', async () => {
    const ctx = testCtx();
    const payload = buildPayload('calendly_demo', spec());
    const first = await post(ctx, 'calendly_demo', payload);
    const again = await post(ctx, 'calendly_demo', payload);
    assert.equal(first.status, 202);
    assert.deepEqual([again.status, again.json.duplicate, again.json.leadId], [200, true, first.json.leadId]);
    assert.equal(listLeads(ctx).length, 1);
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM assignments`).get() as any).c, 1, 'no second assignment');
    assert.equal(listLeads(ctx)[0].flags.includes('idempotent_replay'), true);
    assert.equal(computeMetrics(ctx).hygiene.idempotentReplays, 1);
  });

  it('the same contact within 30 days attaches to the first lead, keeps the owner and does not alert again', async () => {
    const ctx = testCtx();
    const first = await submit(ctx, 'calendly_demo', { ts: '2026-11-04T14:47:00.000Z', seed: 'a' });
    assert.equal(first.lead.route.action, 'rep_alert');
    const second = await submit(ctx, 'guide_download', { ts: '2026-11-06T15:20:00.000Z', message: undefined, guide: 'Health System Executive Guide', seed: 'b' });
    assert.equal(second.lead.route.action, 'attach_to_existing');
    assert.equal(second.lead.route.owner, first.lead.route.owner);
    assert.equal(second.lead.dedupe.duplicateOf, first.json.leadId);
    assert.equal(second.lead.dedupe.priorTouches, 1);
    assert.equal(second.lead.alert.slack, null, 'a B-tier repeat touch does not alert');
    assert.ok(second.lead.score.items.some((i: any) => i.label.startsWith('Repeat engagement')), 'earns repeat-engagement points');
    assert.ok(second.lead.crm.requests.some((r: any) => r.path.endsWith('/contacts/batch/upsert')), 'the touch still lands in the CRM');
    assert.equal(second.lead.crm.requests.some((r: any) => r.path.endsWith('/tasks')), false, 'but creates no task');
    assert.equal(computeMetrics(ctx).hygiene.duplicatesMerged, 1);
  });

  it('outside the 30-day window it is a new lead', async () => {
    const ctx = testCtx();
    await submit(ctx, 'calendly_demo', { ts: '2026-09-01T14:47:00.000Z', seed: 'a' });
    const later = await submit(ctx, 'calendly_demo', { ts: '2026-11-06T15:20:00.000Z', seed: 'b' });
    assert.notEqual(later.lead.route.action, 'attach_to_existing');
  });
});

describe('a guide download that only went to nurture', () => {
  const guide = { ts: '2026-11-04T14:47:00.000Z', title: 'Talent Acquisition Specialist', message: undefined, guide: 'Health System Executive Guide', seed: 'g' };

  it('does not swallow the demo request that follows: the demo is routed normally, with a rep alert and a CRM task', async () => {
    const ctx = testCtx();
    const first = await submit(ctx, 'guide_download', guide);
    assert.deepEqual([first.lead.route.action, first.lead.route.owner], ['nurture', 'Marketing (Sam)'], 'the guide went to Marketing nurture');
    const demo = await submit(ctx, 'calendly_demo', { ts: '2026-11-06T15:20:00.000Z', seed: 'd' });
    assert.notEqual(demo.lead.route.action, 'attach_to_existing');
    assert.equal(demo.lead.route.action, 'rep_alert');
    assert.equal(demo.lead.route.rule, 'R10', 'Intermountain is an enterprise account (decision 25)');
    assert.notEqual(demo.lead.route.owner, 'Marketing (Sam)');
    assert.equal(demo.lead.dedupe.duplicateOf, null);
    assert.equal(demo.lead.dedupe.priorTouches, 1, 'the guide still counts as a prior touch');
    assert.ok(demo.lead.score.items.some((i: any) => i.label.startsWith('Repeat engagement')), 'and still earns the scoring points');
    assert.ok(demo.lead.alert.slack, 'the rep is alerted');
    assert.ok(demo.lead.crm.requests.some((r: any) => r.path.endsWith('/tasks')), 'and a CRM task is created');
  });

  it('a bare demo request after it is also routed to sales, not attached to Marketing', async () => {
    const ctx = testCtx();
    await submit(ctx, 'guide_download', guide);
    const demo = await submit(ctx, 'calendly_demo', { ts: '2026-11-06T15:20:00.000Z', seed: 'd', title: 'Talent Acquisition Specialist', message: undefined });
    assert.ok(['rep_alert', 'team_queue'].includes(demo.lead.route.action), demo.lead.route.action);
    assert.notEqual(demo.lead.route.owner, 'Marketing (Sam)');
    assert.equal(demo.lead.dedupe.duplicateOf, null);
  });

  it('demo then guide still attaches to the demo and keeps its owner (unchanged)', async () => {
    const ctx = testCtx();
    const demo = await submit(ctx, 'calendly_demo', { ts: '2026-11-04T14:47:00.000Z', seed: 'a' });
    const later = await submit(ctx, 'guide_download', { ts: '2026-11-06T15:20:00.000Z', message: undefined, guide: 'Health System Executive Guide', seed: 'b' });
    assert.equal(later.lead.route.action, 'attach_to_existing');
    assert.equal(later.lead.route.owner, demo.lead.route.owner);
    assert.equal(later.lead.dedupe.duplicateOf, demo.json.leadId);
  });
});

describe('end to end on the mini registry', () => {
  it('a strong lead resolves on domain, scores A, alerts a rep and builds the dry-run payloads', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { utm: { source: 'LinkedIn ', medium: 'Paid-Social', campaign: 'hs-contracting-q4' } });
    assert.equal(lead.status, 'done');
    assert.deepEqual([lead.resolution.method, lead.resolution.segment, lead.resolution.accountId], ['org_domain', 'health_system', 'ahrq:SYS-INTERMTN']);
    assert.equal(lead.qualification.final.useCase, 'contract_negotiation');
    assert.equal(lead.qualification.final.urgency, 'now');
    assert.equal(lead.qualification.combineVersion, 'v4');
    assert.deepEqual(lead.qualification.final.sources, { useCase: 'rules', urgency: 'rules', buyingRole: 'rules', disqualifier: 'rules' });
    assert.deepEqual([lead.tier, lead.route.action, lead.route.team, lead.route.owner, lead.route.rule], ['A', 'rep_alert', 'HSP', 'Avery', 'R10']);
    assert.equal(lead.normalized.utmFixes.length, 2);
    assert.equal(lead.normalized.channel, 'paid_social');
    assert.equal(lead.crm.mode, 'dry_run');
    assert.equal(lead.alert.slack.dryRun, true);
    assert.match(lead.alert.slack.blocks[1].fields[1].text, /AHRQ health system, 33 hospitals/);
    for (const k of ['normalize', 'resolve', 'qualify', 'score', 'route', 'crm', 'notify', 'total']) assert.equal(typeof lead.timings[k], 'number', k);
    assert.ok(lead.timeToRouteMs >= lead.timings.queued, 'time to route runs from receipt, so it includes the queue wait');
    assert.ok(lead.timings.total >= lead.timeToRouteMs);
    assert.equal(lead.synthetic, true);
    // the dry-run payloads are on disk
    const dir = join(ctx.cfg.outDir, 'hubspot');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(readFileSync(join(dir, files[0]), 'utf8').includes('contacts/batch/upsert'));
  });

  it('round-robins A leads inside a team and never gives two reps one account', async () => {
    const ctx = testCtx();
    const a = await submit(ctx, 'calendly_demo', { email: 'a1@intermountainhealthcare.org', seed: '1', ts: '2026-11-05T15:00:00.000Z' });
    const b = await submit(ctx, 'calendly_demo', { email: 'b1@ohiohealth.com', company: 'OhioHealth', seed: '2', ts: '2026-11-05T15:10:00.000Z' });
    const c = await submit(ctx, 'calendly_demo', { email: 'c1@intermountainhealthcare.org', seed: '3', ts: '2026-11-05T15:20:00.000Z' });
    assert.deepEqual([a.lead.route.owner, b.lead.route.owner, c.lead.route.owner], ['Avery', 'Jordan', 'Avery']);
  });

  it('an ambiguous free-mail company goes to review with candidates, and is not guessed', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { email: 'lprice@gmail.com', company: 'Baptist Health', state: undefined, message: 'I am benchmarking commercial rates.' });
    assert.equal(lead.resolution.status, 'ambiguous');
    assert.deepEqual([lead.route.rule, lead.route.action, lead.route.owner], ['R6', 'review', 'RevOps']);
    assert.ok(lead.review.candidates.length >= 3);
    assert.ok(lead.flags.includes('review') && lead.flags.includes('free_mail'));
    assert.equal(lead.account, null, 'no account is created from a guess');
  });

  it('a disposable address is dropped with no CRM write', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'guide_download', { email: 'xk29@mailinator.com', first: 'asdf', last: 'qwer', company: 'zzzz', title: undefined, message: 'Make money with crypto! https://example.invalid/win' });
    assert.deepEqual([lead.route.rule, lead.route.action, lead.tier], ['R1', 'drop', 'X']);
    assert.deepEqual(lead.crm.requests, []);
    assert.equal(computeMetrics(ctx).hygiene.spamDropped, 1);
  });

  it('a competitor is flagged and not promoted in the CRM', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'sample_signup', { email: 'lfoster@turquoise.health', first: 'Liam', last: 'Foster', title: 'Product Analyst', company: 'Turquoise Health', message: undefined });
    assert.deepEqual([lead.route.action, lead.tier], ['competitor_flag', 'X']);
    assert.ok(lead.flags.includes('competitor'));
    const contact = lead.crm.requests.find((r: any) => r.path.endsWith('/contacts/batch/upsert'));
    assert.equal('lifecyclestage' in contact.body.inputs[0].properties, false);
  });

  it('web intent creates no person lead: it raises the account, and the next lead from that account scores higher', async () => {
    const ctx = testCtx();
    const wi = await post(ctx, 'web_intent', { synthetic: true, domain: 'ohiohealth.com', company: 'OhioHealth', visitors: 2, window_days: 7, visits: [{ path: '/p/signal', at: '2026-11-05T13:00:00Z' }, { path: '/blog/x', at: '2026-11-05T13:05:00Z' }] });
    const w: any = (await import('../src/view')).leadDetail(ctx, wi.json.leadId);
    assert.deepEqual([w.person, w.route.action, w.route.rule], [null, 'account_signal', 'R9']);
    assert.equal(w.alert.slack, null, 'never a rep alert');
    const lead = (await submit(ctx, 'guide_download', { email: 'x@ohiohealth.com', company: 'OhioHealth', message: undefined, title: 'Director, Payer Strategy', ts: '2026-11-05T15:00:00.000Z' })).lead;
    assert.equal(lead.score.items.find((i: any) => i.label.startsWith('Account intent'))?.points, 6);
    // OhioHealth (15 hospitals) is an enterprise account, so this tier-B lead goes to a named rep under R10 and claims it
    assert.deepEqual(lead.account.signals.map((s: any) => s.type).sort(), ['claim', 'web_intent']);
  });

  it('a lead received after hours is flagged, and a tier-A SLA starts at the next business open', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { ts: '2026-11-07T02:12:00.000Z' });
    assert.ok(lead.flags.includes('after_hours'));
    assert.equal(lead.tier, 'A');
    assert.equal(lead.route.slaDueAt, '2026-11-09T14:05:00.000Z');
  });

  it('an existing account owner beats round robin (R5)', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { email: 'rkline@brookmerehealth.example', company: 'Brookmere Health Plan', title: 'Director of Network Management', message: 'We want to compare our fee schedules against competing plans before a 2027 strategy session.' });
    assert.deepEqual([lead.route.rule, lead.route.owner, lead.route.team], ['R5', 'Casey', 'PLS']);
    assert.ok(lead.flags.includes('existing_account'));
  });
});

// These run with the model before the route for every free-text lead (MODEL_BEFORE_ROUTE=all), the path whose guard rails they
// check. test/model-path.test.ts covers the gated default, where the same answers arrive as a second opinion after the alert.
describe('qualification degrades safely', () => {
  it('with Ollama down the lead still routes on rules and says why', async () => {
    const ctx = testCtx({ llmProvider: 'ollama', modelBeforeRoute: 'all' }, async () => { throw new TypeError('fetch failed: ECONNREFUSED'); });
    const { lead } = await submit(ctx, 'calendly_demo');
    assert.equal(lead.status, 'done');
    assert.equal(lead.qualification.llm, null);
    assert.match(lead.qualification.fallbackReason, /llm_unavailable/);
    assert.equal(lead.qualification.final.useCase, 'contract_negotiation');
    assert.equal(lead.route.action, 'rep_alert');
  });
  it('a model-only disqualifier below 0.8 confidence sends the lead to review instead of dropping it', async () => {
    const body = { message: { content: JSON.stringify({ reasons: 'sounds like a pitch', use_case: 'vendor_pitch', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'vendor_pitch', confidence: 0.7 }) } };
    const ctx = testCtx({ llmProvider: 'ollama', modelBeforeRoute: 'all' }, async () => new Response(JSON.stringify(body), { status: 200 }));
    const { lead } = await submit(ctx, 'calendly_demo', { message: 'We would like to talk about a partnership with your team.' });
    assert.equal(lead.qualification.final.disqualifier, 'none');
    assert.equal(lead.qualification.reviewReason, 'llm_only_disqualifier');
    assert.deepEqual([lead.route.rule, lead.route.action], ['R6', 'review']);
    assert.equal(lead.review.reason, 'llm_only_disqualifier');
  });
  it('a model-only spam or vendor-pitch call goes to RevOps review even at high confidence, and is not dropped', async () => {
    for (const d of ['spam', 'vendor_pitch'] as const) {
      const body = { message: { content: JSON.stringify({ reasons: 'reads like one', use_case: 'other', urgency: 'unknown', buying_role: 'unknown', disqualifier: d, confidence: 0.95 }) } };
      const ctx = testCtx({ llmProvider: 'ollama', modelBeforeRoute: 'all' }, async () => new Response(JSON.stringify(body), { status: 200 }));
      const { lead } = await submit(ctx, 'calendly_demo', { message: 'We would like to talk about a partnership with your team.' });
      assert.equal(lead.qualification.final.disqualifier, 'none', d);
      assert.equal(lead.qualification.reviewReason, 'llm_only_disqualifier', d);
      assert.deepEqual([lead.route.rule, lead.route.action, lead.route.owner], ['R6', 'review', 'RevOps'], d);
      assert.equal(lead.review.reason, 'llm_only_disqualifier', d);
      assert.ok(lead.crm.requests.length > 0, `${d}: it is written to the CRM, not dropped`);
    }
  });
  it('a model disqualifier at 0.8 or above counts, a low-confidence classification falls back to rules', async () => {
    const mk = (o: object) => testCtx({ llmProvider: 'ollama', modelBeforeRoute: 'all' }, async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ reasons: 'r', use_case: 'other', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'none', confidence: 0.9, ...o }) } }), { status: 200 }));
    const hi = (await submit(mk({ disqualifier: 'job_seeker', confidence: 0.9 }), 'calendly_demo', { message: 'x'.repeat(10) })).lead;
    assert.equal(hi.qualification.final.disqualifier, 'job_seeker');
    assert.equal(hi.route.action, 'careers');
    const lo = (await submit(mk({ use_case: 'job_seeker', confidence: 0.4 }), 'calendly_demo')).lead;
    assert.equal(lo.qualification.final.useCase, 'contract_negotiation', 'rules win under 0.6');
    assert.match(lo.qualification.fallbackReason, /low_confidence/);
  });
  it('invalid model JSON is retried once, then falls back', async () => {
    let calls = 0;
    const ctx = testCtx({ llmProvider: 'ollama', modelBeforeRoute: 'all' }, async () => { calls++; return new Response(JSON.stringify({ message: { content: 'not json' } }), { status: 200 }); });
    const { lead } = await submit(ctx, 'calendly_demo');
    assert.equal(calls, 2);
    assert.match(lead.qualification.fallbackReason, /llm_invalid_output/);
  });
  it('the model is never called for a lead with no free text', async () => {
    let calls = 0;
    const ctx = testCtx({ llmProvider: 'ollama', modelBeforeRoute: 'all' }, async () => { calls++; throw new Error('should not be called'); });
    await submit(ctx, 'guide_download', { message: undefined, guide: 'Health System Executive Guide' });
    assert.equal(calls, 0);
  });
});

describe('restart recovery', () => {
  it('leads accepted but unfinished are processed again at boot', async () => {
    const ctx = testCtx();
    const payload = buildPayload('guide_download', spec({ message: undefined }));
    const r = await post(ctx, 'guide_download', payload);
    // simulate a crash after the 202: roll the lead back to 'received' and wipe its derived data
    ctx.db.prepare(`UPDATE leads SET status = 'received', route_json = NULL, tier = NULL WHERE id = ?`).run(r.json.leadId);
    assert.equal(resumePending(ctx), 1);
    await whenIdle(ctx);
    const row = ctx.db.prepare(`SELECT status, tier FROM leads WHERE id = ?`).get(r.json.leadId) as any;
    assert.equal(row.status, 'done');
    assert.ok(row.tier);
    enqueue(ctx, r.json.leadId); await whenIdle(ctx); // re-running is harmless
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM leads`).get() as any).c, 1);
  });
});

describe('a new lead is written in one transaction', () => {
  it('a failure on the leads insert leaves no lead_events row behind, and the delivery can be accepted afterwards', async () => {
    const ctx = testCtx();
    const ev = adapt('guide_download', buildPayload('guide_download', spec({ message: undefined })));
    ctx.db.exec(`CREATE TRIGGER fail_lead BEFORE INSERT ON leads BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    assert.throws(() => ingest(ctx, ev), /disk full/);
    const rows = (t: string) => (ctx.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c as number;
    assert.equal(rows('lead_events'), 0, 'the event insert was rolled back with it');
    assert.equal(rows('leads'), 0);
    ctx.db.exec('DROP TRIGGER fail_lead');
    const r = ingest(ctx, ev);
    assert.equal(r.duplicate, false, 'the same delivery is a new event, not blocked by a half-written one');
    await whenIdle(ctx);
    assert.equal(rows('lead_events'), 1);
    assert.equal(rows('leads'), 1);
  });
});

describe('idempotency keys never depend on the server clock', () => {
  const NO_STAMP: Record<string, (p: any) => void> = {
    guide_download: p => { delete p.submitted_at; },
    signal_ask_waitlist: p => { delete p.submitted_at; },
    sample_signup: p => { delete p.signed_up_at; },
    marketplace: p => { delete p.received_at; },
    api_key: p => { delete p.created_at; },
    event_scan: p => { delete p.scanned_at; },
  };
  const webIntent = () => ({ synthetic: true, domain: 'sutterhealth.org', company: 'Sutter Health', visitors: 2, visits: [{ path: '/a' }, { path: '/b' }] });
  const payloads: [string, () => any][] = [
    ...Object.entries(NO_STAMP).map(([source, strip]): [string, () => any] => [source, () => { const p: any = buildPayload(source as any, spec()); strip(p); return p; }]),
    ['web_intent', webIntent],
  ];

  for (const [source, make] of payloads) {
    it(`${source}: the same body with no timestamp is a duplicate whenever it arrives`, async () => {
      let clock = Date.parse('2026-11-05T15:00:00.000Z');
      const ctx = testCtx({ now: () => clock });
      const first = await post(ctx, source as any, make());
      clock += 3_600_000; // an hour later
      const again = await post(ctx, source as any, make());
      assert.equal(first.status, 202);
      assert.deepEqual([again.status, again.json.duplicate, again.json.leadId], [200, true, first.json.leadId]);
      assert.equal(listLeads(ctx).length, 1);
    });

    it(`${source}: the key is a SHA-256 of the canonical body, so key order does not matter and a different body is a different event`, () => {
      const p = make();
      const a = adapt(source as any, p, '2026-11-05T15:00:00.000Z').sourceEventId;
      const b = adapt(source as any, Object.fromEntries(Object.entries(p).reverse()), '2027-01-01T00:00:00.000Z').sourceEventId;
      assert.match(a, /^[0-9a-f]{64}$/);
      assert.equal(a, b);
      assert.notEqual(adapt(source as any, { ...p, extra: 1 }, '2026-11-05T15:00:00.000Z').sourceEventId, a);
    });
  }

  it('with a timestamp the key is unchanged: it follows the fields and that timestamp, not the body or the clock', () => {
    const p: any = buildPayload('guide_download', spec());
    const a = adapt('guide_download', p, '2026-11-05T15:00:00.000Z').sourceEventId;
    assert.match(a, /^[0-9a-f]{20}$/);
    assert.equal(adapt('guide_download', { ...p, page_url: 'https://example.org/other' }, '2027-01-01T00:00:00.000Z').sourceEventId, a);
    assert.notEqual(adapt('guide_download', { ...p, submitted_at: '2026-11-05T15:00:01.000Z' }, '2026-11-05T15:00:00.000Z').sourceEventId, a);
  });
});
