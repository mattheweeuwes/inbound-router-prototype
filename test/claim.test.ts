import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearAppData } from '../src/db';
import { enqueue, whenIdle } from '../src/pipeline';
import { post, submit, testCtx } from './helpers';

const owner = (ctx: ReturnType<typeof testCtx>, accountId: string) => (ctx.db.prepare(`SELECT owner FROM accounts WHERE id = ?`).get(accountId) as any)?.owner ?? null;
const INTER = 'ahrq:SYS-INTERMTN';
const second = { email: 'b1@intermountainhealthcare.org', first: 'Sam', last: 'Other', seed: 'second', ts: '2026-11-05T16:00:00.000Z' };

describe('account claiming: one account, one rep', () => {
  it('a tier-A rep alert claims the account; the next lead from it goes to that rep under R5, not round-robin', async () => {
    const ctx = testCtx();
    const a = await submit(ctx, 'calendly_demo');
    assert.deepEqual([a.lead.route.rule, a.lead.route.owner], ['R8', 'Avery']);
    assert.equal(owner(ctx, INTER), 'Avery');
    const b = await submit(ctx, 'calendly_demo', second);
    assert.deepEqual([b.lead.tier, b.lead.route.rule, b.lead.route.action, b.lead.route.owner], ['A', 'R5', 'rep_alert', 'Avery']);
    assert.equal(b.lead.route.reason, 'Intermountain Health is already owned by Avery from an earlier lead, so it goes to Avery whatever the tier; tier A only sets the response time.');
    assert.ok(b.lead.flags.includes('existing_account'));
    assert.equal(b.lead.account.owner, 'Avery');
    assert.ok(b.lead.account.signals.some((s: any) => s.type === 'claim' && /Avery claimed/.test(s.detail)));
  });

  it('a lower-tier lead from a claimed account becomes a task for the owner, whatever its tier', async () => {
    const ctx = testCtx();
    await submit(ctx, 'calendly_demo');
    const c = await submit(ctx, 'guide_download', { ...second, message: undefined, guide: 'Health System Executive Guide' });
    assert.deepEqual([c.lead.route.rule, c.lead.route.action, c.lead.route.owner], ['R5', 'owner_task', 'Avery']);
  });

  it('the claiming lead\'s company upsert sets hubspot_owner_id; later leads do not repeat it', async () => {
    const ctx = testCtx();
    const a = await submit(ctx, 'calendly_demo');
    const company = (l: any) => l.crm.requests.find((r: any) => r.path.endsWith('/companies/batch/upsert')).body.inputs[0].properties;
    assert.equal(company(a.lead).hubspot_owner_id, '900001');
    const b = await submit(ctx, 'calendly_demo', second);
    assert.equal('hubspot_owner_id' in company(b.lead), false);
  });

  it('a B-tier first lead claims nothing, so the next A lead is round-robined and claims', async () => {
    const ctx = testCtx();
    const b = await submit(ctx, 'guide_download', { message: undefined, guide: 'Health System Executive Guide' });
    assert.equal(b.lead.tier, 'B');
    assert.equal(b.lead.route.action, 'team_queue');
    assert.equal(owner(ctx, INTER), null);
    const a = await submit(ctx, 'calendly_demo', { ...second, email: 'c1@intermountainhealthcare.org' });
    assert.deepEqual([a.lead.route.rule, a.lead.route.owner], ['R8', 'Avery']);
    assert.equal(owner(ctx, INTER), 'Avery');
  });

  it('review, nurture and web-intent signals claim nothing', async () => {
    const ctx = testCtx();
    await submit(ctx, 'calendly_demo', { email: 'lprice@gmail.com', company: 'Baptist Health', state: undefined, message: 'I am benchmarking commercial rates.' });
    await submit(ctx, 'guide_download', { email: 'q@hylant.com', company: 'Hylant', title: 'Benefits Advisor', message: undefined });
    await post(ctx, 'web_intent', { synthetic: true, domain: 'ohiohealth.com', company: 'OhioHealth', visitors: 2, visits: [{ path: '/a', at: '2026-11-05T13:00:00Z' }] });
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM accounts WHERE owner IS NOT NULL`).get() as any).c, 0);
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM account_signals WHERE type = 'claim'`).get() as any).c, 0);
  });

  it('web intent for a claimed account is a research task for the owner, still no alert', async () => {
    const ctx = testCtx();
    await submit(ctx, 'calendly_demo');
    const wi = await post(ctx, 'web_intent', { synthetic: true, domain: 'intermountainhealthcare.org', company: 'Intermountain Health', visitors: 1, visits: [{ path: '/a', at: '2026-11-05T17:00:00Z' }] });
    const d: any = (await import('../src/view')).leadDetail(ctx, wi.json.leadId);
    assert.deepEqual([d.route.action, d.route.owner], ['account_signal', 'Avery']);
    assert.equal(d.alert.slack, null);
  });

  it('the seeded CRM mirror owner beats a DB claim', async () => {
    const ctx = testCtx();
    const first = await submit(ctx, 'calendly_demo', { email: 'rkline@brookmerehealth.example', company: 'Brookmere Health Plan', title: 'Director of Network Management', message: 'We want to compare our fee schedules against competing plans.' });
    assert.deepEqual([first.lead.route.rule, first.lead.route.owner], ['R5', 'Casey']);
    assert.equal(owner(ctx, 'crm:mirror-brookmere'), null, 'a mirror owner is not copied into the claims column');
    ctx.db.prepare(`UPDATE accounts SET owner = 'Taylor' WHERE id = 'crm:mirror-brookmere'`).run(); // a conflicting DB claim
    const next = await submit(ctx, 'calendly_demo', { email: 'zz@brookmerehealth.example', company: 'Brookmere Health Plan', title: 'Director of Network Management', message: 'We want to compare our fee schedules against competing plans.', seed: 'x', ts: '2026-11-05T16:00:00.000Z' });
    assert.deepEqual([next.lead.route.rule, next.lead.route.owner], ['R5', 'Casey']);
    assert.match(next.lead.route.reason, /owned by Casey/);
  });

  it('re-running the claiming lead releases and re-makes its own claim (no self-ownership, no duplicate signals)', async () => {
    const ctx = testCtx();
    const a = await submit(ctx, 'calendly_demo');
    enqueue(ctx, a.json.leadId); await whenIdle(ctx);
    const row = ctx.db.prepare(`SELECT route_json FROM leads WHERE id = ?`).get(a.json.leadId) as any;
    assert.equal(JSON.parse(row.route_json).rule, 'R8', 'still the original R8 decision');
    assert.equal(owner(ctx, INTER), 'Avery');
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM account_signals WHERE type = 'claim'`).get() as any).c, 1);
  });

  it('resetting the demo clears claimed owners with everything else', async () => {
    const ctx = testCtx();
    await submit(ctx, 'calendly_demo');
    assert.equal(owner(ctx, INTER), 'Avery');
    clearAppData(ctx.db);
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM accounts`).get() as any).c, 0);
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) c FROM account_signals`).get() as any).c, 0);
    const again = await submit(ctx, 'calendly_demo', second);
    assert.deepEqual([again.lead.route.rule, again.lead.route.owner], ['R8', 'Avery'], 'a fresh start: round-robin again, not an inherited claim');
  });
});
