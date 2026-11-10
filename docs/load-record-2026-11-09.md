# Load record, Nov 9: leads in bulk and an uploaded list

What changed is in `docs/DECISIONS.md` #23 (commit lanes) and #24 (uploaded lists). This file holds the commands and the numbers measured on Nov 9, 2026, on this Mac, with Ollama running `llama3.2:3b` locally. Every run was offline (`OFFLINE=1`: no homepage-title or NPPES lookups), HubSpot dry-run, on the real registry and the August 2026 rate file, each on a server of its own with its own database and folder under `out/load/`.

The code before the change (commit `103487d`) was measured the same way, from a copy made with `git archive 103487d` under `out/load/`, served on its own port, and removed afterwards. Both sides got the same list (same generator, same seed, same clock), so before and after compare like with like.

## Commands

A server per run (ports 3483 to 3488, one each, so a closing server never takes the next run's requests):

```
env PORT=<port> APP_DB=out/load/<run>/app.sqlite OUT_DIR=out/load/<run> LLM_PROVIDER=ollama OFFLINE=1 HUBSPOT_LIVE=0 \
  CALENDLY_SIGNING_KEY=local-demo-signing-key-not-a-secret RATES_CSV=data/rates/mrf_rate_search_export.csv node --import tsx server.ts
```

The list is `generateList` from `scripts/lib/list-upload.ts` (what `npm run list:upload -- --count 150 --list HLTH --seed 20261110` posts): 150 scans, 115 at registry organizations, 18 at fictional unknown companies, 7 on free mail, 4 at fictional customers and 6 second scans of a badge already in the list, shuffled, with scan times counted back from 2026-11-10 18:00 UTC. A small driver posted it to the `event_scan` door one scan after another with no gap, waited for the queue, the digests and the second opinions, and read every figure from the server's database and `out/load/<run>/slack/`. For run 2 it also posted fixture F01 (a signed tier-A demo request) with a new invitee id two seconds after the first scan. For run 3 it posted the fifteen events of `fixtures/day/morning.json` one after another with no gap. Run 4 is the replay script:

```
env CALENDLY_SIGNING_KEY=local-demo-signing-key-not-a-secret HUBSPOT_LIVE=0 OFFLINE=1 LLM_PROVIDER=ollama \
  APP_DB=out/load/<run>/app.sqlite OUT_DIR=out/load/<run> npx tsx scripts/replay.ts --pace 2000   # and --burst
```

## 1. The 150-scan upload

| | before (`103487d`) | after |
|---|---|---|
| all 150 accepted (202) | 0.4 s | 1.1 s |
| queue empty (first 202 to the last lead done) | 145.8 s | 1.1 s |
| time to route p50 / p90 / slowest | 80.0 s / 132.2 s / 145.4 s | 1 ms / 20 ms / 39 ms |
| model calls before the route | 64, one at a time | 0 |
| Slack payloads recorded for the list | 74 (42 to `#leads-hsp`, 16 to `#revops-review`, 10 to `#leads-pls`, 5 to `#leads-bw`, 1 to a rep) | 6 (one digest each to `#leads-hsp`, `#leads-bw`, `#leads-pls`, `#leads-api` and `#revops-review`, and the one rep alert) |
| digests recorded after the first 202 | none | 6.3 s (the 5 s quiet period after the last scan) |
| repeats attached to their first scan | 2 of 6 | 5 of 6 |
| second opinions after the alert | 41, the last 241 s after the first post | 105, the last 248 s after the first post |

Routing: before, 53 team queue, 74 nurture, 16 review, 4 owner tasks, 1 rep alert, 2 attached; after, 51, 73, 16, 4, 1 and 5. The three extra attachments are repeat scans that arrived carrying the earlier time; before, each was routed again as a second team-queue item for the same person. The sixth pair's first scan went to nurture, which owns no later touch (decision 6): before, both scans went to nurture; now the second counts the first as a prior touch whatever its time, and its repeat-engagement points took it to a team queue. Posting took longer after the change (1.1 s against 0.4 s), most likely because each lead's whole run now follows its 202 on the same event loop, where before the posts ran while the queue waited on the model.

The second opinions are the model's same call, off the path: 105 ran (every scan with a note), one at a time, in the lulls. With the model before the route, the 64 calls before routing were the queue.

## 2. A demo request during the upload

| | before | after |
|---|---|---|
| F01 posted after the first scan | 2.0 s | 2.0 s |
| its time to alert | 151.2 s (151.2 s of it queued behind the list) | 5 ms |
| its route | tier A, rep alert | tier A, rep alert |

Before, it waited for every scan accepted ahead of it, each of whose model calls ran in turn. After, the list leads were done before it arrived; had they not been, a lead in another lane passes any waiting one after the 250 ms grace.

## 3. The morning's fifteen events, posted together

| | before | after |
|---|---|---|
| sales-routed leads alerted | 10 | 10 |
| time to alert p50 | 7,043 ms | 227 ms |
| slowest | 9,475 ms (D15, 9,473 ms of it queued) | 7,292 ms (D06, the lead's own model call and its wait for the model slot) |
| alerted after more than 1 s | 7 (D06, D07, D08, D12, D13, D14, D15) | 1 (D06) |

Two of the fifteen wait for the model before their route (D06, a customer's waitlist note, and D10, a free-mail note; both have no clear keyword use case). Before, every lead accepted after D06 waited for it, and those after D10 for D10 as well. After, the eight of them other than D10 committed 225 to 249 ms after their 202 (`timings.passed` = 1 on all eight): the 250 ms grace for the waiting head, then they pass. D06's own alert took longer than before (7.3 s against 7.0 s) because its call shared the one model slot with D10's; that wait is its own. D10 goes to RevOps review either way.

## 4. The 40-event replay

Against `docs/speed-record-2026-11-09.md` (gated, the same 22 sales-routed leads):

| run | speed record (Nov 9) | after |
|---|---|---|
| paced, 2 s between posts: p50 / p90 | 9 / 50 ms | 10 / 48 ms |
| paced: slowest own alert | 2,947 ms (F12) | 3,485 ms (F12) |
| burst, no gap: p50 / p90 | 4,244 / 4,297 ms | 204 / 253 ms |
| burst: slowest own alert | 4,298 ms (F17) | 4,835 ms (F12) |
| burst: queue wait p50 / p90 | 4,244 / 4,296 ms | 205 / 252 ms |

The replay script now also prints F13, the day's event scan in a team queue, as the slowest (5.0 s in both runs): its alert is the list digest, recorded when its list had been quiet for 5 s. Leaving it aside, the slowest own alert in each run is F12, the one lead that waits for the model. In the burst, 26 leads passed F12 after its grace; in the paced run, 1. F12's call took 4.8 s in the burst, against 4.3 s in the speed record, because it was the first real call after the warm-up.

The routing decision of every lead (tier, score, action, team, owner, rule, SLA due time, duplicate link and alert channel) is identical in the paced and the burst run, and identical to `npm run replay:ci` (rules only, strict order). Second opinions: 27 in each run, all agreeing with the route.

## Eval

`OUT_DIR=out/load/eval OFFLINE=1 HUBSPOT_LIVE=0 npx tsx scripts/eval.ts --gate`, with the model: gate PASS, every floor where it was. No file under `src/qualify`, `schema.ts` or `time.ts` changed, so the classifier hash is the Nov 9 record's and no new record was written. The Fast path section, which now counts the list door rule, reads as in the speed record: dev 39 items, 1 waited for the model, 27 after the alert; held-out 24, 7 and 17; sealed 24, 8 and 16; none routed differently. `npm run eval:gate:rules` is unchanged.

## What improved, what did not

- A list no longer queues on the model, and the queue behind a list is gone: 146 s to 1.1 s to route 150 scans, and a demo request during the upload is alerted in milliseconds.
- A list posts one message per team and one to RevOps instead of one per row (74 to 6), and each row keeps its own route, SLA, review item and CRM task.
- Repeat scans attach whatever order their times are in (2 of 6 to 5 of 6). The sixth is a first scan that went to nurture, which decision 6 leaves unattached on purpose.
- A lead waiting for the model or a slow lookup holds its own lane only. Leads behind it in other lanes wait the grace period (250 ms) and then pass, so a burst costs about 250 ms instead of a model call per waiting lead.
- Not improved: the lead that waits for the model still waits for it, and with one model slot two such leads still wait for each other (D06 and D10). The second opinions of a list take minutes (105 calls, one at a time), and a lead that needs the model can wait for up to one call that has started in a lull. A team-queue row of a list is now alerted a few seconds after its list settles, not when it is routed.
