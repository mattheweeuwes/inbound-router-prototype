# Speed record, Nov 9: the model off the path to the alert

What changed is in `docs/DECISIONS.md` #19. This file holds the commands and the numbers measured on Nov 9, 2026, on this Mac, with Ollama running `llama3.2:3b` locally. Every run was offline (`OFFLINE=1`: no homepage-title or NPPES lookups), HubSpot dry-run, on the real registry, each into its own database and folder under `out/speed/`. Every run sent the same 40 events (39 leads and one idempotent re-delivery).

## Commands

The current code, old setting and new, paced as the cockpit's Replay a day paces it, then as a burst:

```
run() { name=$1; shift; env CALENDLY_SIGNING_KEY=local-demo-signing-key-not-a-secret HUBSPOT_LIVE=0 OFFLINE=1 LLM_PROVIDER=ollama \
  APP_DB=out/speed/$name/app.sqlite OUT_DIR=out/speed/$name "$@" > out/speed/$name.log 2>&1; }
run old-paced MODEL_BEFORE_ROUTE=all npx tsx scripts/replay.ts --pace 2000
run new-paced npx tsx scripts/replay.ts --pace 2000
run old-burst MODEL_BEFORE_ROUTE=all npx tsx scripts/replay.ts --burst
run new-burst npx tsx scripts/replay.ts --burst
```

The replay prints time to alert, queue wait, the leads that waited for the model and the second opinions, and writes them to `replay.json` (`modelPath`). The code before this change (commit `5b03e51`) was measured the same way, from a copy made with `git archive 5b03e51` under `out/baseline/` and a ten-line script calling `runReplay` with `paceMs: 2000` or `0`, since its replay script had no pacing option. Its figures were read from its database with the same definitions.

## Time to alert

On the 22 leads whose route sends an alert to a rep, an account owner or a team queue (`timings.alerted`, the 202 to the alert). The earlier figures quoted for this change (p50 6.8 s, p90 8.8 s, model p50 2.8 s, 23 sales-routed leads) came from an earlier run with lookups on and a slower model call; the "before" column here is the same code measured under today's conditions, so the three columns compare like with like.

| run | before this change (`5b03e51`) | this code, `MODEL_BEFORE_ROUTE=all` | this code, gated (default) |
|---|---|---|---|
| paced, 2 s between posts: p50 | 2,464 ms | 2,410 ms | 9 ms |
| paced: p90 | 3,506 ms | 3,693 ms | 50 ms |
| paced: slowest | 4,367 ms | 4,048 ms (F01) | 2,947 ms (F12, the one lead that waited for the model) |
| burst, no gap: p50 | 25,093 ms | 24,297 ms | 4,244 ms |
| burst: p90 | 58,501 ms | 56,437 ms | 4,297 ms |
| burst: slowest | 64,821 ms | 62,621 ms (F40) | 4,298 ms (F17) |

## Where the time went

| run | leads that waited for the model | model call p50 / p90 | queue wait p50 / p90 | waited for own prepare p50 / p90 |
|---|---|---|---|---|
| before, paced | 28 | 2,211 / 2,688 ms | 349 / 1,123 ms | not recorded |
| `all`, paced | 28 | 2,200 / 2,511 ms | 301 / 1,305 ms | 2,013 / 2,512 ms |
| gated, paced | 1 | 2,461 ms (one call) | 2 / 3 ms | 1 / 33 ms |
| before, burst | 28 | 2,202 / 2,572 ms | 32,235 / 56,265 ms | not recorded |
| `all`, burst | 28 | 2,191 / 2,472 ms | 31,204 / 54,253 ms | 2,068 / 2,459 ms |
| gated, burst | 1 | 4,285 ms (one call) | 4,244 / 4,296 ms | 0 / 1 ms |

The 28 model calls before the route cost 63.5 s of model time in the paced "before" run. With the gate, one lead waits for the model: F12 (Manager, Payer Contracting), whose message gives the rules no clear keyword winner, and whose use case the model changed from contract negotiation to rate benchmarking. That lead's alert takes one model call. In the burst it is the thirteenth event posted, and because leads commit in the order they were accepted, the 27 leads after it wait for it too: that is the 4.2 s p50. Its call took 4.3 s in the burst, against 2.5 s paced; it was the first real classification after the warm-up call.

A recheck of the gated paced run after a last refactor of the second-opinion worker (no change in behavior; `out/speed/check-new-paced/`) measured p50 10 ms, p90 34 ms and a slowest of 3,768 ms, again F12. This time its qualify step took 3,760 ms for a 2,681 ms model call: it waited about a second for a model slot held by a second opinion that had started in the lull before F12 arrived. That is the known cost of running second opinions in the lulls: a call that has started cannot be interrupted, so a lead that needs the model can wait for up to one call.

## Second opinions after the alert

| run | ran | answered | agreed with the route | would change a field | buying role filled | doubts raised | model call p50 / p90 | the alert to the answer, p50 / p90 |
|---|---|---|---|---|---|---|---|---|
| gated, paced | 27 | 27 | 27 | 0 | 0 | 0 | 2,171 / 2,562 ms | 2,402 / 3,632 ms |
| gated, burst | 27 | 27 | 27 | 0 | 0 | 0 | 2,184 / 2,474 ms | 31,400 / 54,395 ms |

In the burst the second opinions wait until no lead is waiting in the ordered section, then run one at a time, so the last ones answer about a minute after their alert. With the old setting no second opinion runs (0 in both runs).

In the old-setting runs the model was also the source of record for one buying role (a lead with no title). It said `unknown`, the same value the rules had, so the second opinion on that lead in the gated runs records no change.

## Routing decisions

The routing decision of every lead (tier, score, action, team, owner, rule, reason, SLA due time, duplicate link and alert channel) and the rep assignments are identical in all six runs: before this change, old setting and gated, paced and burst. No second opinion raised a doubt, so no lead had a doubt arrive after its alert; the list of leads whose route differs is empty.

## Eval

`OUT_DIR=out/speed/eval OFFLINE=1 HUBSPOT_LIVE=0 npm run eval:gate`, with the model: gate PASS, every classifier cell the same as the Nov 9 record (`docs/eval-record-2026-11-09.md`). The classifier's combined hash is the same as that record's, because no file under `src/qualify`, `schema.ts` or `time.ts` changed, so no new eval record was written. The eval's dev replay now runs with the model before every route, so it keeps scoring the classifier's full answer. The segment and route rows on dev read 35/37, 22/23 and 19/22 in this run, against 37/37, 23/23 and 20/22 in the record, because this run was offline and the record's was not.

The new Fast path section counts the items the gated pipeline would route on different classifier inputs (use case, disqualifier, review) than the full combine:

| set | items | the model before the route | the model after the alert | routed differently |
|---|---|---|---|---|
| dev | 39 | 1 | 27 | 0 |
| held-out | 24 | 7 | 17 | 0 |
| sealed | 24 | 8 | 16 | 0 |

S14, the sealed vendor pitch only the model flags, is among the items whose use case the rules cannot settle, so it still waits for the model and is held for RevOps before any rep hears.

The rules-only gate (`npm run eval:gate:rules`) is unchanged: all six floors at their measured results, and the Fast path rows are 0, since nothing waits for a model that is not there.
