CREATE TABLE IF NOT EXISTS lead_events (id TEXT PRIMARY KEY, source TEXT NOT NULL, source_event_id TEXT NOT NULL,
  received_at TEXT NOT NULL, synthetic INTEGER NOT NULL DEFAULT 0, raw_json TEXT NOT NULL,
  UNIQUE(source, source_event_id));
CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY REFERENCES lead_events(id), status TEXT NOT NULL,
  email TEXT, email_domain TEXT, is_free_mail INTEGER, is_disposable INTEGER, first_name TEXT, last_name TEXT,
  title TEXT, title_function TEXT, title_seniority TEXT, company_name_raw TEXT, company_domain TEXT,
  state TEXT, country TEXT, message TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
  utm_content TEXT, utm_term TEXT, channel TEXT, landing_page TEXT, referrer TEXT,
  contact_key TEXT, duplicate_of TEXT, account_id TEXT,
  normalized_json TEXT, resolution_json TEXT, qualification_json TEXT, score_json TEXT, route_json TEXT,
  crm_json TEXT, alert_json TEXT, timings_json TEXT,
  tier TEXT, score INTEGER, segment TEXT, route_action TEXT, route_team TEXT, owner TEXT, sla_due_at TEXT,
  time_to_route_ms INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT, segment TEXT, subsegment TEXT, domain TEXT,
  ids_json TEXT, firmographics_json TEXT, owner TEXT, intent_points INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS account_signals (id INTEGER PRIMARY KEY, account_id TEXT, type TEXT, detail TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS review_queue (id INTEGER PRIMARY KEY, lead_id TEXT, reason TEXT, candidates_json TEXT, created_at TEXT, resolved INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS stage_log (lead_id TEXT, stage TEXT, started_at TEXT, ms INTEGER, ok INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS assignments (owner TEXT, team TEXT, lead_id TEXT, at TEXT);
CREATE INDEX IF NOT EXISTS idx_leads_contact ON leads(contact_key);
CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);
CREATE INDEX IF NOT EXISTS idx_stage_log_lead ON stage_log(lead_id);
