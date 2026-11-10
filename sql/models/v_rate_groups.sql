-- One rate per group (EIN), the rule from the take-home's analysis.py. Serif's help center says to "pick the rate associated
-- with the largest npi-group", and the file flags that rate (IsMostNpisPerEinCode). So: the flagged row first, then the
-- payer's largest NPI list, then the most psychiatrists, then the higher rate; file order only settles rows identical on all four.
-- Size bands are on AllPayerIndividualNPIs, the size of the whole organization in this network.
DROP VIEW IF EXISTS v_rate_groups;
CREATE VIEW v_rate_groups AS
SELECT *,
  CASE WHEN org_npis <= 50 THEN '1-50' WHEN org_npis <= 500 THEN '51-500' ELSE '501+' END AS band
FROM (
  SELECT r.*, ROW_NUMBER() OVER (
    PARTITION BY ein ORDER BY most_npis DESC, src_npis DESC, npis DESC, rate DESC, id ASC) AS rn
  FROM rate_rows r)
WHERE rn = 1;
