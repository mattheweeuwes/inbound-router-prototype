-- 002: account claims in their own table, a HubSpot outbox, bounded lead retries, and a server-set acceptance time.
-- Applied once by the migration runner (src/db.ts). The UPDATE and INSERT ... SELECT statements carry rows written
-- before this file existed into the new shape; on a new database they touch nothing.

-- Server clock at the 202. Business timestamps (received_at) stay as the payload gave them; processing order and boot
-- recovery use this one. Older rows take it from leads.created_at, which the ingest wrote at the same moment.
ALTER TABLE lead_events ADD COLUMN accepted_at TEXT;
UPDATE lead_events SET accepted_at = (SELECT l.created_at FROM leads l WHERE l.id = lead_events.id) WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_events_accepted ON lead_events(accepted_at);

-- A lead whose pipeline throws is retried: attempts counts runs that failed, retry_at (epoch ms) is when the next one is due.
ALTER TABLE leads ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN retry_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

-- Signals now name the lead that wrote them, so a re-run removes its own rows by id. Before this, the id was written as a
-- "[<lead id>] " prefix on the detail text; it moves to the column here and the text keeps only the human-readable part.
ALTER TABLE account_signals ADD COLUMN lead_id TEXT;
UPDATE account_signals
  SET lead_id = substr(detail, 2, instr(detail, ']') - 2), detail = ltrim(substr(detail, instr(detail, ']') + 1))
  WHERE detail LIKE '[%]%';
CREATE INDEX IF NOT EXISTS idx_account_signals_lead ON account_signals(lead_id);
CREATE INDEX IF NOT EXISTS idx_account_signals_account ON account_signals(account_id, type, at);

-- Which lead's rep alert claimed which account for which rep. accounts.owner stays the current owner that routing reads;
-- this table is what a re-run releases by lead_id. A claim was only ever made on an account with no owner, so for older
-- rows the claimed owner is accounts.owner.
CREATE TABLE IF NOT EXISTS account_claims (lead_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, owner TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_account_claims_account ON account_claims(account_id);
INSERT OR IGNORE INTO account_claims (lead_id, account_id, owner, at)
  SELECT s.lead_id, s.account_id, a.owner, s.at
  FROM account_signals s JOIN accounts a ON a.id = s.account_id
  WHERE s.type = 'claim' AND s.lead_id IS NOT NULL AND a.owner IS NOT NULL;

-- Live HubSpot plans waiting for delivery, one row per lead plan, delivered in id order (src/crm/outbox.ts).
-- state: pending (not yet sent, or waiting for its next attempt), delivered (HubSpot answered; a 4xx is recorded, not
-- retried), dead (gave up after the last attempt). next_attempt_at is epoch ms.
CREATE TABLE IF NOT EXISTS crm_outbox (
  id INTEGER PRIMARY KEY,
  lead_id TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crm_outbox_state ON crm_outbox(state, id);
CREATE INDEX IF NOT EXISTS idx_crm_outbox_lead ON crm_outbox(lead_id);

-- Writes that threw twice before this change were marked crm_json.retryPending and only re-sent at boot. They join the
-- outbox, due now, with a fresh attempt budget, and their record says they are waiting for a retry.
INSERT INTO crm_outbox (lead_id, plan_json, state, attempts, next_attempt_at, last_error, created_at, updated_at)
  SELECT id, json_object('requests', crm_json -> '$.requests', 'skipped', crm_json -> '$.skipped'), 'pending', 0, 0,
    json_extract(crm_json, '$.error'), COALESCE(updated_at, created_at), COALESCE(updated_at, created_at)
  FROM leads WHERE json_extract(crm_json, '$.retryPending') = 1 ORDER BY created_at;
UPDATE leads SET crm_json = json_set(json_remove(crm_json, '$.retryPending'), '$.delivery', 'retrying')
  WHERE json_extract(crm_json, '$.retryPending') = 1;
