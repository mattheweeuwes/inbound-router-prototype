import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after } from 'node:test';
import qualityHandler from '../api/quality';
import { computeMetrics } from '../src/hygiene';
import { buildPayload } from '../src/payloads';
import { CONTROL_IDS, computeScorecard, toMarkdown, type Control } from '../src/quality';
import { post, spec, submit, testCtx } from './helpers';

const NOW = Date.parse('2026-11-07T06:00:00.000Z');
const byId = (controls: Control[], id: string) => {
  const c = controls.find(x => x.id === id);
  assert.ok(c, `control ${id} exists`);
  return c!;
};

/** Five events, one re-delivery: a rep-alert lead, its repeat contact, a disposable address, an ambiguous company, and a lead with no company. */
async function fixture() {
  const ctx = testCtx();
  const first = spec({ ts: '2026-11-04T14:47:00.000Z', seed: 'q1', utm: { source: 'google', medium: 'cpc', campaign: 'brand' } });
  await post(ctx, 'calendly_demo', buildPayload('calendly_demo', first));
  await submit(ctx, 'guide_download', { ts: '2026-11-06T15:20:00.000Z', seed: 'q2', message: undefined, guide: 'Health System Executive Guide' }); // same contact, no UTM
  await post(ctx, 'calendly_demo', buildPayload('calendly_demo', first)); // re-delivery of event 1
  await submit(ctx, 'guide_download', { email: 'xk29@mailinator.com', first: 'asdf', last: 'qwer', company: 'zzzz', title: undefined, ts: '2026-11-06T16:00:00.000Z', seed: 'q3', message: 'Make money with crypto! https://example.invalid/win' });
  await submit(ctx, 'calendly_demo', { email: 'lprice@gmail.com', first: 'Lee', last: 'Price', company: 'Baptist Health', state: undefined, ts: '2026-11-06T17:00:00.000Z', seed: 'q4', message: 'I am benchmarking commercial rates.' });
  await submit(ctx, 'sample_signup', { email: 'noco@gmail.com', first: 'No', last: 'Company', company: undefined, title: undefined, state: undefined, message: undefined, ts: '2026-11-06T18:00:00.000Z', seed: 'q5' });
  ctx.db.prepare(`UPDATE review_queue SET created_at = '2026-11-06T00:00:00.000Z'`).run();
  return ctx;
}

describe('scorecard shape', () => {
  it('every control has a name, a one-sentence definition naming its grain, and the exact read-only SQL', async () => {
    const ctx = await fixture();
    const sc = computeScorecard(ctx.db, { now: NOW });
    assert.deepEqual(sc.controls.map(c => c.id), CONTROL_IDS);
    assert.equal(new Set(sc.controls.map(c => c.id)).size, sc.controls.length, 'ids are unique');
    for (const c of sc.controls) {
      assert.ok(c.name.trim().length > 0, `${c.id} name`);
      assert.ok(c.definition.trim().length > 20, `${c.id} definition`);
      assert.match(c.definition, new RegExp(`^${c.grain[0].toUpperCase()}${c.grain.slice(1)} grain`), `${c.id} definition states its grain first`);
      assert.ok(c.sql.trim().length > 0, `${c.id} sql`);
      assert.match(c.sql, /^(SELECT|WITH) /, `${c.id} is a read`);
      assert.doesNotMatch(c.sql.replace(/'[^']*'/g, "''"), /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|PRAGMA|ATTACH|VACUUM)\b/i, `${c.id} has no write keyword`);
      assert.doesNotMatch(c.definition, /\u2014/, `${c.id} has no em dash`);
      assert.ok(['count', 'hours', 'ms'].includes(c.unit));
    }
    assert.match(toMarkdown(sc), /\| Control \| Value \| Definition \|/);
  });

  it('is repeatable: two runs on the same data give identical controls', async () => {
    const ctx = await fixture();
    const a = computeScorecard(ctx.db, { now: NOW });
    const b = computeScorecard(ctx.db, { now: NOW });
    assert.deepEqual(a, b);
    assert.deepEqual(computeScorecard(ctx.db, { now: NOW, sinceDays: 2 }), computeScorecard(ctx.db, { now: NOW, sinceDays: 2 }));
  });

  it('writes nothing, and runs on a read-only connection to a file database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quality-ro-'));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const ctx = testCtx({ appDb: join(dir, 'app.sqlite') });
    await submit(ctx, 'calendly_demo', { seed: 'ro' });
    const tables = ['lead_events', 'leads', 'accounts', 'account_signals', 'review_queue', 'stage_log', 'assignments'];
    const counts = () => tables.map(t => (ctx.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c);
    const before = counts();
    const changesBefore = (ctx.db.prepare(`SELECT total_changes() c`).get() as any).c;
    const live = computeScorecard(ctx.db, { now: NOW });
    assert.deepEqual(counts(), before);
    assert.equal((ctx.db.prepare(`SELECT total_changes() c`).get() as any).c, changesBefore, 'no row was touched');
    const ro = new DatabaseSync(join(dir, 'app.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(computeScorecard(ro, { now: NOW }), live);
      assert.throws(() => ro.exec(`DELETE FROM leads`), /readonly|read-only/i, 'the connection really is read-only');
    } finally { ro.close(); }
  });
});

describe('counts on a small fixture', () => {
  it('intake: events, stored-once, replays', async () => {
    const ctx = await fixture();
    const { controls } = computeScorecard(ctx.db, { now: NOW });
    assert.equal(byId(controls, 'events_received').value, 5);
    assert.deepEqual([byId(controls, 'events_stored_once').numerator, byId(controls, 'events_stored_once').denominator], [5, 5]);
    assert.equal(byId(controls, 'idempotent_replays').value, 1);
  });

  it('repeat contacts: one attached, none unlinked', async () => {
    const ctx = await fixture();
    const { controls } = computeScorecard(ctx.db, { now: NOW });
    assert.equal(byId(controls, 'repeat_attached').value, 1);
    const unlinked = byId(controls, 'repeat_not_linked');
    assert.deepEqual([unlinked.value, unlinked.denominator], [0, 1]);
  });

  it('a repeat whose duplicate_of is missing is counted as not linked', async () => {
    const ctx = await fixture();
    ctx.db.prepare(`UPDATE leads SET duplicate_of = NULL WHERE duplicate_of IS NOT NULL`).run();
    const c = byId(computeScorecard(ctx.db, { now: NOW }).controls, 'repeat_not_linked');
    assert.deepEqual([c.value, c.denominator], [1, 1]);
  });

  it('zombie leads: the disposable address is the only drop; nothing else was routed away', async () => {
    const ctx = await fixture();
    const { controls } = computeScorecard(ctx.db, { now: NOW });
    const spam = byId(controls, 'zombie_spam_dropped');
    assert.deepEqual([spam.value, spam.denominator], [1, 5]);
    for (const id of ['zombie_vendor_pitch_dropped', 'zombie_careers', 'zombie_press', 'zombie_competitor']) assert.equal(byId(controls, id).value, 0, id);
  });

  it('review queue: open by reason, nothing resolved, oldest item age in hours', async () => {
    const ctx = await fixture();
    const { controls } = computeScorecard(ctx.db, { now: NOW });
    const open = byId(controls, 'review_open');
    const total = (ctx.db.prepare(`SELECT COUNT(*) c FROM review_queue WHERE resolved = 0`).get() as any).c;
    assert.ok(total >= 1);
    assert.equal(open.value, total);
    assert.equal(open.breakdown!.find(b => b.label === 'ambiguous_company')!.value, 1);
    assert.equal(byId(controls, 'review_resolved').value, 0);
    assert.equal(byId(controls, 'review_oldest_open_hours').value, 30);
    ctx.db.prepare(`UPDATE review_queue SET resolved = 1 WHERE reason = 'ambiguous_company'`).run();
    const after2 = computeScorecard(ctx.db, { now: NOW }).controls;
    assert.equal(byId(after2, 'review_resolved').value, 1);
    assert.equal(byId(after2, 'review_open').value, total - 1);
    ctx.db.prepare(`UPDATE review_queue SET resolved = 1`).run();
    assert.equal(byId(computeScorecard(ctx.db, { now: NOW }).controls, 'review_oldest_open_hours').value, null, 'nothing open means no age');
  });

  it('data-contract gaps per source: one missing UTM source on each door that carried none, one lead with no company', async () => {
    const ctx = await fixture();
    const { controls } = computeScorecard(ctx.db, { now: NOW });
    const utm = byId(controls, 'gap_missing_utm_source');
    assert.deepEqual([utm.value, utm.denominator], [4, 5]);
    assert.deepEqual(utm.breakdown!.map(b => [b.label, b.numerator, b.denominator]), [['calendly_demo', 1, 2], ['guide_download', 2, 2], ['sample_signup', 1, 1]]);
    const company = byId(controls, 'gap_missing_company');
    assert.equal(company.value, 1);
    assert.equal(company.breakdown!.find(b => b.label === 'sample_signup')!.numerator, 1);
    assert.equal(byId(controls, 'gap_missing_email').value, 0);
  });

  it('resolution: methods add up to the resolved count, and the unresolved leads are listed with where they went', async () => {
    const ctx = await fixture();
    const { controls } = computeScorecard(ctx.db, { now: NOW });
    const res = byId(controls, 'resolution_by_method');
    const unresolved = byId(controls, 'unresolved_leads');
    assert.equal(res.breakdown!.reduce((a, b) => a + (b.value ?? 0), 0), res.value);
    assert.equal(res.denominator, 5);
    assert.equal(res.value! + unresolved.value!, 5);
    assert.ok(res.breakdown!.some(b => b.label === 'org_domain'));
    assert.ok(unresolved.breakdown!.some(b => b.label === 'ambiguous / review'));
    const direct = (ctx.db.prepare(`SELECT COUNT(*) c FROM leads WHERE json_extract(resolution_json,'$.status') != 'resolved'`).get() as any).c;
    assert.equal(unresolved.value, direct);
  });

  it('active accounts with no owner: the rep-alert lead claimed its account, so it has an owner', async () => {
    const ctx = await fixture();
    const c = byId(computeScorecard(ctx.db, { now: NOW }).controls, 'accounts_no_owner');
    const active = (ctx.db.prepare(`SELECT COUNT(*) c FROM v_account_scores WHERE leads_30d > 0`).get() as any).c;
    const noOwner = (ctx.db.prepare(`SELECT COUNT(*) c FROM v_account_scores WHERE leads_30d > 0 AND owner IS NULL`).get() as any).c;
    assert.equal(c.denominator, active);
    assert.equal(c.breakdown!.find(b => b.label === 'owner on the account row')!.value, active - noOwner);
    assert.ok(c.value! <= noOwner);
  });

  it('stage failures: zero on a clean run, then one when a stage_log row fails', async () => {
    const ctx = await fixture();
    assert.equal(byId(computeScorecard(ctx.db, { now: NOW }).controls, 'stage_failures').value, 0);
    const id = (ctx.db.prepare(`SELECT id FROM leads LIMIT 1`).get() as any).id;
    ctx.db.prepare(`INSERT INTO stage_log (lead_id, stage, started_at, ms, ok, note) VALUES (?, 'crm', ?, 1, 0, 'boom')`).run(id, '2026-11-06T00:00:00.000Z');
    const c = byId(computeScorecard(ctx.db, { now: NOW }).controls, 'stage_failures');
    assert.equal(c.value, 1);
    assert.equal(c.breakdown!.find(b => b.label === 'crm')!.numerator, 1);
  });

  it('a model-only disqualifier below 0.8 confidence is counted as cleared to review', async () => {
    const body = { message: { content: JSON.stringify({ reasons: 'sounds like a pitch', use_case: 'vendor_pitch', urgency: 'unknown', buying_role: 'unknown', disqualifier: 'vendor_pitch', confidence: 0.7 }) } };
    const ctx = testCtx({ llmProvider: 'ollama' }, async () => new Response(JSON.stringify(body), { status: 200 }));
    await submit(ctx, 'calendly_demo', { message: 'We would like to talk about a partnership with your team.' });
    const c = byId(computeScorecard(ctx.db, { now: NOW }).controls, 'llm_only_to_review');
    assert.deepEqual([c.value, c.denominator], [1, 1]);
    assert.equal(byId(computeScorecard(ctx.db, { now: NOW }).controls, 'review_open').breakdown![0].label, 'llm_only_disqualifier');
  });
});

describe('time to route and the window', () => {
  it('nearest-rank p50 and p90, overall and by tier, equal the cockpit metrics', async () => {
    const ctx = await fixture();
    const ids = (ctx.db.prepare(`SELECT l.id FROM leads l JOIN lead_events e ON e.id = l.id ORDER BY e.received_at`).all() as any[]).map(r => r.id);
    const set = ctx.db.prepare(`UPDATE leads SET tier = ?, time_to_route_ms = ? WHERE id = ?`);
    [['A', 100], ['A', 200], ['A', 300], ['A', 400], ['B', 5000]].forEach(([t, ms], i) => set.run(t as string, ms as number, ids[i]));
    const { controls } = computeScorecard(ctx.db, { now: NOW });
    const p50 = byId(controls, 'time_to_route_p50'), p90 = byId(controls, 'time_to_route_p90');
    assert.equal(p50.value, 300);
    assert.equal(p90.value, 5000);
    assert.deepEqual(p50.breakdown!.map(b => [b.label, b.value, b.n]), [['Tier A', 200, 4], ['Tier B', 5000, 1]]);
    assert.deepEqual(p90.breakdown!.map(b => [b.label, b.value, b.n]), [['Tier A', 400, 4], ['Tier B', 5000, 1]]);
    const m = computeMetrics(ctx).timeToRouteMs;
    assert.deepEqual([m.p50, m.p90], [p50.value, p90.value]);
  });

  it('sinceDays counts back from the newest stored event and narrows event and lead controls only', async () => {
    const ctx = await fixture();
    const all = computeScorecard(ctx.db, { now: NOW });
    const day = computeScorecard(ctx.db, { now: NOW, sinceDays: 1 });
    assert.equal(day.windowStart, '2026-11-05T18:00:00.000Z');
    assert.equal(byId(day.controls, 'events_received').value, 4, 'the 4 November event falls outside');
    assert.equal(byId(day.controls, 'idempotent_replays').value, 0, 'the replay belongs to the 4 November event');
    assert.equal(byId(all.controls, 'events_received').value, 5);
    assert.equal(byId(day.controls, 'review_oldest_open_hours').value, byId(all.controls, 'review_oldest_open_hours').value, 'current-state controls ignore the window');
    assert.throws(() => computeScorecard(ctx.db, { sinceDays: 0 }), /positive/);
  });

  it('an empty database gives zeros and nulls, not errors', () => {
    const ctx = testCtx();
    const { controls } = computeScorecard(ctx.db, { now: NOW });
    assert.equal(byId(controls, 'events_received').value, 0);
    assert.equal(byId(controls, 'time_to_route_p50').value, null);
    assert.equal(byId(controls, 'review_oldest_open_hours').value, null);
    assert.equal(byId(controls, 'accounts_no_owner').value, 0);
  });
});

describe('GET /api/quality', () => {
  it('returns the same scorecard as JSON, read-only', async () => {
    const ctx = await fixture();
    const res = await qualityHandler(new Request('http://local/api/quality'), ctx);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const j: any = await res.json();
    assert.deepEqual(j.controls.map((c: Control) => c.id), CONTROL_IDS);
    assert.equal(j.sinceDays, null);
    assert.equal(j.controls.find((c: Control) => c.id === 'events_received').value, 5);
  });
  it('accepts sinceDays, rejects a bad one, and refuses other methods', async () => {
    const ctx = await fixture();
    const ok: any = await (await qualityHandler(new Request('http://local/api/quality?sinceDays=1'), ctx)).json();
    assert.equal(ok.sinceDays, 1);
    assert.equal(ok.controls.find((c: Control) => c.id === 'events_received').value, 4);
    assert.equal((await qualityHandler(new Request('http://local/api/quality?sinceDays=abc'), ctx)).status, 400);
    assert.equal((await qualityHandler(new Request('http://local/api/quality?sinceDays=-3'), ctx)).status, 400);
    assert.equal((await qualityHandler(new Request('http://local/api/quality', { method: 'POST' }), ctx)).status, 405);
  });
});
