-- One row per account and feature the account has used: how often, first and last, and how often in the last 30 days.
-- Mapped events on a resolved account only; an unmapped or unresolved event belongs to nothing here.
DROP VIEW IF EXISTS v_usage_by_account_feature;
CREATE VIEW v_usage_by_account_feature AS
SELECT e.account_key, e.feature, COUNT(*) AS events, MIN(e.occurred_at) AS first_use_at, MAX(e.occurred_at) AS last_use_at,
  (SELECT COUNT(*) FROM v_usage_asof_30d r WHERE r.account_key = e.account_key AND r.feature = e.feature) AS events_30d
FROM usage_events e
WHERE e.account_key IS NOT NULL AND e.feature IS NOT NULL
GROUP BY e.account_key, e.feature;
