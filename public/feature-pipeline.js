// The Feature to pipeline tab: which product features the accounts with deals were using around those deals, and which customers
// look ready for an add-on. It draws GET /api/attribution and nothing else. Read-only: it sends nothing and writes nothing.
// The numbers are influence, not proof of cause, and the page says so before it shows a single one. The wording and geometry with
// no DOM in them are in feature-pipeline-model.js.
import {
  OUTCOME_WORDS, adoptionWords, askedHow, barSegments, cueSummary, day, evidenceWords, headline, interestWords, launchWords, leadTimeWords, money, moneyShort,
  priceRange, provenanceBadges, rateWords, sampleNote,
} from './feature-pipeline-model.js';

/**
 * What app.js hands over: its API reader (live API or sample files) and its JSON highlighter.
 * @typedef {{ getJSON: (path: string) => Promise<any>, jsonHTML: (v: unknown) => string }} Host
 * @typedef {import('./feature-pipeline-model.js').Loaded} Loaded
 * @typedef {import('./feature-pipeline-model.js').NotLoaded} NotLoaded
 * @typedef {import('./feature-pipeline-model.js').Feature} Feature
 * @typedef {import('./feature-pipeline-model.js').Signal} Signal
 * @typedef {import('./feature-pipeline-model.js').Asked} Asked
 */

const esc = (/** @type {unknown} */ v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[/** @type {string} */ (c)] ?? c));
const nf = (/** @type {number} */ n) => n.toLocaleString('en-US');

/** @type {{ status: 'idle' | 'loading' | 'ready' | 'error', error: string, data: Loaded | NotLoaded | null, selected: string | null }} */
const S = { status: 'idle', error: '', data: null, selected: null };

/** @type {Host} */
let host;
let reading = Promise.resolve();

/** @param {string} id */
function byId(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from the page`);
  return el;
}

/**
 * Builds the tab inside `root` once. Returns what app.js needs: show() when the tab opens.
 * @param {HTMLElement} root
 * @param {Host} h
 */
export function mountFeaturePipeline(root, h) {
  host = h;
  root.innerHTML = '<div id="fpBody"></div>';
  root.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-feature]') : null;
    if (t instanceof HTMLElement && t.dataset.feature) { S.selected = t.dataset.feature; render(); }
  });
  return { show, select };
}

/** Another tab (Today) points at a feature: select it, once the API has been read, and draw. */
async function select(/** @type {string} */ feature) {
  await show();
  S.selected = feature;
  render();
}

/** The tab was opened: read the API the first time, draw from what is already read after that. */
async function show() {
  document.querySelector('.tab.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (S.status === 'idle' || S.status === 'error') reading = load();
  await reading;
}

async function load() {
  S.status = 'loading';
  render();
  try {
    S.data = await host.getJSON('/attribution');
    S.status = 'ready';
    const d = S.data;
    if (d && d.loaded && !S.selected) S.selected = d.features[0]?.feature ?? null;
  } catch (e) {
    S.status = 'error';
    S.error = e instanceof Error ? e.message : String(e);
  }
  render();
}

const notice = (/** @type {string} */ title, /** @type {string} */ text) => `<div class="card ob-empty"><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;

/** Sample mode has no attribution file; every other failure is shown as it came. */
const failureText = (/** @type {string} */ msg) => (/^no sample for/.test(msg) ? 'This tab reads the live API. Start the server with npm run dev, then reload.' : `The API answered: ${msg}`);

function render() {
  const body = byId('fpBody');
  const d = S.data;
  if (S.status === 'error') body.innerHTML = notice('Feature to pipeline is not available', failureText(S.error));
  else if (S.status !== 'ready') body.innerHTML = notice('Loading', 'Reading the usage and deals…');
  else if (d === null || !d.loaded) body.innerHTML = notice('No usage data is loaded', d?.reason || 'The usage fixtures were not found.');
  else body.innerHTML = pageHTML(d);
}

// ─── the page ────────────────────────────────────────────────────────────────

function pageHTML(/** @type {Loaded} */ d) {
  return `
    <div class="fp-head">${provenanceHTML(d)}<span class="fp-asof">Measured to ${esc(day(d.asOf))}, the newest event</span></div>
    <div class="ob-finding"><p class="ob-line">${esc(headline(d))}</p></div>
    <div class="card fp-caveat" role="note"><b>Influence, not proof of cause.</b> ${esc(d.model.caveat.replace(/^This is influence, not proof of cause\.\s*/, ''))}</div>
    ${tilesHTML(d)}
    ${chartHTML(d)}
    ${tableHTML(d)}
    ${dealsHTML(d)}
    ${askedHTML(d)}
    ${signalsHTML(d)}
    <p class="ob-chart-note fp-def"><b>The definition.</b> ${esc(d.model.definition)} ${esc(d.model.note)}</p>
    <p class="ob-chart-note fp-def"><b>Interest from inbound.</b> A person in the router's lead stream counts for a feature when they name it in their message, come in through its door, take a guide about it or (for an account's web visits) visit its pages. It is not usage, it is not in any win rate, and it never changes a lead's tier or route. A person who came in twice counts once.</p>`;
}

/** Visible on every view of the tab, one badge for each kind of data behind it, so the two are never read as one. */
function provenanceHTML(/** @type {Loaded} */ d) {
  const notes = { usage: d.synthetic.note, interest: d.synthetic.interest.note };
  return `<div class="fp-prov">${provenanceBadges(d).map((b) =>
    `<div class="fp-prov-row"><span class="syn fp-syn fp-syn-${b.kind}" title="${esc(b.title)}">${esc(b.text)}</span><span class="fp-syn-note">${esc(notes[b.kind])}</span></div>`).join('')}</div>`;
}

function tilesHTML(/** @type {Loaded} */ d) {
  const t = d.data.deals;
  const ev = d.data.events;
  const tile = (/** @type {string} */ label, /** @type {string} */ value, /** @type {string} */ sub) =>
    `<div class="card ob-stat"><div class="ob-stat-label">${esc(label)}</div><div class="ob-stat-value">${value}</div><div class="ob-stat-sub">${sub}</div></div>`;
  return `<div class="ob-stats" role="group" aria-label="The data behind the tab">
    ${tile('Deals', nf(t.total), `${nf(t.won.count)} won, ${nf(t.lost.count)} lost, ${nf(t.open.count)} open; ${nf(d.data.accounts)} accounts`)}
    ${tile('Pipeline in the data', esc(moneyShort(t.won.amount + t.lost.amount + t.open.amount)), `${esc(moneyShort(t.won.amount))} won, ${esc(moneyShort(t.open.amount))} open, ${esc(moneyShort(t.lost.amount))} lost`)}
    ${tile('Events', nf(ev.total), `${nf(ev.mapped)} mapped to a feature, ${nf(ev.unmapped)} unmapped, ${nf(ev.unresolved)} with no account`)}
    ${tile('Expansion signals', nf(d.expansion.signals.length), `customers using a preview, no add-on deal`)}
  </div>`;
}

// ─── the chart: pipeline each feature was around ─────────────────────────────

function chartHTML(/** @type {Loaded} */ d) {
  const features = d.features;
  const max = Math.max(0, ...features.map((f) => f.opportunities.amount));
  const rows = features.map((f) => {
    const segs = barSegments(f, max);
    const label = `${f.label}: ${nf(f.opportunities.count)} deals, ${money(f.opportunities.amount)}. ${segs.map((s) => `${OUTCOME_WORDS[s.key]} ${nf(s.count)}, ${money(s.amount)}`).join('; ')}.`;
    const bars = segs.map((s) => `<span class="fp-seg is-${s.key}" style="width:${s.pct.toFixed(2)}%"></span>`).join('');
    return `<li class="fp-bar-row${f.feature === S.selected ? ' is-selected' : ''}">
      <div class="fp-bar-name"><button type="button" class="ob-open" data-feature="${esc(f.feature)}">${esc(f.label)}</button><span class="fp-bar-sub">${nf(f.opportunities.count)} ${f.opportunities.count === 1 ? 'deal' : 'deals'}</span></div>
      <div class="fp-bar-track" role="img" aria-label="${esc(label)}">${bars}</div>
      <div class="fp-bar-val">${esc(money(f.opportunities.amount))}</div>
    </li>`;
  }).join('');
  const key = (/** @type {'won' | 'open' | 'lost'} */ k) => `<span><i class="fp-sw is-${k}" aria-hidden="true"></i>${OUTCOME_WORDS[k]}</span>`;
  return `<div class="card fp-chart">
    <div class="card-head"><h3>Pipeline each feature was around</h3><span class="sub">deal amounts by outcome; one deal counts under every feature it was around</span></div>
    <div class="legend fp-legend" aria-label="Chart key">${key('won')}${key('open')}${key('lost')}</div>
    <ol class="fp-bars">${rows}</ol>
  </div>`;
}

// ─── the table ───────────────────────────────────────────────────────────────

function tableHTML(/** @type {Loaded} */ d) {
  const rows = d.features.map((f) => rowHTML(f)).join('');
  return `<section class="card fp-list" aria-labelledby="fpTableTitle">
    <div class="card-head fp-table-head"><h3 id="fpTableTitle">Features</h3><span class="sub">counts first: a rate over a few closed deals is not a result</span></div>
    <table class="fp-table">
      <thead><tr>
        <th>Feature</th><th class="num">Accounts using</th><th class="num">Deals around it</th><th class="num">Closed won</th>
        <th class="num">Win rate with use</th><th class="num">Win rate without</th><th class="num">Median days, first use to deal</th><th class="num">Adoption since launch</th>
        <th class="num">Interest from inbound</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function rowHTML(/** @type {Feature} */ f) {
  const w = rateWords(f.winRate.with);
  const wo = rateWords(f.winRate.without);
  const lead = leadTimeWords(f);
  const ad = adoptionWords(f);
  const ask = interestWords(f);
  const on = f.feature === S.selected;
  const cell = (/** @type {string} */ big, /** @type {string} */ small) => `<span class="fp-big">${esc(big)}</span><span class="fp-small">${esc(small)}</span>`;
  const note = sampleNote(f, /** @type {Loaded} */ (S.data).model.smallSample);
  return `<tr class="fp-row${on ? ' is-selected' : ''}"${on ? ' aria-current="true"' : ''}>
    <td class="fp-c-name" data-label="Feature"><button type="button" class="ob-open" data-feature="${esc(f.feature)}">${esc(f.label)}</button>
      <span class="ob-city">${esc(launchWords(f))} · ${esc(f.team)}</span></td>
    <td class="num" data-label="Accounts using">${cell(nf(f.accountsUsing), `${nf(f.events)} events`)}</td>
    <td class="num" data-label="Deals around it">${cell(nf(f.opportunities.count), money(f.opportunities.amount))}</td>
    <td class="num" data-label="Closed won">${cell(nf(f.byOutcome.won.count), money(f.byOutcome.won.amount))}</td>
    <td class="num" data-label="Win rate with use">${cell(w.pct, w.counts)}</td>
    <td class="num" data-label="Win rate without">${cell(wo.pct, wo.counts)}${note ? `<span class="badge warn fp-flag" title="${esc(note)}">small sample</span>` : ''}</td>
    <td class="num" data-label="Median days, first use to deal">${cell(lead.value, lead.counts)}</td>
    <td class="num" data-label="Adoption since launch">${cell(ad.pct, ad.counts)}</td>
    <td class="num" data-label="Interest from inbound">${cell(ask.value, ask.counts)}</td>
  </tr>`;
}

// ─── the deals behind the selected feature ───────────────────────────────────

function dealsHTML(/** @type {Loaded} */ d) {
  const f = d.features.find((x) => x.feature === S.selected);
  if (!f) return '';
  const note = sampleNote(f, d.model.smallSample);
  const rows = f.deals.map((x) => `<tr>
      <td data-label="Deal"><span class="fp-deal-id">${esc(x.id)}</span>${x.addOn ? '<span class="badge fp-addon">add-on</span>' : ''}</td>
      <td data-label="Account">${esc(x.accountName)}</td>
      <td data-label="Stage">${esc(x.stage.replace('_', ' '))}</td>
      <td class="num" data-label="Amount">${esc(money(x.amount))}</td>
      <td data-label="Opened">${esc(day(x.createdAt))}</td>
      <td data-label="Closed">${x.closedAt ? esc(day(x.closedAt)) : 'open'}</td>
      <td class="num" data-label="Uses in the window">${nf(x.uses)}</td>
    </tr>`).join('');
  return `<section class="card fp-deals" aria-labelledby="fpDealsTitle" aria-live="polite">
    <div class="card-head"><h3 id="fpDealsTitle">Deals around ${esc(f.label)}</h3><span class="sub">${nf(f.deals.length)} ${f.deals.length === 1 ? 'deal' : 'deals'}, ${esc(money(f.opportunities.amount))}</span></div>
    ${note ? `<p class="fp-warn">${esc(note)}</p>` : ''}
    ${f.deals.length ? `<table class="fp-table fp-deal-table"><thead><tr><th>Deal</th><th>Account</th><th>Stage</th><th class="num">Amount</th><th>Opened</th><th>Closed</th><th class="num">Uses in the window</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="fp-none">No deal had an account using this feature in its window.</p>'}
  </section>`;
}

// ─── who asked for the selected feature ──────────────────────────────────────

function askedHTML(/** @type {Loaded} */ d) {
  const f = d.features.find((x) => x.feature === S.selected);
  if (!f) return '';
  const i = f.interest;
  const how = cueSummary(f);
  const customers = f.asked.filter((a) => a.customer).length;
  const head = i.leads
    ? `${nf(i.leads)} ${i.leads === 1 ? 'person' : 'people'} at ${nf(i.accounts)} ${i.accounts === 1 ? 'account' : 'accounts'}, ${nf(i.salesReady)} sales-ready${customers ? `; ${nf(customers)} at customers` : ''}. ${how}.`
    : 'Nobody in the lead stream has asked for this feature.';
  const since = i.sinceLaunch === null ? '' : ` ${nf(i.sinceLaunch)} came in after the launch.`;
  return `<section class="card fp-asked" aria-labelledby="fpAskedTitle" aria-live="polite">
    <div class="card-head"><h3 id="fpAskedTitle">Who asked for ${esc(f.label)}</h3><span class="sub">for customer success, newest first; nothing is sent</span></div>
    <p class="fp-asked-sum">${esc(head + since)}</p>
    ${f.asked.map((a) => askedItemHTML(a)).join('')}
  </section>`;
}

function askedItemHTML(/** @type {Asked} */ a) {
  const who = a.person ? `${esc(a.person.name)}${a.person.title ? `, ${esc(a.person.title)}` : ''}` : 'Account-level web visits, no person';
  return `<article class="fp-asked-item">
    <div class="fp-signal-head">
      <h4>${esc(a.accountName ?? 'Organization not identified')}</h4>
      <span class="badge${a.customer ? ' fp-cust' : ''}">${a.customer ? 'customer' : 'not a customer'}</span>
      <span class="fp-signal-meta">${a.owner ? `owner ${esc(a.owner)}` : 'no owner'} · ${esc(day(a.at))}</span>
    </div>
    <p>${who}</p>
    <p class="fp-signal-facts">${esc(askedHow(a))}</p>
    ${a.quote ? `<blockquote class="fp-quote">${esc(a.quote)}</blockquote>` : ''}
  </article>`;
}

// ─── expansion signals ───────────────────────────────────────────────────────

function signalsHTML(/** @type {Loaded} */ d) {
  const x = d.expansion;
  const body = x.signals.length
    ? x.signals.map((s) => signalHTML(s)).join('')
    : `<p class="fp-none">No customer account meets the rule at ${esc(day(d.asOf))}.</p>`;
  return `<section class="card fp-signals" aria-labelledby="fpSignalsTitle">
    <div class="card-head"><h3 id="fpSignalsTitle">Expansion signals</h3><span class="sub">for customer success; nothing is sent</span></div>
    <p class="fp-rule"><b>The rule.</b> ${esc(x.rule)}</p>
    ${body}
  </section>`;
}

function signalHTML(/** @type {Signal} */ s) {
  const a = s.account;
  return `<article class="fp-signal">
    <div class="fp-signal-head">
      <h4>${esc(a.name)}</h4>
      <span class="fp-signal-meta">${a.segment ? `${esc(a.segment.replace(/_/g, ' '))} · ` : ''}${a.owner ? `owner ${esc(a.owner)}` : 'no owner'}</span>
    </div>
    <p>Previewed ${esc(s.addOn.label)}. ${esc(evidenceWords(s))}</p>
    <p class="fp-signal-facts">No ${esc(s.addOn.label)} deal at any stage. The add-on lists at ${esc(priceRange(s.addOn))}.</p>
    <details class="ob-hs">
      <summary>HubSpot requests that would be made (dry run, not sent)</summary>
      ${requestsHTML(s)}
    </details>
  </article>`;
}

/** The dry-run requests, one collapsed block each, as the lead trail shows its CRM requests. */
function requestsHTML(/** @type {Signal} */ s) {
  const reqs = /** @type {{ method: string, path: string, note?: string, body: unknown }[]} */ (s.hubspot.requests);
  return reqs.map((r) => `<details class="req"><summary><span class="verb">${esc(r.method)}</span>${esc(r.path)}</summary>${r.note ? `<div class="meta-line ob-pad">${esc(r.note)}</div>` : ''}<pre class="json">${host.jsonHTML(r.body)}</pre></details>`).join('');
}
