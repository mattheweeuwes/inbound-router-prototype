# Data contract

What crosses each boundary: inbound payloads, the canonical lead, the CRM. Source of truth for types is `src/schema.ts`; for tables, the files in `sql/migrations/`, applied once each in name order and recorded in `schema_migrations` (DECISIONS #18).

## 1. Canonical lead

Every inbound payload is adapted to one `LeadEvent` (`src/sources/*`), normalized (`src/normalize.ts`), and stored on `leads`.

| group | fields |
|---|---|
| identity | `id` (uuid), `source`, `source_event_id`, `received_at` (ISO UTC, from the payload), `accepted_at` (ISO UTC, the server's clock at the 202; orders boot recovery), `synthetic`, `list_name` (on `lead_events`: the uploaded list the event came in on, from the payload's `list` or `event` name, for a door in `LIST_DOORS` (default `event_scan`); null for every other door; DECISIONS #24) |
| person | `email` (trimmed, lowercased; its domain must be a plain DNS hostname, so an address with a port, path, IP address or bare name like `localhost` is treated as having no email), `first_name`, `last_name` (title-cased), `title`, `title_function`, `title_seniority` |
| company as submitted | `company_name_raw`, `company_domain` (null for free-mail and disposable), `state` (2-letter), `country` |
| attribution | `utm_source/medium/campaign/content/term` (normalized), `channel`, `landing_page`, `referrer` |
| message | `message` (the prospect's own words, never rewritten) |
| dedupe | `contact_key` (sha256 of the email, 16 hex), `duplicate_of` (the first lead of the same contact that went to sales, accepted before this one and received within 30 days either side of it; acceptance order, not the source timestamps, decides which is first, because a list arrives out of time order) |
| resolution | `account_id`, `segment`, plus `resolution_json` (method, confidence, evidence, firmographics, candidates) |
| qualification | `qualification_json` (rules output with its evidence, including the date parser's `urgencyCue`, `urgencyDate`, `urgencyDays` and `urgencyKind`, model output, final with per-field `sources`, per-field agreement, fallback reason, prompt and combine versions). This is what the route used: for a lead alerted on the rules (decision 19) `llm` is null and the fallback reason starts `model_after_alert`; the model's answer is in `second_opinion_json` |
| second opinion | `second_opinion` (null when none is due; `pending`, `running` while a call is in flight, `done`), `second_opinion_json` (while due: `{shownSegment}`, the organization type the model is shown; once done: `at`, `provider`, `latencyMs`, `llm` (what the model said, or null), `fallbackReason`, `answered`, `agreed`, `changed` (any of `useCase`, `buyingRole`, `disqualifier`, `reviewReason`: what the full combine would have decided differently from the route), `roleFilled`, `doubt` (`{disqualifier, confidence, heldForPerson}` or null), `followedUp`, `afterAlertMs` (the alert to the answer), `shownSegment`; or `{at, error}` if the worker itself failed) |
| decision | `tier`, `score`, `score_json` (itemized), `route_action`, `route_team`, `owner`, `sla_due_at`, `route_json` (rule and reason) |
| rate fact | `rate_fact_json` (null unless the organization has a rate group in the outbound module, section 7: `ein`, `name`, `line` (the sentence the brief, the Slack alert's "Their rates" field and the CRM task carried), `matchedBy` (`registry_link` or `name_and_state`), `accountId`, `groups` (how many groups matched; the line describes the largest)). Read after the route; nothing scores or routes on it |
| sync | `crm_json` (the exact HubSpot requests and, in live mode, how their delivery went; below), `alert_json` (`slack`: the Slack payload or null, `suppressed`, `failure`: the RevOps alert of a lead that was given up, `followUp`: the payloads a model doubt after the alert sent, to the alert's channel and `#revops-review`, and `digest`: for a list lead folded into its list's digest, `{list, team, channel, at, id}`, with `at` and `id` null until the digest is recorded; `slack` is null for such a lead). `digest_team` (the team whose digest the lead waits for) and `digest_id` (the `list_digests` row it went out in) mirror it as columns |
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
| `serif_features_30d`, `serif_last_feature`, `serif_last_feature_at` | text | product use (section 8), written by `npm run reverse-etl`: the features used in the 30 days up to the newest event (semicolon-separated keys, an empty string when none), the feature last used, and when |
| `serif_events_30d_<feature>` (six: `signal_search`, `signal_watch`, `api`, `mcp`, `network_benchmarking`, `quality_preview`) | number | product events for that feature in the same 30 days, zero when unused |

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

## 8. Product usage and deals (`src/usage/`, migration 005)

Ties what accounts do in the product to the deals sales works, so "I built this feature, did it help sell?" has an answer with its counts. PostHog is the source of events and HubSpot of deals; in this prototype the events arrive through `POST /api/usage` and both are also loaded from synthetic fixtures. Times are stored as UTC ISO text with milliseconds, the only form the adapter and the loader write, so a text comparison is a time comparison.

### Events

`POST /api/usage` takes PostHog's shape: a bare array, a capture body `{ batch: [...] }`, or one event. Each event: `event` (name), `distinct_id`, `timestamp` (ISO), `uuid`, and `properties` carrying the company group (`$groups.company`, else `$group_0`) and optionally `synthetic: true` (or `synthetic: true` on the batch). At most 1,000 events per request. Unsigned, like every door but Calendly.

| table | one row per | columns |
|---|---|---|
| `usage_events` | PostHog event uuid | `event_id` (primary key; with no uuid, a hash of the name, id and time, never the server's clock), `account_key` (null when the group named no account), `group_key` (as sent), `contact_key` (the router's contact key when `distinct_id` is an email, else null), `feature` (null when the name is not in the taxonomy), `event_name`, `occurred_at`, `received_at`, `synthetic`, `source` (`api` or `fixture`) |
| `features` | feature | `feature`, `label`, `launched_at`, `team`, `preview_of_add_on` (the add-on a preview feature previews). From `fixtures/usage/features.json`, replaced whole on load |
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

`GET /api/attribution` (read-only): `loaded`, `status`, `reason` (when not loaded), `asOf`, `model` (`kind`, `windowDays`, `definition`, `caveat`, `smallSample`, `note`), `synthetic` (`events`, `deals`, `allSynthetic`, `note`), `data` (`accounts`; `events` total, mapped, unmapped, unresolved; `deals` total, open, won, lost and influenced, each with count and amount; `unmappedByName`), `features` (per feature: `label`, `team`, `launchedAt`, `daysSinceLaunch`, `accountsUsing`, `events`, `adoption`, `opportunities`, `byOutcome`, `winRate` with `with`, `without` and `small`, `firstUseToOpportunity`, and `deals` with each influenced deal's account, stage, amount, dates and uses in the window) and `expansion` (`rule`, `minUses`, `windowDays`, `signals`).

### Reverse ETL

`npm run reverse-etl` writes each company's usage properties (section 5) beside its lead scores, for every account with product use, in the same dry-run batch. The expansion tasks are written to `out/hubspot/expansion-tasks-<date>.jsonl` as a dry run in every mode.


## 9. Uploaded lists (`src/lists.ts`, `src/listDigest.ts`, migration 006)

A door in `LIST_DOORS` (default `event_scan`; `none` for no list doors) carries a list someone uploads, and each event names its list (`list` or `event` in the payload, else `<door> (no list name)`).

- Routing: unchanged. A list lead whose route is `team_queue`, `owner_task`, `nurture` or `review` keeps its route, SLA, review item and CRM plan, posts no Slack payload of its own and is folded (`alert_json.digest`). A `rep_alert`, a repeat that re-alerts its rep, and a `competitor_flag` keep their own alert.
- The model: with `LIST_DOOR_MODEL` unset (`after_alert`), a list lead is routed on the rules and the model call follows as its second opinion, whatever the note says. `LIST_DOOR_MODEL=gated` puts list doors back under the gate of DECISIONS #19.
- Settled: none of the list's leads is unfinished (`status` other than `done` or `failed`) and none was accepted for `LIST_QUIET_MS` (default 5000 ms). Then one digest per team is recorded for the list's batch.
- A digest (`buildListDigest` in `src/notify/slack.ts`) carries the list's name, its rows in this upload and for the team, counts by tier and by action, the top 10 by score (name, title, organization, tier, score and the booth note cut to 120 characters), how many more, the list's repeats attached and rows at unknown organizations (unresolved, ambiguous, or an inferred employer), and the earliest SLA due among the team's rows. The RevOps digest (`buildReviewDigest`) lists up to 30 review rows by name, the company as typed and the reason. Channels: `#leads-<team>`, `#revops-review` for `Review`, `#marketing` for `Nurture`.
- Settings: `COMMIT_GRACE_MS` (default 250; `never` keeps strict acceptance order), `LIST_DOORS`, `LIST_DOOR_MODEL`, `LIST_QUIET_MS`.

`GET /api/dashboard` adds `lists`: one entry per list, newest first, with `name`, `rows`, `byTier`, `byAction`, `repeatsAttached`, `unknownOrgs`, `inFlight`, `folded`, `waitingForDigest`, `digests`, `firstAccepted` and `lastAccepted`; each `review` item carries `list`, and `GET /api/leads` summaries carry `list` and the flag `in_digest`. A folded lead counts as alerted (the funnel's Alerted step, the SLA counts, time to alert) once its digest is recorded. `GET /api/stream` sends a `list` event when a digest is recorded.

`npm run list:upload` (`scripts/list-upload.ts`, with the generator in `scripts/lib/list-upload.ts`) posts a seeded, synthetic badge-scan list: people invented, organizations from the registry in use, 12% at fictional unknown companies on `.example`, 5% on free mail, 3% at the fictional customers in `fixtures/crm-mirror.json`, 4% second scans of a badge already in the list, shuffled.
