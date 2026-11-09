import type { Ctx } from '../context';
import type { LeadEvent, Normalized, Qualification, Resolution } from '../schema';
import { combine } from './combine';
import { getProvider } from './llm';
import { classifyRules, hasFreeText } from './rules';

export { hasFreeText };

export async function qualify(ctx: Ctx, ev: LeadEvent, n: Normalized, res: Resolution): Promise<Qualification> {
  const rules = classifyRules({ ev, n, res });
  const provider = getProvider(ctx);
  if (!hasFreeText(n)) return combine(rules, null, 'no_free_text: the model is only called when the prospect wrote something', provider.name);
  const outcome = await provider.classify(ctx, ev, n, res);
  return combine(rules, outcome, null, provider.name);
}
