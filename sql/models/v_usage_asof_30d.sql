-- The events of the 30 days up to the as-of date, both ends included. The one place the 30 comes from: the expansion rule
-- (v_usage_expansion) and the per-account counts the reverse ETL writes (v_usage_by_account_feature) both read this view.
-- Times are UTC ISO text with milliseconds, so the text comparison is a time comparison.
DROP VIEW IF EXISTS v_usage_asof_30d;
CREATE VIEW v_usage_asof_30d AS
SELECT e.* FROM usage_events e CROSS JOIN v_usage_asof a
WHERE e.occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ', a.t, '-30 days') AND e.occurred_at <= a.t;
