-- 008: a person's decision on a rate group's registry link (decision 28). One row per EIN, the rate file's stable id for
-- the group, and kept apart from rate_links: the loader rebuilds rate_links on every reload of the file, and a decision a
-- person made must survive that. A later decision on the same EIN replaces the earlier one.
-- decision: confirmed (the group belongs to account_id) or rejected (it does not belong to the candidate shown, account_id,
-- which may be null). decided_by is the name the person typed: sign-in is not built.
CREATE TABLE IF NOT EXISTS rate_link_decisions (
  ein TEXT PRIMARY KEY,
  decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
  account_id TEXT, account_name TEXT,
  decided_by TEXT NOT NULL, note TEXT, decided_at TEXT NOT NULL,
  CHECK (decision = 'rejected' OR account_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_rate_link_decisions_account ON rate_link_decisions(account_id) WHERE decision = 'confirmed';
