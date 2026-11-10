-- Named to sort after v_rate_groups, which it reads (sql/models runs in name order).
-- The top chosen rate in each city and state, with the size of the group paid it. Two groups at the same top rate go to
-- the larger one (the take-home's feed names UNM Medical Group, 3,270 clinicians, for Albuquerque's $274.13).
DROP VIEW IF EXISTS v_rate_groups_city_top;
CREATE VIEW v_rate_groups_city_top AS
SELECT city, state, ein AS top_ein, rate AS top_rate, org_npis AS top_clinicians, groups
FROM (
  SELECT g.city, g.state, g.ein, g.rate, g.org_npis,
    COUNT(*) OVER (PARTITION BY g.city, g.state) AS groups,
    ROW_NUMBER() OVER (PARTITION BY g.city, g.state ORDER BY g.rate DESC, g.org_npis DESC, g.ein) AS k
  FROM v_rate_groups g)
WHERE k = 1;
