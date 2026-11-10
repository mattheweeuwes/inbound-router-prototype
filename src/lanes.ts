// Commit lanes (decision 23). Leads in one lane commit in the order they were accepted; leads in different lanes may pass a
// lead that is still waiting for its prepared result. The lane is read at accept time from what is cheap and certain: the
// email's domain, so people at one organization keep their repeat-contact handling, prior touches and the account claim in
// order; the full address on free mail or a disposable domain, where the domain says nothing about the organization; the
// company domain for a door with no person (web intent); and the lead itself when there is none of these.
import type { DomainLookups } from './normalize';
import { cleanHostname, normalizeEmail } from './normalize';
import type { LeadEvent } from './schema';

/** The lane key: 'domain:<domain>', 'email:<address>' or 'lead:<id>'. */
export function laneOf(ev: Pick<LeadEvent, 'email' | 'context'>, lookups: DomainLookups, leadId: string): string {
  const email = normalizeEmail(ev.email);
  if (email) {
    const domain = email.split('@')[1];
    return lookups.isFreeMail(domain) || lookups.isDisposable(domain) ? `email:${email}` : `domain:${domain}`;
  }
  const company = cleanHostname(typeof ev.context.domain === 'string' ? ev.context.domain : null);
  return company ? `domain:${company}` : `lead:${leadId}`;
}
