// Where the model sits on a lead's path (decision 19). The classifier itself is src/qualify and is unchanged: this file
// decides when it is called. A lead whose route the model can change waits for it; every other free-text lead is routed
// and alerted on the rules, and the same call runs after the alert as a second opinion (src/secondOpinion.ts).
// Model calls share a bounded number of slots, and a call a route is waiting on goes ahead of a second opinion.
import type { Ctx } from './context';
import { modelTiming, type ModelTiming } from './decisions';
import { Limiter } from './limiter';
import { qualify } from './qualify';
import { combine, rulesUseCaseIsClear } from './qualify/combine';
import { getProvider } from './qualify/llm';
import { classifyRules, hasFreeText } from './qualify/rules';
import type { LeadEvent, Normalized, Qualification, Resolution } from './schema';

/** The fallback reason a lead alerted on the rules carries until its second opinion arrives. */
export const AFTER_ALERT_REASON = 'model_after_alert: the rules settled the use case, so the model gives a second opinion after the alert';

/** Model-slot priorities: lower goes first. */
const BEFORE_ROUTE = 0, SECOND_OPINION = 1;

const slots = new WeakMap<Ctx, Limiter>();
function modelSlots(ctx: Ctx): Limiter {
  let l = slots.get(ctx);
  if (!l) slots.set(ctx, (l = new Limiter(ctx.cfg.modelConcurrency)));
  return l;
}

export interface QualifiedForRoute { qual: Qualification; timing: ModelTiming }

/**
 * The qualification the route uses. When the model is due before the route, or not called at all, this is qualify() as the
 * eval runs it, so the record is the one the pipeline always stored. When the model can wait, it is the rules alone through
 * the same combine, with AFTER_ALERT_REASON as the fallback reason.
 */
export async function qualifyForRoute(ctx: Ctx, ev: LeadEvent, n: Normalized, res: Resolution): Promise<QualifiedForRoute> {
  const provider = getProvider(ctx);
  const rules = classifyRules({ ev, n, res });
  const timing = modelTiming({ setting: ctx.cfg.modelBeforeRoute, providerIsModel: provider.name !== 'rules', freeText: hasFreeText(n), rulesUseCaseClear: rulesUseCaseIsClear(rules) });
  if (timing === 'after_alert') return { qual: combine(rules, null, AFTER_ALERT_REASON, provider.name), timing };
  if (timing === 'not_called') return { qual: await qualify(ctx, ev, n, res), timing };
  return { qual: await modelSlots(ctx).run(() => qualify(ctx, ev, n, res), BEFORE_ROUTE), timing };
}

/** The full qualification (rules plus the model) for a lead that was alerted on the rules: the same call, after the alert, in a low-priority slot. */
export function secondOpinionCall(ctx: Ctx, ev: LeadEvent, n: Normalized, res: Resolution): Promise<Qualification> {
  return modelSlots(ctx).run(() => qualify(ctx, ev, n, res), SECOND_OPINION);
}

/** Whether the route waited for a model call: the model ran before routing (a lead with no free text, or rules only, never calls it). */
export const waitedForModel = (q: Qualification) =>
  q.provider !== 'rules' && !String(q.fallbackReason ?? '').startsWith('no_free_text') && q.fallbackReason !== AFTER_ALERT_REASON;

/**
 * What the gated path would have routed on, rebuilt from a full qualification (the rules and the model's answer, as the eval
 * stores them): the full record when the model would have run before the route, the rules alone when it would have waited.
 */
export function fastPathOf(full: Qualification): Qualification {
  const timing = modelTiming({
    setting: 'gated', providerIsModel: full.provider !== 'rules', freeText: full.rules.evidence?.hasFreeText ?? false, rulesUseCaseClear: rulesUseCaseIsClear(full.rules),
  });
  return timing === 'after_alert' ? combine(full.rules, null, AFTER_ALERT_REASON, full.provider) : full;
}
