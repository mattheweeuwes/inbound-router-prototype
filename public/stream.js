// The Lead stream's list: the route chips, the filters with their counts, the count line, the sortable header and the rows, with each
// uploaded list folded into one row. It holds the view (filters, sort, search) and draws it; which lead is open, and the trail on the
// right, stay with app.js. Every change to the view tells the host so the address can follow. The choosing, counting and ordering
// are in stream-model.js, which Node tests; this file only draws and listens.
import { keepFocus } from './focus.js';
import { lab, teamName } from './labels.js';
import {
  ROUTE_CHIPS, SORTS, TIERS, activeFilters, cleared, countLine, defaultView, facetCounts, fromParams, groupLabel, isFiltered, nextSort,
  rowsWithGroups, sortLeads, toParams, visible, without,
} from './stream-model.js';
import { shortParts, utcExact } from './time.js';
import { SRC_SHORT, TEAM_SHORT, actionPill, esc, fmtMs, tierBadge } from './ui.js';

/**
 * What app.js hands over: it opens a lead when a row is picked, and hears when the view changed so it can write the address.
 * @typedef {{
 *   onPick: (id: string, how: 'click' | 'key') => void,
 *   onChange: (how: 'view' | 'search') => void,
 *   selectedId: () => string | null,
 * }} Host
 * @typedef {import('./stream-model.js').Lead} Lead
 * @typedef {import('./stream-model.js').View} View
 * @typedef {{ chips: HTMLElement, bar: HTMLElement, count: HTMLElement, head: HTMLElement, list: HTMLElement, search: HTMLInputElement, pane: HTMLElement }} Els
 */

/** @type {{ leads: Lead[], loaded: boolean, fresh: Set<string>, view: View, open: Set<string>, shown: number, waiting: boolean }} */
const S = { leads: [], loaded: false, fresh: new Set(), view: defaultView(), open: new Set(), shown: 0, waiting: false };

/** @type {Host} */
let host;
/** @type {Els} */
let el;

/**
 * Wires the list's controls once. Returns what app.js calls.
 * @param {Els} els
 * @param {Host} h
 */
export function mountStream(els, h) {
  el = els;
  host = h;
  el.search.addEventListener('input', debounced(() => { S.view = { ...S.view, q: el.search.value }; render(); host.onChange('search'); }, 120));
  el.pane.addEventListener('click', onClick);
  el.pane.addEventListener('change', onChange);
  // a strip that waited for a select to be let go is drawn once the person leaves the control
  el.pane.addEventListener('focusout', (e) => { if (S.waiting && e.target instanceof HTMLSelectElement) setTimeout(() => render(), 0); });
  el.list.addEventListener('keydown', onKey);
  render();
  return { setLeads, applyParams, address: () => toParams(S.view), view: () => S.view, markSelected, reveal, openListOf, firstLeadId, render: () => render() };
}

/** @param {() => void} fn @param {number} ms */
function debounced(fn, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let t;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

/** The leads as the API sent them (newest first), and which of them arrived since the last read. */
function setLeads(/** @type {Lead[]} */ leads, /** @type {Set<string>} */ fresh) {
  S.leads = leads;
  S.loaded = true;
  S.fresh = fresh;
  render(true);
}

/** The address named a view: take it, show it in the search box, and draw. */
function applyParams(/** @type {Record<string, string>} */ params) {
  S.view = fromParams(params);
  el.search.value = S.view.q;
  render();
}

/** Opens the group holding a lead so the lead has a row to show. */
function openListOf(/** @type {string} */ id) {
  const name = S.leads.find((l) => l.id === id)?.list;
  if (name && !S.view.list && !S.open.has(name)) { S.open.add(name); render(); }
}

/** Marks the open lead's row without redrawing the list. */
function markSelected(/** @type {string | null} */ id) {
  for (const row of el.list.querySelectorAll('.row')) {
    const on = row instanceof HTMLElement && row.dataset.id === id;
    row.classList.toggle('is-selected', on);
    row.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

/** The lead at the top of the list as drawn, or null when no row shows. */
function firstLeadId() {
  const row = el.list.querySelector('.row');
  return row instanceof HTMLElement ? row.dataset.id ?? null : null;
}

/** Brings a lead's row into view if the list has it. */
function reveal(/** @type {string} */ id) {
  const row = el.list.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

// ─── drawing ─────────────────────────────────────────────────────────────────

/** What each control strip last drew, so a strip that would come out the same is left alone. */
const drawn = new WeakMap();

/**
 * Writes a control strip. A strip whose HTML has not changed keeps its nodes, so leads arriving do not replace the chip a
 * person is about to click. When leads arrive while a select in the strip is in use, the strip waits: replacing an open
 * select closes its menu under the person's hand. It is drawn when they pick a value or leave the control.
 * @param {HTMLElement} node @param {string} html @param {boolean} arriving
 */
function put(node, html, arriving) {
  if (drawn.get(node) === html) return;
  const active = document.activeElement;
  if (arriving && active instanceof HTMLSelectElement && node.contains(active)) { S.waiting = true; return; }
  node.innerHTML = html;
  drawn.set(node, html);
}

/** @param {boolean} [arriving] true when new leads caused this draw, false when the person did */
function render(arriving = false) {
  keepFocus(el.pane, () => {
    const v = S.view;
    const counts = facetCounts(S.leads, v);
    const shown = sortLeads(visible(S.leads, v), v.sort, v.dir);
    S.shown = shown.length;
    const rows = rowsWithGroups(shown, v, S.open);
    const folded = rows.filter((r) => r.kind === 'group').length;
    S.waiting = false;
    put(el.chips, routeChips(counts), arriving);
    put(el.bar, filterBar(counts), arriving);
    el.count.textContent = S.loaded ? countLine(shown.length, S.leads.length, folded) : '';
    put(el.head, headRow(), arriving);
    drawRows(rows);
  });
}

function routeChips(/** @type {ReturnType<typeof facetCounts>} */ counts) {
  return ROUTE_CHIPS.map((c) => `<button type="button" class="chip${S.view.route === c.key ? ' is-on' : ''}" data-route="${c.key}" data-fk="route-${c.key}" aria-pressed="${S.view.route === c.key}">${esc(c.label)} <span class="chip-n">${counts.route[c.key]}</span></button>`).join('');
}

function filterBar(/** @type {ReturnType<typeof facetCounts>} */ counts) {
  const v = S.view;
  const toggle = (/** @type {string} */ key, /** @type {string} */ label, /** @type {boolean} */ on, /** @type {number} */ n) =>
    `<button type="button" class="chip${on ? ' is-on' : ''}" data-toggle="${key}" data-fk="toggle-${key}" aria-pressed="${on}">${esc(label)} <span class="chip-n">${n}</span></button>`;
  const tiers = TIERS.map((t) => `<button type="button" class="chip${v.tier === t ? ' is-on' : ''}" data-tier="${t}" data-fk="tier-${t}" aria-pressed="${v.tier === t}" aria-label="Tier ${t}, ${counts.tier[t]} leads">${t} <span class="chip-n">${counts.tier[t]}</span></button>`).join('');
  const select = (/** @type {string} */ key, /** @type {string} */ label, /** @type {string} */ options) =>
    `<label class="sf-field">${esc(label)}<select data-select="${key}" data-fk="select-${key}">${options}</select></label>`;
  const opt = (/** @type {string} */ value, /** @type {string} */ text, /** @type {string} */ current) =>
    `<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(text)}</option>`;
  const total = (/** @type {[string, number][]} */ pairs) => pairs.reduce((a, [, n]) => a + n, 0);
  const team = select('team', 'Team', opt('', `All (${total(counts.team)})`, v.team) + counts.team.map(([k, n]) => opt(k, `${teamName(k)} (${n})`, v.team)).join(''));
  const door = select('door', 'Door', opt('', `All (${total(counts.door)})`, v.door) + counts.door.map(([k, n]) => opt(k, `${lab('source', k)} (${n})`, v.door)).join(''));
  const list = select('list', 'List', opt('', `All (${counts.list.all})`, v.list) + opt('none', `Not from a list (${counts.list.none})`, v.list)
    + counts.list.byName.map(([k, n]) => opt(k, `${k} (${n})`, v.list)).join(''));
  const named = activeFilters(v, accountLabel).filter((f) => f.key === 'account' || f.key === 'referrer')
    .map((f) => `<span class="sf-pill">${esc(f.label)}<button type="button" class="sf-x" data-remove="${f.key}" data-fk="remove-${f.key}" aria-label="Remove ${esc(f.label)}">×</button></span>`).join('');
  const clear = isFiltered(v) ? '<button type="button" class="btn-link sf-clear" data-clear data-fk="clear">Clear filters</button>' : '';
  // the sort control the header gives on a wide screen; on a phone the header is hidden and this stands in for it
  const sorter = `<span class="sf-field sf-sort"><label>Sort<select data-select="sort" data-fk="select-sort">${Object.entries(SORTS).map(([k, c]) => opt(k, c.label, v.sort)).join('')}</select></label>`
    + `<button type="button" class="chip" data-sort-dir data-fk="sort-dir" aria-label="Direction: ${v.dir === 'asc' ? 'ascending' : 'descending'}">${v.dir === 'asc' ? '↑' : '↓'}</button></span>`;
  return `${toggle('enterprise', 'Enterprise', v.enterprise, counts.enterprise)}${toggle('referral', 'Referral', v.referral, counts.referral)}
    <span class="sf-group" role="group" aria-label="Tier"><span class="sf-label">Tier</span>${tiers}</span>
    ${team}${door}${list}${sorter}${named}${clear}`;
}

/** The name of an account for its removable chip: the organization its leads carry, else the key. */
function accountLabel(/** @type {string} */ key) {
  return S.leads.find((l) => l.org?.accountId === key)?.org?.name ?? key;
}

function headRow() {
  const v = S.view;
  const head = (/** @type {import('./stream-model.js').SortKey} */ key, /** @type {string} */ label, cls = '') => {
    const on = v.sort === key;
    const arrow = on ? (v.dir === 'asc' ? '↑' : '↓') : '';
    return `<span class="lh-c ${cls}" role="columnheader" aria-sort="${on ? (v.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="sort${on ? ' is-on' : ''}" data-sort="${key}" data-fk="sort-${key}">${esc(label)}<span class="sort-arrow" aria-hidden="true">${arrow}</span></button></span>`;
  };
  return `${head('received', 'Received')}${head('tier', 'Tier')}${head('score', 'Score', 'num')}<span class="lh-c" role="columnheader">Lead</span>${head('org', 'Organization')}<span class="lh-c" role="columnheader">Routed to</span>${head('alert', 'Alert', 'num')}`;
}

/** @param {(import('./stream-model.js').GroupRow | import('./stream-model.js').LeadRow)[]} rows */
function drawRows(rows) {
  const list = el.list;
  const top = list.scrollTop;
  if (!S.loaded) {
    list.innerHTML = '<div class="none list-empty" role="status">Loading leads…</div>';
  } else if (!rows.length) {
    const why = activeFilters(S.view, accountLabel);
    list.innerHTML = why.length
      ? `<div class="none list-empty" role="status"><b>No leads match.</b> Narrowed by ${why.map((f) => `<b>${esc(f.label)}</b>`).join(', ')}. <button type="button" class="btn-link" data-clear data-fk="clear-empty">Clear filters</button></div>`
      : '<div class="none list-empty" role="status">No leads yet.</div>';
  } else {
    list.innerHTML = rows.map((r) => (r.kind === 'group' ? groupHTML(r) : rowHTML(r.lead, r.inGroup))).join('');
  }
  list.scrollTop = top;
  S.fresh = new Set();
}

function groupHTML(/** @type {import('./stream-model.js').GroupRow} */ g) {
  const mix = g.tiers.map(([t, n]) => `${n} ${t}`).join(' · ');
  const t = shortParts(g.newest);
  return `<div class="grow${g.open ? ' is-open' : ''}" role="presentation">
    <button type="button" class="g-toggle" data-group="${esc(g.name)}" data-fk="group-${esc(g.name)}" aria-expanded="${g.open}" aria-label="${esc(groupLabel(g))}. ${g.open ? 'Hide' : 'Show'} the rows">
      <span class="g-chev" aria-hidden="true">${g.open ? '▾' : '▸'}</span><b class="g-name">${esc(g.name)}</b><span class="g-count">${g.rows.toLocaleString('en-US')} ${g.rows === 1 ? 'row' : 'rows'}</span>
      <span class="g-mix">${esc(mix)}</span><span class="g-time" title="${esc(utcExact(g.newest))}">newest ${esc(t.day.split(',')[0])} ${esc(t.time)}</span>
    </button>
    <button type="button" class="btn-link g-only" data-only-list="${esc(g.name)}" data-fk="only-${esc(g.name)}">Only this list</button>
  </div>`;
}

/** The small marks beside a lead's name: enterprise, a named referral, the list it came on, a deal-size cue. Quiet on purpose. */
function marksHTML(/** @type {Lead} */ l, /** @type {boolean} */ inGroup) {
  const marks = [];
  if (l.enterprise) marks.push(`<span class="rmark rmark-ent" title="${esc(`Enterprise account${l.enterpriseFact ? `: ${l.enterpriseFact}` : ''}`)}">enterprise</span>`);
  if (l.referral) {
    const kind = l.referral.kind === 'customer' ? ', a customer' : l.referral.kind === 'known_org' ? ', not a customer' : ', organization not identified';
    marks.push(`<span class="rmark rmark-ref" title="${esc(`Referred by ${l.referral.referrer}${kind}`)}">referral</span>`);
  }
  if (l.list && !inGroup && S.view.list !== l.list) marks.push(`<span class="rmark rmark-list" title="${esc(`From the ${l.list} list`)}">${esc(l.list)}</span>`);
  if (l.dealCue) marks.push(`<span class="rmark rmark-deal" title="${esc(`Deal-size cue in the message: “${l.dealCue}”`)}">deal cue</span>`);
  return marks.length ? `<span class="rmarks">${marks.join('')}</span>` : '';
}

function rowHTML(/** @type {Lead} */ l, /** @type {boolean} */ inGroup) {
  const t = shortParts(l.receivedAt);
  const isSignal = !l.person;
  const name = isSignal ? 'Account signal' : (l.person?.name || l.person?.email || 'Unknown');
  const title = isSignal ? 'Website visits, no person' : (l.person?.title || '');
  const conf = l.org?.confidence || (l.org?.accountId ? 'high' : 'low');
  const orgName = l.org?.name || 'Not matched';
  const seg = l.org?.segment ? lab('segment', l.org.segment) : '';
  const isQueue = !!l.owner && / queue$/i.test(l.owner);
  const teamShort = l.routeTeam ? (TEAM_SHORT[l.routeTeam] || teamName(l.routeTeam)) : '';
  const owner = isQueue ? `${teamShort} queue` : (l.owner || teamShort || '');
  const team = !isQueue && l.owner && teamShort && !String(l.owner).includes(teamShort) ? teamShort : '';
  const sel = l.id === host.selectedId();
  const alert = l.timeToAlertMs == null ? '—' : fmtMs(l.timeToAlertMs);
  const alertTitle = l.timeToAlertMs == null ? 'No alert of its own: a list row goes out in its list digest, or nothing was alerted' : 'From the webhook to this lead\'s own alert';
  return `<div class="row${sel ? ' is-selected' : ''}${S.fresh.has(l.id) ? ' is-new' : ''}${inGroup ? ' in-group' : ''}" role="option" aria-selected="${sel}" data-id="${esc(l.id)}" data-fk="row-${esc(l.id)}" tabindex="-1">
    <div class="cell-time"><time datetime="${esc(l.receivedAt)}" title="${esc(utcExact(l.receivedAt))}">${esc(t.day.split(',')[0])} ${esc(t.time)}</time><br><span class="src">${esc(SRC_SHORT[l.source] || lab('source', l.source))}</span></div>
    <div class="cell-tier">${tierBadge(l.tier)}</div>
    <div class="num cell-score">${l.score == null ? '—' : esc(l.score)}</div>
    <div class="who">
      <div class="who-line"><span class="who-name">${esc(name)}</span>${marksHTML(l, inGroup)}</div>
      <div class="who-title">${esc(title)}</div>
    </div>
    <div class="org">
      <div class="org-name"><span class="cdot conf-${esc(conf)}"></span>${esc(orgName)}</div>
      <div class="org-sub">${esc(seg)}${l.flags.includes('free_mail') ? ' · free-mail' : ''}</div>
    </div>
    <div class="route-cell">${actionPill(l.routeAction)}<span class="route-owner">${esc(owner)}${team ? ` · ${esc(team)}` : ''}</span></div>
    <div class="num speed" title="${esc(alertTitle)}">${esc(alert)}</div>
  </div>`;
}

// ─── events ──────────────────────────────────────────────────────────────────

/** Sets the view, draws, and tells the host. */
function change(/** @type {View} */ view) {
  S.view = view;
  render();
  host.onChange('view');
}

function onClick(/** @type {Event} */ e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const route = t.closest('[data-route]');
  if (route instanceof HTMLElement) { change({ ...S.view, route: /** @type {View['route']} */ (route.dataset.route) }); return; }
  const toggle = t.closest('[data-toggle]');
  if (toggle instanceof HTMLElement) {
    const key = /** @type {'enterprise' | 'referral'} */ (toggle.dataset.toggle);
    // turning Referral off also drops a named referrer, which only makes sense with it on
    change({ ...S.view, [key]: !S.view[key], ...(key === 'referral' && S.view.referral ? { referrer: '' } : {}) });
    return;
  }
  const tier = t.closest('[data-tier]');
  if (tier instanceof HTMLElement) { change({ ...S.view, tier: S.view.tier === tier.dataset.tier ? '' : tier.dataset.tier ?? '' }); return; }
  if (t.closest('[data-sort-dir]')) { change({ ...S.view, dir: S.view.dir === 'asc' ? 'desc' : 'asc' }); return; }
  const sort = t.closest('[data-sort]');
  if (sort instanceof HTMLElement) { change({ ...S.view, ...nextSort(S.view, /** @type {import('./stream-model.js').SortKey} */ (sort.dataset.sort)) }); return; }
  const remove = t.closest('[data-remove]');
  if (remove instanceof HTMLElement) { change(without(S.view, remove.dataset.remove ?? '')); return; }
  if (t.closest('[data-clear]')) { el.search.value = ''; change(cleared(S.view)); return; }
  const only = t.closest('[data-only-list]');
  if (only instanceof HTMLElement) { change({ ...S.view, list: only.dataset.onlyList ?? '' }); return; }
  const group = t.closest('[data-group]');
  if (group instanceof HTMLElement) {
    const name = group.dataset.group ?? '';
    if (S.open.has(name)) S.open.delete(name); else S.open.add(name);
    render();
    return;
  }
  const row = t.closest('.row');
  if (row instanceof HTMLElement && row.dataset.id) { host.onPick(row.dataset.id, 'click'); row.focus({ preventScroll: true }); }
}

function onChange(/** @type {Event} */ e) {
  const t = e.target;
  if (!(t instanceof HTMLSelectElement) || !t.dataset.select) return;
  if (t.dataset.select === 'sort') {
    const key = /** @type {import('./stream-model.js').SortKey} */ (t.value);
    change({ ...S.view, sort: key, dir: SORTS[key].first });
    return;
  }
  change({ ...S.view, [t.dataset.select]: t.value });
}

/** Up and Down (or j and k) move through the rows that are showing, opening each lead as the cursor lands on it. */
function onKey(/** @type {KeyboardEvent} */ e) {
  if (!['ArrowDown', 'ArrowUp', 'j', 'k'].includes(e.key)) return;
  e.preventDefault();
  const rows = /** @type {HTMLElement[]} */ (Array.from(el.list.querySelectorAll('.row')));
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.dataset.id === host.selectedId());
  const next = e.key === 'ArrowDown' || e.key === 'j' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
  const id = rows[next].dataset.id;
  if (id) host.onPick(id, 'key');
  rows[next].scrollIntoView({ block: 'nearest' });
}

