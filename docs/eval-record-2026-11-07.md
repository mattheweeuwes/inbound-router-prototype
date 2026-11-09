# Qualification eval

## Provenance

- Evaluated 2026-11-07T16:36:58.154Z. Model `llama3.2:3b`, temperature 0 (a literal in `src/qualify/llm.ts`), prompt v1, combine v4.
- Sealed set: `fixtures/heldout-sealed.json`, 24 items, sha256 `19085e792f0562912cff67a6cd781ebe84cfcff469cb18a92136c78c392fa390`.
- Classifier: 9 source files (config.ts, qualify/combine.ts, qualify/index.ts, qualify/llm.ts, qualify/prompt.ts, qualify/rules.ts, qualify/when.ts, schema.ts, time.ts); combined sha256 `9e0bbeb9901c61268226f913c6dcc18b7f68494c9a7ce668e47fdc0e079e21a7`. Per-file hashes are in `out/eval-manifest.json`.
- Against the previous recorded run: no earlier recorded run to compare the classifier with (this run becomes the record).
- Supporting evidence only (file modification times, which copying or touching changes): sealed set 2026-11-07T03:49:27.574Z; newest classifier file 2026-11-07T03:45:20.411Z (src/qualify/combine.ts).
- What this shows: from this record on, any edit to the sealed file or the classifier code is detectable by hash. It does not show when the sealed set was written relative to the classifier; that rests on the set's own note and the file times above.

## Gate (v4, floors allow one regression per field)

```
set       field         floor   actual  result
sealed    urgency       22/24   23/24   PASS
sealed    useCase       17/24   18/24   PASS
sealed    disqualifier  21/24   22/24   PASS
heldout   urgency       21/24   22/24   PASS
heldout   useCase       19/24   20/24   PASS
heldout   disqualifier  22/24   23/24   PASS
```

Model answered: held-out 24/24, sealed 24/24; model calls that failed on infrastructure (unreachable or timed out): held-out 0, sealed 0. Gate: **PASS**.

Generated 2026-11-07T16:36:58.154Z. Registry: **real**. Model: `llama3.2:3b` at temperature 0, prompt v1. Pipeline combine policy: **v4**.

- **rules**: the keyword classifier, run on every lead.
- **model**: the local model alone, counted only where it answered (leads with free text).
- **v1**: a confident model overrides the rules.
- **v2**: rules first, the model fills gaps; urgency from keyword cues.
- **v3**: as v2, but the date parser (`src/qualify/when.ts`) decides urgency; the model is asked when the parser finds nothing.
- **v4**: the parser decides urgency and the model never does; no timing language means unknown. This is what the pipeline runs, and v4 urgency equals the old "parser only" counterfactual, which is no longer reported separately.

## dev (39 items)

_rules were written alongside these messages._

| field | rules | model | v1 | v2 | v3 | v4 |
|---|---|---|---|---|---|---|
| useCase | 33/34 (97%) | 19/26 (73%) | 27/34 (79%) | 32/34 (94%) | 32/34 (94%) | 32/34 (94%) |
| urgency | 33/34 (97%) | 16/26 (62%) | 23/34 (68%) | 28/34 (82%) | 23/34 (68%) | 24/34 (71%) |
| disqualifier | 35/35 (100%) | 25/27 (93%) | 35/35 (100%) | 35/35 (100%) | 35/35 (100%) | 35/35 (100%) |
| segment | | | | | | 37/37 (100%) |
| routeTeam | | | | | | 23/23 (100%) |
| routeAction | | | | | | 20/22 (91%) |
| routeOwner | | | | | | 4/4 (100%) |

Label questions (the parser gave an answer from the written definition and the gold label disagrees; golds are not edited):

| id | gold | parser | cue | date | days | message |
|---|---|---|---|---|---|---|
| F05 | this_quarter | exploring | 2027 | 2027-07-01 | 238 | We want to compare our professional fee schedules against competing plans in Detroit and Grand Rapids before a 2027 stra |
| F15 | this_quarter | now | next quarter | 2027-01-01 | 57 | We want rate data to power member-facing cost estimates in our navigation product. Roadmap planning is for next quarter. |
| F19 | this_quarter | exploring | 2027 | 2027-07-01 | 238 | Anesthesia rates vary across markets. We need payer-by-payer benchmarks for the 2027 contract cycle. |
| F28 | this_quarter | now | next quarter | 2027-01-01 | 56 | We use Signal today. I want the API for our data warehouse, scoped for next quarter. |

## heldout (24 items)

_written after the rules were frozen; used to develop the round-3 date parser._

| field | rules | model | v1 | v2 | v3 | v4 |
|---|---|---|---|---|---|---|
| useCase | 18/24 (75%) | 20/24 (83%) | 20/24 (83%) | 20/24 (83%) | 20/24 (83%) | 20/24 (83%) |
| urgency | 11/24 (46%) | 13/24 (54%) | 13/24 (54%) | 10/24 (42%) | 17/24 (71%) | 22/24 (92%) |
| disqualifier | 23/24 (96%) | 20/24 (83%) | 23/24 (96%) | 23/24 (96%) | 23/24 (96%) | 23/24 (96%) |

Label questions (the parser gave an answer from the written definition and the gold label disagrees; golds are not edited):

| id | gold | parser | cue | date | days | message |
|---|---|---|---|---|---|---|
| H04 | this_quarter | exploring | 7/1 | 2027-07-01 | 237 | A 3,000-life manufacturing client is going to market for a 7/1 effective date. They want to know if switching networks a |
| H17 | now | this_quarter | March | 2027-03-01 | 115 | Our orthopedic group's contract with one of the big payers auto-renews in March unless we give notice. Trying to decide  |

## sealed (24 items)

_sealed until the round-3 parser was frozen._

| field | rules | model | v1 | v2 | v3 | v4 |
|---|---|---|---|---|---|---|
| useCase | 13/24 (54%) | 18/24 (75%) | 18/24 (75%) | 18/24 (75%) | 18/24 (75%) | 18/24 (75%) |
| urgency | 13/24 (54%) | 14/24 (58%) | 14/24 (58%) | 15/24 (63%) | 23/24 (96%) | 23/24 (96%) |
| disqualifier | 20/24 (83%) | 22/24 (92%) | 22/24 (92%) | 22/24 (92%) | 22/24 (92%) | 22/24 (92%) |

Idempotent re-delivery (F27) creates no new lead: yes.

## Latency

- rules: p50 0.034 ms, p90 0.049 ms per lead
- model: 76 calls, p50 2273 ms, p90 2805 ms

## Misses (v4 result; 30)

| set | id | field | expected | got | rules | model | reasons |
|---|---|---|---|---|---|---|---|
| dev | F05 | urgency | this_quarter | exploring | this_quarter | this_quarter | parser (deadline): "2027" -> 2027-07-01, 238 days |
| dev | F09 | routeAction | rep_alert | team_queue |  |  | Tier B (66) self-funded employer, so it goes to the Benefits & Workforce queue with a 60 business-minute response time. |
| dev | F12 | useCase | contract_negotiation | rate_benchmarking_market | contract_negotiation | rate_benchmarking_market | Quotes "spends days pulling rate comparisons by hand" and wants to find a solution for this task: an evaluation of existing solutions. |
| dev | F12 | urgency | exploring | unknown | exploring | this_quarter | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F15 | urgency | this_quarter | now | this_quarter | this_quarter | parser (deadline): "next quarter" -> 2027-01-01, 57 days |
| dev | F19 | useCase | contract_negotiation | rate_benchmarking_market | rate_benchmarking_market | contract_negotiation | rules: rate_benchmarking_market +3 (benchmark*); rate_benchmarking_market +2 (rate comparison/variation); rate_benchmarking_market +2 (rates by market); urgency this_quarter: "2027" |
| dev | F19 | urgency | this_quarter | exploring | this_quarter | this_quarter | parser (deadline): "2027" -> 2027-07-01, 238 days |
| dev | F21 | urgency | exploring | unknown | exploring | exploring | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F24 | urgency | unknown | exploring | exploring |  | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F25 | urgency | this_quarter | unknown | this_quarter | now | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F25 | routeAction | rep_alert | team_queue |  |  | Tier B (68) health system, so it goes to the Health Systems & Providers queue with a 60 business-minute response time. |
| dev | F28 | urgency | this_quarter | now | this_quarter | this_quarter | parser (deadline): "next quarter" -> 2027-01-01, 56 days |
| dev | F33 | urgency | this_quarter | unknown | this_quarter | this_quarter | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F35 | urgency | this_quarter | unknown | this_quarter | this_quarter | no timing language in the message, so unknown (or the door default when there is no free text) |
| heldout | H04 | urgency | this_quarter | exploring | unknown | this_quarter | parser (deadline): "7/1" -> 2027-07-01, 237 days |
| heldout | H05 | useCase | network_design_benefits | contract_negotiation | contract_negotiation | network_design_benefits | rules: contract_negotiation +3 (contract cycle/renewal); contract_negotiation +2 (renewal); urgency now: "january" is 2 month(s) out |
| heldout | H13 | disqualifier | job_seeker | none | none | none | Quotes "Happy to chat" and mentions a job posting, but no clear buying intent. |
| heldout | H16 | useCase | rate_benchmarking_market | contract_negotiation | contract_negotiation | rate_benchmarking_market | rules: contract_negotiation +3 (negotiation); urgency now: "december" is 1 month(s) out |
| heldout | H17 | urgency | now | this_quarter | this_quarter | now | parser (deadline): "March" -> 2027-03-01, 115 days |
| heldout | H18 | useCase | rate_benchmarking_market | network_design_benefits | other | network_design_benefits | Quotes "ahead of next fiscal year's budget" and wants to explore options 6 months out: a planning cycle evaluation. |
| heldout | H24 | useCase | other | navigation_find_care | other | navigation_find_care | Quotes "my own surgery" and wants cost estimate for personal use: a navigation/find-care product. |
| sealed | S02 | useCase | payer_competitive_intel | network_design_benefits | other | network_design_benefits | Quotes "before we set 2027 fee schedules" and wants competitor rate information: a planning cycle. |
| sealed | S06 | useCase | rate_benchmarking_market | network_design_benefits | other | network_design_benefits | Quotes "considering entering two new markets" and wants rate information for future planning: a strategic evaluation. |
| sealed | S08 | urgency | exploring | unknown | unknown | this_quarter | no timing language in the message, so unknown (or the door default when there is no free text) |
| sealed | S10 | useCase | contract_negotiation | network_design_benefits | other | network_design_benefits | Quotes "payer strategy refresh" and mentions a specific timeline: an upcoming planning cycle. |
| sealed | S11 | disqualifier | media | none | none | none | Quotes "producing a segment" and wants data for a media project, no specific timeline given. |
| sealed | S15 | useCase | other | vendor_pitch | vendor_pitch | other | rules: vendor-pitch language; urgency unknown: no timing language |
| sealed | S15 | disqualifier | spam | vendor_pitch | vendor_pitch | spam | rules: vendor-pitch language; urgency unknown: no timing language |
| sealed | S16 | useCase | other | contract_negotiation | contract_negotiation | other | rules: contract_negotiation +2 (contracting title at a provider); urgency exploring: "no timeline" |
| sealed | S17 | useCase | payer_competitive_intel | rate_benchmarking_market | rate_benchmarking_market | rate_benchmarking_market | rules: rate_benchmarking_market +3 (benchmark*); urgency this_quarter: "may" is 6 month(s) out |

Not evaluated: the score tier (it comes out of the points table, not a label) and fields the dev gold table leaves blank. The model sees guide-only, badge-only and usage-only dev leads never; those are decided by rules alone.
