# Data contract

What crosses each boundary: inbound payloads, the canonical lead, the CRM. Source of truth for types is `src/schema.ts`; for tables, the files in `sql/migrations/`, applied once each in name order and recorded in `schema_migrations` (DECISIONS #18).

## 1. Canonical lead

Every inbound payload is adapted to one `LeadEvent` (`src/sources/*`), normalized (`src/normalize.ts`), and stored on `leads`.

| group | fields |
|---|---|
| identity | `id` (uuid), `source`, `source_event_id`, `received_at` (ISO UTC, from the payload), `accepted_at` (ISO UTC, the server's clock at the 202; orders boot recovery), `synthetic`, `list_name` (on `lead_events`: the uploaded list the event came in on, from the payload's `list` or `event` name, for a door in `LIST_DOORS` (default `event_scan`); null for every other door; DECISIONS #24) |
| person | `email` (trimmed, lowercased; its domain must be a plain DNS hostname, so an address with a port, path, IP address or bare name like `localhost` is treated as having no email), `first_name`, `last_name` (title-cased), `title`, `title_function`, `title_seniority` |
| company as submitted | `company_name_raw`, `company_domain` (null for free-mail and disposable), `state` (2-letter), `country` |
| attribution | `utm_source/medium/campaign/content/term` (normalized), `channel` (`referral` for a lead with a named referral, whatever the UTM said; section 3), `landing_page`, `referrer` (the web referrer, which is not a named referral) |
| message | `message` (the prospect's own words, never rewritten) |
| dedupe | `contact_key` (sha256 of the email, 16 hex), `duplicate_of` (the first lead of the same contact that went to sales, accepted before this one and received within 30 days either side of it; acceptance order, not the source timestamps, decides which is first, because a list arrives out of time order) |
| resolution | `account_id`, `segment`, plus `resolution_json` (method, confidence, evidence, firmographics, candidates) |
| qualification | `qualification_json` (rules output with its evidence, including the date parser's `urgencyCue`, `urgencyDate`, `urgencyDays` and `urgencyKind`, model output, final with per-field `sources`, per-field agreement, fallback reason, prompt and combine versions). This is what the route used: for a lead alerted on the rules (decision 19) `llm` is null and the fallback reason starts `model_after_alert`; the model's answer is in `second_opinion_json` |
| review decision | `review_decision_json`: a person's decision on the lead's review item (section 12), which every run of the lead applies in prepare; null when none |
| second opinion | `second_opinion` (null when none is due; `pending`, `running` while a call is in flight, `done`), `second_opinion_json` (while due: `{shownSegment}`, the organization type the model is shown; once done: `at`, `provider`, `latencyMs`, `llm` (what the model said, or null), `fallbackReason`, `answered`, `agreed`, `changed` (any of `useCase`, `buyingRole`, `disqualifier`, `reviewReason`: what the full combine would have decided differently from the route), `roleFilled`, `doubt` (`{disqualifier, confidence, heldForPerson}` or null), `followedUp`, `clearedBy` (present when a person had already said the lead is a buyer: the doubt is recorded and nothing is opened or sent), `afterAlertMs` (the alert to the answer), `shownSegment`; or `{at, error}` if the worker itself failed) |
| decision | `tier`, `score`, `score_json` (itemized; a named referral adds one intent line, section 10), `route_action`, `route_team`, `owner`, `sla_due_at`, `route_json` (rule R1 to R10 and reason) |
| deal signals | `enterprise` (1 when the account meets the enterprise definition, DECISIONS #25), `deal_json` (`{enterprise: {enterprise, fact, basis}, cues: [{kind, phrase, index}]}`: the flag with its fact line and which part of the definition it met (`hospitals`, `states`, `payer_kind`, `size_class`), and the deal-size cues quoted from the message, kinds `enterprise_license`, `full_dataset`, `broad_coverage`, `multi_year`, `multi_entity`, `approved_budget`). Rules only; never sent to the model |
| referral | `referral_json` (null unless the lead names a referrer, DECISIONS #26: `cue` (`form_answer`, `referred_by`, `recommended_by`, `recommended_you`, `heard_from`, `told_us`, `suggested`), `text` (the answer or sentence as written), `referrer` (the words naming who), `account` (`{key, name, customer, owner, matchedBy}` when the referrer resolved, else null), `kind` (`customer`, `known_org`, `unknown_org`), `points` (10, 6, 3), `thanks` (`{mode: 'dry_run', requests}`, the thank-you task plan for the referring account's owner, or null)), `referral_kind` and `referrer_account_id` mirror it as columns |
| rate fact | `rate_fact_json` (null unless the organization has a rate group in the outbound module, section 7: `ein`, `name`, `line` (the sentence the brief, the Slack alert's "Their rates" field and the CRM task carried), `matchedBy` (`registry_link` or `name_and_state`), `accountId`, `groups` (how many groups matched; the line describes the largest)). Read after the route; nothing scores or routes on it |
| sync | `crm_json` (the exact HubSpot requests and, in live mode, how their delivery went; below), `alert_json` (`slack`: the Slack payload or null, `suppressed`, `failure`: the RevOps alert of a lead that was given up, `followUp`: the payloads a model doubt after the alert sent, to the alert's channel and `#revops-review`, `enterprise`: the short note to `#enterprise-deals` on the first enterprise lead of an account in 30 days routed to sales (DECISIONS #25), and `digest`: for a list lead folded into its list's digest, `{list, team, channel, at, id}`, with `at` and `id` null until the digest is recorded; `slack` is null for such a lead). `digest_team` (the team whose digest the lead waits for) and `digest_id` (the `list_digests` row it went out in) mirror it as columns |
| processing | `status` (`received`, then one per stage: `normalized` ... `synced`, then `done`; `retrying` while a failed run waits for its next attempt; `failed` once given up), `attempts` (failed runs), `retry_at` (epoch ms of the next run while `retrying`) |
| timing | `time_to_route_ms` (receipt to routing decision), `timings_json` (ms per stage, plus: `queued`, the 202 to the lead's turn in the ordered section; `prepared`, the 202 to its order-independent work being ready; `waitedForPrepare`, its turn to that moment; `prepare`, the order-independent work itself, a wait for a model slot included; `modelBeforeRoute`, the model call the route waited for, when there was one; `passed`, 1 when the lead committed ahead of an earlier-accepted lead in another lane that was still waiting (DECISIONS #23); `alerted`, the 202 to the alert, which for a lead folded into a list digest is the 202 to the digest and is set when the digest is recorded; and `total`. Normalize, resolve and qualify run in the prepare step, alongside other leads, so they can overlap `queued`. The alert stage runs before the HubSpot write) |

`title_function`: `managed_care_contracting | network_strategy | benefits | revenue_cycle_finance | strategy_bd | analytics_data | product_engineering | executive | clinical | marketing_sales | research_academic | media | hr_recruiting | other`.
`title_seniority`: `c_level | vp | director | manager | individual | student | unknown`.

### Account keys (stable IDs, never names)

| key | entity | source |
|---|---|---|
| `ahrq:<health_sys_id>` | health system (a hospital that belongs to one resolves to it; its CCNs stay in `ids_json.ccns`) | AHRQ Compendium |
| `ccn:<ccn>` | standalone hospital | CMS Hospital General Information |
| `payer:<slug>` | payer | payer inventory / curated |
| `npi:<npi>` | provider group with one organizational NPI | NPPES NPI-2 |
| `crm:<mirror id>` | an account in `fixtures/crm-mirror.json` that no public registry knows (the CRM record supplies the name, segment and size) | CRM mirror |
| `domain:<domain>` | everything else: curated organizations, TLD-placed orgs, unknown orgs, and provider-group brands that span several NPI-2 records | email domain |
| `ein:<EIN>` | a contracting group in the rate file (outbound module, section 7); keyed on the file's EIN, never its name, and linked to a registry key only on a unique, strong name match or a person's confirmation (`rate_link_decisions`) | Serif's rate file |

`accounts.enterprise` and `accounts.enterprise_fact` (migration 007) hold the enterprise flag and its fact line, refreshed from the firmographics each time a lead resolves to the account. A referring organization the router has not seen inbound gets an account row when a lead names it, so its referral signal has an account. `accounts.owner` holds a rep only after a round-robin rep alert (R8, or R10 for an enterprise deal) claimed the account (see DECISIONS #5 and #25); owners seeded in `fixtures/crm-mirror.json` are never stored there. The claim itself is a row in `account_claims` (below); it is also shown as a human-readable `account_signals` row of type `claim`, and the claiming lead's company upsert carries `hubspot_owner_id`.

Free-mail leads whose company can't be matched, and ambiguous leads, get no account (`account_id` is null) until a person resolves them.

### Tables beside the lead

| table | one row per | columns | written by |
|---|---|---|---|
| `account_claims` | lead whose rep alert claimed an account | `lead_id` (primary key), `account_id`, `owner`, `at` (the lead's received time) | the route stage, in the same transaction as the assignment; a re-run deletes its lead's row and clears `accounts.owner` if that rep still holds it |
| `account_signals` | account-level event shown in the cockpit | `account_id`, `lead_id` (the lead that wrote it), `type` (`claim`, `web_intent`, or `referral` on the referring account: "referred CommonSpirit Health"), `detail` (human-readable, never parsed), `at` | the route stage; a re-run deletes its lead's rows |
| `crm_outbox` | live HubSpot plan | `lead_id`, `plan_json` (`{requests, skipped}`), `state` (`pending`, `delivered`, `dead`), `attempts`, `next_attempt_at` (epoch ms), `last_error`, `created_at`, `updated_at` | the CRM stage enqueues; the delivery worker (`src/crm/outbox.ts`) settles, oldest first. Dry-run writes none |
| `review_queue` | item for a person | `lead_id`, `reason` (`unresolved_company`, `ambiguous_company`, `llm_only_disqualifier`, or `model_doubt_after_alert` for a doubt the second opinion raised on a route that already went out), `candidates_json`, `created_at`, `resolved`; once a person decides (migration 010): `decision` (`use_account`, `not_for_sales`, `not_a_buyer`, `is_buyer`), `decided_by` (the typed name), `decision_note`, `decided_at`, `decision_json` (section 12) | the route stage (R6), or the second-opinion worker (`src/secondOpinion.ts`); a person's decision sets the decision columns and `resolved = 1`; a re-run deletes only its lead's open rows |
| `list_digests` | digest recorded for one list and one team (DECISIONS #24) | `id`, `list_name`, `team` (`Review` for the RevOps digest), `channel`, `rows` (folded leads in it), `batch_from`, `batch_to` (the first and last acceptance time of the list's batch; the next batch starts after `batch_to`), `at`, `payload_json` (the Slack payload, also appended to `out/slack/` with `leadId` `list:<name>`) | `src/listDigest.ts`, when the list has settled; the leads in it get `digest_id`, `alert_json.digest.at` and `timings_json.alerted` in the same transaction |
| `schema_migrations` | applied migration file | `name`, `applied_at` | the migration runner (`src/db.ts`) |

### `crm_json`

| field | dry-run | live |
|---|---|---|
| `mode` | `dry_run` | `live` |
| `requests`, `skipped` | the plan (section 5) | the plan |
| `ok`, `responses`, `ownerMapped` | absent | filled when delivery settles: `ok` is true only when every response was 2xx; `responses` has each status and HubSpot's error text; `ownerMapped` lists synthetic owner ids swapped for a portal owner. `ok` is false while delivery is pending |
| `delivery` | absent | `pending` (stored, not yet tried), `retrying` (an attempt threw or got a 429 or 5xx), `delivered` (HubSpot answered; a 4xx is recorded here and not retried), `dead` (gave up after the last attempt) |
| `attempts`, `error`, `nextAttemptAt` | absent | attempts so far, the last error, and when the next attempt is due while `retrying` |

## 2. Required fields by source

Required means the inbound handler answers 422 without it. Everything else is optional and degrades gracefully.

| source (`?source=`) | required | `source_event_id` |
|---|---|---|
| `calendly_demo` | `payload.uri`, `payload.email`; signature header; with no `CALENDLY_SIGNING_KEY` the door answers 503 | `payload.uri` |
| `guide_download`, `signal_ask_waitlist` | `fields.email` | sha1 of source, `form_id`, email, `submitted_at` |
| `sample_signup` | `user.email` | sha1 of source, email, `signed_up_at` |
| `marketplace` | `requester.email` | sha1 of source, marketplace, listing, email, `received_at` |
| `api_key` | `developer.email` | sha1 of source, product, email, `created_at` |
| `event_scan` | `badge.email` | sha1 of source, event, email, `scanned_at` |
| `web_intent` | `domain` | sha1 of source, domain, newest visit time, visit count |

Every door but `event_scan` and `web_intent` also carries an optional answer to "How did you hear about us?": a form field `referred_by`, `referral`, `how_did_you_hear` or `how_did_you_hear_about_us` (on `fields`, `user`, `requester` or `developer`, or the payload itself), or for Calendly a booking question matching "hear about", "how did you find", "referr" or "who sent you". It is carried as `ev.context.referral` (`{field, answer}`) and read after normalize (DECISIONS #26); the model never sees it.

With no timestamp in the payload, the id is a SHA-256 of the canonical JSON body (keys sorted), never the server's clock, so a re-delivery of the same body is still a duplicate. `(source, source_event_id)` is unique. A repeat delivery answers `200 {leadId, duplicate: true}` and changes nothing. Every payload may carry `"synthetic": true`; the fixtures all do, and the cockpit badges them.

Calendly signature: `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex hmac_sha256(key, t + "." + body)>`, five-minute tolerance, constant-time compare.

## 3. UTM and channel taxonomy

Normalization: trim, lowercase, then the alias map. Every change is recorded in `normalized.utmFixes` as `{field, from, to}`.

| field | aliases |
|---|---|
| `utm_source` | `li`, `lnkd`, `linkedin.com` to `linkedin`; `gads`, `adwords` to `google`; `fb` to `facebook`; `newsletter`, `mailchimp`, `hs_email` to `email` |
| `utm_medium` | `paidsocial`, `paid-social` to `paid_social`; `ppc` to `cpc`; `newsletter`, `mailchimp`, `hs_email` to `email` |

A lead that names a referrer (DECISIONS #26) reports channel `referral` whatever follows. Otherwise, first match wins: source `marketplace` to `partner_marketplace`; `event_scan` to `event`; `sample_signup` and `api_key` to `product`; `web_intent` to `unknown`; medium `paid_social` (or `cpc` from a social source) to `paid_social`; `cpc`, `paid_search`, `display` to `paid_search`; `email` to `email`; organic or social source to `organic_social`; organic search source to `organic_search`; `referral`/`partner` to `referral`; no UTM and a search-engine referrer to `organic_search`; other referrer to `referral`; nothing at all to `direct`; otherwise `unknown`.

First-touch UTMs are written to HubSpot only on a contact's first lead; last-touch on every touch.

## 4. Lifecycle mapping

| tier | `lifecyclestage` | note |
|---|---|---|
| A | `salesqualifiedlead` | |
| B | `marketingqualifiedlead` | |
| C, D | `lead` | |
| X (disqualified) and competitors | not set | HubSpot does not move lifecycle backwards, so the router never promotes what it later has to take back |

`hs_lead_status` is `NEW` on every write. Routing never creates a CRM record for `drop`, `careers` or `press` actions.

## 5. HubSpot

Dry-run is the default. Live mode requires both a service key (`HUBSPOT_SERVICE_KEY`; a legacy `HUBSPOT_PRIVATE_APP_TOKEN` also works) and `HUBSPOT_LIVE=1`, and substitutes record ids returned by the two upserts into the association and task requests (`{{contact_id}}`, `{{company_id}}`). It has run against a developer test portal, not a production one (see "Confirmed live" below).

Request plan per lead (`src/crm/hubspot.ts`), in order:

| step | request | notes |
|---|---|---|
| 1 | `POST /crm/v3/objects/companies/batch/upsert` | `idProperty: "serif_account_key"`, `id` is the account key. Skipped when there is no resolved account. |
| 2 | `POST /crm/v3/objects/contacts/batch/upsert` | `idProperty: "email"`. Properties below. |
| 3 | `PUT /crm/v4/objects/contacts/{contactId}/associations/default/companies/{companyId}` | default (unlabeled) contact to company association |
| 4 | `POST /crm/v3/objects/tasks` | A, B, existing-owner, review and account-signal routes only. `hs_timestamp` is the SLA due time, `hs_task_body` the extractive brief, `hubspot_owner_id` a synthetic id from `fixtures/owners.json`. |

Nurture enrollment is the contact property `serif_nurture_track`, which a HubSpot workflow listens for. The router does not call a sequences endpoint.

### Documentation checked on 2026-11-06

| topic | page | what was confirmed |
|---|---|---|
| contacts batch upsert | https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/batch/post-crm-v3-objects-contacts-batch-upsert | `POST /crm/v3/objects/contacts/batch/upsert`; body `{"inputs":[{"id","idProperty","properties"}]}`; `idProperty` is `email` or a custom unique-value property; 100 records per batch; partial upserts are not supported when `idProperty` is `email`. |
| companies | https://developers.hubspot.com/docs/api-reference/crm-companies-v3/guide | Documents batch read by a custom unique-identifier property via `idProperty`. **The companies batch upsert endpoint was not on any page that could be fetched.** The request here assumes the same shape as contacts (`inputs[].id/idProperty/properties`) and a property created with `hasUniqueValue: true`. Verify before live use. |
| associations | https://developers.hubspot.com/docs/api-reference/crm-associations-v4/guide | The current page documents date-versioned paths (`PUT /crm/objects/2026-09/{from}/{id}/associations/default/{to}/{id}`; batch `.../associations/2026-09/contact/company/batch/associate/default`), default contact to company `typeId` 279. **The `/crm/v4/...` path used here was not shown.** Move to the dated path that matches the portal's API version before live use. |
| tasks | https://developers.hubspot.com/docs/api-reference/crm-tasks-v3/basic/post-crm-v3-objects-tasks | `POST /crm/v3/objects/tasks`; `hs_timestamp` required; `hs_task_status` `NOT_STARTED` or `COMPLETED`; `hs_task_priority`; `hs_task_type` `EMAIL`/`CALL`/`TODO`; associations `{to:{id}, types:[{associationCategory:"HUBSPOT_DEFINED", associationTypeId}]}`; task to contact is `204`. Task to company `192` is from HubSpot's default type list and was not on the fetched page. |

### Confirmed live on 2026-11-07

Against a developer test portal, after `npm run hubspot:setup` created the custom properties with `serif_account_key` unique. Every request type in the plan above returned 200 when the stored replay of the day was loaded: a 40-event day that produced 39 leads. On the second run, 126 requests were counted: 101 writes (34 company upserts, 34 contact upserts, 33 associations) returned 200, and the 25 tasks were already open, so they were reused and not created. None failed. That confirms the three things the documentation did not show: the companies batch upsert on `serif_account_key`, the `/crm/v4` default association path, and task-to-company type `192`. Running the day a second time created no new records. The `/crm/v4` path is still not the one the current page documents; a production build should move to the dated path.

### Properties written

Definitions: `docs/hubspot-properties.json` (one-time setup; a test keeps it equal to the code). Standard properties used: `email`, `firstname`, `lastname`, `jobtitle`, `company`, `state`, `lifecyclestage`, `hs_lead_status`.

| contact property | type | meaning |
|---|---|---|
| `serif_segment` | enum | resolved account segment |
| `serif_use_case` | enum | classified use case |
| `serif_urgency` | enum | `now`, `this_quarter`, `exploring`, `unknown` |
| `serif_tier` | enum | `A`, `B`, `C`, `D`, `X` |
| `serif_fit_score`, `serif_intent_score` | number | 0 to 50 each |
| `serif_route_team` | enum | `HSP`, `BW`, `PLS`, `API`, `Nurture`, `Review` |
| `serif_source` | text | inbound door |
| `serif_lead_id` | text | router lead id |
| `serif_account_key` | text | stable account key |
| `serif_nurture_track` | text | workflow trigger for C and D leads |
| `serif_referral_kind` | enum | `customer`, `known_org`, `unknown_org`: who the contact named as referring them (DECISIONS #26) |
| `serif_referred_by`, `serif_referrer_account_key` | text | the referring organization (or the words used when it did not resolve) and its account key |
| `serif_deal_cues` | text | deal-size phrases quoted from the message, separated by semicolons (DECISIONS #25) |
| `first_touch_utm_*`, `last_touch_utm_*` | text | source, medium, campaign, content, term |

| company property | type | meaning |
|---|---|---|
| `serif_account_key` | text, **unique value** | the upsert key |
| `serif_segment`, `serif_match_method` | text | resolution result |
| `serif_hospital_count` | number | AHRQ hospital count |
| `serif_enterprise` (`yes`, `no`), `serif_enterprise_fact` | enum, text | the enterprise flag and its fact line (DECISIONS #25), on every company a lead's plan upserts |
| `serif_last_referral` | text | the latest organization a contact said this account referred, with the day; written only by the dry-run thank-you plan |
| `serif_account_score`, `serif_open_leads`, `serif_web_intent_points` | number | written by `npm run reverse-etl` from `v_account_scores` |
| `serif_ein`, `serif_registry_account_key`, `serif_rate_scope`, `serif_platform` | text | outbound groups in a play (section 7): the EIN, the registry account it belongs to (an exact link or a confirmed one), what the rate is for, the mapped platform |
| `serif_rate`, `serif_rate_pct_medicare`, `serif_card_tier_pct`, `serif_conversion_factor`, `serif_clinicians`, `serif_city_top_rate`, `serif_band_median_pct` | number | the finding |
| `serif_contract_form` (`card`, `factor`, `both`, `neither`), `serif_size_band` (`1-50`, `51-500`, `501+`), `serif_outbound_fit` (`target`, `not_target`) | enum | the finding and its fit for the platform play |
| `serif_outbound_play` (`platform`, `system_gap`), `serif_link_status` (`exact`, `probable`, `unlinked`, `confirmed`, `rejected`) | enum | the group's play and how its registry link stands (DECISIONS #27, #28) |
| `serif_features_30d`, `serif_last_feature`, `serif_last_feature_at` | text | product use (section 8), written by `npm run reverse-etl`: the features used in the 30 days up to the newest event (semicolon-separated keys, an empty string when none), the feature last used, and when |
| `serif_events_30d_<feature>` (six: `signal_search`, `signal_watch`, `api`, `mcp`, `network_benchmarking`, `quality_preview`) | number | product events for that feature in the same 30 days, zero when unused |

## 6. Registry tables read (read-only, attached as `reg`)

`cms_hospitals`, `ahrq_systems`, `ahrq_hospital_links`, `payers`, `curated_orgs`, `org_domains`, `free_mail_domains`, `disposable_domains`, `meta`. `name_norm` follows `etl/name_norm.py`; `src/resolve/match.ts` implements the same rule, and a test compares the two on every name in the real registry.

## 7. Outbound: the rate file (`src/outbound/`, migrations 004 and 008)

Input: Serif's public rate search export, `RATES_CSV` (default `data/rates/mrf_rate_search_export.csv`, git-ignored; `npm run rates:fetch` downloads it). Read with an RFC 4180 reader (`src/outbound/csv.ts`). The columns read are listed in `REQUIRED_COLUMNS` (`src/outbound/rateFile.ts`); a file missing one, with a value that is not an amount or a count, or mixing payers, networks, months or codes is refused whole and the tables are left empty. With no file the tables are empty too, and `GET /api/outbound` answers `{loaded: false, reason}`.

Loaded at startup when the file's SHA-256 differs from `rate_file.sha256`, or when `inputs_sha256` (the file, the platform mapping, the registry's meta table and `OUTBOUND_VERSION`) does. Every table below is rebuilt in one transaction, except `rate_link_decisions`, which a reload never touches. Demo reset (`clearAppData`) does not touch any of them.

| table or view | one row per | columns |
|---|---|---|
| `rate_file` | the loaded file (id 1) | `path`, `sha256`, `inputs_sha256`, `rows`, `payer`, `network`, `network_month` (YYYYMM), `code`, `loaded_at` |
| `rate_rows` | rate row, in file order (`id`) | `ein`, `entity`, `name_norm` (the router's `nameNorm`), `state` (from the street address, else the NPI region), `city` (the address part before the state), `taxonomy`, `npis` (FilteredNPIListLength), `src_npis` (PayerSourceNPIListLength), `org_npis` (AllPayerIndividualNPIs: the group's size), `rate`, `medicare` (Baseline), `pct_medicare` (RelativeToBaseline as a fraction), `most_npis` (IsMostNpisPerEinCode), `claims_evidence` (IsBillableClaims), `pos` |
| `v_rate_groups` | group (EIN) | its one rate row, plus `band`: `1-50`, `51-500` or `501+` clinicians by `org_npis` |
| `v_rate_groups_city_top` | city and state | `top_ein`, `top_rate`, `top_clinicians` (a tie on the rate goes to the larger group), `groups` |
| `rate_patterns` | pattern (`card`, `factor`) | `value` (the base or the unit), `hits` (distinct rates it explains), `distinct_rates`, `runners_up_json` (the next two, with their hits) |
| `rate_findings` | group | `ein`, `account_key` (`ein:<EIN>`), `name`, `name_norm`, `city` (title case), `state`, `clinicians`, `band`, `rate`, `medicare`, `pct_medicare` (whole percent), `form` (`card`, `factor`, `both`, `neither`), `card_tier`, `factor_multiple`, `city_top_rate`, `city_top_clinicians`, `city_top_ein`, `band_median_pct`, `fit` (`target`, `not_target`), `fit_reason`, `platform`, `platform_confirmed`, `draft_status` (`ready`, `blocked`, `none`), `draft_reason`, `hook` (`hospital_leverage`, `rate_range`) |
| `rate_links` | group | `status` (`linked`, `unlinked`), `account_id`, `account_name`, `method` (`company_name`), `score` (the best candidate's, linked or not), `reason` (a tie starts `tie:`), `candidates_json` |
| `rate_link_decisions` (migration 008) | EIN a person decided on | `decision` (`confirmed`, `rejected`), `account_id` and `account_name` (the account confirmed, or the candidate rejected, which may be null), `decided_by` (the name typed; sign-in is not built), `note`, `decided_at`. One row per EIN; a later decision replaces it. Written only by `POST /api/outbound/<ein>/link` |

**Derived on request, never stored** (`src/outbound/groupState.ts`), because a decision, a CRM owner or an inbound lead changes them between loads:

| field | values and rule |
|---|---|
| link status | `exact` (`rate_links.status = 'linked'`), `confirmed` or `rejected` (a decision; the exact link cannot be decided on), `probable` (the best candidate in the group's state, when its distinctive name is contained in the group's name or it scores 0.5 or more), else `unlinked` |
| play | `platform` (decision 20's fit, unchanged), `system_gap` (belongs to an `ahrq:` or `ccn:` account by an exact or confirmed link, more than 50 clinicians, and the city's top rate is at least 20% above its own), or none with the reason for each play |
| holder | who already has the account: the CRM mirror (the linked account's name, then the group's own), a rep's claim on the linked account, or a person lead at the linked account received in the last 90 days; `{by: crm, claim or inbound, owner, detail, accountKey, leadId}` |
| status | `suppressed` (a holder, whatever the play), else `ready` or `blocked` (the play's draft), else `link_to_confirm` (a probable link), else `not_target`; with `statusReason` |

**One rate per group** (`v_rate_groups`, the take-home's rule): the row flagged `IsMostNpisPerEinCode` first, then the largest `PayerSourceNPIListLength`, then the largest `FilteredNPIListLength`, then the higher rate; file order settles rows equal on all four.

**Tolerances** (`src/outbound/patterns.ts`, ported from the take-home's `analysis.py`):

| test | rule |
|---|---|
| card tier | `p = round(rate / base x 100)` (half to even, as Python rounds), and `p` is from 50 to 300, and `base x p / 100` rounded to the cent is within $0.011 of the rate |
| conversion factor | the rate in cents is an exact whole multiple of the unit in cents |
| base search | every distinct rate from $100 to $200 as the base; best is the most distinct rates on a tier, then the larger base |
| unit search | every amount from $2.00 to $10.00 by the cent; best is the most distinct rates that are multiples, then the larger unit |
| a pattern | needs at least 3 distinct rates (`MIN_PATTERN_HITS`); otherwise it is absent and no group is on it |
| card range in a draft | the lowest and highest card tiers that two or more small groups share, shown in whole dollars rounded outward ($106.10 to $148.54 reads as $106 to $149) |

**API.** `GET /api/outbound`: `loaded`, `status` (`loaded`, `unchanged`, `missing`, `failed`), `reason`, `file`, `patterns` (each with its search rule), `summary` (per band: groups, median percent of Medicare, card, factor, both, neither, where card and factor count a group on both in both; totals per form; the platform play's fit and draft counts; `plays` (per play: name, team, groups, ready, blocked, suppressed); `statuses` (groups per status); `links` (groups per link status)), `actions` (`linkDecisions`: whether the server takes them; `export`: the CSV path) and `groups` (each with its finding, platform fit, `play`, `playReason`, `team`, `status`, `statusReason`, `link` (`status`, `why`, `basis` (for a probable link, `name` when the candidate's distinctive name is in the group's name and `score` when only its score made it probable; else null), `accountKey` and `accountName` only when exact or confirmed, `probable` (the candidate asked about), `decision`, `ifConfirmed` (the play a confirmation would put it in)) and `holder`). `GET /api/outbound/<ein>`: `finding`, `sourceRows` (each rate row, `chosen` marking the one rate), `link` (the loader's record with its candidates), `linkReview` (status, account, probable candidate, why, decision, candidates), `work` (the same play, status, link and holder fields as the list), `draft` (the platform play's draft, ready or blocked; the system-gap draft, ready, with `hook: null`; or for any other group, a group someone has or a probable link, a labelled preview under the group's own name: `kind`, `status`, `label`, `reason`, `hook`, `hookNote`, `subject`, `body`, `linkedin`, `parts` (the same three texts as runs, `{subject, body, linkedin}`, each an array of `{text, placeholder?, open?}`: a run with a `placeholder` is a value code inserted, one with `open` is a placeholder left for a person; the runs join back to the text, and the cockpit marks inserted figures from them), `inserted` (each `{placeholder, value, field}`), `placeholders` (`{first_name}`)), `draftUnavailable`, `rateLine` and `hubspot` (`{mode: 'dry_run', requests, skipped}`: the company upsert for a group in a play that nobody has, with `serif_outbound_play` and `serif_link_status`; nothing for any other group, with the reason). 404 for an unknown EIN, with the reason when no file is loaded.

`GET /api/outbound/export.csv`: `text/csv`, one row per ready draft, columns `ein`, `account_keys` (`ein:<EIN>` and the registry key, `;`-separated), `play`, `team`, `group_name`, `city`, `state`, `clinicians`, `rate`, `pct_of_medicare`, `city_top_rate`, `contract_form`, `card_tier`, `conversion_factor`, `subject`, `body`, `linkedin` (`{first_name}` left open); RFC 4180 quoting, CRLF records, a header row always. `GET /api/outbound/export`: `rows`, `groups`, `ready` (`total`, `byPlay`), `blocked` (`total`, `why`: reasons with counts), `suppressed` (`total`, `why`: owner and kind with counts, `inAPlay`), `waitingForLinkDecision` (`total`, `wouldJoinSystemGap`), `notTarget`; the five totals add up to `groups`.

`POST /api/outbound/<ein>/link` (only with `DEMO_ROUTES=1`; otherwise 404 saying so): body `{decision: 'confirm' | 'reject', accountKey, by, note}`. `by` is required (at most 80 characters) and `note` optional (at most 500); a confirmation needs an `accountKey` from the group's candidates. 200 with `{decision, linkReview, work}`; 404 for an unknown EIN; 409 for a group the loader linked exactly; 422 for a bad body or an account that is not a candidate; 405 for anything but POST.


## 8. Product usage and deals (`src/usage/`, migration 005)

Ties what accounts do in the product to the deals sales works, so "I built this feature, did it help sell?" has an answer with its counts. PostHog is the source of events and HubSpot of deals; in this prototype the events arrive through `POST /api/usage` and both are also loaded from synthetic fixtures. Times are stored as UTC ISO text with milliseconds, the only form the adapter and the loader write, so a text comparison is a time comparison.

### Events

`POST /api/usage` takes PostHog's shape: a bare array, a capture body `{ batch: [...] }`, or one event. Each event: `event` (name), `distinct_id`, `timestamp` (ISO), `uuid`, and `properties` carrying the company group (`$groups.company`, else `$group_0`) and optionally `synthetic: true` (or `synthetic: true` on the batch). At most 1,000 events per request. Unsigned, like every door but Calendly.

| table | one row per | columns |
|---|---|---|
| `usage_events` | PostHog event uuid | `event_id` (primary key; with no uuid, a hash of the name, id and time, never the server's clock), `account_key` (null when the group named no account), `group_key` (as sent), `contact_key` (the router's contact key when `distinct_id` is an email, else null), `feature` (null when the name is not in the taxonomy), `event_name`, `occurred_at`, `received_at`, `synthetic`, `source` (`api` or `fixture`) |
| `features` | feature | `feature`, `label`, `status` (`launched` or `preview`), `launched_at` (null exactly when the status is `preview`), `team`, `preview_of_add_on` (the add-on a feature previews). From `fixtures/usage/features.json`, replaced whole on load; a feature with no `status` there is launched |
| `add_ons` | add-on | `id`, `label`, `price_low`, `price_high` (whole dollars) |
| `deals` | deal | `id`, `account_key`, `stage`, `amount` (whole dollars), `created_at`, `closed_at`, `outcome` (`won`, `lost`, null while open; set exactly when `closed_at` is), `add_on` (the add-on the deal sells, null for the base product and for seat or renewal deals), `synthetic`, `source` |
| `usage_fixture` | the loaded fixture | `sha256` of the three fixture files, so an unchanged restart does nothing |

**Taxonomy** (`src/usage/taxonomy.ts`, the one place): `signal_search_run` and `search` (the sample sign-up door's name for it) to Signal search (`signal_search`); `watch_alert_created` to Signal Watch alert created (`signal_watch`); `api_call` to `api`; `mcp_tool_call` to `mcp`; `benchmark_viewed` to network benchmarking view (`network_benchmarking`); `quality_preview_viewed` to quality data preview (`quality_preview`). Any other name (`$pageview`, say) is stored with `feature` null, counted as unmapped, and never dropped.

**Account resolution** (`src/usage/account.ts`): the group key is either an account key (`crm:...`, `ahrq:...`, `domain:...`) or a domain. A key resolves when the router knows it (a CRM mirror entry or an account a lead created). A domain resolves through the CRM mirror's domains, then the domain on an account a lead created, subdomains included. Anything else is stored with `account_key` null and counted as unresolved; a name is never guessed into an account.

**Idempotency.** An event whose uuid is stored changes nothing and is counted as a duplicate; the first copy wins. A batch is written in one transaction. The answer is `{ received, stored, duplicates, unmapped, unresolved, rejected }` with `received = stored + duplicates + rejected.length`; `unmapped` and `unresolved` count the events stored by this request. An event with no name or no valid timestamp is listed in `rejected` as `{ index, reason }` and the rest go through. A body that is not JSON answers 400, one that is not a batch or is over the limit 422, any method but POST 405.

**Fixtures** (`fixtures/usage/`, loaded at startup by `src/usage/load.ts` when their hash changes; `USAGE_FIXTURES` points elsewhere): `features.json` (written by hand), `deals.json` and `events.json` (generated by `npm run gen-usage` from the tables in `scripts/gen-usage-fixtures.ts`). Events go through the same adapter and writer as the API, with `source` `fixture`. A changed file replaces every `fixture` row (events, deals, reference data) and leaves rows from the API alone; a file that cannot be used (a deal on an unknown account, a stage that disagrees with its close date) is refused whole and the fixture rows are removed. Deal stages: `qualified`, `proposal`, `negotiation` (open), `closed_won`, `closed_lost`. Every account is one of the twelve fictional organizations in `fixtures/crm-mirror.json`, keyed `crm:<mirror id>`. Demo reset does not touch these tables.

### The attribution definition

`sql/models/v_usage_deal_influence.sql`. A feature **influenced** a deal when the deal's account used it in the **90 days before the deal was created, or while the deal was open**: from 90 days before `created_at` to `closed_at`, both ends included, and for a deal still open to the **as-of date**, which is the newest event (`v_usage_asof`; replayed history keeps a window, as in `v_account_scores`). Only mapped events on a resolved account count. A deal can be influenced by several features, so the rows overlap and do not add up. This is influence, not proof of cause, and the API and the cockpit say so.

`v_usage_feature_influence` gives per feature: accounts using it and events; the influenced deals (count and amount) as won, lost and open; **win rate with use** (won over closed among influenced deals) and **without** (the same over every other closed deal), each returned with its counts; the **median days from the account's first use to the deal opening**, over influenced deals whose first use came first (the others are counted as `used_after_open`); and **adoption since launch**, the accounts that used the feature since `launched_at` over the accounts that used any feature since then. `GET /api/attribution` marks a comparison with fewer than 5 closed deals on either side `small`.

### Expansion signals

`v_usage_expansion` holds the facts (uses and people in the 30 days up to the as-of date, both ends included; whether the account is a customer; how many deals it has for the add-on), and `src/usage/expansion.ts` is the rule: **a customer account that used an add-on's preview at least 3 times in the last 30 days and has no deal, of any stage, for that add-on.** A customer is an account with a closed-won deal for the base product. Each signal lists its evidence and a dry-run HubSpot plan (the company, so the task has something to attach to, and a task for the account's owner whose body is the evidence and its price range). The plan is built with the router's request builders. It is never put in `crm_outbox`, because a dry-run lead plan never is and a plan stored there would be sent by a live boot. No routing changes.

### API

`GET /api/attribution` (read-only): `loaded`, `status`, `reason` (when not loaded), `asOf`, `model` (`kind`, `windowDays`, `definition`, `caveat`, `smallSample`, `note`), `synthetic` (`events`, `deals`, `allSynthetic`, `note` for usage and deals, and `interest` with `leads`, `synthetic`, `allSynthetic` and its own `note` for the lead stream), `data` (`accounts`; `events` total, mapped, unmapped, unresolved; `deals` total, open, won, lost and influenced, each with count and amount; `unmappedByName`), `features` (per feature: `label`, `team`, `status`, `launchedAt` and `daysSinceLaunch` (both null for a feature in preview), `interest` and `asked` (section 11), `accountsUsing`, `events`, `adoption`, `opportunities`, `byOutcome`, `winRate` with `with`, `without` and `small`, `firstUseToOpportunity`, and `deals` with each influenced deal's account, stage, amount, dates and uses in the window) and `expansion` (`rule`, `minUses`, `windowDays`, `signals`).

### Reverse ETL

`npm run reverse-etl` writes each company's usage properties (section 5) beside its lead scores, for every account with product use, in the same dry-run batch. The expansion tasks are written to `out/hubspot/expansion-tasks-<date>.jsonl` as a dry run in every mode.


## 9. Uploaded lists (`src/lists.ts`, `src/listDigest.ts`, migration 006)

A door in `LIST_DOORS` (default `event_scan`; `none` for no list doors) carries a list someone uploads, and each event names its list (`list` or `event` in the payload, else `<door> (no list name)`).

- Routing: unchanged. A list lead whose route is `team_queue`, `owner_task`, `nurture` or `review` keeps its route, SLA, review item and CRM plan, posts no Slack payload of its own and is folded (`alert_json.digest`). A `rep_alert`, a repeat that re-alerts its rep, and a `competitor_flag` keep their own alert.
- The model: with `LIST_DOOR_MODEL` unset (`after_alert`), a list lead is routed on the rules and the model call follows as its second opinion, whatever the note says. `LIST_DOOR_MODEL=gated` puts list doors back under the gate of DECISIONS #19.
- Settled: none of the list's leads is unfinished (`status` other than `done` or `failed`) and none was accepted for `LIST_QUIET_MS` (default 5000 ms). Then one digest per team is recorded for the list's batch.
- A digest (`buildListDigest` in `src/notify/slack.ts`) carries the list's name, its rows in this upload and for the team, counts by tier and by action, the top 10 by score (name, title, organization, tier, score and the booth note cut to 120 characters), how many more, the list's repeats attached and rows at unknown organizations (unresolved, ambiguous, or an inferred employer), and the earliest SLA due among the team's rows. The RevOps digest (`buildReviewDigest`) lists up to 30 review rows by name, the company as typed and the reason. Channels: `#leads-<team>`, `#revops-review` for `Review`, `#marketing` for `Nurture`.
- Settings: `COMMIT_GRACE_MS` (default 250; `never` keeps strict acceptance order), `LIST_DOORS`, `LIST_DOOR_MODEL`, `LIST_QUIET_MS`.

`GET /api/dashboard` adds `lists`: one entry per list, newest first, with `name`, `rows`, `byTier`, `byAction`, `repeatsAttached`, `unknownOrgs`, `inFlight`, `folded`, `waitingForDigest`, `digests`, `firstAccepted` and `lastAccepted`; each `review` item carries `list`, and `GET /api/leads` summaries carry `list` and the flag `in_digest`. A folded lead counts as alerted (the funnel's Alerted step, the SLA counts) once its digest is recorded. `speed.timeToAlert` covers leads with their own alert; `speed.digestDelay` (`n`, `p50`, `p90`) is the time from arriving to the digest for folded rows on a sales route. `GET /api/stream` sends a `list` event when a digest is recorded.

`npm run list:upload` (`scripts/list-upload.ts`, with the generator in `scripts/lib/list-upload.ts`) posts a seeded, synthetic badge-scan list: people invented, organizations from the registry in use, 12% at fictional unknown companies on `.example`, 5% on free mail, 3% at the fictional customers in `fixtures/crm-mirror.json`, 4% second scans of a badge already in the list, shuffled.


## 10. Enterprise accounts, referrals and the accounts API (migration 007, `sql/models/v_accounts.sql`)

**Enterprise** (`src/enterprise.ts`, DECISIONS #25): a health system with 8 or more hospitals or hospitals in 3 or more states, a national or Blue payer, or a national benefits consultant, broker or TPA. A starting assumption for Serif to replace. **Deal-size cues** (`src/dealCues.ts`): rules over the message only. **R10**: a person (not web intent, not a list door), no disqualifier, tier A or B, at an enterprise account or at a confidently resolved sales-segment organization whose message has a cue, goes to a named rep by round-robin in the R7 team and claims the account; SLA 5 minutes for tier A, 15 for tier B, from the next business open.

**Referral** (`src/referral.ts`, `src/leadSignals.ts`, DECISIONS #26): captured from the door's answer and from message phrases, resolved through the CRM mirror and then the registry matcher (confident matches only). Score: one intent line, `Referral: <name> (a customer | not a customer | organization not identified)`, 10, 6 or 3 points, inside the 50-point intent cap. The thank-you plan (`planReferralThanks` in `src/crm/hubspot.ts`): a company upsert of the referring account with `serif_last_referral`, and a task for its owner due 540 business minutes after the lead, subject `Thank <referrer> for referring <organization>`. Stored on the lead only; never in `crm_outbox`.

**Views** (redefined at every start): `v_accounts` (one row per account: key, name, segment, domain, `enterprise`, `enterprise_fact`, `claimed_owner`, `account_score`, `top_tier`, `leads_30d`, `contacts_30d` from `v_account_scores`, `last_activity_at` (the latest lead or signal), `referrals_in`, `referrals_out`, `web_intent_signals`, `has_rate_fact` (a rate group linked exactly or by a person's confirmation, or a lead that carried a rate line), `open_reviews`); `v_account_people` (one row per person lead at an account); `v_account_signals` (`kind` `web_intent`, `claim`, `referral_out`, `referral_in`, `deal_cue`, with `detail`, `lead_id`, `at`). Reads are in `src/store/accountViews.ts`.

**API** (read-only, `api/accounts.ts`, `src/accounts.ts`). `GET /api/accounts?limit=50` (1 to 500; anything else is 50): `{ total, accounts }`, ranked enterprise first, then `accountScore`, then `lastActivityAt` (newest first). Each account: `key`, `name`, `segment`, `enterprise`, `enterpriseFact`, `owner` and `ownerSource` (`crm` for a seeded CRM owner, `claim` for a rep who claimed it, else null), `accountScore`, `topTier`, `leads30d`, `contacts30d`, `lastActivityAt`, `referralsIn`, `referralsOut`, `webIntentSignals`, `hasRateFact`, `openReviews`. `GET /api/accounts/<key>` (the key URL-encoded) adds `domain`, `people` (`leadId`, `name`, `title`, `door`, `tier`, `score`, `routeAction`, `owner`, `receivedAt`, newest first, up to 50), `signals` (`kind`, `detail`, `leadId`, `at`, newest first, up to 50), `rateLine` (the line a lead here carried, or null) and `reviews` (open review items: `leadId`, `reason`, `createdAt`); 404 for a key the router does not hold, 405 for any method but GET.

**Dashboard.** `GET /api/dashboard` adds `referrals`: `people` (leads that name a person), `named`, `share` (percent of `people`), `byKind`, `tiers` (`referred` and `others`, by tier), `salesReady` (percent A or B, `referred` and `others`), `webOrUtmReferral` (leads whose channel reads referral from a web referrer or UTM only, with nobody named), `thanksPlanned`, and `referrers` (`key`, `name`, `customer`, `owner`, `kind`, `leads`, `salesReady`, ranked by leads sent, then sales-ready, then name). `GET /api/leads` summaries carry the flags `enterprise` and `referral`, and a lead's detail carries `deal` and `referral`. A list digest marks enterprise rows and lists them first.

## 11. Feature interest and the team brief (`src/interest/`, `src/todayBrief.ts`, migration 009)

**Tags** (DECISIONS #30). `lead_interest`, one row per lead, feature and cue: `lead_id`, `feature` (a key of `src/usage/taxonomy.ts`), `cue` (`message`, `door`, `path` or `guide`) and `evidence` (the phrase in quotes, `<source> door` or `<source> door, product <product>`, `<paths>: <n> visits`, or `guide "<title>"`). Rewritten whenever the lead is committed. `leads.interest_tagged_at` is set when the lead has been looked at, with or without a tag; at start every finished lead without it is looked at. The cues are `FEATURE_CUES` in `src/usage/taxonomy.ts`: `aliases`, `paths`, `doors` (a source, optionally narrowed by an API key's product) and `guides` (HubSpot form ids). Read apart from the stored tags: a person is one contact (the contact key, else the lead), and leads routed `drop`, `careers`, `press` or `competitor_flag` are left out.

**`GET /api/attribution`, per feature** (added to the fields in section 8):

| field | meaning |
|---|---|
| `status`, `launchedAt`, `daysSinceLaunch` | `launched`, or `preview` with both dates null |
| `interest.leads` | people who showed interest (one per contact) |
| `interest.accounts` | distinct accounts those people belong to (a person the router could not place adds none) |
| `interest.salesReady` | of them, tier A or B |
| `interest.byTier` | `A`, `B`, `C`, `D`, `X` and `pending`, by the person's newest lead |
| `interest.byCue` | people per cue kind; one person can be in several |
| `interest.sinceLaunch` | people who came in at or after the launch; null for a feature with no launch date |
| `asked[]` | up to 50 people, newest first: `leadId`, `accountKey`, `accountName`, `owner` (CRM owner, else the claiming rep), `customer`, `person` (`name`, `title`; null for account-level web visits), `door`, `cue` (strongest: message, door, path, guide), `cues`, `evidence`, `quote` (their message cut at 220 characters, only when the cue includes the message), `at` |

**`GET /api/brief?hours=24`** (read-only). `generatedAt`, `window` (`hours`, `from`, `to`; 1 to 720, anything else is 24) and `sections`, an object with the eight keys `needs_person`, `enterprise`, `referrals`, `lists`, `expansion`, `outbound`, `interest`, `health`. Each section: `id`, `title`, `headline` (one sentence), `count`, `figures` (`label`, `value`, `unit` `count` or `ms`, `tab`), `items` (at most 10) and `more` (how many it left out). Each item: `kind`, `title`, `detail`, `tab` (`overview`, `stream`, `review`, `outbound` or `feature-pipeline`) and `ids`, any of `leadId`, `accountKey`, `ein`, `list`, `feature`. `npm run brief` prints it as text and writes `brief.txt` and `brief.json` under the output folder.

## 12. A person's review decision (`src/review/`, `api/review.ts`, migration 010)

Served only with `DEMO_ROUTES=1`, like the other demo writes. Sign-in is not built, so the request names who decided, and that typed name is what is stored (DECISIONS #33).

**`POST /api/leads/<id>/review`.** Body: `by` (required, up to 80 characters), `note` (optional, up to 500), `decision`, and what the decision needs:

| decision | takes | needs | does |
|---|---|---|---|
| `use_account` | a company item (`unresolved_company`, `ambiguous_company`) | `accountKey`: one of the item's candidates; for an item with no candidates, a key the registry (`ahrq:`, `ccn:`, `payer:`, a curated `domain:`) or the CRM mirror (`crm:`) holds | runs the lead again on that account: resolution `method: "person"`, `confidence: "high"`, the decision as its evidence, then score, route, alert and CRM plan as for any lead |
| `not_for_sales` | a company item | | runs it again with the route `nurture` to `Marketing (Sam)`, the segment's track, rule `person` |
| `not_a_buyer` | any item | `reason` | runs it again with the route `drop`, rule `person`, the reason in the route's reason; nothing is written to the CRM |
| `is_buyer` | a doubt item (`llm_only_disqualifier`, `model_doubt_after_alert`) | | held before the route: runs it again with the model's review reason and any model-only disqualifier taken out. After the alert: closes the item and runs nothing |

Answers 200 with `leadId`, `decision`, `rerun`, `finished` (the re-run settled within 10 s), `outcome` (one line, such as "Routed: tier B, Health Systems & Providers queue") and `route` (`action`, `team`, `owner`, `tier`, `rule`, `account` now). Refuses with 404 (no such lead; or the demo actions are off), 409 (no open item, naming who decided it and when; or the lead is still running) or 422 (a body or a decision the item does not take, a key that is not a candidate, or one nothing holds).

**Stored.** `leads.review_decision_json`: `kind`, `by`, `note`, `at`, `itemReason`, `account` (`{key, name, from: candidate | registry | crm}` or null), `reason` (not a buyer's, or null). `review_queue.decision_json` holds the same with `before` (the lead's `action`, `team`, `owner`, `tier`, `rule` and `account` before the decision) and `rerun`.

**`POST /api/review/list`.** Body: `list`, `by`, `note`. Applies `not_for_sales` to every open `unresolved_company` item whose lead came in on that list, and answers `list`, `count`, `decided` (lead ids), `skipped` (`{leadId, error}`, a lead still running, say) and `finished`. 404 when the list has no such rows.

**`GET /api/review`.** `demoActions` (whether the writes are served), `open` (every open item, oldest first: `leadId`, `reason`, `kind` (`company` or `doubt`), `createdAt`, `receivedAt`, `source`, `synthetic`, `list`, `person`, `title`, `email`, `companyTyped`, `org`, `tier`, `route` (`action`, `team`, `owner`, `rule`, `reason`), `candidates`, `decisions` (the ones the item takes), `busy`) and `decided` (the last 20, newest first: `leadId`, `reason`, `decision`, `by`, `note`, `at`, `person`, `company`, `list`, `outcome` (from the lead's route now), `before`, `account`, `notBuyerReason`).

**The trail.** `GET /api/leads/<id>` has `decisions`: every decision on the lead, oldest first, each the stored `decision_json` (with `before`); the route now is `route`. `review` is the open item when there is one, otherwise the latest decided one.

**`GET /api/how`.** `registry`: `kind` (`real` or `mini`), `hospitals`, `systems`, `payers`, `verifiedDomains`, the counts the How it works drawing shows (DECISIONS #34).

## 13. The lead summary row, taking a link decision back, and the cockpit's address (`src/view.ts`, `api/outbound.ts`, `public/address-model.js`)

**`GET /api/leads?limit=<n>`** answers `{leads: [...]}`, newest first, at most `n` (default 200, ceiling 1000; the cockpit asks for 1000). Each row is a `LeadSummary` (`src/view.ts`), small enough that a thousand of them are about 600 KB. `GET /api/leads/<id>` adds the trail to the same fields, and where it has a field of the same name (`referral`, `deal`) the detail's is the fuller one.

| field | meaning |
|---|---|
| `id`, `receivedAt`, `source`, `synthetic`, `status` | the lead and its door |
| `person` | `{name, title, email}`, or null for an account's web visits |
| `org` | `{name, accountId, segment, matchedBy, confidence}`; `accountId` is the account key the Accounts table and `account=` in the address use |
| `tier`, `score` | the lead's tier and its 0 to 100 score |
| `routeAction`, `routeTeam`, `owner`, `rule` | where it went and the rule that sent it (`R1` to `R10`, `person` for a person's decision); null while it is still being routed |
| `useCase`, `urgency` | the classifier's final labels |
| `enterprise`, `enterpriseFact` | whether the account is enterprise (DECISIONS #25), and the fact line behind it ("145 hospitals in 20 states") |
| `referral` | `{kind, referrer}` for a named referral (DECISIONS #26), the referrer being the account's name when it resolved to one, else the words; null when nobody was named. `kind` is `customer`, `known_org` or `unknown_org` |
| `dealCue` | the first deal-size cue in the message, as written (DECISIONS #25); null when there is none |
| `list` | the uploaded list it came in on (DECISIONS #24), or null |
| `timeToRouteMs` | the 202 to the routing decision |
| `timeToAlertMs` | the 202 to the lead's own alert, counted as the dashboard counts time to alert: a sales route (rep alert, owner task, team queue) whose Slack message went out and was not folded into a list digest. Null otherwise, which is every list row |
| `flags` | `free_mail`, `duplicate`, `review`, `competitor`, `after_hours`, `existing_account`, `idempotent_replay`, `in_digest`, `enterprise`, `referral` |

Nothing here is a decision: the cockpit filters, orders and searches these fields and never writes them back.

**`GET /api/attribution`** adds `tier` to each person in a feature's `asked` list: the tier of their newest lead (null before it is scored). The cockpit's sales-ready filter is tier A or B, as the dashboard counts it.

**`DELETE /api/outbound/<ein>/link`** takes a person's link decision back. Served only with `DEMO_ROUTES=1`, like the `POST` on the same path (DECISIONS #14 and #28). It deletes the row in `rate_link_decisions` for that EIN, so the group returns to what the loader found (a probable link, or none) and every count, status, draft and export row follows. Answers 200 with `cleared: true`, `linkReview` and `work` as the group now reads. 404 when the demo actions are off, for an unknown EIN, and for an EIN with no recorded decision (it does not pretend to have done something); 405 for any method but `GET` on the group, and `POST` and `DELETE` on `/link`. The loader's exact link has no decision to clear. A review decision has no such call: a second decision on a review item is refused (DECISIONS #33).

**The address.** The cockpit's view is `location.hash`: `#<tab>?<key>=<value>&...`, values percent-encoded, keys left out when they are at their default. The tab words are `overview`, `today`, `stream`, `review`, `outbound`, `feature` (the Feature to pipeline tab), `evals`, `quality` and `how`; an address that names none opens the Overview. Parameters by tab:

| tab | parameters |
|---|---|
| `stream` | `lead` (the open lead), `route` (`alert`, `queue`, `nurture`, `review`, `other`), `enterprise=1`, `referral=1`, `referrer` (a referrer's name), `tier` (`A` to `D`), `team` (`HSP`, `BW`, `PLS`, `API`, `Review`, `Nurture`), `door` (a source), `list` (a list's name, or `none`), `account` (an account key), `q` (the search), `sort` (`score`, `tier`, `alert`, `org`; `received` is the default), `dir` (`asc` or `desc`, left out when it is the column's first direction) |
| `outbound` | `ein` (the open group), `status` (`ready`, `blocked`, `suppressed`, `link`, `not_target`), `play` (`in_play`, `platform`, `system_gap`, `all`, `card`, `factor`; the default is `in_play`, or `all` when `status` is set), `state`, `q`, `sort`, `dir` |
| `feature` | `f` (the open feature), `customers=1`, `ready=1`, `cue` (`message`, `door`, `path`, `guide`), `sort` and `dir` (the features table), `asort` and `adir` (the asked list: `when` or `account`) |
| `today` | the accounts table: `enterprise=1`, `noowner=1`, `referral=1`, `q`, `sort` (`name`, `owner`, `people`, `latest`, `score`; the default is the API's rank), `dir` |
| `review` | `lead` (brings that item forward) |

A word a tab does not have (a tier E, a sort that is not a column) falls back to the default for that parameter, so a hand-edited address cannot put a view in a state it does not have. `test/cockpit-address.test.ts` and the tab model tests read and write every parameter above.
