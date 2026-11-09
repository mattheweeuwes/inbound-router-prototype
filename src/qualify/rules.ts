// Deterministic classifier. Runs on EVERY lead; it is the floor the model has to beat.
import { parse as parseWhen, urgencyFromWhen } from './when';
import type { BuyingRole, Classification, Disqualifier, LeadEvent, Normalized, Resolution, Urgency, UseCase } from '../schema';

type Kw = [RegExp, number, string];

const USE_CASE_KEYWORDS: Record<Exclude<UseCase, 'other'>, Kw[]> = {
  contract_negotiation: [
    [/renegotiat/i, 3, 'renegotiat*'],
    [/\bnegotiat(e|ion|ions|ing)\b/i, 3, 'negotiation'],
    [/contract (cycle|renewal|renews?|talks|negotiation)|(upcoming|next) contract/i, 3, 'contract cycle/renewal'],
    [/\brenews?\b|\brenewals?\b/i, 2, 'renewal'],
    [/commercial contract/i, 2, 'commercial contract'],
    [/(below|above) market/i, 1.5, 'below/above market'],
  ],
  rate_benchmarking_market: [
    [/benchmark/i, 3, 'benchmark*'],
    [/market rate|market view|rate comparisons?|compare rates?|rates? vary|rate variation|price variation|peer (systems|hospitals)/i, 2, 'rate comparison/variation'],
    [/\brates?\b.{0,40}\bmarkets?\b/i, 2, 'rates by market'],
    [/service.line/i, 1, 'service line'],
  ],
  payer_competitive_intel: [
    [/compar|\bvs\.?\b|versus|competing|competitive|other plans|against (other|competing)/i, 3, 'compare/versus other plans'],
  ],
  network_design_benefits: [
    [/network (comparison|design|discount|benchmark)|self.funded|plan sponsors?|\bbroker|\brfps?\b|employer clients|clients ask|total cost of care/i, 3, 'network/self-funded/broker'],
    [/\bmembers\b/i, 1, 'members'],
  ],
  navigation_find_care: [
    [/navigation|find care|member.facing|cost.estimat|price.estimat|shoppable|consumer.facing/i, 3, 'navigation/find care/estimates'],
  ],
  data_platform_api: [
    [/\bapi\b|\bmcp\b|datasets?|data (license|licence|feed|warehouse|partnership|platform)|\bbulk\b|snowflake|databricks|refresh cadence|endpoint|integrat/i, 3, 'api/dataset/warehouse'],
  ],
  life_sciences_access: [
    [/market access|formulary|pharma|drug pric|biosimilar|launch|specialty drug/i, 3, 'market access/pharma'],
  ],
  investment_diligence: [
    [/diligence|acquisition|investment thesis|portfolio compan|\bdeal\b|platform investment/i, 3, 'diligence/deal'],
  ],
  research_media: [
    [/thesis|dissertation|coursework|class project|\bstory\b|article|journalis|reporter|publication|academic/i, 3, 'thesis/story/article'],
    [/\bresearch\b|\bstudy\b/i, 1.5, 'research/study'],
  ],
  job_seeker: [[/\bhiring\b|job opening|\bcareers?\b|join (serif|your team|the team)|resume|internship|open roles?/i, 4, 'hiring/join']],
  vendor_pitch: [[/\bseo\b|our agency|\bagency\b|15 minutes|quick call|grow your|lead gen|outsourc|appointment setting|marketing services/i, 4, 'agency/seo/pitch']],
};

const TIE_ORDER: UseCase[] = [
  'job_seeker', 'vendor_pitch', 'contract_negotiation', 'payer_competitive_intel', 'rate_benchmarking_market', 'network_design_benefits',
  'navigation_find_care', 'data_platform_api', 'life_sciences_access', 'investment_diligence', 'research_media', 'other',
];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Months from the received month to a named month (0 = this month). */
const monthsAhead = (from: Date, monthIdx: number) => (monthIdx - from.getUTCMonth() + 12) % 12;

export function urgencyFromText(text: string, received: Date): { urgency: Urgency | null; why: string } {
  const t = text.toLowerCase();
  const now = t.match(/\b(asap|urgent(ly)?|immediately|right away|this week|this month|next month|next week|end of (the )?(month|week)|expires?|expiring|fast)\b/);
  if (now) return { urgency: 'now', why: `"${now[0]}"` };
  const q = t.match(/\bq([1-4])\b/);
  if (q) {
    // days until the start of that quarter, next occurrence
    const startMonth = (Number(q[1]) - 1) * 3;
    let start = Date.UTC(received.getUTCFullYear(), startMonth, 1);
    if (start < +received) start = Date.UTC(received.getUTCFullYear() + 1, startMonth, 1);
    const days = (start - +received) / 86_400_000;
    return days <= 95 ? { urgency: 'now', why: `"${q[0]}" starts in ${Math.round(days)} days` } : { urgency: 'this_quarter', why: `"${q[0]}" starts in ${Math.round(days)} days` };
  }
  const mon = t.match(new RegExp(`\\b(${MONTHS.join('|')})\\b`));
  if (mon) {
    const ahead = monthsAhead(received, MONTHS.indexOf(mon[1]));
    return { urgency: ahead <= 3 ? 'now' : ahead <= 6 ? 'this_quarter' : 'exploring', why: `"${mon[1]}" is ${ahead} month(s) out` };
  }
  const season = t.match(/\b(spring|summer|fall|autumn|winter)\b/);
  if (season) {
    const idx = { spring: 2, summer: 5, fall: 8, autumn: 8, winter: 11 }[season[1] as 'spring'];
    const ahead = monthsAhead(received, idx);
    return { urgency: ahead <= 3 ? 'now' : ahead <= 6 ? 'this_quarter' : 'exploring', why: `"${season[1]}" is about ${ahead} month(s) out` };
  }
  const soon = t.match(/\b(next (year|quarter|fiscal)|20\d\d|budget|planning|contract cycle|renewals?|renegotiat\w*|this half)\b/);
  if (soon) return { urgency: 'this_quarter', why: `"${soon[0]}"` };
  const expl = t.match(/\b(exploring|evaluating|curious|just looking|early stage|no timeline|someday|testing)\b/);
  if (expl) return { urgency: 'exploring', why: `"${expl[0]}"` };
  return { urgency: null, why: 'no timing language' };
}

const SPAM_WORDS = /crypto|bitcoin|casino|forex|viagra|earn \$|click here|free money|https?:\/\//i;
const MASH = /^(asdf|qwer|zxcv|zzzz|xxxx|test|aaaa|hjkl)/i;

/** The model only reads words a person wrote. */
export function hasFreeText(n: Normalized): boolean { return !!n.message && n.message.length >= 3; }

export interface RulesInput { ev: LeadEvent; n: Normalized; res?: Resolution | null }

export function classifyRules({ ev, n, res }: RulesInput): Classification {
  const text = [n.message, n.title].filter(Boolean).join(' . ');
  const notes: string[] = [];
  const guide = String(ev.context.guide ?? '');
  const formId = String(ev.context.formId ?? '');

  // ---- disqualifier
  let disqualifier: Disqualifier = 'none';
  const mashed = [n.firstName, n.lastName, n.companyRaw].some(x => x && MASH.test(x));
  if (n.isDisposable) { disqualifier = 'spam'; notes.push('disposable email domain'); }
  else if (SPAM_WORDS.test(n.message ?? '') && /crypto|bitcoin|casino|forex|viagra|earn|click|free money/i.test(n.message ?? '')) { disqualifier = 'spam'; notes.push('spam vocabulary in message'); }
  else if (mashed) { disqualifier = 'spam'; notes.push('keyboard-mash name or company'); }
  else if (USE_CASE_KEYWORDS.job_seeker[0][0].test(text)) { disqualifier = 'job_seeker'; notes.push('job-seeker language'); }
  else if (USE_CASE_KEYWORDS.vendor_pitch[0][0].test(text)) { disqualifier = 'vendor_pitch'; notes.push('vendor-pitch language'); }
  else if (n.titleSeniority === 'student') { disqualifier = 'student'; notes.push(`student title "${n.title}"`); }
  else if (n.titleFunction === 'media') { disqualifier = 'media'; notes.push(`media title "${n.title}"`); }

  // ---- use case
  const scores = new Map<UseCase, number>();
  const add = (u: UseCase, pts: number, why: string) => { scores.set(u, (scores.get(u) ?? 0) + pts); notes.push(`${u} +${pts} (${why})`); };
  for (const [u, kws] of Object.entries(USE_CASE_KEYWORDS) as [UseCase, Kw[]][]) {
    if (u === 'job_seeker' || u === 'vendor_pitch') continue;
    for (const [re, pts, label] of kws) if (re.test(text)) add(u, pts, label);
  }
  const seg = res?.segment;
  if (seg === 'payer') { /* the compare/versus keyword carries the payer prior; no free points for just being a payer */ }
  if (['benefits_consultant_broker', 'tpa', 'employer_self_funded'].includes(seg ?? '')) add('network_design_benefits', 2, `segment ${seg}`);
  if (seg === 'innovator_api_data') add('data_platform_api', 3, 'segment innovator_api_data');
  if (seg === 'innovator_navigation') add('navigation_find_care', 2, 'segment innovator_navigation');
  if (seg === 'life_sciences') add('life_sciences_access', 3, 'segment life_sciences');
  if (seg === 'pe_investor') add('investment_diligence', 2, 'segment pe_investor');
  if (n.titleFunction === 'managed_care_contracting' || n.titleFunction === 'network_strategy') {
    if (['health_system', 'standalone_hospital', 'provider_group'].includes(seg ?? 'health_system')) add('contract_negotiation', 2, 'contracting title at a provider');
  }
  if (n.titleFunction === 'benefits') add('network_design_benefits', 1.5, 'benefits title');
  if (n.titleFunction === 'research_academic') add('research_media', 2, 'academic title');
  if (n.titleFunction === 'media') add('research_media', 3, 'media title');
  if (/health system executive guide/i.test(guide)) add('contract_negotiation', 2, `guide "${guide}"`);
  if (/benefits advisors/i.test(guide)) add('network_design_benefits', 3, `guide "${guide}"`);
  if (/life.?sciences/i.test(formId)) add('life_sciences_access', 3, `form ${formId}`);
  if (ev.source === 'marketplace' || ev.source === 'api_key') add('data_platform_api', 2, `source ${ev.source}`);
  if (ev.source === 'sample_signup' && Number(ev.context.sessions ?? 0) > 0) add('rate_benchmarking_market', 3 + (Number(ev.context.searches ?? 0) > 0 ? 1 : 0), 'product usage');

  let useCase: UseCase = 'other';
  let overrideScore: number | null = null; // set when a rule other than keyword scoring picked the use case
  if (disqualifier === 'job_seeker') useCase = 'job_seeker';
  else if (disqualifier === 'vendor_pitch') useCase = 'vendor_pitch';
  else if (disqualifier === 'spam') useCase = 'other';
  else if (seg === 'competitor') { useCase = 'other'; overrideScore = 4; }
  else {
    let best = 0;
    for (const u of TIE_ORDER) {
      const s = scores.get(u) ?? 0;
      if (s > best) { best = s; useCase = u; }
    }
    if (useCase === 'payer_competitive_intel' && seg !== 'payer') {
      // compare/versus only means competitive intel when the lead IS a payer
      scores.delete('payer_competitive_intel');
      best = 0; useCase = 'other';
      for (const u of TIE_ORDER) { const s = scores.get(u) ?? 0; if (s > best) { best = s; useCase = u; } }
    }
    if (best < 1.5) useCase = 'other';
  }
  if (seg === 'payer' && disqualifier === 'none' && useCase !== 'payer_competitive_intel' && USE_CASE_KEYWORDS.payer_competitive_intel[0][0].test(text) && !/\bapi\b|dataset|databricks/i.test(text)) {
    useCase = 'payer_competitive_intel';
    overrideScore = 3;
  }

  // ---- urgency
  const received = new Date(ev.receivedAt);
  const u = urgencyFromText(text, received);
  const when = parseWhen(n.message ?? '', ev.receivedAt); // the date parser reads only what the person wrote
  let urgency: Urgency;
  if (u.urgency) { urgency = u.urgency; notes.push(`urgency ${urgency}: ${u.why}`); }
  else if (['sample_signup', 'api_key', 'signal_ask_waitlist', 'marketplace'].includes(ev.source)) { urgency = 'exploring'; notes.push(`urgency exploring: ${ev.source} with no timeline`); }
  else { urgency = 'unknown'; notes.push('urgency unknown: no timing language'); }

  const buyingRole: BuyingRole = ['c_level', 'vp', 'director'].includes(n.titleSeniority) ? 'decision_maker'
    : n.titleSeniority === 'manager' ? 'influencer' : n.titleSeniority === 'unknown' ? 'unknown' : 'user';

  if (disqualifier === 'job_seeker' || disqualifier === 'vendor_pitch') overrideScore = 4;
  if (disqualifier === 'spam') overrideScore = 4;
  const ranked = [...scores.entries()].filter(([u]) => u !== useCase).map(([, v]) => v).sort((a, b) => b - a);
  const top = overrideScore ?? (scores.get(useCase) ?? 0);
  const runnerUp = ranked[0] ?? 0;
  const confidence = disqualifier !== 'none' ? 0.9 : useCase === 'other' ? 0.4 : Math.min(0.9, 0.5 + top / 10);
  return {
    reasons: ('rules: ' + notes.filter(x => x.startsWith(useCase) || !/ \+\d/.test(x)).join('; ')).slice(0, 240), useCase, urgency, buyingRole, disqualifier,
    confidence: Math.round(confidence * 100) / 100,
    evidence: {
      useCaseScore: top, useCaseRunnerUp: runnerUp,
      urgencyCue: when.cue, urgencyDate: when.date, urgencyDays: when.horizonDays, urgencyKind: when.kind, urgencyParsed: urgencyFromWhen(when),
      legacyUrgencyCue: u.urgency ? u.why : null, hasFreeText: hasFreeText(n), roleFromTitle: n.titleSeniority !== 'unknown',
    },
  };
}
