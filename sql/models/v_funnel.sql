-- Source x tier x action counts, for the funnel view and for sanity checks against the cockpit.
DROP VIEW IF EXISTS v_funnel;
CREATE VIEW v_funnel AS
SELECT e.source, COALESCE(l.tier, 'pending') AS tier, COALESCE(l.route_action, 'pending') AS route_action, COUNT(*) AS leads
FROM leads l JOIN lead_events e ON e.id = l.id
GROUP BY e.source, l.tier, l.route_action;
