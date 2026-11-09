// Guard rails: when the model's word counts, and when it does not.
//   v1  the model wins use case, urgency and role whenever it is valid and confident (kept for the eval comparison)
//   v2  rules first, the model fills gaps; urgency from keyword cues (kept for the eval comparison)
//   v3  as v2, but urgency comes from the date parser; with no timing language the model is asked
//   v4  as v3, but the model never decides urgency: no timing language means unknown (what the pipeline runs)
import type { Classification, Disqualifier, FieldSources, Qualification } from '../schema';
import type { LlmOutcome } from './llm';
import { PROMPT_VERSION } from './prompt';

export const COMBINE_VERSION = 'v4';
export type CombineVersion = 'v1' | 'v2' | 'v3' | 'v4';

export const LLM_MIN_CONFIDENCE = 0.6;
export const LLM_DISQUALIFY_CONFIDENCE = 0.8;
/** Disqualifiers that end in a silent drop (R1, R4). A model's word alone never gets a lead dropped, whatever its confidence: a person decides. */
export const PERSON_DECIDES_IF_MODEL_ONLY: readonly Disqualifier[] = ['spam', 'vendor_pitch'];
/** A keyword winner is "clear" at 2+ points with half a point of daylight, or 1+ point with a full point of daylight. */
export const CLEAR_SCORE = 2, CLEAR_MARGIN = 0.5, WEAK_SCORE = 1, WEAK_MARGIN = 1;

export function rulesUseCaseIsClear(rules: Classification): boolean {
  const e = rules.evidence;
  if (!e) return true; // no evidence recorded: treat the rules as authoritative
  const margin = e.useCaseScore - e.useCaseRunnerUp;
  return (e.useCaseScore >= CLEAR_SCORE && margin >= CLEAR_MARGIN) || (e.useCaseScore >= WEAK_SCORE && margin >= WEAK_MARGIN);
}

function resolveDisqualifier(rules: Classification, llm: Classification | null): { value: Disqualifier; reviewReason: string | null; llmDisqualifier: Disqualifier | null } {
  if (rules.disqualifier !== 'none') return { value: rules.disqualifier, reviewReason: null, llmDisqualifier: null };
  if (llm && llm.disqualifier !== 'none') {
    // The model's word alone: spam and vendor pitch always go to a person (they would otherwise be dropped unseen). Any other disqualifier
    // counts at LLM_DISQUALIFY_CONFIDENCE or above; below that, a person decides.
    if (llm.confidence >= LLM_DISQUALIFY_CONFIDENCE && !PERSON_DECIDES_IF_MODEL_ONLY.includes(llm.disqualifier)) return { value: llm.disqualifier, reviewReason: null, llmDisqualifier: null };
    return { value: 'none', reviewReason: 'llm_only_disqualifier', llmDisqualifier: llm.disqualifier };
  }
  return { value: 'none', reviewReason: null, llmDisqualifier: null };
}

export function combine(rules: Classification, outcome: LlmOutcome | null, skipReason: string | null = null, providerName = 'rules', version: CombineVersion = COMBINE_VERSION): Qualification {
  const llm = outcome?.ok ? outcome.value : null;
  const trusted = !!llm && llm.confidence >= LLM_MIN_CONFIDENCE; // valid and confident
  let fallbackReason: string | null = null;
  if (!llm) fallbackReason = skipReason ?? (outcome && !outcome.ok ? `llm_${outcome.reason}: ${outcome.detail}` : 'llm_not_run');
  else if (!trusted) fallbackReason = `llm_low_confidence (${llm.confidence.toFixed(2)} < ${LLM_MIN_CONFIDENCE})`;

  const dq = resolveDisqualifier(rules, llm);
  const final: Classification = { ...rules, disqualifier: dq.value };
  delete final.evidence;
  const sources: FieldSources = { useCase: 'rules', urgency: 'rules', buyingRole: 'rules', disqualifier: 'rules' };
  if (dq.value !== 'none' && rules.disqualifier === 'none') sources.disqualifier = 'model';

  if (version === 'v1') {
    if (trusted && llm) {
      final.useCase = llm.useCase; final.urgency = llm.urgency; final.buyingRole = llm.buyingRole;
      final.reasons = llm.reasons; final.confidence = llm.confidence;
      sources.useCase = sources.urgency = sources.buyingRole = 'model';
    }
  } else {
    if (version === 'v2') {
      // urgency (round 2): a keyword timing cue in the rules wins; without one, the model if it is sure, else the rules' answer.
      if (!rules.evidence?.legacyUrgencyCue && trusted && llm) { final.urgency = llm.urgency; sources.urgency = 'model'; }
    } else if (version === 'v4') {
      // urgency (round 4): the parser decides, and the model never does. No timing language means unknown, because asserting a timeline the
      // prospect never gave inflates the score without evidence. A lead with no free text at all keeps the door default.
      const e = rules.evidence;
      if (e?.urgencyParsed) final.urgency = e.urgencyParsed;
      else if (e && !e.hasFreeText) sources.urgency = 'default';
      else { final.urgency = 'unknown'; sources.urgency = 'default'; }
    } else {
      // urgency (round 3): the date parser decides when the message carries any timing, budget or exploring language. Otherwise the model if it is
      // sure; otherwise unknown. A lead with no free text at all keeps the door default the rules computed (exploring for product doors).
      const e = rules.evidence;
      if (e?.urgencyParsed) { final.urgency = e.urgencyParsed; }
      else if (e && !e.hasFreeText) { /* door default stands */ }
      else if (trusted && llm) { final.urgency = llm.urgency; sources.urgency = 'model'; }
      else final.urgency = 'unknown';
    }
    // use case: a clear keyword winner stands; otherwise the model if it is sure; otherwise whatever the rules had.
    if (!rulesUseCaseIsClear(rules) && trusted && llm) { final.useCase = llm.useCase; sources.useCase = 'model'; }
    // buying role: the title says it when it carries a seniority.
    if (!rules.evidence?.roleFromTitle && trusted && llm) { final.buyingRole = llm.buyingRole; sources.buyingRole = 'model'; }
    if (sources.useCase === 'model') { final.reasons = llm!.reasons; final.confidence = llm!.confidence; }
  }

  return {
    provider: outcome?.provider ?? providerName,
    promptVersion: PROMPT_VERSION,
    combineVersion: version,
    latencyMs: outcome?.latencyMs ?? 0,
    llm, rules, final: { ...final, sources },
    agreement: llm ? { useCase: llm.useCase === rules.useCase, urgency: llm.urgency === rules.urgency, buyingRole: llm.buyingRole === rules.buyingRole, disqualifier: llm.disqualifier === rules.disqualifier } : null,
    fallbackReason, reviewReason: dq.reviewReason, llmDisqualifier: dq.llmDisqualifier,
  };
}
