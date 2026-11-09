import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { combine, COMBINE_VERSION, rulesUseCaseIsClear } from '../src/qualify/combine';
import { classifyRules } from '../src/qualify/rules';
import type { Classification, RulesEvidence } from '../src/schema';
import type { LlmOutcome } from '../src/qualify/llm';
import { adapt } from '../src/sources';
import { buildPayload } from '../src/payloads';
import { normalizeEvent } from '../src/normalize';
import { spec } from './helpers';

const lookups = { isFreeMail: () => false, isDisposable: () => false };
const ev0 = (e: Partial<RulesEvidence> = {}): RulesEvidence => ({ useCaseScore: 3, useCaseRunnerUp: 0, urgencyCue: null, urgencyDate: null, urgencyDays: null, urgencyKind: 'none', urgencyParsed: null, legacyUrgencyCue: null, hasFreeText: true, roleFromTitle: true, ...e });
const rules = (over: Partial<Classification> = {}, e: Partial<RulesEvidence> = {}): Classification => ({ reasons: 'rules: r', useCase: 'contract_negotiation', urgency: 'unknown', buyingRole: 'decision_maker', disqualifier: 'none', confidence: 0.8, evidence: ev0(e), ...over });
const model = (over: Partial<Classification> = {}): Classification => ({ reasons: 'model: m', useCase: 'rate_benchmarking_market', urgency: 'this_quarter', buyingRole: 'user', disqualifier: 'none', confidence: 0.9, ...over });
const ok = (c: Classification): LlmOutcome => ({ ok: true, value: c, latencyMs: 1500, provider: 'ollama:test' });
const down: LlmOutcome = { ok: false, reason: 'unavailable', detail: 'ECONNREFUSED', latencyMs: 3, provider: 'ollama:test' };

describe('combine v4: the model never decides urgency; the rest as v2', () => {
  it('is the pipeline default and records its version; older policies stay callable', () => {
    assert.equal(COMBINE_VERSION, 'v4');
    assert.equal(combine(rules(), ok(model())).combineVersion, 'v4');
    for (const v of ['v1', 'v2', 'v3'] as const) assert.equal(combine(rules(), ok(model()), null, 'x', v).combineVersion, v);
  });

  describe('urgency (v4)', () => {
    const parsed = (urgencyParsed: RulesEvidence['urgencyParsed'], kind: RulesEvidence['urgencyKind'] = 'deadline') => ({ urgencyParsed, urgencyKind: kind, urgencyCue: 'mid-January', urgencyDate: '2027-01-15', urgencyDays: 70 });
    it('a parsed date wins over a confident model, and is marked as rules', () => {
      const q = combine(rules({ urgency: 'unknown' }, parsed('now')), ok(model({ urgency: 'exploring', confidence: 0.95 })));
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['now', 'rules']);
    });
    it('parsed exploring language and budget language also win', () => {
      assert.equal(combine(rules({}, parsed('exploring', 'exploring')), ok(model({ urgency: 'now' }))).final.urgency, 'exploring');
      assert.equal(combine(rules({}, parsed('this_quarter', 'budget')), ok(model({ urgency: 'now' }))).final.urgency, 'this_quarter');
    });
    it('with nothing parsed, a confident model is ignored: urgency is unknown, from the default', () => {
      const q = combine(rules({ urgency: 'exploring' }), ok(model({ urgency: 'now', confidence: 0.99 })));
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['unknown', 'default']);
    });
    it('with nothing parsed and no model, urgency is unknown', () => {
      const q = combine(rules({ urgency: 'exploring' }), down);
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['unknown', 'default']);
    });
    it('the model changes nothing about urgency under v4, whatever it says', () => {
      for (const urgency of ['now', 'this_quarter', 'exploring', 'unknown'] as const) {
        assert.equal(combine(rules({ urgency: 'unknown' }, parsed('this_quarter', 'budget')), ok(model({ urgency }))).final.urgency, 'this_quarter');
        assert.equal(combine(rules({ urgency: 'unknown' }), ok(model({ urgency }))).final.urgency, 'unknown');
      }
    });
    it('a lead with no free text at all keeps the door default, marked as default', () => {
      const q = combine(rules({ urgency: 'exploring' }, { hasFreeText: false }), null, 'no_free_text: x');
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['exploring', 'default']);
    });
    it('a lead with no free text and no door default is unknown', () => {
      const q = combine(rules({ urgency: 'unknown' }, { hasFreeText: false }), null, 'no_free_text: x');
      assert.equal(q.final.urgency, 'unknown');
    });
  });

  describe('urgency (v3, kept for the eval)', () => {
    const v3 = (r: Classification, o: LlmOutcome | null) => combine(r, o, null, 'x', 'v3');
    const parsed = (urgencyParsed: RulesEvidence['urgencyParsed'], kind: RulesEvidence['urgencyKind'] = 'deadline') => ({ urgencyParsed, urgencyKind: kind, urgencyCue: 'mid-January', urgencyDate: '2027-01-15', urgencyDays: 70 });
    it('a parsed date wins over a confident model', () => {
      const q = v3(rules({ urgency: 'unknown' }, parsed('now')), ok(model({ urgency: 'exploring', confidence: 0.95 })));
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['now', 'rules']);
    });
    it('parsed exploring language and budget language also win', () => {
      assert.equal(v3(rules({}, parsed('exploring', 'exploring')), ok(model({ urgency: 'now' }))).final.urgency, 'exploring');
      assert.equal(v3(rules({}, parsed('this_quarter', 'budget')), ok(model({ urgency: 'now' }))).final.urgency, 'this_quarter');
    });
    it('with nothing parsed, a confident model answers', () => {
      const q = v3(rules({ urgency: 'exploring' }), ok(model({ urgency: 'now', confidence: 0.6 })));
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['now', 'model']);
    });
    it('with nothing parsed and a model under 0.6, urgency is unknown', () => {
      const q = v3(rules({ urgency: 'exploring' }), ok(model({ urgency: 'now', confidence: 0.59 })));
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['unknown', 'rules']);
    });
    it('with nothing parsed and no model, urgency is unknown', () => {
      const q = v3(rules({ urgency: 'exploring' }), down);
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['unknown', 'rules']);
    });
    it('a lead with no free text at all keeps the door default', () => {
      const q = v3(rules({ urgency: 'exploring' }, { hasFreeText: false }), null);
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['exploring', 'rules']);
    });
  });

  describe('urgency (v2, kept for the eval)', () => {
    const v2 = (r: Classification, o: LlmOutcome | null) => combine(r, o, null, 'x', 'v2');
    it('an explicit timing cue in the rules wins over a confident model', () => {
      const q = v2(rules({ urgency: 'now' }, { legacyUrgencyCue: '"january" is 2 month(s) out' }), ok(model({ urgency: 'this_quarter' })));
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['now', 'rules']);
    });
    it('with no cue, a confident model answers', () => {
      const q = v2(rules({ urgency: 'unknown' }), ok(model({ urgency: 'now', confidence: 0.6 })));
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['now', 'model']);
    });
    it('with no cue and a model under 0.6, the rules answer stands', () => {
      const q = v2(rules({ urgency: 'unknown' }), ok(model({ urgency: 'now', confidence: 0.59 })));
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['unknown', 'rules']);
      assert.match(q.fallbackReason ?? '', /low_confidence/);
    });
    it('with no cue and no model, the rules answer (the door default) stands', () => {
      const q = v2(rules({ urgency: 'exploring' }), down);
      assert.deepEqual([q.final.urgency, q.final.sources?.urgency], ['exploring', 'rules']);
      assert.match(q.fallbackReason ?? '', /llm_unavailable/);
    });
  });

  describe('use case', () => {
    it('a clear keyword winner (2+ points, half a point ahead) beats the model', () => {
      const q = combine(rules({}, { useCaseScore: 2, useCaseRunnerUp: 1.5 }), ok(model()));
      assert.deepEqual([q.final.useCase, q.final.sources?.useCase], ['contract_negotiation', 'rules']);
    });
    it('1 point with a full point of daylight is also clear', () => {
      assert.equal(rulesUseCaseIsClear(rules({}, { useCaseScore: 1, useCaseRunnerUp: 0 })), true);
      assert.equal(rulesUseCaseIsClear(rules({}, { useCaseScore: 1.5, useCaseRunnerUp: 1 })), false);
    });
    it('a tie goes to the model', () => {
      const q = combine(rules({}, { useCaseScore: 5, useCaseRunnerUp: 5 }), ok(model()));
      assert.deepEqual([q.final.useCase, q.final.sources?.useCase, q.final.reasons], ['rate_benchmarking_market', 'model', 'model: m']);
    });
    it('a weak keyword result goes to the model', () => {
      assert.equal(combine(rules({}, { useCaseScore: 0, useCaseRunnerUp: 0 }), ok(model())).final.sources?.useCase, 'model');
    });
    it('an unclear keyword result with a model under 0.6 keeps the rules answer', () => {
      const q = combine(rules({}, { useCaseScore: 1, useCaseRunnerUp: 1 }), ok(model({ confidence: 0.5 })));
      assert.deepEqual([q.final.useCase, q.final.sources?.useCase], ['contract_negotiation', 'rules']);
    });
    it('an unclear keyword result with no model keeps the rules answer', () => {
      const q = combine(rules({}, { useCaseScore: 0, useCaseRunnerUp: 0 }), null, 'no_free_text: x');
      assert.deepEqual([q.final.useCase, q.final.sources?.useCase, q.fallbackReason], ['contract_negotiation', 'rules', 'no_free_text: x']);
    });
  });

  describe('buying role', () => {
    it('comes from the title when the title gives a seniority', () => {
      const q = combine(rules({ buyingRole: 'decision_maker' }, { roleFromTitle: true }), ok(model({ buyingRole: 'user' })));
      assert.deepEqual([q.final.buyingRole, q.final.sources?.buyingRole], ['decision_maker', 'rules']);
    });
    it('comes from the model when the title is silent', () => {
      const q = combine(rules({ buyingRole: 'unknown' }, { roleFromTitle: false }), ok(model({ buyingRole: 'influencer' })));
      assert.deepEqual([q.final.buyingRole, q.final.sources?.buyingRole], ['influencer', 'model']);
    });
    it('stays unknown when the title is silent and the model is unsure', () => {
      const q = combine(rules({ buyingRole: 'unknown' }, { roleFromTitle: false }), ok(model({ buyingRole: 'influencer', confidence: 0.3 })));
      assert.deepEqual([q.final.buyingRole, q.final.sources?.buyingRole], ['unknown', 'rules']);
    });
  });

  describe('disqualifier (unchanged from v1)', () => {
    it('a rules disqualifier stands whatever the model says', () => {
      const q = combine(rules({ disqualifier: 'student' }), ok(model({ disqualifier: 'none' })));
      assert.deepEqual([q.final.disqualifier, q.final.sources?.disqualifier], ['student', 'rules']);
    });
    it('a model-only disqualifier at 0.8+ counts and is marked as the model (job seeker, student, media)', () => {
      for (const d of ['job_seeker', 'student', 'media'] as const) {
        const q = combine(rules(), ok(model({ disqualifier: d, confidence: 0.8 })));
        assert.deepEqual([q.final.disqualifier, q.final.sources?.disqualifier, q.reviewReason], [d, 'model', null], d);
      }
    });
    it('a model-only spam or vendor-pitch call never disqualifies: it goes to review at any confidence', () => {
      for (const d of ['spam', 'vendor_pitch'] as const) {
        for (const confidence of [0.3, 0.8, 0.99]) {
          const q = combine(rules(), ok(model({ disqualifier: d, confidence })));
          assert.deepEqual([q.final.disqualifier, q.final.sources?.disqualifier, q.reviewReason, q.llmDisqualifier], ['none', 'rules', 'llm_only_disqualifier', d], `${d} at ${confidence}`);
        }
      }
    });
    it('a rule hit for spam or vendor pitch still disqualifies, whatever the model says', () => {
      for (const d of ['spam', 'vendor_pitch'] as const) {
        for (const llm of ['none', d] as const) {
          const q = combine(rules({ disqualifier: d }), ok(model({ disqualifier: llm, confidence: 0.95 })));
          assert.deepEqual([q.final.disqualifier, q.final.sources?.disqualifier, q.reviewReason], [d, 'rules', null], `${d} / model ${llm}`);
        }
      }
    });
    it('a model-only disqualifier under 0.8 is cleared and sent to review', () => {
      const q = combine(rules(), ok(model({ disqualifier: 'job_seeker', confidence: 0.7 })));
      assert.deepEqual([q.final.disqualifier, q.reviewReason, q.llmDisqualifier], ['none', 'llm_only_disqualifier', 'job_seeker']);
    });
  });

  it('agreement is recorded per field, and final keeps no rules evidence', () => {
    const q = combine(rules({ urgency: 'now' }), ok(model({ useCase: 'contract_negotiation', urgency: 'this_quarter', buyingRole: 'decision_maker' })));
    assert.deepEqual(q.agreement, { useCase: true, urgency: false, buyingRole: true, disqualifier: true });
    assert.equal('evidence' in q.final, false);
    assert.equal(q.rules.evidence?.useCaseScore, 3);
  });

  it('v1 stays callable: a confident model overrides the rules on use case, urgency and role', () => {
    const q = combine(rules({ urgency: 'now' }, { urgencyCue: 'cue' }), ok(model()), null, 'x', 'v1');
    assert.deepEqual([q.combineVersion, q.final.useCase, q.final.urgency, q.final.buyingRole], ['v1', 'rate_benchmarking_market', 'this_quarter', 'user']);
    assert.deepEqual(q.final.sources, { useCase: 'model', urgency: 'model', buyingRole: 'model', disqualifier: 'rules' });
  });
});

describe('rules expose their strength', () => {
  const run = (s: Parameters<typeof spec>[0], source: 'calendly_demo' | 'sample_signup' = 'calendly_demo') => {
    const ev = adapt(source, buildPayload(source, spec(s)));
    return classifyRules({ ev, n: normalizeEvent(ev, lookups), res: null });
  };
  it('records the timing cue text, the scores and whether the title gave a seniority', () => {
    const c = run({ ts: '2026-11-04T15:00:00Z', title: 'VP Managed Care Contracting', message: 'Our renegotiations start in mid-January.' });
    assert.deepEqual([c.evidence!.urgencyCue, c.evidence!.urgencyDate, c.evidence!.urgencyKind, c.evidence!.urgencyDays, c.evidence!.urgencyParsed], ['mid-January', '2027-01-15', 'deadline', 72, 'now']);
    assert.ok(c.evidence!.useCaseScore >= 2 && c.evidence!.useCaseScore > c.evidence!.useCaseRunnerUp);
    assert.equal(c.evidence!.roleFromTitle, true);
  });
  it('has no cue when the message has no timing language, and no role when the title is silent', () => {
    const c = run({ title: 'Growth Wizard', message: 'Interested in benchmarks.' });
    assert.equal(c.evidence!.urgencyCue, null);
    assert.equal(c.evidence!.roleFromTitle, false);
  });
  it('a product door default (exploring) is not a cue', () => {
    const c = run({ message: undefined }, 'sample_signup');
    assert.equal(c.urgency, 'exploring');
    assert.equal(c.evidence!.urgencyCue, null);
  });
});
