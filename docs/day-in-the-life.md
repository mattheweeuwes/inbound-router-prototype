# A day as the GTM engineer at Serif

I ran one working day against this platform to see whether the pitch holds. Serif's CTO said what the company wants: more enterprise customers, inbound referral as the main source of conversion, outreach built on its own data, growth without more people, add-ons sold to existing accounts, and a way to see what a feature did for sales. The day is fifteen inbound events across those segments (`fixtures/day/morning.json`, each with the sentence a seller or marketer would expect of it), a 150-scan conference list uploaded at once, the outbound module and the feature view.

The first run, at commit `092568c`, held for 9 of the 15 events, was half right on 5 (D01, D06, D07, D12, D13) and missed D04. This document sets what that run found beside what the platform does now. `npm run day` replays the day in process (rules only, offline, HubSpot dry-run) and checks 48 assertions, and `test/day.test.ts` runs the same scenario on the test registry in CI. The new numbers below are from `npm run day` on the real registry and the August 2026 rate file. The times are from `docs/load-record-2026-11-09.md`, because the scenario runs on a fixed clock and every duration in it reads as zero. All times are US Eastern; the day's clock stops at 6:30 pm. Every person is invented.

## 9:30 am: an enterprise health system, sent by a customer (D01)

Sales asked for this one to be treated as a deal, not a form. An SVP of Managed Care at CommonSpirit Health books a demo and writes that the contracting VP at Wrenfield Health recommended Serif.

Before: tier A 90, Health Systems team, round-robin to Jordan, alerted in 44 ms. The channel was recorded as "direct". Nothing marked the account as enterprise, and the referral was not captured.

Now: tier A, Health Systems, a named rep (Avery) under the enterprise rule with 5 minutes to respond, the alert carries the account's hospital fact, and the referral is resolved to Wrenfield Health as a customer owned by Avery, who gets a planned thank-you task (dry-run). The channel reads referral, and the referral adds 10 points to intent.

## 10:10 am to 11:50 am: a consultant, an employer, a payer, a developer (D02 to D05)

D02, Mercer, is tier A to Benefits & Workforce in both runs, and now to a named rep under the enterprise rule. D03, an employer nobody has heard of who took the benefits playbook, goes to Benefits & Workforce nurture, flagged as an inferred employer, in both runs.

D04 is the biggest deal of the day: Humana asks for a bulk license of the full negotiated-rate data lake, all payers and states, with the budget approved. Before, it was tier B 69, one point under A, and went to a team queue with a 60 business-minute SLA and no name on it. Now the message's deal-size cues ("bulk license", "budget is approved") send it to a named rep (Quinn) with 15 minutes. The tier does not change. The cues are the prospect's own words, and the README says so.

D05, a developer creating an API key, goes to the Data & API team in both runs.

## 12:10 pm: a customer asks about a feature that has not launched (D06)

Customer success asked for this. A director at Brindlewood Mutual Health, a customer, writes to the Signal Ask waitlist: would it cover out-of-network exposure by market?

Before: an owner task to Taylor, which was right, and nothing else. Nothing recorded that this customer asked about Signal Ask, so there was no list to work from when it launches. The alert took 12.0 s.

Now: the same owner task, and Signal Ask is a feature in preview with no launch date. The lead is tagged with it by two cues, the door and the words, and appears in that feature's asked list as a customer owned by Taylor, with a quote of the message. The asked list is what customer success reads when the feature ships.

## 12:40 pm to 2:10 pm: private equity, life sciences, a solo practice, web visits, a vendor (D07 to D11)

D07 (Welsh Carson, a live diligence) and D08 (Vertex) go to the Payers, Life Sciences & Advisory team. Before, they sat in the team queue with a 60-minute SLA; now both reach a named rep with 15 minutes, because their messages carry deal-size cues ("portfolio MSOs", "ten states"). D07's "Managing Director" was read as director seniority before; it reads as vice-president now.

D10, a practice manager on a free-mail address asking what Aetna pays for one code, goes to RevOps review in both runs. D11, a vendor pitch, is dropped and nobody is alerted, in both.

When this day was first run, a review item could only be read: the tab said RevOps decides and nothing let anyone decide. Since then a person decides in Needs a person: they choose one of the candidates (or, for an unplaced company, an account the registry or the CRM holds), send the lead to nurture, rule it not a buyer, or clear the model's doubt, and the lead runs through the router again with that decision (`docs/DECISIONS.md` #33). The list's unplaced rows go to nurture in one step. `npm run day` itself still leaves the review items open, so its counts are the router's alone.

D09 is the one nobody sees: six page views from kp.org, four of them on pricing and Network benchmarking, no person. It was an account signal and a research task before, and it still is. What is new is that the visits are read for the feature they point at: the pages are tagged as interest in Network benchmarking by visited path, and in Signal search.

## 3:10 pm to 4:30 pm: a referral, a second person, a customer, a broker (D12 to D15)

D12 is a regional system with a contract expiring on March 31 that heard about Serif from a peer. Before, tier A to Jordan, with the channel "direct". Now the form answer is resolved to Emory Healthcare, which is not a customer, so the referral is credited and scored (6 points), and the lead is still a rep alert, 5 minutes.

D13 is a second person at CommonSpirit two hours after D01. Before, the same rep (Jordan) got it, and the alert did not say who else was already in. Now the same rep gets it (Avery, the same one as D01), and the alert names Helena Marsh. One note to sales leadership goes out for the account, not one per person.

D14, a customer contact downloading a guide, goes to the owner (Avery) as a task and not as new business. D15, a Lockton analyst with six sessions and two searches, goes to Benefits & Workforce as before, and now to a named rep with 15 minutes.

## What the same morning looked like to the machine

Seven of the fifteen leads were alerted 12 to 14 seconds after they arrived, although their own processing took milliseconds, because leads committed strictly in the order accepted and unrelated leads were waiting for the model. Now, with the day's events posted together, the sales-routed leads' time to alert has a p50 of 227 ms against 7,043 ms, and one lead is alerted after more than a second (D06, 7.3 s, which waited for its own model call and shared the model's one slot with D10's), against seven.

## 5:00 pm: the conference list

Marketing came back with 150 badge scans from HLTH, 12% at companies nobody knows, 5% on free mail, 3% at customers and 4% repeat scans, in no time order.

Before: all 150 accepted in 0.8 s, then 219 seconds to empty the queue. Time to route p50 was 115 s and p90 208 s, and a demo request arriving during the upload would wait behind it. It produced 48 team-queue items (39 posted one by one to `#leads-hsp`), 77 nurture entries, 17 separate RevOps review items and 7 owner tasks. Six badges were in the list twice; one pair was attached, and five were routed twice.

Now: all 150 are routed in about a second (p50 1 ms, p90 20 ms), the list sends 6 messages instead of 74 (one digest per team and one to RevOps, plus a rep alert), and a demo request during the upload was alerted in 5 ms instead of 151 s. `npm run day` on the real registry gives 1 tier A, 57 B, 72 C and 20 D; 72 nurture, 49 team queue, 16 review, 7 owner tasks, 5 repeats attached and 1 rep alert; and 5 digests (one each for the API, BW, HSP, PLS and Review teams) carrying 144 rows. Two runs with the same seed make the same decision on every row.

## 6:00 pm: outbound, and what the data says to sell

The rate file has 127 groups. Before, 3 were targets and 2 drafts were ready, nothing checked whether a group was already a customer or being worked inbound, and there was no export. Now there are two plays (platform, and a system-gap play for the Health Systems team), links between a group and a registry organization wait for a person to confirm them, groups someone already has are suppressed with who has them, and ready drafts export as a CSV. `npm run day` reads 3 drafts ready (2 platform, 1 system gap), 1 blocked, 4 suppressed, 28 links waiting for a decision, 91 not a target, and 3 export rows. The counts add up to the 127 groups.

## 6:30 pm: what a morning looks like, and what a feature did

Before, the dashboard had the pieces and no one place to start. Now there is a Today tab (second, after Overview) and `npm run brief`, built from what the platform already holds, with the ids to open each row: what needs a person now, enterprise accounts and their rep, who referred whom, what each list produced, expansion signals, outbound, feature interest this week and health. It decides nothing.

For engineering, the Feature to pipeline tab used to answer "how did Network benchmarking help sales" from invented usage and deals only: 5 of 12 accounts adopted it, 5 deals ($487K) had it around, a median of 41 days from first use to an opportunity. It still does, and it now has an Interest column beside those. After the day, on the real registry, interest from the lead stream reads Network benchmarking 11 people, API 10, Signal Watch 9, Signal search 2, Signal Ask 2, MCP 1 and the quality preview 0. The day's two people who named or visited Network benchmarking (D02, D09) and the one who took the benefits playbook (D03) are among them, each with its evidence. The list rows add the rest, from their booth notes. This is what was asked for, and not a measure of what a feature did for a deal: interest is people who said or showed something, it is kept apart from usage and deals on the page, and it changes no score.

## The first run, repeated by hand

After the changes I repeated the first run's steps over HTTP against a running server, under the first run's conditions (the local model on, registry lookups on, the 40 base fixtures replayed first), with the same two scripts.

- The fifteen events posted together: thirteen were alerted in under 300 ms. The two that needed the model before routing took 4.9 s (D06) and 7.7 s (D10, which waited for D06's call to free the model's one slot). In the first run seven leads took 12 to 14 s.
- The same 150-badge list: the queue was empty 1.5 s after the first post, against 219 s. Time to route was p50 2 ms, p90 20 ms, slowest 26 ms. Five digests went out in place of 48 queue alerts and 17 review alerts.
- A demo request from a 36-hospital system, posted while the list was being worked, was a tier A rep alert in 7 ms.
- Three of the six repeat scans were attached to their first scan. The other three followed a first scan that had gone to nurture, which decision 6 leaves alone.

## What still does not hold

- The model has one slot. A lead that needs it before routing (D06 and D10 here) waits for its own call, and two such leads wait for each other. The second opinions of a 150-row list still take minutes.
- A repeat scan of a badge whose first scan went to nurture is routed on its own (decision 6). On the day's list that is 1 of 6.
- The enterprise definition is a starting assumption. On the real registry it makes many systems enterprise (54 of the 153 accounts after the day) and sends more people to a named rep. Serif should tune it, and the deal-size cues are the prospect's own words.
- Referral capture is phrase-based: "Jane at Emory said we should call you" is missed. Interest cues are the same, and the aliases are mine to tune.
- Usage and deals are invented, on twelve fictional accounts, and the attribution is influence, not cause: most win-rate comparisons rest on fewer than five closed deals on a side.
- Twenty-eight probable links between rate groups and registry organizations need a person, and some candidates are wrong, so nothing is linked until someone confirms it.
- A person's decision, on a review item or a link, records the name they typed: sign-in is not built. A review decision cannot be undone in the product; a second one is refused.
- The scenario runs on a fixed clock, so its own timings read zero; the timed numbers are from the load record, which used the local model on one Mac. Health's queue-wait and time-to-alert figures in the brief cover every lead, not the window.
- Nothing here is sent. HubSpot is dry-run and Slack is a recorder, so what the reps and customer success would do with it is not tested.
