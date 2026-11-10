# Inbound router

A work sample for Serif Health's GTM Engineer role, by Matthew Eeuwes. It is a prototype, not a Serif product. The cockpit follows the look of Serif's public site (its colors and the Sora typeface), and it carries no Serif logo.

Every inbound lead is resolved to a real healthcare entity on a stable ID, scored, routed and alerted within seconds, and anything uncertain goes to a person. It covers eight inbound doors (demo booking, gated guides, early-access waitlist, sample signup, marketplace listings, API/MCP keys, conference scans, web intent), resolves organizations from free public data (CMS, AHRQ, NPPES), and builds the exact HubSpot and Slack requests. Nothing is sent by default; with a HubSpot service key and `HUBSPOT_LIVE=1` it writes to HubSpot, and it has run that way against a developer test portal.

## Run it

Needs Node 22 (uses `node:sqlite`). Optional: Ollama with `llama3.2:3b` on `127.0.0.1:11434`; without it the rules classifier carries every lead.

```
npm install
npm test               # unit and pipeline tests, no network
npm run replay         # all 40 fixtures through the inbound handler; prints a table and time to alert, writes out/replay.json
                       # (-- --pace 2000 posts like the cockpit's Replay a day, -- --burst posts with no gap)
npm run eval           # rules vs model vs combined against fixtures/gold-labels.json; writes out/eval.md and out/eval.json
npm run eval:gate      # the same evaluation as a gate: exits 1 if v4 on the sealed or held-out set is below its floors, or the local model is unreachable
npm run ci             # what CI runs, in order, stopping at the first failure: typecheck, tests, CI replay, rules-only eval gate, browser test
npm run dev            # http://127.0.0.1:3480 (API under /api, cockpit from public/); sets a local demo signing key and DEMO_ROUTES=1 inline
npm run reverse-etl    # company batch upsert from the v_account_scores view (dry-run)
npm run etl            # rebuild data/registry.sqlite (Python 3.9 standard library only)
npm run gen-fixtures   # regenerate fixtures/submissions.json and gold-labels.json from the table in scripts/gen-fixtures.ts
```

Until `data/registry.sqlite` exists with `meta.status = 'complete'`, the app runs on the hand-made `test/fixtures/registry-mini.sql`. It switches to the real registry on its own. `npm run dev` prints which one it is using.

## How it works

```
 doors                       POST /api/inbound?source=...
 calendly_demo  ──┐          verify signature (Calendly) ─ adapt to LeadEvent ─ (source, event id) unique?
 guide_download   │                        │ duplicate: 200, stop            │ new: 202
 signal_ask       ├──────────────────────► │                                 ▼
 sample_signup    │                  lead_events + leads('received')   queue (resumed at boot)
 marketplace      │                                                         │
 api_key          │      ┌──────────────────────────────────────────────────┘
 event_scan       │      ▼  prepare: starts at once, 4 leads at a time   commit: one lead at a time, in the order accepted
 web_intent    ───┘   normalize ─► resolve ─► qualify ──────────────────► dedupe ─► score ─► route ─► notify ─► crm
                      UTM, email,  domain,    rules on every lead;         30 days,  fit 50 +  R1..R9   Slack Block  HubSpot
                      title        curated,   the model before the         account   intent 50 first    Kit payload; requests
                                   name, site route only when the          upsert    itemized  match    the rep is   (dry-run) or an
                                   title,     rules cannot settle the                points    wins     told first   outbox, retried
                                   NPPES, TLD use case (it can change                                       │
                                              the team); guard-railed                                       ▼
                      second opinion: every other free-text lead gets the same model call after the alert, one at a time
                      while no lead waits; a disqualifier only the model raised opens a review item and a follow-up to
                      the alert's channel and RevOps, and the lead stays routed
                      no match, a tie, or a non-buyer call only the model makes before the route (spam or vendor pitch at
                      any confidence, anything else under 0.8): held for RevOps (R6) before any rep is alerted; an account
                      that already has an owner goes to the owner (R5), doubt included. Exception: a benefits or HR contact
                      at an unknown company is resolved as a low-confidence inferred employer and routed by tier
                      every stage timed into stage_log; every decision stored on the lead with its evidence; a run that
                      throws is retried with backoff, then given up with a RevOps alert
 data/app.sqlite (WAL)  ◄── attaches ──►  data/registry.sqlite (read-only, built by etl/)
```

An account already in the CRM that the public registries do not know keeps the CRM record's identity, segment and size.

Files: `api/` Web-standard handlers (`Request` to `Response`, deployable as functions); `server.ts` the local server; `src/` the pipeline (`src/pipeline.ts` the queue and runner, `src/stages.ts` the prepare step and one function per ordered stage, `src/decisions.ts` the pure decisions, `src/modelPath.ts` when the model runs, `src/secondOpinion.ts` the model's answer after the alert, `src/limiter.ts` the bound on concurrent work, `src/store/` every statement the pipeline runs, `src/crm/outbox.ts` HubSpot delivery); `sql/` migrations and views; `fixtures/` the 40 synthetic submissions, gold labels, owners and CRM mirror; `etl/` the registry build; `docs/` decisions and data contract; `out/` generated output.

## Real and synthetic

| real | synthetic |
|---|---|
| Organizations, their domains and counts, except the three CRM accounts: CMS Hospital General Information, AHRQ Compendium of U.S. Health Systems, NPPES NPI-2 lookups, homepage titles | Every person, email address, job title and message. All fixtures carry `"synthetic": true` and the UI badges them. |
| Resolution, scoring, routing, SLA math, dedupe, idempotency, the HubSpot and Slack request bodies | Reps (`fixtures/owners.json`), HubSpot owner ids, the CRM mirror (`fixtures/crm-mirror.json`) |
| Calendly signature check, UTM and title normalization | Fake organizations use the reserved `.example` TLD. The three accounts in the CRM mirror are fictional, so no real organization appears as a Serif customer, prospect or partner |
| The local model call and its latency | Nothing is sent by default: no email code exists, Slack is dry-run, HubSpot is dry-run unless `HUBSPOT_LIVE=1` and a service key are set |

## Mapping to the posting

| posting | where |
|---|---|
| Speed up response to new leads | 202 on receipt, prepare concurrently and commit in order, the model off the path to the alert unless it can change the team (`src/modelPath.ts`, `src/secondOpinion.ts`), per-stage timings, `time_to_route_ms` and time to alert, SLA clocks in business hours (`src/time.ts`, `src/route.ts`) |
| AI-assisted tools that qualify and route inbound leads | `src/qualify/` (rules plus a guard-railed model slot, filled in this demo by a small local model, with an eval), `src/route.ts` |
| Own the schemas, tagging and hygiene from marketing to sales | `docs/DATA-CONTRACT.md`, UTM and channel taxonomy in `src/normalize.ts`, dedupe and idempotency in `src/pipeline.ts`, `/api/metrics` hygiene counts |
| Report on the funnel and speed to lead | the cockpit's Overview tab, modeled on HubSpot's Lead Pipeline Overview dashboard: leads by door, funnel, buyer type, disqualification reasons, where the time goes, rep load, HubSpot sync and data quality, all from `GET /api/dashboard` (`src/dashboard.ts`, read-only) |
| Custom webhooks and integrations when no-code runs out | `api/inbound.ts` and `src/sources/`, `src/crm/hubspot.ts` |
| HubSpot | request builders, property definitions in `docs/hubspot-properties.json`, reverse ETL in `scripts/reverse-etl.ts` |
| Document the decisions | `docs/DECISIONS.md` |

## Tests and CI

Every push and pull request runs `.github/workflows/ci.yml`, and `npm run ci` runs the same sequence locally. It stops at the first failure.

1. `npm run typecheck`: `tsc --noEmit` over the app, scripts, tests and the browser test.
2. `npm test`: the unit and pipeline tests (524, about two seconds, no network).
3. `npm run replay:ci`: all 40 fixtures through the real inbound handler, rules only, offline, HubSpot dry-run, in its own database and folder (`out/ci/`). It fails the build if the p90 time to route is over `TTR_P90_BUDGET_MS`, set in that script: 150 ms. On Nov 8 the p90 measured 17 ms on this Mac and 35 ms on the GitHub runner, so the budget is about four times the runner's figure: it fails when someone makes the pipeline slow, not when a runner is noisy. With `CI` set, the replay also refuses to start if HubSpot is live.
4. `npm run eval:gate:rules`: the v4 classifier with no model, scored on the sealed and held-out sets. The rules path is deterministic, so its floors (`RULES_FLOORS` in `scripts/lib/eval-gate.ts`) are the measured results with no slack: any drop is a real change in the rules or the date parser. Its output goes to `eval-rules.*` files, never over the model run's `out/eval.json`.
5. `npm run test:e2e`: one Playwright test. It starts the server on port 3497 with a throwaway database, opens the cockpit, sends a test lead through the form, opens it in the stream and checks the decision trail: the resolved organization, a routing decision, and a dry-run CRM sync, with no console errors or failed requests.

`APP_DB`, `OUT_DIR` and `OFFLINE=1` (lookups off) exist so these runs can be pointed away from `data/app.sqlite` and `out/`, which hold the demo.

CI does not gate the model-in-the-loop eval. It needs the local Ollama model, so it runs on this machine with `npm run eval:gate`. The record of its last run (Nov 9, after the classifier changed) is in `docs/eval-record-2026-11-09.md`, with the hashes in `docs/eval-manifest-2026-11-09.json`. The Nov 7 pair is kept beside it as history; it describes the classifier as it stood before the Nov 9 change. CI also never sends anything to HubSpot or Slack, and the workflow uses no secrets.

## Known limits

- The pipeline runs in one process. Each lead's order-independent work (normalize, resolve, the rules, a gated model call) starts when it is accepted, four at a time, but leads commit one at a time in the order they were accepted, so a lead that waits for the model holds the leads behind it: in a burst of the 40-event day, everything after the one lead that waited was alerted about 4.3 s after its 202 (`docs/speed-record-2026-11-09.md`). `time_to_route_ms` runs from the 202 to the routing decision, so a burst shows up in it; the wait for earlier leads is also reported as `timings.queued`. Per-account ordering would let unrelated leads pass; it is not built.
- The classifier is rules first, with the demo's 3B local model filling gaps on use case and buying role only. Only a lead whose use case the rules cannot settle waits for the model before routing; every other free-text lead is alerted on the rules and gets the same call afterwards, so a disqualifier only the model sees (a vendor pitch, say) reaches RevOps as a doubt a few seconds after the rep was alerted, not before (`docs/DECISIONS.md` #19; `MODEL_BEFORE_ROUTE=all` restores the old order). Second opinions run one at a time and only while no lead is waiting, so a steady stream with no lull delays them, and one that has started holds a lead that needs the model for up to one call. The model never decides urgency: urgency comes from a temporal-expression parser (`src/qualify/when.ts`) that resolves phrases to dates relative to the lead's received time, and a message with no timing language is `unknown`. The model cannot set urgency, override a rule, write alert text or get a lead dropped on its word alone, but its use-case label can change the team for API-type leads (`teamFor` in `src/route.ts`). Combine policy is v4; v1 to v3 stay callable. `npm run eval` scores rules, model, v1, v2, v3 and v4 on the dev fixtures, the held-out set and, if `fixtures/heldout-sealed.json` exists, a sealed set, and writes `out/eval.md`.
- A door that is meant to be signed fails closed. Calendly is the only one: with `CALENDLY_SIGNING_KEY` missing or blank, `POST /api/inbound?source=calendly_demo` answers 503 naming the setting and records nothing, and the server logs one warning line at start. `.env.example` is documentation only and is never loaded, so a missing key stays missing. `npm run dev` and `npm run replay` set a local demo key inline (`local-demo-signing-key-not-a-secret`, not a secret), which is what lets the cockpit's send-a-lead form and Replay a day (which sign server-side) work. The other doors are unsigned by design.
- Local only by default: the server binds to 127.0.0.1 (`HOST` overrides), and the cockpit's write routes under `/api/demo/` answer 404 unless `DEMO_ROUTES=1` (`npm run dev` sets it). The read endpoints (`/api/leads`, `/api/metrics`, `/api/dashboard`, `/api/stream`) have no authentication, so do not expose this server to a network.
- The homepage-title lookup fetches a domain taken from a stranger's email address, so it takes a plain DNS hostname only, refuses any name that resolves to a private, loopback, link-local, CGNAT or unique-local address, and follows at most 3 redirects, https only. It checks the name before the fetch and `fetch` resolves it again, so a DNS answer that changes in between is not caught; closing that needs the connection pinned to the checked address.
- The rep alert goes out before the HubSpot write. A live HubSpot plan goes to an outbox in the database and is delivered outside the one-at-a-time section, oldest first; a network error, a 429 or a 5xx is retried with backoff (honoring Retry-After) for about four minutes, then marked dead and shown on the dashboard. Delivery is strictly in order, so one plan waiting for its retry holds the plans behind it. A link from the alert to the HubSpot record would have to be a follow-up message, because the record may not exist when the alert goes out.
- A lead whose run throws is retried twice (after 5 s and 10 s), then given up: status `failed`, and RevOps gets an alert payload through the same Slack recorder. A re-run, by retry or by boot recovery, can send the rep alert a second time when the earlier run failed after it. Retries run on an in-process timer; a stopped process picks them up at the next boot.
- `npm run eval` also writes `out/eval-manifest.json` and a Provenance section at the top of `out/eval.md`: SHA-256 of the sealed set, of each classifier source file and of the whole classifier, the model and temperature, and the per-set results. `npm run eval:gate` compares the classifier hash with the previous recorded run and fails below the floors (sealed urgency 22/24, use case 17/24, disqualifier 21/24; held-out 21/24, 19/24, 22/24). The hashes make later edits detectable. They do not prove when the sealed set was written; file modification times are recorded as supporting evidence only.
- Treat the eval numbers with care. The dev fixtures were written alongside the rules. The held-out set was used to build the date parser, so it is a development set too (v4 urgency 22/24 there). The sealed set (24 items, written before the date parser was built and kept outside the project until the classifier code was frozen, as its own note records) scores 23/24 on v4 urgency, 18/24 on use case and 21/24 on disqualifier in the Nov 9 run (22/24 on Nov 7, before the classifier changed; see `docs/DECISIONS.md` #9). The classifier code was edited after the sealed set had been scored, so read the sealed numbers as a regression check.
- Because silent messages are `unknown`, their intent score has no urgency points. That is deliberate. Several gold labels on the dev fixtures expect `exploring` or `this_quarter` for such messages, so dev urgency accuracy is lower than the rules-only column.
- Dates resolve against fixed conventions (a bare month is the 1st, "mid" is the 15th, a bare year is July 1, "next quarter" is its first day). Some gold labels disagree with those conventions; they are listed as label questions in the eval and not edited.
- Resolution depends on the registry. A company that is in none of CMS, AHRQ, the curated list or NPPES, and whose domain is not mapped, ends as `unknown_org` and goes to review (or, with a benefits title, to a low-confidence inferred employer). The AHRQ file is the 2023 compendium; systems that merged since may be named by their old record.
- Homepage-title and NPPES lookups use the network on first sight of a domain and are cached under `data/cache/`. With the network off they degrade to unresolved and the reason is recorded.
- HubSpot live mode has run against a developer test portal, not a production one. On Nov 7 it loaded the 40-event day (39 leads). Running the day again counted 126 requests: 101 writes (company and contact upserts and the contact-to-company association) returned 200, and the 25 tasks were already open and were reused, not created. It created no new records. That run confirmed the two endpoint shapes the documentation did not show (see `docs/DATA-CONTRACT.md`). A production portal's existing schema, owners and rate limits are untested.
- Round-robin capacity is 6 alerts per rep per rolling 24 hours, a placeholder.
- Scoring weights are hand-set. Closed-won and closed-lost data would be needed to fit them.
- In the test suite and CI, the Slack and HubSpot paths run against stubbed network calls; nothing is sent.
