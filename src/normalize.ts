import { createHash } from 'node:crypto';
import type { Channel, LeadEvent, Normalized, TitleFunction, TitleSeniority, Utm } from './schema';

export interface DomainLookups {
  isFreeMail(domain: string): boolean;
  isDisposable(domain: string): boolean;
}

// ---------- UTM ----------
const SOURCE_ALIASES: Record<string, string> = {
  li: 'linkedin', lnkd: 'linkedin', 'linkedin.com': 'linkedin',
  gads: 'google', adwords: 'google', fb: 'facebook',
  newsletter: 'email', mailchimp: 'email', hs_email: 'email',
};
const MEDIUM_ALIASES: Record<string, string> = {
  paidsocial: 'paid_social', 'paid-social': 'paid_social', paid_social: 'paid_social', ppc: 'cpc',
  newsletter: 'email', mailchimp: 'email', hs_email: 'email',
};

export function normalizeUtm(utm: Utm): { utm: Utm; fixes: Normalized['utmFixes'] } {
  const out: Utm = {};
  const fixes: Normalized['utmFixes'] = [];
  for (const key of ['source', 'medium', 'campaign', 'content', 'term'] as const) {
    const raw = utm[key];
    if (raw == null || String(raw).trim() === '') continue;
    let v = String(raw).trim().toLowerCase();
    if (key === 'source') v = SOURCE_ALIASES[v] ?? v;
    if (key === 'medium') v = MEDIUM_ALIASES[v] ?? v;
    if (key === 'source' || key === 'medium') v = v.replace(/\s+/g, '_');
    out[key] = v;
    if (v !== raw) fixes.push({ field: `utm_${key}`, from: String(raw), to: v });
  }
  return { utm: out, fixes };
}

// ---------- channel ----------
export function deriveChannel(source: LeadEvent['source'], utm: Utm, referrer: string | null): Channel {
  if (source === 'marketplace') return 'partner_marketplace';
  if (source === 'event_scan') return 'event';
  if (source === 'sample_signup' || source === 'api_key') return 'product';
  if (source === 'web_intent') return 'unknown';
  const m = utm.medium ?? '';
  const s = utm.source ?? '';
  const social = ['linkedin', 'facebook', 'twitter', 'x', 'instagram', 'reddit'].includes(s);
  if (m === 'paid_social' || (m === 'cpc' && social)) return 'paid_social';
  if (m === 'cpc' || m === 'paid_search' || m === 'display') return 'paid_search';
  if (m === 'email') return 'email';
  if (m === 'organic' && social) return 'organic_social';
  if (m === 'social' || (social && !m)) return 'organic_social';
  if (m === 'organic' || ['google', 'bing', 'duckduckgo'].includes(s) && !m) return 'organic_search';
  if (m === 'referral' || m === 'partner') return 'referral';
  if (!s && !m && referrer) {
    const host = safeHost(referrer);
    if (/(^|\.)(google|bing|duckduckgo|yahoo)\./.test(host)) return 'organic_search';
    if (/(linkedin|facebook|twitter|t\.co|reddit)/.test(host)) return 'organic_social';
    return 'referral';
  }
  if (!s && !m && !referrer) return 'direct';
  return 'unknown';
}

function safeHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// ---------- names ----------
export function titleCase(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return null;
  return t.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

export function splitName(full: string | null | undefined): { first: string | null; last: string | null } {
  const t = (full ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return { first: null, last: null };
  const i = t.indexOf(' ');
  return i < 0 ? { first: t, last: null } : { first: t.slice(0, i), last: t.slice(i + 1) };
}

// ---------- title -> function / seniority ----------
// Order matters: the first matching rule wins.
const FUNCTION_RULES: [TitleFunction, RegExp][] = [
  ['research_academic', /\b(student|professor|researcher|postdoc|phd|lecturer|fellow)\b/],
  ['media', /\b(reporter|journalist|editor|correspondent|writer)\b/],
  ['hr_recruiting', /\b(recruit|talent acquisition|human resources|\bhr\b)/],
  ['network_strategy', /\bnetwork (management|development|contracting|strategy|operations)\b/],
  ['managed_care_contracting', /(managed care|payer (contracting|relations|strategy)|payor|reimbursement|contracting|provider relations)/],
  ['benefits', /\b(benefits?|total rewards|rewards|people (operations|team)|workforce)\b/],
  ['revenue_cycle_finance', /(revenue cycle|revenue integrity|decision support|\bcfo\b|chief financial|finance|financial|controller|pricing|chargemaster|treasury)/],
  ['strategy_bd', /(strategy|strategic|business development|\bbd\b|growth|partnerships?|value creation|corporate development|\bprincipal\b|investments?)/],
  ['analytics_data', /(analytics|\bdata\b|\bbi\b|business intelligence|insights|analyst)/],
  ['product_engineering', /(engineer|developer|\bproduct\b|software|architect)/],
  ['executive', /\b(ceo|coo|president|founder|co-founder|owner|chief executive|chief operating)\b/],
  ['clinical', /\b(physician|nurse|clinical|medical director|cmo|md|surgeon|pharmacist)\b/],
  ['marketing_sales', /\b(marketing|sales|account executive|demand gen|brand|communications)\b/],
];

export function titleFunction(title: string | null): TitleFunction {
  if (!title) return 'other';
  const t = title.toLowerCase();
  for (const [fn, re] of FUNCTION_RULES) if (re.test(t)) return fn;
  return 'other';
}

export function titleSeniority(title: string | null): TitleSeniority {
  if (!title) return 'unknown';
  const t = title.toLowerCase();
  if (/\b(student|intern|undergraduate|graduate|candidate)\b/.test(t)) return 'student';
  // a managing director sits above a director (in private equity, banking and consulting it is the senior executive rung),
  // so it reads at the vice-president level rather than matching "director" below
  if (/\b(vp|svp|evp|avp)\b|vice president|head of|managing director/.test(t)) return 'vp';
  if (/\bchief\b|\bc[a-z]o\b|^president\b|\bfounder\b|\bowner\b/.test(t)) return 'c_level';
  if (/director|\bprincipal\b|\bpartner\b/.test(t) && !/growth partner/.test(t)) return 'director';
  if (/manager|\blead\b|supervisor/.test(t)) return 'manager';
  if (/analyst|engineer|developer|specialist|associate|coordinator|advisor|adviser|reporter|journalist|writer|consultant|scientist|researcher|representative|\bpartner\b/.test(t)) return 'individual';
  return 'unknown';
}

// ---------- email ----------
/**
 * A DNS hostname and nothing else: dotted labels of letters, digits and hyphens, at least one dot, and a last label that starts with a letter.
 * No port, path, query, brackets or bare name like "localhost". The last-label rule is what keeps IP literals out: "127.0.0.1" fails, and so does
 * "127.0.0.0x1", which a URL parser would read as 127.0.0.1. Anything else is treated as no domain, because this value is later put in a URL.
 */
export function cleanHostname(raw: string | null | undefined): string | null {
  const h = (raw ?? '').trim().toLowerCase();
  if (h.length > 253) return null;
  const labels = h.split('.');
  if (labels.length < 2) return null;
  if (!labels.every(l => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  return /^[a-z]/.test(labels[labels.length - 1]) ? h : null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  const m = e.match(/^[^@\s]+@([^@\s]+)$/);
  return m && cleanHostname(m[1]) ? e : null;
}

export function contactKey(email: string | null): string | null {
  return email ? createHash('sha256').update(email).digest('hex').slice(0, 16) : null;
}

export function normalizeEvent(ev: LeadEvent, lookups: DomainLookups): Normalized {
  const email = normalizeEmail(ev.email);
  const emailDomain = email ? email.split('@')[1] : cleanHostname(ev.context.domain ? String(ev.context.domain) : null);
  const isFreeMail = !!emailDomain && lookups.isFreeMail(emailDomain);
  const isDisposable = !!emailDomain && lookups.isDisposable(emailDomain);
  const { utm, fixes } = normalizeUtm(ev.utm);
  const title = ev.title?.trim() || null;
  const company = ev.company?.trim() || null;
  const state = ev.state ? ev.state.trim().toUpperCase().slice(0, 2) : null;
  return {
    email,
    emailDomain,
    isFreeMail,
    isDisposable,
    firstName: titleCase(ev.firstName),
    lastName: titleCase(ev.lastName),
    title,
    titleFunction: titleFunction(title),
    titleSeniority: titleSeniority(title),
    companyRaw: company,
    companyDomain: emailDomain && !isFreeMail && !isDisposable ? emailDomain : null,
    state,
    country: ev.country ? ev.country.trim().toUpperCase() : null,
    message: ev.message?.trim() || null,
    utm,
    utmFixes: fixes,
    channel: deriveChannel(ev.source, utm, ev.referrer),
    landingPage: ev.landingPage,
    referrer: ev.referrer,
    contactKey: contactKey(email),
  };
}
