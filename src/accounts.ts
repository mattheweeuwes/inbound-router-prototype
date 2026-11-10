// Read model for GET /api/accounts and GET /api/accounts/<key>: the accounts the router holds, enterprise accounts first.
// The logic is in the views (sql/models/v_accounts.sql) and their reads (src/store/accountViews.ts); this file shapes rows
// into the API's types and adds the one thing SQL cannot see, the seeded CRM owner from fixtures/crm-mirror.json.
import type { Ctx } from './context';
import { matchMirror } from './mirror';
import type { AccountPersonRow, AccountRow, AccountSignalRow } from './store/accountViews';

export const ACCOUNTS_DEFAULT_LIMIT = 50;
export const ACCOUNTS_MAX_LIMIT = 500;
/** People and signals listed on one account; an account with more says how many it has in its 30-day counts. */
const DETAIL_ROWS = 50;

export const SIGNAL_KINDS = ['web_intent', 'claim', 'referral_in', 'referral_out', 'deal_cue'] as const;
export type SignalKind = typeof SIGNAL_KINDS[number];
const isSignalKind = (k: string): k is SignalKind => (SIGNAL_KINDS as readonly string[]).includes(k);

export interface AccountSummary {
  key: string;
  name: string | null;
  segment: string | null;
  enterprise: boolean;
  /** the fact line behind the flag ("145 hospitals in 20 states"), or what is known when it is not enterprise */
  enterpriseFact: string | null;
  /** the CRM owner, else the rep who claimed it on a rep alert, else null */
  owner: string | null;
  ownerSource: 'crm' | 'claim' | null;
  /** the highest lead score at the account in the last 30 days, and that lead's tier */
  accountScore: number;
  topTier: string | null;
  leads30d: number;
  contacts30d: number;
  lastActivityAt: string | null;
  referralsIn: number;
  referralsOut: number;
  webIntentSignals: number;
  /** the rate file has a group linked to this account, or a lead here carried its rate line */
  hasRateFact: boolean;
  openReviews: number;
}

export interface AccountPerson {
  leadId: string; name: string; title: string | null; door: string; tier: string | null; score: number | null;
  routeAction: string | null; owner: string | null; receivedAt: string;
}

export interface AccountSignal { kind: SignalKind; detail: string; leadId: string | null; at: string }

export interface AccountReview { leadId: string; reason: string; createdAt: string }

export interface AccountDetail extends AccountSummary {
  domain: string | null;
  people: AccountPerson[];
  signals: AccountSignal[];
  /** the rate line a lead here carried, when one did */
  rateLine: string | null;
  reviews: AccountReview[];
}

/** What names an account to the CRM mirror and to a claim: its domain and name, and the rep who claimed it on a rep alert. */
export type AccountIdentity = Pick<AccountRow, 'domain' | 'name' | 'claimed_owner'>;

/** The CRM owner, else the rep who claimed the account, else nobody. */
export function ownerOf(ctx: Ctx, r: AccountIdentity): Pick<AccountSummary, 'owner' | 'ownerSource'> {
  const crm = matchMirror(ctx.mirror, r.domain, r.name);
  if (crm) return { owner: crm.owner, ownerSource: 'crm' };
  return r.claimed_owner ? { owner: r.claimed_owner, ownerSource: 'claim' } : { owner: null, ownerSource: null };
}

/** Whether the CRM mirror holds the account as a customer. */
export const isCustomerAccount = (ctx: Ctx, r: Pick<AccountIdentity, 'domain' | 'name'>): boolean =>
  matchMirror(ctx.mirror, r.domain, r.name)?.status === 'customer';

function toSummary(ctx: Ctx, r: AccountRow): AccountSummary {
  return {
    key: r.account_key, name: r.name, segment: r.segment, enterprise: !!r.enterprise, enterpriseFact: r.enterprise_fact, ...ownerOf(ctx, r),
    accountScore: Number(r.account_score), topTier: r.top_tier, leads30d: Number(r.leads_30d), contacts30d: Number(r.contacts_30d),
    lastActivityAt: r.last_activity_at, referralsIn: Number(r.referrals_in), referralsOut: Number(r.referrals_out),
    webIntentSignals: Number(r.web_intent_signals), hasRateFact: !!r.has_rate_fact, openReviews: Number(r.open_reviews),
  };
}

const toPerson = (p: AccountPersonRow): AccountPerson => ({
  leadId: p.lead_id, name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email || 'Unknown', title: p.title, door: p.source,
  tier: p.tier, score: p.score, routeAction: p.route_action, owner: p.owner, receivedAt: p.received_at,
});

/** A signal row as the API shows it; a kind this file does not know (a type added to account_signals later) is left out, not mislabelled. */
const toSignals = (rows: AccountSignalRow[]): AccountSignal[] =>
  rows.flatMap(s => (isSignalKind(s.kind) ? [{ kind: s.kind, detail: s.detail, leadId: s.lead_id, at: s.at }] : []));

/** A limit parameter as given, kept between 1 and ACCOUNTS_MAX_LIMIT; anything unusable is the default. */
export function accountsLimit(raw: string | null): number {
  const n = Number(raw ?? ACCOUNTS_DEFAULT_LIMIT);
  return Number.isFinite(n) && n >= 1 ? Math.min(ACCOUNTS_MAX_LIMIT, Math.floor(n)) : ACCOUNTS_DEFAULT_LIMIT;
}

/** Accounts ranked: enterprise first, then the account score, then the latest activity. */
export function listAccounts(ctx: Ctx, limit = ACCOUNTS_DEFAULT_LIMIT): { total: number; accounts: AccountSummary[] } {
  return { total: ctx.store.accountViews.count(), accounts: ctx.store.accountViews.ranked(limit).map(r => toSummary(ctx, r)) };
}

/** One account with its people, signals, rate line and open review items, or null when the router holds no such account. */
export function accountDetail(ctx: Ctx, key: string): AccountDetail | null {
  const v = ctx.store.accountViews;
  const row = v.one(key);
  if (!row) return null;
  return {
    ...toSummary(ctx, row), domain: row.domain,
    people: v.people(key, DETAIL_ROWS).map(toPerson),
    signals: toSignals(v.signals(key, DETAIL_ROWS)),
    rateLine: v.rateLine(key),
    reviews: v.reviews(key).map(r => ({ leadId: r.lead_id, reason: r.reason, createdAt: r.created_at })),
  };
}
