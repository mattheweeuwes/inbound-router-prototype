# Testing log

How each finding in this repository was reached, in the order it happened. Every entry says what I asked, how I tested it, what I found, what I changed because of it, and where the full record is. The records hold the commands, so each test can be run again on this code.

## What runs on every change

`npm run ci` runs these in order and stops at the first failure. `npm run day` is run beside it.

| Check | What it proves |
|---|---|
| `npm run typecheck` | The TypeScript, and the cockpit's JavaScript through its JSDoc types, compile with no errors. |
| `npm test` | The unit and pipeline tests: every rule, every stage, every failure path, on a small registry kept in the repo. |
| `npm run replay:ci` | The 40 fixture events go through the real inbound handler, nothing fails, and time to route stays under a 150 ms budget at the 90th percentile. |
| `npm run eval:gate:rules` | The classifier with no model in the loop still meets its measured results on the held-out and sealed sets. It has no slack, because without a model it is deterministic. |
| `npm run test:e2e` | Browser tests written as tasks a person does: find today's enterprise leads, settle a tie, confirm a link and undo it, open a linked view. |
| `npm run day` | One working day as a scenario: the 40 fixtures, 15 inbound events across Serif's growth segments, a 150-row list, then outbound, attribution, accounts and the brief, with 48 assertions. |

The eval with a model in the loop is not in CI. It needs the local model, or a key for a hosted one, so it runs on this machine with `npm run eval:gate`.

## The log

### 1. Does the classifier hold on messages it was not built on? (Nov 7 to 9)

- **How.** Three labelled sets: the 40 fixtures the rules were written beside, 24 held-out messages, and 24 sealed messages written before the date parser existed and kept out of the project until the classifier code was frozen. Each run records a hash of the sealed file and of every classifier source file, so a later edit to either shows.
- **Found.** On the sealed set the date parser got urgency right 23 times of 24 and the small local model alone 14. With the model filling gaps, use case rose from 13 to 18. The pipeline as a whole scored 23, 18 and 21 of 24 on urgency, use case and disqualifier.
- **Changed.** The model never sets urgency. Floors were set one below each recorded result, and the gate fails below them.
- **Record.** `docs/eval-record-2026-11-09.md`, `docs/eval-manifest-2026-11-09.json`. The earlier run is `docs/eval-record-2026-11-07.md`.

### 2. Is the model worth its place in front of the rep's alert? (Nov 9)

- **How.** I read the demo day's own database: which leads waited for the model, and how often its answer was the one used. Then I measured time to alert before and after a change, on the same 40 events, paced and as a burst.
- **Found.** The model was called on 28 of 39 leads and supplied a final field on 2. Its calls were nearly all of the time between a lead arriving and the rep hearing.
- **Changed.** A lead waits for the model only when the rules cannot settle its use case, the one field where the model's answer can change the team. Every other lead is alerted on the rules, and the same call follows as a second opinion (decision 19). Paced, time to alert went from a median of 2.5 s to 9 ms. Every routing decision stayed the same.
- **Record.** `docs/speed-record-2026-11-09.md`.

### 3. Does it hold for a working day at Serif? (Nov 9)

- **How.** I took what Serif's CTO said the company wants (more enterprise customers, referral as the main source of conversion, outreach built on its own data, growth without more people, add-on sales, a way to see what a feature did for sales) and ran one day against a running server with the model on: 15 inbound events across those segments, a 150-badge conference list, then the outbound, attribution and dashboard functions.
- **Found.** Routing was right on team for all 15. A national payer asking for the whole data lake with budget approved went to a channel queue with no named rep. Nothing treated a 145-hospital system as enterprise. Two referrals, one from a customer, were recorded as "direct". The list took 219 seconds to clear and posted 65 separate alerts. Outbound produced 2 drafts from 127 groups.
- **Changed.** An enterprise rule (decision 25), referral capture and credit (26), a second outbound play with link review, suppression and an export (27 to 29), feature interest and a "who asked" list (30), a morning brief (31), and the day itself as a scenario with assertions (32).
- **Record.** `docs/day-in-the-life.md`, which sets the first run beside the run after the changes and lists what still does not hold. The events are in `fixtures/day/morning.json`.

### 4. Does a list upload hold? (Nov 9)

- **How.** The same 150-row list, same seed, posted to the code before and after the change, each on its own server and database, with the local model on. Then the same upload with a demo request posted two seconds in.
- **Found.** Before: 145.8 s to empty the queue, time to route a median of 80 s, 74 Slack messages, and a demo request arriving during the upload alerted after 151 s. Leads committed strictly in the order accepted, and 64 of them waited for the model one at a time.
- **Changed.** Leads prepare at once and commit in per-organization lanes, so one slow lead holds only its own lane (decision 23). A list is routed on the rules and alerts once per team (24). After: 1.1 s to empty, a median of 1 ms, 6 messages, and the demo request alerted in 5 ms.
- **Record.** `docs/load-record-2026-11-09.md`.

### 5. Can a person work in the cockpit? (Nov 10)

- **How.** Not through the API or the tests. I loaded the day into a running server and used every tab by hand at 1440 px with tasks in mind: find today's enterprise leads, settle a tie in the review queue, confirm a link, find who asked for a feature. I also read the How it works tab against what the code does.
- **Found, first pass.** Twenty things that slow a person down, among them: the lead stream had no filter for enterprise, referral, list, team or tier and no sorting, and the 150-row list buried the day's leads; the review queue was read-only, so nothing let a person pick a candidate; the outbound link list sat above the table with wrong candidates first, jumped the page on every click and had no undo; no view could be linked. How it works was behind the code in nine places.
- **Found, second pass**, after those were fixed, by doing the tasks again: a filter menu closed whenever a lead arrived; sending a list's unplaced rows to nurture brought a badge that had been scanned twice back into the queue; the list-wide send used a browser dialog; the review tab and its badge disagreed with no hint.
- **Changed.** A person's decision on a review item (decision 33), How it works redrawn and checked against the code by a test (34), views in the address (35), a list as one row (36), controls that keep their place while leads arrive (37), one visual system with the helper wording removed (38). The browser tests in `e2e/use-the-cockpit.spec.ts` are those tasks.
- **Record.** This entry, the decisions it names, and the tests.

### 6. Would a hosted model do better than the local one, and what would it cost? (Nov 10)

- **How.** Claude Sonnet 5.5 through the same eval as the local model: the same three labelled sets, the same floors, nothing loosened. Extra-high effort twice, to see whether it answers the same way both times, and low effort once. Then the whole working day from entry 3 with the hosted model in the slot. The local model was run again on the same code the same day, so the comparison is like for like.
- **Found.** The hosted path already in the code had never been run and current models would have refused its request. Once fixed: Sonnet passes the gate at both efforts. On its own it beats the local model on every field (use case on the sealed set: 23 or 24 of 24 against 18). The two extra-high runs agreed on use case and disqualifier for 76 of 76 messages. Extra high was no more accurate than low, took about 1.7 times as long and cost a third more. No call ran past the 8 s limit. The day routed the same 51 comparable leads the same way, and cost $1.00.
- **Found by running the day, not the eval.** The list's second opinions took longer on the hosted model than on the local one, because the worker asked them one at a time whatever the number of slots.
- **Changed.** The hosted request (decision 39) and the second-opinion pool (40). The default model did not change, and neither did the combine policy.
- **Not changed, on purpose.** The results say the rules-first policy now holds a strong model back on use case. I have seen the sealed set's results field by field, so a policy chosen on them would be tuned on the sealed set. It needs a new sealed set first.
- **Record.** `docs/hosted-model-record-2026-11-10.md`, with the full eval output in `docs/eval-record-2026-11-10-sonnet-5-5-xhigh.md` and `-low.md` and their manifests.

## What these tests do not show

- Every person, lead, deal and usage event is invented. No result here is a result on Serif's traffic.
- The labelled sets are 24 items each. A difference of one or two items is not a finding.
- Timings are from one Mac, with a small local model unless an entry says otherwise. Hosted timings are from one afternoon on one network.
- HubSpot has been written to only in a developer test portal. Slack is recorded, never sent.
- Nobody on a sales or marketing team has used it. The hands-on pass was mine.
