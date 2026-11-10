// The Today tab's logic with no DOM in it: the order of the brief's sections, how a figure is worded, where an item opens, and how an
// account's row reads. today.js draws it. Kept apart so test/cockpit-today.test.ts can run it in Node. Every figure comes from
// GET /api/brief and GET /api/accounts; nothing here counts, ranks or decides. Where a row opens is an address (address-model.js), so
// every "Open in ..." is a link a person can copy.
import { buildAddress } from './address-model.js';

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

/** "12 ms", "1.4 s", "17 min", "2 h 10 min" or "no data": a duration figure as it reads in a tile. */
export function msWords(/** @type {number | null} */ ms) {
  if (ms === null) return 'no data';
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole} ms`;
  if (whole < 60_000) return `${(whole / 1000).toFixed(1)} s`;
  const minutes = Math.floor(whole / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}` : `${minutes} min`;
}

/** A figure's value as it reads in a tile. */
export function figureValue(/** @type {Figure} */ f) {
  if (f.value === null) return 'no data';
  return f.unit === 'ms' ? msWords(f.value) : f.value.toLocaleString('en-US');
}

/** How many rows a section shows before the person opens it up; the API sends up to ten and says how many more there are. */
export const TOP_ROWS = 3;

/**
 * Where an item opens: the tab and its address parameters. A lead and a review item open by lead, a group by EIN, a feature by its key,
 * and an uploaded list opens the Lead stream with that list chosen, where its rows are.
 * @param {Item} item
 * @returns {{ tab: Tab, params: Record<string, string> }}
 */
export function targetOf(item) {
  const d = item.ids;
  if (d.list) return { tab: 'stream', params: { list: d.list } };
  if (item.tab === 'stream' && d.leadId) return { tab: 'stream', params: { lead: d.leadId } };
  if (item.tab === 'review' && d.leadId) return { tab: 'review', params: { lead: d.leadId } };
  if (item.tab === 'outbound' && d.ein) return { tab: 'outbound', params: { ein: d.ein } };
  if (item.tab === 'feature-pipeline' && d.feature) return { tab: 'feature-pipeline', params: { f: d.feature } };
  return { tab: item.tab, params: {} };
}

/** The address an item's link points at. */
export const addressOf = (/** @type {Item} */ item) => { const t = targetOf(item); return buildAddress(t.tab, t.params); };

/** The button text on an item: where it opens. */
export const openLabel = (/** @type {Item} */ item) => `Open in ${TAB_LABEL[targetOf(item).tab]}`;

/**
 * The rows a section shows: its first TOP_ROWS, or all it was sent when the person has opened it up.
 * @param {Section} s
 * @param {boolean} open
 */
export const rowsShown = (s, open) => (open ? s.items : s.items.slice(0, TOP_ROWS));

/** How many rows "Show all" would add: the rows sent beyond the top ones. */
export const rowsHidden = (/** @type {Section} */ s) => Math.max(0, s.items.length - TOP_ROWS);

/**
 * Where "and N more" goes: the tab that holds the rest, with the filter that matches what the section counts. A section whose rows
 * are of two kinds (links to confirm, then suppressed groups) points at the kind the list ran into last.
 * @param {Section} s
 * @returns {{ tab: Tab, params: Record<string, string>, words: string }}
 */
export function moreTarget(s) {
  const last = s.items[s.items.length - 1]?.kind;
  /** @type {Record<string, { tab: Tab, params: Record<string, string>, words: string }>} */
  const by = {
    needs_person: last === 'SLA clock' ? { tab: 'stream', params: {}, words: 'the Lead stream' } : { tab: 'review', params: {}, words: 'Needs a person' },
    enterprise: { tab: 'stream', params: { enterprise: '1' }, words: 'the Lead stream, enterprise only' },
    referrals: { tab: 'stream', params: { referral: '1' }, words: 'the Lead stream, referrals only' },
    lists: { tab: 'overview', params: {}, words: 'the Overview' },
    expansion: { tab: 'feature-pipeline', params: {}, words: 'Feature to pipeline' },
    outbound: last === 'suppressed' ? { tab: 'outbound', params: { status: 'suppressed' }, words: 'Outbound, suppressed groups' } : { tab: 'outbound', params: { status: 'link' }, words: 'Outbound, links to confirm' },
    interest: { tab: 'feature-pipeline', params: {}, words: 'Feature to pipeline' },
    health: { tab: 'stream', params: {}, words: 'the Lead stream' },
  };
  return by[s.id] ?? { tab: 'overview', params: {}, words: 'the Overview' };
}

/** The address "and N more" points at. */
export const moreAddress = (/** @type {Section} */ s) => { const t = moreTarget(s); return buildAddress(t.tab, t.params); };

/** The entries of the page's index: each section with its count, then the accounts table with the number of accounts. */
export function indexEntries(/** @type {Brief} */ brief, /** @type {number} */ accountTotal) {
  return [...sectionsInOrder(brief).map((s) => ({ id: s.id, label: s.title, count: s.count })), { id: 'accounts', label: 'Accounts', count: accountTotal }];
}

/** "2026-11-10 21:30 UTC", or a dash when there is no time: the exact time a local time carries on hover. */
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
    latestAt: a.lastActivityAt,
    signals: signalsWords(a),
  };
}

/** What the sections look back over: said after "As of <time>.", where the time is printed as a local time with the UTC time on hover. */
export const lookbackWords = (/** @type {Brief} */ b) => {
  const h = b.window.hours;
  // a window of whole days longer than one day reads in days: "14 days", not "336 hours"
  return `Lead sections look back ${h > 24 && h % 24 === 0 ? count(h / 24, 'day') : count(h, 'hour')}; the rest are shown as they stand.`;
};
