-- The accounts API's read models (GET /api/accounts, src/accounts.ts). One row per account the router holds, with what a
-- seller asks first: is it enterprise, how hot is it, who came in, what signals it has, and does anything wait on a person.
-- Scores and the 30-day counts come from v_account_scores, so the window is the same one the reverse ETL writes.
DROP VIEW IF EXISTS v_accounts;
CREATE VIEW v_accounts AS
SELECT
  a.id                                        AS account_key,
  a.name                                      AS name,
  a.segment                                   AS segment,
  a.domain                                    AS domain,
  a.enterprise                                AS enterprise,
  a.enterprise_fact                           AS enterprise_fact,
  a.owner                                     AS claimed_owner,
  COALESCE(s.account_score, 0)                AS account_score,
  s.top_tier                                  AS top_tier,
  COALESCE(s.leads_30d, 0)                    AS leads_30d,
  COALESCE(s.contacts_30d, 0)                 AS contacts_30d,
  -- the latest thing that happened at the account: a lead, or a signal written about it (a referral it made, say)
  NULLIF(MAX(COALESCE((SELECT MAX(e.received_at) FROM leads l JOIN lead_events e ON e.id = l.id WHERE l.account_id = a.id), ''),
             COALESCE((SELECT MAX(g.at) FROM account_signals g WHERE g.account_id = a.id), '')), '')
                                              AS last_activity_at,
  (SELECT COUNT(*) FROM leads l WHERE l.account_id = a.id AND l.referral_kind IS NOT NULL)          AS referrals_in,
  (SELECT COUNT(*) FROM account_signals g WHERE g.account_id = a.id AND g.type = 'referral')       AS referrals_out,
  (SELECT COUNT(*) FROM account_signals g WHERE g.account_id = a.id AND g.type = 'web_intent')     AS web_intent_signals,
  EXISTS (SELECT 1 FROM rate_links k WHERE k.account_id = a.id AND k.status = 'linked')
    OR EXISTS (SELECT 1 FROM rate_link_decisions d WHERE d.account_id = a.id AND d.decision = 'confirmed')
    OR EXISTS (SELECT 1 FROM leads l WHERE l.account_id = a.id AND l.rate_fact_json IS NOT NULL)   AS has_rate_fact,
  (SELECT COUNT(*) FROM review_queue r JOIN leads l ON l.id = r.lead_id WHERE l.account_id = a.id AND r.resolved = 0) AS open_reviews
FROM accounts a
LEFT JOIN v_account_scores s ON s.account_key = a.id;

-- Every person who came in at an account, one row per lead, newest first when read.
DROP VIEW IF EXISTS v_account_people;
CREATE VIEW v_account_people AS
SELECT
  l.account_id AS account_key, l.id AS lead_id, l.first_name, l.last_name, l.email, l.title, e.source, l.tier, l.score,
  l.route_action, l.owner, e.received_at
FROM leads l
JOIN lead_events e ON e.id = l.id
WHERE l.account_id IS NOT NULL AND e.source != 'web_intent';

-- An account's signals in one shape: web intent, claims and referrals it made (account_signals), referrals its people
-- named (referral_in), and the deal-size cues quoted from its people's messages (deal_cue).
DROP VIEW IF EXISTS v_account_signals;
CREATE VIEW v_account_signals AS
SELECT g.account_id AS account_key, CASE g.type WHEN 'referral' THEN 'referral_out' ELSE g.type END AS kind, g.detail, g.lead_id, g.at
FROM account_signals g
UNION ALL
SELECT l.account_id, 'referral_in',
  'referred by ' || COALESCE(json_extract(l.referral_json, '$.account.name'), '"' || json_extract(l.referral_json, '$.referrer') || '"')
    || CASE l.referral_kind WHEN 'customer' THEN ' (a customer)' WHEN 'known_org' THEN ' (not a customer)' ELSE ' (organization not identified)' END,
  l.id, e.received_at
FROM leads l JOIN lead_events e ON e.id = l.id
WHERE l.account_id IS NOT NULL AND l.referral_kind IS NOT NULL
UNION ALL
SELECT l.account_id, 'deal_cue', json_extract(c.value, '$.kind') || ': "' || json_extract(c.value, '$.phrase') || '"', l.id, e.received_at
FROM leads l JOIN lead_events e ON e.id = l.id, json_each(l.deal_json, '$.cues') c
WHERE l.account_id IS NOT NULL AND l.deal_json IS NOT NULL;
