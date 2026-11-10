// Identity resolution: IDs, not names. Runs the ordered steps and stops at the first confident answer.
import type { Ctx } from '../context';
import type { Candidate, Confidence, LeadEvent, Normalized, Resolution, ResolveMethod, Segment } from '../schema';
import { domainChain, tldSegment } from './domain';
import { matchCompany, type MatchResult } from './match';
import { lookupNppes } from './nppes';
import { curatedOrg, hospital, orgDomain, payer, systemFirmographics } from './registry';
import { fetchSiteTitle, titleVariants } from './siteTitle';

function base(): Resolution {
  return { status: 'unresolved', accountId: null, accountName: null, segment: 'unknown_org', subsegment: null, confidence: 'low', method: 'none', matchScore: null, evidence: [], firmographics: {}, candidates: [], inferred: false };
}

/** Build a resolved Resolution for a registry account key. */
export function resolutionForAccount(ctx: Ctx, accountId: string, method: ResolveMethod, confidence: Confidence, matchScore: number | null, evidence: Resolution['evidence']): Resolution {
  const r = base();
  r.status = 'resolved'; r.method = method; r.confidence = confidence; r.matchScore = matchScore; r.evidence = evidence; r.accountId = accountId;
  const [kind, id] = [accountId.slice(0, accountId.indexOf(':')), accountId.slice(accountId.indexOf(':') + 1)];
  if (kind === 'ahrq') {
    const s = systemFirmographics(ctx.db, id);
    r.segment = 'health_system'; r.accountName = s?.name ?? id; r.firmographics = s?.firmographics ?? {};
  } else if (kind === 'ccn') {
    const h = hospital(ctx.db, id);
    r.segment = 'standalone_hospital'; r.accountName = h?.name ?? id;
    r.firmographics = { hospitals: 1, beds: h?.beds ?? null, states: h?.state ? [h.state] : [], ccns: [id], cmsType: h?.cmsType, ownership: h?.ownership, rating: h?.rating };
  } else if (kind === 'payer') {
    const p = payer(ctx.db, id);
    r.segment = 'payer'; r.accountName = p?.name ?? id; r.firmographics = { payerKind: p?.kind ?? null };
  } else {
    r.accountName = id;
  }
  return r;
}

const decodeEntities = (t: string) => t.replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const bareHost = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

/** Turns the ETL's pipe-separated evidence ("seed | title='...' | GET a -> b") into one plain sentence. Plain text; the UI escapes. */
export function verifiedDetail(raw: string | null): string | null {
  if (!raw) return null;
  const text = decodeEntities(raw);
  const title = text.match(/title='([^']*)'/)?.[1];
  const site = text.match(/og:site_name='([^']*)'/)?.[1];
  const redirect = text.match(/GET (\S+) -> (\S+)/);
  const bodyMatch = /BODY-TEXT MATCH/.test(text);
  const parts: string[] = [];
  if (title) parts.push(`homepage title "${title}"`);
  else if (site) parts.push(`homepage site name "${site}"`);
  if (bodyMatch) parts.push('the homepage text names the organization');
  const note: string[] = [];
  if (redirect && bareHost(redirect[1]) !== bareHost(redirect[2])) note.push(`redirects to ${bareHost(redirect[2])}`);
  if (/fixture-override/.test(text)) note.push('domain swapped for this fixture');
  if (!parts.length) return text.split(' | ').filter(x => !/^(seed|seed-extra)$/.test(x)).join('; ') || null;
  return parts.join(', ') + (note.length ? ` (${note.join('; ')})` : '');
}

const ENTITY_TEXT: Record<string, string> = { ahrq_system: 'AHRQ health system', cms_hospital: 'CMS hospital', payer: 'payer' };

const PROVIDERISH = /(physician|clinic|practice|medical group|anesthesi|radiolog|surgery|surgical|cardiolog|oncolog|pathology|emergency medicine|hospitalist|imaging|pediatric|orthop|dermatolog|health|care|partners|group|managed care|payer|contracting|rates?)/i;

function titleMatchesRole(n: Normalized): boolean {
  return ['managed_care_contracting', 'network_strategy', 'revenue_cycle_finance'].includes(n.titleFunction);
}

function fromMatch(ctx: Ctx, m: MatchResult, method: ResolveMethod, how: string, confidence: Confidence, ev: Resolution['evidence']): Resolution | null {
  if (m.outcome === 'unique' && m.top) {
    return resolutionForAccount(ctx, m.top.accountId, method, confidence, m.top.score, [...ev, { step: how, detail: `matched "${m.top.name}" (${m.top.kind}, score ${m.top.score}); ${m.reason}` }]);
  }
  if (m.outcome === 'ambiguous') {
    const r = base();
    r.status = 'ambiguous'; r.method = method; r.confidence = 'low'; r.matchScore = m.top?.score ?? null; r.candidates = m.candidates;
    r.evidence = [...ev, { step: how, detail: `ambiguous: ${m.reason}` }];
    return r;
  }
  return null;
}

export async function resolve(ctx: Ctx, ev: LeadEvent, n: Normalized): Promise<Resolution> {
  const evidence: Resolution['evidence'] = [];
  const domain = n.companyDomain;
  const company = n.companyRaw;

  if (n.isDisposable) {
    const r = base();
    r.evidence = [{ step: 'domain', detail: `${n.emailDomain} is a disposable-mail domain; no lookup attempted` }];
    return r;
  }

  // 1. curated domain, 2. known org domain (both run before any TLD heuristic, so jhmi.edu is a health system)
  if (domain) {
    for (const d of domainChain(domain)) {
      const c = curatedOrg(ctx.db, d);
      if (c) {
        const r = base();
        r.status = 'resolved'; r.method = 'curated_domain'; r.confidence = 'high';
        r.accountId = `domain:${c.domain}`; r.accountName = c.name; r.segment = c.segment; r.subsegment = c.subsegment;
        r.firmographics = { sizeClass: c.size_class };
        r.evidence = [{ step: 'curated_domain', detail: `${d} is on the curated list as ${decodeEntities(c.name)} (${c.segment.replace(/_/g, ' ')}${c.subsegment ? ', ' + c.subsegment : ''})` }];
        return r;
      }
    }
    for (const d of domainChain(domain)) {
      const o = orgDomain(ctx.db, d);
      if (o) {
        let accountId: string;
        if (o.entity_type === 'ahrq_system') accountId = `ahrq:${o.entity_id}`;
        else if (o.entity_type === 'payer') accountId = `payer:${o.entity_id}`;
        else {
          const h = hospital(ctx.db, o.entity_id);
          accountId = h?.systemId ? `ahrq:${h.systemId}` : `ccn:${o.entity_id}`;
        }
        const steps: Resolution['evidence'] = [{ step: 'org_domain', detail: `${d} maps to ${ENTITY_TEXT[o.entity_type] ?? o.entity_type} ${o.entity_id}, ${decodeEntities(o.name)}` }];
        if (o.entity_type === 'cms_hospital' && accountId.startsWith('ahrq:')) steps.push({ step: 'parent_system', detail: `CMS hospital ${o.entity_id} belongs to AHRQ health system ${accountId.slice(5)}, so the lead is placed on the system` });
        const ver = verifiedDetail(o.evidence);
        if (ver) steps.push({ step: 'verified', detail: ver });
        return resolutionForAccount(ctx, accountId, 'org_domain', 'high', null, steps);
      }
    }
    evidence.push({ step: 'domain', detail: `${domain} is not in the curated or known-organization lists` });
  } else {
    evidence.push({ step: 'domain', detail: n.isFreeMail ? `${n.emailDomain} is free-mail; domain says nothing about the employer` : 'no email domain on this event' });
  }

  // 3. company-name match (free-mail, or unknown domain with a company field)
  let siteName: string | null = null;
  if (company) {
    const m = matchCompany(ctx.db, company, n.state);
    const conf: Confidence = n.isFreeMail ? 'medium' : (titleMatchesRole(n) ? 'high' : 'medium');
    const hit = fromMatch(ctx, m, 'company_name', 'company_name', conf, evidence);
    if (hit) return hit;
    evidence.push({ step: 'company_name', detail: `"${company}": ${m.reason}` });
  } else if (n.isFreeMail) {
    evidence.push({ step: 'company_name', detail: 'free-mail address and no company field: nothing to match on' });
  }

  const tld = domain ? tldSegment(domain, n.country) : null;
  const reserved = !!domain && /\.(example|test|invalid|localhost)$/.test(domain); // never resolvable: skip network lookups
  if (reserved) evidence.push({ step: 'site_title', detail: `${domain} uses a reserved TLD; no fetch attempted` });

  // 4. site title (unknown corporate domain; .edu/.gov/non-US endings skip the fetch)
  if (domain && !tld && !reserved && ctx.cfg.network) {
    const st = await fetchSiteTitle(ctx, domain);
    if (st.error) evidence.push({ step: 'site_title', detail: `could not read ${domain}: ${st.error}` });
    else {
      evidence.push({ step: 'site_title', detail: `title "${st.title ?? ''}"${st.siteName ? `, og:site_name "${st.siteName}"` : ''}` });
      siteName = st.siteName ?? null;
      let ambiguous: Resolution | null = null;
      for (const v of titleVariants(st)) {
        const m = matchCompany(ctx.db, v, n.state);
        const hit = fromMatch(ctx, m, 'site_title', 'site_title', 'medium', evidence);
        if (hit?.status === 'resolved') return hit;
        if (hit && !ambiguous) ambiguous = hit;
      }
      if (ambiguous) return ambiguous;
    }
  }

  // 5. NPPES (provider-ish lead with a company name that nothing else placed)
  const nameForNppes = company ?? siteName;
  if (nameForNppes && ctx.cfg.network && !tld && !reserved && PROVIDERISH.test(`${n.title ?? ''} ${n.message ?? ''} ${nameForNppes}`)) {
    const out = await lookupNppes(ctx, nameForNppes, n.state);
    evidence.push({ step: 'nppes', detail: out.note });
    if (out.hit) {
      const h = out.hit;
      const r = base();
      r.status = 'resolved'; r.method = 'nppes'; r.confidence = 'medium'; r.matchScore = null;
      // one organizational NPI: key on it. A brand spread over several NPI-2 records has no single NPI, so key on the domain and list them.
      r.accountId = h.brand && domain ? `domain:${domain}` : `npi:${h.npi}`;
      r.accountName = h.brand ? (company ?? h.name) : h.name; r.segment = 'provider_group'; r.subsegment = h.taxonomy;
      r.firmographics = { npi: h.npi, npis: h.npis, taxonomy: h.taxonomy, states: h.states, hospitals: null };
      r.evidence = [...evidence, { step: 'nppes', detail: h.brand
        ? `brand spans ${h.npis.length} NPI-2 records (first ${h.npi}); keyed on domain, NPIs listed. Taxonomy: ${h.taxonomy ?? 'n/a'}`
        : `NPI-2 ${h.npi} "${h.name}", taxonomy: ${h.taxonomy ?? 'n/a'}` }];
      return r;
    }
  }

  // 6. TLD heuristics
  if (tld) {
    const r = base();
    r.status = 'resolved'; r.method = 'tld'; r.confidence = 'medium'; r.segment = tld.segment;
    r.accountId = domain ? `domain:${domain}` : null; r.accountName = company ?? domain;
    r.evidence = [...evidence, { step: 'tld', detail: tld.detail }];
    return r;
  }

  // 7. otherwise unknown_org; employer inference happens after qualification (see inferEmployer)
  const r = base();
  r.accountId = domain ? `domain:${domain}` : null;
  r.accountName = company ?? domain;
  r.evidence = [...evidence, { step: 'none', detail: 'no registry, name, site-title or NPPES match' }];
  return r;
}

/** A registry link made from a name and a state alone, for records that arrive without a domain (the rate file's groups). */
export interface NameLink {
  status: 'linked' | 'unlinked';
  accountId: string | null;
  accountName: string | null;
  method: 'company_name';
  /** the best candidate's score, linked or not; null when nothing scored at all */
  score: number | null;
  reason: string;
  /** what a person would choose from: kept on an unlinked record too */
  candidates: Candidate[];
}

/**
 * Links a name and state to a registry account with the same matcher and thresholds as step 3 above. Only a unique,
 * strong match links. A tie or a weak match stays unlinked with its candidates and is never guessed, which is the rule
 * the router follows for a lead (R6). No network lookups.
 */
export function resolveByName(ctx: Ctx, name: string, state: string | null): NameLink {
  const m = matchCompany(ctx.db, name, state);
  if (m.outcome === 'unique' && m.top) {
    return { status: 'linked', accountId: m.top.accountId, accountName: m.top.name, method: 'company_name', score: m.top.score, reason: m.reason, candidates: m.candidates };
  }
  const reason = m.outcome === 'ambiguous' ? `tie: ${m.reason}` : m.reason;
  return { status: 'unlinked', accountId: null, accountName: null, method: 'company_name', score: m.top?.score ?? m.candidates[0]?.score ?? null, reason, candidates: m.candidates };
}

/** Step 7 follow-up: benefits/HR at an unknown corporate domain is probably a self-funded employer. Low confidence, labelled inferred. */
export function inferEmployer(res: Resolution, n: Normalized, useCase: string): Resolution {
  if (res.status !== 'unresolved' || res.method !== 'none' || !n.companyDomain || n.isFreeMail) return res;
  if (n.titleFunction === 'benefits' || n.titleFunction === 'hr_recruiting' || useCase === 'network_design_benefits') {
    return {
      ...res, status: 'resolved', segment: 'employer_self_funded' as Segment, confidence: 'low', method: 'inferred', inferred: true,
      evidence: [...res.evidence, { step: 'inferred', detail: `benefits/HR persona (${n.title ?? 'title n/a'}) at an unknown corporate domain: inferred self-funded employer, low confidence` }],
    };
  }
  return res;
}
