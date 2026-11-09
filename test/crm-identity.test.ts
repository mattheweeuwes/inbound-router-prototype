import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crmIdentity } from '../src/mirror';
import type { CrmMirrorEntry, Normalized, Resolution } from '../src/schema';
import { scoreLead } from '../src/score';
import { adapt } from '../src/sources';
import { buildPayload } from '../src/payloads';
import { normalizeEvent } from '../src/normalize';
import { spec, submit, testCtx } from './helpers';

// The shipped fixtures/crm-mirror.json (loaded by testCtx) lists three fictional accounts that no public registry contains.
const CRM_DOMAIN = 'brookmerehealth.example';

const unresolved = (over: Partial<Resolution> = {}): Resolution => ({
  status: 'unresolved', accountId: 'domain:x.example', accountName: 'X', segment: 'unknown_org', subsegment: null, confidence: 'low', method: 'none',
  matchScore: null, evidence: [{ step: 'none', detail: 'no match' }], firmographics: {}, candidates: [], inferred: false, ...over,
});
const norm = (over: Partial<Normalized> = {}) => ({ companyDomain: null, companyRaw: null, ...over }) as Normalized;
const entry: CrmMirrorEntry = { id: 'test-acct', name: 'Test Account', status: 'partner', owner: 'Morgan', segment: 'benefits_consultant_broker', domains: ['testacct.example'], nameContains: ['test account'], note: '' };

describe('crmIdentity: a CRM account the public registries do not know keeps the CRM identity', () => {
  it('a domain match supplies identity, segment and high confidence', () => {
    const r = crmIdentity(unresolved(), norm({ companyDomain: 'testacct.example' }), [entry]);
    assert.deepEqual([r.status, r.method, r.accountId, r.accountName, r.segment, r.confidence, r.inferred], ['resolved', 'crm', 'crm:test-acct', 'Test Account', 'benefits_consultant_broker', 'high', false]);
    assert.ok(r.evidence.some(e => e.step === 'crm'));
  });
  it('a name-only match is medium confidence, and an ambiguous resolution is settled by the CRM account', () => {
    const amb = unresolved({ status: 'ambiguous', accountId: null, accountName: null, candidates: [{ accountId: 'a', name: 'A', kind: 'x', state: null, score: 1 }] });
    const r = crmIdentity(amb, norm({ companyRaw: 'The Test Account Group' }), [entry]);
    assert.deepEqual([r.status, r.method, r.confidence, r.candidates.length], ['resolved', 'crm', 'medium', 0]);
  });
  it('returns the same object when nothing matches, and never overrides a resolved organization', () => {
    const none = unresolved();
    assert.equal(crmIdentity(none, norm({ companyDomain: 'other.example' }), [entry]), none);
    const resolved = unresolved({ status: 'resolved', method: 'org_domain', segment: 'payer' });
    assert.equal(crmIdentity(resolved, norm({ companyDomain: 'testacct.example' }), [entry]), resolved);
  });
});

/** The size line of the fit score for a lead whose organization is the CRM entry (or none), as points. */
function sizeCredit(m: CrmMirrorEntry): number {
  const ev = adapt('calendly_demo', buildPayload('calendly_demo', spec({ email: 'pat@testacct.example', company: 'Test Account' })));
  const n = normalizeEvent(ev, { isFreeMail: () => false, isDisposable: () => false });
  const res = crmIdentity(unresolved(), n, [m]);
  assert.equal(res.method, 'crm');
  const score = scoreLead({ ev, n, res, final: { reasons: '', useCase: 'other', urgency: 'unknown', buyingRole: 'unknown', disqualifier: 'none', confidence: 0.9 }, priorTouches: 0, accountIntent: 0 });
  return score.items.find(i => i.label.startsWith('Size:'))?.points ?? 0;
}

describe('the CRM record supplies size', () => {
  it('firmographics are copied from the mirror entry, and an entry without them yields none', () => {
    const withFg = crmIdentity(unresolved(), norm({ companyDomain: 'testacct.example' }), [{ ...entry, firmographics: { sizeClass: 'national' } }]);
    assert.deepEqual(withFg.firmographics, { sizeClass: 'national' });
    const without = crmIdentity(unresolved(), norm({ companyDomain: 'testacct.example' }), [entry]);
    assert.deepEqual(without.firmographics, {});
  });
  it('a CRM-resolved payer is credited by its payerKind, a regional payer more than one with no size', () => {
    const payer: CrmMirrorEntry = { ...entry, segment: 'payer' };
    assert.equal(sizeCredit({ ...payer, firmographics: { payerKind: 'regional' } }), 10);
    assert.ok(sizeCredit({ ...payer, firmographics: { payerKind: 'regional' } }) > sizeCredit(payer));
  });
  it('a CRM account in a segment with no size table is credited like any other known organization', () => {
    assert.equal(sizeCredit({ ...entry, segment: 'employer_self_funded' }), 6);
  });
});

describe('the CRM identity fallback in the pipeline', () => {
  it('an unknown .example domain listed in the mirror resolves as a CRM account and routes R5 to the mirror owner', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { email: `rkline@${CRM_DOMAIN}`, company: 'Brookmere Health Plan', title: 'Director of Network Management', message: 'We want to compare our fee schedules against competing plans.' });
    assert.deepEqual([lead.resolution.status, lead.resolution.method, lead.resolution.accountId, lead.resolution.segment], ['resolved', 'crm', 'crm:mirror-brookmere', 'payer']);
    assert.deepEqual([lead.route.rule, lead.route.owner], ['R5', 'Casey']);
    assert.notEqual(lead.resolution.segment, 'unknown_org');
  });

  it('CONTROL: a registry-resolved organization that a test-only mirror also lists keeps its registry identity, and the mirror only routes', async () => {
    const ctx = testCtx();
    // test-only entry on a registry organization: it exists to prove the registry wins, and says nothing about that organization
    ctx.mirror = [{ id: 'test-only-control', name: 'Control Account', status: 'open_opportunity', owner: 'Casey', segment: 'benefits_consultant_broker', domains: ['intermountainhealthcare.org'], nameContains: [], note: 'test only' }];
    const { lead } = await submit(ctx, 'calendly_demo');
    assert.equal(lead.resolution.status, 'resolved');
    assert.notEqual(lead.resolution.method, 'crm');
    assert.equal(lead.resolution.segment, 'health_system');
    assert.ok(lead.resolution.accountId.startsWith('ahrq:'));
    assert.deepEqual([lead.route.rule, lead.route.owner], ['R5', 'Casey']);
  });

  it('a benefits-titled contact at a mirror account is not relabelled an inferred employer', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { email: `bmanager@${CRM_DOMAIN}`, company: 'Brookmere Health Plan', title: 'Director of Employee Benefits', message: 'We need network design benchmarks for our benefits team.' });
    assert.deepEqual([lead.resolution.method, lead.resolution.segment, lead.resolution.inferred], ['crm', 'payer', false]);
    assert.notEqual(lead.resolution.segment, 'employer_self_funded');
  });

  it('an unknown domain that is not in the mirror is still unresolved and goes to review (R6)', async () => {
    const ctx = testCtx();
    const { lead } = await submit(ctx, 'calendly_demo', { email: 'pat@unlisted-company.example', company: 'Unlisted Company', title: 'Analyst', message: 'We are benchmarking rates.' });
    assert.equal(lead.resolution.method, 'none');
    assert.notEqual(lead.resolution.status, 'resolved');
    assert.deepEqual([lead.route.rule, lead.route.action], ['R6', 'review']);
  });
});
