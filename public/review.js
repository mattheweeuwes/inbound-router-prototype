// The Needs a person tab: every open review item with what a person decides from, and the decision itself (decision 33).
// A tie's candidates each get "Use this account"; every item gets "Send to nurture" or "Not a buyer"; a doubt the model
// raised gets "It is a buyer". A decided item is replaced in place by one line saying what happened, focus moves to the next
// item and the page does not move. A list's unplaced rows can go to nurture in one step. The wording, grouping and focus
// order are in review-model.js, which Node tests; this file only draws and listens.
import { readDecider, saveDecider } from './decider.js';
import {
  DEMO_OFF, decidedRow, displayOrder, groupItems, isUnplaced, itemButtons, matchText, NOT_BUYER_REASONS, nextFocus, nurtureAllConfirm,
  decidedHeading, nurtureAllLabel, openHeadline, reasonWords, rowsLeft,
} from './review-model.js';

/**
 * What app.js hands over: its API reader and writer, a way to set the tab's badge, to open a lead's trail, and to print a time.
 * @typedef {{
 *   getJSON: (path: string) => Promise<any>, postJSON: (path: string, body: unknown) => Promise<any>,
 *   onCount: (n: number) => void, openLead: (id: string) => void, fmtTime: (iso: string) => string,
 * }} Host
 * @typedef {import('./review-model.js').ReviewView} ReviewView
 * @typedef {import('./review-model.js').OpenItem} OpenItem
 */

const esc = (/** @type {unknown} */ v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[/** @type {string} */ (c)] ?? c));

/** @type {{ status: 'idle' | 'loading' | 'ready' | 'error', error: string, view: ReviewView | null, by: string, done: Set<string>, order: string[] }} */
const S = { status: 'idle', error: '', view: null, by: '', done: new Set(), order: [] };

/** @type {Host} */
let host;
/** @type {HTMLElement} */
let root;

/**
 * Builds the tab inside `el` once. Returns show() for when the tab opens, focusItem() to bring one item forward, and count()
 * for the badge.
 * @param {HTMLElement} el
 * @param {Host} h
 */
export function mountReview(el, h) {
  host = h;
  root = el;
  S.by = readDecider();
  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  // the tab has no view of its own to put in the address; an address that names a lead brings that item forward
  return { show, focusItem, count: () => openLeft(), address: () => ({}), applyAddress };
}

/** The tab was opened: read again, because items arrive and leave while it is closed. */
async function show() {
  if (!S.view) { S.status = 'loading'; render(); }
  try {
    S.view = await host.getJSON('/review');
    S.status = 'ready';
    S.done = new Set();
  } catch (e) {
    S.status = 'error';
    const msg = e instanceof Error ? e.message : String(e);
    // the page's sample mode has no review items to decide: say what the tab needs instead of the reader's error
    S.error = msg.startsWith('no sample') ? 'This tab reads and writes the live API. Start the server with npm run dev and open it again.' : msg;
  }
  render();
  host.onCount(openLeft());
}

const openLeft = () => (S.view ? S.view.open.filter((i) => !S.done.has(i.leadId)).length : 0);
const demoOn = () => !!S.view?.demoActions;

/** An address named a lead: bring its item forward once the items are drawn. */
function applyAddress(/** @type {Record<string, string>} */ params) {
  if (params.lead) focusItem(params.lead);
}

/** Brings one item into view, with its list's group open, and flashes it (from Today or the Overview). */
function focusItem(/** @type {string} */ id) {
  const card = /** @type {HTMLElement | null} */ (root.querySelector(`.rcard[data-id="${CSS.escape(id)}"]`));
  if (!card) return;
  const group = /** @type {HTMLDetailsElement | null} */ (card.closest('details.rlist'));
  if (group) group.open = true;
  card.scrollIntoView({ block: 'center' });
  card.classList.add('is-flash');
  setTimeout(() => card.classList.remove('is-flash'), 1700);
  card.focus({ preventScroll: true });
}

// ─── drawing ────────────────────────────────────────────────────────────────

function render() {
  if (S.status === 'loading') { root.innerHTML = '<div class="none">Loading…</div>'; return; }
  if (S.status === 'error') { root.innerHTML = `<div class="card ob-empty"><h3>Needs a person could not load</h3><p>${esc(S.error)}</p></div>`; return; }
  const v = /** @type {ReviewView} */ (S.view);
  S.order = displayOrder(v.open).map((i) => i.leadId);
  const { lists, single } = groupItems(v.open);
  root.innerHTML = `${barHTML(v)}<div class="review-list" id="rvList">${lists.map(listHTML).join('')}${single.map(cardHTML).join('')}${v.open.length ? '' : `<div class="none">${esc(openHeadline(0))}</div>`}</div><div id="rvDecided">${decidedHTML(v)}</div>`;
}

function barHTML(/** @type {ReviewView} */ v) {
  return `<div class="rv-bar">
    <label class="ob-field rv-by">Deciding as<input id="rvBy" type="text" value="${esc(S.by)}" placeholder="Your name" autocomplete="name" maxlength="80"></label>
    <span class="rv-count" id="rvCount" aria-live="polite">${esc(openHeadline(v.open.length))}</span>
    ${v.demoActions ? '' : `<p class="rv-off">${esc(DEMO_OFF)}</p>`}
    <p class="rv-msg" id="rvMsg" role="status"></p>
  </div>`;
}

function listHTML(/** @type {import('./review-model.js').ListGroup} */ g) {
  const off = demoOn() ? '' : ' disabled';
  // the list-wide button sits on the heading, so it is there while the list is collapsed
  const all = g.unplaced > 1 ? `<button type="button" class="btn btn-secondary btn-sm rv-all" data-act="nurture_all" data-list="${esc(g.name)}"${off} title="The rows nobody could place; each is recorded with your name">${esc(nurtureAllLabel(g.unplaced))}</button>` : '';
  return `<details class="rlist" data-list="${esc(g.name)}"><summary><b>${esc(g.name)}</b> · <span class="rv-left">${esc(rowsLeft(g.items.length))}</span>${all}</summary>${g.items.map(cardHTML).join('')}</details>`;
}

function cardHTML(/** @type {OpenItem} */ i) {
  const off = demoOn() && !i.busy ? '' : ' disabled';
  const said = i.companyTyped ? ` · said "${esc(i.companyTyped)}"` : '';
  const head = `<div class="rcard-top"><span class="rcard-name">${esc(i.person)}</span><span class="rcard-sub">${esc(i.title ?? '')}${said}</span><span class="badge warn">${esc(reasonWords(i.reason))}</span><button type="button" class="btn btn-ghost btn-sm open" data-id="${esc(i.leadId)}">Open the trail</button></div>`;
  const why = `<div class="rcard-why">${esc(i.route.reason ?? 'Sent to a person.')}${i.busy ? ' <b>It is running now; decide when it is done.</b>' : ''}</div>`;
  const cands = i.candidates.length && i.decisions.includes('use_account')
    ? `<table class="cands"><thead><tr><th>Candidate</th><th>State</th><th class="rv-key-col">Account key</th><th class="num">Match</th><th></th></tr></thead><tbody>${i.candidates.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.state || '—')}</td><td class="rv-key-col"><span class="idkey">${esc(c.accountId)}</span></td><td class="num">${esc(matchText(c.score))}</td><td class="rv-use"><button type="button" class="btn btn-secondary btn-sm" data-act="use_account" data-key="${esc(c.accountId)}"${off}>Use this account</button></td></tr>`).join('')}</tbody></table>`
    : '';
  const named = !i.candidates.length && i.decisions.includes('use_account')
    ? `<label class="ob-field rv-key">Account key, if you know it<input type="text" data-ctl="key" placeholder="crm:… or ahrq:…" spellcheck="false"${off}></label><button type="button" class="btn btn-secondary btn-sm" data-act="use_account"${off}>Use this account</button>`
    : '';
  const buttons = itemButtons(i).map((b) => b.decision === 'not_a_buyer'
    ? `<span class="rv-nb"><select data-ctl="reason" aria-label="Why it is not a buyer"${off}>${NOT_BUYER_REASONS.map((r) => `<option>${esc(r)}</option>`).join('')}</select><button type="button" class="btn btn-ghost btn-sm" data-act="not_a_buyer"${off}>${esc(b.label)}</button></span>`
    : `<button type="button" class="btn ${b.decision === 'is_buyer' ? 'btn-primary' : 'btn-secondary'} btn-sm" data-act="${b.decision}"${off}>${esc(b.label)}</button>`).join('');
  return `<div class="rcard" data-id="${esc(i.leadId)}" tabindex="-1">${head}${why}${cands}<div class="rcard-acts">${named}${buttons}</div><p class="rcard-msg" role="alert"></p></div>`;
}

function decidedHTML(/** @type {ReviewView} */ v) {
  if (!v.decided.length) return '';
  const rows = v.decided.map((d) => decidedRow(d, host.fmtTime)).map((r) => `<tr><td>${esc(r.person)}${r.company ? `<div class="rv-sub">${esc(r.company)}</div>` : ''}</td><td>${esc(r.what)}</td><td>${esc(r.outcome)}</td><td>${esc(r.who)}${r.note ? `<div class="rv-sub">"${esc(r.note)}"</div>` : ''}</td><td class="num">${esc(r.when)}</td></tr>`).join('');
  return `<details class="rdecided"><summary>${esc(decidedHeading(v.decided.length))}</summary><div class="rv-scroll"><table class="dtable"><thead><tr><th>Person</th><th>Decision</th><th>What happened</th><th>Who</th><th class="num">When</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

// ─── acting ─────────────────────────────────────────────────────────────────

function onInput(/** @type {Event} */ e) {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (t.id !== 'rvBy') return;
  S.by = t.value;
  saveDecider(t.value);
  say('');
}

function onClick(/** @type {MouseEvent} */ e) {
  const t = /** @type {HTMLElement} */ (e.target);
  const open = /** @type {HTMLElement | null} */ (t.closest('.open'));
  if (open?.dataset.id) { host.openLead(open.dataset.id); return; }
  const btn = /** @type {HTMLButtonElement | null} */ (t.closest('button[data-act]'));
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act ?? '';
  if (act === 'nurture_all') { e.preventDefault(); void nurtureAll(btn.dataset.list ?? ''); return; } // inside a summary: do not toggle it
  const card = /** @type {HTMLElement | null} */ (btn.closest('.rcard'));
  if (card?.dataset.id) void decide(card, act, btn);
}

/** The body a button sends, or a message saying what is missing. */
function bodyFor(/** @type {HTMLElement} */ card, /** @type {string} */ act, /** @type {HTMLButtonElement} */ btn) {
  if (act === 'use_account') {
    const key = btn.dataset.key ?? /** @type {HTMLInputElement | null} */ (card.querySelector('[data-ctl="key"]'))?.value.trim() ?? '';
    return key ? { decision: act, accountKey: key } : 'Type the account key first, such as crm:… or ahrq:….';
  }
  if (act === 'not_a_buyer') return { decision: act, reason: /** @type {HTMLSelectElement | null} */ (card.querySelector('[data-ctl="reason"]'))?.value ?? NOT_BUYER_REASONS[0] };
  return { decision: act };
}

async function decide(/** @type {HTMLElement} */ card, /** @type {string} */ act, /** @type {HTMLButtonElement} */ btn) {
  const id = /** @type {string} */ (card.dataset.id);
  if (!needName(card)) return;
  const body = bodyFor(card, act, btn);
  if (typeof body === 'string') { cardMsg(card, body); return; }
  setBusy(card, true);
  try {
    const r = await host.postJSON(`/leads/${encodeURIComponent(id)}/review`, { ...body, by: S.by.trim() });
    markDecided(id, r.outcome);
    void refreshDecided();
  } catch (e) {
    setBusy(card, false);
    cardMsg(card, e instanceof Error ? e.message : String(e));
  }
}

async function nurtureAll(/** @type {string} */ list) {
  const g = groupItems(S.view?.open ?? []).lists.find((x) => x.name === list);
  const group = /** @type {HTMLElement | null} */ (root.querySelector(`details.rlist[data-list="${CSS.escape(list)}"]`));
  if (!g || !group || !needName(group)) return;
  const n = g.items.filter((i) => isUnplaced(i) && !S.done.has(i.leadId)).length;
  if (!n || !window.confirm(nurtureAllConfirm(n, list))) return;
  const btn = /** @type {HTMLButtonElement | null} */ (group.querySelector('[data-act="nurture_all"]'));
  if (btn) btn.disabled = true;
  try {
    const r = await host.postJSON('/review/list', { list, by: S.by.trim() });
    for (const id of /** @type {string[]} */ (r.decided)) markDecided(id, 'Sent to nurture', false);
    say(`${r.count} row${r.count === 1 ? '' : 's'} from ${list} sent to nurture${r.skipped?.length ? `; ${r.skipped.length} left because ${r.skipped[0].error}` : ''}.`);
    btn?.remove();
    const next = S.order.find((x) => !S.done.has(x));
    focusCard(next ?? null);
    void refreshDecided();
  } catch (e) {
    if (btn) btn.disabled = false;
    say(e instanceof Error ? e.message : String(e));
  }
}

/** True when a name is typed; otherwise puts focus in the name field, which sits at the top of the tab and stays in view. */
function needName(/** @type {HTMLElement} */ near) {
  if (S.by.trim()) return true;
  const input = /** @type {HTMLInputElement | null} */ (root.querySelector('#rvBy'));
  say('Type your name in Deciding as first: it is stored as who decided.');
  if (near.classList.contains('rcard')) cardMsg(near, 'Type your name in Deciding as first.');
  // the bar sticks under the top bar on a desktop, so focus need not scroll; on a phone it scrolls with the page
  const sticky = !!input && getComputedStyle(/** @type {HTMLElement} */ (input.closest('.rv-bar'))).position === 'sticky';
  input?.focus({ preventScroll: sticky });
  return false;
}

/**
 * Replaces the item with one line saying what happened, moves focus to the next open item and updates the counts. The
 * card stays where it was and only gets shorter, so the page does not jump.
 */
function markDecided(/** @type {string} */ id, /** @type {string} */ outcome, focusNext = true) {
  const card = /** @type {HTMLElement | null} */ (root.querySelector(`.rcard[data-id="${CSS.escape(id)}"]`));
  S.done.add(id);
  if (card) {
    const name = card.querySelector('.rcard-name')?.textContent ?? '';
    card.classList.add('is-decided');
    card.innerHTML = `<div class="rcard-top"><span class="rv-done" aria-hidden="true">✓</span><span class="rcard-name">${esc(name)}</span><span class="rv-outcome">${esc(outcome)}</span><button type="button" class="btn btn-ghost btn-sm open" data-id="${esc(id)}">Open the trail</button></div>`;
  }
  updateCounts();
  if (focusNext) focusCard(nextFocus(S.order, id, S.done));
}

function focusCard(/** @type {string | null} */ id) {
  const next = /** @type {HTMLElement | null} */ (id ? root.querySelector(`.rcard[data-id="${CSS.escape(id)}"]`) : null);
  if (!next) { /** @type {HTMLElement | null} */ (root.querySelector('#rvBy'))?.focus({ preventScroll: true }); return; }
  const group = /** @type {HTMLDetailsElement | null} */ (next.closest('details.rlist'));
  if (group && !group.open) { group.querySelector('summary')?.focus({ preventScroll: true }); return; }
  const target = /** @type {HTMLElement} */ (next.querySelector('button[data-act]:not([disabled])') ?? next);
  target.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest' });
}

function updateCounts() {
  const left = openLeft();
  const c = root.querySelector('#rvCount');
  if (c) c.textContent = openHeadline(left);
  for (const g of groupItems(S.view?.open ?? []).lists) {
    const el = root.querySelector(`details.rlist[data-list="${CSS.escape(g.name)}"] .rv-left`);
    const n = g.items.filter((i) => !S.done.has(i.leadId)).length;
    if (el) el.textContent = rowsLeft(n);
  }
  host.onCount(left);
}

/** Reads the decided list again and redraws only it, so nothing above it moves. */
async function refreshDecided() {
  try {
    const v = /** @type {ReviewView} */ (await host.getJSON('/review'));
    if (!S.view) return;
    S.view.decided = v.decided;
    const box = root.querySelector('#rvDecided');
    const wasOpen = !!box?.querySelector('details[open]');
    if (box) box.innerHTML = decidedHTML(S.view);
    if (wasOpen) box?.querySelector('details')?.setAttribute('open', '');
  } catch { /* the next visit reads it */ }
}

function setBusy(/** @type {HTMLElement} */ card, /** @type {boolean} */ busy) {
  card.querySelectorAll('button[data-act], select, input').forEach((b) => { /** @type {HTMLButtonElement} */ (b).disabled = busy; });
  card.classList.toggle('is-busy', busy);
  if (busy) cardMsg(card, '');
}

function cardMsg(/** @type {HTMLElement} */ card, /** @type {string} */ text) {
  const m = card.querySelector('.rcard-msg');
  if (m) m.textContent = text;
}

function say(/** @type {string} */ text) {
  const m = root.querySelector('#rvMsg');
  if (m) m.textContent = text;
}
