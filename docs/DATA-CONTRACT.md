# Data contract

What crosses each boundary: inbound payloads, the canonical lead, the CRM. Source of truth for types is `src/schema.ts`; for tables, the files in `sql/migrations/`, applied once each in name order and recorded in `schema_migrations` (DECISIONS #18).

## 1. Canonical lead

Every inbound payload is adapted to one `LeadEvent` (`src/sources/*`), normalized (`src/normalize.ts`), and stored on `leads`.

| group | fields |
|---|---|
| identity | `id` (uuid), `source`, `source_event_id`, `received_at` (ISO UTC, from the payload), `accepted_at` (ISO UTC, the server's clock at the 202; orders boot recovery), `synthetic` |
| person | `email` (trimmed, lowercased; its domain must be a plain DNS hostname, so an address with a port, path, IP address or bare name like `localhost` is treated as having no email), `first_name`, `last_name` (title-cased), `title`, `title_function`, `title_seniority` |
| company as submitted | `company_name_raw`, `company_domain` (null for free-mail and disposable), `state` (2-letter), `country` |
| attribution | `utm_source/medium/campaign/content/term` (normalized), `channel`, `landing_page`, `referrer` |
| message | `message` (the prospect's own words, never rewritten) |
| dedupe | `contact_key` (sha256 of the email, 16 hex), `duplicate_of` (first lead of the same contact within 30 days) |
| resolution | `account_id`, `segment`, plus `resolution_json` (method, confidence, evidence, firmographics, candidates) |
| qualification | `qualification_json` (rules output with its evidence, including the date parser's `urgencyCue`, `urgencyDate`, `urgencyDays` and `urgencyKind`, model output, final with per-field `sources`, per-field agreement, fallback reason, prompt and combine versions). This is what the route used: for a lead alerted on the rules (decision 19) `llm` is null and the fallback reason starts `model_after_alert`; the model's answer is in `second_opinion_json` |
| second opinion | `second_opinion` (null when none is due; `pending`, `running` while a call is in flight, `done`), `second_opinion_json` (while due: `{shownSegment}`, the organization type the model is shown; once done: `at`, `provider`, `latencyMs`, `llm` (what the model said, or null), `fallbackReason`, `answered`, `agreed`, `changed` (any of `useCase`, `buyingRole`, `disqualifier`, `reviewReason`: what the full combine would have decided differently from the route), `roleFilled`, `doubt` (`{disqualifier, confidence, heldForPerson}` or null), `followedUp`, `afterAlertMs` (the alert to the answer), `shownSegment`; or `{at, error}` if the worker itself failed) |
| decision | `tier`, `score`, `score_json` (itemized), `route_action`, `route_team`, `owner`, `sla_due_at`, `route_json` (rule and reason) |
| rate fact | `rate_fact_json` (null unless the organization has a rate group in the outbound module, section 7: `ein`, `name`, `line` (the sentence the brief, the Slack alert's "Their rates" field and the CRM task carried), `matchedBy` (`registry_link` or `name_and_state`), `accountId`, `groups` (how many groups matched; the line describes the largest)). Read after the route; nothing scores or routes on it |
| sync | `crm_json` (the exact HubSpot requests and, in live mode, how their delivery went; below), `alert_json` (`slack`: the Slack payload or null, `suppressed`, `failure`: the RevOps alert of a lead that was given up, and `followUp`: the payloads a model doubt after the alert sent, to the alert's channel and `#revops-review`) |
| processing | `status` (`received`, then one per stage: `normalized` ... `synced`, then `done`; `retrying` while a failed run waits for its next attempt; `failed` once given up), `attempts` (failed runs), `retry_at` (epoch ms of the next run while `retrying`) |
| timing | `time_to_route_ms` (receipt to routing decision), `timings_json` (ms per stage, plus: `queued`, the 202 to the lead's turn in the ordered section; `prepared`, the 202 to its order-independent work being ready; `waitedForPrepare`, its turn to that moment; `prepare`, the order-independent work itself, a wait for a model slot included; `modelBeforeRoute`, the model call the route waited for, when there was one; `alerted`, the 202 to the alert; and `total`. Normalize, resolve and qualify run in the prepare step, alongside other leads, so they can overlap `queued`. The alert stage runs before the HubSpot write) |

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
| `ein:<EIN>` | a contracting group in the rate file (outbound module, section 7); keyed on the file's EIN, never its name, and linked to a registry key only on a unique, strong name match | Serif's rate file |

`accounts.owner` holds a rep only after a tier-A rep alert claimed the account (see DECISIONS #5); owners seeded in `fixtures/crm-mirror.json` are never stored there. The claim itself is a row in `account_claims` (below); it is also shown as a human-readable `account_signals` row of type `claim`, and the claiming lead's company upsert carries `hubspot_owner_id`.

Free-mail leads whose company can't be matched, and ambiguous leads, get no account (`account_id` is null) until a person resolves them.

### Tables beside the lead

| table | one row per | columns | written by |
|---|---|---|---|
| `account_claims` | lead whose rep alert claimed an account | `lead_id` (primary key), `account_id`, `owner`, `at` (the lead's received time) | the route stage, in the same transaction as the assignment; a re-run deletes its lead's row and clears `accounts.owner` if that rep still holds it |
| `account_signals` | account-level event shown in the cockpit | `account_id`, `lead_id` (the lead that wrote it), `type` (`claim`, `web_intent`), `detail` (human-readable, never parsed), `at` | the route stage; a re-run deletes its lead's rows |
| `crm_outbox` | live HubSpot plan | `lead_id`, `plan_json` (`{requests, skipped}`), `state` (`pending`, `delivered`, `dead`), `attempts`, `next_attempt_at` (epoch ms), `last_error`, `created_at`, `updated_at` | the CRM stage enqueues; the delivery worker (`src/crm/outbox.ts`) settles, oldest first. Dry-run writes none |
| `review_queue` | item for a person | `lead_id`, `reason` (`unresolved_company`, `ambiguous_company`, `llm_only_disqualifier`, or `model_doubt_after_alert` for a doubt the second opinion raised on a route that already went out), `candidates_json`, `created_at`, `resolved` | the route stage (R6), or the second-opinion worker (`src/secondOpinion.ts`); a re-run deletes its lead's rows |
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

With no timestamp in the payload, the id is a SHA-256 of the canonical JSON body (keys sorted), never the server's clock, so a re-delivery of the same body is still a duplicate. `(source, source_event_id)` is unique. A repeat delivery answers `200 {leadId, duplicate: true}` and changes nothing. Every payload may carry `"synthetic": true`; the fixtures all do, and the cockpit badges them.

Calendly signature: `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex hmac_sha256(key, t + "." + body)>`, five-minute tolerance, constant-time compare.

## 3. UTM and channel taxonomy

Normalization: trim, lowercase, then the alias map. Every change is recorded in `normalized.utmFixes` as `{field, from, to}`.

| field | aliases |
|---|---|
| `utm_source` | `li`, `lnkd`, `linkedin.com` to `linkedin`; `gads`, `adwords` to `google`; `fb` to `facebook`; `newsletter`, `mailchimp`, `hs_email` to `email` |
| `utm_medium` | `paidsocial`, `paid-social` to `paid_social`; `ppc` to `cpc`; `newsletter`, `mailchimp`, `hs_email` to `email` |

Channel, first match wins: source `marketplace` to `partner_marketplace`; `event_scan` to `event`; `sample_signup` and `api_key` to `product`; `web_intent` to `unknown`; medium `paid_social` (or `cpc` from a social source) to `paid_social`; `cpc`, `paid_search`, `display` to `paid_search`; `email` to `email`; organic or social source to `organic_social`; organic search source to `organic_search`; `referral`/`partner` to `referral`; no UTM and a search-engine referrer to `organic_search`; other referrer to `referral`; nothing at all to `direct`; otherwise `unknown`.

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
| `first_touch_utm_*`, `last_touch_utm_*` | text | source, medium, campaign, content, term |

| company property | type | meaning |
|---|---|---|
| `serif_account_key` | text, **unique value** | the upsert key |
| `serif_segment`, `serif_match_method` | text | resolution result |
| `serif_hospital_count` | number | AHRQ hospital count |
| `serif_account_score`, `serif_open_leads`, `serif_web_intent_points` | number | written by `npm run reverse-etl` from `v_account_scores` |
| `serif_ein`, `serif_registry_account_key`, `serif_rate_scope`, `serif_platform` | text | outbound target groups (section 7): the EIN, the registry account it links to, what the rate is for, the mapped platform |
| `serif_rate`, `serif_rate_pct_medicare`, `serif_card_tier_pct`, `serif_conversion_factor`, `serif_clinicians`, `serif_city_top_rate`, `serif_band_median_pct` | number | the finding |
| `serif_contract_form` (`card`, `factor`, `both`, `neither`), `serif_size_band` (`1-50`, `51-500`, `501+`), `serif_outbound_fit` (`target`, `not_target`) | enum | the finding and its fit |

## 6. Registry tables read (read-only, attached as `reg`)

`cms_hospitals`, `ahrq_systems`, `ahrq_hospital_links`, `payers`, `curated_orgs`, `org_domains`, `free_mail_domains`, `disposable_domains`, `meta`. `name_norm` follows `etl/name_norm.py`; `src/resolve/match.ts` implements the same rule, and a test compares the two on every name in the real registry.

## 7. Outbound: the rate file (`src/outbound/`, migration 004)

Input: Serif's public rate search export, `RATES_CSV` (default `data/rates/mrf_rate_search_export.csv`, git-ignored; `npm run rates:fetch` downloads it). Read with an RFC 4180 reader (`src/outbound/csv.ts`). The columns read are listed in `REQUIRED_COLUMNS` (`src/outbound/rateFile.ts`); a file missing one, with a value that is not an amount or a count, or mixing payers, networks, months or codes is refused whole and the tables are left empty. With no file the tables are empty too, and `GET /api/outbound` answers `{loaded: false, reason}`.

Loaded at startup when the file's SHA-256 differs from `rate_file.sha256`, or when `inputs_sha256` (the file, the platform mapping, the registry's meta table and `OUTBOUND_VERSION`) does. Every table below is rebuilt in one transaction. Demo reset (`clearAppData`) does not touch them.

| table or view | one row per | columns |
|---|---|---|
| `rate_file` | the loaded file (id 1) | `path`, `sha256`, `inputs_sha256`, `rows`, `payer`, `network`, `network_month` (YYYYMM), `code`, `loaded_at` |
| `rate_rows` | rate row, in file order (`id`) | `ein`, `entity`, `name_norm` (the router's `nameNorm`), `state` (from the street address, else the NPI region), `city` (the address part before the state), `taxonomy`, `npis` (FilteredNPIListLength), `src_npis` (PayerSourceNPIListLength), `org_npis` (AllPayerIndividualNPIs: the group's size), `rate`, `medicare` (Baseline), `pct_medicare` (RelativeToBaseline as a fraction), `most_npis` (IsMostNpisPerEinCode), `claims_evidence` (IsBillableClaims), `pos` |
| `v_rate_groups` | group (EIN) | its one rate row, plus `band`: `1-50`, `51-500` or `501+` clinicians by `org_npis` |
| `v_rate_groups_city_top` | city and state | `top_ein`, `top_rate`, `top_clinicians` (a tie on the rate goes to the larger group), `groups` |
| `rate_patterns` | pattern (`card`, `factor`) | `value` (the base or the unit), `hits` (distinct rates it explains), `distinct_rates`, `runners_up_json` (the next two, with their hits) |
| `rate_findings` | group | `ein`, `account_key` (`ein:<EIN>`), `name`, `name_norm`, `city` (title case), `state`, `clinicians`, `band`, `rate`, `medicare`, `pct_medicare` (whole percent), `form` (`card`, `factor`, `both`, `neither`), `card_tier`, `factor_multiple`, `city_top_rate`, `city_top_clinicians`, `city_top_ein`, `band_median_pct`, `fit` (`target`, `not_target`), `fit_reason`, `platform`, `platform_confirmed`, `draft_status` (`ready`, `blocked`, `none`), `draft_reason`, `hook` (`hospital_leverage`, `rate_range`) |
| `rate_links` | group | `status` (`linked`, `unlinked`), `account_id`, `account_name`, `method` (`company_name`), `score` (the best candidate's, linked or not), `reason` (a tie starts `tie:`), `candidates_json` |

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

**API** (read-only). `GET /api/outbound`: `loaded`, `status` (`loaded`, `unchanged`, `missing`, `failed`), `reason`, `file`, `patterns` (each with its search rule), `summary` (per band: groups, median percent of Medicare, card, factor, both, neither, where card and factor count a group on both in both; totals per form; fit and draft counts) and `groups`. `GET /api/outbound/<ein>`: `finding`, `sourceRows` (each rate row, `chosen` marking the one rate), `link`, `draft` (a draft for a target, a labelled preview for any other group: `kind`, `status`, `label`, `reason`, `hook`, `hookNote`, `subject`, `body`, `linkedin`, `parts` (the same three texts as runs, `{subject, body, linkedin}`, each an array of `{text, placeholder?, open?}`: a run with a `placeholder` is a value code inserted, one with `open` is a placeholder left for a person; the runs join back to the text, and the cockpit marks inserted figures from them), `inserted` (each `{placeholder, value, field}`), `placeholders` (`{first_name}`)), `draftUnavailable`, `rateLine` and `hubspot` (`{mode: 'dry_run', requests, skipped}`: the company upsert for a target, nothing for any other group). 404 for an unknown EIN, with the reason when no file is loaded.

