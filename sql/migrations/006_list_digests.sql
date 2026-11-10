-- 006: list uploads (decision 24). A door that carries a list someone uploads (a conference badge-scan list, by default) names
-- its list on each event, and a list lead whose route is not a rep's alert is folded into one digest per list and team.

-- The list an event belongs to, set at the 202 from the payload's own list or event name; NULL for every other door.
ALTER TABLE lead_events ADD COLUMN list_name TEXT;
CREATE INDEX IF NOT EXISTS idx_lead_events_list ON lead_events(list_name) WHERE list_name IS NOT NULL;

-- A list lead folded into a digest: the team whose digest it waits for, and the digest it went out in (NULL until then).
ALTER TABLE leads ADD COLUMN digest_team TEXT;
ALTER TABLE leads ADD COLUMN digest_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_leads_digest_pending ON leads(digest_team) WHERE digest_team IS NOT NULL AND digest_id IS NULL;

-- One row per digest recorded. batch_to is the last acceptance time the digest covers; the list's next batch starts after it.
CREATE TABLE IF NOT EXISTS list_digests (
  id INTEGER PRIMARY KEY,
  list_name TEXT NOT NULL,
  team TEXT NOT NULL,
  channel TEXT NOT NULL,
  rows INTEGER NOT NULL,
  batch_from TEXT NOT NULL,
  batch_to TEXT NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_list_digests_list ON list_digests(list_name, batch_to);
