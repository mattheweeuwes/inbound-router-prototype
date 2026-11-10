// The team brief (src/todayBrief.ts, GET /api/brief): every section present with the ids to open its items, built from what the
// router already holds, and read-only. The scenario test (day.test.ts) reads the full day's brief; this one uses a handful of
// the morning's events so each section's content can be checked exactly.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import briefApi from '../api/brief';
import { ROOT } from '../src/config';
import { BRIEF_SECTIONS, briefText, buildBrief, DEFAULT_WINDOW_HOURS, ITEM_LIMIT, waitText, windowHours, type TodayBrief } from '../src/todayBrief';
import type { Source } from '../src/schema';
import { post, testCtx } from './helpers';

interface DayEvent { id: string; source: Source; payload: unknown }
const FILE = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'day', 'morning.json'), 'utf8')) as { clock: string; events: DayEvent[] };
const CLOCK = Date.parse(FILE.clock);

async function day(ids: string[]) {
  const ctx = testCtx({ now: () => CLOCK, usageFixtures: join(ROOT, 'fixtures', 'usage') });
  for (const id of ids) { const e = FILE.events.find(x => x.id === id)!; await post(ctx, e.source, e.payload); }
  return ctx;
}
const items = (b: TodayBrief, id: typeof BRIEF_SECTIONS[number]) => b.sections[id].items;

describe('the team brief', () => {
  it('has every section, each with a headline and figures, and nothing in the sections that come from leads on an empty database', async () => {
    const b = buildBrief(testCtx({ now: () => CLOCK }));
    assert.deepEqual(Object.keys(b.sections), [...BRIEF_SECTIONS]);
    for (const id of BRIEF_SECTIONS) {
      const s = b.sections[id];
      assert.equal(s.id, id);
      assert.ok(s.title && s.headline, `${id} says what it holds`);
      assert.ok(s.figures.length > 0, `${id} has figures`);
      if (['expansion', 'outbound'].includes(id)) continue; // these read the invented usage fixtures and rate file, not leads
      assert.equal(s.count, 0, `${id} is empty on an empty database`);
      assert.deepEqual(s.items, []);
    }
    assert.match(b.sections.expansion.headline, /not loaded/, 'the test context loads no usage fixtures, and the section says so');
    assert.equal(b.window.hours, DEFAULT_WINDOW_HOURS);
    assert.equal(b.window.to, FILE.clock);
  });

  it('enterprise: an account with its fact, the people in, and the rep', async () => {
    const b = buildBrief(await day(['D01', 'D13']));
    const [first, ...rest] = items(b, 'enterprise');
    assert.equal(rest.length, 0, 'two people at one account are one row');
    assert.equal(first.title, 'CommonSpirit Health');
    assert.match(first.detail, /^\d+ hospitals.*2 people in: Victor Almeida, Helena Marsh\. Rep: Avery\. Best tier A\./);
    assert.equal(first.tab, 'stream');
    assert.equal(first.ids.accountKey, 'ahrq:SYS-COMMONSPIRIT');
    assert.ok(first.ids.leadId, 'the newest lead opens the row');
    assert.deepEqual(b.sections.enterprise.figures.map(f => f.value), [2, 1, 1]);
  });

  it('referrals: who referred whom, whose customer, and the ids to open it', async () => {
    const b = buildBrief(await day(['D01', 'D12']));
    assert.deepEqual(items(b, 'referrals').map(i => i.title), ['Emory Healthcare referred Renee Abernathy at Piedmont Healthcare', 'Wrenfield Health referred Helena Marsh at CommonSpirit Health']);
    const wren = items(b, 'referrals')[1];
    assert.match(wren.detail, /a customer owned by Avery\. Tier A\. A thank-you task for the owner is planned\.$/);
    assert.deepEqual([wren.tab, wren.ids.accountKey], ['stream', 'crm:mirror-wrenfield']);
    assert.deepEqual(b.sections.referrals.figures.map(f => f.value), [2, 1]);
  });

  it('needs a person: review items open in their tab, and the oldest wait is reported', async () => {
    const b = buildBrief(await day(['D10']));
    const [r] = items(b, 'needs_person').filter(i => i.kind === 'review item');
    assert.equal(r.tab, 'review');
    assert.ok(r.ids.leadId);
    assert.match(r.title, /^Dale Pruitt/);
    assert.equal(b.sections.needs_person.figures[0].value, 1);
  });

  it('feature interest this week: who asked, and a feature that has not launched says so', async () => {
    const b = buildBrief(await day(['D02', 'D06', 'D09']));
    const byTitle = Object.fromEntries(items(b, 'interest').map(i => [i.title, i]));
    assert.deepEqual(Object.keys(byTitle).sort(), ['Network benchmarking', 'Signal Ask', 'Signal search']);
    assert.match(byTitle['Signal Ask'].detail, /Newest: Brindlewood Mutual Health \(a customer\), 2026-11-10\. Not launched\./);
    assert.match(byTitle['Network benchmarking'].detail, /^2 people at 2 accounts/);
    assert.deepEqual([byTitle['Signal Ask'].tab, byTitle['Signal Ask'].ids], ['feature-pipeline', { feature: 'signal_ask' }]);
  });

  it('feature interest looks back a week from the clock: an older lead is left out', async () => {
    const ctx = testCtx({ now: () => CLOCK + 8 * 86_400_000, usageFixtures: join(ROOT, 'fixtures', 'usage') });
    const e = FILE.events.find(x => x.id === 'D06')!;
    await post(ctx, e.source, e.payload);
    assert.equal(buildBrief(ctx).sections.interest.count, 0);
  });

  it('expansion signals and outbound come from their own read models, with ids', async () => {
    const b = buildBrief(await day([]));
    assert.deepEqual(items(b, 'expansion').map(i => [i.title, i.tab, i.ids.feature]), [['Brindlewood Mutual Health', 'feature-pipeline', 'quality_preview'], ['Copperleaf Benefit Advisors', 'feature-pipeline', 'quality_preview']]);
    const link = items(b, 'outbound').find(i => i.kind === 'link to confirm')!;
    assert.deepEqual([link.tab, !!link.ids.ein], ['outbound', true]);
    const held = items(b, 'outbound').find(i => i.kind === 'suppressed')!;
    assert.match(held.detail, /Tallowmere/);
    assert.match(b.sections.outbound.headline, /^\d+ drafts? ready \(\d+ Platform, \d+ System gap\)/);
  });

  it('health: a failed lead is listed with its id, and the figures are the dashboard\'s', async () => {
    const ctx = await day(['D02']);
    ctx.db.prepare(`UPDATE leads SET status = 'failed', attempts = 3`).run();
    const b = buildBrief(ctx);
    const failed = items(b, 'health').find(i => i.kind === 'failed lead')!;
    assert.ok(failed.ids.leadId);
    assert.equal(b.sections.health.figures.find(f => f.label === 'Failed or retrying leads')?.value, 1);
  });

  it('caps a long section and says how many it left out', async () => {
    const ctx = testCtx({ now: () => CLOCK });
    const insert = ctx.db.prepare(`INSERT INTO review_queue (lead_id, reason, created_at) VALUES (?, 'x', ?)`);
    for (let i = 0; i < ITEM_LIMIT + 3; i++) insert.run(`lead-${i}`, FILE.clock);
    const s = buildBrief(ctx).sections.needs_person;
    assert.deepEqual([s.count, s.items.length, s.more], [ITEM_LIMIT + 3, ITEM_LIMIT, 3]);
  });

  it('reads and writes nothing: the database is the same after a brief', async () => {
    const ctx = await day(['D01', 'D06']);
    const tables = ['leads', 'accounts', 'lead_interest', 'review_queue', 'crm_outbox', 'stage_log'];
    const counts = () => tables.map(t => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    const before = counts();
    buildBrief(ctx);
    assert.deepEqual(counts(), before);
  });

  it('GET /api/brief takes a window in hours, ignores nonsense, and refuses other methods', async () => {
    const ctx = await day(['D01']);
    const get = async (q = '') => (await (await briefApi(new Request(`http://local/api/brief${q}`), ctx)).json()) as TodayBrief;
    assert.equal((await get('?hours=48')).window.hours, 48);
    // with no window named, the server's setting decides (BRIEF_WINDOW_HOURS), and a named window still wins
    const wide = testCtx({ briefWindowHours: 336 });
    assert.equal(((await (await briefApi(new Request('http://local/api/brief'), wide)).json()) as TodayBrief).window.hours, 336);
    assert.equal(((await (await briefApi(new Request('http://local/api/brief?hours=12'), wide)).json()) as TodayBrief).window.hours, 12);
    assert.equal((await get('?hours=abc')).window.hours, 24);
    assert.equal((await get('?hours=0')).window.hours, 24);
    assert.equal((await get('?hours=99999')).window.hours, 720);
    assert.equal(windowHours(null), 24);
    assert.equal((await briefApi(new Request('http://local/api/brief', { method: 'POST' }), ctx)).status, 405);
  });

  it('prints as plain text with each section, its items and the ids', async () => {
    const brief = buildBrief(await day(['D01', 'D06']));
    const text = briefText(brief);
    for (const id of BRIEF_SECTIONS) assert.match(text, new RegExp(`^${brief.sections[id].title.toUpperCase()}$`, 'm'));
    assert.match(text, /\[enterprise account\] CommonSpirit Health\./);
    assert.match(text, /leadId [0-9a-f-]{36}, accountKey ahrq:SYS-COMMONSPIRIT; stream\)/);
    assert.ok(!text.includes('—'), 'no em dashes');
  });

  it('words a wait the way a person says it', () => {
    assert.deepEqual([0, 59_000, 60_000, 45 * 60_000, 60 * 60_000, 130 * 60_000].map(waitText), ['under a minute', 'under a minute', '1 min', '45 min', '1 h', '2 h 10 min']);
  });
});
