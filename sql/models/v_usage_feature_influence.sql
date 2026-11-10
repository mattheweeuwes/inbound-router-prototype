-- Per feature: who uses it, the deals it influenced (v_usage_deal_influence) split by outcome, the closed deals behind a win rate,
-- the median days from an account's first use to the deal opening, and adoption since launch.
-- Win rate with use is won / closed among the influenced deals; the rate without it is taken against all closed deals (closed_all,
-- won_all), so the caller subtracts. Counts are returned beside every rate so a rate over a handful of deals can be read as one.
-- first use is the account's first use of the feature ever; a deal whose first use came after the deal opened is counted in
-- used_after_open and left out of the median, which describes use that came first.
DROP VIEW IF EXISTS v_usage_feature_influence;
CREATE VIEW v_usage_feature_influence AS
WITH influenced AS (
  SELECT i.feature, d.id AS deal_id, d.amount, d.outcome, d.created_at, u.first_use_at
  FROM v_usage_deal_influence i
  JOIN deals d ON d.id = i.deal_id
  JOIN v_usage_by_account_feature u ON u.account_key = i.account_key AND u.feature = i.feature),
by_feature AS (
  SELECT feature,
    SUM(outcome = 'won') AS won_count, COALESCE(SUM(CASE WHEN outcome = 'won' THEN amount END), 0) AS won_amount,
    SUM(outcome = 'lost') AS lost_count, COALESCE(SUM(CASE WHEN outcome = 'lost' THEN amount END), 0) AS lost_amount,
    SUM(outcome IS NULL) AS open_count, COALESCE(SUM(CASE WHEN outcome IS NULL THEN amount END), 0) AS open_amount,
    SUM(first_use_at > created_at) AS used_after_open
  FROM influenced GROUP BY feature),
lead_time AS (
  SELECT feature, julianday(created_at) - julianday(first_use_at) AS days,
    ROW_NUMBER() OVER (PARTITION BY feature ORDER BY julianday(created_at) - julianday(first_use_at)) AS rn,
    COUNT(*) OVER (PARTITION BY feature) AS n
  FROM influenced WHERE first_use_at <= created_at),
median AS (
  SELECT feature, AVG(days) AS days, MAX(n) AS n FROM lead_time WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY feature)
SELECT f.feature, f.label, f.launched_at, f.team,
  (SELECT COUNT(DISTINCT u.account_key) FROM v_usage_by_account_feature u WHERE u.feature = f.feature) AS accounts_using,
  (SELECT COALESCE(SUM(u.events), 0) FROM v_usage_by_account_feature u WHERE u.feature = f.feature) AS events,
  (SELECT COUNT(DISTINCT e.account_key) FROM usage_events e
    WHERE e.account_key IS NOT NULL AND e.feature IS NOT NULL AND e.occurred_at >= f.launched_at) AS active_since_launch,
  (SELECT COUNT(DISTINCT e.account_key) FROM usage_events e
    WHERE e.account_key IS NOT NULL AND e.feature = f.feature AND e.occurred_at >= f.launched_at) AS using_since_launch,
  COALESCE(b.won_count, 0) AS won_count, COALESCE(b.won_amount, 0) AS won_amount,
  COALESCE(b.lost_count, 0) AS lost_count, COALESCE(b.lost_amount, 0) AS lost_amount,
  COALESCE(b.open_count, 0) AS open_count, COALESCE(b.open_amount, 0) AS open_amount,
  COALESCE(b.used_after_open, 0) AS used_after_open,
  m.days AS median_days, COALESCE(m.n, 0) AS median_n,
  (SELECT COUNT(*) FROM deals WHERE outcome IS NOT NULL) AS closed_all,
  (SELECT COUNT(*) FROM deals WHERE outcome = 'won') AS won_all
FROM features f
LEFT JOIN by_feature b ON b.feature = f.feature
LEFT JOIN median m ON m.feature = f.feature
ORDER BY f.launched_at, f.feature;
