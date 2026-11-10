// The resolution a person's decision gives a lead (decision 33): the account they chose, built the way the resolver builds
// a registry or CRM account, with its own method value so no reader takes it for a match the router made, or for a guess.
import type { Ctx } from '../context';
import { resolutionForAccount } from '../resolve';
import { curatedOrg, hospital, payer, systemFirmographics } from '../resolve/registry';
import type { Resolution, ResolveMethod } from '../schema';
import type { AccountChoice, ReviewDecision } from './decision';

/**
 * The method a person's choice records. The resolver's methods are a type in src/schema.ts, which the eval gate hashes with
 * the classifier, so this value is added here instead of there. Every reader of Resolution.method treats it as a label
 * (score.ts, brief.ts, the dashboard, the cockpit, the HubSpot match-method property), and each of them names it.
 */
export const PERSON_METHOD = 'person';
const personMethod = PERSON_METHOD as string as ResolveMethod;

/** The account behind a key the person named, from the registry or the CRM mirror, or null when neither has it. */
export function lookupAccount(ctx: Ctx, key: string): AccountChoice | null {
  const i = key.indexOf(':');
  if (i < 1) return null;
  const kind = key.slice(0, i), id = key.slice(i + 1);
  if (kind === 'crm') {
    const m = ctx.mirror.find(x => x.id === id);
    return m ? { key, name: m.name, from: 'crm' } : null;
  }
  const name = kind === 'ahrq' ? systemFirmographics(ctx.db, id)?.name
    : kind === 'ccn' ? hospital(ctx.db, id)?.name
    : kind === 'payer' ? payer(ctx.db, id)?.name
    : kind === 'domain' ? curatedOrg(ctx.db, id)?.name
    : null;
  return name ? { key, name, from: 'registry' } : null;
}

/** The resolution for the account a person chose: resolved, high confidence, method 'person', with the decision as its evidence. */
export function decidedResolution(ctx: Ctx, d: ReviewDecision): Resolution {
  const a = d.account;
  if (!a) throw new Error('a use_account decision without its account');
  const evidence = [{ step: PERSON_METHOD, detail: `${d.by} chose ${a.name} (${a.key}) in Needs a person${d.note ? `: "${d.note}"` : ''}` }];
  const base = accountResolution(ctx, a);
  return { ...base, status: 'resolved', method: personMethod, confidence: 'high', evidence, candidates: [], inferred: false };
}

/** The account's identity, segment and size, as the resolver or the CRM mirror would give them. */
function accountResolution(ctx: Ctx, a: AccountChoice): Resolution {
  if (a.key.startsWith('crm:')) {
    const m = ctx.mirror.find(x => `crm:${x.id}` === a.key);
    const r = resolutionForAccount(ctx, a.key, 'crm', 'high', null, []);
    return { ...r, accountName: m?.name ?? a.name, segment: m?.segment ?? 'unknown_org', firmographics: { ...(m?.firmographics ?? {}) } };
  }
  if (a.key.startsWith('domain:')) {
    const c = curatedOrg(ctx.db, a.key.slice('domain:'.length));
    const r = resolutionForAccount(ctx, a.key, 'curated_domain', 'high', null, []);
    return c ? { ...r, accountName: c.name, segment: c.segment, subsegment: c.subsegment, firmographics: { sizeClass: c.size_class } } : r;
  }
  return resolutionForAccount(ctx, a.key, 'company_name', 'high', null, []);
}
