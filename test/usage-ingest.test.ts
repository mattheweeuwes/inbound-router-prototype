// POST /api/usage: events stored once per uuid, nothing dropped silently, and the account resolved through the existing keys.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import handler from '../api/usage';
import { ingestUsage } from '../src/usage/ingest';
import { testCtx } from './helpers';

const ev = (uuid: string, over: Record<string, unknown> = {}) => ({
  event: 'api_call', distinct_id: 'g.rossi@sparrowgate.example', timestamp: '2026-10-01T14:00:00Z', uuid, properties: { $groups: { company: 'sparrowgate.example' } }, ...over,
});
const post = (ctx: ReturnType<typeof testCtx>, body: unknown) =>
  handler(new Request('http://local/api/usage', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), ctx);

const rows = (ctx: ReturnType<typeof testCtx>) =>
  ctx.db.prepare(`SELECT event_id, account_key, group_key, feature, event_name, occurred_at, synthetic, source FROM usage_events ORDER BY event_id`).all() as
    { event_id: string; account_key: string | null; group_key: string | null; feature: string | null; event_name: string; occurred_at: string; synthetic: number; source: string }[];

describe('usage ingest', () => {
  it('stores each event with its feature and account, and answers with what it did', async () => {
    const ctx = testCtx();
    const res = await post(ctx, { batch: [ev('a'), ev('b', { event: 'mcp_tool_call' })] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: 2, stored: 2, duplicates: 0, unmapped: 0, unresolved: 0, rejected: [] });
    assert.deepEqual(rows(ctx).map(r => [r.event_id, r.account_key, r.feature, r.source]), [['a', 'crm:mirror-sparrowgate', 'api', 'api'], ['b', 'crm:mirror-sparrowgate', 'mcp', 'api']]);
  });
  it('is idempotent on the event uuid: the same batch again changes nothing and is counted as duplicates', async () => {
    const ctx = testCtx();
    const batch = { batch: [ev('a'), ev('b'), ev('c')] };
    await post(ctx, batch);
    const again = await (await post(ctx, batch)).json();
    assert.deepEqual(again, { received: 3, stored: 0, duplicates: 3, unmapped: 0, unresolved: 0, rejected: [] });
    assert.equal(rows(ctx).length, 3);
    // the same uuid twice inside one batch is one event
    const twice = await (await post(ctx, [ev('d'), ev('d')])).json();
    assert.deepEqual([twice.stored, twice.duplicates], [1, 1]);
  });
  it('a redelivered uuid with different content keeps the first copy', async () => {
    const ctx = testCtx();
    await post(ctx, [ev('a')]);
    await post(ctx, [ev('a', { event: 'mcp_tool_call' })]);
    assert.equal(rows(ctx)[0].feature, 'api');
  });
  it('an event the taxonomy does not know is stored as unmapped and counted, never dropped', async () => {
    const ctx = testCtx();
    const out = await (await post(ctx, [ev('a', { event: '$pageview' }), ev('b', { event: 'export_downloaded' }), ev('c')])).json();
    assert.deepEqual([out.stored, out.unmapped], [3, 2]);
    assert.deepEqual(rows(ctx).filter(r => r.feature === null).map(r => r.event_name), ['$pageview', 'export_downloaded']);
    assert.deepEqual(ctx.store.usage.unmappedByName(), [{ event: '$pageview', n: 1 }, { event: 'export_downloaded', n: 1 }]);
    assert.deepEqual(ctx.store.usage.eventTotals().unmapped, 2);
  });
  it('a group that names no known account is stored with no account and counted as unresolved', async () => {
    const ctx = testCtx();
    const out = await (await post(ctx, [ev('a', { properties: { $groups: { company: 'unlisted.example' } } }), ev('b', { properties: {} }), ev('c')])).json();
    assert.deepEqual([out.stored, out.unresolved], [3, 2]);
    const r = rows(ctx);
    assert.deepEqual(r.map(x => [x.event_id, x.account_key, x.group_key]), [['a', null, 'unlisted.example'], ['b', null, null], ['c', 'crm:mirror-sparrowgate', 'sparrowgate.example']]);
  });
  it('an unusable event is reported with its position, the rest are stored, and received adds up', async () => {
    const ctx = testCtx();
    const out = await (await post(ctx, [ev('a'), { event: 'api_call' }, ev('b')])).json();
    assert.deepEqual([out.received, out.stored, out.duplicates, out.rejected.length], [3, 2, 0, 1]);
    assert.equal(out.rejected[0].index, 1);
  });
  it('stores times in one canonical form and the synthetic flag', async () => {
    const ctx = testCtx();
    await post(ctx, { synthetic: true, batch: [ev('a', { timestamp: '2026-10-01T10:00:00-04:00' }), ev('b', { timestamp: '2026-10-01T14:00:00.5Z' })] });
    assert.deepEqual(rows(ctx).map(r => [r.occurred_at, r.synthetic]), [['2026-10-01T14:00:00.000Z', 1], ['2026-10-01T14:00:00.500Z', 1]]);
  });
  it('refuses a body that is not JSON or not a batch, and any method but POST, and stores nothing', async () => {
    const ctx = testCtx();
    assert.equal((await post(ctx, 'not json')).status, 400);
    assert.equal((await post(ctx, { hello: 'world' })).status, 422);
    const get = await handler(new Request('http://local/api/usage'), ctx);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    assert.equal(rows(ctx).length, 0);
  });
  it('a batch is all or nothing: a failure part way leaves no half batch', () => {
    const ctx = testCtx();
    const real = ctx.store.usage.insertEvent;
    let calls = 0;
    ctx.store.usage.insertEvent = (...a: Parameters<typeof real>) => { if (++calls === 2) throw new Error('disk full'); return real(...a); };
    assert.throws(() => ingestUsage(ctx, [ev('a'), ev('b')]), /disk full/);
    ctx.store.usage.insertEvent = real;
    assert.equal(rows(ctx).length, 0);
  });
});
