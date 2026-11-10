-- The attribution model (DECISIONS #22). A feature influenced a deal when the deal's account used it from 90 days before the
-- deal was created until the deal closed; for a deal still open, until the as-of date. Both ends are included. One row per
-- deal and feature, with how often the account used the feature in that window. This is influence, not proof of cause: it
-- says the use and the deal overlapped in time, nothing more. A deal can be influenced by several features.
-- Only mapped events on a resolved account count.
DROP VIEW IF EXISTS v_usage_deal_influence;
CREATE VIEW v_usage_deal_influence AS
SELECT d.id AS deal_id, d.account_key, e.feature, COUNT(*) AS uses,
  MIN(e.occurred_at) AS first_use_in_window, MAX(e.occurred_at) AS last_use_in_window
FROM deals d
CROSS JOIN v_usage_asof a
JOIN usage_events e ON e.account_key = d.account_key AND e.feature IS NOT NULL
  AND e.occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ', d.created_at, '-90 days')
  AND e.occurred_at <= COALESCE(d.closed_at, a.t)
GROUP BY d.id, e.feature;
