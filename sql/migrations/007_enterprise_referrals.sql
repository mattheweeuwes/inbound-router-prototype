-- 007: enterprise accounts, deal-size cues and named referrals (decisions 25 and 26).

-- The lead's own record: whether its account is enterprise, the deal signals routing read (the enterprise fact and the
-- deal-size cues quoted from the message), and a named referral when it has one.
ALTER TABLE leads ADD COLUMN enterprise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN deal_json TEXT;
ALTER TABLE leads ADD COLUMN referral_json TEXT;
-- customer, known_org or unknown_org; NULL when the lead names no referrer
ALTER TABLE leads ADD COLUMN referral_kind TEXT;
-- the referring organization's account key, when the referrer resolved to one
ALTER TABLE leads ADD COLUMN referrer_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_referrer ON leads(referrer_account_id) WHERE referrer_account_id IS NOT NULL;

-- The account's own flag and fact line, refreshed from the firmographics each time a lead resolves to it.
ALTER TABLE accounts ADD COLUMN enterprise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN enterprise_fact TEXT;
