// What the reverse ETL writes to each company about product use: the features used in the last 30 days, the latest use, and the
// 30-day event count per feature. Pure over the rows of v_usage_by_account_feature.
import type { UsageRollup } from '../crm/hubspot';
import type { AccountFeatureRow } from '../store/usage';
import { FEATURE_KEYS, isUsageFeature, type UsageFeature } from './taxonomy';

const zeros = (): Record<UsageFeature, number> => Object.fromEntries(FEATURE_KEYS.map(f => [f, 0])) as Record<UsageFeature, number>;

/** One rollup per account that has used any mapped feature, keyed by account key. */
export function usageRollups(rows: AccountFeatureRow[]): Map<string, UsageRollup> {
  const out = new Map<string, UsageRollup>();
  for (const r of rows) {
    if (!isUsageFeature(r.feature)) continue;
    let u = out.get(r.account_key);
    if (!u) { u = { features30d: [], lastFeature: null, lastFeatureAt: null, events30d: zeros() }; out.set(r.account_key, u); }
    u.events30d[r.feature] = r.events_30d;
    if (u.lastFeatureAt === null || r.last_use_at > u.lastFeatureAt) { u.lastFeature = r.feature; u.lastFeatureAt = r.last_use_at; }
  }
  for (const u of out.values()) u.features30d = FEATURE_KEYS.filter(f => u.events30d[f] > 0);
  return out;
}
