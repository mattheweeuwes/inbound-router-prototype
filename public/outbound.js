// The Outbound tab: Serif's public rate file read as a sales story and as work for a team. It draws GET /api/outbound (the
// finding, what is ready by play, the links waiting for a person, a chart of every group's rate against its size, a
// filterable table) and GET /api/outbound/<ein> (one group's facts, source rows, play, registry link, who already has it,
// the drafted email and LinkedIn line with every inserted figure marked, and the dry-run HubSpot request).
// It sends nothing. Its writes are a person's link decision (POST /api/outbound/<ein>/link) and taking one back (DELETE on the same
// path), which the server takes only with the demo actions on. The groups table comes first, then the links to confirm, then the
// chart. The logic with no DOM in it is in outbound-model.js.
import {
  FILTERS, FILTER_KEYS, LINK_VALUE_WORDS, PLAY_WORDS, SORTS, STATUS_CHIPS, chartGeometry, chipCounts, confirmWords, fileTitle, filterGroups, formCounts,
  formLabel, fromParams, headline, linkValue, linksToConfirm, panelRows, pickStatus, sortGroups, statesOf, statusLabel, toParams, workCounts,
} from './outbound-model.js';
import { copyAddress } from './copy-link.js';
import { readDecider, saveDecider } from './decider.js';
import { timeTag } from './time.js';

/**
 * What app.js hands over: its API reader (live API or sample files), its API writers, its JSON highlighter, and a way to say the view
 * changed so the address follows.
 * @typedef {{
 *   getJSON: (path: string) => Promise<any>, postJSON: (path: string, body: unknown) => Promise<any>, deleteJSON: (path: string) => Promise<any>,
 *   jsonHTML: (v: unknown) => string, syncAddress: (opts?: { push?: boolean }) => void,
 * }} Host
 * @typedef {import('./outbound-model.js').Group} Group
 * @typedef {import('./outbound-model.js').Loaded} Loaded
 * @typedef {import('./outbound-model.js').Want} Want
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

/** The badge class for each status: ready is good news, blocked and a link to confirm need someone, the rest are muted. */
const STATUS_BADGE = { ready: 'ok', blocked: 'warn', link_to_confirm: 'warn', suppressed: '', not_target: '' };

// ─── state ───────────────────────────────────────────────────────────────────

/**
 * One decision made in this visit, kept where its row was so the panel does not shift.
 * @typedef {{ ein: string, index: number, decision: 'confirm' | 'reject', name: string, candidate: string | null }} Line
 * @typedef {{
 *   status: 'idle' | 'loading' | 'ready' | 'error',
 *   error: string,
 *   data: Loaded | NotLoaded | null,
 *   want: Want,
 *   sort: { key: string, dir: 'asc' | 'desc' },
 *   selected: string | null,
 *   addressEin: string | null,
 *   sheetOpen: boolean,
 *   details: Map<string, any>,
 *   detailError: string,
 *   by: string,
 *   linkMsg: { ein: string, text: string, error: boolean } | null,
 *   deciding: string | null,
 *   lines: Line[],
 *   linksAll: boolean,
 *   decidedOpen: boolean,
 * }} State
 */
/** @type {State} */
const S = {
  status: 'idle', error: '', data: null, want: { filter: 'in_play', status: '', state: '', query: '' }, sort: { key: 'clinicians', dir: 'desc' },
  selected: null, addressEin: null, sheetOpen: false, details: new Map(), detailError: '', by: readDecider(), linkMsg: null, deciding: null,
  lines: [], linksAll: false, decidedOpen: false,
};

/** @type {Host} */
let host;
let chartWidth = 0;
/** The read in flight, so a second caller (an address that names a group) waits for it instead of finding no data. */
let reading = Promise.resolve();

// ─── the page ────────────────────────────────────────────────────────────────

/**
 * Builds the tab inside `root` once. Returns what app.js needs: show() when the tab opens, applyAddress(params) for a view an address
 * names, and address() for the view's parameters.
 * @param {HTMLElement} root
 * @param {Host} h
 */
export function mountOutbound(root, h) {
  host = h;
  root.innerHTML = `
    <div id="obTop"></div>
    <div class="ob-split" id="obSplit">
      <section class="card ob-list" id="obList" aria-labelledby="obListTitle"></section>
      <aside class="card ob-detail" id="obDetail" aria-label="Group detail"></aside>
    </div>
    <div id="obLinks"></div>
    <div id="obChart"></div>`;
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);
  root.addEventListener('keydown', onKey);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sheetOpen && root.offsetParent) closeSheet(); });
  const chart = byId('obChart');
  new ResizeObserver(() => { if (Math.abs(chart.clientWidth - chartWidth) > 8 && S.status === 'ready') renderChart(); }).observe(chart);
  return { show, applyAddress, address };
}

/** The tab was opened: read the API the first time, draw from what is already read after that. */
async function show() {
  // on a phone the tab strip scrolls sideways, so bring the open tab into it
  document.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (S.status === 'idle' || S.status === 'error') reading = load();
  await reading;
}

/** The view as address parameters: the open group, the status, the play, the state, the search and the sort. */
function address() {
  return { ein: S.addressEin ?? '', ...toParams(S.want, S.sort) };
}

/** An address named a view: take its filters and sort, and open the group it names, once the API has been read. */
async function applyAddress(/** @type {Record<string, string>} */ params) {
  await show();
  const view = fromParams(params);
  S.want = view.want;
  S.sort = view.sort;
  const d = S.data;
  if (!d || !d.loaded) return;
  S.addressEin = params.ein || null;
  if (params.ein) {
    // a group the filters hide is shown anyway: the address asked for it
    if (!filterGroups(d.groups, S.want).some((g) => g.ein === params.ein)) S.want = { filter: 'all', status: '', state: '', query: '' };
    select(params.ein, { sheet: true });
  }
  if (!params.ein && !isNarrow()) {
    // no group named: the detail shows the first group the table now holds, not one the filters have hidden
    const rows = sortGroups(filterGroups(d.groups, S.want), S.sort);
    if (rows.length && !rows.some((g) => g.ein === S.selected)) select(rows[0].ein);
  }
  renderList();
  if (params.ein) byId('obList').querySelector(`[data-ein="${CSS.escape(params.ein)}"]`)?.scrollIntoView({ block: 'nearest' });
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
    const first = sortGroups(filterGroups(d.groups, S.want), S.sort)[0];
    if (first) { select(first.ein); renderList(); }
  }
}

function renderAll() {
  const d = S.data;
  const top = byId('obTop');
  const showBody = S.status === 'ready' && d !== null && d.loaded;
  byId('obChart').hidden = !showBody;
  byId('obSplit').hidden = !showBody;
  byId('obLinks').hidden = !showBody;
  if (S.status === 'error') top.innerHTML = notice('Outbound is not available', failureText(S.error));
  else if (S.status !== 'ready') top.innerHTML = notice('Loading', 'Loading the rate file…');
  else if (d === null || !d.loaded) top.innerHTML = emptyState(d);
  else {
    top.innerHTML = topHTML(d);
    renderLinks();
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
      ${tile('Groups', nf(d.file.groups), `${nf(d.summary.plays.platform.groups + d.summary.plays.system_gap.groups)} in a play, ${nf(d.summary.statuses.ready)} with a draft ready`)}
      ${tile('On the rate card', nf(c.card), p.card ? `a whole percent of ${usd(p.card.base)}; ${nf(p.card.hits)} of ${nf(p.card.distinctRates)} distinct rates` : 'no card found in this file')}
      ${tile('On a conversion factor', nf(c.factor), p.factor ? `a whole multiple of ${usd(p.factor.unit)}; ${nf(p.factor.hits)} of ${nf(p.factor.distinctRates)} distinct rates${c.both ? `; ${nf(c.both)} fit both` : ''}` : 'no factor found in this file')}
      <div class="card ob-stat ob-stat-bands"><div class="ob-stat-label">Median % of Medicare, by size</div><div class="ob-bands" role="group" aria-label="Median percent of Medicare by size band">${bandCells}</div><div class="ob-stat-sub">clinicians in the group</div></div>
    </div>
    ${workHTML(d)}`;
}

/** The work row: drafts ready by play, groups someone already has, links waiting for a person, and the export. */
function workHTML(/** @type {Loaded} */ d) {
  const w = workCounts(d);
  const tile = (/** @type {string} */ label, /** @type {number} */ value, /** @type {string} */ sub, /** @type {string} */ extra = '') =>
    `<div class="card ob-stat ob-work-tile"><div class="ob-stat-label">${esc(label)}</div><div class="ob-stat-value">${nf(value)}</div><div class="ob-stat-sub">${esc(sub)}</div>${extra}</div>`;
  return `<div class="ob-stats ob-work" role="group" aria-label="Outbound work">
      ${tile('Drafts ready: Platform', w.ready.platform, 'behavioral health platforms, confirmed')}
      ${tile('Drafts ready: System gap', w.ready.system_gap, 'health systems paid under their city’s top rate')}
      ${tile('Suppressed', w.suppressed, 'a customer, an owner or an inbound lead has it')}
      ${tile('Links to confirm', w.linksWaiting, 'probable registry links waiting for a person', w.linksWaiting ? '<button type="button" class="btn-link ob-jump" data-jump-links>Go to them</button>' : '')}
    </div>
    <p class="ob-export"><a class="ob-export-link" href="${esc(d.actions.export)}" download>Export the ${nf(w.ready.total)} ready drafts (CSV)</a> <span class="muted">One row per draft, with {first_name} left open. Nothing is sent.</span></p>`;
}

// ─── links to confirm ────────────────────────────────────────────────────────

/** The panel of probable links: the most useful one first, each with its candidate and what confirming would do, and buttons that record a person's decision. */
function renderLinks() {
  const d = S.data;
  const box = byId('obLinks');
  if (!d || !d.loaded) return;
  const probable = linksToConfirm(d.groups);
  const rows = panelRows(probable, S.lines, S.linksAll);
  const off = d.actions.linkDecisions ? '' : '<p class="ob-links-off"><b>Demo actions are off on this server,</b> so a decision cannot be recorded here. Start it with <code>npm run dev</code> (it sets <code>DEMO_ROUTES=1</code>).</p>';
  const items = rows.map((r) => (r.kind === 'link' ? linkItem(r.group) : lineItem(r.line))).join('');
  const showAll = probable.length > 1
    ? `<button type="button" class="btn-link ob-links-all" data-links-all data-fk="links-all" aria-expanded="${S.linksAll}">${S.linksAll ? 'Show fewer' : `Show all ${nf(probable.length)}`}</button>`
    : '';
  box.innerHTML = `<section class="card ob-links" id="obLinksCard" aria-labelledby="obLinksTitle">
    <div class="ob-links-head">
      <h3 id="obLinksTitle">Links to confirm <span class="chip-n">${nf(probable.length)}</span></h3>
      <label class="ob-field ob-by">Deciding as<input data-ctl="by" data-fk="by" type="text" value="${esc(S.by)}" placeholder="Your name" autocomplete="name"></label>
    </div>
    <p class="ob-links-note">A group is linked to a registry organization only on a unique, strong name match. These are the near misses: the best candidate in the group's state, the ones that would put a group in a play first. Until a person confirms one, no draft and no record names the organization. Sign-in is not built, so the name you type is stored as who decided.</p>
    ${off}
    ${items ? `<ul class="ob-link-list">${items}</ul>` : '<p class="none ob-none">No probable link is waiting.</p>'}
    ${showAll}
    ${decidedHTML(d)}
  </section>`;
}

/** One link waiting: the group, its candidate, why it is probable, what confirming does, and the two buttons. */
function linkItem(/** @type {Group} */ g) {
  const c = /** @type {import('./outbound-model.js').Candidate} */ (g.link.probable);
  const busy = S.deciding === g.ein ? ' disabled' : '';
  const value = linkValue(g);
  const msg = S.linkMsg && S.linkMsg.ein === g.ein ? `<p class="ob-link-msg${S.linkMsg.error ? ' is-error' : ''}" role="status">${esc(S.linkMsg.text)}</p>` : '';
  return `<li class="ob-link" data-ein="${esc(g.ein)}">
      <div class="ob-link-group"><button type="button" class="ob-open" data-open="${esc(g.ein)}">${esc(g.name)}</button><span class="ob-city">${esc(place(g))} · ${nf(g.clinicians)} clinicians</span></div>
      <div class="ob-link-cand"><span class="ob-link-arrow" aria-hidden="true">→</span> <b>${esc(c.name)}</b> <span class="muted">${esc(c.state ?? '—')} · score ${c.score.toFixed(2)}</span>
        <span class="ob-city">${esc(g.link.why)}.</span>
        <span class="ob-link-tag is-v${value}">${esc(LINK_VALUE_WORDS[value])}</span> <span class="ob-city">${esc(confirmWords(g))}.</span></div>
      <div class="ob-link-acts">
        <button type="button" class="btn btn-sm" data-link-act="confirm" data-ein="${esc(g.ein)}" data-account="${esc(c.accountId)}"${busy}>Confirm</button>
        <button type="button" class="btn btn-secondary btn-sm" data-link-act="reject" data-ein="${esc(g.ein)}"${busy}>Reject</button>
      </div>
      ${msg}
    </li>`;
}

/** A decision made in this visit: one line where the row was, with what happened and an Undo. */
function lineItem(/** @type {Line} */ l) {
  const what = l.decision === 'confirm' ? `Confirmed for ${l.name}.${l.candidate ? ` Linked to ${l.candidate}.` : ''}` : `Rejected for ${l.name}.${l.candidate ? ` Not part of ${l.candidate}.` : ''}`;
  const busy = S.deciding === l.ein ? ' disabled' : '';
  const err = S.linkMsg && S.linkMsg.ein === l.ein && S.linkMsg.error ? ` <span class="is-error">${esc(S.linkMsg.text)}</span>` : '';
  return `<li class="ob-link ob-link-done" data-ein="${esc(l.ein)}">
      <p class="ob-link-msg" role="status">${esc(what)}${err}</p>
      <div class="ob-link-acts"><button type="button" class="btn btn-secondary btn-sm" data-undo="${esc(l.ein)}" data-fk="undo-${esc(l.ein)}"${busy}>Undo</button></div>
    </li>`;
}

/** Earlier decisions, collapsed: each with who decided and when, and an Undo that takes it back. */
function decidedHTML(/** @type {Loaded} */ d) {
  const here = new Set(S.lines.map((l) => l.ein));
  const decided = d.groups.filter((g) => g.link.decision && !here.has(g.ein))
    .sort((a, b) => String(b.link.decision?.decidedAt).localeCompare(String(a.link.decision?.decidedAt)) || a.ein.localeCompare(b.ein));
  if (!decided.length) return '';
  const rows = decided.map((g) => {
    const x = /** @type {import('./outbound-model.js').Decision} */ (g.link.decision);
    const verb = x.decision === 'confirmed' ? `Confirmed${x.accountName ? `: ${x.accountName}` : ''}` : `Rejected${x.accountName ? `: ${x.accountName}` : ''}`;
    return `<li class="ob-decided-row" data-ein="${esc(g.ein)}">
      <div class="ob-decided-what"><button type="button" class="ob-open" data-open="${esc(g.ein)}">${esc(g.name)}</button><span class="ob-city">${esc(verb)} · ${esc(x.decidedBy)} · ${timeTag(x.decidedAt)}</span></div>
      <button type="button" class="btn btn-secondary btn-sm" data-undo="${esc(g.ein)}" data-fk="undo-${esc(g.ein)}"${S.deciding === g.ein ? ' disabled' : ''}>Undo</button>
    </li>`;
  }).join('');
  return `<div class="ob-decided">
      <button type="button" class="btn-link ob-decided-toggle" data-decided-toggle data-fk="decided-toggle" aria-expanded="${S.decidedOpen}">Decided (${nf(decided.length)})</button>
      ${S.decidedOpen ? `<ul class="ob-decided-list">${rows}</ul>` : ''}
    </div>`;
}

/** Runs a redraw without letting the page move: the scroll position is put back after it. */
function keepScroll(/** @type {() => void} */ redraw) {
  const y = window.scrollY;
  redraw();
  window.scrollTo(0, y);
}

/** Puts the cursor in the Deciding as box, which a decision needs, and brings it into view if it is off screen. */
function askForName() {
  const field = byId('obLinks').querySelector('[data-ctl="by"]');
  if (!(field instanceof HTMLInputElement)) return;
  field.focus();
  field.scrollIntoView({ block: 'nearest' });
}

/** Where a group's row sits in the panel as drawn now, so its decision can take its place. */
function panelIndex(/** @type {string} */ ein) {
  const d = S.data;
  if (!d || !d.loaded) return 0;
  const rows = panelRows(linksToConfirm(d.groups), S.lines, S.linksAll);
  return Math.max(0, rows.findIndex((r) => r.kind === 'link' && r.group.ein === ein));
}

/** Records a decision through the API, then reads the groups again so every count, status and draft follow it. The row becomes a line with an Undo. */
async function decide(/** @type {string} */ ein, /** @type {'confirm' | 'reject'} */ decision, /** @type {string | undefined} */ accountKey) {
  const group = S.data && S.data.loaded ? S.data.groups.find((g) => g.ein === ein) : undefined;
  if (!S.by.trim()) {
    S.linkMsg = { ein, text: 'Type your name in Deciding as first: it is stored as who decided.', error: true };
    keepScroll(renderLinks);
    askForName();
    return;
  }
  const index = panelIndex(ein);
  S.deciding = ein;
  S.linkMsg = null;
  keepScroll(renderLinks);
  try {
    await host.postJSON(`/outbound/${encodeURIComponent(ein)}/link`, { decision, by: S.by.trim(), ...(accountKey ? { accountKey } : {}) });
    S.lines = [...S.lines.filter((l) => l.ein !== ein), { ein, index, decision, name: group?.name ?? ein, candidate: group?.link.probable?.name ?? null }];
    S.details.delete(ein);
    S.data = await host.getJSON('/outbound');
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    S.linkMsg = { ein, error: true, text: /demo actions are off/.test(text) ? `Not recorded: the server has demo actions off. ${text}` : `Not recorded: ${text}` };
  }
  S.deciding = null;
  keepScroll(renderAll);
}

/** Takes a decision back through the API: the group returns to what the loader found, and its row returns to the panel. */
async function undo(/** @type {string} */ ein) {
  S.deciding = ein;
  S.linkMsg = null;
  keepScroll(renderLinks);
  try {
    await host.deleteJSON(`/outbound/${encodeURIComponent(ein)}/link`);
    S.lines = S.lines.filter((l) => l.ein !== ein);
    S.details.delete(ein);
    S.data = await host.getJSON('/outbound');
  } catch (e) {
    S.linkMsg = { ein, error: true, text: `Not undone: ${e instanceof Error ? e.message : String(e)}` };
  }
  S.deciding = null;
  keepScroll(renderAll);
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
    <span><svg class="ob-sw" viewBox="-8 -8 16 16" aria-hidden="true"><circle class="m-ring" r="7"/></svg>In a play</span>
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

  // mark order: ordinary groups, then groups in a play, then the selected one, so the ones that matter are never covered
  const rank = (/** @type {Group} */ g) => (g.ein === S.selected ? 2 : g.play ? 1 : 0);
  const marks = [...d.groups].sort((a, b) => rank(a) - rank(b)).map((g) => {
    const p = pointFor(g);
    if (!p) return '';
    const ring = g.play || g.ein === S.selected ? `<circle class="m-ring${g.ein === S.selected ? ' is-selected' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${MARK_SIZE + 4}"/>` : '';
    return `<g class="pt" data-ein="${esc(g.ein)}">${ring}${markSVG(p)}</g>`;
  }).join('');

  // labels without hover: the groups in a play and the selected group are named on the chart, on whichever side has room
  const named = d.groups.filter((g) => g.play || g.ein === S.selected);
  const labels = named.map((g) => {
    const p = pointFor(g);
    if (!p) return '';
    const left = p.x > plot.x1 - 130;
    const short = g.platform && g.play === 'platform' ? g.platform : g.name;
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
  const rows = sortGroups(filterGroups(d.groups, S.want), S.sort);
  const states = statesOf(d.groups);
  const counts = chipCounts(d.groups, S.want);
  const chips = FILTER_KEYS.map((k) => `<button type="button" class="chip${S.want.filter === k ? ' is-on' : ''}" data-filter="${k}" data-fk="filter-${k}" aria-pressed="${S.want.filter === k}">${esc(FILTERS[k].label)} <span class="chip-n">${counts.filter[k]}</span></button>`).join('');
  const statusChips = STATUS_CHIPS.map((c) => `<button type="button" class="chip${S.want.status === c.key ? ' is-on' : ''}" data-status="${c.key}" data-fk="status-${c.key}" aria-pressed="${S.want.status === c.key}">${esc(c.label)} <span class="chip-n">${counts.status[c.key]}</span></button>`).join('');
  const stateOpts = [`<option value="">All states</option>`, ...states.map(([s, n]) => `<option value="${esc(s)}"${S.want.state === s ? ' selected' : ''}>${esc(s)} (${n})</option>`)].join('');
  const sortOpts = Object.entries(SORTS).map(([k, c]) => `<option value="${k}"${S.sort.key === k ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
  const head = Object.entries(SORTS).map(([k, c]) => {
    const on = S.sort.key === k;
    const aria = on ? (S.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th class="ob-c-${k}${c.numeric ? ' num' : ''}" aria-sort="${aria}"><button type="button" class="ob-sort${on ? ' is-on' : ''}" data-sort="${k}" data-fk="sort-${k}">${esc(c.label)}<span class="ob-arrow" aria-hidden="true">${on ? (S.sort.dir === 'asc' ? '↑' : '↓') : ''}</span></button></th>`;
  }).join('');
  const body = rows.map((g) => rowHTML(g)).join('');
  const narrowed = [FILTERS[S.want.filter].label, STATUS_CHIPS.find((c) => c.key === S.want.status)?.label, S.want.state, S.want.query.trim() && `“${S.want.query.trim()}”`].filter(Boolean);
  byId('obList').innerHTML = `
    <div class="ob-tools">
      <h3 id="obListTitle">Groups</h3>
      <div class="chips" role="group" aria-label="Filter groups">${chips}</div>
      <div class="chips ob-status-chips" role="group" aria-label="Filter by status">${statusChips}</div>
      <div class="ob-fields">
        <label class="ob-field">State<select data-ctl="state" data-fk="state">${stateOpts}</select></label>
        <label class="ob-field ob-field-sort">Sort by<select data-ctl="sort" data-fk="sort-select">${sortOpts}</select></label>
        <label class="ob-field ob-field-search">Search<input data-ctl="query" data-fk="query" type="search" value="${esc(S.want.query)}" placeholder="Name, city or EIN"></label>
      </div>
    </div>
    <div class="ob-count" aria-live="polite">${nf(rows.length)} of ${nf(d.groups.length)} groups</div>
    ${rows.length ? `<table class="ob-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>` : `<div class="none ob-none"><b>No group matches.</b> Narrowed by ${narrowed.map((w) => `<b>${esc(w)}</b>`).join(', ')}. <button type="button" class="btn-link" data-act="reset" data-fk="reset">Clear filters</button></div>`}`;
}

function rowHTML(/** @type {Group} */ g) {
  const on = g.ein === S.selected;
  const label = statusLabel(g);
  const fit = g.status === 'not_target'
    ? `<span class="ob-nofit">${esc(label)}</span>`
    : `<span class="badge ${STATUS_BADGE[g.status]}" title="${esc(g.statusReason)}">${esc(label)}</span>`;
  const form = formLabel(g);
  return `<tr class="ob-row${on ? ' is-selected' : ''}"${on ? ' aria-current="true"' : ''} data-ein="${esc(g.ein)}">
    <td class="ob-c-name" data-label="Group"><button type="button" class="ob-open" data-open="${esc(g.ein)}" data-fk="open-${esc(g.ein)}">${esc(g.name)}</button><span class="ob-city">${esc(g.city)}</span></td>
    <td class="ob-c-state" data-label="State">${esc(g.state ?? '—')}</td>
    <td class="num ob-c-clinicians" data-label="Clinicians">${nf(g.clinicians)}</td>
    <td class="num ob-c-rate" data-label="Rate">${usd(g.rate)}</td>
    <td class="num ob-c-pct" data-label="% of Medicare">${g.pctOfMedicare}%</td>
    <td class="ob-c-form${g.form === 'neither' ? ' is-none' : ''}" data-label="Contract form">${esc(form)}</td>
    <td class="ob-c-status" data-label="Status">${fit}</td>
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
  /** @type {Group | undefined} */
  const listed = d.groups.find((x) => x.ein === g.ein);
  const work = p.work;
  const fitBadge = `<span class="badge ${STATUS_BADGE[/** @type {keyof typeof STATUS_BADGE} */ (work.status)]}">${esc(listed ? statusLabel(listed) : work.status)}</span>`;
  return `
    <header class="ob-d-head">
      <div class="ob-d-top">
        <div class="ob-d-name">${esc(g.name)}</div>
        <button type="button" class="btn btn-secondary btn-sm ob-close" data-act="close">Close</button>
      </div>
      <div class="ob-d-tools">
        <button type="button" class="btn btn-secondary btn-sm" data-copy-group="${esc(g.ein)}">Copy link</button><span class="copy-msg" role="status" aria-live="polite"></span>
      </div>
      <div class="ob-d-sub">${esc(place(g))} · <span class="idkey">EIN ${esc(g.ein)}</span> <span class="idkey">${esc(g.accountKey)}</span></div>
      <div class="ob-d-badges">${fitBadge}${draft ? draftBadge(draft) : ''}</div>
    </header>
    <p class="ob-nothing"><b>Nothing is sent from here.</b> There is no email code in this project, and the HubSpot request below is shown, not made.</p>
    ${findingSection(p, d)}
    ${rowsSection(p, d)}
    ${holderSection(p)}
    ${identitySection(p)}
    ${fitSection(p)}
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

/** Who already has the account, when someone does: the reason it is not prospected, and whose talking point it is. */
function holderSection(/** @type {any} */ p) {
  const h = p.work.holder;
  if (!h) return '';
  return `<section class="ob-sec ob-held"><h4>Not prospected</h4><p><b>${esc(h.owner)} has it.</b> ${esc(h.detail)}. The finding below is a talking point for them, not a draft.</p></section>`;
}

function identitySection(/** @type {any} */ p) {
  const l = p.link;
  const r = p.linkReview;
  if (!l || !r) return section('Registry', '<p>No link was stored for this group.</p>');
  const decided = r.decision ? ` ${esc(sentenceCase(r.decision.decision))} by ${esc(r.decision.decidedBy)} on ${timeTag(r.decision.decidedAt)}${r.decision.note ? ` (“${esc(r.decision.note)}”)` : ''}.` : '';
  let head;
  if (r.status === 'exact') head = `<p><span class="badge ok">Exact</span> Linked to <b>${esc(r.accountName)}</b> <span class="idkey">${esc(r.accountId)}</span>, matched on company name (score ${Number(l.score).toFixed(2)}; ${esc(l.reason)}). A lead from that organization gets this group’s rate line in its brief.</p>`;
  else if (r.status === 'confirmed') head = `<p><span class="badge ok">Confirmed</span> Belongs to <b>${esc(r.accountName)}</b> <span class="idkey">${esc(r.accountId)}</span>.${decided} A lead from that organization gets this group’s rate line in its brief.</p>`;
  else if (r.status === 'probable') head = `<p><span class="badge warn">Probable</span> The best candidate is <b>${esc(r.probable?.name)}</b> (${esc(r.why)}). Nothing names it as this group’s organization until a person confirms it in Links to confirm.</p>`;
  else if (r.status === 'rejected') head = `<p><span class="badge">Rejected</span>${r.probable ? ` Not part of <b>${esc(r.probable.name)}</b>.` : ''}${decided}</p>`;
  else head = `<p>Stands on its EIN: <span class="idkey">${esc(p.finding.accountKey)}</span>. It is not linked to a registry organization (${esc(l.reason)}). A link is made only on a unique, strong name match; a weak one is never guessed.</p>`;
  const cands = r.status !== 'exact' && (l.candidates || []).length
    ? `<table class="cands"><thead><tr><th>Closest registry name</th><th>State</th><th class="num">Match</th></tr></thead><tbody>${l.candidates.map((/** @type {any} */ c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.state || '—')}</td><td class="num">${Number(c.score).toFixed(2)}</td></tr>`).join('')}</tbody></table>`
    : '';
  return section('Registry', `${head}${cands}`, r.status);
}

/** Which play the group is in, or why it is in none, with the platform mapping when there is one. */
function fitSection(/** @type {any} */ p) {
  const g = p.finding;
  const w = p.work;
  const mapping = g.platform ? `<p class="meta-line">Mapped to <b>${esc(g.platform)}</b>, ${g.platformConfirmed ? 'confirmed' : 'not confirmed'}.</p>` : '';
  const title = w.play ? `Play: ${PLAY_WORDS[/** @type {keyof typeof PLAY_WORDS} */ (w.play)]}` : 'In no play';
  return section(title, `<p>${esc(w.statusReason)}</p>${w.play && w.team ? `<p class="meta-line">Worked by the ${esc(w.team)} team.</p>` : ''}${mapping}`);
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
      <div class="ob-mail-label">Email · ${draft.hook ? `${esc(HOOK_WORDS[/** @type {keyof typeof HOOK_WORDS} */ (draft.hook)] ?? draft.hook)} hook` : `${esc(PLAY_WORDS[/** @type {keyof typeof PLAY_WORDS} */ (p.work.play)] ?? '')} play`}</div>
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
  again?.focus({ preventScroll: true });
  if (again instanceof HTMLInputElement && caret != null) again.setSelectionRange(caret, caret);
}

/** The table's view changed: draw it, keep focus, and let the address follow. */
function changed(/** @type {() => void} */ apply) {
  apply();
  keepFocus(renderList);
  host.syncAddress({ push: false });
}

function onClick(/** @type {Event} */ e) {
  const t = /** @type {HTMLElement} */ (e.target);
  const sort = t.closest('[data-sort]');
  if (sort instanceof HTMLElement) {
    const key = sort.dataset.sort ?? 'name';
    changed(() => { S.sort = S.sort.key === key ? { key, dir: S.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: SORTS[key].first }; });
    return;
  }
  const chip = t.closest('[data-filter]');
  if (chip instanceof HTMLElement) {
    changed(() => { S.want = { ...S.want, filter: /** @type {import('./outbound-model.js').FilterKey} */ (chip.dataset.filter) }; });
    return;
  }
  const status = t.closest('[data-status]');
  if (status instanceof HTMLElement && S.data && S.data.loaded) {
    const groups = S.data.groups;
    changed(() => { S.want = pickStatus(S.want, /** @type {import('./outbound-model.js').Status} */ (status.dataset.status), groups); });
    return;
  }
  const act = t.closest('[data-link-act]');
  if (act instanceof HTMLElement && act.dataset.ein) {
    void decide(act.dataset.ein, act.dataset.linkAct === 'confirm' ? 'confirm' : 'reject', act.dataset.account);
    return;
  }
  const undoBtn = t.closest('[data-undo]');
  if (undoBtn instanceof HTMLElement && undoBtn.dataset.undo) { void undo(undoBtn.dataset.undo); return; }
  if (t.closest('[data-links-all]')) { S.linksAll = !S.linksAll; keepScroll(() => keepFocus(renderLinks)); return; }
  if (t.closest('[data-decided-toggle]')) { S.decidedOpen = !S.decidedOpen; keepScroll(() => keepFocus(renderLinks)); return; }
  if (t.closest('[data-jump-links]')) { byId('obLinks').scrollIntoView({ block: 'start' }); return; }
  const copy = t.closest('[data-copy-group]');
  if (copy instanceof HTMLElement && copy.dataset.copyGroup) { void copyAddress(`#outbound?ein=${encodeURIComponent(copy.dataset.copyGroup)}`, copy); return; }
  if (t.closest('[data-act="reset"]')) { changed(() => { S.want = { filter: 'all', status: '', state: '', query: '' }; }); return; }
  if (t.closest('[data-act="close"]')) { closeSheet(); return; }
  const opener = t.closest('[data-open], tr[data-ein], .pt[data-ein]');
  if (opener instanceof Element) {
    const ein = opener.getAttribute('data-open') ?? opener.getAttribute('data-ein');
    if (ein) {
      S.addressEin = ein;
      keepFocus(() => { select(ein, { sheet: true }); renderList(); });
      host.syncAddress({ push: true });
    }
  }
}

function onInput(/** @type {Event} */ e) {
  const t = e.target;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLSelectElement)) return;
  const ctl = t.dataset.ctl;
  if (!ctl) return;
  // the name is shared with Needs a person and remembered in this browser (decider.js)
  if (ctl === 'by') { S.by = t.value; saveDecider(t.value); return; }
  changed(() => {
    if (ctl === 'state') S.want = { ...S.want, state: t.value };
    else if (ctl === 'query') S.want = { ...S.want, query: t.value };
    else if (ctl === 'sort') S.sort = { key: t.value, dir: SORTS[t.value].first };
  });
}

/** Up and Down move between the group buttons in the table, so the list can be read by keyboard alone. */
function onKey(/** @type {KeyboardEvent} */ e) {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.matches('.ob-open') || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
  const all = Array.from(byId('obList').querySelectorAll('.ob-open'));
  const next = all[all.indexOf(t) + (e.key === 'ArrowDown' ? 1 : -1)];
  if (next instanceof HTMLElement) { e.preventDefault(); next.focus(); }
}
