// The Outbound tab's logic with no DOM in it: which groups a filter keeps, how they sort, where each one sits on the chart and
// what the headline says. outbound.js draws it. Kept apart so test/cockpit-outbound.test.ts can run it in Node.
// Every figure comes from GET /api/outbound; nothing here rounds a number up or invents one. The view (play, status, state, search, sort)
// is written to and read from the address here too, so a filtered table is a link.
import { oneOf } from './address-model.js';

/**
 * @typedef {'card' | 'factor' | 'both' | 'neither'} Form
 * @typedef {'platform' | 'system_gap'} Play
 * @typedef {'ready' | 'blocked' | 'suppressed' | 'link_to_confirm' | 'not_target'} Status
 * @typedef {{ accountId: string, name: string, kind: string, state: string | null, score: number }} Candidate
 * @typedef {{ decision: 'confirmed' | 'rejected', accountId: string | null, accountName: string | null, decidedBy: string, note: string | null, decidedAt: string }} Decision
 * @typedef {{
 *   status: 'exact' | 'probable' | 'unlinked' | 'confirmed' | 'rejected', why: string, basis: 'name' | 'score' | null,
 *   accountKey: string | null, accountName: string | null, probable: Candidate | null, decision: Decision | null, ifConfirmed: Play | null,
 * }} Link
 * @typedef {{ by: 'crm' | 'claim' | 'inbound', owner: string, detail: string, accountKey: string, leadId: string | null }} Holder
 * @typedef {{
 *   ein: string, accountKey: string, name: string, city: string, state: string | null, clinicians: number, band: string,
 *   rate: number, medicare: number, pctOfMedicare: number, form: Form, cardTier: number | null, factorMultiple: number | null,
 *   fit: 'target' | 'not_target', fitReason: string, platform: string | null, platformConfirmed: boolean | null,
 *   draftStatus: 'ready' | 'blocked' | 'none', draftReason: string | null, hook: string, registryAccountKey: string | null,
 *   play: Play | null, playReason: string, team: string | null, status: Status, statusReason: string, link: Link, holder: Holder | null,
 * }} Group
 * @typedef {{ band: string, groups: number, medianPctOfMedicare: number | null, card: number, factor: number, both: number, neither: number }} Band
 * @typedef {{ value: number, hits: number, distinctRates: number }} Pattern
 * @typedef {{ name: string, team: string, groups: number, ready: number, blocked: number, suppressed: number }} PlayCount
 * @typedef {{
 *   loaded: true, status: string, reason: null,
 *   file: { path: string, rows: number, groups: number, payer: string, network: string, networkMonth: string, code: string },
 *   patterns: { card: (Pattern & { base: number }) | null, factor: (Pattern & { unit: number }) | null },
 *   summary: {
 *     bands: Band[], forms: Record<Form, number>, fit: { target: number, notTarget: number }, drafts: { ready: number, blocked: number },
 *     plays: Record<Play, PlayCount>, statuses: Record<Status, number>, links: Record<Link['status'], number>,
 *   },
 *   actions: { linkDecisions: boolean, export: string },
 *   groups: Group[],
 * }} Loaded
 * @typedef {{ loaded: false, status: string, reason: string | null, file: { path: string | null }, groups: [] }} NotLoaded
 */

export const FILTER_KEYS = /** @type {const} */ (['in_play', 'platform', 'system_gap', 'all', 'card', 'factor']);
/** @typedef {typeof FILTER_KEYS[number]} FilterKey */

/** @type {Record<FilterKey, { label: string, keeps: (g: Group) => boolean }>} */
export const FILTERS = {
  // a play's group someone already has stays in its play, so its owner can find it; its status says it is not prospected
  in_play: { label: 'In a play', keeps: (g) => g.play !== null },
  platform: { label: 'Platform', keeps: (g) => g.play === 'platform' },
  system_gap: { label: 'System gap', keeps: (g) => g.play === 'system_gap' },
  all: { label: 'All', keeps: () => true },
  // a group that fits both contract forms is on the card and on a factor, as the API's summary counts it
  card: { label: 'On the card', keeps: (g) => g.form === 'card' || g.form === 'both' },
  factor: { label: 'On a factor', keeps: (g) => g.form === 'factor' || g.form === 'both' },
};

/**
 * One column per sortable header. `get` is what the column sorts on; `first` is the direction a first click gives
 * (numbers largest first, words A to Z).
 * @type {Record<string, { label: string, numeric: boolean, first: 'asc' | 'desc', get: (g: Group) => string | number }>}
 */
export const SORTS = {
  name: { label: 'Group', numeric: false, first: 'asc', get: (g) => g.name.toLowerCase() },
  state: { label: 'State', numeric: false, first: 'asc', get: (g) => g.state ?? '' },
  clinicians: { label: 'Clinicians', numeric: true, first: 'desc', get: (g) => g.clinicians },
  rate: { label: 'Rate', numeric: true, first: 'desc', get: (g) => g.rate },
  pct: { label: '% of Medicare', numeric: true, first: 'desc', get: (g) => g.pctOfMedicare },
  form: { label: 'Contract form', numeric: false, first: 'asc', get: (g) => formLabel(g) },
  status: { label: 'Status', numeric: false, first: 'asc', get: (g) => STATUS_ORDER.indexOf(g.status) },
};

/** What a team works first: ready drafts, then blocked ones, links waiting for a person, groups someone has, the rest. */
export const STATUS_ORDER = /** @type {const} */ (['ready', 'blocked', 'link_to_confirm', 'suppressed', 'not_target']);

/** @type {Record<Play, string>} */
export const PLAY_WORDS = { platform: 'Platform', system_gap: 'System gap' };

/** "Card 80%", "Factor ×35", "Card 80% · ×35" or "Neither": the tier or the multiple, which is what the form means for this group. */
export function formLabel(/** @type {Group} */ g) {
  const card = g.cardTier == null ? null : `Card ${g.cardTier}%`;
  const factor = g.factorMultiple == null ? null : `Factor ×${g.factorMultiple}`;
  return [card, factor].filter(Boolean).join(' · ') || 'Neither';
}

/**
 * The status in a few words: "Ready · System gap", "Blocked · Platform", "Suppressed · Jordan has it", "Link to confirm" or
 * "Not a target".
 * @param {Group} g
 */
export function statusLabel(g) {
  const play = g.play ? PLAY_WORDS[g.play] : '';
  if (g.status === 'ready') return `Ready · ${play}`;
  if (g.status === 'blocked') return `Blocked · ${play}`;
  if (g.status === 'suppressed') return `Suppressed · ${g.holder?.owner ?? 'someone'} has it`;
  if (g.status === 'link_to_confirm') return 'Link to confirm';
  return 'Not a target';
}

/**
 * The work tiles: drafts ready by play, groups someone already has, and links waiting for a person. Every count is the API's.
 * @param {Loaded} d
 */
export function workCounts(d) {
  const p = d.summary.plays;
  return {
    ready: { platform: p.platform.ready, system_gap: p.system_gap.ready, total: d.summary.statuses.ready },
    suppressed: d.summary.statuses.suppressed,
    linksWaiting: d.summary.links.probable,
  };
}

/**
 * What confirming a probable link would do, which is how the panel orders them: 0 puts the group in a play, 1 links an organization
 * whose name is in the group's name, 2 is a score and nothing more.
 * @param {Group} g
 */
export function linkValue(g) {
  if (g.link.ifConfirmed) return 0;
  return g.link.basis === 'name' ? 1 : 2;
}

/** What each value of linkValue says, for the tag on a row. */
export const LINK_VALUE_WORDS = ['Would put the group in a play', 'Its name is in the group’s name', 'Score only'];

/**
 * The probable links a person should look at, most useful first: those that would put the group in a play, then those where the
 * organization's name is contained in the group's name, then the ones that rest on a score alone. Within each, the largest group.
 * @param {Group[]} groups
 */
export function linksToConfirm(groups) {
  return groups.filter((g) => g.link.status === 'probable' && g.link.probable)
    .sort((a, b) => linkValue(a) - linkValue(b) || b.clinicians - a.clinicians || a.ein.localeCompare(b.ein));
}

/** What confirming this link does, in a sentence. */
export function confirmWords(/** @type {Group} */ g) {
  return g.link.ifConfirmed ? `Confirming puts it in the ${PLAY_WORDS[g.link.ifConfirmed]} play` : 'Confirming links it to the organization; it stays in no play';
}

/** How many links show before the person opens the rest: every one whose confirmation would put its group in a play, and at least one. */
export const firstLinks = (/** @type {Group[]} */ probable) => Math.max(1, probable.filter((g) => g.link.ifConfirmed).length);

/**
 * The panel's rows. The links worth a person's minute show first (the ones that would put a group in a play, which the order
 * already brings to the top); the rest wait behind one control. A decision made here stays in the place its row was, as a
 * one-line notice, so nothing below it moves. `lines` carry the index the row had when it was decided.
 * @template {{ index: number }} L
 * @param {Group[]} probable the links still waiting, in order
 * @param {L[]} lines the decisions made in this visit
 * @param {boolean} all whether the person asked for every link
 * @returns {Array<{ kind: 'link', group: Group } | { kind: 'line', line: L }>}
 */
export function panelRows(probable, lines, all) {
  const shown = all ? probable : probable.slice(0, firstLinks(probable));
  /** @type {Array<{ kind: 'link', group: Group } | { kind: 'line', line: L }>} */
  const out = shown.map((group) => ({ kind: 'link', group }));
  for (const line of [...lines].sort((a, b) => a.index - b.index)) out.splice(Math.min(line.index, out.length), 0, { kind: 'line', line });
  return out;
}

/**
 * What the table is narrowed by: a play or form chip, a status chip (empty for none), a state and a search.
 * @typedef {{ filter: FilterKey, state: string, query: string, status?: Status | '' }} Want
 */

/**
 * The groups a filter, a status, a state and a search keep.
 * @param {Group[]} groups
 * @param {Want} want
 */
export function filterGroups(groups, { filter, state, query, status = '' }) {
  const q = query.trim().toLowerCase();
  const keeps = FILTERS[filter].keeps;
  return groups.filter((g) => keeps(g) && (!status || g.status === status) && (!state || g.state === state) && (!q || `${g.name} ${g.city} ${g.platform ?? ''} ${g.ein}`.toLowerCase().includes(q)));
}

/** The status chips, in the order a team works them, with the word each uses in the address ("link" for a link to confirm). */
export const STATUS_CHIPS = /** @type {const} */ ([
  { key: 'ready', label: 'Ready', word: 'ready' },
  { key: 'blocked', label: 'Blocked', word: 'blocked' },
  { key: 'suppressed', label: 'Suppressed', word: 'suppressed' },
  { key: 'link_to_confirm', label: 'Link to confirm', word: 'link' },
  { key: 'not_target', label: 'Not a target', word: 'not_target' },
]);

/** The status an address word names, or '' for none. */
export const statusOfWord = (/** @type {string | undefined} */ word) => STATUS_CHIPS.find((c) => c.word === word)?.key ?? '';

/** The address word for a status ('' for none). */
export const wordOfStatus = (/** @type {Status | ''} */ status) => STATUS_CHIPS.find((c) => c.key === status)?.word ?? '';

/**
 * The count beside every chip for the current result: how many groups each would leave with the other chips, the state and the search
 * as they are.
 * @param {Group[]} groups
 * @param {Want} want
 */
export function chipCounts(groups, want) {
  const filter = /** @type {Record<FilterKey, number>} */ (Object.fromEntries(FILTER_KEYS.map((k) => [k, filterGroups(groups, { ...want, filter: k }).length])));
  const status = /** @type {Record<Status, number>} */ (Object.fromEntries(STATUS_CHIPS.map((c) => [c.key, filterGroups(groups, { ...want, status: c.key }).length])));
  return { filter, status };
}

/**
 * The want after a status chip is clicked: the chip turns on, or off when it was on. A status can sit outside the chosen play (a link
 * to confirm is in no play yet), so a pick that would leave the table empty widens the play chip to All instead.
 * @param {Want} want
 * @param {Status} status
 * @param {Group[]} groups
 * @returns {Want}
 */
export function pickStatus(want, status, groups) {
  if (want.status === status) return { ...want, status: '' };
  const next = { ...want, status };
  if (!filterGroups(groups, next).length && filterGroups(groups, { ...next, filter: 'all' }).length) return { ...next, filter: 'all' };
  return next;
}

/**
 * Sorted copy. Equal values keep a fixed order (name, then EIN), so a click never shuffles rows that tie.
 * @param {Group[]} groups
 * @param {{ key: string, dir: 'asc' | 'desc' }} sort
 */
export function sortGroups(groups, { key, dir }) {
  const col = SORTS[key] ?? SORTS.name;
  const sign = dir === 'asc' ? 1 : -1;
  return [...groups].sort((a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    const by = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sign * by || a.name.localeCompare(b.name) || a.ein.localeCompare(b.ein);
  });
}

/** The states in the file, A to Z, with how many groups each has. */
export function statesOf(/** @type {Group[]} */ groups) {
  const n = new Map();
  for (const g of groups) if (g.state) n.set(g.state, (n.get(g.state) ?? 0) + 1);
  return [...n].sort((a, b) => a[0].localeCompare(b[0]));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "UnitedHealthcare Choice Plus, code 90837, August 2026" from the file's scope. */
export function fileTitle(/** @type {Loaded['file']} */ f) {
  const month = MONTHS[Number(f.networkMonth.slice(4, 6)) - 1] ?? f.networkMonth;
  return `${f.payer} ${f.network}, code ${f.code}, ${month} ${f.networkMonth.slice(0, 4)}`;
}

/** "1-50" is "1 to 50 clinicians"; "501+" is "over 500". */
export function bandWords(/** @type {string} */ band) {
  const over = band.match(/^(\d+)\+$/);
  if (over) return `over ${Number(over[1]) - 1} clinicians`;
  const [lo, hi] = band.split('-');
  return lo === '1' ? `${hi} or fewer clinicians` : `${lo} to ${hi} clinicians`;
}

/**
 * The finding in one line, as the take-home states it: how many of the smallest groups sit on the one rate card, and the
 * gap between the smallest and largest bands' medians. Every figure is the API's. With no card pattern, or no small group
 * on it, it is the medians alone. Null when a median is missing.
 */
export function headline(/** @type {Loaded} */ d) {
  const [small, , large] = d.summary.bands;
  if (!small || !large || small.medianPctOfMedicare == null || large.medianPctOfMedicare == null) return null;
  const top = `Groups with ${bandWords(large.band)} sit at a median of ${large.medianPctOfMedicare}%.`;
  const card = d.patterns.card;
  if (!card || !small.card) return `Groups with ${bandWords(small.band)} are paid a median of ${small.medianPctOfMedicare}% of Medicare. ${top}`;
  return `Of the ${small.groups} groups with ${bandWords(small.band)}, ${small.card} are paid a whole percent of one $${card.base.toFixed(2)} base, and the band's median is ${small.medianPctOfMedicare}% of Medicare. ${top}`;
}

/** Counts for the stat tiles: groups on the card and on a factor (a group on both is in both), and either. */
export function formCounts(/** @type {Loaded} */ d) {
  const f = d.summary.forms;
  return { card: f.card + f.both, factor: f.factor + f.both, both: f.both, either: f.card + f.factor + f.both };
}

export const median = (/** @type {number[]} */ xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ─── the chart ───────────────────────────────────────────────────────────────

/** Fewest pixels between two tier labels on the right edge. */
const LABEL_GAP = 12;

/**
 * Where everything on the rate-against-size chart sits, in pixels, for a given drawing size. x is clinicians on a log scale,
 * y is the rate in dollars. Pure: groups and patterns in, coordinates out.
 * @param {Group[]} groups
 * @param {Loaded['patterns']['card']} card
 * @param {Band[]} bands
 * @param {{ width: number, height: number }} size
 */
export function chartGeometry(groups, card, bands, { width, height }) {
  const narrow = width < 560;
  const pad = narrow ? { top: 50, right: 36, bottom: 48, left: 44 } : { top: 52, right: 44, bottom: 52, left: 56 };
  const plot = { x0: pad.left, x1: width - pad.right, y0: pad.top, y1: height - pad.bottom };

  const xMin = 0.7;
  const xMax = 10 ** Math.ceil(Math.log10(Math.max(10, ...groups.map((g) => g.clinicians))));
  const rates = groups.map((g) => g.rate);
  const yMin = Math.floor((Math.min(...rates) - 5) / 25) * 25;
  const yMax = Math.ceil(Math.max(...rates) / 50) * 50;
  const x = (/** @type {number} */ clinicians) => plot.x0 + ((Math.log10(clinicians) - Math.log10(xMin)) / (Math.log10(xMax) - Math.log10(xMin))) * (plot.x1 - plot.x0);
  const y = (/** @type {number} */ rate) => plot.y1 - ((rate - yMin) / (yMax - yMin)) * (plot.y1 - plot.y0);

  const xTicks = [1, 10, 100, 1000, 10000].filter((t) => t <= xMax).map((t) => ({ value: t, x: x(t) }));
  const yTicks = [];
  for (let v = Math.ceil(yMin / 50) * 50; v <= yMax; v += 50) yTicks.push({ value: v, y: y(v) });

  // the size bands: a divider between each pair (the upper bound of the band before it, plus half a clinician) and a centered caption
  const uppers = bands.slice(0, -1).map((b) => Number(b.band.split('-')[1]));
  const edges = [xMin, ...uppers.map((u) => u + 0.5), xMax];
  const bandCaptions = bands.map((b, i) => ({
    band: b.band, median: b.medianPctOfMedicare, groups: b.groups, x: (x(edges[i]) + x(edges[i + 1])) / 2,
  }));
  const dividers = uppers.map((u) => ({ at: u, x: x(u + 0.5) }));

  // the card's tiers: one dotted line per tier a group sits on, at base x tier. A label is skipped when it would touch the one above.
  const base = card ? card.base : 0;
  const tiers = card ? [.../** @type {Set<number>} */ (new Set(groups.map((g) => g.cardTier).filter((t) => t != null)))].sort((a, b) => b - a) : [];
  let lastLabelY = -Infinity;
  const tierLines = tiers.map((tier) => {
    const yy = y((base * tier) / 100);
    const labelled = yy - lastLabelY >= LABEL_GAP;
    if (labelled) lastLabelY = yy;
    return { tier, y: yy, labelled };
  });

  // Medicare's 100% line: the median of the groups' own baselines, because the baseline varies a little by locality
  const medicare = median(groups.map((g) => g.medicare));

  const points = groups.map((g) => ({ ein: g.ein, x: x(g.clinicians), y: y(g.rate), form: g.form, target: g.play !== null }));
  return { width, height, plot, xTicks, yTicks, dividers, bandCaptions, tierLines, medicare: { value: medicare, y: y(medicare) }, points, x, y };
}

// ─── the address ─────────────────────────────────────────────────────────────

/**
 * The table's view as address parameters, leaving out what is the default. With a status chosen the play defaults to All, because a
 * status such as a link to confirm sits outside the plays.
 * @param {Want} want
 * @param {{ key: string, dir: 'asc' | 'desc' }} sort
 * @returns {Record<string, string>}
 */
export function toParams(want, sort) {
  const status = want.status ?? '';
  const playDefault = status ? 'all' : 'in_play';
  const col = SORTS[sort.key];
  return {
    status: wordOfStatus(status), play: want.filter === playDefault ? '' : want.filter, state: want.state, q: want.query.trim(),
    sort: sort.key === DEFAULT_SORT.key ? '' : sort.key, dir: col && sort.dir === col.first ? '' : sort.dir,
  };
}

/** The sort the table opens on: the largest groups first. */
export const DEFAULT_SORT = /** @type {{ key: string, dir: 'asc' | 'desc' }} */ ({ key: 'clinicians', dir: 'desc' });

/**
 * The view an address names. A word the table does not have falls back to the default, so a hand-edited address cannot break the page.
 * @param {Record<string, string>} p
 * @returns {{ want: Required<Want>, sort: { key: string, dir: 'asc' | 'desc' } }}
 */
export function fromParams(p) {
  const status = statusOfWord(p.status);
  const key = oneOf(p.sort, Object.keys(SORTS), DEFAULT_SORT.key);
  return {
    want: { status, filter: /** @type {FilterKey} */ (oneOf(p.play, FILTER_KEYS, status ? 'all' : 'in_play')), state: p.state ?? '', query: p.q ?? '' },
    sort: { key, dir: /** @type {'asc' | 'desc'} */ (oneOf(p.dir, ['asc', 'desc'], SORTS[key].first)) },
  };
}
