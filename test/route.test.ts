import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findDealCues } from '../src/dealCues';
import { enterpriseOf, type DealSignals } from '../src/enterprise';
import { decideRoute, SLA, teamFor, type RouteInput } from '../src/route';
import type { Classification, CrmMirrorEntry, Owners, Qualification, Resolution, Score, Tier } from '../src/schema';
import { adapt } from '../src/sources';
import { buildPayload } from '../src/payloads';
import { normalizeEvent } from '../src/normalize';
import { spec } from './helpers';
import type { Source } from '../src/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config';

const owners: Owners = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'owners.json'), 'utf8'));
const lookups = { isFreeMail: () => false, isDisposable: (d: string) => d === 'mailinator.com' };
const res = (over: Partial<Resolution> = {}): Resolution => ({ status: 'resolved', accountId: 'ahrq:X', accountName: 'X Health', segment: 'health_system', subsegment: null, confidence: 'high', method: 'org_domain', matchScore: null, evidence: [], firmographics: {}, candidates: [], inferred: false, ...over });
const cls = (over: Partial<Classification> = {}): Classification => ({ reasons: '', useCase: 'contract_negotiation', urgency: 'now', buyingRole: 'decision_maker', disqualifier: 'none', confidence: 0.9, ...over });
const qual = (final: Partial<Classification> = {}, over: Partial<Qualification> = {}): Qualification => ({ provider: 'rules', promptVersion: 'v1', combineVersion: 'v2', latencyMs: 0, llm: null, rules: cls(final), final: cls(final), agreement: null, fallbackReason: null, reviewReason: null, llmDisqualifier: null, ...over });
const score = (tier: Tier, total = 75): Score => ({ total, fit: 40, intent: 35, tier, items: [] });

function input(over: Partial<RouteInput> & { source?: Source; email?: string; tier?: Tier; spec?: Parameters<typeof spec>[0] } = {}): RouteInput {
  const source = over.source ?? 'calendly_demo';
  const ev = source === 'web_intent'
    ? adapt('web_intent', { synthetic: true, domain: 'sutterhealth.org', company: 'Sutter Health', visitors: 2, visits: [{ path: '/a', at: '2026-11-05T14:00:00Z' }] })
    : adapt(source, buildPayload(source, spec({ ts: '2026-11-05T15:00:00.000Z', email: over.email ?? 'dwhitfield@x.org', ...over.spec })));
  const n = normalizeEvent(ev, lookups);
  const base: RouteInput = {
    ev, n, res: res(), qual: qual(), score: score(over.tier ?? 'A'), duplicate: null, mirror: null, owners,
    pickRep: team => ({ name: owners.teams[team]?.reps[0].name ?? 'x', hubspotOwnerId: '1' }),
  };
  const { source: _s, email: _e, tier: _t, spec: _sp, ...rest } = over;
  return { ...base, ...rest };
}

describe('route rules R1 to R9', () => {
  it('R1: a disposable domain is dropped, and wins over a competitor', () => {
    const r = decideRoute(input({ email: 'x@mailinator.com', res: res({ segment: 'competitor' }) }));
    assert.deepEqual([r.rule, r.action], ['R1', 'drop']);
  });
  it('R1: a rules-detected spam disqualifier is dropped', () => {
    const r = decideRoute(input({ qual: qual({ disqualifier: 'spam' }), tier: 'X' }));
    assert.deepEqual([r.rule, r.action], ['R1', 'drop']);
  });
  it('R2: a contact duplicate attaches to the existing lead and keeps its owner', () => {
    const r = decideRoute(input({ tier: 'B', duplicate: { leadId: 'abcdef123456', owner: 'Avery', team: 'HSP', lastAlertAt: null } }));
    assert.deepEqual([r.rule, r.action, r.owner, r.team], ['R2', 'attach_to_existing', 'Avery', 'HSP']);
    assert.equal(r.alertSuppressed, true);
  });
  it('R2: the alert is suppressed inside 24h; after that only a tier-A touch re-alerts', () => {
    const d = (lastAlertAt: string) => ({ leadId: 'abcdef123456', owner: 'Avery', team: 'HSP' as const, lastAlertAt });
    assert.equal(decideRoute(input({ tier: 'A', duplicate: d('2026-11-05T03:00:00Z') })).alertSuppressed, true, 'under 24h');
    assert.equal(decideRoute(input({ tier: 'A', duplicate: d('2026-11-03T15:00:00Z') })).alertSuppressed, false, 'over 24h, tier A');
    assert.equal(decideRoute(input({ tier: 'B', duplicate: d('2026-11-03T15:00:00Z') })).alertSuppressed, true, 'over 24h, tier B');
  });
  it('R3: a competitor is flagged to marketing with no sales route', () => {
    const r = decideRoute(input({ res: res({ segment: 'competitor' }), tier: 'X' }));
    assert.deepEqual([r.rule, r.action, r.owner], ['R3', 'competitor_flag', 'Marketing (Sam)']);
  });
  it('R4: disqualifier routes', () => {
    const route = (dq: Classification['disqualifier'], segment: Resolution['segment'] = 'unknown_org') => decideRoute(input({ qual: qual({ disqualifier: dq }), res: res({ segment }), tier: 'X' }));
    assert.equal(route('job_seeker').action, 'careers');
    assert.equal(route('media', 'media').action, 'press');
    assert.equal(route('vendor_pitch').action, 'drop');
    assert.deepEqual([route('student', 'academic').action, route('student', 'academic').sequence], ['nurture', 'research']);
    const nonUs = decideRoute(input({ res: res({ segment: 'non_us' }), tier: 'D' }));
    assert.deepEqual([nonUs.rule, nonUs.action, nonUs.sequence], ['R4', 'nurture', 'out_of_territory']);
  });
  const mirror: CrmMirrorEntry = { id: 'm', name: 'Wrenfield Health', status: 'customer', owner: 'Avery', segment: 'health_system', domains: [], nameContains: [], note: '' };
  it('R5: the existing account owner wins at any tier; the tier sets action and SLA', () => {
    const a = decideRoute(input({ mirror, tier: 'A' }));
    assert.deepEqual([a.rule, a.action, a.owner, a.slaMinutes], ['R5', 'rep_alert', 'Avery', 5]);
    const c = decideRoute(input({ mirror, tier: 'C', score: score('C', 40) }));
    assert.deepEqual([c.action, c.owner, c.slaMinutes], ['owner_task', 'Avery', 540]);
  });
  it('R5: an account claimed on an earlier lead routes to the claiming rep, with its own reason', () => {
    const r = decideRoute(input({ claimedOwner: 'Avery', tier: 'A', res: res({ accountName: 'Piedmont Healthcare' }) }));
    assert.deepEqual([r.rule, r.action, r.owner, r.slaMinutes], ['R5', 'rep_alert', 'Avery', 5]);
    assert.equal(r.reason, 'Piedmont Healthcare is already owned by Avery from an earlier lead, so it goes to Avery whatever the tier; tier A only sets the response time.');
    assert.equal(decideRoute(input({ claimedOwner: 'Avery', tier: 'C', score: score('C', 40) })).action, 'owner_task');
  });
  it('R5: the seeded mirror owner wins when a claim also exists', () => {
    const m: CrmMirrorEntry = { id: 'm', name: 'Wrenfield Health', status: 'customer', owner: 'Casey', segment: 'health_system', domains: [], nameContains: [], note: '' };
    const r = decideRoute(input({ mirror: m, claimedOwner: 'Avery', tier: 'A' }));
    assert.deepEqual([r.owner, r.team], ['Casey', 'PLS']);
    assert.match(r.reason, /^Existing customer account owned by Casey/);
  });
  it('R5: the owner is told about a model-only doubt, and the routing does not change', () => {
    const doubt = qual({}, { reviewReason: 'llm_only_disqualifier', llmDisqualifier: 'job_seeker' });
    const sentence = ' The model alone flagged it as job seeker at under 0.8 confidence and no rule agreed, so check it before acting.';
    const plain = decideRoute(input({ mirror, tier: 'A' }));
    const flagged = decideRoute(input({ mirror, tier: 'A', qual: doubt }));
    assert.deepEqual([flagged.rule, flagged.action, flagged.owner, flagged.slaMinutes], [plain.rule, plain.action, plain.owner, plain.slaMinutes]);
    assert.equal(flagged.reason, plain.reason + sentence);
    assert.doesNotMatch(plain.reason, /model alone/);
    const claimed = decideRoute(input({ claimedOwner: 'Avery', tier: 'A', qual: doubt }));
    assert.equal(claimed.rule, 'R5');
    assert.match(claimed.reason, /from an earlier lead.*job seeker at under 0\.8 confidence.*check it before acting\.$/);
  });
  it('R5: a model-only spam or vendor-pitch call is flagged to the owner without a confidence claim, because it holds at any confidence', () => {
    for (const what of ['spam', 'vendor_pitch'] as const) {
      const r = decideRoute(input({ mirror, tier: 'A', qual: qual({}, { reviewReason: 'llm_only_disqualifier', llmDisqualifier: what }) }));
      assert.equal(r.rule, 'R5');
      assert.match(r.reason, new RegExp(`The model alone flagged it as ${what.replace('_', ' ')} and no rule agreed, so check it before acting\\.$`));
      assert.doesNotMatch(r.reason, /0\.8/);
    }
  });
  it('R6: ambiguous or unresolved companies go to RevOps with a 60 business-minute SLA', () => {
    const amb = decideRoute(input({ res: res({ status: 'ambiguous', segment: 'unknown_org', accountId: null, candidates: [{ accountId: 'a', name: 'A', kind: 'x', state: null, score: 1 }] }), tier: 'C' }));
    assert.deepEqual([amb.rule, amb.action, amb.owner, amb.slaMinutes], ['R6', 'review', 'RevOps', 60]);
    assert.equal(decideRoute(input({ res: res({ status: 'unresolved', segment: 'unknown_org' }) })).action, 'review');
  });
  it('R6: a model-only disqualifier goes to review instead of dropping a buyer', () => {
    const r = decideRoute(input({ qual: qual({}, { reviewReason: 'llm_only_disqualifier', llmDisqualifier: 'job_seeker' }) }));
    assert.deepEqual([r.rule, r.action], ['R6', 'review']);
    assert.match(r.reason, /less than 0\.8 confident/);
  });
  it('R6: a model-only spam or vendor-pitch call goes to review at any confidence, and the reason says so', () => {
    for (const what of ['spam', 'vendor_pitch'] as const) {
      const r = decideRoute(input({ qual: qual({}, { reviewReason: 'llm_only_disqualifier', llmDisqualifier: what }) }));
      assert.deepEqual([r.rule, r.action, r.owner], ['R6', 'review', 'RevOps']);
      assert.match(r.reason, /never dropped on the model's word alone/);
      assert.doesNotMatch(r.reason, /0\.8/);
    }
  });
  it('R1 and R4 still drop a spam or vendor-pitch call that a rule made', () => {
    assert.deepEqual([decideRoute(input({ qual: qual({ disqualifier: 'spam' }) })).rule, decideRoute(input({ qual: qual({ disqualifier: 'spam' }) })).action], ['R1', 'drop']);
    assert.deepEqual([decideRoute(input({ qual: qual({ disqualifier: 'vendor_pitch' }) })).rule, decideRoute(input({ qual: qual({ disqualifier: 'vendor_pitch' }) })).action], ['R4', 'drop']);
  });
  it('R7: team by segment and use case', () => {
    assert.equal(teamFor('health_system', 'contract_negotiation', 'calendly_demo'), 'HSP');
    assert.equal(teamFor('provider_group', 'other', 'calendly_demo'), 'HSP');
    assert.equal(teamFor('tpa', 'network_design_benefits', 'calendly_demo'), 'BW');
    assert.equal(teamFor('government', 'other', 'guide_download'), 'BW');
    assert.equal(teamFor('payer', 'payer_competitive_intel', 'calendly_demo'), 'PLS');
    assert.equal(teamFor('pe_investor', 'investment_diligence', 'calendly_demo'), 'PLS');
    assert.equal(teamFor('innovator_navigation', 'other', 'calendly_demo'), 'BW');
    assert.equal(teamFor('innovator_navigation', 'navigation_find_care', 'calendly_demo'), 'API');
    assert.equal(teamFor('innovator_api_data', 'other', 'api_key'), 'API');
    assert.equal(teamFor('payer', 'data_platform_api', 'marketplace'), 'API');
    assert.equal(teamFor('payer', 'data_platform_api', 'calendly_demo'), 'PLS');
  });
  it('R8: A is a rep alert with a 5 minute SLA, B a team queue, C and D nurture', () => {
    const a = decideRoute(input({ tier: 'A' }));
    assert.deepEqual([a.rule, a.action, a.team, a.owner, a.slaMinutes], ['R8', 'rep_alert', 'HSP', 'Avery', 5]);
    assert.equal(a.slaDueAt, '2026-11-05T15:05:00.000Z');
    const b = decideRoute(input({ tier: 'B', score: score('B', 60) }));
    assert.deepEqual([b.action, b.owner, b.slaMinutes, b.slaDueAt], ['team_queue', 'HSP queue', 60, '2026-11-05T16:00:00.000Z']);
    const c = decideRoute(input({ tier: 'C', score: score('C', 40) }));
    assert.deepEqual([c.action, c.owner, c.sequence], ['nurture', 'Marketing (Sam)', 'provider_education']);
    assert.equal(decideRoute(input({ tier: 'D', score: score('D', 20), source: 'sample_signup', res: res({ segment: 'innovator_api_data' }) })).sequence, 'developer_product');
  });
  it('R8: after hours, the A SLA clock starts at the next business open; B rolls to the next business morning', () => {
    const fri = '2026-11-07T02:12:00.000Z'; // Fri 21:12 ET
    const a = decideRoute(input({ tier: 'A', spec: { ts: fri } }));
    assert.equal(a.slaDueAt, '2026-11-09T14:05:00.000Z');
    const b = decideRoute(input({ tier: 'B', spec: { ts: fri }, score: score('B', 60) }));
    assert.equal(b.slaDueAt, '2026-11-09T15:00:00.000Z');
  });
  it('R9: web intent is an account signal for the account owner or team, never a rep alert', () => {
    const r = decideRoute(input({ source: 'web_intent', tier: 'C', score: score('C', 40) }));
    assert.deepEqual([r.rule, r.action, r.owner], ['R9', 'account_signal', 'HSP queue']);
    const owned = decideRoute(input({ source: 'web_intent', mirror: { id: 'm', name: 'S', status: 'customer', owner: 'Avery', segment: 'health_system', domains: [], nameContains: [], note: '' } }));
    assert.equal(owned.owner, 'Avery');
  });
  it('rule order: R4 before R5 (a student at a customer account is still nurture)', () => {
    const r = decideRoute(input({ qual: qual({ disqualifier: 'student' }), res: res({ segment: 'academic' }), tier: 'X', mirror: { id: 'm', name: 'S', status: 'customer', owner: 'Avery', segment: 'health_system', domains: [], nameContains: [], note: '' } }));
    assert.equal(r.rule, 'R4');
  });

  describe('reasons are one plain sentence, naming the team in full', () => {
    const oneSentence = (r: string) => { assert.match(r, /^[A-Z].*\.$/); assert.equal((r.match(/\. /g) ?? []).length, 0, r); };
    it('R1 to R9', () => {
      const m: CrmMirrorEntry = { id: 'm', name: 'Wrenfield Health', status: 'customer', owner: 'Avery', segment: 'health_system', domains: [], nameContains: [], note: '' };
      const cases: [string, ReturnType<typeof decideRoute>, RegExp][] = [
        ['R1', decideRoute(input({ email: 'x@mailinator.com' })), /disposable-mail service/],
        ['R2', decideRoute(input({ tier: 'B', duplicate: { leadId: 'abcdef123456', owner: 'Avery', team: 'HSP', lastAlertAt: null } })), /already has a lead.*stays with Avery/],
        ['R3', decideRoute(input({ res: res({ segment: 'competitor', accountName: 'Turquoise Health' }), tier: 'X' })), /Turquoise Health is a competitor/],
        ['R4', decideRoute(input({ qual: qual({ disqualifier: 'job_seeker' }), tier: 'X' })), /job seeker.*careers-page/],
        ['R5', decideRoute(input({ mirror: m, tier: 'B', score: score('B', 60) })), /^Existing customer account owned by Avery, so it goes to Avery whatever the tier/],
        ['R6', decideRoute(input({ res: res({ status: 'ambiguous', segment: 'unknown_org', accountId: null, candidates: [{ accountId: 'ahrq:a', name: 'A', kind: 'ahrq_system', state: 'AR', score: 1 }, { accountId: 'ahrq:b', name: 'A', kind: 'ahrq_system', state: 'FL', score: 1 }] }), spec: { company: 'Baptist Health', state: undefined } })), /^Baptist Health matches two health systems about equally and no state was given, so RevOps picks the account before any rep is alerted\.$/],
        ['R7/R8 A', decideRoute(input({ tier: 'A', score: score('A', 85) })), /^Tier A \(85\) health system with no account owner, so round-robin assigned Avery in Health Systems & Providers\.$/],
        ['R8 B', decideRoute(input({ tier: 'B', score: score('B', 62) })), /Tier B \(62\).*Health Systems & Providers queue.*60 business-minute/],
        ['R8 C', decideRoute(input({ tier: 'C', score: score('C', 40) })), /Tier C \(40\).*nurture track/],
        ['R9', decideRoute(input({ source: 'web_intent' })), /Web visits from .*no rep is alerted/],
      ];
      for (const [rule, r, re] of cases) { assert.match(r.reason, re, rule); oneSentence(r.reason); }
    });
  });
});

describe('R10: an enterprise deal never waits in a team queue', () => {
  const enterprise = (hospitals: number): DealSignals => ({ enterprise: enterpriseOf('health_system', { hospitals }), cues: [] });
  const cued = (message: string): DealSignals => ({ enterprise: enterpriseOf('pe_investor', {}), cues: findDealCues(message) });

  it('a tier-B lead at an enterprise account goes to a named rep with a 15-minute response time, and says why', () => {
    const r = decideRoute(input({ tier: 'B', score: score('B', 62), deal: enterprise(145), res: res({ accountName: 'CommonSpirit Health' }) }));
    assert.deepEqual([r.rule, r.action, r.owner, r.team, r.slaMinutes], ['R10', 'rep_alert', 'Avery', 'HSP', SLA.enterprise]);
    assert.equal(r.reason, 'CommonSpirit Health is an enterprise account (145 hospitals), so a named rep gets it now instead of the Health Systems & Providers queue: round-robin assigned Avery in Health Systems & Providers, with a 15-minute response time.');
  });
  it('tier A keeps its 5 minutes', () => {
    const r = decideRoute(input({ tier: 'A', score: score('A', 85), deal: enterprise(145) }));
    assert.deepEqual([r.rule, r.slaMinutes], ['R10', SLA.A]);
  });
  it('a deal-size cue at a confidently resolved sales-segment organization counts too, and the reason quotes it', () => {
    const r = decideRoute(input({
      tier: 'B', score: score('B', 60), deal: cued('We want to benchmark three portfolio MSOs.'),
      res: res({ segment: 'pe_investor', accountName: 'Welsh, Carson, Anderson & Stowe', accountId: 'domain:welshcarson.com', method: 'curated_domain' }),
    }));
    assert.deepEqual([r.rule, r.team, r.owner], ['R10', 'PLS', 'Casey']);
    assert.match(r.reason, /^Welsh, Carson, Anderson & Stowe is a known private equity investor and the message covers several entities \("portfolio MSOs"\), so a named rep gets it now/);
  });
  it('a cue does not count from a low-confidence or inferred organization', () => {
    const deal = cued('Budget is approved for a bulk license.');
    for (const r of [res({ confidence: 'low' }), res({ segment: 'employer_self_funded', inferred: true, confidence: 'low', method: 'inferred' })]) {
      assert.equal(decideRoute(input({ tier: 'B', score: score('B', 60), deal, res: r })).rule, 'R8');
    }
  });
  it('stays out of the way of earlier rules, lower tiers, list doors and disqualifiers', () => {
    const m: CrmMirrorEntry = { id: 'm', name: 'Wrenfield Health', status: 'customer', owner: 'Taylor', segment: 'health_system', domains: [], nameContains: [], note: '' };
    assert.deepEqual([decideRoute(input({ tier: 'B', score: score('B', 60), deal: enterprise(20), mirror: m })).rule], ['R5'], 'the account owner comes first');
    assert.equal(decideRoute(input({ tier: 'B', score: score('B', 60), deal: enterprise(20), res: res({ status: 'ambiguous', accountId: null }) })).rule, 'R6');
    assert.equal(decideRoute(input({ tier: 'C', score: score('C', 40), deal: enterprise(20) })).rule, 'R8', 'tier C goes to nurture');
    const scan = decideRoute(input({ source: 'event_scan', tier: 'B', score: score('B', 60), deal: enterprise(20), listDoor: true }));
    assert.deepEqual([scan.rule, scan.action], ['R8', 'team_queue'], 'a list row stays in its digest');
    assert.equal(decideRoute(input({ source: 'web_intent', tier: 'B', deal: enterprise(20) })).rule, 'R9');
    assert.equal(decideRoute(input({ tier: 'X', qual: qual({ disqualifier: 'student' }), deal: enterprise(20) })).rule, 'R4');
  });
  it('with no rep available it falls back to the team queue and says so', () => {
    const r = decideRoute(input({ tier: 'B', score: score('B', 60), deal: enterprise(20), pickRep: () => null }));
    assert.deepEqual([r.rule, r.owner], ['R10', 'HSP queue']);
    assert.match(r.reason, /no rep was available\.$/);
  });
});
