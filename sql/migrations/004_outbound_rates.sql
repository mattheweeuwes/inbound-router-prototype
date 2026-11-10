-- 004: the outbound module (DECISIONS #20). A public rate file (Serif's rate search export) is loaded into rate_rows at
-- startup when its hash changes; every other table here is derived from it and rebuilt in the same transaction.
-- rate_file: the one file loaded. sha256 is the file's hash; inputs_sha256 also covers the platform mapping and the registry
-- the links were made against, so a change to either rebuilds the derived tables.
CREATE TABLE IF NOT EXISTS rate_file (
  id INTEGER PRIMARY KEY CHECK (id = 1), path TEXT NOT NULL, sha256 TEXT NOT NULL, inputs_sha256 TEXT NOT NULL,
  rows INTEGER NOT NULL, payer TEXT, network TEXT, network_month TEXT, code TEXT, loaded_at TEXT NOT NULL);
-- rate_rows: one row per rate row of the file, in file order (id). Column names follow analysis.py in the take-home.
CREATE TABLE IF NOT EXISTS rate_rows (
  id INTEGER PRIMARY KEY, ein TEXT NOT NULL, entity TEXT NOT NULL, name_norm TEXT NOT NULL, state TEXT, city TEXT, taxonomy TEXT,
  npis INTEGER NOT NULL,          -- FilteredNPIListLength: psychiatrists on this rate row
  src_npis INTEGER NOT NULL,      -- PayerSourceNPIListLength: NPIs on the payer's original list for this rate
  org_npis INTEGER NOT NULL,      -- AllPayerIndividualNPIs: individual NPIs linked to the EIN in this network, any specialty (group size)
  rate REAL NOT NULL, medicare REAL NOT NULL,
  pct_medicare REAL NOT NULL,     -- RelativeToBaseline, as a fraction
  most_npis INTEGER NOT NULL,     -- IsMostNpisPerEinCode
  claims_evidence INTEGER NOT NULL, -- IsBillableClaims
  pos TEXT);
CREATE INDEX IF NOT EXISTS idx_rate_rows_ein ON rate_rows(ein);
-- rate_patterns: the base the card search found and the unit the factor search found, with how many distinct rates each explains.
CREATE TABLE IF NOT EXISTS rate_patterns (
  kind TEXT PRIMARY KEY CHECK (kind IN ('card', 'factor')), value REAL NOT NULL, hits INTEGER NOT NULL, distinct_rates INTEGER NOT NULL,
  runners_up_json TEXT);
-- rate_findings: one row per group (EIN), from v_rate_groups and the patterns, with its fit and draft status.
CREATE TABLE IF NOT EXISTS rate_findings (
  ein TEXT PRIMARY KEY, account_key TEXT NOT NULL, name TEXT NOT NULL, name_norm TEXT NOT NULL, city TEXT, state TEXT,
  clinicians INTEGER NOT NULL, band TEXT NOT NULL, rate REAL NOT NULL, medicare REAL NOT NULL, pct_medicare INTEGER NOT NULL,
  form TEXT NOT NULL CHECK (form IN ('card', 'factor', 'both', 'neither')), card_tier INTEGER, factor_multiple INTEGER,
  city_top_rate REAL NOT NULL, city_top_clinicians INTEGER NOT NULL, city_top_ein TEXT NOT NULL, band_median_pct REAL NOT NULL,
  fit TEXT NOT NULL CHECK (fit IN ('target', 'not_target')), fit_reason TEXT NOT NULL,
  platform TEXT, platform_confirmed INTEGER,
  draft_status TEXT NOT NULL CHECK (draft_status IN ('ready', 'blocked', 'none')), draft_reason TEXT,
  hook TEXT NOT NULL CHECK (hook IN ('hospital_leverage', 'rate_range')));
CREATE INDEX IF NOT EXISTS idx_rate_findings_name ON rate_findings(name_norm, state);
-- rate_links: each group's link to a registry organization, by name and state. Unlinked rows keep the candidates a person would see.
CREATE TABLE IF NOT EXISTS rate_links (
  ein TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('linked', 'unlinked')), account_id TEXT, account_name TEXT,
  method TEXT NOT NULL, score REAL, reason TEXT NOT NULL, candidates_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rate_links_account ON rate_links(account_id) WHERE account_id IS NOT NULL;
-- the rate line an inbound lead's brief carried, when its organization has a rate group (decision 20)
ALTER TABLE leads ADD COLUMN rate_fact_json TEXT;
