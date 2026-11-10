// The Today tab: where the team starts the morning. It draws GET /api/brief (needs a person, enterprise, referrals, list uploads,
// expansion signals, outbound, feature interest, health) and the accounts table from GET /api/accounts, enterprise accounts
// first. A sticky index at the top jumps to each section with its count. A section shows its top rows and opens up in place; the
// "and N more" under it opens the tab that holds the rest, with the matching filter. Every row is a link to an address (see
// address-model.js). Read-only: it decides, sends and writes nothing; the brief is built from read models that already exist. The
// wording, order and targets with no DOM in them are in today-model.js; the accounts table is accounts.js.
import { mountAccounts } from './accounts.js';
import { keepFocus } from './focus.js';
import { indexHTML, wireIndex } from './section-index.js';
import { timeTag, withLocalTimes } from './time.js';
import { addressOf, figureValue, indexEntries, lookbackWords, moreAddress, moreTarget, openLabel, rowsHidden, rowsShown, sectionsInOrder } from './today-model.js';

/**
 * What app.js hands over: its API reader, and a way to say the view changed so the address follows.
 * @typedef {{ getJSON: (path: string) => Promise<any>, syncAddress: (opts?: { push?: boolean }) => void }} Host
 * @typedef {import('./today-model.js').Brief} Brief
 * @typedef {import('./today-model.js').Section} Section
 * @typedef {import('./today-model.js').Item} Item
 * @typedef {import('./today-model.js').Account} Account
 */

const esc = (/** @type {unknown} */ v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[/** @type {string} */ (c)] ?? c));

/** @type {{ status: 'idle' | 'loading' | 'ready' | 'error', error: string, brief: Brief | null, total: number, open: Set<string>, scrollToAccounts: boolean }} */
const S = { status: 'idle', error: '', brief: null, total: 0, open: new Set(), scrollToAccounts: false };

/** @type {Host} */
let host;
/** @type {HTMLElement} */
let root;
/** @type {ReturnType<typeof mountAccounts>} */
let accounts;

/** The accounts the table asks for: the API's ceiling, so every account is reachable. */
const ACCOUNT_ROWS = 500;

/**
 * Builds the tab inside `el` once. Returns what app.js needs: show() when the tab opens, applyAddress(params) for a view an address
 * names, and address() for the view's parameters.
 * @param {HTMLElement} el
 * @param {Host} h
 */
export function mountToday(el, h) {
  host = h;
  root = el;
  root.innerHTML = '<div id="tdBody"></div>';
  accounts = mountAccounts(root, { onChange: () => host.syncAddress({ push: false }) });
  root.addEventListener('click', onClick);
  wireIndex(root);
  return { show, applyAddress, address: () => accounts.address() };
}

/** The tab was opened: read again every time, because this page is the answer to "what is new". */
async function show() {
  document.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  await load();
}

/** An address named a view of the accounts table: take it, and bring the table into view when it narrows it. */
function applyAddress(/** @type {Record<string, string>} */ params) {
  accounts.applyParams(params);
  S.scrollToAccounts = accounts.hasFilters();
  render();
}

async function load() {
  S.status = S.brief ? S.status : 'loading';
  render();
  try {
    const [brief, list] = await Promise.all([host.getJSON('/brief'), host.getJSON(`/accounts?limit=${ACCOUNT_ROWS}`)]);
    S.brief = brief;
    S.total = list.total;
    accounts.setAccounts(list.accounts);
    S.status = 'ready';
  } catch (e) {
    S.status = 'error';
    S.error = e instanceof Error ? e.message : String(e);
  }
  render();
}

function onClick(/** @type {Event} */ e) {
  const t = e.target instanceof Element ? e.target.closest('button') : null;
  if (!(t instanceof HTMLButtonElement)) return;
  if (t.dataset.refresh !== undefined) { void load(); return; }
  if (t.dataset.expand) {
    const id = t.dataset.expand;
    if (S.open.has(id)) S.open.delete(id); else S.open.add(id);
    render();
  }
}

const notice = (/** @type {string} */ title, /** @type {string} */ text) => `<div class="card ob-empty"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
const failureText = (/** @type {string} */ msg) => (/^no sample for/.test(msg) ? 'This tab reads the live API. Start the server with npm run dev, then reload.' : `The API answered: ${msg}`);

function render() {
  const body = root.querySelector('#tdBody');
  if (!(body instanceof HTMLElement)) return;
  keepFocus(body, () => {
    if (S.status === 'error') body.innerHTML = notice('Today is not available', failureText(S.error));
    else if (S.status !== 'ready' || !S.brief) body.innerHTML = notice('Loading', 'Reading the brief…');
    else body.innerHTML = pageHTML(S.brief);
  });
  if (S.scrollToAccounts && S.status === 'ready') {
    S.scrollToAccounts = false;
    root.querySelector('#tdAccounts')?.scrollIntoView({ block: 'start' });
  }
}

function pageHTML(/** @type {Brief} */ b) {
  return `
    <div class="td-head"><p class="td-asof">As of ${timeTag(b.generatedAt, 'full')}. ${esc(lookbackWords(b))}</p><button type="button" class="btn btn-secondary td-refresh" data-refresh>Refresh</button></div>
    ${indexHTML(indexEntries(b, S.total), 'Sections on this page')}
    <div class="td-grid">${sectionsInOrder(b).map(sectionHTML).join('')}</div>
    <section class="card td-accounts" id="tdAccounts" data-index-id="accounts" aria-labelledby="tdAccountsTitle">${accounts.html(S.total)}</section>`;
}

function sectionHTML(/** @type {Section} */ s) {
  const figures = s.figures.map((f) => `<div class="td-fig"><span class="td-fig-v">${esc(figureValue(f))}</span><span class="td-fig-l">${esc(f.label)}</span></div>`).join('');
  const open = S.open.has(s.id);
  const hidden = rowsHidden(s);
  const rows = s.items.length ? `<ul class="td-items">${rowsShown(s, open).map(itemHTML).join('')}</ul>` : '<p class="td-none">Nothing here.</p>';
  const toggle = hidden
    ? `<button type="button" class="btn-link td-toggle" data-expand="${esc(s.id)}" data-fk="expand-${esc(s.id)}" aria-expanded="${open}">${open ? 'Show fewer' : `Show all ${s.items.length}`}</button>`
    : '';
  const more = s.more && (open || !hidden)
    ? `<p class="td-more">and ${s.more.toLocaleString('en-US')} more, in <a href="${esc(moreAddress(s))}">${esc(moreTarget(s).words)}</a></p>`
    : '';
  return `<section class="card td-card" aria-labelledby="td-${esc(s.id)}" data-section="${esc(s.id)}" data-index-id="${esc(s.id)}">
    <div class="card-head"><h3 id="td-${esc(s.id)}">${esc(s.title)}</h3><span class="td-count">${s.count.toLocaleString('en-US')}</span></div>
    <p class="td-headline">${esc(s.headline)}</p>
    <div class="td-figs">${figures}</div>
    ${rows}${toggle}${more}
  </section>`;
}

function itemHTML(/** @type {Item} */ i) {
  return `<li class="td-item">
    <span class="td-kind">${esc(i.kind)}</span>
    <div class="td-main"><b>${esc(i.title)}</b><span>${withLocalTimes(i.detail)}</span></div>
    <a class="td-open" href="${esc(addressOf(i))}">${esc(openLabel(i))}</a>
  </li>`;
}
