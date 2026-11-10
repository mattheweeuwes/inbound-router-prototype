// The Today tab's logic with no DOM in it: the order of the brief's sections, how a figure is worded, where an item opens, and how an
// account's row reads. today.js draws it. Kept apart so test/cockpit-today.test.ts can run it in Node. Every figure comes from
// GET /api/brief and GET /api/accounts; nothing here counts, ranks or decides.

/**
 * @typedef {'overview' | 'stream' | 'review' | 'outbound' | 'feature-pipeline'} Tab
 * @typedef {{ leadId?: string, accountKey?: string, ein?: string, list?: string, feature?: string }} Ids
 * @typedef {{ kind: string, title: string, detail: string, tab: Tab, ids: Ids }} Item
 * @typedef {{ label: string, value: number | null, unit: 'count' | 'ms', tab: Tab }} Figure
 * @typedef {{ id: string, title: string, headline: string, count: number, figures: Figure[], items: Item[], more: number }} Section
 * @typedef {{ generatedAt: string, window: { hours: number, from: string, to: string }, sections: Record<string, Section> }} Brief
 * @typedef {{
 *   key: string, name: string | null, segment: string | null, enterprise: boolean, enterpriseFact: string | null, owner: string | null,
 *   ownerSource: string | null, accountScore: number, topTier: string | null, leads30d: number, contacts30d: number, lastActivityAt: string | null,
 *   referralsIn: number, referralsOut: number, webIntentSignals: number, hasRateFact: boolean, openReviews: number,
 * }} Account
 */

/** The brief's sections in the order the page shows them: what needs a person first, then who is coming in, then the machinery. */
export const SECTION_ORDER = /** @type {const} */ (['needs_person', 'enterprise', 'referrals', 'lists', 'expansion', 'outbound', 'interest', 'health']);

/** The cockpit tab that holds each target, in the words of its tab label. */
export const TAB_LABEL = /** @type {Record<Tab, string>} */ ({
  overview: 'Overview', stream: 'Lead stream', review: 'Needs a person', outbound: 'Outbound', 'feature-pipeline': 'Feature to pipeline',
});

/** The sections in page order, skipping any the API did not send. */
export function sectionsInOrder(/** @type {Brief} */ brief) {
  return SECTION_ORDER.map((id) => brief.sections[id]).filter((s) => !!s);
}

/** "12 ms", "1.4 s" or "no data": a duration figure as it reads in a tile. */
export function msWords(/** @type {number | null} */ ms) {
  if (ms === null) return 'no data';
  const whole = Math.round(ms);
  return whole >= 1000 ? `${(whole / 1000).toFixed(1)} s` : `${whole} ms`;
}

/** A figure's value as it reads in a tile. */
export function figureValue(/** @type {Figure} */ f) {
  if (f.value === null) return 'no data';
  return f.unit === 'ms' ? msWords(f.value) : f.value.toLocaleString('en-US');
}

/** The button text on an item: where it opens. */
export const openLabel = (/** @type {Item} */ item) => `Open in ${TAB_LABEL[item.tab]}`;

/** What the page needs to open an item: the tab and the ids, as one object. */
export const targetOf = (/** @type {Item} */ item) => ({ tab: item.tab, ...item.ids });

/** "2026-11-10 21:30 UTC", or a dash when there is no time. */
export const stamp = (/** @type {string | null} */ iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '—');

/** The word count for a number of things: "1 referral", "3 referrals". */
const count = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An account's signals in a line: the referrals, web intent and open reviews it has, and whether the rate file knows it. */
export function signalsWords(/** @type {Account} */ a) {
  const parts = [];
  if (a.referralsIn) parts.push(`${count(a.referralsIn, 'referral')} in`);
  if (a.referralsOut) parts.push(`${count(a.referralsOut, 'referral')} out`);
  if (a.webIntentSignals) parts.push(`${count(a.webIntentSignals, 'web visit signal')}`);
  if (a.openReviews) parts.push(`${count(a.openReviews, 'open review item')}`);
  if (a.hasRateFact) parts.push('in the rate file');
  return parts.length ? parts.join(', ') : 'none';
}

/** One account as the table shows it. The API sends them ranked, enterprise first, and this keeps that order. */
export function accountRow(/** @type {Account} */ a) {
  return {
    key: a.key,
    name: a.name ?? a.key,
    enterprise: a.enterprise,
    fact: a.enterpriseFact ?? 'no size fact',
    owner: a.owner ? `${a.owner}${a.ownerSource === 'claim' ? ' (claimed)' : ''}` : 'no owner',
    people: a.contacts30d,
    latest: stamp(a.lastActivityAt),
    signals: signalsWords(a),
  };
}

/** The line under the page title: when the brief was made and what it looks back over. */
export const asOfWords = (/** @type {Brief} */ b) => `As of ${stamp(b.generatedAt)}. Lead sections look back ${count(b.window.hours, 'hour')}; the rest are shown as they stand.`;
