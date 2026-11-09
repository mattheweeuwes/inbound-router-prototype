import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../src/context';
import { computeDashboard } from '../src/dashboard';
import { resumePending, retryDueLeads, whenIdle } from '../src/pipeline';
import { submit, testCtx } from './helpers';

const START = Date.parse('2026-11-05T15:30:00.000Z');
const SEC = 1000;

/** A context whose pipeline throws at the score stage until the trigger is dropped, on a clock the test moves. */
function failingCtx(over: Parameters<typeof testCtx>[0] = {}) {
  const clock = { now: START };
  const ctx = testCtx({ leadRetryDelayMs: 5 * SEC, now: () => clock.now, ...over });
  ctx.db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF status ON leads WHEN NEW.status = 'scored' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  return { ctx, clock, heal: () => ctx.db.exec('DROP TRIGGER boom') };
}

const row = (ctx: Ctx, id: string) => ({ ...(ctx.db.prepare(`SELECT status, attempts, retry_at, tier, alert_json FROM leads WHERE id = ?`).get(id) as { status: string; attempts: number; retry_at: number | null; tier: string | null; alert_json: string | null }) });
const failures = (ctx: Ctx, id: string) => (ctx.db.prepare(`SELECT note FROM stage_log WHERE lead_id = ? AND stage = 'pipeline' ORDER BY rowid`).all(id) as { note: string }[]).map(r => r.note);

async function retryAt(ctx: Ctx, clock: { now: number }, at: number) {
  clock.now = at;
  const n = retryDueLeads(ctx);
  await whenIdle(ctx);
  return n;
}

describe('a lead whose pipeline throws is retried with backoff', () => {
  it('the first failure schedules a retry and counts as in flight, not failed', async () => {
    const { ctx } = failingCtx();
    const { lead: l } = await submit(ctx, 'calendly_demo');
    assert.deepEqual(row(ctx, l.id), { status: 'retrying', attempts: 1, retry_at: START + 5 * SEC, tier: null, alert_json: null });
    assert.deepEqual(failures(ctx, l.id), ['attempt 1 of 3: disk full']);
    const d = computeDashboard(ctx);
    assert.deepEqual([d.window.failed, d.window.retrying, d.window.inFlight], [0, 1, 1]);
  });

  it('nothing runs before the retry is due; then it runs, and a lead that now succeeds is done', async () => {
    const { ctx, clock, heal } = failingCtx();
    const { lead: l } = await submit(ctx, 'calendly_demo');
    assert.equal(await retryAt(ctx, clock, START + 5 * SEC - 1), 0);
    heal();
    assert.equal(await retryAt(ctx, clock, START + 5 * SEC), 1);
    const r = row(ctx, l.id);
    assert.deepEqual([r.status, r.tier, r.retry_at], ['done', 'A', null]);
    assert.deepEqual(failures(ctx, l.id), ['attempt 1 of 3: disk full'], 'the failed run stays in the log');
    assert.equal(computeDashboard(ctx).window.failed, 0);
  });

  it('after the last attempt the lead is given up, and RevOps gets an alert through the Slack recorder', async () => {
    const { ctx, clock } = failingCtx();
    const { lead: l } = await submit(ctx, 'calendly_demo');
    await retryAt(ctx, clock, START + 5 * SEC);
    assert.deepEqual([row(ctx, l.id).status, row(ctx, l.id).retry_at], ['retrying', START + 15 * SEC], 'the second wait is twice the first');
    await retryAt(ctx, clock, START + 15 * SEC);
    const r = row(ctx, l.id);
    assert.deepEqual([r.status, r.attempts, r.retry_at], ['failed', 3, null]);
    assert.deepEqual(failures(ctx, l.id), ['attempt 1 of 3: disk full', 'attempt 2 of 3: disk full', 'attempt 3 of 3: disk full']);

    const alert = JSON.parse(r.alert_json!).failure;
    assert.equal(alert.channel, '#revops-review');
    assert.match(alert.text, new RegExp(`not processed after 3 attempts: calendly_demo lead ${l.id}`));
    const dir = join(ctx.cfg.outDir, 'slack');
    const recorded = readdirSync(dir).flatMap(f => readFileSync(join(dir, f), 'utf8').trim().split('\n')).map(x => JSON.parse(x));
    assert.ok(recorded.some(x => x.leadId === l.id && x.channel === '#revops-review' && /Last error\*\ndisk full/.test(JSON.stringify(x.blocks).replace(/\\n/g, '\n'))), 'the same recorder as every other alert');

    const d = computeDashboard(ctx);
    assert.deepEqual([d.window.failed, d.window.retrying, d.window.inFlight], [1, 0, 0]);
    assert.equal(await retryAt(ctx, clock, START + 3600 * SEC), 0, 'nothing more is retried');
    assert.equal(resumePending(ctx), 0, 'and boot recovery leaves it alone');
  });

  it('boot recovery picks up a lead with retries left, at once', async () => {
    const { ctx, heal } = failingCtx();
    const { lead: l } = await submit(ctx, 'calendly_demo');
    heal();
    assert.equal(resumePending(ctx), 1);
    await whenIdle(ctx);
    assert.equal(row(ctx, l.id).status, 'done');
  });

  it('the timer retries on its own while the process runs', async () => {
    const ctx = testCtx({ leadRetryDelayMs: 20 });
    ctx.db.exec(`CREATE TRIGGER boom BEFORE UPDATE OF status ON leads WHEN NEW.status = 'scored' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
    const { lead: l } = await submit(ctx, 'calendly_demo');
    assert.equal(row(ctx, l.id).status, 'retrying');
    ctx.db.exec('DROP TRIGGER boom');
    await new Promise(r => setTimeout(r, 120));
    await whenIdle(ctx);
    assert.equal(row(ctx, l.id).status, 'done');
  });
});
