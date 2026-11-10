// The attribution read model: turns the rows of v_usage_feature_influence and v_usage_deal_influence into what GET /api/attribution
// serves. The model itself is the SQL in sql/models; this file only names its constants, divides, and says in words what the
// numbers do and do not mean. Pure: rows in, payload out.
import type { DealOutcome, FeatureInfluenceRow, FeatureStatus, InfluencedDealRow } from '../store/usage';

/** The window before a deal is created in which use counts. The same number is in sql/models/v_usage_deal_influence.sql; a test moves an event across its edge. */
export const INFLUENCE_WINDOW_DAYS = 90;

/** Fewer closed deals than this on either side of a win-rate comparison marks it as a small sample. */
export const SMALL_SAMPLE = 5;

export const DEFINITION =
  `A feature influenced a deal when the deal's account used it in the ${INFLUENCE_WINDOW_DAYS} days before the deal was created, or while the deal was open ` +
  `(until it closed; for a deal still open, until the newest event). Both ends are included.`;

export const CAVEAT =
  'This is influence, not proof of cause. It says an account used a feature around the time it had a deal, and nothing about whether the feature moved the deal. ' +
  'Features overlap, so one deal counts under several and the rows do not add up. A win rate over a handful of closed deals is shown with its counts and should not be read as an effect.';

export interface Tally { count: number; amount: number }
export interface Rate { won: number; closed: number; rate: number | null }

export interface InfluencedDeal {
  id: string; accountKey: string; accountName: string; stage: string; outcome: DealOutcome | null; amount: number; addOn: string | null;
  createdAt: string; closedAt: string | null; uses: number; firstUseInWindow: string; lastUseInWindow: string;
}

export interface FeatureAttribution {
  feature: string; label: string; team: string;
  /** launched, or in preview with no launch date (launchedAt and daysSinceLaunch are then null, and nothing is measured since launch) */
  status: FeatureStatus; launchedAt: string | null; daysSinceLaunch: number | null;
  accountsUsing: number; events: number;
  /** accounts that used the feature since launch, of the accounts that used any feature since launch */
  adoption: { accounts: number; of: number; share: number | null };
  opportunities: Tally;
  byOutcome: { won: Tally; open: Tally; lost: Tally };
  /** won / closed among deals the feature influenced, and among all the other closed deals. small: either side has fewer than SMALL_SAMPLE closed deals. */
  winRate: { with: Rate; without: Rate; small: boolean };
  /** median days from the account's first use to the deal opening, over deals whose first use came first; usedAfterOpen deals are left out of it */
  firstUseToOpportunity: { medianDays: number | null; deals: number; usedAfterOpen: number };
  deals: InfluencedDeal[];
}

const rate = (won: number, closed: number): Rate => ({ won, closed, rate: closed > 0 ? won / closed : null });
const DAY_MS = 86_400_000;
const daysBetween = (fromIso: string, toIso: string) => Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS));
const tally = (count: number, amount: number): Tally => ({ count, amount });

/** One feature's row, with the deals behind it. `accountName` turns an account key into a name. */
export function attributeFeature(
  r: FeatureInfluenceRow, deals: InfluencedDealRow[], asOf: string, accountName: (key: string) => string,
): FeatureAttribution {
  const closedWith = r.won_count + r.lost_count;
  const withUse = rate(r.won_count, closedWith);
  const without = rate(r.won_all - r.won_count, r.closed_all - closedWith);
  return {
    feature: r.feature, label: r.label, team: r.team, status: r.status, launchedAt: r.launched_at,
    daysSinceLaunch: r.launched_at === null ? null : daysBetween(r.launched_at, asOf),
    accountsUsing: r.accounts_using, events: r.events,
    adoption: { accounts: r.using_since_launch, of: r.active_since_launch, share: r.active_since_launch > 0 ? r.using_since_launch / r.active_since_launch : null },
    opportunities: tally(r.won_count + r.lost_count + r.open_count, r.won_amount + r.lost_amount + r.open_amount),
    byOutcome: { won: tally(r.won_count, r.won_amount), open: tally(r.open_count, r.open_amount), lost: tally(r.lost_count, r.lost_amount) },
    winRate: { with: withUse, without, small: withUse.closed < SMALL_SAMPLE || without.closed < SMALL_SAMPLE },
    firstUseToOpportunity: { medianDays: r.median_days === null ? null : Math.round(r.median_days * 10) / 10, deals: r.median_n, usedAfterOpen: r.used_after_open },
    deals: deals.filter(d => d.feature === r.feature).map(d => ({
      id: d.deal_id, accountKey: d.account_key, accountName: accountName(d.account_key), stage: d.stage, outcome: d.outcome, amount: d.amount, addOn: d.add_on,
      createdAt: d.created_at, closedAt: d.closed_at, uses: d.uses, firstUseInWindow: d.first_use_in_window, lastUseInWindow: d.last_use_in_window,
    })),
  };
}

/** Every feature, the one that touched the most pipeline first; features with equal pipeline keep launch order. */
export function attributeFeatures(
  rows: FeatureInfluenceRow[], deals: InfluencedDealRow[], asOf: string, accountName: (key: string) => string,
): FeatureAttribution[] {
  return rows.map(r => attributeFeature(r, deals, asOf, accountName)).sort((a, b) => b.opportunities.amount - a.opportunities.amount);
}
