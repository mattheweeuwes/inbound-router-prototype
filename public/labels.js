// The words the cockpit uses for the router's codes: doors, segments, actions, teams, use cases and so on. One place, so the Lead
// stream's search matches what its rows say and the trail reads the same way. No DOM in here.

/** @type {Record<string, Record<string, string>>} */
export const L = {
  source: {
    calendly_demo: 'Demo request', guide_download: 'Guide download', signal_ask_waitlist: 'Signal Ask waitlist',
    sample_signup: 'Try Signal', marketplace: 'Marketplace', api_key: 'API key', event_scan: 'Event scan', web_intent: 'Web intent',
  },
  segment: {
    health_system: 'Health system', standalone_hospital: 'Hospital', provider_group: 'Provider group', payer: 'Payer',
    benefits_consultant_broker: 'Benefits consultant / broker', tpa: 'TPA', employer_self_funded: 'Self-funded employer',
    innovator_navigation: 'Navigation', innovator_api_data: 'Data / API', life_sciences: 'Life sciences', pe_investor: 'PE / investor',
    consulting_advisory: 'Advisory', government: 'Public employer', academic: 'Academic', media: 'Media', competitor: 'Competitor',
    non_us: 'Outside the US', unknown_org: 'Unknown org',
  },
  action: {
    rep_alert: 'Rep alert', owner_task: 'Owner task', team_queue: 'Team queue', nurture: 'Nurture', review: 'Needs a person',
    careers: 'Careers reply', press: 'Press', competitor_flag: 'Competitor flag', drop: 'Dropped', account_signal: 'Account signal',
    attach_to_existing: 'Attached to first lead', replay: 'Replay ignored',
  },
  team: {
    HSP: 'Health Systems & Providers', BW: 'Benefits & Workforce', PLS: 'Payers, Life Sciences & Advisory', API: 'Data & API Partnerships',
    Review: 'Review', Nurture: 'Nurture',
  },
  useCase: {
    contract_negotiation: 'Contract negotiation', rate_benchmarking_market: 'Market rate benchmarking', payer_competitive_intel: 'Payer competitive intel',
    network_design_benefits: 'Network design (benefits)', navigation_find_care: 'Navigation / find care', data_platform_api: 'Data platform / API',
    life_sciences_access: 'Life sciences access', investment_diligence: 'Investment diligence', research_media: 'Research / media',
    job_seeker: 'Job seeker', vendor_pitch: 'Vendor pitch', other: 'Other',
  },
  urgency: { now: 'Now', this_quarter: 'This quarter', exploring: 'Exploring', unknown: 'Unknown' },
  role: { decision_maker: 'Decision maker', influencer: 'Influencer', user: 'User', unknown: 'Unknown' },
  disq: { none: 'None', job_seeker: 'Job seeker', vendor_pitch: 'Vendor pitch', student: 'Student', media: 'Media', spam: 'Spam', competitor: 'Competitor' },
  method: {
    curated_domain: 'Curated domain list', org_domain: 'Verified org domain', company_name: 'Company-name match',
    site_title: 'Homepage-title match', nppes: 'NPPES organization NPI', tld_heuristic: 'Domain type', tld: 'Domain type (TLD)', inferred: 'Inferred employer', crm: 'CRM account', person: 'Chosen by a person', none: 'Not matched',
  },
  fn: {
    managed_care_contracting: 'Managed care / contracting', network_strategy: 'Network strategy', benefits: 'Benefits',
    revenue_cycle_finance: 'Finance / revenue cycle', strategy_bd: 'Strategy / BD', analytics_data: 'Analytics / data',
    product_engineering: 'Product / engineering', executive: 'Executive', clinical: 'Clinical', marketing_sales: 'Marketing / sales',
    research_academic: 'Research / academic', media: 'Media', hr_recruiting: 'HR / recruiting', other: 'Other',
  },
  seniority: { c_level: 'C-level', vp: 'VP', director: 'Director', manager: 'Manager', individual: 'Individual contributor', student: 'Student', unknown: 'Unknown' },
  channel: {
    paid_social: 'Paid social', paid_search: 'Paid search', organic_search: 'Organic search', organic_social: 'Organic social', email: 'Email',
    referral: 'Referral', partner_marketplace: 'Partner marketplace', event: 'Event', product: 'Product', direct: 'Direct', unknown: 'Unknown',
  },
  flag: {
    free_mail: 'free-mail', duplicate: 'repeat', review: 'review', competitor: 'competitor', after_hours: 'after hours',
    existing_account: 'owned account', idempotent_replay: 'replay', in_digest: 'in a list digest',
  },
};
/**
 * The words for a code, or the fallback (a dash) when there is none. A code the table does not know is shown with its underscores as spaces.
 * @param {string} map which table: 'source', 'segment', 'action', 'team', 'useCase' and so on
 * @param {string | null | undefined} v
 * @param {string} [fallback]
 */
export const lab = (map, v, fallback) => (v == null || v === '' ? (fallback ?? '—') : (L[map][v] ?? String(v).replace(/_/g, ' ')));

export const teamName = (/** @type {string | null | undefined} */ t) => (t ? (L.team[t] ?? t) : '');
