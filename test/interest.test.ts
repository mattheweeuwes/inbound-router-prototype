// Feature interest from inbound (decision 30): what each cue finds, how a lead is tagged as it is committed, the start-up backfill,
// migration 009 on a database that already holds features, and what GET /api/attribution serves per feature.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import attribution from '../api/attribution';
import { ROOT } from '../src/config';
import { migrate } from '../src/db';
import { backfillInterest } from '../src/interest/tag';
import { interestTags, normalizePath, type CueSource } from '../src/interest/cues';
import { QUOTE_CHARS } from '../src/interest/view';
import type { Source } from '../src/schema';
import { FEATURE_CUES } from '../src/usage/taxonomy';
import { spec, submit, testCtx } from './helpers';

const ev = (source: Source, over: Partial<CueSource> = {}): CueSource => ({ source, message: null, context: {}, ...over });
const tags = (e: CueSource) => interestTags(e).map(t => `${t.feature}:${t.cue}`);

describe('interest cues', () => {
  it('the Signal Ask waitlist door is interest in Signal Ask, whatever the message says', () => {
    assert.deepEqual(tags(ev('signal_ask_waitlist')), ['signal_ask:door']);
  });

  it('an API key is interest in the product it was made for', () => {
    assert.deepEqual(tags(ev('api_key', { context: { product: 'api' } })), ['api:door']);
    assert.deepEqual(tags(ev('api_key', { context: { product: 'MCP' } })), ['mcp:door']);
    assert.deepEqual(tags(ev('api_key', { context: { product: 'something-else' } })), []);
    assert.deepEqual(tags(ev('marketplace', { context: { product: 'api' } })), [], 'the product only counts on the API key door');
  });

  it('the benefits playbook points at Network benchmarking; the data-quality guide points at nothing', () => {
    assert.deepEqual(tags(ev('guide_download', { context: { formId: 'gd_cost_intelligence', guide: 'Cost Intelligence Playbook for Benefits Advisors' } })), ['network_benchmarking:guide']);
    const quality = ev('guide_download', { context: { formId: 'gd_data_quality', guide: 'Definitive Guide to Data Quality' } });
    assert.deepEqual(tags(quality), [], 'a guide about the quality of price data is not the provider quality add-on');
    for (const cues of Object.values(FEATURE_CUES)) assert.ok(!cues.guides.includes('gd_data_quality'));
  });

  it('an account-level visit to a feature page is interest, with the pages and how many visits as evidence', () => {
    const visits = ['/platform/products/network-benchmarking/', '/pricing/', '/platform/products/network-benchmarking?utm=x', '/platform/products/signal/'].map(path => ({ path }));
    const found = interestTags(ev('web_intent', { context: { visits } }));
    assert.deepEqual(found.map(t => [t.feature, t.cue, t.evidence]), [
      ['signal_search', 'path', '/platform/products/signal/: 1 visit'],
      ['network_benchmarking', 'path', '/platform/products/network-benchmarking/, /platform/products/network-benchmarking?utm=x: 2 visits'],
    ]);
  });

  it('a path fragment matches whole path segments: the Signal page is not the Signal Ask page', () => {
    assert.deepEqual(tags(ev('web_intent', { context: { visits: [{ path: '/platform/products/signal-ask/' }] } })), ['signal_ask:path']);
    assert.equal(normalizePath('/A/B?x=1#y'), '/a/b/');
  });

  it('a feature named in the message counts, whole-word and in any case; a topic word does not', () => {
    assert.deepEqual(tags(ev('calendly_demo', { message: 'Looking at NETWORK   benchmarking ahead of renewals.' })), ['network_benchmarking:message']);
    assert.deepEqual(tags(ev('calendly_demo', { message: 'We need service-line benchmarks against peer systems.' })), [], 'benchmarks alone is not the feature');
    assert.deepEqual(tags(ev('calendly_demo', { message: 'A rapid rollout, via apis maybe.' })), [], 'api is not matched inside a longer word');
    assert.deepEqual(tags(ev('calendly_demo', { message: 'Does the API cover all payers? Also curious about Signal Watch.' })), ['signal_watch:message', 'api:message']);
  });

  it('the door and the words are two cues for one feature, each kept with its evidence', () => {
    const t = interestTags(ev('signal_ask_waitlist', { message: 'Would Signal Ask cover out-of-network exposure?' }));
    assert.deepEqual(t.map(x => [x.cue, x.evidence]), [['message', '"signal ask"'], ['door', 'signal_ask_waitlist door']]);
  });
});

describe('interest tags on a committed lead', () => {
  it('stores the tags as the lead is committed and marks it looked at', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'signal_ask_waitlist', { message: 'Would Signal Ask cover our out-of-network exposure?' });
    const rows = ctx.db.prepare(`SELECT feature, cue FROM lead_interest WHERE lead_id = ? ORDER BY cue`).all(lead.id) as { feature: string; cue: string }[];
    assert.deepEqual(rows.map(r => `${r.feature}:${r.cue}`), ['signal_ask:door', 'signal_ask:message']);
    assert.ok((ctx.db.prepare(`SELECT interest_tagged_at AS t FROM leads WHERE id = ?`).get(lead.id) as { t: string | null }).t);
  });

  it('a lead with no cue has no tag rows and is still marked looked at', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { message: 'Our renegotiations start in January.' });
    assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM lead_interest`).get() as { n: number }).n, 0);
    assert.ok((ctx.db.prepare(`SELECT interest_tagged_at AS t FROM leads WHERE id = ?`).get(lead.id) as { t: string | null }).t);
  });

  it('tags change no tier, score or route: the same lead scores the same with and without a feature in its message', async () => {
    const a = await submit(testCtx(), 'calendly_demo', { message: 'Our commercial renegotiations start in January.' });
    const b = await submit(testCtx(), 'calendly_demo', { message: 'Our commercial renegotiations start in January. Network Benchmarking would help.' });
    assert.deepEqual([a.lead.tier, a.lead.route.rule, a.lead.route.team], [b.lead.tier, b.lead.route.rule, b.lead.route.team]);
    assert.equal(a.lead.score.total, b.lead.score.total);
  });
});

describe('the start-up backfill', () => {
  it('tags finished leads that have no tags, once, and a restart finds nothing to do', async () => {
    const ctx = testCtx();
    const one = await submit(ctx, 'signal_ask_waitlist', { message: 'Signal Ask please', email: 'a@intermountainhealthcare.org' });
    await submit(ctx, 'calendly_demo', { message: 'Plain request.', email: 'b@intermountainhealthcare.org', seed: 'other' });
    // a database from before tagging: no tag rows, no marks
    ctx.db.exec(`DELETE FROM lead_interest; UPDATE leads SET interest_tagged_at = NULL`);
    const first = backfillInterest(ctx);
    assert.deepEqual([first.checked, first.tagged], [2, 1]);
    // its door and its words are two cues, so two rows, both on the Signal Ask lead
    assert.deepEqual((ctx.db.prepare(`SELECT lead_id, feature, cue FROM lead_interest ORDER BY cue`).all() as { lead_id: string; feature: string; cue: string }[]).map(r => [r.lead_id, r.feature, r.cue]),
      [[one.lead.id, 'signal_ask', 'door'], [one.lead.id, 'signal_ask', 'message']]);
    assert.deepEqual([backfillInterest(ctx).checked], [0]);
  });

  it('leaves a lead that is not finished to its own commit', async () => {
    const ctx = testCtx();
    ctx.db.prepare(`INSERT INTO lead_events (id, source, source_event_id, received_at, synthetic, raw_json) VALUES ('x', 'signal_ask_waitlist', 'e', '2026-11-05T15:00:00.000Z', 1, '{}')`).run();
    ctx.db.prepare(`INSERT INTO leads (id, status, created_at, updated_at) VALUES ('x', 'received', 't', 't')`).run();
    assert.equal(backfillInterest(ctx).checked, 0);
  });
});

describe('migration 009', () => {
  const dir = mkdtempSync(join(tmpdir(), 'router-m009-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('rebuilds a features table that already holds rows, keeping them as launched', () => {
    const old = join(dir, 'old');
    mkdirSync(old);
    for (const f of readdirSync(join(ROOT, 'sql', 'migrations')).filter(x => x < '009')) copyFileSync(join(ROOT, 'sql', 'migrations', f), join(old, f));
    const db = new DatabaseSync(join(dir, 'app.sqlite'));
    migrate(db, old);
    db.prepare(`INSERT INTO features (feature, label, launched_at, team, preview_of_add_on) VALUES ('api', 'API', '2025-11-03T00:00:00.000Z', 'Platform', NULL)`).run();
    assert.deepEqual(migrate(db, join(ROOT, 'sql', 'migrations')), ['009_feature_interest.sql', '010_review_decisions.sql']);
    assert.deepEqual({ ...(db.prepare(`SELECT feature, status, launched_at FROM features`).get() as object) }, { feature: 'api', status: 'launched', launched_at: '2025-11-03T00:00:00.000Z' });
    // a feature in preview has no launch date, and a launched one must have one
    db.prepare(`INSERT INTO features (feature, label, status, launched_at, team) VALUES ('signal_ask', 'Signal Ask', 'preview', NULL, 'Signal')`).run();
    assert.throws(() => db.prepare(`INSERT INTO features (feature, label, status, launched_at, team) VALUES ('mcp', 'MCP', 'launched', NULL, 'Platform')`).run());
    db.close();
  });
});

describe('interest in GET /api/attribution', () => {
  const usageCtx = () => testCtx({ usageFixtures: join(ROOT, 'fixtures', 'usage') });
  const get = async (ctx: ReturnType<typeof usageCtx>) => (await (await attribution(new Request('http://local/api/attribution'), ctx)).json()) as any;

  it('Signal Ask is a feature in preview with no launch date, with nothing measured since a launch', async () => {
    const f = (await get(usageCtx())).features.find((x: any) => x.feature === 'signal_ask');
    assert.deepEqual([f.status, f.launchedAt, f.daysSinceLaunch, f.adoption.share, f.accountsUsing, f.opportunities.count, f.interest.sinceLaunch], ['preview', null, null, null, 0, 0, null]);
    const all = (await get(usageCtx())).features.map((x: any) => x.feature);
    assert.equal(all.at(-1), 'signal_ask', 'listed after the launched features');
  });

  it('counts people, accounts, sales-ready, tiers and cues, and lists who asked newest first with a cut quote', async () => {
    const ctx = usageCtx();
    const long = `Would Signal Ask cover this? ${'We have many markets to compare. '.repeat(20)}`;
    const a = await submit(ctx, 'signal_ask_waitlist', { email: 'a@brindlewoodhealth.example', first: 'Ada', last: 'Okoye', company: 'Brindlewood Mutual Health', title: 'Director, Provider Network', message: long, ts: '2026-11-04T15:00:00.000Z', seed: 'a' });
    await submit(ctx, 'signal_ask_waitlist', { email: 'b@wrenfieldhealth.example', first: 'Bo', last: 'Lang', company: 'Wrenfield Health', title: 'VP, Payer Strategy', ts: '2026-11-05T15:00:00.000Z', seed: 'b' });
    const f = (await get(ctx)).features.find((x: any) => x.feature === 'signal_ask');
    assert.deepEqual([f.interest.leads, f.interest.accounts, f.interest.byCue], [2, 2, { message: 1, door: 2, path: 0, guide: 0 }]);
    assert.equal(f.interest.salesReady, f.interest.byTier.A + f.interest.byTier.B);
    assert.deepEqual(f.asked.map((x: any) => x.accountName), ['Wrenfield Health', 'Brindlewood Mutual Health'], 'newest first');
    const [wren, brind] = f.asked;
    assert.deepEqual([wren.customer, wren.owner, wren.cue, wren.quote], [true, 'Avery', 'door', null]);
    assert.deepEqual([brind.customer, brind.owner, brind.cue, brind.person, brind.leadId], [true, 'Taylor', 'message', { name: 'Ada Okoye', title: 'Director, Provider Network' }, a.lead.id]);
    assert.ok(brind.quote.length <= QUOTE_CHARS && brind.quote.endsWith('...'), `a ${long.length} character message is cut to ${QUOTE_CHARS}`);
  });

  it('a person who came in twice counts once, and a vendor pitch that names a feature does not count', async () => {
    const ctx = usageCtx();
    const same = { email: 'dup@intermountainhealthcare.org', message: 'Signal Ask sounds useful.' };
    await submit(ctx, 'signal_ask_waitlist', { ...same, ts: '2026-11-04T15:00:00.000Z', seed: '1' });
    await submit(ctx, 'signal_ask_waitlist', { ...same, ts: '2026-11-05T15:00:00.000Z', seed: '2' });
    await submit(ctx, 'calendly_demo', { email: 'seo@rankrocket.example', company: 'RankRocket SEO', title: 'Growth Partner', message: 'We help data companies like Serif with link building. Do you have 15 minutes about Network Benchmarking?', seed: '3' });
    const p = await get(ctx);
    assert.equal(p.features.find((x: any) => x.feature === 'signal_ask').interest.leads, 1);
    assert.equal(p.features.find((x: any) => x.feature === 'network_benchmarking').interest.leads, 0);
  });

  it('says apart that usage and deals are invented and that interest comes from the lead stream', async () => {
    const ctx = usageCtx();
    await submit(ctx, 'signal_ask_waitlist', spec({ seed: 'z' }));
    const s = (await get(ctx)).synthetic;
    assert.match(s.note, /^Usage and deals are invented/);
    assert.deepEqual([s.interest.leads, s.interest.synthetic, s.interest.allSynthetic], [1, 1, true]);
    assert.match(s.interest.note, /lead stream/);
  });
});
