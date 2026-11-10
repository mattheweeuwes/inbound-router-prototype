// The synthetic usage fixtures (fixtures/usage): that they are all invented, load once and reload when changed, tell the story the README
// states, and that the SQL model agrees with the attribution definition written out a second way. Plus the reverse ETL's usage properties.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ROOT } from '../src/config';
import { COMPANY_PROPERTIES, eventsProperty, usageCompanyProperties } from '../src/crm/hubspot';
import type { CrmMirrorEntry } from '../src/schema';
import { INFLUENCE_WINDOW_DAYS } from '../src/usage/attribution';
import { usageRollups } from '../src/usage/rollup';
import { FEATURE_KEYS } from '../src/usage/taxonomy';
import { attributionPayload } from '../src/usage/view';
import { DAY } from './usage-helpers';
import { testCtx } from './helpers';

const FIXTURES = join(ROOT, 'fixtures', 'usage');
const scratch = mkdtempSync(join(tmpdir(), 'usage-fixtures-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const mirror = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'crm-mirror.json'), 'utf8')) as CrmMirrorEntry[];
const shipped = () => testCtx({ usageFixtures: FIXTURES });

/** A copy of the fixture folder to edit. */
function copyFixtures(name: string): string {
  const dir = join(scratch, name);
  cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

describe('usage fixtures: all invented', () => {
  it('every deal and every resolved event is on a fictional CRM mirror account on a reserved .example domain', () => {
    const ctx = shipped();
    const fictional = new Map(mirror.filter(m => m.domains.every(d => d.endsWith('.example'))).map(m => [`crm:${m.id}`, m]));
    assert.equal(fictional.size, 12, 'the three accounts the router already had, and nine more');
    for (const d of ctx.store.usage.deals()) assert.ok(fictional.has(d.accountKey), `${d.id} is on ${d.accountKey}`);
    const keys = ctx.db.prepare(`SELECT DISTINCT account_key AS k FROM usage_events WHERE account_key IS NOT NULL`).all() as { k: string }[];
    for (const { k } of keys) assert.ok(fictional.has(k), k);
    assert.deepEqual(keys.length, 12);
  });
  it('every event, deal and person is flagged synthetic, and every address is on a .example domain', () => {
    const ctx = shipped();
    const totals = ctx.store.usage.eventTotals();
    assert.equal(totals.synthetic, totals.total);
    const deals = ctx.store.usage.dealTotals();
    assert.equal(deals.synthetic, deals.total);
    const events = JSON.parse(readFileSync(join(FIXTURES, 'events.json'), 'utf8')).batch as { distinct_id: string | null; properties: { synthetic?: boolean; $groups?: { company: string } } }[];
    for (const e of events) {
      assert.equal(e.properties.synthetic, true);
      if (e.distinct_id) assert.match(e.distinct_id, /@[a-z0-9.-]+\.example$/);
      if (e.properties.$groups) assert.match(e.properties.$groups.company, /\.example$/);
    }
    for (const d of JSON.parse(readFileSync(join(FIXTURES, 'deals.json'), 'utf8')) as { synthetic: boolean }[]) assert.equal(d.synthetic, true);
  });
  it('a mirror account\'s status matches its deals: a customer has a closed-won base deal, an open opportunity has an open deal and no win', () => {
    const ctx = shipped();
    const deals = ctx.store.usage.deals();
    for (const m of mirror.filter(x => x.domains.every(d => d.endsWith('.example')))) {
      const mine = deals.filter(d => d.accountKey === `crm:${m.id}`);
      if (m.status === 'customer') assert.ok(mine.some(d => d.outcome === 'won' && !d.addOn), `${m.name} is a customer`);
      if (m.status === 'open_opportunity') assert.ok(mine.some(d => d.outcome === null) && !mine.some(d => d.outcome === 'won'), `${m.name} has an open opportunity`);
    }
  });
  it('no event is dated before the launch of the feature it is use of', () => {
    const ctx = shipped();
    const early = ctx.db.prepare(`SELECT COUNT(*) AS n FROM usage_events e JOIN features f ON f.feature = e.feature WHERE e.occurred_at < f.launched_at`).get() as { n: number };
    assert.equal(early.n, 0);
  });
});

describe('usage fixtures: loading', () => {
  it('loads the files through the same adapter as the API, and does nothing on a restart with the same files', () => {
    const appDb = join(scratch, 'restart.sqlite');
    const first = testCtx({ appDb, usageFixtures: FIXTURES });
    assert.deepEqual([first.usage.status, first.usage.features, first.usage.deals, first.usage.events], ['loaded', 7, 22, 427]);
    const second = testCtx({ appDb, usageFixtures: FIXTURES });
    assert.equal(second.usage.status, 'unchanged');
    assert.equal(second.store.usage.eventTotals().total, 427);
  });
  it('a changed file replaces what the earlier load put in, and leaves events posted to the API alone', () => {
    const dir = copyFixtures('changed');
    const appDb = join(scratch, 'changed.sqlite');
    const ctx = testCtx({ appDb, usageFixtures: dir });
    ctx.store.usage.insertEvent({ eventId: 'posted', eventName: 'api_call', feature: 'api', groupKey: null, contactKey: null, occurredAt: '2026-11-01T00:00:00.000Z', synthetic: false }, 'crm:mirror-lumenfold', '2026-11-01T00:00:00.000Z', 'api');
    const deals = JSON.parse(readFileSync(join(dir, 'deals.json'), 'utf8')) as { id: string }[];
    writeFileSync(join(dir, 'deals.json'), JSON.stringify(deals.filter(d => d.id !== 'D-1001')));
    const again = testCtx({ appDb, usageFixtures: dir });
    assert.deepEqual([again.usage.status, again.usage.deals], ['loaded', 21]);
    assert.equal(again.store.usage.deals().some(d => d.id === 'D-1001'), false, 'a deal removed from the file is gone');
    assert.equal(again.store.usage.eventTotals().total, 428, 'the fixture events were replaced, not doubled, and the posted one stayed');
  });
  it('with no folder the fixture rows go and the API says why; a file that cannot be used is refused whole', () => {
    const appDb = join(scratch, 'gone.sqlite');
    testCtx({ appDb, usageFixtures: FIXTURES });
    const off = testCtx({ appDb, usageFixtures: join(scratch, 'nowhere') });
    assert.equal(off.usage.status, 'missing');
    assert.equal(off.store.usage.eventTotals().total, 0);
    assert.equal((attributionPayload(off) as { loaded: boolean }).loaded, false);

    const dir = copyFixtures('broken');
    const deals = JSON.parse(readFileSync(join(dir, 'deals.json'), 'utf8')) as Record<string, unknown>[];
    deals[0].accountKey = 'crm:mirror-not-in-the-crm';
    writeFileSync(join(dir, 'deals.json'), JSON.stringify(deals));
    const bad = testCtx({ usageFixtures: dir });
    assert.equal(bad.usage.status, 'failed');
    assert.match(bad.usage.message, /D-1001: crm:mirror-not-in-the-crm is not an account the router knows/);
    assert.equal(bad.store.usage.dealTotals().total, 0);
  });
  it('refuses a deal whose close and stage disagree, a feature outside the taxonomy and an add-on nobody defined', () => {
    const cases: [string, string, (o: any) => void, RegExp][] = [
      ['deals.json', 'closedat', d => { d[0].closedAt = null; }, /closedAt is set exactly when the stage is closed/],
      ['deals.json', 'backwards', d => { d[0].closedAt = '2020-01-01'; }, /closedAt is before createdAt/],
      ['deals.json', 'stage', d => { d[0].stage = 'maybe'; }, /stage maybe is not one of/],
      ['deals.json', 'addon', d => { d[0].addOn = 'mystery'; }, /addOn mystery is not in addOns/],
      ['features.json', 'taxonomy', f => { f.features[0].feature = 'teleport'; }, /teleport is not in the taxonomy/],
    ];
    for (const [file, name, edit, want] of cases) {
      const dir = copyFixtures(`case-${name}`);
      const parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      edit(parsed);
      writeFileSync(join(dir, file), JSON.stringify(parsed));
      const ctx = testCtx({ usageFixtures: dir });
      assert.equal(ctx.usage.status, 'failed', name);
      assert.match(ctx.usage.message, want, name);
    }
  });
});

describe('usage fixtures: the story', () => {
  it('has the counts the README states, and a few small rates', () => {
    const p = attributionPayload(shipped()) as any;
    assert.deepEqual([p.data.deals.total, p.data.deals.won.count, p.data.deals.lost.count, p.data.deals.open.count, p.data.accounts], [22, 11, 6, 5, 12]);
    assert.deepEqual([p.data.events.total, p.data.events.mapped, p.data.events.unmapped, p.data.events.unresolved], [427, 343, 84, 4]);
    assert.deepEqual(p.data.unmappedByName.map((u: { event: string }) => u.event), ['$pageview', 'export_downloaded']);
    assert.equal(p.synthetic.allSynthetic, true);
    assert.equal(p.features.length, 7, 'six launched features and Signal Ask in preview');
    // nearly every comparison rests on few closed deals, which is the point of showing counts; only the API has five or more on both sides
    assert.deepEqual(p.features.filter((f: any) => !f.winRate.small).map((f: any) => f.feature), ['api']);
    // Signal search was used by nearly everyone, so it is around almost every deal and there is almost nothing to compare it to
    const search = p.features.find((f: any) => f.feature === 'signal_search');
    assert.deepEqual([search.accountsUsing, search.opportunities.count, search.winRate.without.closed], [11, 20, 2]);
  });
  it('lists two expansion signals: Brindlewood with five uses and Copperleaf with three, and not the near misses', () => {
    const p = attributionPayload(shipped()) as any;
    assert.deepEqual(p.expansion.signals.map((s: any) => [s.account.name, s.evidence.uses, s.evidence.people]), [['Brindlewood Mutual Health', 5, 3], ['Copperleaf Benefit Advisors', 3, 2]]);
    const preview = p.features.find((f: any) => f.feature === 'quality_preview');
    assert.ok(preview.deals.some((d: any) => d.addOn && d.accountName === 'Quillhaven Regional Medical Center' && d.outcome === 'lost'), 'one account used the preview and lost the add-on deal');
  });
  it('the SQL model agrees with the definition written out a second way, on every deal and feature', () => {
    const ctx = shipped();
    const asOf = Date.parse(ctx.store.usage.asOf());
    const events = ctx.db.prepare(`SELECT account_key AS a, feature AS f, occurred_at AS at FROM usage_events WHERE account_key IS NOT NULL AND feature IS NOT NULL`).all() as { a: string; f: string; at: string }[];
    const expected = new Map<string, number>();
    for (const d of ctx.store.usage.deals()) {
      const from = Date.parse(d.createdAt) - INFLUENCE_WINDOW_DAYS * DAY;
      const to = d.closedAt ? Date.parse(d.closedAt) : asOf;
      for (const e of events) {
        const at = Date.parse(e.at);
        if (e.a === d.accountKey && at >= from && at <= to) expected.set(`${d.id}|${e.f}`, (expected.get(`${d.id}|${e.f}`) ?? 0) + 1);
      }
    }
    const actual = new Map(ctx.store.usage.influencedDeals().map(r => [`${r.deal_id}|${r.feature}`, r.uses]));
    assert.deepEqual(actual, expected);
    assert.equal(expected.size, 47, 'a real comparison, not an empty one');
  });
});

describe('reverse ETL: product usage on each company', () => {
  it('rolls up the features used in 30 days, the last use and the 30-day count per feature', () => {
    const ctx = shipped();
    const r = usageRollups(ctx.store.usage.byAccountFeature());
    assert.equal(r.size, 12);
    const brindle = r.get('crm:mirror-brindlewood')!;
    assert.deepEqual(brindle.features30d, ['signal_search', 'signal_watch', 'api', 'network_benchmarking', 'quality_preview']);
    assert.equal(brindle.events30d.quality_preview, 5);
    assert.equal(brindle.events30d.mcp, 0);
    assert.equal(brindle.lastFeatureAt, ctx.db.prepare(`SELECT MAX(occurred_at) AS t FROM usage_events WHERE account_key = 'crm:mirror-brindlewood' AND feature IS NOT NULL`).get()!.t);
    const alder = r.get('crm:mirror-alderfinch')!;
    assert.deepEqual([alder.features30d, alder.lastFeature], [[], 'signal_search'], 'a quiet account writes an empty list, not nothing');
  });
  it('writes every property it defines, including the empty and zero ones, and each is defined in docs/hubspot-properties.json', () => {
    const ctx = shipped();
    const alder = usageCompanyProperties(usageRollups(ctx.store.usage.byAccountFeature()).get('crm:mirror-alderfinch')!);
    assert.equal(alder.serif_features_30d, '');
    assert.equal(alder[eventsProperty('quality_preview')], 0);
    const defined = new Set((JSON.parse(readFileSync(join(ROOT, 'docs', 'hubspot-properties.json'), 'utf8')).companies as { name: string }[]).map(p => p.name));
    for (const k of Object.keys(alder)) assert.ok(defined.has(k), `${k} is defined`);
    assert.deepEqual(COMPANY_PROPERTIES.filter(p => p.name.startsWith('serif_events_30d_')).map(p => p.name), FEATURE_KEYS.map(eventsProperty));
  });
});
