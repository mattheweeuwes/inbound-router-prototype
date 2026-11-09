# Decisions

One short entry each. Where the code departs from a plain reading of the original brief, the entry says so.

## 1. Key accounts on stable public IDs, never names

Accounts are `ahrq:<health_sys_id>`, `ccn:<ccn>`, `payer:<slug>`, `npi:<npi>`, or `domain:<domain>` as a last resort. A hospital that belongs to an AHRQ system resolves to the system and keeps its CCN in `ids_json`. Names are only used to find a candidate, never as the key, so a rename or a typo does not split an account. When the name matches several accounts equally, the lead goes to a person with the top five candidates (rule R6) instead of being guessed.

## 2. Resolve before you score

Fit points depend on who the organization is, so scoring an unplaced lead produces a confident number about nothing. Resolution runs first, in a fixed order that stops at the first confident answer: curated domain, known organization domain, company-name match, homepage title, NPPES, TLD heuristic. The known-domain step runs before the TLD step on purpose, so `jhmi.edu` is Johns Hopkins Health System and not "academic". Every step is written to `resolution.evidence`. A lead that cannot be placed gets a human, not a silent guess. The one inference is a benefits or HR contact at an unknown company, who is resolved as a probable self-funded employer, labeled low confidence and routed by tier (decision 12). An account already in the CRM mirror that the public registries do not know keeps the CRM record's identity, segment and size (method `crm`); a registry match is never overridden.

## 3. The model classifies; code writes facts

The model returns an enum record (use case, urgency, buying role, disqualifier, confidence) with its reasons first. It never writes text a prospect sees. The model cannot set urgency, override a rule, write alert text or get a lead dropped on its word alone. Its use-case label can change the team for API-type leads (`teamFor` in `src/route.ts`). The rep brief in Slack and the CRM task is extractive: the prospect's own words in quotes, plus facts inserted by code from the registry (hospital count, beds, match method). Nothing in an alert is generated.

## 4. Disqualify on rules; a model alone cannot drop a lead

A rule hit (disposable domain, student title, job-seeker language, spam wording, and so on) disqualifies. When only the model says a lead is a non-buyer, spam and vendor pitch always go to a person: those two are dropped without anyone reading them, so a model-only call at any confidence, 0.8 or higher included, clears the disqualifier and sends the lead to review (R6) with reason `llm_only_disqualifier`. For the other disqualifiers (job seeker, student, media) the model alone counts at confidence 0.8 or above, recorded as the model's call; below that the same review path applies. The model never decides "competitor"; that comes from the curated domain list. A buyer is never dropped on the model's word alone.

## 5. Account owner beats round-robin

When the resolved account is in the CRM mirror (customer, open opportunity, partner), the owner gets the lead whatever the tier (R5). The tier still sets the SLA. This is what keeps two reps from working one account. Round-robin (least recently assigned, skipping anyone at capacity) only applies to accounts nobody owns. An account becomes owned the first time a tier-A rep alert under the round-robin rule names a rep: that rep is written to `accounts.owner` in the same transaction as the assignment (standing in for HubSpot's company owner being set by the company upsert, whose body then carries `hubspot_owner_id`), and the next lead from that account goes to the same rep under R5. A seeded CRM-mirror owner always wins over a claim. Team-queue, nurture, review and web-intent routes claim nothing, and resetting the demo clears claims with the rest of the database.

## 6. Idempotent webhooks

`(source, source_event_id)` is unique; a re-delivery answers 200 `duplicate: true` and does nothing else. The id comes from the payload's own timestamp, or from a SHA-256 of the canonical JSON body when there is none; server time never enters it. The event and its lead are inserted in one transaction. Separately, the same normalized email within 30 days attaches as a new touch (`duplicate_of`, same owner, repeat-engagement points), but only to an earlier lead that went to sales (a rep alert, owner task, team queue or review). A guide download that went to nurture counts as a prior touch for scoring and does not swallow the demo request that follows it: that request is routed normally, with its own rep and CRM task. Re-running a lead replaces its derived rows and the CRM writes upsert, but a re-run (boot recovery) can repeat an alert. A repeat touch does not alert inside 24 hours of the last alert; after that, only a tier-A touch alerts again. The first rule protects against the sender, the second against the prospect.

## 7. 202 and asynchronous processing

The inbound handler verifies, records and answers 202; the pipeline runs after, in this order: normalize, resolve, qualify, score, route, alert, then the HubSpot write. Here that is an in-process queue with one lead at a time, and unfinished leads are picked up again at boot. In production it should be a durable queue (Vercel Queues, Inngest or SQS) with a dead-letter queue and parallel workers. `time_to_route_ms` is measured from receipt (the 202) to the routing decision, because that is what the prospect experiences. The part of it spent waiting for this single worker is also reported as `timings.queued`, so a burst shows up as queue time rather than as a slow pipeline. The demo replay defaults to 2000 ms between posts, roughly one model call, so the queue stays short.

## 8. Dry-run CRM writes, company upsert on a unique property

HubSpot and Slack payloads are built exactly and stored on the lead and in `out/`, and by default nothing is sent. The Slack alert is built and recorded before the HubSpot write, so a slow or failing CRM never delays the rep: nothing in the alert comes from the CRM stage. A HubSpot call that throws (a network error or the 10 s timeout) is retried once; if it still fails, the plan is stored as `retryPending` and sent again at the next boot. Live HubSpot needs a service key and `HUBSPOT_LIVE=1`; it has run that way against a developer test portal. Companies are upserted on `serif_account_key`, a unique-value custom property holding the stable account key, so a company is the same company whether it arrived as `intermountainhealthcare.org`, a Gmail address with a company name, or an event badge. Keying on domain or name would create duplicates. Two endpoint shapes were missing from the documentation; the test-portal run confirmed both (see `DATA-CONTRACT.md`).

## 9. A model slot, rules first, with an honest eval

This demo fills the model slot with `llama3.2:3b` on Ollama at temperature 0, constrained to a JSON schema. Rules run on every lead. The provider sits behind one interface, so a hosted model can replace it and be run against the same eval sets (`npm run eval`). At Serif the slot is filled by evidence, not preference: candidates such as a larger open-weights model (Qwen or GLM class) on Serif's hardware, or a hosted model under Serif's data terms (the Anthropic provider in `src/qualify/llm.ts`, off unless keyed), run against a labelled set of Serif's own past leads, and one replaces the baseline only by beating it at the same floors. Use case, the weakest field on the sealed set, is where a stronger model would earn its cost first. The rules guard, and a person on an unsure "no", stay whatever fills the slot. The model is only called for leads that include something a person wrote; guide, badge and usage-only leads go to rules alone.

Combine policy v4 (`COMBINE_VERSION`, in `src/qualify/combine.ts`) is what the pipeline runs. v1, v2 and v3 stay callable for the comparison.

- v1: a confident model overrides the rules on use case, urgency and role.
- v2: rules first, the model fills gaps; urgency from a short list of keyword cues.
- v3: v2, with urgency decided by a temporal-expression parser (`src/qualify/when.ts`); the model is asked when the parser finds nothing.
- v4: v3, but the model never decides urgency.

v4 per field:
- Urgency: the parser reads the message, resolves every date expression to a concrete date relative to when the lead was received (America/New_York), and takes the earliest future one. "ASAP" or an equivalent is now; a horizon of 92 days or less is now, up to 183 days is this quarter, beyond that is exploring. Budget or planning language with no nearer date is this quarter. Exploring or no-rush language counts only when no date is present; an explicit date always beats it. "No rush" and "not urgent" can never read as urgent, and "reply now" style imperatives are not deadlines. If the message has no timing language, urgency is `unknown`. The one exception is a lead with no free text at all, which keeps the door default (exploring for product doors). The cue, the resolved date and the day count are stored in `qualification.rules.evidence` (`urgencyCue`, `urgencyDate`, `urgencyDays`, `urgencyKind`), and the Slack "why now" line quotes them (for example `("mid-January", 2027-01-15, 70 days out)`). Nothing in that line comes from the model.
- Use case: a clear keyword winner stands (2 or more points and half a point ahead, or 1 point and a full point ahead); otherwise the model if valid and confident; else the rules' answer.
- Buying role: from the title when it carries a seniority, else the model.
- Disqualifier: a rule hit disqualifies. For spam and vendor pitch, a model-only call goes to a person at any confidence. For the other disqualifiers the model alone counts at 0.8 or above, and below that the lead goes to review.

Why the model does not decide urgency: the small demo model got dates wrong (it called "January" six months out), and when a message gives no timing it tends to volunteer one anyway (`exploring` or `this_quarter`), where the honest answer is that the prospect gave none. A timeline the prospect never stated adds points to the intent score without evidence, so a lead can reach a rep alert on a guess. In v3 that showed: with the model consulted for the silent messages, held-out urgency was 17/24, and 22/24 without it. This was a product decision made before any sealed data existed, not a result of tuning. A larger model would make fewer of these errors, and the parser would still decide: date math and the urgency cut-offs are rules, and code applies them the same way every time, at no cost.

Every field records which side decided it (`qualification.final.sources`: `rules` for a keyword or parser decision, `model`, or `default` for the door default or unknown) and whether the model and the rules agreed (`agreement`).

Results, correct out of total, from `out/eval.md` (the Nov 9 run, `docs/eval-record-2026-11-09.md`; the only cell that moved since Nov 7 is sealed disqualifier, v1 to v4, 22/24 to 21/24). The `rules` column is the round-2 keyword classifier, unchanged. Dev is 39 leads that created a lead; the held-out set is 24 items.

| set | field | rules | model alone | v1 | v2 | v3 | v4 |
|---|---|---|---|---|---|---|---|
| dev | use case | 33/34 | 19/26 | 27/34 | 32/34 | 32/34 | 32/34 |
| dev | urgency | 33/34 | 16/26 | 23/34 | 28/34 | 23/34 | 24/34 |
| dev | disqualifier | 35/35 | 25/27 | 35/35 | 35/35 | 35/35 | 35/35 |
| held-out | use case | 18/24 | 20/24 | 20/24 | 20/24 | 20/24 | 20/24 |
| held-out | urgency | 11/24 | 13/24 | 13/24 | 10/24 | 17/24 | 22/24 |
| held-out | disqualifier | 23/24 | 20/24 | 23/24 | 23/24 | 23/24 | 23/24 |
| sealed | use case | 13/24 | 18/24 | 18/24 | 18/24 | 18/24 | 18/24 |
| sealed | urgency | 13/24 | 14/24 | 14/24 | 15/24 | 23/24 | 23/24 |
| sealed | disqualifier | 20/24 | 22/24 | 21/24 | 21/24 | 21/24 | 21/24 |

How to read them:
- Neither set is independent evidence about v4 urgency. The dev messages were written together with the rules, and the held-out set, which was blind when v2 was measured (urgency 10/24), was used in round 3 to build the parser. Its misses shaped the parser's rules, so 22/24 is a development number. The sealed set (24 items, `fixtures/heldout-sealed.json`, written before the date parser was built and kept outside the project until the classifier code was frozen, as its own note records; loaded by `npm run eval`) is the number to quote: v4 urgency 23/24. Its one urgency miss is S08 (gold exploring, no timing language, so v4 says unknown). The parser raised no label questions on it. The classifier code was changed after the eval first saw the sealed set, on Nov 9, so the sealed figures after that date describe edited code. What changed: `src/qualify/combine.ts` now sends a model-only spam or vendor-pitch call to a person at any confidence (before, 0.8 or above counted and the lead was dropped; decision 4), and `src/qualify/llm.ts` now reads the hosted provider's key and model from the config instead of the environment and treats a non-200 answer as unavailable. The hosted path is not exercised by the local eval, and because `llm.ts` no longer imports `config.ts`, that file left the hashed classifier set (9 files, hash `9e0bbeb9`, became 8 files, hash `ca9a4c28`). The sealed set file is byte-identical (same hash). Re-running both gates on Nov 9 showed: rules-only is unchanged, with all six floors at their measured results; with the model in the loop, every field is unchanged except sealed disqualifier, which fell from 22/24 to 21/24. The one new miss is S14, a vendor pitch that only the model flagged: it used to be counted as a drop and now goes to RevOps, so the lead is held, not lost, and the label scores as a miss. All six floors pass. Sealed disqualifier now sits exactly on its floor (21/24), so one more regression there fails the gate. No floor was changed. The Nov 7 record and manifest are kept as history.
- On dev, rules alone (97%) beat v4 (71%) on urgency, because the rules were written against those messages and the parser follows fixed conventions that some gold labels do not. The remaining v4 dev misses are mostly label questions or messages that give no timing, where several golds say `exploring` or `this_quarter` and v4 says `unknown`.
- Label questions are items where the parser applied the written definition and the gold label disagrees. They are reported in `out/eval.md` and `out/eval.json` (`labelQuestions`), and no gold label was edited. Dev: F05 and F19 ("2027" resolves to July 1, 2027, 238 days out, so exploring; gold this_quarter), F15 and F28 ("next quarter" is January 1, 56 to 57 days out, so now; gold this_quarter). Held-out: H04 ("7/1" is July 1, 2027, 237 days out, so exploring; gold this_quarter) and H17 ("auto-renews in March" is March 1, 115 days out, so this_quarter; gold now).
- Dates are resolved to the earliest date the message names, so a message that names a far renewal and a near meeting reads as the near one.
- The effect on routing: ten fixture leads changed from round 3 to round 4, all because a model-guessed urgency became `unknown`. F12 and F25 dropped from tier A (rep alert) to tier B (team queue); F35 stays tier A at exactly 70.

## 10. What changes with Serif's real stack

- HubSpot forms and workflows replace the fixture forms; the same payload adapter sits behind a form webhook.
- Calendly webhook signing is implemented against the documented header format; the signing key comes from the Calendly subscription.
- The Clay web-intent webhook replaces the `web_intent` fixture. It is account-level, so it feeds account intent and a research task, never a rep alert.
- PostHog events, or warehouse rows, feed product-qualified-lead scoring in place of the three usage rules.
- Databricks plus Hightouch (or similar) reverse ETL of account scores: `npm run reverse-etl` builds the company batch upsert from the `v_account_scores` view, which is the shape a warehouse model would hand to the sync.
- Closed-won and closed-lost outcomes should feed back into the weights in `src/score.ts`. Today they are hand-set.

## 11. Provider groups with no single NPI

NPPES is searched for an unplaced lead with a provider-looking company. One organizational NPI-2 match becomes `npi:<npi>`. A brand that spans several NPI-2 records (for example a practice platform with one record per state) has no single NPI, so it is keyed on `domain:<domain>` with the NPIs listed in `firmographics.npis`, and the evidence says so. NPPES matches registered other names as well as legal names.

## 12. Employer inference is labeled

An unplaced corporate domain with a benefits or HR title (or a network-and-benefits use case) is set to `employer_self_funded` with `confidence: low` and `inferred: true`. It scores as an unknown-size employer (no size points). It is not presented as a registry match.

## 13. Signed doors fail closed; the eval is a gate with a freeze record

A door that is meant to be signed (today only Calendly, listed in `SIGNED_DOORS` in `src/sources/index.ts`) refuses every request with 503 when its key is missing or blank. Skipping the check when no key is set would let an unsigned request create a lead, so an unconfigured door is closed, not open. The server logs one warning line at start naming each signed door without a key. Every default lives in code (`makeConfig()` in `src/config.ts`); `.env.example` is documentation only and is never loaded, because loading it once handed the door a key and the 503 path could never fire. `npm run dev` and `npm run replay` set the local demo key inline, and `npm run dev` also sets `DEMO_ROUTES=1`.

`npm run eval:gate` runs the normal evaluation and exits 1 if combine v4 is below the floors on the sealed set (urgency 22/24, use case 17/24, disqualifier 21/24) or the held-out set (21/24, 19/24, 22/24), each one regression below the Nov 7 results (on the Nov 9 re-run the sealed disqualifier result is exactly at its floor). If the local model cannot be reached it fails; it never passes by skipping. The floors are set in `scripts/lib/eval-gate.ts` and no classifier code or label is changed to meet them.

`out/eval-manifest.json` records the SHA-256 of the sealed set and of every classifier source file (everything under `src/qualify` plus the runtime imports of those files), one combined classifier hash, the model, temperature and prompt, the timestamp and the per-set results. The next run compares the classifier hash with the recorded one. This makes any later edit to the sealed set or the classifier detectable, as the Nov 9 run showed: the manifest flagged the classifier as changed against the Nov 7 record. The current record is `docs/eval-record-2026-11-09.md` with `docs/eval-manifest-2026-11-09.json`; the Nov 7 pair is history. It cannot show that the sealed set was written before the parser existed; that still rests on the set's own note and on file modification times, which the manifest records as supporting evidence only.

## 14. A local server stays local, and the one outbound fetch is checked

The server binds to 127.0.0.1 unless `HOST` says otherwise. The cockpit's write routes (`/api/demo/submit`, `/api/demo/replay`) answer 404 unless `DEMO_ROUTES=1`; the read endpoints are unauthenticated, which is acceptable only because of the bind address.

The only fetch aimed at a name a stranger supplied is the homepage title of an unknown email domain. The domain must be a plain DNS hostname (no port, path, query or IP literal), the name is resolved first and refused if any answer is a private, loopback, link-local, CGNAT, unique-local or otherwise reserved address (IPv4 and IPv6), and redirects must stay on https and DNS names, at most 3. A failed fetch is cached for an hour and the cache holds at most 5,000 domains. One gap remains: the name is resolved once to check it and again by `fetch`, so a DNS answer that changes in between (rebinding) is not caught. Closing it needs the connection pinned to the checked address, which the platform `fetch` does not allow without a custom dispatcher.
