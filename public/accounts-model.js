// The accounts table's logic with no DOM in it: which accounts the filters and the search keep, how the columns sort, how many rows
// show, and how the view is written to and read from the address. Today's accounts section draws it (accounts.js). Every figure comes
// from GET /api/accounts; nothing here scores an account or decides who owns it.
import { isOn, oneOf } from './address-model.js';
import { signalsWords } from './today-model.js';

/**
 * @typedef {import('./today-model.js').Account} Account
 * @typedef {'rank' | 'name' | 'owner' | 'people' | 'latest' | 'score'} SortKey
 * @typedef {{ enterprise: boolean, noOwner: boolean, referral: boolean, q: string, sort: SortKey, dir: 'asc' | 'desc', shown: number }} View
 */

/** Rows shown at first, and how many more each "Show more" adds. */
export const FIRST_ROWS = 25;
export const MORE_ROWS = 50;

/**
 * The sortable columns. `rank` is the order the API sends (enterprise first, then the account score), which is where the table starts.
 * A missing value goes last in either direction.
 * @type {Record<SortKey, { label: string, first: 'asc' | 'desc', get: (a: Account) => string | number | null }>}
 */
export const SORTS = {
  rank: { label: 'Ranked', first: 'asc', get: () => 0 },
  name: { label: 'Account', first: 'asc', get: (a) => (a.name ?? a.key).toLowerCase() },
  owner: { label: 'Owner', first: 'asc', get: (a) => (a.owner ? a.owner.toLowerCase() : null) },
  people: { label: 'People in', first: 'desc', get: (a) => a.contacts30d },
  latest: { label: 'Latest activity', first: 'desc', get: (a) => a.lastActivityAt },
  score: { label: 'Score', first: 'desc', get: (a) => a.accountScore },
};

/** @returns {View} the table as it opens: ranked, nothing filtered, the first rows */
export const defaultView = () => ({ enterprise: false, noOwner: false, referral: false, q: '', sort: 'rank', dir: 'asc', shown: FIRST_ROWS });

/** Whether an account has a referral in or out: the "has a referral" filter. */
export const hasReferral = (/** @type {Account} */ a) => a.referralsIn > 0 || a.referralsOut > 0;

/** Everything a person might type, as one lowercase line. */
const searchText = (/** @type {Account} */ a) => [a.name, a.key, a.enterpriseFact, a.owner, a.segment?.replace(/_/g, ' '), signalsWords(a)].filter(Boolean).join(' ').toLowerCase();

/**
 * Whether an account passes. `skip` leaves one filter out, which is how a filter's own count is taken.
 * @param {Account} a
 * @param {View} v
 * @param {'enterprise' | 'noOwner' | 'referral' | null} [skip]
 */
export function passes(a, v, skip = null) {
  if (skip !== 'enterprise' && v.enterprise && !a.enterprise) return false;
  if (skip !== 'noOwner' && v.noOwner && a.owner) return false;
  if (skip !== 'referral' && v.referral && !hasReferral(a)) return false;
  const q = v.q.trim().toLowerCase();
  return !q || searchText(a).includes(q);
}

/** The accounts that pass, in the order the API sent them. */
export const visible = (/** @type {Account[]} */ accounts, /** @type {View} */ v) => accounts.filter((a) => passes(a, v));

/** The count beside each filter: what the table would hold with that filter on and the others as they are. */
export function counts(/** @type {Account[]} */ accounts, /** @type {View} */ v) {
  const n = { enterprise: 0, noOwner: 0, referral: 0 };
  for (const a of accounts) {
    if (passes(a, v, 'enterprise') && a.enterprise) n.enterprise++;
    if (passes(a, v, 'noOwner') && !a.owner) n.noOwner++;
    if (passes(a, v, 'referral') && hasReferral(a)) n.referral++;
  }
  return n;
}

/**
 * Sorted copy. "Ranked" keeps the API's order as it is. Ties keep the API's order too, so a click never shuffles rows that tie.
 * @param {Account[]} accounts
 * @param {SortKey} key
 * @param {'asc' | 'desc'} dir
 */
export function sortAccounts(accounts, key, dir) {
  if (key === 'rank') return [...accounts];
  const col = SORTS[key];
  const sign = dir === 'asc' ? 1 : -1;
  const at = new Map(accounts.map((a, i) => [a.key, i]));
  return [...accounts].sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
    const by = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sign * by || (at.get(a.key) ?? 0) - (at.get(b.key) ?? 0);
  });
}

/** The direction a header click gives: the column's first direction when it is new, the opposite when it is already sorted. */
export function nextSort(/** @type {View} */ v, /** @type {SortKey} */ key) {
  return v.sort === key ? { sort: key, dir: /** @type {'asc' | 'desc'} */ (v.dir === 'asc' ? 'desc' : 'asc') } : { sort: key, dir: SORTS[key].first };
}

/** "12 of 158 accounts". */
export const countLine = (/** @type {number} */ shown, /** @type {number} */ total) => `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} account${total === 1 ? '' : 's'}`;

/** Rows to draw now, and how many more a "Show more" adds (zero when everything shows). */
export function page(/** @type {number} */ matching, /** @type {number} */ shown) {
  const rows = Math.min(shown, matching);
  return { rows, more: Math.min(MORE_ROWS, matching - rows), left: matching - rows };
}

/** Whether anything narrows the table: what the Clear filters control is for. */
export const isFiltered = (/** @type {View} */ v) => v.enterprise || v.noOwner || v.referral || v.q.trim() !== '';

/** The view with every filter and the search off; the sort stays. */
export const cleared = (/** @type {View} */ v) => ({ ...defaultView(), sort: v.sort, dir: v.dir });

/** What is narrowing the table, in words, for the empty message. */
export function activeWords(/** @type {View} */ v) {
  return [v.enterprise && 'Enterprise only', v.noOwner && 'No owner', v.referral && 'Has a referral', v.q.trim() && `Search "${v.q.trim()}"`].filter(Boolean);
}

/**
 * The view as address parameters, leaving out what is the default.
 * @param {View} v
 * @returns {Record<string, string | boolean>}
 */
export function toParams(v) {
  return { enterprise: v.enterprise, noowner: v.noOwner, referral: v.referral, q: v.q.trim(), sort: v.sort === 'rank' ? '' : v.sort, dir: v.sort === 'rank' || v.dir === SORTS[v.sort].first ? '' : v.dir };
}

/** The view an address names; a word the table does not have falls back to the default. */
export function fromParams(/** @type {Record<string, string>} */ p) {
  const sort = /** @type {SortKey} */ (oneOf(p.sort, Object.keys(SORTS), 'rank'));
  return /** @type {View} */ ({
    enterprise: isOn(p.enterprise), noOwner: isOn(p.noowner), referral: isOn(p.referral), q: p.q ?? '', sort,
    dir: oneOf(p.dir, ['asc', 'desc'], SORTS[sort].first), shown: FIRST_ROWS,
  });
}
