// The Today tab: where the team starts the morning. It draws GET /api/brief (needs a person, enterprise, referrals, list uploads,
// expansion signals, outbound, feature interest, health) and the accounts table from GET /api/accounts, enterprise accounts
// first. Every row opens the tab that holds its detail. Read-only: it decides, sends and writes nothing; the brief is built from
// read models that already exist. The wording and order with no DOM in them are in today-model.js.
import { accountRow, asOfWords, figureValue, openLabel, sectionsInOrder } from './today-model.js';

/**
 * What app.js hands over: its API reader and the function that opens a lead, review item, group, list or feature in its own tab.
 * @typedef {{ getJSON: (path: string) => Promise<any>, go: (target: { tab: import('./today-model.js').Tab, leadId?: string, accountKey?: string, ein?: string, list?: string, feature?: string }) => void }} Host
 * @typedef {import('./today-model.js').Brief} Brief
 * @typedef {import('./today-model.js').Section} Section
 * @typedef {import('./today-model.js').Item} Item
 * @typedef {import('./today-model.js').Account} Account
 */

const esc = (/** @type {unknown} */ v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[/** @type {string} */ (c)] ?? c));

/** @type {{ status: 'idle' | 'loading' | 'ready' | 'error', error: string, brief: Brief | null, accounts: { total: number, accounts: Account[] } | null, note: string }} */
const S = { status: 'idle', error: '', brief: null, accounts: null, note: '' };

/** @type {Host} */
let host;
/** @type {HTMLElement} */
let root;

/** How many accounts the table asks for; the API says how many there are in all. */
const ACCOUNT_ROWS = 25;

/**
 * Builds the tab inside `el` once. Returns what app.js needs: show() when the tab opens.
 * @param {HTMLElement} el
 * @param {Host} h
 */
export function mountToday(el, h) {
  host = h;
  root = el;
  root.innerHTML = '<div id="tdBody"></div>';
  root.addEventListener('click', onClick);
  return { show };
}

/** The tab was opened: read again every time, because this page is the answer to "what is new". */
async function show() {
  document.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  await load();
}

async function load() {
  S.status = S.brief ? S.status : 'loading';
  render();
  try {
    const [brief, accounts] = await Promise.all([host.getJSON('/brief'), host.getJSON(`/accounts?limit=${ACCOUNT_ROWS}`)]);
    S.brief = brief;
    S.accounts = accounts;
    S.status = 'ready';
  } catch (e) {
    S.status = 'error';
    S.error = e instanceof Error ? e.message : String(e);
  }
  render();
}

/** @param {Event} e */
async function onClick(e) {
  const t = e.target instanceof Element ? e.target.closest('button') : null;
  if (!(t instanceof HTMLButtonElement)) return;
  if (t.dataset.refresh !== undefined) { await load(); return; }
  if (t.dataset.account) { await openAccount(t.dataset.account); return; }
  if (t.dataset.tab) {
    const { tab, lead, account, ein, list, feature } = t.dataset;
    host.go(/** @type {any} */ ({ tab, leadId: lead, accountKey: account, ein, list, feature }));
  }
}

/**
 * The account's newest person opens in the lead stream; an account with nobody in says so where the row is.
 * @param {string} key
 */
async function openAccount(key) {
  try {
    const d = await host.getJSON(`/accounts/${encodeURIComponent(key)}`);
    const lead = d.people?.[0]?.leadId;
    if (lead) { S.note = ''; host.go({ tab: 'stream', leadId: lead }); return; }
    S.note = `${d.name ?? key} has no person in the stream yet, only signals.`;
  } catch (err) {
    S.note = `The account could not be opened: ${err instanceof Error ? err.message : String(err)}`;
  }
  render();
}

const notice = (/** @type {string} */ title, /** @type {string} */ text) => `<div class="card ob-empty"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
const failureText = (/** @type {string} */ msg) => (/^no sample for/.test(msg) ? 'This tab reads the live API. Start the server with npm run dev, then reload.' : `The API answered: ${msg}`);

function render() {
  const body = root.querySelector('#tdBody');
  if (!body) return;
  if (S.status === 'error') body.innerHTML = notice('Today is not available', failureText(S.error));
  else if (S.status !== 'ready' || !S.brief || !S.accounts) body.innerHTML = notice('Loading', 'Reading the brief…');
  else body.innerHTML = pageHTML(S.brief, S.accounts);
}

function pageHTML(/** @type {Brief} */ b, /** @type {{ total: number, accounts: Account[] }} */ a) {
  return `
    <div class="td-head"><p class="td-asof">${esc(asOfWords(b))}</p><button type="button" class="btn btn-secondary td-refresh" data-refresh>Refresh</button></div>
    <div class="td-grid">${sectionsInOrder(b).map(sectionHTML).join('')}</div>
    ${accountsHTML(a)}
    <p class="ob-chart-note td-note">The brief decides nothing. It lists what the dashboard, the outbound module, the usage module and the accounts API already hold, with the ids to open each one. Nothing on this page is sent.</p>`;
}

function sectionHTML(/** @type {Section} */ s) {
  const figures = s.figures.map((f) => `<div class="td-fig"><span class="td-fig-v">${esc(figureValue(f))}</span><span class="td-fig-l">${esc(f.label)}</span></div>`).join('');
  const rows = s.items.length
    ? `<ul class="td-items">${s.items.map(itemHTML).join('')}</ul>${s.more ? `<p class="td-more">and ${s.more} more, in the tab</p>` : ''}`
    : '<p class="td-none">Nothing here.</p>';
  return `<section class="card td-card" aria-labelledby="td-${esc(s.id)}" data-section="${esc(s.id)}">
    <div class="card-head"><h3 id="td-${esc(s.id)}">${esc(s.title)}</h3><span class="td-count">${s.count.toLocaleString('en-US')}</span></div>
    <p class="td-headline">${esc(s.headline)}</p>
    <div class="td-figs">${figures}</div>
    ${rows}
  </section>`;
}

function itemHTML(/** @type {Item} */ i) {
  const d = i.ids;
  const attrs = [['tab', i.tab], ['lead', d.leadId], ['account', d.accountKey], ['ein', d.ein], ['list', d.list], ['feature', d.feature]]
    .filter(([, v]) => v).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<li class="td-item">
    <span class="td-kind">${esc(i.kind)}</span>
    <div class="td-main"><b>${esc(i.title)}</b><span>${esc(i.detail)}</span></div>
    <button type="button" class="td-open" ${attrs}>${esc(openLabel(i))}</button>
  </li>`;
}

function accountsHTML(/** @type {{ total: number, accounts: Account[] }} */ a) {
  const rows = a.accounts.map((x) => accountRow(x));
  const body = rows.map((r) => `<tr class="td-arow${r.enterprise ? ' is-enterprise' : ''}">
      <td class="td-c-name" data-label="Account"><button type="button" class="ob-open" data-account="${esc(r.key)}">${esc(r.name)}</button>${r.enterprise ? '<span class="badge td-ent">enterprise</span>' : ''}</td>
      <td data-label="Fact">${esc(r.fact)}</td>
      <td data-label="Owner">${esc(r.owner)}</td>
      <td class="num" data-label="People in">${r.people}</td>
      <td data-label="Latest activity">${esc(r.latest)}</td>
      <td data-label="Signals">${esc(r.signals)}</td>
    </tr>`).join('');
  return `<section class="card td-accounts" aria-labelledby="tdAccountsTitle">
    <div class="card-head"><h3 id="tdAccountsTitle">Accounts</h3><span class="sub">enterprise first, then by account score; ${rows.length} of ${a.total.toLocaleString('en-US')}</span></div>
    ${S.note ? `<p class="fp-warn" role="status">${esc(S.note)}</p>` : ''}
    ${rows.length ? `<table class="td-table"><thead><tr><th>Account</th><th>Fact</th><th>Owner</th><th class="num">People in (30 days)</th><th>Latest activity</th><th>Signals</th></tr></thead><tbody>${body}</tbody></table>`
      : '<p class="td-none">No account has come in yet.</p>'}
  </section>`;
}
