// The PostHog adapter, the taxonomy, and how a company group resolves to an account key.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT } from '../src/config';
import { contactKey } from '../src/normalize';
import { PayloadError } from '../src/sources/common';
import { accountForGroup } from '../src/usage/account';
import { adaptBatch, MAX_BATCH } from '../src/usage/posthog';
import { EVENT_FEATURE, FEATURE_KEYS, featureOf, primaryEvent } from '../src/usage/taxonomy';
import { testCtx } from './helpers';

const ev = (over: Record<string, unknown> = {}) => ({
  event: 'signal_search_run', distinct_id: 'Dana@Wrenfieldhealth.example', timestamp: '2026-10-01T14:03:22.123456+00:00', uuid: 'u-1',
  properties: { $groups: { company: 'wrenfieldhealth.example' } }, ...over,
});

describe('usage: the PostHog adapter', () => {
  it('maps the event shape onto the stored fields', () => {
    const { events, rejected } = adaptBatch({ batch: [ev()] });
    assert.deepEqual(rejected, []);
    assert.deepEqual(events[0], {
      eventId: 'u-1', eventName: 'signal_search_run', feature: 'signal_search', groupKey: 'wrenfieldhealth.example',
      contactKey: contactKey('dana@wrenfieldhealth.example'), occurredAt: '2026-10-01T14:03:22.123Z', synthetic: false,
    });
  });
  it('takes a bare array, a capture body or one event, and the group from $group_0 when $groups is missing', () => {
    assert.equal(adaptBatch([ev(), ev({ uuid: 'u-2' })]).events.length, 2);
    assert.equal(adaptBatch({ api_key: 'k', batch: [ev()] }).events.length, 1);
    assert.equal(adaptBatch(ev()).events.length, 1);
    assert.equal(adaptBatch(ev({ properties: { $group_0: 'a.example' } })).events[0].groupKey, 'a.example');
    assert.equal(adaptBatch(ev({ properties: {} })).events[0].groupKey, null);
  });
  it('an id that is not an email gives no contact, and a missing uuid is keyed on what identifies the event, not on the clock', () => {
    const anon = adaptBatch([ev({ distinct_id: '0192-anon-id' })]).events[0];
    assert.equal(anon.contactKey, null);
    const a = adaptBatch([ev({ uuid: undefined })]).events[0];
    const b = adaptBatch([ev({ uuid: undefined })]).events[0];
    assert.equal(a.eventId, b.eventId);
    assert.notEqual(a.eventId, adaptBatch([ev({ uuid: undefined, timestamp: '2026-10-01T14:03:23Z' })]).events[0].eventId);
  });
  it('the synthetic flag comes from the event or the batch', () => {
    assert.equal(adaptBatch([ev({ properties: { synthetic: true } })]).events[0].synthetic, true);
    assert.equal(adaptBatch({ synthetic: true, batch: [ev()] }).events[0].synthetic, true);
  });
  it('an unusable event is rejected with its position and reason, and the others still go through', () => {
    const { events, rejected } = adaptBatch([ev(), ev({ event: '' }), 'nope', ev({ timestamp: 'yesterday' }), ev({ timestamp: undefined })]);
    assert.equal(events.length, 1);
    assert.deepEqual(rejected.map(r => r.index), [1, 2, 3, 4]);
    assert.match(rejected[0].reason, /event is required/);
    assert.match(rejected[3].reason, /timestamp/);
  });
  it('a body that is not a batch, or is over the limit, is refused whole', () => {
    assert.throws(() => adaptBatch('x'), PayloadError);
    assert.throws(() => adaptBatch({ hello: 1 }), PayloadError);
    assert.throws(() => adaptBatch(Array.from({ length: MAX_BATCH + 1 }, () => ev())), /limit is 1000/);
  });
});

describe('usage: the taxonomy', () => {
  it('maps the six features, an unknown name to nothing, and every feature has a name it is sent under', () => {
    assert.deepEqual(['signal_search_run', 'watch_alert_created', 'api_call', 'mcp_tool_call', 'benchmark_viewed', 'quality_preview_viewed'].map(featureOf),
      ['signal_search', 'signal_watch', 'api', 'mcp', 'network_benchmarking', 'quality_preview']);
    assert.equal(featureOf('$pageview'), null);
    assert.equal(featureOf('toString'), null, 'a name on Object.prototype is not a feature');
    for (const f of FEATURE_KEYS) assert.equal(EVENT_FEATURE[primaryEvent(f)], f);
  });
  it('the sample sign-up door calls a search "search", and that is signal search', () => {
    assert.equal(featureOf('search'), 'signal_search');
  });
  it('fixtures/usage/features.json lists exactly the taxonomy\'s features', () => {
    const file = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'usage', 'features.json'), 'utf8')) as { features: { feature: string }[] };
    assert.deepEqual(file.features.map(f => f.feature).sort(), [...FEATURE_KEYS].sort());
  });
});

describe('usage: resolving a company group to an account key', () => {
  it('a mirror domain gives its crm: key, with or without www and with a subdomain', () => {
    const ctx = testCtx();
    assert.equal(accountForGroup(ctx, 'brookmerehealth.example'), 'crm:mirror-brookmere');
    assert.equal(accountForGroup(ctx, 'WWW.BrookmereHealth.example'), 'crm:mirror-brookmere');
    assert.equal(accountForGroup(ctx, 'portal.brookmerehealth.example'), 'crm:mirror-brookmere');
  });
  it('an account key resolves only when the router knows it', () => {
    const ctx = testCtx();
    assert.equal(accountForGroup(ctx, 'crm:mirror-wrenfield'), 'crm:mirror-wrenfield');
    assert.equal(accountForGroup(ctx, 'crm:mirror-nobody'), null);
    assert.equal(accountForGroup(ctx, 'ahrq:SYS-1'), null, 'no lead has created it');
    ctx.store.accounts.upsert({ id: 'ahrq:SYS-1', name: 'A System', segment: 'health_system', subsegment: null, domain: 'asystem.example', idsJson: null, firmographicsJson: null, at: '2026-11-01T00:00:00.000Z' });
    assert.equal(accountForGroup(ctx, 'ahrq:SYS-1'), 'ahrq:SYS-1');
    assert.equal(accountForGroup(ctx, 'asystem.example'), 'ahrq:SYS-1', 'by the domain a lead put on the account');
  });
  it('an unknown domain, a name that is not a host, and nothing resolve to no account', () => {
    const ctx = testCtx();
    assert.equal(accountForGroup(ctx, 'unlisted.example'), null);
    assert.equal(accountForGroup(ctx, 'Wrenfield Health'), null, 'a name is never guessed into an account');
    assert.equal(accountForGroup(ctx, null), null);
  });
});
