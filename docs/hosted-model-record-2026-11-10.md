# Hosted model record, Nov 10: Claude Sonnet 5.5 in the model slot

The model slot is "filled by evidence": a model takes it only by beating the baseline on the same labelled sets at the same floors. Until now the only model scored was the small local one. This file is the first hosted model put through the same test, and through the working day in `docs/day-in-the-life.md`.

When this record was first written the local model was still the default. Later the same day the hosted model became the default whenever a key is set, at low effort (`docs/DECISIONS.md` #41); the sections "Low effort, three runs" and "The working day on the default" are the evidence for that. With no key the local model fills the slot. At Serif the key would come with data terms first.

## What was run

- **Model.** `claude-sonnet-5-5` through the hosted API, called directly over HTTP so the repository keeps no runtime dependencies. Same prompt (v1), same labels, same combine policy (v4) as the local model.
- **Effort.** Extra high (`xhigh`), twice, to see whether it answers the same way both times. Low once, because low is the usual starting point for classification and extra high should have to earn its cost. Low was later run twice more, for three in all; the tables just below use the first low run, and "Low effort, three runs" has all three.
- **Sets.** The 40 fixtures, the 24 held-out messages and the 24 sealed messages. 76 model calls per run: the model is only called when the prospect wrote something.
- **Time limit.** The eval runs allowed 60 s a call, so a slow answer still counts as the model's answer; the record then says how many would have missed the pipeline's 8 s default. The day ran with the 8 s default.

```
run() { env LLM_PROVIDER=anthropic ANTHROPIC_MODEL=claude-sonnet-5-5 ANTHROPIC_EFFORT=$2 MODEL_TIMEOUT_MS=60000 \
  OFFLINE=1 HUBSPOT_LIVE=0 OUT_DIR=out/hosted/$1 npx tsx scripts/eval.ts --gate; }
run xhigh-1 xhigh; run xhigh-2 xhigh; run low-1 low
```

The key is read from `.env` (`ANTHROPIC_API_KEY`), which git ignores. The full output of each run is in `docs/eval-record-2026-11-10-sonnet-5-5-xhigh.md` and `docs/eval-record-2026-11-10-sonnet-5-5-low.md`, with their manifests beside them. The extra-high record is the first of the two runs.

The local model was run again the same day on the same code (`OUT_DIR=out/hosted/local-3b npm run eval:gate`), so every "local 3B" figure below is like for like: `docs/eval-record-2026-11-10-local.md`. Its results are the same as the Nov 9 record in every cell.

## The request current models accept

The hosted path that was in the code had never been run, and current models would have refused it: it sent a fixed temperature, which they no longer take, and forced a tool call, which Sonnet 5.5 refuses. The request is now:

- no temperature, no tools;
- a JSON output format with the classifier's schema, so the answer is always the fixed labels (the schema is sent without its length and range keywords, which the format does not take; the parser still enforces them);
- effort as the one setting for how much the model thinks (`ANTHROPIC_EFFORT`);
- room for thinking in the token limit, since thinking counts toward it.

A decline, an answer cut off at the token limit and an answer outside the schema are all treated as no answer, so the rules decide. A rate-limited or overloaded call is tried once more inside the time limit.

## Gate

All three runs pass at the floors set for the local model, which were the only floors at the time. Nothing was changed to make them pass. The hosted model now has floors of its own, set from the low-effort runs below.

```
set       field         floor   local 3B   Sonnet xhigh   Sonnet low
sealed    urgency       22/24   23/24      23/24          23/24
sealed    useCase       17/24   18/24      20/24          21/24
sealed    disqualifier  21/24   21/24      22/24          22/24
heldout   urgency       21/24   22/24      22/24          22/24
heldout   useCase       19/24   20/24      21/24          21/24
heldout   disqualifier  22/24   23/24      24/24          24/24
```

Both extra-high runs gave the same six numbers. The model answered every call in every run: no timeouts, no declines, no answers outside the schema.

## The model on its own

The gate scores the pipeline, where the rules go first. This is the model's own answer, out of 24.

| set | field | local 3B | Sonnet, extra high | Sonnet, low |
|---|---|---|---|---|
| held-out | use case | 20 | 22 | 23 |
| held-out | urgency | 13 | 21 | 21 |
| held-out | disqualifier | 20 | 24 | 24 |
| sealed | use case | 18 | 23 | 24 |
| sealed | urgency | 14 | 21 | 19 |
| sealed | disqualifier | 22 | 24 | 24 |

Sonnet is well ahead of the local model on every field. Extra high and low are within one or two items of each other, in both directions, which on sets of 24 is not a difference.

## Does it answer the same way twice?

Hosted models take no temperature setting, so I ran extra high twice over the same 76 messages.

- Use case and disqualifier, the two fields that can change a route: identical on 76 of 76.
- All four labels identical on 74 of 76. The two that moved were an urgency (the pipeline never takes urgency from the model) and a buying role (no points ride on it).
- Extra high against low: the labels differ on 11 of 76, eight of them urgency. The pipeline's decision differs on 2.

## Speed and cost

| run | median | 90th percentile | slowest | over the 8 s default | cost per call |
|---|---|---|---|---|---|
| local 3B, same day and code | 2.3 s | 2.6 s | 4.2 s | 0 of 76 | none |
| Sonnet, extra high, run 1 | 2.3 s | 3.8 s | 5.2 s | 0 of 76 | $0.0067 |
| Sonnet, extra high, run 2 | 2.4 s | 3.9 s | 6.4 s | 0 of 76 | $0.0067 |
| Sonnet, low | 1.4 s | 1.5 s | 2.3 s | 0 of 76 | $0.0050 |

Cost is from the token counts the API returned (146,277 in for each run; about 22,000 out at extra high and 8,600 at low) at $2 and $10 per million tokens. Nearly all of the input is the same fixed prompt on every call.

## The working day on the hosted model

The same day as `docs/day-in-the-life.md`: the 40 fixtures, the 15 morning events, the 150-badge list. Extra high, the 8 s default, four model calls at once.

- **Routing.** Of the 51 leads that can be compared with the local-model day (the list rows and the items a person decided are left out), all 51 have the same tier, score, action, team and owner. The use-case label differs on 2 and changes no route.
- **Time to alert.** A median of 8 to 14 ms and a 90th percentile of 37 to 40 ms on the paced day, as with the local model: the model is off the alert path either way.
- **The leads that wait for the model.** With the 15 morning events posted together, the two leads whose use case the rules cannot settle were alerted in about 2.5 s and 5 s. With the local model's single slot they took 4.9 s and 7.7 s, because the second waited for the first. On the hosted model the second waits too, for a slot that second opinions hold: see "The working day on the default".
- **Second opinions.** Every one on the base day agreed with the rules (27 of 27). On the list, 93 to 96 of 103 agreed; the rest would change a use case or fill a buying role, and none raised a doubt.
- **The list's second opinions.** The first hosted run took 296 s to answer the list's 103 second opinions, slower than the local model's 248 s, although four calls could run at once. The worker asked them one at a time: strands that found nothing due at the start never came back. It is now a pool that refills, and keeps one slot free for a lead whose route is waiting (decision 40). The same list then took 102 s.
- **Cost.** 142 calls for the whole day, $1.00. The hosted testing up to this point came to about $4.20.

## Low effort, three runs

Low was run twice more, so there are three runs on the same 76 messages (`docs/eval-record-2026-11-10-sonnet-5-5-low.md`, `-low-2.md` and `-low-3.md`). All three pass.

```
set       field         low 1    low 2    low 3    lowest   hosted floor
sealed    urgency       23/24    23/24    23/24    23       22/24
sealed    useCase       21/24    20/24    20/24    20       19/24
sealed    disqualifier  22/24    22/24    22/24    22       21/24
heldout   urgency       22/24    22/24    22/24    22       21/24
heldout   useCase       21/24    21/24    21/24    21       20/24
heldout   disqualifier  24/24    24/24    24/24    24       23/24
```

The hosted floors are one below the lowest of the three runs. Both extra-high runs clear them as well.

With the floors in place I ran the gate once more exactly as the README gives it, `npm run eval:gate` with nothing set but the key, so the default model, low effort and the 8 s limit are what ran: it passes at the hosted floors with sealed 23, 20 and 22 and held-out 22, 21 and 24, no call over 3.0 s (`docs/eval-record-2026-11-10-default.md`). The local model's recorded result does not (18 on sealed use case), which is the point of separate floors: the gate now fails if the model in the slot slips, not only if it falls to the level of the model it replaced.

From run to run, out of 76 messages:

| | low, three runs (each pair) | extra high, two runs |
|---|---|---|
| use case and disqualifier both the same | 74 or 75 | 76 |
| all four labels the same | 71 or 72 | 74 |
| the pipeline's final decision the same | 74 or 75 | 75 |

Across the three low runs, two messages got a different use-case label in one run (one in the fixtures, one in the sealed set). Disqualifier never moved, at either effort. So low is a little less steady on use case than extra high, on two and three runs of 76 messages, which is too few to call. It is the reason the floors rest on three runs and not one.

| low run | median | 90th percentile | slowest | over the 8 s default | cost per call |
|---|---|---|---|---|---|
| 1 | 1.4 s | 1.5 s | 2.3 s | 0 of 76 | $0.0050 |
| 2 | 2.1 s | 2.2 s | 2.4 s | 0 of 76 | $0.0050 |
| 3 | 1.4 s | 1.5 s | 2.1 s | 0 of 76 | $0.0050 |

## The working day on the default

The same day once more, with nothing set but the key. The server chose Claude Sonnet 5.5 at low effort and four calls at once by itself.

- **Routing.** All 51 comparable leads have the same tier, score, action, team, owner and rule as on the extra-high day, and the same use-case label. Against the local-model day, 50 of 50 route the same and the use-case label differs on 2.
- **Time to alert.** Over the whole day 33 leads went to sales with their own alert, at a median of 13 ms and a 90th percentile of 289 ms. Counted the same way, the local-model day and the extra-high day give 14 ms and 9 ms, and 288 ms and 289 ms. The 90th percentile is the 15 morning events posted together, which wait out the 250 ms commit grace.
- **The leads that wait for the model.** Three did. Two went on to sales and were alerted in 1.7 s and 2.1 s. The third, a practice manager nobody could place, reached the review queue in 4.2 s: its own call took 2.2 s, and before that it waited 2.0 s for a model slot. The same two morning leads took about 2.5 s and 5 s at extra high, and 4.9 s and 7.7 s on the local model.
- **Why the second one waits.** The 15 events arrive one after another within a third of a second, and the first few are routed in milliseconds, so their second opinions start at once and take three of the four slots. One slot is kept free for a route (decision 40), and the first lead that needs the model takes it. A second lead that needs the model in the same moment waits for a slot, up to one call. That is a limit of the design as built, not of the model.
- **Second opinions.** All 34 on the leads outside the list agreed with the rules. On the list 96 of 105 agreed and 9 would change a field. None raised a doubt.
- **The list's second opinions** were done 67 s after the upload, against 102 s at extra high and 248 s on the local model.
- **Cost.** 142 calls, $0.70. With the three further low-effort eval runs, the hosted testing in this record came to about $6.

## What I take from it

1. **Sonnet 5.5 qualifies for the slot by the rule this repository set for itself, and now fills it when a key is set.** It passes the same gate and is equal or better in every cell.
2. **Extra high does not earn its cost here, so low is the default.** Low matched it on these sets within one item, answered faster and cost three quarters as much. What extra high has in its favour is steadiness from run to run, on small samples: see "Low effort, three runs".
3. **The combine policy was built around a weak model, and now holds a strong one back.** On the sealed set the rules alone get use case right 13 times, Sonnet alone 23, and the rules-first pipeline 20. The model-first policy the eval already scores (v1) gets 22. For urgency the date parser still wins (23 against 21). So the next policy is per field: the model for use case, the parser for urgency, the person-in-the-loop guard for a model-only "not a buyer" unchanged.
4. **I have not made that change.** I have now seen this sealed set's results field by field, so choosing a policy on them would be tuning on the sealed set. It needs a fresh sealed set, written before the policy is.

## What this does not show

- The sets are 24 messages each, all invented. One or two items either way is not a finding.
- One afternoon, one network. Hosted latency moves with load.
- Nothing here was run on a real lead. A hosted model sees the message, the title, the organization type, the door and the date, never the name, email or company; real traffic would still need Serif's data terms first.
- The fixed prompt is sent in full on every call. Caching it would cut most of the input cost; that is not built.
