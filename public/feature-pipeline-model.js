// The Feature to pipeline tab's logic with no DOM in it: how the API's numbers are worded, which share of the chart each bar gets,
// and the one-line finding. feature-pipeline.js draws it. Kept apart so test/cockpit-feature-pipeline.test.ts can run it in Node.
// Every figure comes from GET /api/attribution. Nothing here recomputes a rate or rounds a count; it formats what was sent.

/**
 * @typedef {{ count: number, amount: number }} Tally
 * @typedef {{ won: number, closed: number, rate: number | null }} Rate
 * @typedef {{
 *   id: string, accountKey: string, accountName: string, stage: string, outcome: 'won' | 'lost' | null, amount: number, addOn: string | null,
 *   createdAt: string, closedAt: string | null, uses: number, firstUseInWindow: string, lastUseInWindow: string,
 * }} Deal
 * @typedef {{
 *   feature: string, label: string, team: string, launchedAt: string, daysSinceLaunch: number, accountsUsing: number, events: number,
 *   adoption: { accounts: number, of: number, share: number | null },
 *   opportunities: Tally,
 *   byOutcome: { won: Tally, open: Tally, lost: Tally },
 *   winRate: { with: Rate, without: Rate, small: boolean },
 *   firstUseToOpportunity: { medianDays: number | null, deals: number, usedAfterOpen: number },
 *   deals: Deal[],
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
 *   synthetic: { events: number, deals: number, allSynthetic: boolean, note: string },
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

/** The evidence for an expansion signal, in a sentence. */
export function evidenceWords(/** @type {Signal} */ s) {
  const e = s.evidence;
  return `${plural(e.uses, 'use')} of ${s.feature.label} in the ${d30(e)} days to ${day(e.windowTo)}, by ${plural(e.people, 'person', 'people')}, the last on ${day(e.lastUse)}.`;
}

const d30 = (/** @type {Signal['evidence']} */ e) => Math.round((Date.parse(e.windowTo) - Date.parse(e.windowFrom)) / 86_400_000);

/** "$30,000 to $50,000". */
export const priceRange = (/** @type {Signal['addOn']} */ a) => `${money(a.priceLow)} to ${money(a.priceHigh)}`;
