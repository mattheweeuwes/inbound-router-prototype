-- 003: the model's second opinion after the alert (decision 19). A free-text lead whose route the model could not change is
-- alerted on the rules; the same model call runs afterwards, off the ordered path, and its result is stored here.
-- second_opinion: NULL (none due), 'pending' (due, waiting for the worker), 'running' (a call is in flight; boot puts it back
-- to pending), 'done'. second_opinion_json: while pending, the organization type the model is shown; once done, what the
-- model said, whether it agreed with the route, which fields it would have changed and any doubt it raised.
ALTER TABLE leads ADD COLUMN second_opinion TEXT CHECK (second_opinion IN ('pending', 'running', 'done'));
ALTER TABLE leads ADD COLUMN second_opinion_json TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_second_opinion ON leads(second_opinion) WHERE second_opinion IS NOT NULL;
