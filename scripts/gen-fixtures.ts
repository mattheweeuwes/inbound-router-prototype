// Generates fixtures/submissions.json and fixtures/gold-labels.json from the table below.
// People are synthetic; organizations are real, except the CRM accounts in fixtures/crm-mirror.json, which are fictional (.example domains)
// so that no real organization appears as a Serif customer, prospect or partner. Every payload carries "synthetic": true.
// Edit the table below and run `npm run gen-fixtures`. data/fixture-overrides.json is applied at load time, not here.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPayload, type PayloadSpec } from '../src/payloads';
import { ROOT } from '../src/config';
import type { Source } from '../src/schema';

const et = (day: string, hhmm: string) => new Date(`2026-11-${day}T${hhmm}:00-05:00`).toISOString(); // EST

interface Row {
  id: string; day: string; at: string; source: Source;
  first?: string; last?: string; title?: string; company?: string; domain?: string; state?: string; email?: string;
  message?: string; utm?: PayloadSpec['utm']; guide?: string; formId?: string; usage?: PayloadSpec['usage']; marketplace?: string; product?: PayloadSpec['product']; event?: string; notes?: string;
  copyOf?: string; sameContactAs?: string; payload?: Record<string, unknown>; note?: string;
  gold: Record<string, unknown>;
}

const sess = (n: number, day: string, start: string): NonNullable<PayloadSpec['usage']> =>
  Array.from({ length: n }, (_, i) => ({ event: 'session_start' as const, at: et(day, `${String(Number(start.slice(0, 2)) - 1).padStart(2, '0')}:${String(10 + i * 7).padStart(2, '0')}`) }));

const R: Row[] = [
  { id: 'F01', day: '04', at: '09:47', source: 'calendly_demo', first: 'Dana', last: 'Whitfield', title: 'VP Managed Care Contracting', company: 'Intermountain Health', domain: 'intermountainhealthcare.org', state: 'UT',
    utm: { source: 'LinkedIn ', medium: 'Paid-Social', campaign: 'hs-contracting-q4' }, message: 'Our commercial renegotiations start in January. We want to compare our rates to peer systems by service line.',
    gold: { segment: 'health_system', useCase: 'contract_negotiation', urgency: 'now', disqualifier: 'none', route: { team: 'HSP', action: 'rep_alert' } } },
  { id: 'F32', day: '05', at: '08:52', source: 'web_intent', company: 'Sutter Health', domain: 'sutterhealth.org',
    payload: { synthetic: true, domain: 'sutterhealth.org', company: 'Sutter Health', visitors: 2, window_days: 7, visits: [
      { path: '/platform/products/signal/', at: et('05', '08:12') }, { path: '/blog/signal-watch-monitoring-rate-changes-month-over-month', at: et('05', '08:19') },
      { path: '/platform/products/signal/', at: et('05', '08:41') }, { path: '/blog/signal-watch-monitoring-rate-changes-month-over-month', at: et('05', '08:52') }] },
    gold: { segment: 'health_system', route: { action: 'account_signal' } } },
  { id: 'F02', day: '05', at: '09:18', source: 'guide_download', first: 'Marcus', last: 'Bell', title: 'Director, Payer Strategy', company: 'Sutter Health', domain: 'sutterhealth.org', state: 'CA', guide: 'Health System Executive Guide', formId: 'gd_health_system_exec',
    gold: { segment: 'health_system', useCase: 'contract_negotiation', urgency: 'unknown', disqualifier: 'none', route: { team: 'HSP', action: 'team_queue' } } },
  { id: 'F03', day: '05', at: '09:41', source: 'calendly_demo', first: 'Priya', last: 'Raman', title: 'Senior Analyst, Decision Support', company: 'OhioHealth', domain: 'ohiohealth.com', state: 'OH',
    utm: { source: 'google', medium: 'cpc', campaign: 'brand' }, message: "We want a market rate view for orthopedics and cardiology for next year's budget.",
    gold: { segment: 'health_system', useCase: 'rate_benchmarking_market', urgency: 'this_quarter', disqualifier: 'none', route: { team: 'HSP' } } },
  { id: 'F04', day: '05', at: '10:05', source: 'sample_signup', first: 'Hannah', last: 'Price', title: 'Managed Care Analyst', company: 'Tanner Health', domain: 'tanner.org', state: 'GA',
    usage: [...sess(5, '05', '10:05'), { event: 'search', code: 'CPT 27447', market: 'GA', at: et('05', '09:40') }, { event: 'search', code: 'CPT 29881', market: 'GA', at: et('05', '09:48') }],
    gold: { segment: 'health_system', useCase: 'rate_benchmarking_market', urgency: 'exploring', disqualifier: 'none', route: { team: 'HSP' } } },
  { id: 'F05', day: '05', at: '10:32', source: 'calendly_demo', first: 'Robert', last: 'Kline', title: 'Director of Network Management', company: 'Brookmere Health Plan', domain: 'brookmerehealth.example', state: 'MI',
    message: 'We want to compare our professional fee schedules against competing plans in Detroit and Grand Rapids before a 2027 strategy session.',
    gold: { segment: 'payer', useCase: 'payer_competitive_intel', urgency: 'this_quarter', disqualifier: 'none', route: { team: 'PLS', owner: 'Casey' } } },
  { id: 'F06', day: '05', at: '10:50', source: 'guide_download', first: 'Elena', last: 'Ruiz', title: 'Provider Network Data Manager', company: 'Priority Health', domain: 'priorityhealth.com', state: 'MI', guide: 'Definitive Guide to Data Quality', formId: 'gd_data_quality',
    gold: { segment: 'payer', useCase: 'other', urgency: 'unknown', disqualifier: 'none', route: { team: 'PLS' } } },
  { id: 'F07', day: '05', at: '11:12', source: 'calendly_demo', first: 'Tom', last: 'Gallagher', title: 'SVP Benefits Consulting', company: 'Alder & Finch Benefits', domain: 'alderfinch.example',
    utm: { source: 'li', medium: 'paidsocial', campaign: 'benefits-advisors' }, message: 'Several of our self-funded clients renew in Q1. We need network benchmarking for broker RFPs.',
    gold: { segment: 'benefits_consultant_broker', useCase: 'network_design_benefits', urgency: 'now', disqualifier: 'none', route: { team: 'BW', owner: 'Morgan' } } },
  { id: 'F08', day: '05', at: '11:40', source: 'guide_download', first: 'Jasmine', last: 'Cole', title: 'Benefits Advisor', company: 'Hylant', domain: 'hylant.com', state: 'OH', guide: 'Cost Intelligence Playbook for Benefits Advisors', formId: 'gd_cost_intelligence',
    gold: { segment: 'benefits_consultant_broker', useCase: 'network_design_benefits', urgency: 'unknown', disqualifier: 'none', route: { action: 'nurture' } } },
  { id: 'F09', day: '05', at: '12:15', source: 'calendly_demo', first: 'Brian', last: 'Mendez', title: 'Director of Total Rewards', company: 'Mohawk Industries', domain: 'mohawkind.com', state: 'GA',
    utm: { source: 'newsletter', medium: 'email', campaign: 'monthly-digest' }, message: 'We are self-funded with about 20,000 members. Is our network discount real before our January renewal?',
    gold: { segment: 'employer_self_funded', useCase: 'network_design_benefits', urgency: 'now', disqualifier: 'none', route: { team: 'BW', action: 'rep_alert' } } },
  { id: 'F10', day: '05', at: '12:48', source: 'marketplace', marketplace: 'Databricks', first: 'Ana', last: 'Petrov', title: 'Head of Data Engineering', company: 'Highmark Health', domain: 'highmarkhealth.org', state: 'PA',
    message: 'Interested in the bulk negotiated-rate dataset via Databricks. What is the coverage for PA and WV, and what is the refresh cadence? Scoping for a Q2 start.',
    gold: { segment: 'payer', useCase: 'data_platform_api', urgency: 'this_quarter', disqualifier: 'none', route: { team: 'API' } } },
  { id: 'F11', day: '05', at: '13:20', source: 'api_key', product: 'mcp', first: 'Leo', last: 'Chen', title: 'Software Engineer', company: 'Paytient', domain: 'paytient.com', message: 'Testing the Find Care MCP for a cost-estimate feature.',
    gold: { segment: 'innovator_api_data', useCase: 'data_platform_api', urgency: 'exploring', disqualifier: 'none', route: { action: 'nurture' } } },
  { id: 'F12', day: '05', at: '13:44', source: 'signal_ask_waitlist', first: 'Grace', last: 'Holloway', title: 'Manager, Payer Contracting', company: 'Atrium Health', domain: 'atriumhealth.org', state: 'NC', message: 'Our team spends days pulling rate comparisons by hand.',
    gold: { segment: 'health_system', useCase: 'contract_negotiation', urgency: 'exploring', disqualifier: 'none', route: { team: 'HSP' } } },
  { id: 'F13', day: '05', at: '14:10', source: 'event_scan', event: 'HFMA', first: 'Derrick', last: 'Lane', title: 'Revenue Cycle Director', company: 'Tanner Health', domain: 'tanner.org', state: 'GA', notes: 'asked about service-line benchmarks',
    gold: { segment: 'health_system', useCase: 'rate_benchmarking_market', urgency: 'unknown', disqualifier: 'none', route: { team: 'HSP' } } },
  { id: 'F14', day: '05', at: '14:35', source: 'calendly_demo', first: 'Samuel', last: 'Ortiz', title: 'Chief Financial Officer', company: 'Jefferson Healthcare', domain: 'jeffersonhealthcare.org', state: 'WA',
    message: 'We are a small independent hospital. Are our commercial rates below market before the next contract cycle next spring?',
    gold: { segment: 'standalone_hospital', useCase: 'contract_negotiation', urgency: 'this_quarter', disqualifier: 'none', route: { team: 'HSP' } } },
  { id: 'F15', day: '05', at: '15:02', source: 'calendly_demo', first: 'Nina', last: 'Alvarez', title: 'VP Strategy & Business Development', company: 'Transcarent', domain: 'transcarent.com',
    message: 'We want rate data to power member-facing cost estimates in our navigation product. Roadmap planning is for next quarter.',
    gold: { segment: 'innovator_navigation', useCase: 'navigation_find_care', urgency: 'this_quarter', disqualifier: 'none', route: { team: 'API' } } },
  { id: 'F16', day: '05', at: '15:30', source: 'guide_download', first: 'Rachel', last: 'Kim', title: 'Director, Market Access Analytics', company: 'Genentech', domain: 'gene.com', guide: 'State of the Data', formId: 'gd_life_sciences',
    gold: { segment: 'life_sciences', useCase: 'life_sciences_access', urgency: 'unknown', disqualifier: 'none', route: { action: 'nurture' } } },
  { id: 'F17', day: '05', at: '15:58', source: 'calendly_demo', first: 'Owen', last: 'Brooks', title: 'VP Value Creation', company: 'Cressey & Company', domain: 'cresseyco.com',
    message: 'We need negotiated-rate benchmarks for two provider-platform diligences we are running now. Our investment committee meets in early December.',
    gold: { segment: 'pe_investor', useCase: 'investment_diligence', urgency: 'now', disqualifier: 'none', route: { team: 'PLS' } } },
  { id: 'F18', day: '05', at: '16:25', source: 'calendly_demo', first: 'Claire', last: 'Donovan', title: 'Principal', company: 'Chartis', domain: 'chartis.com', message: 'We are looking for a data license for an advisory team supporting health-system clients.',
    gold: { segment: 'consulting_advisory', useCase: 'data_platform_api', urgency: 'unknown', disqualifier: 'none', route: { team: 'PLS' } } },
  { id: 'F19', day: '05', at: '16:50', source: 'calendly_demo', first: 'Victor', last: 'Hale', title: 'Chief Contracting Officer', company: 'US Anesthesia Partners', domain: 'usap.com', state: 'TX',
    message: 'Anesthesia rates vary across markets. We need payer-by-payer benchmarks for the 2027 contract cycle.',
    gold: { segment: 'provider_group', useCase: 'contract_negotiation', urgency: 'this_quarter', disqualifier: 'none', route: { team: 'HSP' } } },
  { id: 'F20', day: '05', at: '17:20', source: 'calendly_demo', first: 'Jordan', last: 'Meyers', title: 'Health Reporter', company: 'STAT', domain: 'statnews.com',
    message: 'I am working on a story on hospital price variation. Could I get a comment and a data walkthrough?',
    gold: { segment: 'media', useCase: 'research_media', urgency: 'unknown', disqualifier: 'media', route: { action: 'press' } } },
  { id: 'F21', day: '06', at: '08:30', source: 'sample_signup', first: 'Ethan', last: 'Park', title: 'Graduate Student', company: 'Georgia Tech', domain: 'gatech.edu', message: 'I am writing a thesis on price transparency and would like sample data.',
    usage: [{ event: 'session_start', at: et('06', '08:20') }],
    gold: { segment: 'academic', useCase: 'research_media', urgency: 'exploring', disqualifier: 'student', route: { action: 'nurture' } } },
  { id: 'F22', day: '06', at: '08:55', source: 'calendly_demo', first: 'Chris', last: 'Doyle', title: 'Data Engineer', domain: 'gmail.com', message: 'I am not a buyer. I would love to join your team. Are you hiring?',
    gold: { segment: 'unknown_org', useCase: 'job_seeker', urgency: 'unknown', disqualifier: 'job_seeker', route: { action: 'careers' } } },
  { id: 'F23', day: '06', at: '09:10', source: 'calendly_demo', first: 'Ava', last: 'Sterling', title: 'Growth Partner', company: 'BrightPath Agency', domain: 'brightpath-agency.example', message: 'Quick pitch from an SEO agency. Do you have 15 minutes?',
    gold: { segment: 'unknown_org', useCase: 'vendor_pitch', urgency: 'unknown', disqualifier: 'vendor_pitch', route: { action: 'drop' } } },
  { id: 'F24', day: '06', at: '09:34', source: 'sample_signup', first: 'Liam', last: 'Foster', title: 'Product Analyst', company: 'Turquoise Health', domain: 'turquoise.health', usage: sess(2, '06', '09:34'),
    gold: { segment: 'competitor', useCase: 'other', urgency: 'unknown', disqualifier: 'none', route: { action: 'competitor_flag' } } },
  { id: 'F25', day: '06', at: '09:58', source: 'calendly_demo', first: 'Monica', last: 'Reyes', title: 'Payer Contracting Manager', company: 'Northside Hospital', domain: 'outlook.com', state: 'GA',
    message: 'I am prepping a commercial renegotiation and need rate comparisons in metro Atlanta.',
    gold: { segment: 'health_system', useCase: 'contract_negotiation', urgency: 'this_quarter', disqualifier: 'none', route: { team: 'HSP', action: 'rep_alert' }, flags: ['free_mail'] } },
  { id: 'F26', day: '06', at: '10:20', source: 'guide_download', sameContactAs: 'F01', first: 'Dana', last: 'Whitfield', title: 'VP Managed Care Contracting', company: 'Intermountain Health', domain: 'intermountainhealthcare.org', state: 'UT', guide: 'Health System Executive Guide', formId: 'gd_health_system_exec',
    note: 'Same contact as F01, two days later. Must attach to the first lead, keep its owner, and not alert again.',
    gold: { segment: 'health_system', route: { action: 'attach_to_existing', ownerSameAs: 'F01' } } },
  { id: 'F27', day: '06', at: '10:41', source: 'calendly_demo', copyOf: 'F03', first: 'Priya', last: 'Raman', domain: 'ohiohealth.com', note: 'Webhook re-delivery of F03: identical body, same sourceEventId. Must be a no-op.',
    gold: { noop: true } },
  { id: 'F28', day: '06', at: '11:05', source: 'calendly_demo', first: 'Paul', last: 'Novak', title: 'Director, Managed Care Analytics', company: 'Wrenfield Health', domain: 'wrenfieldhealth.example', state: 'PA',
    message: 'We use Signal today. I want the API for our data warehouse, scoped for next quarter.',
    gold: { segment: 'health_system', useCase: 'data_platform_api', urgency: 'this_quarter', disqualifier: 'none', route: { owner: 'Avery' } } },
  { id: 'F29', day: '06', at: '11:30', source: 'calendly_demo', first: 'Lauren', last: 'Price', title: 'Managed Care Director', company: 'Baptist Health', domain: 'gmail.com', message: 'I am benchmarking commercial rates.',
    gold: { route: { action: 'review' } } },
  { id: 'F30', day: '06', at: '11:52', source: 'guide_download', first: 'asdf', last: 'qwer', company: 'zzzz', email: 'xk29@mailinator.com', domain: 'mailinator.com', guide: 'State of the Data', formId: 'gd_state_of_data', message: 'Make money with crypto! https://example.invalid/win',
    gold: { disqualifier: 'spam', route: { action: 'drop' } } },
  { id: 'F31', day: '06', at: '12:15', source: 'sample_signup', first: 'Oliver', last: 'Grant', title: 'Commissioning Analyst', company: 'NHS', domain: 'nhs.net', usage: sess(1, '06', '12:15'),
    gold: { segment: 'non_us', route: { action: 'nurture' } } },
  { id: 'F33', day: '06', at: '13:00', source: 'calendly_demo', first: 'Isabel', last: 'Grant', title: 'Director of Network Contracting', company: 'Meritain Health', domain: 'meritain.com',
    message: 'Our self-funded clients ask for network comparisons at renewal. I want a repeatable way to produce them.',
    gold: { segment: 'tpa', useCase: 'network_design_benefits', urgency: 'this_quarter', disqualifier: 'none', route: { team: 'BW' } } },
  { id: 'F34', day: '06', at: '13:30', source: 'guide_download', first: 'Hector', last: 'Silva', title: 'Benefits Manager', company: 'City of Atlanta', domain: 'atlantaga.gov', state: 'GA', guide: 'Cost Intelligence Playbook for Benefits Advisors', formId: 'gd_cost_intelligence',
    gold: { segment: 'government', useCase: 'network_design_benefits', urgency: 'unknown', disqualifier: 'none', route: { action: 'nurture' } } },
  { id: 'F35', day: '06', at: '14:10', source: 'calendly_demo', first: 'Mei', last: 'Tanaka', title: 'Director, Payer Relations', company: 'Johns Hopkins Medicine', domain: 'jhmi.edu', state: 'MD',
    message: 'We want peer benchmarks for the professional fee schedule ahead of renewals.',
    gold: { segment: 'health_system', useCase: 'contract_negotiation', urgency: 'this_quarter', disqualifier: 'none', route: { team: 'HSP', action: 'rep_alert' } } },
  { id: 'F36', day: '06', at: '14:45', source: 'sample_signup', first: 'Kofi', last: 'Mensah', title: 'Pricing Analyst', company: 'Baptist Health South Florida', domain: 'baptisthealth.net', state: 'FL',
    usage: [...sess(2, '06', '14:45'), { event: 'search', code: 'DRG 470', market: 'Miami', at: et('06', '14:30') }],
    gold: { segment: 'health_system', useCase: 'rate_benchmarking_market', urgency: 'exploring', disqualifier: 'none', route: { team: 'HSP' } } },
  { id: 'F37', day: '06', at: '15:20', source: 'marketplace', marketplace: 'Snowflake', first: 'Daniel', last: 'Wright', title: 'Director, Data Partnerships', company: 'Zelis', domain: 'zelis.com',
    message: 'Exploring a data partnership to enrich our price-transparency products.',
    gold: { segment: 'innovator_api_data', useCase: 'data_platform_api', urgency: 'exploring', disqualifier: 'none', route: { team: 'API' } } },
  { id: 'F38', day: '06', at: '16:00', source: 'calendly_demo', first: 'Sofia', last: 'Martins', title: 'Senior Manager, Provider Reimbursement', company: 'Independence Blue Cross', domain: 'ibx.com', state: 'PA',
    message: 'Where do our facility rates sit versus other plans in Philadelphia? Budget planning starts in December.',
    gold: { segment: 'payer', useCase: 'payer_competitive_intel', urgency: 'now', disqualifier: 'none', route: { team: 'PLS', action: 'rep_alert' } } },
  { id: 'F39', day: '06', at: '16:40', source: 'event_scan', event: 'RSNA', first: 'Gabriel', last: 'Stone', title: 'VP Commercial Strategy', company: 'RAYUS Radiology', domain: 'rayusradiology.com', notes: 'imaging rates by market',
    gold: { segment: 'provider_group', useCase: 'rate_benchmarking_market', urgency: 'unknown', disqualifier: 'none', route: { action: 'nurture' } } },
  { id: 'F40', day: '06', at: '21:12', source: 'calendly_demo', first: 'Hannah', last: 'Brooks', title: 'Executive Director, Managed Care', company: 'Piedmont Healthcare', domain: 'piedmont.org', state: 'GA',
    message: 'A major commercial contract renews in spring and talks start next month. We need benchmarks fast.',
    gold: { segment: 'health_system', useCase: 'contract_negotiation', urgency: 'now', disqualifier: 'none', route: { team: 'HSP', action: 'rep_alert' }, flags: ['after_hours'] } },
];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
const submissions: unknown[] = [];
const gold: Record<string, unknown> = {};
const byId = new Map<string, Row>(R.map(r => [r.id, r]));

for (const r of R) {
  const ts = et(r.day, r.at);
  let payload: Record<string, unknown>;
  const src = r.copyOf ? byId.get(r.copyOf)! : r;
  if (r.payload) payload = r.payload;
  else {
    const email = src.email ?? `${slug(src.first!).slice(0, 1)}${slug(src.last!)}@${src.domain}`;
    // the payload timestamp is when the person acted; for a re-delivery it is the original's
    const payloadTs = r.copyOf ? et(src.day, src.at) : ts;
    payload = buildPayload(src.source, {
      first: src.first!, last: src.last!, email, title: src.title, company: src.company, state: src.state, message: src.message, ts: payloadTs,
      utm: src.utm, guide: src.guide, formId: src.formId, usage: src.usage, marketplace: src.marketplace, product: src.product, event: src.event, notes: src.notes,
      pageUrl: src.guide ? `https://example.org/prototype/resources/${slug(src.guide)}` : undefined, seed: src.id,
    });
  }
  submissions.push({ id: r.id, ts, source: r.source, ...(r.copyOf ? { copyOf: r.copyOf } : {}), ...(r.sameContactAs ? { sameContactAs: r.sameContactAs } : {}), ...(r.note ? { note: r.note } : {}), payload });
  gold[r.id] = r.gold;
}
submissions.sort((a: any, b: any) => Date.parse(a.ts) - Date.parse(b.ts));
const dir = join(ROOT, 'fixtures');
writeFileSync(join(dir, 'submissions.json'), JSON.stringify(submissions, null, 2) + '\n');
writeFileSync(join(dir, 'gold-labels.json'), JSON.stringify(gold, null, 2) + '\n');
console.log(`wrote ${submissions.length} fixtures`);
