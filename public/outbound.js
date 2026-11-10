// The Outbound tab: Serif's public rate file read as a sales story. It draws GET /api/outbound (the finding, a chart of every
// group's rate against its size, a filterable table) and GET /api/outbound/<ein> (one group's facts, source rows, registry link,
// the drafted email and LinkedIn line with every inserted figure marked, and the dry-run HubSpot request).
// Read-only: nothing on this tab sends anything. The logic with no DOM in it is in outbound-model.js.
import {
  FILTERS, FILTER_KEYS, SORTS, chartGeometry, fileTitle, filterGroups, fitLabel, formCounts, formLabel, headline, sortGroups, statesOf,
} from './outbound-model.js';

/**
 * What app.js hands over: its API reader (live API or sample files) and its JSON highlighter.
 * @typedef {{ getJSON: (path: string) => Promise<any>, jsonHTML: (v: unknown) => string }} Host
 * @typedef {import('./outbound-model.js').Group} Group
 * @typedef {import('./outbound-model.js').Loaded} Loaded
 * @typedef {import('./outbound-model.js').NotLoaded} NotLoaded
 * @typedef {{ text: string, placeholder?: string, open?: boolean }} Part
 */

// ─── small helpers ───────────────────────────────────────────────────────────

const esc = (/** @type {unknown} */ v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[/** @type {string} */ (c)] ?? c));
const usd = (/** @type {number} */ n) => `$${n.toFixed(2)}`;
const nf = (/** @type {number | null | undefined} */ n) => (n == null ? '—' : n.toLocaleString('en-US'));
const sentenceCase = (/** @type {string} */ t) => t.charAt(0).toUpperCase() + t.slice(1);
const place = (/** @type {Group} */ g) => [g.city, g.state].filter(Boolean).join(', ');

/** The narrow layout opens a group's detail as a full-screen sheet; the wide one keeps it beside the table. */
const NARROW = '(max-width: 900px)';
const isNarrow = () => window.matchMedia(NARROW).matches;

/** @param {string} id */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the page`);
  return el;
}

const HOOK_WORDS = { hospital_leverage: 'Hospital leverage', rate_range: 'Rate range' };

// ─── state ───────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   status: 'idle' | 'loading' | 'ready' | 'error',
 *   error: string,
 *   data: Loaded | NotLoaded | null,
 *   filter: import('./outbound-model.js').FilterKey,
 *   state: string,
 *   query: string,
 *   sort: { key: string, dir: 'asc' | 'desc' },
 *   selected: string | null,
 *   sheetOpen: boolean,
 *   details: Map<string, any>,
 *   detailError: string,
 * }} State
 */
/** @type {State} */
const S = {
  status: 'idle', error: '', data: null, filter: 'targets', state: '', query: '', sort: { key: 'clinicians', dir: 'desc' },
  selected: null, sheetOpen: false, details: new Map(), detailError: '',
};

/** @type {Host} */
let host;
let chartWidth = 0;
/** The read in flight, so a second caller (a jump from a lead) waits for it instead of finding no data. */
let reading = Promise.resolve();

// ─── the page ────────────────────────────────────────────────────────────────

/**
 * Builds the tab inside `root` once. Returns what app.js needs: show() when the tab opens, open(ein) to jump to a group.
 * @param {HTMLElement} root
 * @param {Host} h
 */
export function mountOutbound(root, h) {
  host = h;
  root.innerHTML = `
    <div id="obTop"></div>
    <div id="obChart"></div>
    <div class="ob-split" id="obSplit">
      <section class="card ob-list" id="obList" aria-labelledby="obListTitle"></section>
      <aside class="card ob-detail" id="obDetail" aria-label="Group detail"></aside>
    </div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  root.addEventListener('keydown', onKey);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sheetOpen && root.offsetParent) closeSheet(); });
  const chart = byId('obChart');
  new ResizeObserver(() => { if (Math.abs(chart.clientWidth - chartWidth) > 8 && S.status === 'ready') renderChart(); }).observe(chart);
  return { show, open };
}

/** The tab was opened: read the API the first time, draw from what is already read after that. */
async function show() {
  // on a phone the tab strip scrolls sideways, so bring the open tab into it
  document.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (S.status === 'idle' || S.status === 'error') reading = load();
  await reading;
}

/** Opens one group by EIN, widening the filter if the table is hiding it. */
async function open(/** @type {string} */ ein) {
  await show();
  const d = S.data;
  if (!d || !d.loaded) return;
  if (!filterGroups(d.groups, S).some((g) => g.ein === ein)) { S.filter = 'all'; S.state = ''; S.query = ''; }
  select(ein, { sheet: true });
  renderList();
  byId('obList').querySelector(`[data-ein="${CSS.escape(ein)}"]`)?.scrollIntoView({ block: 'nearest' });
}

async function load() {
  S.status = 'loading';
  renderAll();
  try {
    S.data = await host.getJSON('/outbound');
    S.status = 'ready';
  } catch (e) {
    S.status = 'error';
    S.error = e instanceof Error ? e.message : String(e);
  }
  renderAll();
  const d = S.data;
  if (S.status === 'ready' && d && d.loaded && !S.selected && !isNarrow()) {
    const first = sortGroups(filterGroups(d.groups, S), S.sort)[0];
    if (first) { select(first.ein); renderList(); }
  }
}

function renderAll() {
  const d = S.data;
  const top = byId('obTop');
  const showBody = S.status === 'ready' && d !== null && d.loaded;
  byId('obChart').hidden = !showBody;
  byId('obSplit').hidden = !showBody;
  if (S.status === 'error') top.innerHTML = notice('Outbound is not available', failureText(S.error));
  else if (S.status !== 'ready') top.innerHTML = notice('Loading', 'Loading the rate file…');
  else if (d === null || !d.loaded) top.innerHTML = emptyState(d);
  else {
    top.innerHTML = topHTML(d);
    renderChart();
    renderList();
    renderDetail();
  }
}

const notice = (/** @type {string} */ title, /** @type {string} */ text) => `<div class="card ob-empty"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;

/** Sample mode has no outbound files; every other failure is shown as it came. */
const failureText = (/** @type {string} */ msg) => (/^no sample for/.test(msg) ? 'This tab reads the live API. Start the server with npm run dev, then reload.' : `The API answered: ${msg}`);

/** No rate file: say why, and show the one command that fetches it. */
function emptyState(/** @type {NotLoaded | null} */ d) {
  const failed = d?.status === 'failed';
  return `<div class="card ob-empty">
    <h3>${failed ? 'The rate file could not be read' : 'No rate file is loaded'}</h3>
    <p>${esc(d?.reason || 'The Outbound tab reads Serif’s public rate file, and none was found.')}</p>
    <p>${failed ? 'Replace it with a fresh copy:' : 'Fetch it with:'}</p>
    <pre class="ob-cmd"><code>npm run rates:fetch</code></pre>
    <p class="ob-empty-foot">Then restart the server. It loads the file at start (default <code>data/rates/mrf_rate_search_export.csv</code>; <code>RATES_CSV</code> points elsewhere). The file is public and is never committed.</p>
  </div>`;
}

// ─── the top: the finding and four figures ───────────────────────────────────

function topHTML(/** @type {Loaded} */ d) {
  const line = headline(d);
  const c = formCounts(d);
  const p = d.patterns;
  const bands = d.summary.bands;
  const tile = (/** @type {string} */ label, /** @type {string} */ value, /** @type {string} */ sub) =>
    `<div class="card ob-stat"><div class="ob-stat-label">${esc(label)}</div><div class="ob-stat-value">${value}</div><div class="ob-stat-sub">${sub}</div></div>`;
  const bandCells = bands.map((b) => `<div><div class="ob-band-name">${esc(b.band.replace('-', '–'))}</div><div class="ob-band-val">${b.medianPctOfMedicare == null ? '—' : `${b.medianPctOfMedicare}%`}</div><div class="ob-band-n">${nf(b.groups)} groups</div></div>`).join('');
  return `
    <div class="ob-finding">
      ${line ? `<p class="ob-line">${esc(line)}</p>` : ''}
      <p class="ob-scope">${esc(fileTitle(d.file))}. ${nf(d.file.rows)} rate rows, one rate per group.</p>
    </div>
    <div class="ob-stats">
      ${tile('Groups', nf(d.file.groups), `${nf(d.summary.fit.target)} targets, ${nf(d.summary.drafts.ready)} with a draft ready`)}
      ${tile('On the rate card', nf(c.card), p.card ? `a whole percent of ${usd(p.card.base)}; ${nf(p.card.hits)} of ${nf(p.card.distinctRates)} distinct rates` : 'no card found in this file')}
      ${tile('On a conversion factor', nf(c.factor), p.factor ? `a whole multiple of ${usd(p.factor.unit)}; ${nf(p.factor.hits)} of ${nf(p.factor.distinctRates)} distinct rates${c.both ? `; ${nf(c.both)} fit both` : ''}` : 'no factor found in this file')}
      <div class="card ob-stat ob-stat-bands"><div class="ob-stat-label">Median % of Medicare, by size</div><div class="ob-bands" role="group" aria-label="Median percent of Medicare by size band">${bandCells}</div><div class="ob-stat-sub">clinicians in the group</div></div>
    </div>`;
}

// ─── the chart ───────────────────────────────────────────────────────────────

const MARK_SIZE = 5;

/** One group's mark: the shape and fill carry the contract form, so the chart reads without color. */
function markSVG(/** @type {{ x: number, y: number, form: string }} */ p, /** @type {number} */ r = MARK_SIZE) {
  const { x, y } = p;
  if (p.form === 'card') return `<circle class="m-card" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`;
  if (p.form === 'factor') return `<rect class="m-factor" x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${2 * r}" height="${2 * r}"/>`;
  if (p.form === 'both') return `<path class="m-both" d="M${x.toFixed(1)} ${(y - r - 1.5).toFixed(1)}L${(x + r + 1.5).toFixed(1)} ${y.toFixed(1)}L${x.toFixed(1)} ${(y + r + 1.5).toFixed(1)}L${(x - r - 1.5).toFixed(1)} ${y.toFixed(1)}Z"/>`;
  return `<circle class="m-neither" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r - 0.5}"/>`;
}

/** The legend swatch for a form, drawn with the same shapes as the chart. */
const swatch = (/** @type {string} */ form) => `<svg class="ob-sw" viewBox="-8 -8 16 16" aria-hidden="true">${markSVG({ x: 0, y: 0, form }, 5)}</svg>`;

function legendHTML(/** @type {Loaded} */ d) {
  const n = d.summary.forms;
  const base = d.patterns.card?.base;
  return `<div class="legend ob-legend" aria-label="Chart key">
    <span>${swatch('card')}On the card (${nf(n.card)})</span>
    <span>${swatch('factor')}On a factor (${nf(n.factor)})</span>
    ${n.both ? `<span>${swatch('both')}Both (${nf(n.both)})</span>` : ''}
    <span>${swatch('neither')}Neither (${nf(n.neither)})</span>
    <span><svg class="ob-sw" viewBox="-8 -8 16 16" aria-hidden="true"><circle class="m-ring" r="7"/></svg>Target</span>
    ${base ? `<span><svg class="ob-sw ob-sw-line" viewBox="0 0 20 16" aria-hidden="true"><path class="g-tier" d="M0 8H20"/></svg>Card tier (% of ${usd(base)})</span>` : ''}
    <span><svg class="ob-sw ob-sw-line" viewBox="0 0 20 16" aria-hidden="true"><path class="g-medicare" d="M0 8H20"/></svg>Medicare 100%</span>
  </div>`;
}

/** Draws the rate-against-size chart at the width its box has now, so the type stays readable on a phone. */
function renderChart() {
  const d = S.data;
  const box = byId('obChart');
  if (!d || !d.loaded) return;
  box.innerHTML = `<div class="card ob-chart-card">
    <div class="card-head"><h3 id="obChartTitle">Rate against size</h3><span class="sub">each mark is one group; its shape is its contract form</span></div>
    ${legendHTML(d)}
    <div class="ob-chart-wrap"></div>
    <p class="ob-chart-note">The figures above the chart are each size band's median percent of Medicare. Dotted lines are the rate card's tiers; the dashed line is Medicare's 100%, the median of the groups' own baselines. Click a mark or pick a row to open the group.</p>
  </div>`;
  const wrap = byId('obChart').querySelector('.ob-chart-wrap');
  if (!(wrap instanceof HTMLElement)) return;
  chartWidth = box.clientWidth;
  const width = Math.max(280, Math.round(wrap.clientWidth));
  const height = width < 560 ? 440 : 460;
  const geo = chartGeometry(d.groups, d.patterns.card, d.summary.bands, { width, height });
  const { plot } = geo;
  const sel = d.groups.find((g) => g.ein === S.selected) ?? null;
  const byEin = new Map(geo.points.map((p) => [p.ein, p]));
  const pointFor = (/** @type {Group} */ g) => byEin.get(g.ein);

  const grid = geo.yTicks.map((t) => `<path class="g-grid" d="M${plot.x0} ${t.y.toFixed(1)}H${plot.x1}"/><text class="t-axis" x="${plot.x0 - 8}" y="${(t.y + 4).toFixed(1)}" text-anchor="end">$${t.value}</text>`).join('');
  const xAxis = geo.xTicks.map((t) => `<path class="g-grid g-grid-x" d="M${t.x.toFixed(1)} ${plot.y1}V${plot.y1 + 5}"/><text class="t-axis" x="${t.x.toFixed(1)}" y="${plot.y1 + 19}" text-anchor="middle">${nf(t.value)}</text>`).join('');
  const dividers = geo.dividers.map((v) => `<path class="g-band" d="M${v.x.toFixed(1)} ${plot.y0 - 6}V${plot.y1}"/>`).join('');
  const captions = geo.bandCaptions.map((b) => `<text class="t-band" x="${b.x.toFixed(1)}" y="${plot.y0 - 30}" text-anchor="middle">${esc(b.band.replace('-', '–'))}</text><text class="t-band-val" x="${b.x.toFixed(1)}" y="${plot.y0 - 14}" text-anchor="middle">${width < 560 ? '' : 'median '}${b.median == null ? '—' : `${b.median}%`}</text>`).join('');
  const tiers = geo.tierLines.map((t) => `<path class="g-tier" d="M${plot.x0} ${t.y.toFixed(1)}H${plot.x1}"/>${t.labelled ? `<text class="t-tier" x="${plot.x1 + 5}" y="${(t.y + 3.5).toFixed(1)}">${t.tier}%</text>` : ''}`).join('');
  const med = `<path class="g-medicare" d="M${plot.x0} ${geo.medicare.y.toFixed(1)}H${plot.x1}"/><text class="t-medicare" x="${plot.x0 + 6}" y="${(geo.medicare.y - 6).toFixed(1)}">Medicare 100% · ${usd(geo.medicare.value)}</text>`;

  // mark order: ordinary groups, then targets, then the selected one, so the ones that matter are never covered
  const rank = (/** @type {Group} */ g) => (g.ein === S.selected ? 2 : g.fit === 'target' ? 1 : 0);
  const marks = [...d.groups].sort((a, b) => rank(a) - rank(b)).map((g) => {
    const p = pointFor(g);
    if (!p) return '';
    const ring = g.fit === 'target' || g.ein === S.selected ? `<circle class="m-ring${g.ein === S.selected ? ' is-selected' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${MARK_SIZE + 4}"/>` : '';
    return `<g class="pt" data-ein="${esc(g.ein)}">${ring}${markSVG(p)}</g>`;
  }).join('');

  // labels without hover: the targets and the selected group are named on the chart, on whichever side has room
  const named = d.groups.filter((g) => g.fit === 'target' || g.ein === S.selected);
  const labels = named.map((g) => {
    const p = pointFor(g);
    if (!p) return '';
    const left = p.x > plot.x1 - 130;
    const short = g.platform && g.fit === 'target' ? g.platform : g.name;
    const text = short.length > 26 ? `${short.slice(0, 25)}…` : short;
    return `<text class="t-name${g.ein === S.selected ? ' is-selected' : ''}" x="${(p.x + (left ? -15 : 15)).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="${left ? 'end' : 'start'}">${esc(text)}</text>`;
  }).join('');

  const desc = `${nf(d.groups.length)} groups. Each is a mark at its clinician count (left to right, log scale) and its rate (bottom to top). ${selectedSummary(sel)}The table below lists every group.`;
  wrap.innerHTML = `<svg class="ob-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="obChartTitle obChartDesc">
      <desc id="obChartDesc">${esc(desc)}</desc>
      ${dividers}${grid}${tiers}${med}${xAxis}${captions}
      <text class="t-title" x="${plot.x0}" y="${height - 8}">Clinicians in the group, log scale</text>
      ${width < 560 ? '' : `<text class="t-title" x="2" y="${plot.y0 - 14}">Rate, ${esc(d.file.code)}</text>`}
      ${marks}${labels}
    </svg>`;
}

function selectedSummary(/** @type {Group | null} */ g) {
  return g ? `Selected: ${g.name}, ${nf(g.clinicians)} clinicians, ${usd(g.rate)}, ${g.pctOfMedicare}% of Medicare, ${formLabel(g)}. ` : '';
}

// ─── the table ───────────────────────────────────────────────────────────────

function renderList() {
  const d = S.data;
  if (!d || !d.loaded) return;
  const rows = sortGroups(filterGroups(d.groups, S), S.sort);
  const states = statesOf(d.groups);
  const counts = Object.fromEntries(FILTER_KEYS.map((k) => [k, d.groups.filter(FILTERS[k].keeps).length]));
  const chips = FILTER_KEYS.map((k) => `<button type="button" class="chip${S.filter === k ? ' is-on' : ''}" data-filter="${k}" aria-pressed="${S.filter === k}">${esc(FILTERS[k].label)} <span class="chip-n">${counts[k]}</span></button>`).join('');
  const stateOpts = [`<option value="">All states</option>`, ...states.map(([s, n]) => `<option value="${esc(s)}"${S.state === s ? ' selected' : ''}>${esc(s)} (${n})</option>`)].join('');
  const sortOpts = Object.entries(SORTS).map(([k, c]) => `<option value="${k}"${S.sort.key === k ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  const head = Object.entries(SORTS).map(([k, c]) => {
    const on = S.sort.key === k;
    const aria = on ? (S.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="ob-c-${k}${c.numeric ? ' num' : ''}" aria-sort="${aria}"><button type="button" class="ob-sort${on ? ' is-on' : ''}" data-sort="${k}" data-fk="sort-${k}">${esc(c.label)}<span class="ob-arrow" aria-hidden="true">${on ? (S.sort.dir === 'asc' ? '↑' : '↓') : ''}</span></button></th>`;
  }).join('');
  const body = rows.map((g) => rowHTML(g)).join('');
  byId('obList').innerHTML = `
    <div class="ob-tools">
      <h3 id="obListTitle">Groups</h3>
      <div class="chips" role="group" aria-label="Filter groups">${chips}</div>
      <div class="ob-fields">
        <label class="ob-field">State<select data-ctl="state" data-fk="state">${stateOpts}</select></label>
        <label class="ob-field ob-field-sort">Sort by<select data-ctl="sort" data-fk="sort-select">${sortOpts}</select></label>
        <label class="ob-field ob-field-search">Search<input data-ctl="query" data-fk="query" type="search" value="${esc(S.query)}" placeholder="Name, city or EIN"></label>
      </div>
    </div>
    <div class="ob-count" aria-live="polite">${nf(rows.length)} of ${nf(d.groups.length)} groups</div>
    ${rows.length ? `<table class="ob-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` : `<div class="none ob-none">No group matches. <button type="button" class="btn-link" data-act="reset">Show all groups</button></div>`}`;
}

function rowHTML(/** @type {Group} */ g) {
  const on = g.ein === S.selected;
  const fit = g.fit === 'target'
    ? `<span class="badge ${g.draftStatus === 'ready' ? 'ok' : 'warn'}">${esc(fitLabel(g))}</span>`
    : `<span class="ob-nofit">${esc(fitLabel(g))}</span>`;
  const form = formLabel(g);
  return `<tr class="ob-row${on ? ' is-selected' : ''}"${on ? ' aria-current="true"' : ''} data-ein="${esc(g.ein)}">
    <td class="ob-c-name" data-label="Group"><button type="button" class="ob-open" data-open="${esc(g.ein)}" data-fk="open-${esc(g.ein)}">${esc(g.name)}</button><span class="ob-city">${esc(g.city)}</span></td>
    <td class="ob-c-state" data-label="State">${esc(g.state ?? '—')}</td>
    <td class="num ob-c-clinicians" data-label="Clinicians">${nf(g.clinicians)}</td>
    <td class="num ob-c-rate" data-label="Rate">${usd(g.rate)}</td>
    <td class="num ob-c-pct" data-label="% of Medicare">${g.pctOfMedicare}%</td>
    <td class="ob-c-form${g.form === 'neither' ? ' is-none' : ''}" data-label="Contract form">${esc(form)}</td>
    <td class="ob-c-fit" data-label="Fit">${fit}</td>
  </tr>`;
}

// ─── selecting and the detail panel ──────────────────────────────────────────

/** Makes a group the selected one and starts reading its detail. */
function select(/** @type {string} */ ein, { sheet = false } = {}) {
  S.selected = ein;
  S.sheetOpen = sheet && isNarrow();
  S.detailError = '';
  if (!S.details.has(ein)) {
    host.getJSON(`/outbound/${encodeURIComponent(ein)}`).then(
      (p) => { S.details.set(ein, p); if (S.selected === ein) renderDetail(); },
      (e) => { if (S.selected === ein) { S.detailError = e instanceof Error ? e.message : String(e); renderDetail(); } },
    );
  }
  renderDetail();
  renderChart();
}

function closeSheet() {
  const back = S.selected;
  S.sheetOpen = false;
  renderDetail();
  const opener = back ? byId('obList').querySelector(`[data-open="${CSS.escape(back)}"]`) : null;
  if (opener instanceof HTMLElement) opener.focus();
}

function renderDetail() {
  const box = byId('obDetail');
  box.classList.toggle('is-open', S.sheetOpen);
  if (S.sheetOpen) box.setAttribute('aria-modal', 'true'); else box.removeAttribute('aria-modal');
  box.setAttribute('role', S.sheetOpen ? 'dialog' : 'complementary');
  const ein = S.selected;
  const d = S.data;
  if (!ein || !d || !d.loaded) { box.innerHTML = `<div class="ob-d-empty"><div class="empty-title">Pick a group</div><p>Its facts, source rows, draft and HubSpot request open here.</p></div>`; return; }
  const p = S.details.get(ein);
  if (!p) {
    box.innerHTML = S.detailError
      ? `<div class="ob-d-empty"><div class="empty-title">Couldn't load this group</div><p>${esc(S.detailError)}</p></div>`
      : `<div class="ob-d-empty"><div class="empty-title">Loading…</div></div>`;
    return;
  }
  const hadFocus = box.contains(document.activeElement);
  box.innerHTML = detailHTML(p, d);
  box.scrollTop = 0;
  if (S.sheetOpen && !hadFocus) /** @type {HTMLElement | null} */ (box.querySelector('[data-act="close"]'))?.focus();
}

function detailHTML(/** @type {any} */ p, /** @type {Loaded} */ d) {
  /** @type {Group & Record<string, any>} */
  const g = p.finding;
  const draft = p.draft;
  const fitBadge = g.fit === 'target' ? '<span class="badge ok">Target</span>' : '<span class="badge">Not a target</span>';
  return `
    <header class="ob-d-head">
      <div class="ob-d-top">
        <div class="ob-d-name">${esc(g.name)}</div>
        <button type="button" class="btn btn-secondary btn-sm ob-close" data-act="close">Close</button>
      </div>
      <div class="ob-d-sub">${esc(place(g))} · <span class="idkey">EIN ${esc(g.ein)}</span> <span class="idkey">${esc(g.accountKey)}</span></div>
      <div class="ob-d-badges">${fitBadge}${draft ? draftBadge(draft) : ''}</div>
    </header>
    <p class="ob-nothing"><b>Nothing is sent from here.</b> There is no email code in this project, and the HubSpot request below is shown, not made.</p>
    ${findingSection(p, d)}
    ${rowsSection(p, d)}
    ${identitySection(p)}
    ${fitSection(g)}
    ${draftSection(p)}
    ${hubspotSection(p)}`;
}

const section = (/** @type {string} */ title, /** @type {string} */ body, /** @type {string} */ sub = '') =>
  `<section class="ob-sec"><h4>${esc(title)}${sub ? ` <span class="ob-sec-sub">${esc(sub)}</span>` : ''}</h4>${body}</section>`;

const kv = (/** @type {Array<[string, string] | null>} */ pairs) =>
  `<dl class="kv ob-kv">${pairs.filter(/** @returns {x is [string, string]} */ (x) => !!x).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

function contractFormText(/** @type {Group} */ g, /** @type {Loaded} */ d) {
  const card = d.patterns.card;
  const factor = d.patterns.factor;
  const parts = [];
  if (g.cardTier != null && card) parts.push(`${g.cardTier}% of the ${usd(card.base)} rate card`);
  if (g.factorMultiple != null && factor) parts.push(`${g.factorMultiple} × the ${usd(factor.unit)} conversion unit`);
  return parts.length ? parts.join(', and ') : 'Neither the card nor the factor: this rate is not a whole percent of the card’s base or a whole multiple of the unit.';
}

function findingSection(/** @type {any} */ p, /** @type {Loaded} */ d) {
  const g = p.finding;
  const top = g.cityTopEin === g.ein ? 'This group holds it.' : `${usd(g.cityTopRate)} (${nf(g.cityTopClinicians)} clinicians, EIN ${esc(g.cityTopEin)})`;
  return section('The finding', kv([
    ['Rate', `<b>${usd(g.rate)}</b> for ${esc(d.file.code)}`],
    ['% of Medicare', `<b>${g.pctOfMedicare}%</b> <span class="muted">of a ${usd(g.medicare)} baseline</span>`],
    ['Contract form', esc(contractFormText(g, d))],
    ['Size', `${nf(g.clinicians)} clinicians · band ${esc(g.band)}, median ${g.bandMedianPct}% of Medicare`],
    g.city ? [`Top rate in ${g.city}`, top] : null,
    ['As a rep would read it', `<span class="ob-quote">${esc(p.rateLine)}</span>`],
  ]));
}

function rowsSection(/** @type {any} */ p, /** @type {Loaded} */ d) {
  /** @type {Array<Record<string, any>>} */
  const rows = p.sourceRows;
  const body = rows.map((r) => `<tr class="${r.chosen ? 'is-chosen' : ''}">
      <td class="num">${usd(r.rate)}</td><td class="num">${Math.round(r.pct_medicare * 100)}%</td>
      <td class="num">${nf(r.npis)}</td><td class="num">${nf(r.src_npis)}</td>
      <td>${r.chosen ? '<span class="badge ok">Used</span>' : ''}${r.most_npis && !r.chosen ? '<span class="badge">Flagged</span>' : ''}</td></tr>`).join('');
  return section('Source rate rows', `
    <table class="ob-rows"><thead><tr><th class="num">Rate</th><th class="num">% of Medicare</th><th class="num">Psychiatrists on the row</th><th class="num">Payer’s NPI list</th><th></th></tr></thead><tbody>${body}</tbody></table>
    <p class="meta-line">${rows.length === 1 ? 'One row in the file for this group.' : `${rows.length} rows in the file for this group.`} The rate used is the row the file flags as covering the most NPIs, then the payer’s largest NPI list, then the most psychiatrists, then the higher rate.</p>`, `${rows.length}`);
}

function identitySection(/** @type {any} */ p) {
  const l = p.link;
  if (!l) return section('Registry', '<p>No link was stored for this group.</p>');
  if (l.status === 'linked') {
    return section('Registry', `<p>Linked to <b>${esc(l.accountName)}</b> <span class="idkey">${esc(l.accountId)}</span>, matched on company name (score ${Number(l.score).toFixed(2)}; ${esc(l.reason)}). A lead from that organization gets this group’s rate line in its brief.</p>`);
  }
  const cands = (l.candidates || []).length
    ? `<table class="cands"><thead><tr><th>Closest registry name</th><th>State</th><th class="num">Match</th></tr></thead><tbody>${l.candidates.map((/** @type {any} */ c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.state || '—')}</td><td class="num">${Number(c.score).toFixed(2)}</td></tr>`).join('')}</tbody></table>`
    : '';
  return section('Registry', `<p>Stands on its EIN: <span class="idkey">${esc(p.finding.accountKey)}</span>. It is not linked to a registry organization (${esc(l.reason)}). A link is made only on a unique, strong name match; a weak one is never guessed.</p>${cands}`);
}

function fitSection(/** @type {Group} */ g) {
  const mapping = g.platform ? `<p class="meta-line">Mapped to <b>${esc(g.platform)}</b>, ${g.platformConfirmed ? 'confirmed' : 'not confirmed'}.</p>` : '';
  return section(g.fit === 'target' ? 'Why it is a target' : 'Why it is not a target', `<p>${esc(g.fitReason)}.</p>${mapping}`);
}

function draftBadge(/** @type {any} */ draft) {
  if (draft.status === 'ready') return '<span class="badge ok">Draft ready</span>';
  if (draft.status === 'blocked') return '<span class="badge warn">Draft blocked</span>';
  return '<span class="badge">Preview</span>';
}

/** Runs of a rendered text as HTML: inserted values marked, the open placeholder marked differently, blank lines as paragraphs. */
function runsHTML(/** @type {Part[]} */ parts) {
  const html = parts.map((r) => (r.open ? `<span class="ph-open">${esc(r.text)}</span>` : r.placeholder ? `<mark class="ins">${esc(r.text)}</mark>` : esc(r.text))).join('');
  return html.split('\n\n').map((para) => `<p>${para}</p>`).join('');
}

function draftSection(/** @type {any} */ p) {
  const draft = p.draft;
  if (!draft) return section('Draft', `<p>No draft can be written from this file: ${esc(p.draftUnavailable)}.</p>`);
  const inserted = /** @type {Array<{ placeholder: string, value: string, field: string }>} */ (draft.inserted);
  const state = draft.status === 'blocked'
    ? `<div class="ob-state is-blocked"><b>Blocked.</b> ${esc(draft.reason || draft.label)}</div>`
    : draft.status === 'ready'
      ? `<div class="ob-state is-ready"><b>Ready for a rep to review.</b> ${esc(sentenceCase(draft.label.replace(/^Draft: /, '')))}</div>`
      : `<div class="ob-state"><b>Preview.</b> ${esc(sentenceCase(draft.label.replace(/^Preview only: /, '')))}</div>`;
  const table = inserted.map((v) => `<tr><td class="ob-v"><mark class="ins">${esc(v.value)}</mark></td><td><code>${esc(v.placeholder)}</code></td><td class="ob-from">${esc(v.field)}</td></tr>`).join('');
  return section('Draft', `
    ${state}
    ${draft.hookNote ? `<p class="meta-line">${esc(draft.hookNote)}.</p>` : ''}
    <div class="ob-mail">
      <div class="ob-mail-label">Email · ${esc(HOOK_WORDS[/** @type {keyof typeof HOOK_WORDS} */ (draft.hook)] ?? draft.hook)} hook</div>
      <div class="ob-mail-subject"><span>Subject</span>${runsHTML(draft.parts.subject)}</div>
      <div class="ob-mail-body">${runsHTML(draft.parts.body)}</div>
    </div>
    <div class="ob-mail">
      <div class="ob-mail-label">LinkedIn line</div>
      <div class="ob-mail-body">${runsHTML(draft.parts.linkedin)}</div>
    </div>
    <p class="ob-key"><mark class="ins">Figure</mark> inserted by code from the file. <span class="ph-open">{first_name}</span> left open: the file names organizations, not people.</p>
    <table class="ob-ins"><caption>Every inserted value and where it came from</caption><thead><tr><th>Value</th><th>Placeholder</th><th>Where it came from</th></tr></thead><tbody>${table}</tbody></table>`);
}

function hubspotSection(/** @type {any} */ p) {
  const h = p.hubspot;
  const reqs = (h.requests || []).map((/** @type {any} */ r) => `<details class="req"><summary><span class="verb">${esc(r.method)}</span>${esc(r.path)}</summary>${r.note ? `<div class="meta-line ob-pad">${esc(r.note)}</div>` : ''}<pre class="json">${host.jsonHTML(r.body)}</pre></details>`).join('');
  const none = h.skipped ? `<p class="meta-line">No request for this group: ${esc(h.skipped)}.</p>` : '';
  return `<section class="ob-sec"><details class="ob-hs"><summary>HubSpot request that would be sent <span class="ob-sec-sub">dry run, never sent</span></summary>${reqs}${none}</details></section>`;
}

// ─── events ──────────────────────────────────────────────────────────────────

/** Runs a re-render and gives focus back to the control that had it, which a redraw would otherwise drop. */
function keepFocus(/** @type {() => void} */ redraw) {
  const key = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.fk : undefined;
  const caret = document.activeElement instanceof HTMLInputElement ? document.activeElement.selectionStart : null;
  redraw();
  if (!key || S.sheetOpen) return;
  const again = /** @type {HTMLElement | null} */ (byId('obList').querySelector(`[data-fk="${CSS.escape(key)}"]`));
  again?.focus();
  if (again instanceof HTMLInputElement && caret != null) again.setSelectionRange(caret, caret);
}

function onClick(/** @type {Event} */ e) {
  const t = /** @type {HTMLElement} */ (e.target);
  const sort = t.closest('[data-sort]');
  if (sort instanceof HTMLElement) {
    const key = sort.dataset.sort ?? 'name';
    S.sort = S.sort.key === key ? { key, dir: S.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: SORTS[key].first };
    keepFocus(renderList);
    return;
  }
  const chip = t.closest('[data-filter]');
  if (chip instanceof HTMLElement) {
    S.filter = /** @type {import('./outbound-model.js').FilterKey} */ (chip.dataset.filter);
    renderList();
    return;
  }
  if (t.closest('[data-act="reset"]')) { S.filter = 'all'; S.state = ''; S.query = ''; renderList(); return; }
  if (t.closest('[data-act="close"]')) { closeSheet(); return; }
  const opener = t.closest('[data-open], tr[data-ein], .pt[data-ein]');
  if (opener instanceof Element) {
    const ein = opener.getAttribute('data-open') ?? opener.getAttribute('data-ein');
    if (ein) { keepFocus(() => { select(ein, { sheet: true }); renderList(); }); }
  }
}

function onInput(/** @type {Event} */ e) {
  const t = e.target;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
  const ctl = t.dataset.ctl;
  if (!ctl) return;
  if (ctl === 'state') S.state = t.value;
  else if (ctl === 'query') S.query = t.value;
  else if (ctl === 'sort') S.sort = { key: t.value, dir: SORTS[t.value].first };
  keepFocus(renderList);
}

/** Up and Down move between the group buttons in the table, so the list can be read by keyboard alone. */
function onKey(/** @type {KeyboardEvent} */ e) {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.matches('.ob-open') || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  const all = Array.from(byId('obList').querySelectorAll('.ob-open'));
  const next = all[all.indexOf(t) + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next instanceof HTMLElement) { e.preventDefault(); next.focus(); }
}
