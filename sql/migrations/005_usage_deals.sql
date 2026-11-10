-- 005: product usage tied to pipeline (DECISIONS #22). PostHog-shaped events are stored once per event uuid, deals stand in for
-- HubSpot deals, and the views in sql/models join them. Times are stored as UTC ISO text with milliseconds
-- (2026-10-01T14:03:22.123Z) so a text comparison is a time comparison; the adapter and the loader write that form and nothing else.

-- The features Serif ships, from fixtures/usage/features.json (reference data, replaced whole on load).
-- preview_of_add_on: set on a feature that previews a paid add-on (add_ons.id), which is what the expansion rule watches.
CREATE TABLE IF NOT EXISTS features (
  feature TEXT PRIMARY KEY, label TEXT NOT NULL, launched_at TEXT NOT NULL, team TEXT NOT NULL, preview_of_add_on TEXT);
CREATE TABLE IF NOT EXISTS add_ons (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, price_low INTEGER NOT NULL, price_high INTEGER NOT NULL);

-- One row per PostHog event, keyed on its uuid, so a redelivered batch changes nothing.
-- feature: NULL when the event name is not in the taxonomy (src/usage/taxonomy.ts): kept and counted as unmapped, never dropped.
-- account_key: NULL when the company group did not resolve to an account key; group_key keeps what was sent.
-- contact_key: the router's contact key (sha256 of the email, 16 hex) when distinct_id is an email, else NULL.
-- source: 'api' for POST /api/usage, 'fixture' for the committed synthetic file, which a changed file replaces.
CREATE TABLE IF NOT EXISTS usage_events (
  event_id TEXT PRIMARY KEY, account_key TEXT, group_key TEXT, contact_key TEXT, feature TEXT, event_name TEXT NOT NULL,
  occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, synthetic INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'fixture')));
CREATE INDEX IF NOT EXISTS idx_usage_events_account ON usage_events(account_key, feature, occurred_at);

-- One row per deal. outcome is NULL while the deal is open; closed_at is set exactly when outcome is.
-- add_on: the add-on the deal sells (add_ons.id), NULL for the base product and for seat or renewal deals.
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY, account_key TEXT NOT NULL, stage TEXT NOT NULL, amount INTEGER NOT NULL CHECK (amount >= 0),
  created_at TEXT NOT NULL, closed_at TEXT, outcome TEXT CHECK (outcome IN ('won', 'lost')), add_on TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'fixture')),
  CHECK ((closed_at IS NULL) = (outcome IS NULL)));
CREATE INDEX IF NOT EXISTS idx_deals_account ON deals(account_key);

-- The hash of the fixture files last loaded, so an unchanged restart does no work.
CREATE TABLE IF NOT EXISTS usage_fixture (
  id INTEGER PRIMARY KEY CHECK (id = 1), sha256 TEXT NOT NULL, loaded_at TEXT NOT NULL);
