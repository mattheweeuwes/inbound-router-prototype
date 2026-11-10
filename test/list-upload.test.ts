// The list generator (scripts/lib/list-upload.ts): its shape, its seed, and an upload through the real handler.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flushListDigests } from '../src/listDigest';
import { whenIdle } from '../src/pipeline';
import { generateList, mirrorCustomers, postList, registryOrgs, REPEAT_NOTE, UNKNOWN_COMPANIES } from '../scripts/lib/list-upload';
import { leadView, post, testCtx } from './helpers';

const NOW = Date.parse('2026-11-10T15:00:00.000Z');

function make(seed = 20261110, count = 150) {
  const ctx = testCtx();
  const list = generateList(registryOrgs(ctx.db), mirrorCustomers(ctx.mirror), { count, listName: 'HLTH', seed, now: NOW });
  return { ctx, list };
}

describe('the list generator', () => {
  it('has the count and the shares: registry, unknown on .example, free mail, customers, repeats', () => {
    const { list } = make();
    assert.equal(list.scans.length, 150);
    const n = (k: string) => list.kinds.filter(x => x === k).length;
    assert.deepEqual({ registry: n('registry'), unknown: n('unknown'), free: n('free_mail'), customer: n('customer'), repeat: n('repeat') },
      { registry: 115, unknown: 18, free: 7, customer: 4, repeat: 6 });
    const unknownDomains = new Set(UNKNOWN_COMPANIES.map(([, d]) => d));
    list.scans.forEach((s, i) => {
      assert.equal(s.synthetic, true);
      assert.equal(s.event, 'HLTH');
      const domain = s.badge.email.split('@')[1];
      if (list.kinds[i] === 'unknown') assert.ok(unknownDomains.has(domain) && domain.endsWith('.example'));
      if (list.kinds[i] === 'free_mail') assert.equal(domain, 'gmail.com');
      if (list.kinds[i] === 'customer') assert.ok(domain.endsWith('.example'), 'customers are the fictional mirror accounts');
    });
  });

  it('a repeat is the same badge as an earlier row, scanned later, and the list is not in time order', () => {
    const { list } = make();
    list.scans.forEach((s, i) => {
      if (list.kinds[i] !== 'repeat') return;
      const original = list.scans.find((o, j) => j !== i && list.kinds[j] !== 'repeat' && o.badge.email === s.badge.email)!;
      assert.ok(original, 'its first scan is in the list');
      assert.equal(s.notes, REPEAT_NOTE);
      assert.ok(Date.parse(s.scanned_at) > Date.parse(original.scanned_at));
    });
    const times = list.scans.map(s => s.scanned_at);
    assert.notDeepEqual(times, [...times].sort(), 'shuffled');
  });

  it('the same seed and clock give the same list; another seed gives another', () => {
    assert.deepEqual(make(7).list, make(7).list);
    assert.notDeepEqual(make(7).list.scans, make(8).list.scans);
  });

  it('posts through the event_scan door: every row accepted, repeats attached to their first scan, digests once settled', async () => {
    const { ctx, list } = make(11, 40);
    const r = await postList(list.scans, async payload => {
      const res = await post(ctx, 'event_scan', payload, { wait: false });
      return { status: res.status, leadId: res.json.leadId ?? null };
    });
    assert.deepEqual(r.codes, { 202: 40 });
    await whenIdle(ctx);
    const leads = r.ids.map(id => leadView(ctx, id ?? ''));
    const byEmail = new Map<string, number[]>();
    list.scans.forEach((s, i) => byEmail.set(s.badge.email, [...(byEmail.get(s.badge.email) ?? []), i]));
    const pairs = [...byEmail.values()].filter(ix => ix.length === 2);
    assert.equal(pairs.length, list.kinds.filter(k => k === 'repeat').length);
    for (const [i, j] of pairs) {
      // whichever scan was posted first owns the pair, whatever its time; one that went to nurture owns nothing (decision 6)
      const [first, second] = [leads[i], leads[j]];
      if (['rep_alert', 'owner_task', 'team_queue', 'review'].includes(first.route.action)) assert.equal(second.dedupe.duplicateOf, first.id, first.person?.email ?? first.id);
      assert.equal(first.dedupe.duplicateOf, null);
    }
    assert.ok(flushListDigests(ctx, { force: true }).length >= 1);
  });
});
