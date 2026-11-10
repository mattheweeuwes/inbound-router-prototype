-- 010: a person's decision on a review item (decision 33). Sign-in is not built, so decided_by is the name the person
-- typed. A decided row stays as the record of who decided what: a re-run of the lead deletes only its open items.
-- decision: use_account (the person chose the account), not_for_sales (marketing's nurture track), not_a_buyer
-- (dropped, with the reason in decision_json) or is_buyer (the model's doubt is cleared).
-- decision_json: the decision as the router applied it, with the route the lead had before it (what it changed).
ALTER TABLE review_queue ADD COLUMN decision TEXT CHECK (decision IS NULL OR decision IN ('use_account', 'not_for_sales', 'not_a_buyer', 'is_buyer'));
ALTER TABLE review_queue ADD COLUMN decided_by TEXT;
ALTER TABLE review_queue ADD COLUMN decision_note TEXT;
ALTER TABLE review_queue ADD COLUMN decided_at TEXT;
ALTER TABLE review_queue ADD COLUMN decision_json TEXT;
CREATE INDEX IF NOT EXISTS idx_review_queue_lead ON review_queue(lead_id);
CREATE INDEX IF NOT EXISTS idx_review_queue_decided ON review_queue(decided_at) WHERE resolved = 1;

-- The forced choice, kept with the lead so every later run (the re-run the decision starts, boot recovery, a retry) reads
-- it in prepare instead of asking the resolver or the model's doubt again.
ALTER TABLE leads ADD COLUMN review_decision_json TEXT;
