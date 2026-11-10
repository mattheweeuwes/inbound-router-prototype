import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { confidentSalesOrg, ENTERPRISE_DEFINITION, enterpriseOf, hospitalFact } from '../src/enterprise';
import { CUE_TEXT, cueClause, findDealCues, type DealCueKind } from '../src/dealCues';
import type { Resolution } from '../src/schema';

const states = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);

describe('the enterprise definition', () => {
  it('a health system is enterprise from 8 hospitals, or from hospitals in 3 states', () => {
    assert.deepEqual(ENTERPRISE_DEFINITION.minHospitals, 8);
    assert.deepEqual(ENTERPRISE_DEFINITION.minStates, 3);
    assert.deepEqual(enterpriseOf('health_system', { hospitals: 8 }), { enterprise: true, fact: '8 hospitals', basis: 'hospitals' });
    assert.deepEqual(enterpriseOf('health_system', { hospitals: 7 }), { enterprise: false, fact: '7 hospitals', basis: null });
    assert.deepEqual(enterpriseOf('health_system', { hospitals: 6, states: states(3) }), { enterprise: true, fact: '6 hospitals in 3 states', basis: 'states' });
    assert.equal(enterpriseOf('health_system', { hospitals: 6, states: states(2) }).enterprise, false);
    assert.deepEqual(enterpriseOf('health_system', { hospitals: 145, states: states(20) }), { enterprise: true, fact: '145 hospitals in 20 states', basis: 'hospitals' });
  });
  it('a payer is enterprise when national or Blue', () => {
    assert.deepEqual(enterpriseOf('payer', { payerKind: 'national' }), { enterprise: true, fact: 'national payer', basis: 'payer_kind' });
    assert.deepEqual(enterpriseOf('payer', { payerKind: 'blue' }), { enterprise: true, fact: 'Blue plan', basis: 'payer_kind' });
    assert.deepEqual(enterpriseOf('payer', { payerKind: 'regional' }), { enterprise: false, fact: 'regional payer', basis: null });
    assert.deepEqual(enterpriseOf('payer', {}), { enterprise: false, fact: null, basis: null });
  });
  it('a benefits consultant or broker, or a TPA, is enterprise when national', () => {
    assert.deepEqual(enterpriseOf('benefits_consultant_broker', { sizeClass: 'national' }), { enterprise: true, fact: 'national benefits consultant or broker', basis: 'size_class' });
    assert.deepEqual(enterpriseOf('tpa', { sizeClass: 'national' }), { enterprise: true, fact: 'national third-party administrator', basis: 'size_class' });
    assert.deepEqual(enterpriseOf('benefits_consultant_broker', { sizeClass: 'regional' }), { enterprise: false, fact: 'regional benefits consultant or broker', basis: null });
    assert.equal(enterpriseOf('tpa', { sizeClass: 'other' }).fact, null);
  });
  it('no other segment is enterprise, whatever its firmographics say', () => {
    for (const seg of ['standalone_hospital', 'provider_group', 'employer_self_funded', 'life_sciences', 'pe_investor', 'unknown_org'] as const) {
      assert.equal(enterpriseOf(seg, { hospitals: 50, states: states(10), payerKind: 'national', sizeClass: 'national' }).enterprise, false, seg);
    }
  });
  it('names the states only when there are two or more: a single state may be only where the headquarters is', () => {
    assert.equal(hospitalFact({ hospitals: 9, states: ['GA'] }), '9 hospitals');
    assert.equal(hospitalFact({ hospitals: 1, states: ['GA', 'SC'] }), '1 hospital in 2 states');
    assert.equal(hospitalFact({ states: states(4) }), 'hospitals in 4 states');
    assert.equal(hospitalFact({}), null);
  });
  it('a deal-size cue counts only from a confidently resolved sales-segment organization', () => {
    const res = (over: Partial<Resolution>): Resolution => ({ status: 'resolved', accountId: 'x', accountName: 'X', segment: 'pe_investor', subsegment: null, confidence: 'high', method: 'curated_domain', matchScore: null, evidence: [], firmographics: {}, candidates: [], inferred: false, ...over });
    assert.equal(confidentSalesOrg(res({})), true);
    assert.equal(confidentSalesOrg(res({ confidence: 'medium' })), true);
    assert.equal(confidentSalesOrg(res({ confidence: 'low' })), false);
    assert.equal(confidentSalesOrg(res({ inferred: true })), false);
    assert.equal(confidentSalesOrg(res({ status: 'ambiguous' })), false);
    for (const seg of ['unknown_org', 'academic', 'media', 'government', 'competitor', 'non_us'] as const) assert.equal(confidentSalesOrg(res({ segment: seg })), false, seg);
  });
});

describe('deal-size cues', () => {
  const kinds = (m: string) => findDealCues(m).map(c => [c.kind, c.phrase]);

  it('finds each kind, keeps the words as written, in the order written', () => {
    assert.deepEqual(kinds('Evaluating a bulk license of the full negotiated-rate data lake for national network strategy. All payers, all states, monthly refresh. Budget is approved for 2027.'), [
      ['enterprise_license', 'bulk license'], ['full_dataset', 'full negotiated-rate data lake'], ['broad_coverage', 'All payers'], ['broad_coverage', 'all states'], ['approved_budget', 'Budget is approved'],
    ]);
    const one: [string, DealCueKind, string][] = [
      ['We want an enterprise license for the team.', 'enterprise_license', 'enterprise license'],
      ['Interested in the bulk negotiated-rate dataset via Databricks.', 'enterprise_license', 'bulk negotiated-rate dataset'],
      ['Can we get the entire dataset?', 'full_dataset', 'entire dataset'],
      ['We renegotiate across 21 states in Q1.', 'broad_coverage', '21 states'],
      ['Our plans operate in seven states.', 'broad_coverage', 'seven states'],
      ['Nationwide coverage matters to us.', 'broad_coverage', 'Nationwide'],
      ['We would sign a multi-year agreement.', 'multi_year', 'multi-year'],
      ['Open to a three-year contract.', 'multi_year', 'three-year contract'],
      ['We want to benchmark three portfolio MSOs.', 'multi_entity', 'portfolio MSOs'],
      ['It would cover several subsidiaries.', 'multi_entity', 'several subsidiaries'],
      ['We have an approved budget for this.', 'approved_budget', 'approved budget'],
    ];
    for (const [m, kind, phrase] of one) assert.deepEqual(kinds(m), [[kind, phrase]], m);
  });

  it('does not match what only sounds large', () => {
    const none = [
      'We are not looking for a bulk license yet.',
      'There is no approved budget for this.',
      'Coverage for PA and WV, two states.',
      'We operate in four states.',
      'Budget planning starts in December.',
      'We are looking for a data license for an advisory team.',
      'We want the full picture of our rates.',
      'One year to start.',
      'Our portfolio is growing.',
      '',
    ];
    for (const m of none) assert.deepEqual(findDealCues(m), [], m);
    assert.deepEqual(findDealCues(null), []);
  });

  it('a cue reads as a clause with its phrase quoted', () => {
    const [c] = findDealCues('A bulk license, please.');
    assert.equal(cueClause(c), 'asks for a bulk or enterprise license ("bulk license")');
    assert.equal(Object.keys(CUE_TEXT).length, 6);
  });
});
