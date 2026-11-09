// Canonical types. Everything that crosses a module boundary is declared here.

export type Source =
  | 'calendly_demo' | 'guide_download' | 'signal_ask_waitlist' | 'sample_signup'
  | 'marketplace' | 'api_key' | 'event_scan' | 'web_intent';

export const SOURCES: Source[] = [
  'calendly_demo', 'guide_download', 'signal_ask_waitlist', 'sample_signup',
  'marketplace', 'api_key', 'event_scan', 'web_intent',
];

export interface Utm { source?: string; medium?: string; campaign?: string; content?: string; term?: string }

export interface LeadEvent {
  source: Source;
  sourceEventId: string;
  receivedAt: string; // ISO UTC
  synthetic: boolean;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  state: string | null;
  country: string | null;
  message: string | null;
  utm: Utm;
  landingPage: string | null;
  referrer: string | null;
  context: Record<string, unknown>; // source-specific: guide, usage, pageViews, marketplace, event, product, domain
  raw: unknown;
}

export type TitleFunction =
  | 'managed_care_contracting' | 'network_strategy' | 'benefits' | 'revenue_cycle_finance' | 'strategy_bd'
  | 'analytics_data' | 'product_engineering' | 'executive' | 'clinical' | 'marketing_sales'
  | 'research_academic' | 'media' | 'hr_recruiting' | 'other';

export type TitleSeniority = 'c_level' | 'vp' | 'director' | 'manager' | 'individual' | 'student' | 'unknown';

export type Channel =
  | 'paid_social' | 'paid_search' | 'organic_search' | 'organic_social' | 'email' | 'referral'
  | 'partner_marketplace' | 'event' | 'product' | 'direct' | 'unknown';

export interface Normalized {
  email: string | null;
  emailDomain: string | null;
  isFreeMail: boolean;
  isDisposable: boolean;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  titleFunction: TitleFunction;
  titleSeniority: TitleSeniority;
  companyRaw: string | null;
  companyDomain: string | null; // null for free-mail / disposable
  state: string | null;
  country: string | null;
  message: string | null;
  utm: Utm;
  utmFixes: { field: string; from: string; to: string }[];
  channel: Channel;
  landingPage: string | null;
  referrer: string | null;
  contactKey: string | null;
}

export type Segment =
  | 'health_system' | 'payer' | 'benefits_consultant_broker' | 'tpa' | 'life_sciences' | 'standalone_hospital'
  | 'employer_self_funded' | 'innovator_navigation' | 'innovator_api_data' | 'provider_group' | 'pe_investor'
  | 'consulting_advisory' | 'unknown_org' | 'government' | 'academic' | 'non_us' | 'media' | 'competitor';

export type Confidence = 'high' | 'medium' | 'low';

export type ResolveMethod =
  | 'curated_domain' | 'org_domain' | 'company_name' | 'site_title' | 'nppes' | 'tld' | 'inferred' | 'crm' | 'none';

export interface Candidate { accountId: string; name: string; kind: string; state: string | null; score: number }

export interface Firmographics {
  hospitals?: number | null; beds?: number | null; states?: string[]; ccns?: string[];
  npi?: string | null; npis?: string[]; payerKind?: string | null; taxonomy?: string | null;
  cmsType?: string | null; ownership?: string | null; rating?: number | null; sizeClass?: string | null;
}

export interface Resolution {
  status: 'resolved' | 'ambiguous' | 'unresolved';
  accountId: string | null;
  accountName: string | null;
  segment: Segment;
  subsegment: string | null;
  confidence: Confidence;
  method: ResolveMethod;
  matchScore: number | null;
  evidence: { step: string; detail: string }[];
  firmographics: Firmographics;
  candidates: Candidate[];
  inferred: boolean;
}

export const USE_CASES = [
  'contract_negotiation', 'rate_benchmarking_market', 'payer_competitive_intel', 'network_design_benefits',
  'navigation_find_care', 'data_platform_api', 'life_sciences_access', 'investment_diligence',
  'research_media', 'job_seeker', 'vendor_pitch', 'other',
] as const;
export type UseCase = typeof USE_CASES[number];

export const URGENCIES = ['now', 'this_quarter', 'exploring', 'unknown'] as const;
export type Urgency = typeof URGENCIES[number];

export const BUYING_ROLES = ['decision_maker', 'influencer', 'user', 'unknown'] as const;
export type BuyingRole = typeof BUYING_ROLES[number];

export const DISQUALIFIERS = ['none', 'job_seeker', 'vendor_pitch', 'student', 'media', 'spam'] as const;
export type Disqualifier = typeof DISQUALIFIERS[number];

export interface RulesEvidence {
  useCaseScore: number;        // keyword score of the winning use case
  useCaseRunnerUp: number;     // keyword score of the next best
  urgencyCue: string | null;   // the phrase the date parser decided on ("mid-January"), or null when the message had no timing language
  urgencyDate: string | null;  // the concrete date it resolved to (yyyy-mm-dd)
  urgencyDays: number | null;  // days from receipt to that date (0 for asap)
  urgencyKind: 'asap' | 'deadline' | 'budget' | 'exploring' | 'none';
  urgencyParsed: Urgency | null; // what the parser maps that to; null when kind is none
  legacyUrgencyCue: string | null; // the round-2 keyword cue, kept so combine v2 can still be reproduced
  hasFreeText: boolean;        // the lead includes words a person wrote
  roleFromTitle: boolean;      // the title gave a seniority, so buying role does not need the model
}

export type FieldSource = 'rules' | 'model' | 'default'; // default: nothing decided it, so the door default or unknown stands
export interface FieldSources { useCase: FieldSource; urgency: FieldSource; buyingRole: FieldSource; disqualifier: FieldSource }

export interface Classification {
  reasons: string;
  useCase: UseCase;
  urgency: Urgency;
  buyingRole: BuyingRole;
  disqualifier: Disqualifier;
  confidence: number;
  evidence?: RulesEvidence;   // rules output only
  sources?: FieldSources;     // final output only: which side decided each field
}

export interface Qualification {
  provider: string;
  promptVersion: string;
  combineVersion: string;
  latencyMs: number;
  llm: Classification | null;
  rules: Classification;
  final: Classification;
  agreement: { useCase: boolean; urgency: boolean; buyingRole: boolean; disqualifier: boolean } | null;
  fallbackReason: string | null;
  reviewReason: string | null; // llm_only_disqualifier
  llmDisqualifier: Disqualifier | null; // what the model said before the guardrail (null when it said none or did not run)
}

export interface ScoreItem { group: 'fit' | 'intent'; label: string; points: number }
export interface Score { total: number; fit: number; intent: number; tier: Tier; items: ScoreItem[] }
export type Tier = 'A' | 'B' | 'C' | 'D' | 'X';

export type RouteAction =
  | 'drop' | 'attach_to_existing' | 'competitor_flag' | 'careers' | 'press' | 'nurture' | 'owner_task'
  | 'rep_alert' | 'team_queue' | 'review' | 'account_signal';
export type Team = 'HSP' | 'BW' | 'PLS' | 'API' | 'Nurture' | 'Review';

export interface Route {
  action: RouteAction;
  team: Team;
  owner: string;
  rule: string; // R1..R9
  reason: string;
  slaMinutes: number | null;
  slaDueAt: string | null;
  sequence?: string | null; // nurture track
  alertSuppressed?: boolean;
}

export interface CrmRequest { method: 'POST' | 'PUT' | 'PATCH'; path: string; body: unknown; note?: string }

export interface Owners {
  teams: Record<string, { name: string; reps: { name: string; hubspotOwnerId: string; capacity: number }[] }>;
  queues: Record<string, { owner: string; hubspotOwnerId: string }>;
}

export interface CrmMirrorEntry {
  id: string; name: string; status: string; owner: string; segment: Segment; firmographics?: Firmographics; domains: string[]; nameContains: string[]; note: string;
}
