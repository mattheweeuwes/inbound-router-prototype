// What each box on the How it works tab explains when it is clicked, with no DOM in it: the files, what it does, how it is
// built, what would change in production, and the tests that prove what the box claims. how.js draws it. Kept apart so
// test/how-it-works.test.ts can read every sentence: each figure in it is checked against the constant it names, and each
// test it cites must exist (docs/DECISIONS.md #34). Write a figure here only when the code has it.

/**
 * @typedef {{ h: string, items: string[], ordered?: boolean }} Section
 * @typedef {{ title: string, files: string, sum: string, facts: [string, string][], sections: Section[], prod: string, tests: [string, string][] }} Node
 */

/** @type {Record<string, Node>} */
export const TOPO = {
  doors: {
    title: 'Inbound doors', files: 'src/sources/*.ts',
    sum: 'Eight sources, each with its own adapter. An adapter turns that tool\'s webhook payload into one canonical lead event, so nothing after this point knows which vendor sent it.',
    facts: [['Language', 'TypeScript'], ['Shape', 'One file per source, a pure function from the vendor payload to the canonical LeadEvent type.'], ['Dependencies', 'None. No vendor SDKs.']],
    sections: [
      { h: 'The adapters', items: ['Calendly-style demo request: the signed door.', 'HubSpot-form-style gated guide and Signal Ask waitlist.', 'Product events for the Try Signal sign-up and API or MCP key creation, with usage counts.', 'Marketplace inquiry, event badge scan (an uploaded list), and account-level web intent (no person).'] },
      { h: 'Why this shape', items: ['Vendor quirks stay at the edge.', 'A new door is one adapter and a fixture. The pipeline does not change.'] },
    ],
    prod: 'Point each adapter at the live tool\'s webhook.',
    tests: [['test/pipeline.test.ts', 'other sources are not signature-gated, and bad input gets a 4xx']],
  },
  webhook: {
    title: 'Webhook', files: 'api/inbound.ts · src/sources/calendly.ts · src/pipeline.ts',
    sum: 'One endpoint, POST /api/inbound?source=<door>. It verifies the request, records the event exactly once, answers 202, and does the work after the response.',
    facts: [['Language', 'TypeScript'], ['Shape', 'A Web-standard handler (Request in, Response out). Locally a small node:http server sits in front of it, bound to 127.0.0.1 unless HOST says otherwise.'], ['Crypto', 'node:crypto: HMAC-SHA256 and a constant-time compare.']],
    sections: [
      { h: 'Each request', ordered: true, items: ['A signed door with no key configured answers 503. It fails closed.', 'Signature: HMAC-SHA256 over the timestamp and the raw body. A timestamp more than 300 seconds old is rejected, which stops replays. A bad signature gets 401.', 'The payload is adapted to the canonical event.', 'Insert, in one transaction, with a unique key on (source, source event id). The id comes from the payload\'s own timestamp, or from a SHA-256 of the body, never from server time. A re-delivery gets 200 with no work done.', 'A new event gets 202 Accepted and is processed off the request path.'] },
    ],
    prod: 'Parallel workers with a per-account lock instead of the one ordered section, and a dead-letter queue for events that keep failing.',
    tests: [['test/pipeline.test.ts', 'a re-delivered webhook returns 200 duplicate and does nothing else'], ['test/signed-doors.test.ts', 'a valid signature with the key still gives 202, and a bad signature still gives 401']],
  },
  lanes: {
    title: 'Prepare at once, commit in lanes', files: 'src/pipeline.ts · src/lanes.ts · src/commitOrder.ts · src/limiter.ts',
    sum: 'Each lead\'s order-independent work starts as soon as it is accepted. Everything that depends on earlier leads then commits one lead at a time, in acceptance order within a lane.',
    facts: [['Prepare', 'Normalize and resolve with their lookups, four leads at a time (PREPARE_CONCURRENCY), then the rules and, when the route needs it, the model.'], ['Commit', 'Dedupe, the account, score, route, round-robin, the alert and the HubSpot plan, one lead at a time, so round-robin and dedupe never race.'], ['Lane', 'The organization: the email domain, or the address on free mail.']],
    sections: [
      { h: 'Passing', items: ['A lead still waiting for its prepared result (a model call, a slow lookup) holds only its own lane.', 'After a grace of 250 ms (COMMIT_GRACE_MS) a ready lead in another lane passes it. Leads of one lane always commit in the order they were accepted.', 'COMMIT_GRACE_MS=never keeps strict acceptance order; CI replays that way.'] },
      { h: 'Restarts', items: ['Every stage writes its result and its time. A re-run replaces what an earlier run derived, so a restart re-runs anything unfinished. A re-run can repeat an alert.'] },
    ],
    prod: 'Workers per lane across processes, with the lane as the lock.',
    tests: [['test/lanes.test.ts', 'a lead waiting for the model holds its own lane only: after the grace a ready lead in another lane passes it'], ['test/model-path.test.ts', 'a later lead prepares while an earlier one waits for the model, and still commits after it']],
  },
  normalize: {
    title: 'Normalize', files: 'src/normalize.ts',
    sum: 'Turns the raw event into fields that compare cleanly across doors.',
    facts: [['Language', 'TypeScript'], ['Shape', 'Pure functions with no network calls, driven by lookup tables.']],
    sections: [
      { h: 'What it derives', items: ['A lower-cased email and a contact key, which catches the same person arriving through another door.', 'First and last name, with casing fixed.', 'Job function and seniority, read from the title.', 'Clean UTM tags, and a channel from the door, the UTMs and the referrer. A named referral sets the channel to referral.', 'The email domain, kept only if it is a plain DNS hostname.', 'Free-mail and disposable-mail flags.'] },
    ],
    prod: 'Also check HubSpot for the same contact touched in the last 30 days.',
    tests: [['test/normalize.test.ts', 'treats a port, path, query, IP literal or bare name as no domain']],
  },
  resolve: {
    title: 'Resolve', files: 'src/resolve/*.ts · src/review/resolution.ts',
    sum: 'Places the lead on a real organization by ID, so three people from one health system become one account. Every answer carries its evidence as one sentence.',
    facts: [['Language', 'TypeScript'], ['Shape', 'An ordered list of resolvers. The first confident answer wins.'], ['Data', 'The registry database, attached read-only. NPPES and homepage titles are fetched live, each with a 4 s timeout.']],
    sections: [
      { h: 'Resolution order', ordered: true, items: ['A curated domain list, payers included.', 'Organization domains from the registry.', 'Company-name match, using one name-normalization rule shared with the Python ETL.', 'The homepage title of an unknown corporate domain (at most 64 KB read, at most 3 redirects, https and public addresses only).', 'NPPES for provider groups (organization NPIs only).', 'Top-level-domain rules.', 'Otherwise unknown. An HR or benefits title at an unknown company is a probable self-funded employer, with low confidence.'] },
      { h: 'When it cannot decide', items: ['No match, or candidates within 0.1 of each other: held for a person (R6).', 'A person\'s choice in Needs a person is stored with the lead. Every later run uses it and does not ask the resolver again; its method is person.'] },
    ],
    prod: 'Match on existing HubSpot company records first, then the registries.',
    tests: [['test/pipeline.test.ts', 'an ambiguous free-mail company goes to review with candidates, and is not guessed'], ['test/review-decision.test.ts', 'the choice survives a later re-run (boot recovery) without asking the resolver again']],
  },
  qualify: {
    title: 'Qualify', files: 'src/qualify/rules.ts · when.ts · llm.ts · combine.ts · src/modelPath.ts',
    sum: 'Reads the message for use case, buying role, urgency and disqualifiers. The rules run on every lead; the model is asked before the route only when the rules cannot settle the use case.',
    facts: [['Language', 'TypeScript'], ['Shape', 'Rules, a date parser and a model slot, and a combiner (the guard rails, version 4) that decides which one wins each field.'], ['Model call', 'Ollama /api/chat at temperature 0, output held to a JSON schema, 8 s timeout.']],
    sections: [
      { h: 'When the model runs', items: ['Before the route only for free text with no clear keyword use case, because the use case can change the team.', 'Never before the route for an uploaded list.', 'Every other free-text lead is routed and alerted on the rules, and the same call runs after the alert as a second opinion.'] },
      { h: 'Who decides each field', items: ['Use case: a clear keyword winner, else the model at 0.6 confidence or more, else the rules.', 'Buying role: title seniority, else the model.', 'Urgency: the date parser only. No timing language is unknown.', 'Disqualifier: a rule hit counts. A model-only spam or vendor-pitch call always goes to a person; any other model-only disqualifier counts at 0.8 or more, and below that a person decides.'] },
    ],
    prod: 'The model slot is filled by whichever model clears the eval floors on labelled production leads.',
    tests: [['test/model-path.test.ts', 'a use case the rules cannot settle waits for the model, and the route uses its answer'], ['test/pipeline.test.ts', 'a model-only disqualifier below 0.8 confidence sends the lead to review instead of dropping it'], ['test/lists.test.ts', 'a badge note the rules cannot settle is routed on the rules, and the model answers after the alert']],
  },
  model: {
    title: 'Model slot', files: 'src/qualify/llm.ts · src/qualify/prompt.ts',
    sum: 'The model sits behind one provider interface, so it can be swapped without touching the pipeline. This demo runs a small local model as the baseline.',
    facts: [['Interface', 'Three providers: Ollama (local), rules only (no model), and a hosted provider that is written but switched off.'], ['Demo model', 'Llama 3.2 3B through Ollama on this machine.'], ['Call', 'Temperature 0, JSON-schema output, 8 s timeout. Plain fetch, no SDK.']],
    sections: [
      { h: 'What decides the slot', items: ['The eval: dev, held-out and sealed sets (the sealed set is 24 leads), with a floor per field.', 'A manifest hashes the sealed set and every classifier file, so each result is tied to the exact code behind it.', 'CI runs the gate with the model off, so the result is the same every time.'] },
    ],
    prod: 'Run candidate models, open-weights or hosted, against labelled production leads. The one that clears the floors takes the slot.',
    tests: [['test/eval-gate.test.ts', 'fails when any single field is one below its floor']],
  },
  secondopinion: {
    title: 'Second opinion', files: 'src/secondOpinion.ts · src/decisions.ts (compareSecondOpinion)',
    sum: 'A lead routed on the rules gets the same model call after its alert, one at a time and only while no lead is waiting. A disqualifier only the model raised does not un-route the lead.',
    facts: [['When', 'After the alert, in the lulls between leads.'], ['Stored', 'What the model said, whether it agrees with the route and which fields it would change.'], ['On a doubt', 'A review item opens, and a follow-up goes to where the alert went and to RevOps. The lead stays with its rep until a person decides.']],
    sections: [
      { h: 'Which doubts follow up', items: ['On an owner route (R5) or a round-robin route (R8, R10): the item and the follow-up.', 'On a repeat touch (R2): recorded only.', 'When a person already said the lead is a buyer: recorded, and nothing is opened or sent.'] },
    ],
    prod: 'Measure how often the second opinion would have changed the route, and move a field before the route only if that rate earns it.',
    tests: [['test/model-path.test.ts', 'a doubt the rules did not share opens a review item and a follow-up to the rep and RevOps; the lead stays routed'], ['test/review-decision.test.ts', 'a doubt after the alert cleared as a buyer closes the item, re-routes nothing, and is not raised again on a re-run']],
  },
  score: {
    title: 'Score', files: 'src/score.ts · src/referral.ts',
    sum: 'An explainable score out of 100: fit up to 50 plus intent up to 50. Every point is an itemized line stored with the lead.',
    facts: [['Language', 'TypeScript'], ['Shape', 'A pure function that returns the line items, the total and a tier.'], ['Weights', 'A points table in score.ts.']],
    sections: [
      { h: 'Fit', items: ['Segment.', 'Size: hospitals in the system, or beds.', 'Persona: job function times seniority.'] },
      { h: 'Intent', items: ['The door: a demo request outweighs a guide download.', 'Urgency, from the date parser.', 'Product usage, and repeat touches in the last 30 days.', 'Other activity at the same account.', 'A named referral: 10 points from a customer, 6 from a known organization, 3 from words alone.'] },
      { h: 'Tiers', items: ['A at 70 or more, B at 50, C at 30, D below that.'] },
    ],
    prod: 'Refit the weights on closed-won outcomes once there are enough, and keep the line items.',
    tests: [['test/score.test.ts', 'itemizes 10 for a customer, 6 for a known organization and 3 for an unidentified one, as intent'], ['test/score.test.ts', 'tier boundaries']],
  },
  route: {
    title: 'Route', files: 'src/route.ts · src/enterprise.ts · src/dealCues.ts · src/time.ts',
    sum: 'Ordered rules, first match wins. Each decision stores the rule, a one-line reason and an SLA due time in business hours.',
    facts: [['Language', 'TypeScript'], ['Shape', 'One function that walks the rules in order and returns a decision object.'], ['SLA clock', 'Business-hours math in Eastern time, written without a time-zone library.']],
    sections: [
      { h: 'Rules, in evaluation order', ordered: true, items: [
        'R1 spam by rule, or a disposable email: drop.',
        'R2 the same person already went to sales in the last 30 days: attach to that record, with no new alert inside 24 hours of the last one.',
        'R9 web intent (account-level): an account signal, never a rep alert.',
        'R3 competitor: flag to marketing. R4 disqualified or out of scope: careers, press, drop, research or out of territory.',
        'R5 the account already has an owner: the owner gets it, ahead of round-robin, with any doubt in the alert.',
        'R6 no organization, a tie, or a model-only non-buyer call: RevOps review, with a 60 business-minute SLA.',
        'R10 a person (not a list row) at an enterprise account, or at a known organization whose message has a deal-size cue, at tier B or better: a named rep by round-robin, with 5 minutes for tier A and 15 for tier B.',
        'R7 and R8 team by segment, then tier: A alerts a named rep (5 minutes), B goes to the team queue, C and D go to nurture.',
      ] },
      { h: 'Enterprise', items: ['A health system with 8 or more hospitals or hospitals in 3 or more states, a national or Blue payer, or a national broker, consultant or TPA. A starting assumption for Serif to replace.'] },
      { h: 'No double assignment', items: ['When round-robin names a rep, the account is claimed in the same transaction as the assignment.'] },
    ],
    prod: 'Territories and tier cut-offs move into config that RevOps can edit. The rules keep their tests.',
    tests: [['test/route.test.ts', 'a tier-B lead at an enterprise account goes to a named rep with a 15-minute response time, and says why'], ['test/route.test.ts', 'R2: the alert is suppressed inside 24h; after that only a tier-A touch re-alerts'], ['test/pipeline.test.ts', 'an existing account owner beats round robin (R5)']],
  },
  alert: {
    title: 'Alert', files: 'src/notify/slack.ts · src/brief.ts · src/listDigest.ts',
    sum: 'Tells the owner, with an SLA due time and a brief they can act on in a minute. It goes out before the HubSpot write, so Slack never waits on HubSpot. In this prototype every message is a recorded Block Kit payload, not sent.',
    facts: [['Format', 'A Slack Block Kit payload, stored on the lead.'], ['SLA', 'A due time computed in business hours, Eastern time.'], ['Brief', 'Extractive: the prospect\'s own words, quoted, plus facts from the registry, the enterprise fact, the referral and others in from the account. No model writes any of it.']],
    sections: [
      { h: 'Uploaded lists', items: ['A list\'s team-queue, owner-task, nurture and review rows post no alert each. One digest per list and team goes out once the list has been quiet for 5 s (LIST_QUIET_MS). A rep alert still goes out on its own.'] },
      { h: 'Enterprise deals', items: ['The first enterprise lead from a person at an account in 30 days, routed to sales and not from a list, also posts a short note to the enterprise deals channel.'] },
    ],
    prod: 'Post to the owner\'s Slack channel. The link to the HubSpot record comes in a follow-up once the write returns an id.',
    tests: [['test/lists.test.ts', 'flush waits for the quiet period on the injected clock, then records one digest per team'], ['test/crm-failure.test.ts', 'the Slack payload is the same whether HubSpot answers or throws, so it uses nothing from the CRM stage'], ['test/day-morning.test.ts', 'D01: an enterprise system with its hospital fact, referred by a customer owned by Avery, reported as a referral']],
  },
  hubspot: {
    title: 'HubSpot', files: 'src/crm/hubspot.ts · src/crm/outbox.ts · scripts/hubspot-setup.ts',
    sum: 'Plans each routed lead\'s HubSpot writes: the contact, the company, and a task for the owner. Dry-run by default; with a live key the plan goes to an outbox that delivers it after the alert.',
    facts: [['API', 'HubSpot CRM v3 REST with a service key. Plain fetch, 10 s timeout per call, no SDK.'], ['Modes', 'Dry-run writes the request bodies to files. Live needs a key and HUBSPOT_LIVE=1. CI cannot write.'], ['Outbox', 'Plans are delivered oldest first, outside the one-at-a-time section.']],
    sections: [
      { h: 'Writes', items: ['Contacts: batch upsert keyed by email.', 'Companies: batch upsert keyed by the router\'s account key, so one system is always one company.', 'A task for the owner, associated to the contact and the company.'] },
      { h: 'When a write fails', items: ['A network error, a 429 or a 5xx is retried with backoff, honoring Retry-After.', 'After 8 attempts the plan is marked dead and counted on the Overview.', 'Any other 4xx is recorded and the plan goes on, as a retry would get the same answer.'] },
    ],
    prod: 'Map to the portal\'s own properties, and push account scores back in batches from a database view (reverse ETL).',
    tests: [['test/crm-failure.test.ts', 'gives up after the last attempt, and the dashboard counts the lead as a failed, not synced, write'], ['test/crm-failure.test.ts', 'a 429 stops the plan at that request and honors Retry-After when it asks for longer than the backoff']],
  },
  review: {
    title: 'Needs a person', files: 'src/route.ts (R6) · src/review/*.ts · api/review.ts',
    sum: 'When the router cannot decide, the lead stops for a person instead of guessing, and the person decides there. Their decision is stored with the lead, which runs through the router again with it.',
    facts: [['Opened by', 'No organization match, a tie, a model-only non-buyer call before the route, or the second opinion\'s doubt after the alert.'], ['Decisions', 'Use one of the candidates (or, for an unplaced company, an account the registry or the CRM holds); send to nurture; not a buyer, with the reason; or, for a doubt, it is a buyer.'], ['Who', 'The name typed in Deciding as. Sign-in is not built, so the route is served only with DEMO_ROUTES=1.']],
    sections: [
      { h: 'What a decision does', items: ['The lead runs again with the decision. A chosen account is scored and routed like any other lead: the owner rule, the enterprise rule and the tier all apply.', 'Not for sales goes to marketing\'s nurture track and not a buyer drops the lead, both under the rule person.', 'It is a buyer on a doubt after the alert closes the item; nothing is re-routed.', 'A list\'s unplaced rows can go to nurture in one step.'] },
      { h: 'What it cannot do', items: ['Decide an item twice, or decide a lead that is still running.', 'Choose an account that is not a candidate of a tie.'] },
    ],
    prod: 'Sign-in, so the decision names a real user, and a weekly look at the review volume and how often the model and the rules disagree.',
    tests: [['test/review-decision.test.ts', 'the Baptist Health tie, resolved to one candidate, is scored and routed like any lead, and leaves the queue'], ['test/review-decision.test.ts', 'a second decision on a decided item is refused and says who decided'], ['test/review-decision.test.ts', 'one call sends every open unplaced-company row of the list to nurture and says how many']],
  },
  registries: {
    title: 'Public registries', files: 'etl/build_registry.py → data/registry.sqlite',
    sum: 'A local lookup database built from public sources, so resolution is instant and the data is versioned with the code. The counts on the drawing are read from the registry the server runs on.',
    facts: [['Language', 'Python 3, standard library only.'], ['Output', 'One SQLite file with indexed tables, opened read-only by the app.'], ['Live lookups', 'NPPES and homepage titles, each with a 4 s timeout.']],
    sections: [
      { h: 'Sources', items: ['CMS Hospital General Information: every Medicare hospital, keyed by CCN.', 'AHRQ Compendium of US Health Systems: systems and their member hospitals.', 'Serif\'s public payer inventory, plus a hand-verified domain list.'] },
    ],
    prod: 'Rebuild on CMS\'s release schedule, and add the company\'s own account tables.',
    tests: [['test/match.test.ts', 'agrees with the real registry name_norm column when it exists']],
  },
  referral: {
    title: 'Referral capture', files: 'src/referral.ts · src/leadSignals.ts',
    sum: 'An answer to "How did you hear about us?" or a phrase such as "recommended you" is resolved to the organization that referred the lead, by rules, never by the model.',
    facts: [['Resolves', 'The CRM\'s customers first, then the registry, confident matches only.'], ['Feeds', 'Intent points in Score, the lead\'s channel (referral), a signal on the referring account and a dry-run thank-you task for its owner.']],
    sections: [{ h: 'Points', items: ['10 from a customer, 6 from a known organization, 3 from words that resolve to nothing.'] }],
    prod: 'Read the CRM\'s own referral field, and credit the referrer\'s owner in the pipeline report.',
    tests: [['test/referral.test.ts', 'the CRM first, then the registry; a customer is worth 10, a known organization 6, words alone 3'], ['test/day-morning.test.ts', 'D01: an enterprise system with its hospital fact, referred by a customer owned by Avery, reported as a referral']],
  },
  interest: {
    title: 'Feature interest tags', files: 'src/interest/*.ts',
    sum: 'Each lead is tagged, as it is committed, with the features it showed interest in: by its words, the door it came through, a guide about the feature or the pages its account visited. Tags change no score or route.',
    facts: [['Stored', 'One row per lead and feature, with the cue and its evidence.'], ['Read by', 'Feature to pipeline and the Today brief.']],
    sections: [{ h: 'Not counted', items: ['A message that asks for a feature without naming it, and leads routed as not a buyer.'] }],
    prod: 'Tag from the product\'s own feature flags as well as the words.',
    tests: [['test/interest.test.ts', 'tags change no tier, score or route: the same lead scores the same with and without a feature in its message']],
  },
  usage: {
    title: 'Usage and deals', files: 'src/usage/*.ts · fixtures/usage/',
    sum: 'PostHog-shaped product events and HubSpot-shaped deals, joined on the router\'s account key. In this prototype every event and deal is invented, on fictional .example accounts.',
    facts: [['Events', 'POST /api/usage, idempotent on the event id; an unknown event is stored as unmapped, never dropped.'], ['Deals', 'Loaded from a fixture standing in for HubSpot\'s deals.']],
    sections: [{ h: 'Influence', items: ['A feature influenced a deal when the account used it in the 90 days before the deal was created or while it was open. Influence, not proof of cause.'] }],
    prod: 'A PostHog webhook destination posting to the same endpoint, and deals read from HubSpot.',
    tests: [['test/usage-attribution.test.ts', 'the window is 90 days before creation, both ends included, as the code says'], ['test/interest.test.ts', 'says apart that usage and deals are invented and that interest comes from the lead stream']],
  },
  pipeline: {
    title: 'Feature to pipeline', files: 'src/usage/view.ts · src/interest/view.ts · GET /api/attribution',
    sum: 'Per feature: the accounts using it, the deals it was around and the win rate with and without it, each with the counts it rests on, and who in the lead stream asked for it.',
    facts: [['Tab', 'Feature to pipeline.'], ['Badges', 'Usage and deals are marked synthetic; the lead stream is marked apart.']],
    sections: [{ h: 'Expansion', items: ['A customer that used an add-on\'s preview at least 3 times in 30 days with no deal for it is listed for customer success, with a dry-run task.'] }],
    prod: 'The same view over real PostHog and HubSpot data.',
    tests: [['test/usage-attribution.test.ts', 'a customer with three preview uses in 30 days and no add-on deal is listed, with its evidence'], ['test/interest.test.ts', 'counts people, accounts, sales-ready, tiers and cues, and lists who asked newest first with a cut quote']],
  },
  today: {
    title: 'Today brief', files: 'src/todayBrief.ts · GET /api/brief',
    sum: 'One place to start the morning: what needs a person, enterprise, referrals, lists, expansion, outbound, feature interest and health. It reads the same read models as the dashboard and decides nothing.',
    facts: [['Tab', 'Today.'], ['Writes', 'None. Every row opens the tab that holds its detail.']],
    sections: [{ h: 'Also', items: ['npm run brief prints the same answer as text.'] }],
    prod: 'Post it to the team channel at the start of the day.',
    tests: [['test/brief.test.ts', 'reads and writes nothing: the database is the same after a brief']],
  },
  ratefile: {
    title: 'Rate file and patterns', files: 'src/outbound/csv.ts · rateFile.ts · load.ts · patterns.ts · sql/models/v_rate_groups.sql',
    sum: 'Serif\'s public rate export, one CSV row per negotiated rate, is read at start into tables. The two contract forms in it are found by search, not written in by hand.',
    facts: [['Input', 'RATES_CSV. npm run rates:fetch downloads it; the file is public and never committed.'], ['Reloads', 'Only when the file\'s SHA-256, the platform mapping, the registry or the derivation version changes.']],
    sections: [
      { h: 'The two patterns', items: ['The rate card: a whole percent of one base, to the cent.', 'The conversion factor: a whole-dollar multiple of one unit.', 'A pattern needs at least 3 distinct rates; its hit counts and runners-up are stored.'] },
      { h: 'With no file', items: ['The tables are emptied, and the Outbound tab says why and shows the command that fetches it.'] },
    ],
    prod: 'Fetch each new monthly file on a schedule and keep the old ones.',
    tests: [['test/outbound.test.ts', 'loads every row, finds the card and the factor by search, and keeps one finding per group']],
  },
  findings: {
    title: 'One finding per EIN', files: 'src/outbound/findings.ts · linkReview.ts · src/resolve/index.ts (resolveByName)',
    sum: 'For each group: its rate, where that sits against Medicare, which contract form it fits, how it compares with the top rate in its city and the median of its size band.',
    facts: [['Key', 'ein:<EIN>, the file\'s own id for the contracting entity, never its name.'], ['Link', 'Matched to a registry organization by name and state through the router\'s own matcher. Only a unique, strong match links.']],
    sections: [{ h: 'Link review', items: ['A near miss is probable: the best candidate in the group\'s state, when its distinctive name is in the group\'s name or it scores 0.5 or more.', 'A probable link names no organization until a person confirms it in the Outbound tab. Decisions are kept by EIN across reloads, and a person can take one back (Undo), which returns the group to what the loader found.'] }],
    prod: 'Match groups to the CRM\'s own company records before the registry.',
    tests: [['test/outbound-plays.test.ts', 'confirming the probable link puts the group in the system-gap play, with a ready draft, a HubSpot body and an export row'], ['test/outbound-plays.test.ts', 'survives a reload of the rate file, which rebuilds every derived table']],
  },
  plays: {
    title: 'Two plays', files: 'src/outbound/plays.ts · targeting.ts · holds.ts',
    sum: 'Platform: behavioral health platforms from a hand-made mapping, ready only when the mapping is confirmed. System gap, for the Health Systems team: a group that belongs to a hospital or system, has more than 50 clinicians, and is paid at least 20% less than another group in its city.',
    facts: [['Suppressed', 'A group whose account is in the CRM, claimed by a rep, or had a person come in within 90 days. Its status says who has it, and it gets no draft.'], ['Every group', 'Shows its play, or why it is in none.']],
    sections: [{ h: 'Why not the others', items: ['Small independent groups and hospital systems are not platform targets, each with a one-line reason.'] }],
    prod: 'Plays as config the sales team can edit, each with its own test.',
    tests: [['test/outbound-plays.test.ts', 'states its rule once: a hospital or system link, more than 50 clinicians, a group in the city paid 20% more'], ['test/outbound-plays.test.ts', 'an inbound lead with no claim suppresses for 90 days after it came in, and not after']],
  },
  drafts: {
    title: 'Drafts, export and HubSpot', files: 'src/outbound/draft.ts · systemGapDraft.ts · export.ts · src/crm/hubspot.ts (buildOutboundCompanyUpsert)',
    sum: 'A group in a play gets a drafted email and LinkedIn line with every figure inserted by code. Ready drafts export as CSV. A HubSpot company upsert is built for it and never sent.',
    facts: [['Templates', 'Fixed text with no digits in it. Each placeholder is filled from a named field and returned with where it came from.'], ['Export', 'GET /api/outbound/export.csv, one row per ready draft; GET /api/outbound/export counts the rest and why.']],
    sections: [{ h: 'Nothing is sent', items: ['There is no email code in the project.', 'The upsert is never put in the outbox, even with HUBSPOT_LIVE=1.'] }],
    prod: 'A rep adds the contact and sends from their own sequencing tool after review.',
    tests: [['test/outbound.test.ts', 'every number in the subject, email and follow-up was inserted by code, and each insert names its field'], ['test/outbound-plays.test.ts', 'one row per ready draft with every column, quoted so the texts survive a CSV reader']],
  },
  loop: {
    title: 'The loop back into the router', files: 'src/outbound/fact.ts · src/stages.ts (notify)',
    sum: 'When an inbound lead\'s organization has a rate group, the rep brief, the Slack alert and the CRM task carry one line about that group\'s own rate.',
    facts: [['Match', 'The groups linked to the account the lead resolved to, else the groups with the same normalized name in the same state.'], ['Effect', 'None on the score or the route.']],
    sections: [{ h: 'Try it', items: ['With the real rate file loaded, send a test lead with the preset Organization in the rate file. Its trail has a Their rates step with a link to the group.'] }],
    prod: 'List every matching group, not only the largest.',
    tests: [['test/outbound.test.ts', 'the line changes no score and no route, and a lead with no rate group carries none']],
  },
};

/** The boxes in the order a keyboard reaches them on the drawing; every one has an entry above. */
export const NODE_ORDER = Object.keys(TOPO);

/** Every sentence a box can show, for the test that checks the figures in them. */
export function allText(/** @type {Node} */ n) {
  return [n.title, n.sum, ...n.facts.flat(), ...n.sections.flatMap((s) => [s.h, ...s.items]), n.prod];
}
