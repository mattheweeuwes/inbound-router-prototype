// Today's accounts table: every account the router holds, enterprise first, that a person can search, filter to enterprise, no owner or
// a referral, sort by a column and read in full ("Show more"). A row opens that account's people in the Lead stream. Read-only. The
// choosing and ordering are in accounts-model.js, which Node tests; this file only draws and listens.
import {
  FIRST_ROWS, MORE_ROWS, activeWords, cleared, countLine, counts, defaultView, fromParams, isFiltered, nextSort, page, sortAccounts, toParams, visible,
} from './accounts-model.js';
import { buildAddress } from './address-model.js';
import { keepFocus } from './focus.js';
import { accountRow } from './today-model.js';
import { timeTag } from './time.js';
import { esc, tierBadge } from './ui.js';

/**
 * @typedef {import('./today-model.js').Account} Account
 * @typedef {import('./accounts-model.js').View} View
 * @typedef {{ onChange: () => void }} Host
 */

/** @type {{ accounts: Account[], view: View }} */
const S = { accounts: [], view: defaultView() };
/** @type {HTMLElement} */
let el;
/** @type {Host} */
let host;

/**
 * Listens for the table's controls once, on `root` (the Today tab's own element, which outlives every redraw of the page). The table is
 * the section with id tdAccounts inside it. Returns what today.js calls.
 * @param {HTMLElement} root
 * @param {Host} h
 */
export function mountAccounts(root, h) {
  el = root;
  host = h;
  el.addEventListener('click', onClick);
  el.addEventListener('input', onInput);
  return { setAccounts, applyParams, address: () => toParams(S.view), html, hasFilters: () => isFiltered(S.view) };
}

function setAccounts(/** @type {Account[]} */ accounts) { S.accounts = accounts; }

function applyParams(/** @type {Record<string, string>} */ params) { S.view = fromParams(params); }

/** Draws the table again in place, keeping focus where it was. */
function redraw() {
  const box = el.querySelector('#tdAccounts');
  if (box) keepFocus(box, () => { box.innerHTML = html(); });
}

/** The section's markup. `total` is how many accounts the router holds. */
function html(total = S.accounts.length) {
  const v = S.view;
  const n = counts(S.accounts, v);
  const matching = sortAccounts(visible(S.accounts, v), v.sort, v.dir);
  const { rows, left, more } = page(matching.length, v.shown);
  const head = (/** @type {import('./accounts-model.js').SortKey} */ key, /** @type {string} */ label, cls = '') => {
    const on = v.sort === key;
    return `<th class="${cls}" aria-sort="${on ? (v.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="ob-sort${on ? ' is-on' : ''}" data-sort="${key}" data-fk="asort-${key}">${esc(label)}<span class="ob-arrow" aria-hidden="true">${on ? (v.dir === 'asc' ? '↑' : '↓') : ''}</span></button></th>`;
  };
  const toggle = (/** @type {string} */ key, /** @type {string} */ label, /** @type {boolean} */ on, /** @type {number} */ count) =>
    `<button type="button" class="chip${on ? ' is-on' : ''}" data-toggle="${key}" data-fk="atoggle-${key}" aria-pressed="${on}">${esc(label)} <span class="chip-n">${count}</span></button>`;
  const body = matching.slice(0, rows).map((a) => rowHTML(accountRow(a), a)).join('');
  const words = activeWords(v);
  const empty = `<p class="td-none" role="status"><b>No account matches.</b> ${words.length ? `Narrowed by ${words.map((w) => `<b>${esc(w)}</b>`).join(', ')}. ` : ''}<button type="button" class="btn-link" data-clear data-fk="aclear-empty">Clear filters</button></p>`;
  return `<div class="card-head"><h3 id="tdAccountsTitle">Accounts</h3><span class="sub">enterprise first, then by account score</span></div>
    <div class="td-tools">
      ${toggle('enterprise', 'Enterprise only', v.enterprise, n.enterprise)}${toggle('noOwner', 'No owner', v.noOwner, n.noOwner)}${toggle('referral', 'Has a referral', v.referral, n.referral)}
      <label class="ob-field td-search">Search<input type="search" data-search data-fk="asearch" value="${esc(v.q)}" placeholder="Account, owner or fact" autocomplete="off"></label>
      ${isFiltered(v) ? '<button type="button" class="btn-link" data-clear data-fk="aclear">Clear filters</button>' : ''}
    </div>
    <div class="ob-count" role="status" aria-live="polite">${esc(countLine(matching.length, total))}</div>
    ${matching.length
      ? `<table class="td-table"><thead><tr>${head('name', 'Account')}<th>Fact</th>${head('owner', 'Owner')}${head('score', 'Score', 'num')}${head('people', 'People in (30 days)', 'num')}${head('latest', 'Latest activity')}<th>Signals</th></tr></thead><tbody>${body}</tbody></table>`
        + (left ? `<div class="td-showmore"><button type="button" class="btn btn-secondary btn-sm" data-more data-fk="amore">Show ${more} more</button><span class="muted">${left.toLocaleString('en-US')} not shown</span></div>` : '')
      : empty}`;
}

/** @param {ReturnType<typeof accountRow>} r @param {Account} a */
function rowHTML(r, a) {
  const href = buildAddress('stream', { account: r.key });
  return `<tr class="td-arow${r.enterprise ? ' is-enterprise' : ''}">
      <td class="td-c-name" data-label="Account"><a class="td-account" href="${esc(href)}" title="Open ${esc(r.name)}'s people in the Lead stream">${esc(r.name)}</a>${r.enterprise ? '<span class="badge td-ent">enterprise</span>' : ''}</td>
      <td data-label="Fact">${esc(r.fact)}</td>
      <td data-label="Owner">${esc(r.owner)}</td>
      <td class="num" data-label="Score">${a.topTier ? tierBadge(a.topTier) : ''} ${esc(a.accountScore)}</td>
      <td class="num" data-label="People in">${r.people}</td>
      <td data-label="Latest activity">${timeTag(r.latestAt)}</td>
      <td data-label="Signals">${esc(r.signals)}</td>
    </tr>`;
}

function onClick(/** @type {Event} */ e) {
  const t = e.target instanceof Element && e.target.closest('#tdAccounts') ? e.target : null;
  if (!t) return;
  const sort = t.closest('[data-sort]');
  if (sort instanceof HTMLElement) { S.view = { ...S.view, ...nextSort(S.view, /** @type {import('./accounts-model.js').SortKey} */ (sort.dataset.sort)), shown: FIRST_ROWS }; redraw(); host.onChange(); return; }
  const toggle = t.closest('[data-toggle]');
  if (toggle instanceof HTMLElement) {
    const key = /** @type {'enterprise' | 'noOwner' | 'referral'} */ (toggle.dataset.toggle);
    S.view = { ...S.view, [key]: !S.view[key], shown: FIRST_ROWS };
    redraw(); host.onChange(); return;
  }
  if (t.closest('[data-clear]')) { S.view = cleared(S.view); redraw(); host.onChange(); return; }
  if (t.closest('[data-more]')) { S.view = { ...S.view, shown: S.view.shown + MORE_ROWS }; redraw(); }
}

function onInput(/** @type {Event} */ e) {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || t.dataset.search === undefined || !t.closest('#tdAccounts')) return;
  S.view = { ...S.view, q: t.value, shown: FIRST_ROWS };
  redraw();
  host.onChange();
}

