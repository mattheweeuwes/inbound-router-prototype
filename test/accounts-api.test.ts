import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import accountsApi from '../api/accounts';
import { accountsLimit, ACCOUNTS_DEFAULT_LIMIT, ACCOUNTS_MAX_LIMIT, type AccountDetail, type AccountSummary } from '../src/accounts';
import { post, submit, testCtx } from './helpers';

const get = async (ctx: ReturnType<typeof testCtx>, path: string) => {
  const res = await accountsApi(new Request(`http://local${path}`), ctx);
  return { status: res.status, body: await res.json() };
};

// Intermountain (33 hospitals) is enterprise; Johns Hopkins (6 hospitals, one state) and Tanner are not
const hopkins = { email: 'pcole@jhmi.edu', first: 'Pat', last: 'Cole', company: 'Johns Hopkins Medicine', state: 'MD', seed: 'h', ts: '2026-11-05T17:00:00.000Z' };
const hopkinsGuide = { ...hopkins, email: 'mreed@jhmi.edu', first: 'Morgan', last: 'Reed', seed: 'h2', ts: '2026-11-05T18:00:00.000Z', message: undefined, guide: 'Health System Executive Guide' };

describe('GET /api/accounts', () => {
  it('ranks enterprise accounts first, then the account score, then the latest activity', async () => {
    const ctx = testCtx();
    await submit(ctx, 'guide_download', { message: undefined, guide: 'Health System Executive Guide', ts: '2026-11-05T15:00:00.000Z' }); // Intermountain, tier B
    await submit(ctx, 'calendly_demo', hopkins); // Johns Hopkins, tier A: a higher score, but not enterprise
    await submit(ctx, 'calendly_demo', { email: 'k@tanner.org', company: 'Tanner Health System', state: 'GA', seed: 't', ts: '2026-11-05T19:00:00.000Z', title: 'Manager, Payer Contracting', message: 'Looking at rates.' });
    const { status, body } = await get(ctx, '/api/accounts');
    assert.equal(status, 200);
    const accounts: AccountSummary[] = body.accounts;
    assert.equal(accounts[0].key, 'ahrq:SYS-INTERMTN');
    assert.equal(accounts[0].enterprise, true);
    assert.equal(accounts[0].enterpriseFact, '33 hospitals');
    const rest = accounts.slice(1);
    assert.ok(rest.every(a => !a.enterprise));
    for (let i = 1; i < rest.length; i++) {
      const [a, b] = [rest[i - 1], rest[i]];
      assert.ok(a.accountScore > b.accountScore || (a.accountScore === b.accountScore && (a.lastActivityAt ?? '') >= (b.lastActivityAt ?? '')), `${a.key} before ${b.key}`);
    }
    assert.equal(body.total, accounts.length);
    assert.equal((await get(ctx, '/api/accounts?limit=1')).body.accounts.length, 1);
  });

  it('the limit is clamped and a bad one falls back to the default', () => {
    assert.deepEqual([accountsLimit(null), accountsLimit('5'), accountsLimit('0'), accountsLimit('abc'), accountsLimit('99999')],
      [ACCOUNTS_DEFAULT_LIMIT, 5, ACCOUNTS_DEFAULT_LIMIT, ACCOUNTS_DEFAULT_LIMIT, ACCOUNTS_MAX_LIMIT]);
  });

  it('one account: owner, people, signals, deal cues, rate fact, open review items and its 30-day counts', async () => {
    const ctx = testCtx();
    await post(ctx, 'web_intent', { synthetic: true, domain: 'jhmi.edu', company: 'Johns Hopkins Medicine', visitors: 2, visits: [{ path: '/pricing', at: '2026-11-05T13:00:00Z' }] });
    const a = await submit(ctx, 'calendly_demo', { ...hopkins, message: 'We have an approved budget and want the full dataset.' });
    await submit(ctx, 'guide_download', hopkinsGuide);
    ctx.db.prepare(`UPDATE leads SET rate_fact_json = ? WHERE id = ?`).run(JSON.stringify({ line: 'Their UHC Choice Plus rate for 90837 (Aug 2026): $1.' }), a.json.leadId);
    ctx.db.prepare(`INSERT INTO review_queue (lead_id, reason, candidates_json, created_at, resolved) VALUES (?, 'model_doubt_after_alert', NULL, '2026-11-05T17:01:00.000Z', 0)`).run(a.json.leadId);
    const { status, body } = await get(ctx, `/api/accounts/${encodeURIComponent('ahrq:SYS-JHHS')}`);
    assert.equal(status, 200);
    const d: AccountDetail = body;
    assert.deepEqual([d.key, d.name, d.segment, d.enterprise], ['ahrq:SYS-JHHS', 'Johns Hopkins Health System', 'health_system', false]);
    assert.deepEqual([d.owner, d.ownerSource], ['Avery', 'claim'], 'the tier-A demo claimed it');
    assert.deepEqual(d.people.map(p => [p.name, p.door, p.tier]), [['Morgan Reed', 'guide_download', 'B'], ['Pat Cole', 'calendly_demo', 'A']]);
    const kinds = d.signals.map(s => s.kind).sort();
    assert.deepEqual(kinds, ['claim', 'deal_cue', 'deal_cue', 'web_intent']);
    assert.ok(d.signals.some(s => s.kind === 'deal_cue' && s.detail === 'approved_budget: "approved budget"'));
    assert.deepEqual([d.hasRateFact, d.rateLine], [true, 'Their UHC Choice Plus rate for 90837 (Aug 2026): $1.']);
    assert.deepEqual(d.reviews.map(r => r.reason), ['model_doubt_after_alert']);
    // leads30d is v_account_scores' count, so the web-intent lead counts as a lead; it names no contact
    assert.deepEqual([d.leads30d, d.contacts30d, d.openReviews, d.webIntentSignals], [3, 2, 1, 1]);
    assert.equal(d.lastActivityAt, '2026-11-05T18:00:00.000Z');
  });

  it('a CRM account shows its seeded owner; an unknown key is a 404; only GET is allowed', async () => {
    const ctx = testCtx();
    await submit(ctx, 'guide_download', { email: 'x@wrenfieldhealth.example', company: 'Wrenfield Health', state: 'MN', message: undefined, guide: 'Health System Executive Guide' });
    const w = await get(ctx, `/api/accounts/${encodeURIComponent('crm:mirror-wrenfield')}`);
    assert.deepEqual([w.body.owner, w.body.ownerSource, w.body.enterprise, w.body.enterpriseFact], ['Avery', 'crm', true, '11 hospitals']);
    assert.equal((await get(ctx, '/api/accounts/nope')).status, 404);
    assert.equal((await accountsApi(new Request('http://local/api/accounts', { method: 'POST' }), ctx)).status, 405);
  });
});
