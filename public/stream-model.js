// The Lead stream's logic with no DOM in it: which leads the filters and the search keep, the count each filter shows, how the list
// sorts, how an uploaded list folds into one group row, and how all of it is written to and read from the address. stream.js
// draws it. Kept apart so test/cockpit-stream.test.ts can run it in Node. Every field comes from GET /api/leads; nothing here
// scores, routes or changes a decision, it only chooses which rows to show and in what order.
import { L, lab, teamName } from './labels.js';
import { isOn, oneOf } from './address-model.js';

/**
 * One row of GET /api/leads (the fields the stream reads).
 * @typedef {{
 *   id: string, receivedAt: string, source: string, status: string,
 *   person: { name: string, title: string | null, email: string | null } | null,
 *   org: { name: string | null, accountId: string | null, segment: string | null, confidence?: string | null },
 *   tier: string | null, score: number | null, routeAction: string | null, routeTeam: string | null, owner: string | null,
 *   useCase: string | null, timeToAlertMs: number | null, flags: string[], list: string | null,
 *   enterprise: boolean, enterpriseFact: string | null, referral: { kind: string, referrer: string } | null,
 *   rule: string | null, dealCue: string | null,
 * }} Lead
 * @typedef {'all' | 'alert' | 'queue' | 'nurture' | 'review' | 'other'} Route
 * @typedef {'received' | 'score' | 'tier' | 'alert' | 'org'} SortKey
 * @typedef {{
 *   route: Route, enterprise: boolean, referral: boolean, referrer: string, tier: string, team: string, door: string,
 *   list: string, account: string, q: string, sort: SortKey, dir: 'asc' | 'desc',
 * }} View
 * @typedef {'route' | 'enterprise' | 'referral' | 'tier' | 'team' | 'door' | 'list'} Facet
 */

/** The route chips, in the order they sit. Each keeps the leads whose route action is one of its actions. */
export const ROUTE_CHIPS = /** @type {const} */ ([
  { key: 'all', label: 'All' }, { key: 'alert', label: 'Rep alerts' }, { key: 'queue', label: 'Queue' },
  { key: 'nurture', label: 'Nurture' }, { key: 'review', label: 'Needs a person' }, { key: 'other', label: 'Other' },
]);

/** @type {Record<Route, (l: Lead) => boolean>} */
export const ROUTES = {
  all: () => true,
  alert: (l) => ['rep_alert', 'owner_task'].includes(l.routeAction ?? ''),
  queue: (l) => l.routeAction === 'team_queue',
  nurture: (l) => l.routeAction === 'nurture',
  review: (l) => l.routeAction === 'review',
  other: (l) => !['rep_alert', 'owner_task', 'team_queue', 'nurture', 'review'].includes(l.routeAction ?? ''),
};

export const TIERS = /** @type {const} */ (['A', 'B', 'C', 'D']);
const TIER_RANK = /** @type {Record<string, number>} */ ({ A: 0, B: 1, C: 2, D: 3, X: 4 });

/** A list folds into one row only when this many of its rows are in the result; fewer show as ordinary rows. */
export const GROUP_MIN = 4;

/**
 * The sortable columns. `first` is the direction a first click gives; `get` is what the column sorts on, and a missing value
 * (null) always sorts last, whichever way the column runs.
 * @type {Record<SortKey, { label: string, first: 'asc' | 'desc', get: (l: Lead) => string | number | null }>}
 */
export const SORTS = {
  received: { label: 'Received', first: 'desc', get: (l) => l.receivedAt },
  score: { label: 'Score', first: 'desc', get: (l) => l.score },
  tier: { label: 'Tier', first: 'asc', get: (l) => (l.tier == null ? null : TIER_RANK[l.tier] ?? 9) },
  alert: { label: 'Time to alert', first: 'desc', get: (l) => l.timeToAlertMs },
  org: { label: 'Organization', first: 'asc', get: (l) => (l.org?.name ? l.org.name.toLowerCase() : null) },
};

/** @returns {View} the view with nothing chosen */
export const defaultView = () => ({
  route: 'all', enterprise: false, referral: false, referrer: '', tier: '', team: '', door: '', list: '', account: '', q: '', sort: 'received', dir: 'desc',
});

// ─── what a filter keeps ─────────────────────────────────────────────────────

/** Everything a person might type, as one lowercase line: the words on the row and the ones behind it. */
export function searchText(/** @type {Lead} */ l) {
  return [
    l.person?.name, l.person?.title, l.person?.email, l.org?.name, lab('source', l.source), lab('segment', l.org?.segment, ''),
    l.owner, teamName(l.routeTeam), lab('action', l.routeAction, ''), l.tier && `tier ${l.tier}`,
    l.list, l.rule, lab('useCase', l.useCase, ''), l.referral?.referrer, l.dealCue, l.enterpriseFact,
    ...l.flags.map((f) => L.flag[f] ?? f.replace(/_/g, ' ')),
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Whether a lead passes the view. `skip` leaves one facet out, which is how a filter's own count is taken: the count beside Tier B is
 * what the list would hold with Tier B chosen and everything else as it is.
 * @param {Lead} l
 * @param {View} v
 * @param {Facet | null} [skip]
 */
export function passes(l, v, skip = null) {
  if (skip !== 'route' && !ROUTES[v.route](l)) return false;
  if (skip !== 'enterprise' && v.enterprise && !l.enterprise) return false;
  if (skip !== 'referral' && v.referral && !l.referral) return false;
  if (v.referrer && l.referral?.referrer !== v.referrer) return false;
  if (skip !== 'tier' && v.tier && l.tier !== v.tier) return false;
  if (skip !== 'team' && v.team && l.routeTeam !== v.team) return false;
  if (skip !== 'door' && v.door && l.source !== v.door) return false;
  if (skip !== 'list' && v.list && (v.list === 'none' ? l.list : l.list !== v.list)) return false;
  if (v.account && l.org?.accountId !== v.account) return false;
  const q = v.q.trim().toLowerCase();
  return !q || searchText(l).includes(q);
}

/** The leads that pass, in the order they came. */
export const visible = (/** @type {Lead[]} */ leads, /** @type {View} */ v) => leads.filter((l) => passes(l, v));

/** @param {Map<string, number>} m @param {string | null | undefined} k */
const bump = (m, k) => { if (k) m.set(k, (m.get(k) ?? 0) + 1); };

/**
 * The count beside every filter option for the current result: how many leads each would leave if it were the one chosen, with the
 * other filters and the search as they are.
 * @param {Lead[]} leads
 * @param {View} v
 */
export function facetCounts(leads, v) {
  /** @type {Record<string, number>} */
  const route = Object.fromEntries(ROUTE_CHIPS.map((c) => [c.key, 0]));
  /** @type {Record<string, number>} */
  const tier = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const team = new Map();
  const door = new Map();
  const list = new Map();
  let enterprise = 0, referral = 0, fromList = 0, notFromList = 0;
  for (const l of leads) {
    if (passes(l, v, 'route')) for (const c of ROUTE_CHIPS) if (ROUTES[c.key](l)) route[c.key]++;
    if (passes(l, v, 'enterprise') && l.enterprise) enterprise++;
    if (passes(l, v, 'referral') && l.referral) referral++;
    if (passes(l, v, 'tier') && l.tier && l.tier in tier) tier[l.tier]++;
    if (passes(l, v, 'team')) bump(team, l.routeTeam);
    if (passes(l, v, 'door')) bump(door, l.source);
    if (passes(l, v, 'list')) { if (l.list) { fromList++; bump(list, l.list); } else notFromList++; }
  }
  return {
    route, enterprise, referral, tier,
    team: [...team].sort((a, b) => a[0].localeCompare(b[0])),
    door: [...door].sort((a, b) => a[0].localeCompare(b[0])),
    list: { all: fromList + notFromList, none: notFromList, byName: [...list].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) },
  };
}

// ─── order ───────────────────────────────────────────────────────────────────

/**
 * Sorted copy. A missing value goes last in either direction, and ties keep newest first, so a click never shuffles rows that tie.
 * @param {Lead[]} leads
 * @param {SortKey} key
 * @param {'asc' | 'desc'} dir
 */
export function sortLeads(leads, key, dir) {
  const col = SORTS[key] ?? SORTS.received;
  const sign = dir === 'asc' ? 1 : -1;
  return [...leads].sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    if (x == null || y == null) return x == null && y == null ? tieBreak(a, b) : x == null ? 1 : -1;
    const by = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sign * by || tieBreak(a, b);
  });
}

const tieBreak = (/** @type {Lead} */ a, /** @type {Lead} */ b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id);

/** The direction a header click gives: the first direction for a new column, the opposite for the one already sorted. */
export function nextSort(/** @type {View} */ v, /** @type {SortKey} */ key) {
  return v.sort === key ? { sort: key, dir: /** @type {'asc' | 'desc'} */ (v.dir === 'asc' ? 'desc' : 'asc') } : { sort: key, dir: SORTS[key].first };
}

// ─── lists folded into one row ───────────────────────────────────────────────

/**
 * @typedef {{ kind: 'group', name: string, rows: number, tiers: [string, number][], newest: string, open: boolean }} GroupRow
 * @typedef {{ kind: 'lead', lead: Lead, inGroup: boolean }} LeadRow
 */

/** Tier counts in tier order: "54 B, 79 C". Leads with no tier yet are left out. */
function tierMix(/** @type {Lead[]} */ rows) {
  const n = new Map();
  for (const l of rows) bump(n, l.tier);
  return [...n].sort((a, b) => (TIER_RANK[a[0]] ?? 9) - (TIER_RANK[b[0]] ?? 9));
}

/**
 * The rows to draw. With the List filter on "all", every uploaded list with GROUP_MIN rows or more in the result is one group row at
 * the place its first row would sit under the current sort; an open group is followed by its rows. With a list chosen, or none,
 * the rows are ordinary rows.
 * @param {Lead[]} sorted the leads that pass, in the order to show them
 * @param {View} v
 * @param {Set<string>} open the lists the person has opened
 * @returns {(GroupRow | LeadRow)[]}
 */
export function rowsWithGroups(sorted, v, open) {
  if (v.list) return sorted.map((lead) => ({ kind: 'lead', lead, inGroup: false }));
  /** @type {Map<string, Lead[]>} */
  const byList = new Map();
  for (const l of sorted) if (l.list) byList.set(l.list, [...(byList.get(l.list) ?? []), l]);
  const folded = new Set([...byList].filter(([, rows]) => rows.length >= GROUP_MIN).map(([name]) => name));
  /** @type {(GroupRow | LeadRow)[]} */
  const out = [];
  const placed = new Set();
  for (const l of sorted) {
    if (!l.list || !folded.has(l.list)) { out.push({ kind: 'lead', lead: l, inGroup: false }); continue; }
    if (placed.has(l.list)) continue;
    placed.add(l.list);
    const rows = /** @type {Lead[]} */ (byList.get(l.list));
    const newest = rows.reduce((a, b) => (a.receivedAt >= b.receivedAt ? a : b)).receivedAt;
    const isOpen = open.has(l.list);
    out.push({ kind: 'group', name: l.list, rows: rows.length, tiers: tierMix(rows), newest, open: isOpen });
    if (isOpen) for (const r of rows) out.push({ kind: 'lead', lead: r, inGroup: true });
  }
  return out;
}

/** "HLTH, 150 rows: 54 B, 79 C, 17 D": a group row in one line. */
export function groupLabel(/** @type {GroupRow} */ g) {
  const mix = g.tiers.map(([t, n]) => `${n} ${t}`).join(', ');
  return `${g.name}, ${g.rows} ${g.rows === 1 ? 'row' : 'rows'}${mix ? `: ${mix}` : ''}`;
}

/** The lists with a lead in the result, as names, so the List filter can offer them. */
export const listNames = (/** @type {Lead[]} */ leads) => [...new Set(leads.flatMap((l) => (l.list ? [l.list] : [])))];

/** The list a lead came in on, when the group holding it is folded, else null: the group to open so the lead shows. */
export function listToOpen(/** @type {Lead[]} */ leads, /** @type {string} */ id) {
  return leads.find((l) => l.id === id)?.list ?? null;
}

// ─── the count line, the active filters, the address ─────────────────────────

/** "12 of 205 leads", with how many lists are folded when some are. */
export function countLine(/** @type {number} */ shown, /** @type {number} */ total, /** @type {number} */ folded = 0) {
  return `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} lead${total === 1 ? '' : 's'}${folded ? ` · ${folded} list${folded === 1 ? '' : 's'} folded` : ''}`;
}

/** Whether anything but the sort narrows the list: what the Clear filters control is for. The search counts. */
export function isFiltered(/** @type {View} */ v) {
  return activeFilters(v).length > 0;
}

/**
 * What is narrowing the list, in words, for the empty message and the removable chips.
 * @param {View} v
 * @param {(key: string) => string} [accountName] the name to show for an account key
 * @returns {{ key: string, label: string }[]}
 */
export function activeFilters(v, accountName = (k) => k) {
  /** @type {{ key: string, label: string }[]} */
  const out = [];
  if (v.route !== 'all') out.push({ key: 'route', label: ROUTE_CHIPS.find((c) => c.key === v.route)?.label ?? v.route });
  if (v.enterprise) out.push({ key: 'enterprise', label: 'Enterprise' });
  if (v.referral) out.push({ key: 'referral', label: 'Referral' });
  if (v.referrer) out.push({ key: 'referrer', label: `Referred by ${v.referrer}` });
  if (v.tier) out.push({ key: 'tier', label: `Tier ${v.tier}` });
  if (v.team) out.push({ key: 'team', label: `Team ${teamName(v.team)}` });
  if (v.door) out.push({ key: 'door', label: `Door ${lab('source', v.door)}` });
  if (v.list) out.push({ key: 'list', label: v.list === 'none' ? 'Not from a list' : `List ${v.list}` });
  if (v.account) out.push({ key: 'account', label: `Account ${accountName(v.account)}` });
  if (v.q.trim()) out.push({ key: 'q', label: `Search "${v.q.trim()}"` });
  return out;
}

/** The view with one filter taken off. */
export function without(/** @type {View} */ v, /** @type {string} */ key) {
  const clear = defaultView();
  return /** @type {View} */ ({ ...v, [key]: clear[/** @type {keyof View} */ (key)] });
}

/** The view with every filter and the search taken off; the sort stays, because it is how a person likes to read. */
export function cleared(/** @type {View} */ v) {
  return { ...defaultView(), sort: v.sort, dir: v.dir };
}

/**
 * The view as address parameters, leaving out whatever is the default, so a plain list is a plain "#stream".
 * @param {View} v
 * @returns {Record<string, string | boolean>}
 */
export function toParams(v) {
  const first = SORTS[v.sort].first;
  return {
    route: v.route === 'all' ? '' : v.route, enterprise: v.enterprise, referral: v.referral, referrer: v.referrer, tier: v.tier, team: v.team,
    door: v.door, list: v.list, account: v.account, q: v.q.trim(),
    sort: v.sort === 'received' ? '' : v.sort, dir: v.dir === first ? '' : v.dir,
  };
}

/**
 * The view an address names. A word the page does not have (a tier E, a route that does not exist) falls back to the default.
 * @param {Record<string, string>} p
 * @returns {View}
 */
export function fromParams(p) {
  const sort = /** @type {SortKey} */ (oneOf(p.sort, Object.keys(SORTS), 'received'));
  return {
    route: /** @type {Route} */ (oneOf(p.route, Object.keys(ROUTES), 'all')),
    enterprise: isOn(p.enterprise), referral: isOn(p.referral) || !!p.referrer, referrer: p.referrer ?? '',
    tier: oneOf(p.tier, TIERS, ''), team: p.team ?? '', door: p.door ?? '', list: p.list ?? '', account: p.account ?? '', q: p.q ?? '',
    sort, dir: /** @type {'asc' | 'desc'} */ (oneOf(p.dir, ['asc', 'desc'], SORTS[sort].first)),
  };
}
