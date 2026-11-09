// The seeded CRM mirror (fixtures/crm-mirror.json): accounts that already have an owner in the CRM before the router sees a lead.
import type { CrmMirrorEntry, Normalized, Resolution } from './schema';
import { domainChain } from './resolve/domain';

function match(mirror: CrmMirrorEntry[], domain: string | null, accountName: string | null): { entry: CrmMirrorEntry; by: 'domain' | 'name' } | null {
  const doms = domain ? domainChain(domain) : [];
  const name = (accountName ?? '').toLowerCase();
  for (const entry of mirror) {
    if (entry.domains.some(d => doms.includes(d))) return { entry, by: 'domain' };
    if (name && entry.nameContains.some(s => name.includes(s))) return { entry, by: 'name' };
  }
  return null;
}

export function matchMirror(mirror: CrmMirrorEntry[], domain: string | null, accountName: string | null): CrmMirrorEntry | null {
  return match(mirror, domain, accountName)?.entry ?? null;
}

/**
 * An account that is in the CRM but in no public registry keeps the CRM record's identity, segment and size.
 * Only when the registries did not settle the organization (unresolved or ambiguous): a registry-resolved organization is never overridden,
 * and the mirror then only routes (R5). Returns the same object when nothing changes, so callers can compare by identity.
 */
export function crmIdentity(res: Resolution, n: Normalized, mirror: CrmMirrorEntry[]): Resolution {
  if (res.status === 'resolved') return res;
  const hit = match(mirror, n.companyDomain, res.accountName ?? n.companyRaw);
  if (!hit) return res;
  const m = hit.entry;
  return {
    ...res, status: 'resolved', accountId: `crm:${m.id}`, accountName: m.name, segment: m.segment, subsegment: null,
    confidence: hit.by === 'domain' ? 'high' : 'medium', method: 'crm', matchScore: null, candidates: [], inferred: false, firmographics: { ...(m.firmographics ?? {}) },
    evidence: [...res.evidence, { step: 'crm', detail: `not in the public registries; matched the CRM account ${m.name} on its ${hit.by}, and the CRM record supplies the segment${m.firmographics ? ' and size' : ''}` }],
  };
}
