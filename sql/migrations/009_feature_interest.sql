-- 009: feature interest from inbound leads (decision 30), and a feature that has not launched.

-- A feature may be in preview with no launch date (Signal Ask), so launched_at can be NULL and a status says which. SQLite
-- cannot drop a NOT NULL, so the table is rebuilt; its rows are reference data the loader replaces on a changed fixture file.
-- The views that read it are redefined at every start (sql/models), after migrations.
CREATE TABLE features_old AS SELECT feature, label, launched_at, team, preview_of_add_on FROM features;
DROP TABLE features;
CREATE TABLE features (
  feature TEXT PRIMARY KEY, label TEXT NOT NULL, launched_at TEXT, team TEXT NOT NULL, preview_of_add_on TEXT,
  status TEXT NOT NULL DEFAULT 'launched' CHECK (status IN ('launched', 'preview')),
  CHECK ((status = 'launched') = (launched_at IS NOT NULL)));
INSERT INTO features (feature, label, launched_at, team, preview_of_add_on) SELECT feature, label, launched_at, team, preview_of_add_on FROM features_old;
DROP TABLE features_old;

-- One row per (lead, feature, cue): what the lead showed that points at the feature. cue is how it showed it: the door it came
-- through (or an API key's product), a gated guide, a page an account visited, or words in its message. evidence is the
-- specific thing: the phrase, the path with its visit count, the guide, the product. The rows are derived from the lead and
-- rewritten whenever it is committed again.
CREATE TABLE IF NOT EXISTS lead_interest (
  lead_id TEXT NOT NULL REFERENCES leads(id),
  feature TEXT NOT NULL,
  cue TEXT NOT NULL CHECK (cue IN ('door', 'guide', 'path', 'message')),
  evidence TEXT NOT NULL,
  PRIMARY KEY (lead_id, feature, cue)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_lead_interest_feature ON lead_interest(feature);

-- When the lead was last looked at for cues, so a lead with none is not looked at again at every start (the backfill reads
-- the leads where this is NULL). Set on commit, and by the backfill for leads committed before this migration.
ALTER TABLE leads ADD COLUMN interest_tagged_at TEXT;
