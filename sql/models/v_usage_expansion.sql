-- Expansion signal facts: for each account and add-on preview feature used in the last 30 days, how often, by how many people,
-- when, whether the account is a customer (a closed-won deal for the base product) and how many deals it has for that add-on
-- (any stage). The rule that turns these into a signal (three uses, a customer, no add-on deal) is src/usage/expansion.ts.
DROP VIEW IF EXISTS v_usage_expansion;
CREATE VIEW v_usage_expansion AS
SELECT r.account_key, f.preview_of_add_on AS add_on, f.feature,
  COUNT(*) AS uses_30d, COUNT(DISTINCT r.contact_key) AS contacts_30d,
  MIN(r.occurred_at) AS first_use_30d, MAX(r.occurred_at) AS last_use_30d,
  EXISTS (SELECT 1 FROM deals d WHERE d.account_key = r.account_key AND d.outcome = 'won' AND d.add_on IS NULL) AS is_customer,
  (SELECT COUNT(*) FROM deals d WHERE d.account_key = r.account_key AND d.add_on = f.preview_of_add_on) AS add_on_deals
FROM v_usage_asof_30d r
JOIN features f ON f.feature = r.feature AND f.preview_of_add_on IS NOT NULL
WHERE r.account_key IS NOT NULL
GROUP BY r.account_key, f.feature;
