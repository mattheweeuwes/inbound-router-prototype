// The loop back into the router: when an inbound lead's organization has a rate group, its rep brief, Slack alert and CRM
// task carry one factual line about that group's rate, built by code from the stored finding. It changes no score and no route.
import type { Ctx } from '../context';
import { nameNorm } from '../resolve/match';
import type { Normalized, Resolution } from '../schema';
import { cents, fileTerms, type FileTerms } from './campaign';
import type { Finding } from './findings';

/** The rate line as stored on the lead (leads.rate_fact_json) for the cockpit. */
export interface RateFact {
  ein: string;
  name: string;
  line: string;
  /** registry_link: the lead resolved to the account the group links to. name_and_state: the normalized name and state matched. */
  matchedBy: 'registry_link' | 'name_and_state';
  accountId: string | null;
  /** groups that matched; the line describes the largest */
  groups: number;
}

/** ", 80% of a $141.47 rate card", ", a $47 conversion factor", both joined by "and", or nothing. */
function formClause(f: Finding, cardBase: number | null): string {
  const card = f.cardTier !== null && cardBase !== null ? `${f.cardTier}% of a ${cents(cardBase)} rate card` : null;
  const factor = f.factorMultiple !== null ? `a $${f.factorMultiple} conversion factor` : null;
  const parts = [card, factor].filter(Boolean);
  return parts.length ? `, ${parts.join(' and ')}` : '';
}

function cityClause(f: Finding): string {
  if (!f.city) return '';
  return f.cityTopEin === f.ein ? `; the top rate in ${f.city}` : `; top rate in ${f.city} ${cents(f.cityTopRate)}`;
}

/**
 * Their UHC Choice Plus rate for 90837 (Aug 2026): $163.09, 97% of Medicare, a $47 conversion factor; top rate in Dallas $378.38.
 * When several groups matched, the largest is described and the line says so.
 */
export function rateLine(f: Finding, t: FileTerms, cardBase: number | null, groups: number): string {
  const head = `Their ${t.payerShort} ${t.network} rate for ${t.code} (${t.monthShort} ${t.year}): ${cents(f.rate)}, ${f.pctOfMedicare}% of Medicare`;
  const many = groups > 1 ? ` (${f.name}, the largest of ${groups} rate groups that match)` : '';
  return `${head}${formClause(f, cardBase)}${cityClause(f)}${many}.`;
}

/**
 * The rate groups for a lead's organization: those linked to the account it resolved to, else those whose normalized name
 * and state equal the lead's (its resolved name or the company it typed, in its own state or one the registry gives).
 */
function matchingGroups(ctx: Ctx, res: Resolution, n: Normalized): { groups: Finding[]; matchedBy: RateFact['matchedBy'] } | null {
  const store = ctx.store.outbound;
  if (res.accountId) {
    const linked = store.linkedTo(res.accountId);
    if (linked.length) return { groups: linked, matchedBy: 'registry_link' };
  }
  const names = [...new Set([res.accountName, n.companyRaw].map(nameNorm).filter(Boolean))];
  const states = [...new Set([n.state, ...(res.firmographics.states ?? [])].filter((s): s is string => !!s))];
  for (const name of names) {
    for (const state of states) {
      const found = store.byName(name, state);
      if (found.length) return { groups: found, matchedBy: 'name_and_state' };
    }
  }
  return null;
}

/** The rate line for a lead, or null when no rate file is loaded or its organization has no rate group. */
export function rateFactFor(ctx: Ctx, res: Resolution, n: Normalized): RateFact | null {
  const file = ctx.store.outbound.file();
  if (!file) return null;
  const match = matchingGroups(ctx, res, n);
  if (!match) return null;
  const top = match.groups[0];
  const line = rateLine(top, fileTerms(file.scope), ctx.store.outbound.patterns().card?.value ?? null, match.groups.length);
  return { ein: top.ein, name: top.name, line, matchedBy: match.matchedBy, accountId: res.accountId, groups: match.groups.length };
}
