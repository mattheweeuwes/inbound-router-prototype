// The Feature to pipeline tab's logic with no DOM in it: how the API's numbers are worded, which share of the chart each bar gets,
// and the one-line finding. feature-pipeline.js draws it. Kept apart so test/cockpit-feature-pipeline.test.ts can run it in Node.
// Every figure comes from GET /api/attribution. Nothing here recomputes a rate or rounds a count; it formats what was sent. How the two
// tables sort, how the asked list is filtered, and how the view is written to and read from the address are here too.
import { isOn, oneOf } from './address-model.js';

/**
 * @typedef {{ count: number, amount: number }} Tally
 * @typedef {{ won: number, closed: number, rate: number | null }} Rate
 * @typedef {{
 *   id: string, accountKey: string, accountName: string, stage: string, outcome: 'won' | 'lost' | null, amount: number, addOn: string | null,
 *   createdAt: string, closedAt: string | null, uses: number, firstUseInWindow: string, lastUseInWindow: string,
 * }} Deal
 * @typedef {'message' | 'door' | 'path' | 'guide'} Cue
 * @typedef {{
 *   leads: number, accounts: number, salesReady: number, byTier: Record<string, number>, byCue: Record<Cue, number>, sinceLaunch: number | null,
 * }} Interest
 * @typedef {{
 *   leadId: string, accountKey: string | null, accountName: string | null, owner: string | null, customer: boolean, tier: string | null,
 *   person: { name: string, title: string | null } | null, door: string, cue: Cue, cues: Cue[], evidence: string[], quote: string | null, at: string,
 * }} Asked
 * @typedef {{
 *   feature: string, label: string, team: string, status: 'launched' | 'preview', launchedAt: string | null, daysSinceLaunch: number | null,
 *   accountsUsing: number, events: number,
 *   adoption: { accounts: number, of: number, share: number | null },
 *   opportunities: Tally,
 *   byOutcome: { won: Tally, open: Tally, lost: Tally },
 *   winRate: { with: Rate, without: Rate, small: boolean },
 *   firstUseToOpportunity: { medianDays: number | null, deals: number, usedAfterOpen: number },
 *   deals: Deal[],
 *   interest: Interest,
 *   asked: Asked[],
 * }} Feature
 * @typedef {{
 *   account: { key: string, name: string, segment: string | null, owner: string | null },
 *   addOn: { id: string, label: string, priceLow: number, priceHigh: number },
 *   feature: { key: string, label: string },
 *   evidence: { uses: number, people: number, windowFrom: string, windowTo: string, firstUse: string, lastUse: string },
 *   hubspot: { mode: string, requests: unknown[], skipped: string | null },
 * }} Signal
 * @typedef {{
 *   loaded: true, status: string, reason: null, asOf: string,
 *   model: { kind: string, windowDays: number, definition: string, caveat: string, smallSample: number, note: string },
 *   synthetic: {
 *     events: number, deals: number, allSynthetic: boolean, note: string,
 *     interest: { leads: number, synthetic: number, allSynthetic: boolean, note: string },
 *   },
 *   data: {
 *     accounts: number,
 *     events: { total: number, mapped: number, unmapped: number, unresolved: number },
 *     deals: { total: number, open: Tally, won: Tally, lost: Tally, influenced: Tally },
 *     unmappedByName: { event: string, count: number }[],
 *   },
 *   features: Feature[],
 *   expansion: { rule: string, minUses: number, windowDays: number, signals: Signal[] },
 * }} Loaded
 * @typedef {{ loaded: false, status: string, reason: string | null, features: [], signals: [] }} NotLoaded
 */

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** $1,234,000 in full. */
export const money = (/** @type {number} */ n) => `$${Math.round(n).toLocaleString('en-US')}`;

/** $2.19M, $548k or $900: for a tile, where the full figure would not fit. */
export function moneyShort(/** @type {number} */ n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000).toLocaleString('en-US')}k`;
  return `$${Math.round(n)}`;
}

/** A date from an ISO time: 2026-11-06. */
export const day = (/** @type {string} */ iso) => iso.slice(0, 10);

/** The rate as the words a person reads: a whole percent, and the counts it rests on. */
export function rateWords(/** @type {Rate} */ r) {
  if (r.closed === 0 || r.rate === null) return { pct: 'n/a', counts: 'no closed deals' };
  return { pct: `${Math.round(r.rate * 100)}%`, counts: `${r.won} of ${r.closed} closed` };
}

/** "11 of 12 accounts (92%)", or a dash when no account has been active since the launch. */
export function adoptionWords(/** @type {Feature} */ f) {
  if (f.status === 'preview') return { pct: 'n/a', counts: 'not launched' };
  const a = f.adoption;
  if (a.share === null) return { pct: 'n/a', counts: 'no accounts active since launch' };
  return { pct: `${Math.round(a.share * 100)}%`, counts: `${a.accounts} of ${a.of} accounts` };
}

/** Median days from an account's first use to the deal opening, with how many deals it rests on. */
export function leadTimeWords(/** @type {Feature} */ f) {
  const l = f.firstUseToOpportunity;
  if (l.medianDays === null) return { value: 'n/a', counts: l.usedAfterOpen ? `${plural(l.usedAfterOpen, 'deal')} used it only after opening` : 'no deals' };
  const after = l.usedAfterOpen ? `; ${l.usedAfterOpen} used it only after opening` : '';
  return { value: `${Math.round(l.medianDays)} d`, counts: `${plural(l.deals, 'deal')}${after}` };
}

/** What the sample size says about the win-rate comparison, or null when both sides have enough closed deals. */
export function sampleNote(/** @type {Feature} */ f, /** @type {number} */ smallSample) {
  if (!f.winRate.small) return null;
  const w = f.winRate;
  return `Small sample: ${plural(w.with.closed, 'closed deal')} with use, ${plural(w.without.closed, 'closed deal')} without (under ${smallSample} on a side). Do not read this as an effect.`;
}

/**
 * The bar for one feature: how much of the full width each outcome gets, as a percent of the longest bar. Outcomes are drawn
 * won, open, lost; a zero outcome has no segment. `max` is the largest feature total, so the longest bar fills the track.
 * @param {Feature} f
 * @param {number} max
 */
export function barSegments(f, max) {
  const order = /** @type {const} */ (['won', 'open', 'lost']);
  return order
    .map((key) => ({ key, ...f.byOutcome[key], pct: max > 0 ? (100 * f.byOutcome[key].amount) / max : 0 }))
    .filter((s) => s.count > 0);
}

export const OUTCOME_WORDS = { won: 'Closed won', open: 'Open', lost: 'Closed lost' };

/** The one-line finding: how many deals had a tracked feature around them, and which feature touched the most. */
export function headline(/** @type {Loaded} */ d) {
  const t = d.data.deals;
  const top = [...d.features].sort((a, b) => b.opportunities.amount - a.opportunities.amount)[0];
  if (!top || t.total === 0) return 'There are no deals to attribute yet.';
  const first = `${t.influenced.count} of ${plural(t.total, 'deal')} had an account using at least one tracked feature in the ${d.model.windowDays} days before it opened or while it was open.`;
  const second = top.opportunities.count > 0
    ? ` ${top.label} was around the most pipeline: ${plural(top.opportunities.count, 'deal')}, ${money(top.opportunities.amount)}.`
    : '';
  return first + second;
}

/** When the feature launched, or that it has not: a preview has no date to show. */
export const launchWords = (/** @type {Feature} */ f) => (f.launchedAt === null ? 'in preview, no launch date' : `launched ${day(f.launchedAt)}`);

/** The interest column: people who showed interest, with the accounts and sales-ready people behind the count. */
export function interestWords(/** @type {Feature} */ f) {
  const i = f.interest;
  if (i.leads === 0) return { value: '0', counts: 'nobody has asked' };
  return { value: String(i.leads), counts: `${plural(i.accounts, 'account')}, ${i.salesReady} sales-ready` };
}

const CUE_WORDS = /** @type {Record<Cue, string>} */ ({ message: 'in their message', door: 'by the door', path: 'by pages visited', guide: 'by a guide' });
const CUE_ORDER = /** @type {const} */ (['message', 'door', 'path', 'guide']);

/** How the people showed it, in the order of how strong the cue is: "2 in their message, 1 by the door". Empty when nobody did. */
export function cueSummary(/** @type {Feature} */ f) {
  return CUE_ORDER.filter((c) => f.interest.byCue[c] > 0).map((c) => `${f.interest.byCue[c]} ${CUE_WORDS[c]}`).join(', ');
}

/** What an asked-for item says about how the person showed it: the cue in words, then the evidence. */
export const askedHow = (/** @type {Asked} */ a) => `${CUE_WORDS[a.cue]}: ${a.evidence.join('; ')}`;

/** The evidence for an expansion signal, in a sentence. */
export function evidenceWords(/** @type {Signal} */ s) {
  const e = s.evidence;
  return `${plural(e.uses, 'use')} of ${s.feature.label} in the ${d30(e)} days to ${day(e.windowTo)}, by ${plural(e.people, 'person', 'people')}, the last on ${day(e.lastUse)}.`;
}

const d30 = (/** @type {Signal['evidence']} */ e) => Math.round((Date.parse(e.windowTo) - Date.parse(e.windowFrom)) / 86_400_000);

/** "$30,000 to $50,000". */
export const priceRange = (/** @type {Signal['addOn']} */ a) => `${money(a.priceLow)} to ${money(a.priceHigh)}`;

// ─── sorting the features table ──────────────────────────────────────────────

/**
 * The features table's columns. `first` is the direction a first click gives; `get` is what the column sorts on, and a missing value
 * (null: a rate over no closed deals, a median over no deals) always goes last.
 * @type {Record<string, { label: string, first: 'asc' | 'desc', get: (f: Feature) => string | number | null }>}
 */
export const FEATURE_SORTS = {
  feature: { label: 'Feature', first: 'asc', get: (f) => f.label.toLowerCase() },
  accounts: { label: 'Accounts using', first: 'desc', get: (f) => f.accountsUsing },
  deals: { label: 'Deals around it', first: 'desc', get: (f) => f.opportunities.count },
  won: { label: 'Closed won', first: 'desc', get: (f) => f.byOutcome.won.count },
  withRate: { label: 'Win rate with use', first: 'desc', get: (f) => f.winRate.with.rate },
  withoutRate: { label: 'Win rate without', first: 'desc', get: (f) => f.winRate.without.rate },
  days: { label: 'Median days, first use to deal', first: 'asc', get: (f) => f.firstUseToOpportunity.medianDays },
  adoption: { label: 'Adoption since launch', first: 'desc', get: (f) => f.adoption.share },
  interest: { label: 'Interest from inbound', first: 'desc', get: (f) => f.interest.leads },
};

/** The order the table opens in: the API's, which is the feature list as the product has it. */
export const FEATURE_DEFAULT = /** @type {{ key: string, dir: 'asc' | 'desc' }} */ ({ key: '', dir: 'asc' });

/**
 * Sorted copy; with no column chosen, the order the API sent. Ties keep that order, so a click never shuffles rows that tie.
 * @param {Feature[]} features
 * @param {{ key: string, dir: 'asc' | 'desc' }} sort
 */
export function sortFeatures(features, { key, dir }) {
  const col = FEATURE_SORTS[key];
  if (!col) return [...features];
  const sign = dir === 'asc' ? 1 : -1;
  const at = new Map(features.map((f, i) => [f.feature, i]));
  return [...features].sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
    const by = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sign * by || (at.get(a.feature) ?? 0) - (at.get(b.feature) ?? 0);
  });
}

// ─── who asked: filters and order ────────────────────────────────────────────

/** The ways a person can show interest, in the words of the cue filter. */
export const CUE_OPTIONS = /** @type {const} */ ([
  { key: 'message', label: 'In their message' }, { key: 'door', label: 'By the door' }, { key: 'path', label: 'By pages visited' }, { key: 'guide', label: 'By a guide' },
]);

/** @typedef {{ customers: boolean, ready: boolean, cue: '' | Cue }} AskedFilter */

/** Sales-ready is the dashboard's: tier A or B. */
export const isSalesReady = (/** @type {Asked} */ a) => a.tier === 'A' || a.tier === 'B';

/**
 * Whether a person passes. `skip` leaves one filter out, which is how a filter's own count is taken.
 * @param {Asked} a
 * @param {AskedFilter} f
 * @param {keyof AskedFilter | null} [skip]
 */
function askedPasses(a, f, skip = null) {
  if (skip !== 'customers' && f.customers && !a.customer) return false;
  if (skip !== 'ready' && f.ready && !isSalesReady(a)) return false;
  return skip === 'cue' || !f.cue || a.cues.includes(f.cue);
}

/** The people that pass, in the order the API sent them (newest first). */
export const filterAsked = (/** @type {Asked[]} */ asked, /** @type {AskedFilter} */ f) => asked.filter((a) => askedPasses(a, f));

/** The count beside each filter: how many people it would leave with the other filters as they are. */
export function askedCounts(/** @type {Asked[]} */ asked, /** @type {AskedFilter} */ f) {
  const cue = /** @type {Record<Cue, number>} */ ({ message: 0, door: 0, path: 0, guide: 0 });
  let customers = 0;
  let ready = 0;
  for (const a of asked) {
    if (askedPasses(a, f, 'customers') && a.customer) customers++;
    if (askedPasses(a, f, 'ready') && isSalesReady(a)) ready++;
    if (askedPasses(a, f, 'cue')) for (const c of a.cues) cue[c]++;
  }
  return { customers, ready, cue };
}

/** The asked list's sortable columns: when they asked (newest first to start) and the account A to Z. A person with no account goes last. */
export const ASKED_SORTS = /** @type {Record<string, { label: string, first: 'asc' | 'desc', get: (a: Asked) => string | null }>} */ ({
  when: { label: 'When', first: 'desc', get: (a) => a.at },
  account: { label: 'Account', first: 'asc', get: (a) => (a.accountName ? a.accountName.toLowerCase() : null) },
});

/**
 * Sorted copy of the asked list. Ties keep the newest first.
 * @param {Asked[]} asked
 * @param {{ key: string, dir: 'asc' | 'desc' }} sort
 */
export function sortAsked(asked, { key, dir }) {
  const col = ASKED_SORTS[key] ?? ASKED_SORTS.when;
  const sign = dir === 'asc' ? 1 : -1;
  return [...asked].sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    if (x == null || y == null) return x == null && y == null ? b.at.localeCompare(a.at) : x == null ? 1 : -1;
    return sign * x.localeCompare(y) || b.at.localeCompare(a.at) || a.leadId.localeCompare(b.leadId);
  });
}

/** "7 of 13 asked", or the plain count when nothing is filtered. */
export const askedCountLine = (/** @type {number} */ shown, /** @type {number} */ total) => `${shown} of ${total} asked`;

// ─── the address ─────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   feature: string | null, asked: AskedFilter, features: { key: string, dir: 'asc' | 'desc' }, askedSort: { key: string, dir: 'asc' | 'desc' },
 * }} View
 */

/** The view with nothing chosen: no feature picked, nobody filtered, the API's order. */
export const defaultView = () => /** @type {View} */ ({
  feature: null, asked: { customers: false, ready: false, cue: '' }, features: { ...FEATURE_DEFAULT }, askedSort: { key: 'when', dir: 'desc' },
});

/**
 * The view as address parameters: the feature (f), the asked filters, and the two sorts, leaving out what is the default.
 * @param {View} v
 * @returns {Record<string, string | boolean>}
 */
export function toParams(v) {
  const fcol = FEATURE_SORTS[v.features.key];
  return {
    f: v.feature ?? '', customers: v.asked.customers, ready: v.asked.ready, cue: v.asked.cue,
    sort: v.features.key, dir: fcol && v.features.dir === fcol.first ? '' : v.features.key ? v.features.dir : '',
    asort: v.askedSort.key === 'when' ? '' : v.askedSort.key, adir: v.askedSort.dir === ASKED_SORTS[v.askedSort.key].first ? '' : v.askedSort.dir,
  };
}

/** The view an address names; a word the page does not have falls back to the default. */
export function fromParams(/** @type {Record<string, string>} */ p) {
  const sort = oneOf(p.sort, Object.keys(FEATURE_SORTS), '');
  const asort = oneOf(p.asort, Object.keys(ASKED_SORTS), 'when');
  return /** @type {View} */ ({
    feature: p.f || null,
    asked: { customers: isOn(p.customers), ready: isOn(p.ready), cue: oneOf(p.cue, CUE_OPTIONS.map((c) => c.key), '') },
    features: { key: sort, dir: oneOf(p.dir, ['asc', 'desc'], sort ? FEATURE_SORTS[sort].first : 'asc') },
    askedSort: { key: asort, dir: oneOf(p.adir, ['asc', 'desc'], ASKED_SORTS[asort].first) },
  });
}
