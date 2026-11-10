# Qualification eval

## Provenance

- Evaluated 2026-11-10T15:29:48.642Z. Hosted model `claude-sonnet-5-5` at effort low, no temperature (current hosted models take none), 60 s per call, prompt v1, combine v4.
- Sealed set: `fixtures/heldout-sealed.json`, 24 items, sha256 `19085e792f0562912cff67a6cd781ebe84cfcff469cb18a92136c78c392fa390`.
- Classifier: 8 source files (qualify/combine.ts, qualify/index.ts, qualify/llm.ts, qualify/prompt.ts, qualify/rules.ts, qualify/when.ts, schema.ts, time.ts); combined sha256 `dba1398bf8d6df95d59ca2a720f9b16815bcab0108502e8ada04e62e4895d003`. Per-file hashes are in `out/eval-manifest.json`.
- Against the previous recorded run: no earlier recorded run to compare the classifier with (this run becomes the record).
- Supporting evidence only (file modification times, which copying or touching changes): sealed set 2026-11-07T03:49:27.000Z; newest classifier file 2026-11-10T15:25:29.925Z (src/qualify/llm.ts).
- What this shows: from this record on, any edit to the sealed file or the classifier code is detectable by hash. It does not show when the sealed set was written relative to the classifier; that rests on the set's own note and the file times above.

## Gate (v4, floors allow one regression per field)

```
set       field         floor   actual  result
sealed    urgency       22/24   23/24   PASS
sealed    useCase       17/24   21/24   PASS
sealed    disqualifier  21/24   22/24   PASS
heldout   urgency       21/24   22/24   PASS
heldout   useCase       19/24   21/24   PASS
heldout   disqualifier  22/24   24/24   PASS
```

Model answered: held-out 24/24, sealed 24/24; model calls that failed on infrastructure (unreachable or timed out): held-out 0, sealed 0. Gate: **PASS**.

Generated 2026-11-10T15:29:48.642Z. Registry: **real**. Model: `claude-sonnet-5-5` at effort low, prompt v1. Pipeline combine policy: **v4**.

- **rules**: the keyword classifier, run on every lead.
- **model**: the hosted model alone, counted only where it answered (leads with free text).
- **v1**: a confident model overrides the rules.
- **v2**: rules first, the model fills gaps; urgency from keyword cues.
- **v3**: as v2, but the date parser (`src/qualify/when.ts`) decides urgency; the model is asked when the parser finds nothing.
- **v4**: the parser decides urgency and the model never does; no timing language means unknown. This is what the pipeline runs, and v4 urgency equals the old "parser only" counterfactual, which is no longer reported separately.

## dev (39 items)

_rules were written alongside these messages._

| field | rules | model | v1 | v2 | v3 | v4 |
|---|---|---|---|---|---|---|
| useCase | 33/34 (97%) | 23/26 (89%) | 31/34 (91%) | 32/34 (94%) | 32/34 (94%) | 32/34 (94%) |
| urgency | 33/34 (97%) | 21/26 (81%) | 28/34 (82%) | 31/34 (91%) | 24/34 (71%) | 24/34 (71%) |
| disqualifier | 35/35 (100%) | 27/27 (100%) | 35/35 (100%) | 35/35 (100%) | 35/35 (100%) | 35/35 (100%) |
| segment | | | | | | 35/37 (95%) |
| routeTeam | | | | | | 22/23 (96%) |
| routeAction | | | | | | 19/22 (86%) |
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
| useCase | 18/24 (75%) | 23/24 (96%) | 23/24 (96%) | 21/24 (88%) | 21/24 (88%) | 21/24 (88%) |
| urgency | 11/24 (46%) | 21/24 (88%) | 19/24 (79%) | 16/24 (67%) | 21/24 (88%) | 22/24 (92%) |
| disqualifier | 23/24 (96%) | 24/24 (100%) | 24/24 (100%) | 24/24 (100%) | 24/24 (100%) | 24/24 (100%) |

Label questions (the parser gave an answer from the written definition and the gold label disagrees; golds are not edited):

| id | gold | parser | cue | date | days | message |
|---|---|---|---|---|---|---|
| H04 | this_quarter | exploring | 7/1 | 2027-07-01 | 237 | A 3,000-life manufacturing client is going to market for a 7/1 effective date. They want to know if switching networks a |
| H17 | now | this_quarter | March | 2027-03-01 | 115 | Our orthopedic group's contract with one of the big payers auto-renews in March unless we give notice. Trying to decide  |

## sealed (24 items)

_sealed until the round-3 parser was frozen._

| field | rules | model | v1 | v2 | v3 | v4 |
|---|---|---|---|---|---|---|
| useCase | 13/24 (54%) | 24/24 (100%) | 24/24 (100%) | 21/24 (88%) | 21/24 (88%) | 21/24 (88%) |
| urgency | 13/24 (54%) | 19/24 (79%) | 19/24 (79%) | 18/24 (75%) | 23/24 (96%) | 23/24 (96%) |
| disqualifier | 20/24 (83%) | 24/24 (100%) | 22/24 (92%) | 22/24 (92%) | 22/24 (92%) | 22/24 (92%) |

Idempotent re-delivery (F27) creates no new lead: yes.

## Latency

- rules: p50 0.034 ms, p90 0.059 ms per lead
- model: 76 calls, p50 1375 ms, p90 1502 ms, slowest 2340 ms; 0 over the pipeline's 8 s default (this run allowed 60 s)
- hosted tokens: 146277 in, 8599 out over 76 answered calls

## Fast path (decisions 19 and 24)

Items the gated pipeline would route on different classifier inputs than the full combine above, because the model's answer that changes them would arrive after the alert. A lead whose use case the model can change waits for it, so use case differs only on a list door (decision 24), which never waits and is counted here. 

| set | items | waited for the model | model after the alert | routed differently | which |
|---|---|---|---|---|---|
| dev | 39 | 1 | 27 | 0 |  |
| heldout | 24 | 7 | 17 | 0 |  |
| sealed | 24 | 8 | 16 | 0 |  |

## Misses (v4 result; 29)

| set | id | field | expected | got | rules | model | reasons |
|---|---|---|---|---|---|---|---|
| dev | F05 | urgency | this_quarter | exploring | this_quarter | this_quarter | parser (deadline): "2027" -> 2027-07-01, 238 days |
| dev | F09 | routeAction | rep_alert | team_queue |  |  | Tier B (66) self-funded employer, so it goes to the Benefits & Workforce queue with a 60 business-minute response time. |
| dev | F12 | useCase | contract_negotiation | rate_benchmarking_market | contract_negotiation | rate_benchmarking_market | Says the team "spends days pulling rate comparisons by hand": a pain point about rate benchmarking, with no negotiation or date mentioned. |
| dev | F12 | urgency | exploring | unknown | exploring | unknown | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F15 | urgency | this_quarter | now | this_quarter | this_quarter | parser (deadline): "next quarter" -> 2027-01-01, 57 days |
| dev | F19 | useCase | contract_negotiation | rate_benchmarking_market | rate_benchmarking_market | rate_benchmarking_market | rules: rate_benchmarking_market +3 (benchmark*); rate_benchmarking_market +2 (rate comparison/variation); rate_benchmarking_market +2 (rates by market); urgency this_quarter: "2027" |
| dev | F19 | urgency | this_quarter | exploring | this_quarter | this_quarter | parser (deadline): "2027" -> 2027-07-01, 238 days |
| dev | F19 | segment | provider_group | unknown_org |  |  | domain: usap.com is not in the curated or known-organization lists / company_name: "US Anesthesia Partners": best score 0 is under 0.7 / none: no registry, name, site-title or NPPES match |
| dev | F19 | routeTeam | HSP | Review |  |  | "US Anesthesia Partners" could not be matched to any known organization, so RevOps looks at it before any rep is alerted. |
| dev | F21 | urgency | exploring | unknown | exploring | unknown | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F24 | urgency | unknown | exploring | exploring |  | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F25 | urgency | this_quarter | unknown | this_quarter | now | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F25 | routeAction | rep_alert | team_queue |  |  | Tier B (68) health system, so it goes to the Health Systems & Providers queue with a 60 business-minute response time. |
| dev | F28 | urgency | this_quarter | now | this_quarter | this_quarter | parser (deadline): "next quarter" -> 2027-01-01, 56 days |
| dev | F33 | urgency | this_quarter | unknown | this_quarter | exploring | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F35 | urgency | this_quarter | unknown | this_quarter | unknown | no timing language in the message, so unknown (or the door default when there is no free text) |
| dev | F39 | segment | provider_group | unknown_org |  |  | domain: rayusradiology.com is not in the curated or known-organization lists / company_name: "RAYUS Radiology": best score 0 is under 0.7 / none: no registry, name, site-title or NPPES match |
| dev | F39 | routeAction | nurture | review |  |  | "RAYUS Radiology" could not be matched to any known organization, so RevOps looks at it before any rep is alerted. |
| heldout | H04 | urgency | this_quarter | exploring | unknown | this_quarter | parser (deadline): "7/1" -> 2027-07-01, 237 days |
| heldout | H05 | useCase | network_design_benefits | contract_negotiation | contract_negotiation | network_design_benefits | rules: contract_negotiation +3 (contract cycle/renewal); contract_negotiation +2 (renewal); urgency now: "january" is 2 month(s) out |
| heldout | H16 | useCase | rate_benchmarking_market | contract_negotiation | contract_negotiation | rate_benchmarking_market | rules: contract_negotiation +3 (negotiation); urgency now: "december" is 1 month(s) out |
| heldout | H17 | urgency | now | this_quarter | this_quarter | this_quarter | parser (deadline): "March" -> 2027-03-01, 115 days |
| heldout | H18 | useCase | rate_benchmarking_market | other | other | other | rules: urgency exploring: "july" is 8 month(s) out |
| sealed | S08 | urgency | exploring | unknown | unknown | this_quarter | no timing language in the message, so unknown (or the door default when there is no free text) |
| sealed | S14 | disqualifier | vendor_pitch | none | none | vendor_pitch | Says "We build AI SDR agents and would love to show you how we can triple your outbound": a sales pitch, not a buyer. |
| sealed | S15 | useCase | other | vendor_pitch | vendor_pitch | other | rules: vendor-pitch language; urgency unknown: no timing language |
| sealed | S15 | disqualifier | spam | vendor_pitch | vendor_pitch | spam | rules: vendor-pitch language; urgency unknown: no timing language |
| sealed | S16 | useCase | other | contract_negotiation | contract_negotiation | other | rules: contract_negotiation +2 (contracting title at a provider); urgency exploring: "no timeline" |
| sealed | S17 | useCase | payer_competitive_intel | rate_benchmarking_market | rate_benchmarking_market | payer_competitive_intel | rules: rate_benchmarking_market +3 (benchmark*); urgency this_quarter: "may" is 6 month(s) out |

Not evaluated: the score tier (it comes out of the points table, not a label) and fields the dev gold table leaves blank. The model sees guide-only, badge-only and usage-only dev leads never; those are decided by rules alone.
