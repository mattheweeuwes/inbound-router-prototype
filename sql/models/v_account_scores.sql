-- One row per account: the shape a warehouse model would hand to reverse ETL (Hightouch or similar).
-- "30 days" is measured back from the newest lead in the table, so replayed history still has a window.
DROP VIEW IF EXISTS v_account_scores;
CREATE VIEW v_account_scores AS
WITH anchor AS (SELECT COALESCE(MAX(received_at), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) AS t FROM lead_events),
recent AS (
  SELECT l.account_id, l.id, l.score, l.tier, l.contact_key, e.received_at
  FROM leads l
  JOIN lead_events e ON e.id = l.id
  CROSS JOIN anchor
  WHERE l.account_id IS NOT NULL
    AND l.status = 'done'
    AND COALESCE(l.route_action, '') NOT IN ('drop', 'careers', 'press', 'competitor_flag')
    AND e.received_at >= strftime('%Y-%m-%dT%H:%M:%SZ', anchor.t, '-30 days')
)
SELECT
  a.id                                       AS account_key,
  a.name                                     AS name,
  a.segment                                  AS segment,
  a.domain                                   AS domain,
  a.owner                                    AS owner,
  COUNT(r.id)                                AS leads_30d,
  COUNT(DISTINCT r.contact_key)              AS contacts_30d,
  COALESCE(MAX(r.score), 0)                  AS account_score,
  (SELECT r2.tier FROM recent r2 WHERE r2.account_id = a.id ORDER BY r2.score DESC LIMIT 1) AS top_tier,
  COALESCE(a.intent_points, 0)               AS web_intent_points,
  MAX(r.received_at)                         AS last_activity_at
FROM accounts a
LEFT JOIN recent r ON r.account_id = a.id
GROUP BY a.id;
