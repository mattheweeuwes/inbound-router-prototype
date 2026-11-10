-- The date every usage window is measured from: the newest event, so replayed or fixture history still has a window
-- (v_account_scores does the same with the newest lead). With no events it is the clock.
DROP VIEW IF EXISTS v_usage_asof;
CREATE VIEW v_usage_asof AS
SELECT COALESCE(MAX(occurred_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS t FROM usage_events;
