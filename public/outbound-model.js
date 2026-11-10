// The Outbound tab's logic with no DOM in it: which groups a filter keeps, how they sort, where each one sits on the chart and
// what the headline says. outbound.js draws it. Kept apart so test/cockpit-outbound.test.ts can run it in Node.
// Every figure comes from GET /api/outbound; nothing here rounds a number up or invents one.

/**
 * @typedef {'card' | 'factor' | 'both' | 'neither'} Form
 * @typedef {{
 *   ein: string, accountKey: string, name: string, city: string, state: string | null, clinicians: number, band: string,
 *   rate: number, medicare: number, pctOfMedicare: number, form: Form, cardTier: number | null, factorMultiple: number | null,
 *   fit: 'target' | 'not_target', fitReason: string, platform: string | null, platformConfirmed: boolean | null,
 *   draftStatus: 'ready' | 'blocked' | 'none', draftReason: string | null, hook: string, registryAccountKey: string | null,
 * }} Group
 * @typedef {{ band: string, groups: number, medianPctOfMedicare: number | null, card: number, factor: number, both: number, neither: number }} Band
 * @typedef {{ value: number, hits: number, distinctRates: number }} Pattern
 * @typedef {{
 *   loaded: true, status: string, reason: null,
 *   file: { path: string, rows: number, groups: number, payer: string, network: string, networkMonth: string, code: string },
 *   patterns: { card: (Pattern & { base: number }) | null, factor: (Pattern & { unit: number }) | null },
 *   summary: { bands: Band[], forms: Record<Form, number>, fit: { target: number, notTarget: number }, drafts: { ready: number, blocked: number } },
 *   groups: Group[],
 * }} Loaded
 * @typedef {{ loaded: false, status: string, reason: string | null, file: { path: string | null }, groups: [] }} NotLoaded
 */

export const FILTER_KEYS = /** @type {const} */ (['targets', 'all', 'card', 'factor']);
/** @typedef {typeof FILTER_KEYS[number]} FilterKey */

/** @type {Record<FilterKey, { label: string, keeps: (g: Group) => boolean }>} */
export const FILTERS = {
  targets: { label: 'Targets', keeps: (g) => g.fit === 'target' },
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
  fit: { label: 'Fit', numeric: false, first: 'asc', get: (g) => fitRank(g) },
};

/** Targets with a ready draft first, then blocked ones, then the rest. */
const fitRank = (/** @type {Group} */ g) => (g.fit === 'target' ? (g.draftStatus === 'ready' ? 0 : 1) : 2);

/** "Card 80%", "Factor ×35", "Card 80% · ×35" or "Neither": the tier or the multiple, which is what the form means for this group. */
export function formLabel(/** @type {Group} */ g) {
  const card = g.cardTier == null ? null : `Card ${g.cardTier}%`;
  const factor = g.factorMultiple == null ? null : `Factor ×${g.factorMultiple}`;
  return [card, factor].filter(Boolean).join(' · ') || 'Neither';
}

/** @param {Group} g */
export function fitLabel(g) {
  if (g.fit !== 'target') return 'Not a target';
  return g.draftStatus === 'ready' ? 'Target · draft ready' : g.draftStatus === 'blocked' ? 'Target · draft blocked' : 'Target';
}

/**
 * The groups a filter, a state and a search keep.
 * @param {Group[]} groups
 * @param {{ filter: FilterKey, state: string, query: string }} want
 */
export function filterGroups(groups, { filter, state, query }) {
  const q = query.trim().toLowerCase();
  const keeps = FILTERS[filter].keeps;
  return groups.filter((g) => keeps(g) && (!state || g.state === state) && (!q || `${g.name} ${g.city} ${g.platform ?? ''} ${g.ein}`.toLowerCase().includes(q)));
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

/** The finding in one line, from the first and last size band's medians. Null when a median is missing. */
export function headline(/** @type {Loaded} */ d) {
  const [small, , large] = d.summary.bands;
  if (!small || !large || small.medianPctOfMedicare == null || large.medianPctOfMedicare == null) return null;
  return `Rates rise with group size: groups with ${bandWords(small.band)} are paid a median of ${small.medianPctOfMedicare}% of Medicare, groups with ${bandWords(large.band)} a median of ${large.medianPctOfMedicare}%.`;
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

  const points = groups.map((g) => ({ ein: g.ein, x: x(g.clinicians), y: y(g.rate), form: g.form, target: g.fit === 'target' }));
  return { width, height, plot, xTicks, yTicks, dividers, bandCaptions, tierLines, medicare: { value: medicare, y: y(medicare) }, points, x, y };
}
