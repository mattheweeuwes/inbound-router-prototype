// The Needs a person tab's logic with no DOM in it: how items group under their list, which buttons an item gets, the words
// for a reason and a decision, where focus goes after a decision, and how a decided row reads. review.js draws it. Kept apart
// so test/cockpit-review.test.ts can run it in Node. Every item, outcome and count comes from GET /api/review and the
// decision's response; nothing here decides.

/**
 * @typedef {'use_account' | 'not_for_sales' | 'not_a_buyer' | 'is_buyer'} Decision
 * @typedef {{ accountId: string, name: string, kind: string, state: string | null, score: number }} Candidate
 * @typedef {{
 *   leadId: string, reason: string, kind: 'company' | 'doubt', createdAt: string, receivedAt: string, source: string, synthetic: boolean,
 *   list: string | null, person: string, title: string | null, email: string | null, companyTyped: string | null, org: string | null,
 *   tier: string | null, route: { action: string | null, team: string | null, owner: string | null, rule: string | null, reason: string | null },
 *   candidates: Candidate[], decisions: Decision[], busy: boolean,
 * }} OpenItem
 * @typedef {{
 *   leadId: string, reason: string, decision: string, by: string, note: string | null, at: string, person: string, company: string | null,
 *   list: string | null, outcome: string,
 * }} DecidedItem
 * @typedef {{ demoActions: boolean, open: OpenItem[], decided: DecidedItem[] }} ReviewView
 * @typedef {{ name: string, items: OpenItem[], unplaced: number }} ListGroup
 */

/** The reasons for not a buyer a person picks from; the first is the default. Stored as written. */
export const NOT_BUYER_REASONS = /** @type {const} */ ([
  'a vendor or partner pitch', 'a job seeker', 'a student or researcher', 'spam or a test', 'press or an analyst', 'another reason',
]);

/** The item's question, in a few words, by its reason. */
export const REASON_WORDS = /** @type {Record<string, string>} */ ({
  ambiguous_company: 'Which organization is it?',
  unresolved_company: 'Nobody could place the company',
  llm_only_disqualifier: 'The model doubts it is a buyer (held before any alert)',
  model_doubt_after_alert: 'The model doubts it is a buyer (after the alert went out)',
});

/** A decision in the words its button and the Decided list use. */
export const DECISION_WORDS = /** @type {Record<Decision, string>} */ ({
  use_account: 'Used an account', not_for_sales: 'Sent to nurture', not_a_buyer: 'Not a buyer', is_buyer: 'It is a buyer',
});

/** The sentence shown, and the buttons disabled, when the server takes no decisions. */
export const DEMO_OFF = 'Decisions are off on this server: start it with DEMO_ROUTES=1.';

export const reasonWords = (/** @type {string} */ reason) => REASON_WORDS[reason] ?? reason.replace(/_/g, ' ');

/**
 * Items from one uploaded list read as one thing, under its name, in the order the list's first item arrived; every other
 * item stands on its own. unplaced counts the rows "Send all to nurture" would decide.
 * @param {OpenItem[]} open
 * @returns {{ lists: ListGroup[], single: OpenItem[] }}
 */
export function groupItems(open) {
  /** @type {Map<string, OpenItem[]>} */
  const byList = new Map();
  for (const i of open) if (i.list) byList.set(i.list, [...(byList.get(i.list) ?? []), i]);
  const lists = [...byList.entries()].map(([name, items]) => ({ name, items, unplaced: items.filter(isUnplaced).length }));
  return { lists, single: open.filter((i) => !i.list) };
}

/** An item a list's "Send all to nurture" decides: a company nobody could place, with the lead finished. */
export const isUnplaced = (/** @type {OpenItem} */ i) => i.reason === 'unresolved_company' && !i.busy;

/** The items in the order the page shows them: each list's rows under its heading first, then the others. */
export function displayOrder(/** @type {OpenItem[]} */ open) {
  const { lists, single } = groupItems(open);
  return [...lists.flatMap((l) => l.items), ...single];
}

/**
 * Where focus goes after an item is decided: the next item still open in display order, else the one before it, else
 * nothing (the empty message takes it).
 * @param {string[]} order lead ids in display order, the decided one included
 * @param {string} decidedId
 * @param {Set<string>} done ids already decided, which are skipped
 * @returns {string | null}
 */
export function nextFocus(order, decidedId, done) {
  const i = order.indexOf(decidedId);
  const open = (/** @type {string} */ id) => id !== decidedId && !done.has(id);
  return order.slice(i + 1).find(open) ?? order.slice(0, Math.max(0, i)).reverse().find(open) ?? null;
}

/** The buttons an item gets beside its candidates: one per decision it takes other than choosing an account. */
export function itemButtons(/** @type {OpenItem} */ item) {
  const order = /** @type {Decision[]} */ (['is_buyer', 'not_for_sales', 'not_a_buyer']);
  return order.filter((d) => item.decisions.includes(d)).map((d) => ({ decision: d, label: d === 'not_for_sales' ? 'Send to nurture' : DECISION_WORDS[d] }));
}

/** "Send all 16 to nurture". */
export const nurtureAllLabel = (/** @type {number} */ n) => `Send all ${n} to nurture`;

/**
 * The lead ids the server holds open that the tab has not shown: items that arrived while it was open. The tab does not
 * redraw under a person mid-decision, so it says they are there and lets the person bring them in.
 * @param {string[]} liveIds @param {string[]} shownIds
 */
export const arrivedSince = (liveIds, shownIds) => liveIds.filter((id) => !shownIds.includes(id));

/** "1 more item arrived while this was open." */
export const arrivedLine = (/** @type {number} */ n) => `${n} more item${n === 1 ? '' : 's'} arrived while this was open.`;

/** What the list-wide button reads once it is armed: the second click is the confirmation. */
export const nurtureAllYes = (/** @type {number} */ n) => `Yes, send ${n} to nurture`;

/** The question the list-wide button asks, in the page, before it acts. */
export const nurtureAllConfirm = (/** @type {number} */ n, /** @type {string} */ list) =>
  `Send all ${n} rows from ${list} that nobody could place to marketing's nurture track? Each one is recorded with your name.`;

/** The heading of the open list: "3 items need a person", or that nothing does. */
export function openHeadline(/** @type {number} */ n) {
  if (n === 0) return 'Nothing is waiting for a person right now.';
  return `${n} item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a person`;
}

/** A list heading's count: "16 rows from this list need a person", or that every row is decided. */
export function rowsLeft(/** @type {number} */ n) {
  if (n === 0) return 'every row decided';
  return `${n} row${n === 1 ? '' : 's'} from this list need${n === 1 ? 's' : ''} a person`;
}

/** The Decided list's heading: how many it shows, newest first (the API sends at most the last 20). */
export const decidedHeading = (/** @type {number} */ n) => `Decided, newest first (${n})`;

/** A decided row: what happened, who decided and when (local time). */
export function decidedRow(/** @type {DecidedItem} */ d, /** @type {(iso: string) => string} */ fmt) {
  const what = DECISION_WORDS[/** @type {Decision} */ (d.decision)] ?? d.decision;
  return { person: d.person, company: d.company ?? '', what, outcome: d.outcome, who: d.by, when: fmt(d.at), note: d.note ?? '' };
}

/** The candidate's match, in two decimals, or a dash. */
export const matchText = (/** @type {number | null | undefined} */ s) => (s == null ? '—' : Number(s).toFixed(2));
