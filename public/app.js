/* Inbound Router cockpit. Vanilla JS, no build step.
 * Live mode: talks to the API on the same origin and follows /api/stream.
 * Sample mode: if the API is not reachable, reads public/mock/*.json and keeps checking for the API.
 * The Overview tab renders GET /api/dashboard and refreshes from /api/stream, throttled.
 * The address (location.hash) names the tab and what is open or filtered in it: address-model.js. */
import { lab, teamName } from './labels.js';
import { buildAddress, parseAddress, sameAddress } from './address-model.js';
import { TZ, fullTime, shortParts, timeTag, utcExact } from './time.js';
import { TEAM_SHORT, actionPill, esc, fmtMs, tierBadge } from './ui.js';
import { mountStream } from './stream.js';
import { indexHTML, wireIndex } from './section-index.js';
import { copyAddress } from './copy-link.js';

const STAGE_ORDER = ['received', 'normalized', 'resolved', 'qualified', 'scored', 'routed', 'notified', 'synced', 'done'];
const TERMINAL = new Set(['done', 'failed', 'duplicate']);

// ─── state ───────────────────────────────────────────────────────────────────
let stream = null; // the Lead stream's list (stream.js), mounted in wire()
const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;
const state = {
  mode: null, // 'live' | 'sample'
  leads: [],
  known: new Set(),
  fresh: new Set(),
  dash: null,
  reviewOpen: null, // open review items as Needs a person last counted them, or null to use the dashboard's count
  tableView: {},
  seenFeed: new Set(),
  evalData: null,
  quality: null,
  selectedId: null,
  details: new Map(),
  tab: 'overview',
  addressLead: null, // the lead the address names, once a person has chosen one (the first lead is shown without being in the address)
  follow: false,
  sse: null,
  pollTimer: null,
  probeTimer: null,
};

// ─── helpers ─────────────────────────────────────────────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const fmtShort = shortParts;
const fmtFull = fullTime;
function dueText(dueIso, fromIso) {
  const a = fmtShort(dueIso);
  const b = fmtShort(fromIso);
  return a.day && a.day !== b.day ? `${a.day.split(',')[0]} ${a.time}` : a.time;
}
const pct = (x) => (x == null ? '—' : `${Math.round(Number(x) * 100)}%`);
function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(timer));
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function jsonHTML(v) {
  const raw = JSON.stringify(v, null, 2) ?? 'null';
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(raw))) {
    out += esc(raw.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="k">${esc(m[1])}</span>${esc(m[2])}` : `<span class="s">${esc(m[1])}</span>`;
    else if (m[3]) out += `<span class="b">${m[3]}</span>`;
    else out += `<span class="n">${m[0]}</span>`;
    last = re.lastIndex;
  }
  return out + esc(raw.slice(last));
}
function mrkdwn(t) {
  let s = esc(t || '');
  s = s.replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>');
  s = s.replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return s.replace(/\n(?!<blockquote>)/g, '<br>').replace(/<\/blockquote><br>/g, '</blockquote>');
}
// ─── data layer ──────────────────────────────────────────────────────────────
async function probeLive() {
  try {
    const r = await fetchWithTimeout('/api/metrics', {}, 1500);
    const ct = r.headers.get('content-type') || '';
    return r.ok && ct.includes('json');
  } catch {
    return false;
  }
}
async function getJSON(path) {
  if (state.mode === 'live') {
    const r = await fetchWithTimeout(`/api${path}`, {}, 8000);
    if (!r.ok) {
      let msg = `${r.status}`;
      try { msg = (await r.json()).error || msg; } catch { /* keep status */ }
      throw new Error(msg);
    }
    return r.json();
  }
  // sample mode
  if (path.startsWith('/leads/')) {
    const id = decodeURIComponent(path.slice('/leads/'.length));
    const r = await fetch(`mock/lead-${encodeURIComponent(id)}.json`);
    if (r.ok) return r.json();
    const s = state.leads.find((l) => l.id === id);
    if (!s) throw new Error('not found');
    return { ...s };
  }
  const file = path.startsWith('/leads') ? 'leads' : path.startsWith('/metrics') ? 'metrics' : path.startsWith('/eval') ? 'eval' : path.startsWith('/dashboard') ? 'dashboard' : null;
  if (!file) throw new Error('no sample for ' + path);
  const r = await fetch(`mock/${file}.json`);
  if (!r.ok) throw new Error(`sample ${file} missing`);
  return r.json();
}
async function deleteJSON(path) {
  const r = await fetchWithTimeout(`/api${path}`, { method: 'DELETE' }, 15000);
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}
async function postJSON(path, body) {
  const r = await fetchWithTimeout(`/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 15000);
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

function setMode(mode) {
  state.mode = mode;
  const pill = $('#modePill');
  pill.classList.toggle('live', mode === 'live');
  pill.classList.toggle('sample', mode === 'sample');
  $('#modeText').textContent = mode === 'live' ? 'Live API' : 'Sample data · API offline';
  $('#submitBtn').disabled = mode !== 'live';
  renderStrip();
}

// ─── loading ─────────────────────────────────────────────────────────────────
async function loadList() {
  try {
    const data = await getJSON('/leads?limit=1000');
    const leads = Array.isArray(data.leads) ? data.leads : [];
    leads.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    const firstLoad = state.known.size === 0;
    for (const l of leads) {
      if (!state.known.has(l.id)) {
        if (!firstLoad) state.fresh.add(l.id);
        state.known.add(l.id);
      }
    }
    state.leads = leads;
    drawList();
    // the first lead in the list opens by itself on a wide screen, so the trail is never an empty pane; on a phone it would cover the list
    if (state.follow && leads.length && leads[0].id !== state.selectedId) select(leads[0].id, { keepFollow: true });
    if (!state.selectedId && leads.length && !isNarrow()) select(stream.firstLeadId() ?? leads[0].id, { how: 'auto' });
    if (state.addressLead) stream.openListOf(state.addressLead);
    if (state.revealLead && leads.some((l) => l.id === state.revealLead)) { stream.reveal(state.revealLead); state.revealLead = null; }
    renderReviewTabCount();
  } catch (e) {
    $('#leadList').innerHTML = `<div class="none" style="padding:16px">Couldn't load leads: ${esc(e.message)}</div>`;
  }
}
async function loadEval() {
  try {
    state.evalData = await getJSON('/eval');
  } catch {
    state.evalData = null;
  }
  renderEval();
}
async function loadQuality() {
  const body = $('#qualityBody');
  if (!state.quality) body.innerHTML = '<div class="none">Loading…</div>';
  try {
    state.quality = await getJSON('/quality');
  } catch (e) {
    state.quality = null;
    body.innerHTML = `<div class="card" style="max-width:760px"><h3>No scorecard</h3></div>`;
    return;
  }
  renderQuality();
}
const refreshList = debounce(() => { loadList(); scheduleDashboard(); }, 250);
const refreshDetail = debounce(() => { if (state.selectedId) loadDetail(state.selectedId, true); }, 200);

async function loadDetail(id, quiet = false) {
  const pane = $('#detail');
  const cached = state.details.get(id);
  if (cached && TERMINAL.has(cached.status) && !quiet) {
    renderDetail(cached);
    return;
  }
  if (!quiet && !cached) pane.innerHTML = '<div class="none" style="padding:16px 14px">Loading…</div>';
  try {
    const d = await getJSON(`/leads/${encodeURIComponent(id)}`);
    state.details.set(id, d);
    if (state.selectedId === id) renderDetail(d);
  } catch (e) {
    if (state.selectedId === id) pane.innerHTML = `<div class="empty"><div class="empty-title">Couldn't load this lead: ${esc(e.message)}</div></div>`;
  }
}

/**
 * Opens a lead's trail. `how` says who asked: a click or a typed address is something to remember in the address (a click adds a
 * history entry, so Back returns to the lead before); arrow keys and the first-lead default do not.
 */
function select(id, { keepFollow = false, how = 'auto' } = {}) {
  if (!keepFollow) state.follow = false;
  state.selectedId = id;
  stream.markSelected(id);
  loadDetail(id);
  if (how === 'click' || how === 'key') {
    state.addressLead = id;
    syncAddress({ push: how === 'click' });
  }
  if (isNarrow() && how !== 'auto') $('#detail').classList.add('is-open');
}

// the open review items: the tab's own count once it has read them, else the dashboard's, which counts the same rows
/** Draws the lead list from what is loaded. */
function drawList() {
  stream.setLeads(state.leads, state.fresh);
  state.fresh = new Set();
}
function renderReviewTabCount() {
  const n = state.reviewOpen ?? (state.dash ? state.dash.review.length : state.leads.filter((l) => l.routeAction === 'review').length);
  const el = $('#reviewCount');
  el.textContent = String(n);
  el.dataset.zero = n === 0 ? 'true' : 'false';
}

// ─── detail ──────────────────────────────────────────────────────────────────
function stageState(d, key, hasData, warn) {
  const idx = STAGE_ORDER.indexOf(d.status);
  const k = STAGE_ORDER.indexOf(key);
  if (hasData || (idx >= 0 && idx >= k)) return warn ? 'warn' : 'done';
  if (d.status === 'error' || d.status === 'failed') return 'warn';
  if (TERMINAL.has(d.status)) return 'wait';
  return idx + 1 === k ? 'run' : 'wait';
}
function stage(cls, name, note, ms, body) {
  return `<section class="stage ${cls}">
    <span class="stage-dot" aria-hidden="true"></span>
    <div class="stage-head"><span class="stage-name">${esc(name)}</span><span class="stage-note">${note ? esc(note) : ''}</span>${ms != null ? `<span class="stage-ms">${esc(fmtMs(ms))}</span>` : ''}</div>
    ${body ? `<div class="stage-body">${body}</div>` : ''}
  </section>`;
}
const kv = (pairs) => `<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const notRecorded = '<span style="color:var(--muted)">Not recorded</span>';

function renderDetail(d) {
  const pane = $('#detail');
  const isSignal = !d.person;
  const name = isSignal ? 'Account signal' : (d.person.name || d.person.email);
  const sub = isSignal
    ? `${d.org?.name || ''} · website visits, no person`
    : [d.person.title, d.org?.name || d.normalized?.companyNameRaw, d.person.email].filter(Boolean).join(' · ');
  const sc = d.score || {};
  const r = d.route || {};
  const t = d.timings || {};
  const tierCls = `tier-${d.tier ?? sc.tier ?? 'none'}`;
  const routeMain = r.action
    ? `${actionPill(r.action)} <span class="arrow">→</span> <span class="d-verdict-main">${esc(r.owner || teamName(r.team) || lab('action', r.action))}</span>${r.owner && r.team ? ` <span style="color:var(--muted)">${esc(teamName(r.team))}</span>` : ''}${r.slaMinutes != null ? ` <span class="pill act-nurture">SLA ${esc(r.slaMinutes)} min${r.slaDueAt ? `, due ${esc(dueText(r.slaDueAt, d.receivedAt))}` : ''}</span>` : ''}${r.rule ? ` <span class="idkey">${esc(r.rule)}</span>` : ''}`
    : `${actionPill(d.routeAction)}`;

  let html = `<div class="d-head">
    <div class="d-tools">
      <button type="button" class="btn btn-secondary btn-sm d-back" data-close-detail>Back to the list</button>
      <button type="button" class="btn btn-secondary btn-sm" data-copy-lead="${esc(d.id)}">Copy link</button>
      <span class="copy-msg" role="status" aria-live="polite"></span>
    </div>
    <div class="d-top">
      <div class="d-tier tier ${tierCls}">${esc(d.tier ?? sc.tier ?? '·')}</div>
      <div class="d-title">
        <div class="d-name">${esc(name)} ${d.synthetic !== false ? '<span class="syn">SYNTHETIC</span>' : ''}</div>
        <div class="d-sub">${esc(sub)}</div>
      </div>
      <div class="d-score">
        <div class="d-score-num">${esc(sc.total ?? d.score ?? '–')}</div>
        <div class="d-score-lbl">${sc.fit != null ? `fit ${esc(sc.fit)} · intent ${esc(sc.intent)}` : 'score'}</div>
      </div>
    </div>
    <div class="d-verdict">${routeMain}${r.reason ? `<div class="d-verdict-reason">${esc(r.reason)}</div>` : ''}
      <div class="d-verdict-reason" style="color:var(--muted)">Routed in ${esc(fmtMs(d.timeToRouteMs ?? t.total))} from the webhook${d.receivedAt ? ` · received ${timeTag(d.receivedAt, 'full')}` : ''}</div>
    </div>
  </div><div class="trail">`;

  if (d.status === 'duplicate' || (d.flags || []).includes('idempotent_replay')) {
    html += stage('warn', 'Webhook re-delivery', 'Same source event ID as an earlier delivery', null,
      '<div class="meta-line">Stored once. This delivery did nothing: no second lead, no second alert.</div>');
  }

  // 1 received
  const n = d.normalized || null;
  const dd = d.dedupe || {};
  const rawBlock = d.raw ? `<details class="raw-toggle"><summary>Raw webhook payload</summary><pre class="json">${jsonHTML(d.raw)}</pre></details>` : '';
  html += stage(stageState(d, 'received', true), 'Received', `${lab('source', d.source)} webhook`, null,
    kv([
      ['Door', esc(lab('source', d.source))],
      ['Received', timeTag(d.receivedAt, 'full')],
      ['Contact key', dd.contactKey ? `<span class="idkey">${esc(dd.contactKey)}</span>` : notRecorded],
      t.queued != null ? ['Queue wait', esc(fmtMs(t.queued))] : null,
      dd.duplicateOf ? ['Repeat of', `<a class="jump" href="${leadHref(dd.duplicateOf)}">earlier lead</a> (${esc(dd.priorTouches ?? 1)} prior touch${dd.priorTouches === 1 ? '' : 'es'})`] : null,
    ]) + rawBlock);

  // 2 normalized
  if (n) {
    const fixes = (n.utmFixes || []).map((f) => `<div class="fix">${esc(f.field)}: <s>${esc(JSON.stringify(f.from))}</s> → <ins>${esc(JSON.stringify(f.to))}</ins></div>`).join('');
    const utm = n.utm && Object.values(n.utm).some(Boolean)
      ? ['source', 'medium', 'campaign', 'content', 'term'].filter((k) => n.utm[k]).map((k) => `${k}=${esc(n.utm[k])}`).join(' · ')
      : '<span style="color:var(--muted)">none</span>';
    html += stage(stageState(d, 'normalized', true), 'Normalized', `${lab('channel', n.channel, 'unknown channel')} · ${(n.utmFixes || []).length} tag fix${(n.utmFixes || []).length === 1 ? '' : 'es'}`, t.normalize,
      kv([
        ['Email', `${esc(n.email)}${n.isFreeMail ? ' <span class="flag">free-mail</span>' : ''}${n.isDisposable ? ' <span class="flag flag-competitor">disposable</span>' : ''}`],
        ['Title', `${esc(n.title || '—')}${n.titleFunction ? ` <span style="color:var(--muted)">→ ${esc(lab('fn', n.titleFunction))}, ${esc(lab('seniority', n.titleSeniority))}</span>` : ''}`],
        n.companyNameRaw ? ['Company field', esc(n.companyNameRaw)] : null,
        ['Location', esc([n.state, n.country].filter(Boolean).join(', ') || '—')],
        ['Campaign tags', utm + fixes],
        ['Channel', esc(lab('channel', n.channel))],
        n.message ? ['Message', `<span>${esc(n.message)}</span>`] : null,
      ]));
  } else {
    html += stage(stageState(d, 'normalized', false), 'Normalized', '', t.normalize, null);
  }

  // 3 resolved
  const res = d.resolution;
  if (res) {
    const warn = res.status !== 'resolved' && res.status !== 'not_applicable';
    const f = res.firmographics || {};
    const firmo = [
      f.hospitals != null ? `${f.hospitals} hospital${f.hospitals === 1 ? '' : 's'}` : null,
      f.beds != null ? `${Number(f.beds).toLocaleString()} beds` : null,
      f.states && f.states.length ? f.states.join(', ') : null,
      f.payerKind ? `payer: ${f.payerKind}` : null,
      f.taxonomy ? f.taxonomy : null,
      f.npi ? `NPI ${f.npi}` : null,
      f.ccns && f.ccns.length ? `CCN ${f.ccns.slice(0, 3).join(', ')}${f.ccns.length > 3 ? ` +${f.ccns.length - 3}` : ''}` : null,
    ].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
    const cands = (res.candidates || []).length
      ? `<table class="cands"><thead><tr><th>Candidate</th><th>State</th><th>Account key</th><th class="num">Match</th></tr></thead><tbody>${res.candidates.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.state || '—')}</td><td><span class="idkey">${esc(c.accountId || '—')}</span></td><td class="num">${esc(c.score != null ? Number(c.score).toFixed(2) : '—')}</td></tr>`).join('')}</tbody></table>`
      : '';
    const head = res.accountId
      ? `<div><b>${esc(res.accountName || d.org?.name || '')}</b> <span class="idkey">${esc(res.accountId)}</span> <span class="seg">${esc(lab('segment', res.segment))}</span></div>`
      : `<div><b>${res.status === 'ambiguous' ? 'More than one possible account' : 'No account matched'}</b> <span class="seg">${esc(lab('segment', res.segment, ''))}</span></div>`;
    const ev = (res.evidence || []).length
      ? `<ul class="evidence">${res.evidence.map((e) => `<li><span class="ev-step">${esc(e.step)}</span><span>${esc(e.detail)}</span></li>`).join('')}</ul>` : '';
    html += stage(stageState(d, 'resolved', true, warn), 'Resolved', `${lab('method', res.method)} · ${res.confidence || '—'} confidence`, t.resolve,
      head + (firmo ? `<div class="firmo">${firmo}</div>` : '') + ev + cands);
  } else {
    html += stage(stageState(d, 'resolved', false), 'Resolved', '', t.resolve, null);
  }

  // 4 qualified
  const q = d.qualification;
  if (q && q.final) {
    const fz = q.final;
    const llm = q.llm || null;
    const rules = q.rules || {};
    const src = fz.sources || {};
    const agreeObj = q.agreement && typeof q.agreement === 'object' ? q.agreement : null;
    const llmVal = (k1, k2) => (llm ? (llm[k1] ?? llm[k2]) : null);
    const srcTag = (k) => (src[k] ? `<span class="srcTag src-${esc(src[k])}">${esc(src[k] === 'model' ? 'model' : 'rules')}</span>` : '');
    const row = (label, map, key, finalV, llmV, rulesV) => {
      const disagree = agreeObj && agreeObj[key] === false && llmV != null;
      return `<tr${disagree ? ' class="dis"' : ''}><td>${esc(label)}</td><td>${esc(llmV == null ? '—' : lab(map, llmV))}</td><td>${esc(rulesV == null ? '—' : lab(map, rulesV))}</td><td class="final">${esc(lab(map, finalV))} ${srcTag(key)}</td></tr>`;
    };
    const disagreements = agreeObj ? Object.entries(agreeObj).filter(([, v]) => v === false).map(([k]) => k) : (q.agreement === false ? ['some fields'] : []);
    const warn = !!q.reviewReason;
    const ev = rules.evidence || {};
    let cue = '';
    if (ev.urgencyCue) {
      const when = ev.urgencyDate ? new Date(ev.urgencyDate) : null;
      const days = when && d.receivedAt ? Math.round((when - new Date(d.receivedAt)) / 86400000) : null;
      const whenTxt = when ? ` → ${when.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' })}${days != null ? `, ${days} days out` : ''}` : '';
      cue = `<div class="meta-line">Date parser: “${esc(ev.urgencyCue)}”${esc(whenTxt)}${ev.urgencyKind ? ` (${esc(ev.urgencyKind)})` : ''}</div>`;
    }
    html += stage(stageState(d, 'qualified', true, warn), 'Qualified', `${q.provider || 'classifier'}${q.promptVersion ? ` · prompt ${q.promptVersion}` : ''}${q.combineVersion ? ` · combine ${q.combineVersion}` : ''}`, t.qualify ?? q.latencyMs,
      ((llm && llm.reasons) ? `<div class="quote"><span class="quote-lbl">Model's reasons</span>“${esc(llm.reasons)}”</div>` : '') +
      `<table class="qgrid"><thead><tr><th>Field</th><th>Model</th><th>Rules</th><th>Used</th></tr></thead><tbody>
        ${row('Use case', 'useCase', 'useCase', fz.useCase, llmVal('use_case', 'useCase'), rules.useCase ?? rules.use_case)}
        ${row('Urgency', 'urgency', 'urgency', fz.urgency, llmVal('urgency', 'urgency'), rules.urgency)}
        ${row('Buying role', 'role', 'buyingRole', fz.buyingRole, llmVal('buying_role', 'buyingRole'), rules.buyingRole ?? rules.buying_role)}
        ${row('Disqualifier', 'disq', 'disqualifier', fz.disqualifier, llmVal('disqualifier', 'disqualifier'), rules.disqualifier)}
      </tbody></table>
      <div class="agree ${disagreements.length ? 'no' : 'yes'}">${!llm && String(q.fallbackReason || '').startsWith('model_after_alert') ? 'Routed on the rules: they settled the use case, so the model was asked after the alert.' : !llm ? 'Rules only: the model was not called for this lead.' : disagreements.length ? `Model and rules disagree on ${esc(disagreements.map((k) => ({ useCase: 'use case', buyingRole: 'buying role' }[k] || k)).join(', '))}.` : 'Model and rules agree.'}</div>
      ${cue}
      ${q.fallbackReason && llm == null ? '' : q.fallbackReason ? `<div class="meta-line">Fallback: ${esc(q.fallbackReason)}</div>` : ''}
      ${q.reviewReason ? `<div class="meta-line" style="color:var(--warn)">Sent to a person: ${esc(q.reviewReason.replace(/_/g, ' '))}</div>` : ''}
      ${secondOpinionLine(d.secondOpinion)}`);
  } else {
    html += stage(stageState(d, 'qualified', false), 'Qualified', '', t.qualify, null);
  }

  // 5 scored
  if (sc && sc.items) {
    const fitW = Math.max(0, Math.min(100, (Number(sc.fit || 0) / 50) * 100));
    const intW = Math.max(0, Math.min(100, (Number(sc.intent || 0) / 50) * 100));
    const items = sc.items.map((i) => `<tr><td>${esc(i.group)}</td><td>${esc(i.label)}</td><td class="${i.points < 0 ? 'neg' : ''}">${i.points > 0 ? '+' : ''}${esc(i.points)}</td></tr>`).join('');
    html += stage(stageState(d, 'scored', true), 'Scored', `${sc.total ?? '–'} of 100 → tier ${sc.tier ?? d.tier ?? '–'}`, t.score,
      `<div class="scorebars"><span>Fit</span><div class="bar"><span style="width:${fitW}%"></span></div><b>${esc(sc.fit ?? 0)}</b>
        <span>Intent</span><div class="bar intent"><span style="width:${intW}%"></span></div><b>${esc(sc.intent ?? 0)}</b></div>
       <table class="points"><tbody>${items}</tbody></table>`);
  } else {
    html += stage(stageState(d, 'scored', false), 'Scored', d.tier === 'X' ? 'Not for sales' : '', t.score, null);
  }

  // a person's decision on the lead's review item: what they chose, and the route before and now
  for (const dec of d.decisions || []) html += decisionStage(dec, { ...r, tier: d.tier });

  // 6 routed
  if (r.action) {
    html += stage(stageState(d, 'routed', true, r.action === 'review'), 'Routed', `${lab('action', r.action)}${r.rule === 'person' ? " · a person's decision" : r.rule ? ` · rule ${r.rule}` : ''}`, t.route,
      kv([
        ['Action', esc(lab('action', r.action))],
        ['Owner', esc(r.owner || '—')],
        ['Team', esc(teamName(r.team) || '—')],
        r.slaMinutes != null ? ['SLA', `${esc(r.slaMinutes)} min${r.slaDueAt ? `, due ${timeTag(r.slaDueAt, 'full')}` : ''}`] : null,
        r.reason ? ['Why', esc(r.reason)] : null,
      ]));
  } else {
    html += stage(stageState(d, 'routed', false), 'Routed', '', t.route, null);
  }

  // 7 alert (it goes out before the HubSpot write)
  const al = d.alert;
  if (al) {
    const dg = al.digest;
    const alertLine = al.slack ? 'Slack message built' : dg ? `Folded into the ${dg.list} digest for ${dg.channel}` : 'No alert for this outcome';
    const digestBody = dg ? `<div class="meta-line">This row came in on the uploaded list ${esc(dg.list)}. Its route, SLA and CRM task are its own; its alert is one line in the list's digest to ${esc(dg.channel)} instead of a message of its own. ${dg.at ? `The digest went out ${timeTag(dg.at, 'full')}.` : 'The digest goes out when the list has settled.'}</div>` : '';
    html += stage(stageState(d, 'notified', true), 'Alert', alertLine, t.notify, al.slack ? renderSlack(al.slack) : digestBody);
  } else {
    html += stage(stageState(d, 'notified', false), 'Alert', '', t.notify, null);
  }
  // the rate line the outbound module adds to the brief, the alert and the task (only when the organization is in the rate file)
  if (d.rateFact) html += rateFactStage(d.rateFact);
  // 8 crm
  const crm = d.crm;
  if (crm) {
    const reqs = (crm.requests || []).map((x, i) => `<details class="req"><summary><span class="verb">${esc(x.method)}</span>${esc(x.path)}${(crm.responses || [])[i] ? ` · ${esc(crm.responses[i].reused ? 'open task already there, kept it' : String(crm.responses[i].status))}` : ''}</summary>${(crm.responses || [])[i] && crm.responses[i].error ? `<div class="meta-line">${esc(crm.responses[i].error)}</div>` : ''}${x.body != null ? `<pre class="json">${jsonHTML(x.body)}</pre>` : '<pre class="json">(no body)</pre>'}</details>`).join('');
    html += stage(stageState(d, 'synced', true), 'HubSpot', `${crm.mode === 'live' ? (crm.delivery === 'pending' || crm.delivery === 'retrying' ? `live, waiting to send${crm.attempts ? ` (attempt ${crm.attempts} failed)` : ''}` : crm.delivery === 'dead' ? `live, gave up after ${crm.attempts} attempts` : crm.ok === false ? `live, ${(crm.responses || []).filter((r) => r.status >= 300).length} failed` : 'live, sent') : 'dry run, not sent'}${crm.ownerMapped && crm.ownerMapped.length ? ' · synthetic rep mapped to the portal owner' : ''} · ${(crm.requests || []).length} request${(crm.requests || []).length === 1 ? '' : 's'}`, t.crm,
      reqs || '<div class="meta-line">No CRM write for this outcome.</div>');
  } else {
    html += stage(stageState(d, 'synced', false), 'HubSpot', '', t.crm, null);
  }

  html += '</div>';

  // account context
  const a = d.account;
  if (a && ((a.otherLeads || []).length || (a.signals || []).length || a.owner)) {
    html += `<div class="acct"><h4>Same account: ${esc(a.name || a.id)}</h4><ul>
      ${a.owner ? `<li>Owner in the CRM: <b>${esc(a.owner)}</b></li>` : ''}
      ${(a.otherLeads || []).map((o) => `<li><a class="jump" href="${leadHref(o.id)}">${esc(o.name || 'Lead')}</a>, ${esc(o.title || '')} · ${esc(lab('source', o.source))} · ${timeTag(o.receivedAt, 'short')}</li>`).join('')}
      ${(a.signals || []).map((s) => `<li>Signal: ${esc(s.type === 'web_intent' ? 'web visits' : s.type)} · ${esc(s.detail)} · ${timeTag(s.at, 'short')}</li>`).join('')}
    </ul></div>`;
  }
  pane.innerHTML = html;
}

/** The outbound module's one line about this organization's own rate, with the way it was matched and a jump to its group. */
const DECISION_TEXT = { use_account: 'Used an account', not_for_sales: 'Sent to nurture', not_a_buyer: 'Not a buyer', is_buyer: 'It is a buyer' };
/** A route in a few words, for the decision step's before and now. */
const routeWords = (x) => (x && x.action ? `${lab('action', x.action)} · ${x.owner || teamName(x.team) || '—'}${x.tier && x.tier !== 'X' ? ` · tier ${x.tier}` : ''}` : '—');
/** The Decided by a person step: who chose what, when, and what it changed. */
function decisionStage(dec, now) {
  const what = DECISION_TEXT[dec.kind] || dec.kind;
  return stage('done', 'Decided by a person', `${what} · ${dec.by}`, null, kv([
    ['Decision', esc(what) + (dec.account ? `: ${esc(dec.account.name)} <span class="idkey">${esc(dec.account.key)}</span>` : '') + (dec.reason ? ` (${esc(dec.reason)})` : '')],
    ['Who', `${esc(dec.by)}, ${timeTag(dec.at, 'full')}`],
    dec.note ? ['Note', esc(dec.note)] : null,
    ['Before', esc(routeWords(dec.before))],
    ['Now', esc(dec.rerun ? routeWords(now) : `${routeWords(now)} (not run again)`)],
  ]));
}

function rateFactStage(f) {
  const how = f.matchedBy === 'registry_link' ? 'linked to the account this lead resolved to' : 'same name and state as the lead\u2019s organization';
  return stage('done', 'Their rates', 'from the rate file, added to the brief, the alert and the task', null,
    `<div class="quote"><span class="quote-lbl">${esc(f.name)}</span>${esc(f.line)}</div>` +
    kv([['Matched', `${esc(how)}${f.groups > 1 ? ` (${esc(f.groups)} groups matched)` : ''}`], ['Group', `<a class="jump-outbound" href="${buildAddress('outbound', { ein: f.ein })}">Open in Outbound</a> <span class="idkey">EIN ${esc(f.ein)}</span>`]]));
}

function renderSlack(slack) {
  const blocks = Array.isArray(slack) ? slack : slack.blocks;
  if (!Array.isArray(blocks)) return `<pre class="json">${jsonHTML(slack)}</pre>`;
  let header = '';
  let fields = '';
  let secs = '';
  let ctx = '';
  for (const b of blocks) {
    if (b.type === 'header') header = b.text?.text || '';
    else if (b.type === 'section') {
      if (b.text?.text) secs += `<div class="chat-sec">${mrkdwn(b.text.text)}</div>`;
      if (Array.isArray(b.fields)) fields += b.fields.map((f) => `<div>${mrkdwn(f.text)}</div>`).join('');
    } else if (b.type === 'context') ctx += (b.elements || []).map((e) => mrkdwn(e.text || '')).join(' · ');
  }
  return `<div class="chat">
    <div class="chat-avatar"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 9h6l5 7h7M7 16h11M7 23h6l5-7" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div><div class="chat-from">Inbound Router <span>APP · to ${esc(slack.channel || 'a channel')} · preview, not sent</span></div>
      ${header ? `<div class="chat-h">${esc(header)}</div>` : ''}
      ${fields ? `<div class="chat-fields">${fields}</div>` : ''}${secs}${ctx ? `<div class="chat-ctx">${ctx}</div>` : ''}
    </div></div>`;
}

// ─── eval tab ────────────────────────────────────────────────────────────────
let evalSet = null;
const SET_ORDER = ['sealed', 'heldout', 'dev'];
function setLabel(x) {
  if (x.name === 'sealed') return `Sealed held-out (${x.n} synthetic)`;
  if (x.name === 'heldout') return `Held-out (${x.n} synthetic)`;
  if (x.name === 'dev') return `Development (${x.n})`;
  return `${x.name} (${x.n})`;
}
function evalColumns(sets) {
  // Show whichever policy columns the eval produced, in a fixed order; 'final' is the policy the pipeline uses.
  const keys = new Set();
  for (const x of sets) for (const f of Object.values(x.fields || {})) for (const k of Object.keys(f || {})) keys.add(k);
  const cols = [];
  if (keys.has('rules')) cols.push(['rules', 'Rules']);
  if (keys.has('llm')) cols.push(['llm', 'Model']);
  if (keys.has('v1')) cols.push(['v1', 'v1']);
  if (keys.has('v2')) cols.push(['v2', 'v2']);
  if (keys.has('v3')) cols.push(['v3', 'v3']);
  if (keys.has('v4')) cols.push(['v4', 'v4']);
  if (keys.has('final') && !keys.has('v3') && !keys.has('v4')) cols.push(['final', 'Used']);
  return cols;
}
function renderEval() {
  const body = $('#evalBody');
  const e = state.evalData;
  const sets = e && Array.isArray(e.sets) ? e.sets.slice() : e && e.fields && !e.sample ? [{ name: 'dev', n: e.n, note: '', fields: e.fields }] : null;
  if (!e || e.sample || !sets || !sets.length) {
    body.innerHTML = `<div class="card" style="max-width:760px"><h3>No eval recorded yet</h3></div>`;
    return;
  }
  sets.sort((a, b) => (SET_ORDER.indexOf(a.name) + 99 * (SET_ORDER.indexOf(a.name) < 0)) - (SET_ORDER.indexOf(b.name) + 99 * (SET_ORDER.indexOf(b.name) < 0)));
  if (!evalSet || !sets.find((x) => x.name === evalSet)) evalSet = sets[0].name;
  const cur = sets.find((x) => x.name === evalSet);
  const usedKey = e.combineVersion && ['v1', 'v2', 'v3', 'v4'].includes(e.combineVersion) ? e.combineVersion : 'final';
  const cols = evalColumns(sets);
  const rows = [
    ['Use case', 'useCase'], ['Urgency', 'urgency'], ['Disqualifier', 'disqualifier'],
    ['Segment (from matching)', 'segment'], ['Route team (from routing)', 'routeTeam'], ['Route action (from routing)', 'routeAction'],
  ].filter(([, k]) => cur.fields && cur.fields[k]);
  const val = (f, k) => (k === usedKey && f[k] == null ? f.final : f[k]);
  const cell = (f, key, top) => {
    const v = val(f, key);
    if (v == null) return '<td style="color:var(--faint)">n/a</td>';
    const cnt = !!(f.counts && f.counts[key]);
    return `<td class="${v === top ? 'best' : ''}">${cnt ? `${esc(f.counts[key])}<small>(${pct(v)})</small>` : pct(v)}<span class="accbar"><span style="width:${Math.round(v * 100)}%"></span></span></td>`;
  };
  const table = rows.map(([label, key]) => {
    const f = cur.fields[key] || {};
    const vals = cols.map(([k]) => val(f, k)).filter((x) => x != null);
    const top = vals.length ? Math.max(...vals) : null;
    return `<tr><td>${esc(label)}</td>${cols.map(([k]) => cell(f, k, top)).join('')}</tr>`;
  }).join('');
  const head = cols.map(([k, l]) => `<th>${esc(l)}${k === usedKey ? ' <span class="srcTag src-model">used</span>' : ''}</th>`).join('');

  // Data-driven note on urgency across policies, from the most independent set available.
  const ref = sets.find((x) => x.name === 'sealed') || sets.find((x) => x.name === 'heldout');
  let story = '';
  if (ref && ref.fields && ref.fields.urgency) {
    const u = ref.fields.urgency;
    const bits = cols.map(([k, l]) => (val(u, k) != null ? `${l} ${u.counts && u.counts[k] ? `${u.counts[k]} (${pct(val(u, k))})` : pct(val(u, k))}` : null)).filter(Boolean);
    story = `<div class="card" style="margin-top:14px"><h3>What the evals changed</h3>
      <p style="margin:0 0 6px;color:var(--ink-2)">Version 1 let the model override the rules whenever it was at least 60% confident; the small demo model got month arithmetic wrong, so urgency got worse. Version 2 let rules decide wherever they had a clear signal; it recovered on the development set but its keyword cues did not generalize to new phrasing. Version 3 replaced the cues with a date parser that resolves every expression to a calendar date and measures the distance, but still asked the model when a message had no timing language, and the model guessed. Version 4 stops guessing: no timing language means unknown.</p>
      <p style="margin:0;color:var(--ink-2)">Urgency on the ${esc(setLabel(ref).toLowerCase())}: ${esc(bits.join(' · '))}.</p></div>`;
  }
  const curMisses = (e.misses || []).filter((m) => !m.set || m.set === cur.name);
  const misses = curMisses.slice(0, 60).map((m) => `<div class="miss"><div class="miss-top"><span class="idkey">${esc(m.fixtureId)}</span><b>${esc(m.field)}</b><span>expected <b>${esc(m.expected)}</b>, got <b>${esc(m.got)}</b></span>${m.source ? `<span class="src">${esc(lab('source', m.source))}</span>` : ''}</div>${m.reasons ? `<div class="why">“${esc(m.reasons)}”</div>` : ''}</div>`).join('');
  const lq = (cur.labelQuestions || []);
  const lqHtml = lq.length ? `<div class="card" style="margin-top:14px"><h3>Label questions (${esc(lq.length)})</h3>${lq.map((q) => `<div class="miss"><div class="miss-top"><span class="idkey">${esc(q.fixtureId || q.id)}</span><span>label <b>${esc(q.gold ?? q.expected)}</b>, parser <b>${esc(q.parser ?? q.got)}</b></span></div>${q.why || q.reason ? `<div class="why">${esc(q.why || q.reason)}</div>` : ''}</div>`).join('')}</div>` : '';
  body.innerHTML = `<div class="set-tabs" role="group" aria-label="Eval set">${sets.map((x) => `<button class="${x.name === cur.name ? 'is-on' : ''}" data-set="${esc(x.name)}">${esc(setLabel(x))}</button>`).join('')}</div>
  <div class="eval-grid">
    <div>
      <div class="card"><h3>Accuracy · ${esc(setLabel(cur))}</h3>
        <table class="acc"><thead><tr><th>Field</th>${head}</tr></thead><tbody>${table}</tbody></table>
        <div class="meta-line">Model ${esc(e.model)} · prompt ${esc(e.promptVersion)} · temperature 0 · latency p50 ${esc(fmtMs(e.latencyMs?.p50))}, p90 ${esc(fmtMs(e.latencyMs?.p90))} · run ${esc(fmtFull(e.generatedAt))}</div>
      </div>
      ${story}
    </div>
    <div>
      <div class="card"><h3>Misses on this set (${esc(curMisses.length)})</h3>${misses || '<div class="none">None.</div>'}</div>
      ${lqHtml}
    </div>
  </div>`;
  $$('.set-tabs button', body).forEach((b) => b.addEventListener('click', () => { evalSet = b.dataset.set; renderEval(); }));
}

// ─── data quality tab ────────────────────────────────────────────────────────
const GRAIN_LABEL = { event: 'event', lead: 'lead', account: 'account', stage: 'stage' };
function qualityValue(c) {
  if (c.value == null) return '<span class="dq-none">none</span>';
  if (c.unit === 'ms') return `${esc(fmtMs(c.value))}`;
  if (c.unit === 'hours') return `${esc(c.value)} h`;
  const of = c.denominator != null && c.numerator != null ? `<span class="dq-of">of ${esc(c.denominator)}</span>` : '';
  return `${esc(c.value)}${of}`;
}
function qualityBreakdown(c) {
  if (!c.breakdown || !c.breakdown.length) return '';
  const bit = (b) => {
    const v = b.value == null ? 'none' : c.unit === 'ms' ? fmtMs(b.value) : b.value;
    const d = b.denominator != null ? `/${b.denominator}` : '';
    const n = b.n != null ? ` · n ${b.n}` : '';
    return `<span class="dq-chip"><span>${esc(b.label)}</span><b>${esc(v)}${esc(d)}</b><small>${esc(n)}</small></span>`;
  };
  return `<div class="dq-break">${c.breakdown.map(bit).join('')}</div>`;
}
function renderQuality() {
  const body = $('#qualityBody');
  const q = state.quality;
  if (!q || !Array.isArray(q.controls)) return;
  const rows = q.controls.map((c) => `<div class="dq-row">
      <div class="dq-name"><div>${esc(c.name)}</div><div class="dq-tags"><span class="dq-tag">${esc(GRAIN_LABEL[c.grain] || c.grain)} grain</span>${c.scope === 'current' ? '<span class="dq-tag">current state</span>' : ''}</div></div>
      <div class="dq-value">${qualityValue(c)}</div>
      <div class="dq-def">${esc(c.definition)}${qualityBreakdown(c)}<details class="raw-toggle"><summary>Query</summary><pre class="dq-sql">${esc(c.sql)}</pre></details></div>
    </div>`).join('');
  body.innerHTML = `<div class="card dq-card">
      <div class="dq-head"><span>Control</span><span>Value</span><span>Definition</span></div>
      ${rows}
      <div class="meta-line">${q.sinceDays == null ? 'All stored history.' : `Last ${esc(q.sinceDays)} day(s) before the newest event.`} Generated ${esc(fmtFull(q.generatedAt))}.</div>
    </div>`;
}

// ─── overview ────────────────────────────────────────────────────────────────
// Renders GET /api/dashboard. Every figure on this tab comes from that payload; nothing here invents or rounds up a number.
// Charts are plain HTML: thin bars, a 2px surface gap between stacked parts, values at the bar tips,
// and a Table button on every chart card that shows the same numbers as a table.

const OV_REASON = { ambiguous_company: 'More than one possible account', unresolved_company: 'No organization matched', llm_only_disqualifier: 'Model-only disqualifier', model_doubt_after_alert: 'Model doubt after the alert' };
const KEY_KIND = { ahrq: 'AHRQ system', ccn: 'CMS CCN', payer: 'payer', npi: 'NPI', domain: 'domain' };
const LIFECYCLE = { salesqualifiedlead: ['Sales qualified', 'A'], marketingqualifiedlead: ['Marketing qualified', 'B'], lead: ['Lead', 'C'], not_set: ['Not set', 'X'] };
const TIER_ORDER = ['A', 'B', 'C', 'D', 'X'];

const nf = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const pctTxt = (p) => (p == null ? '—' : `${Math.round(Number(p))}%`);
function dur(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${Math.max(0, s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
function ago(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const s = Math.round((nowMs - Date.parse(iso)) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const etDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ }); // yyyy-mm-dd in Eastern time
function dayLabel(ymd, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
}
function niceScale(max, maxN = 6, integer = true) {
  if (!(max > 0)) return { max: integer ? 4 : 1, ticks: integer ? [0, 1, 2, 3, 4] : [0, 0.25, 0.5, 0.75, 1] };
  const mag = 10 ** Math.floor(Math.log10(max));
  let best = null;
  for (const m of [mag / 10, mag]) for (const f of [1, 2, 2.5, 5, 10]) {
    const step = f * m;
    if (integer && (step < 1 || !Number.isInteger(Math.round(step * 1e6) / 1e6))) continue;
    const n = Math.ceil(max / step - 1e-9);
    if (n < 2 || n > maxN) continue;
    const top = n * step;
    if (!best || top < best.top - 1e-9 || (Math.abs(top - best.top) < 1e-9 && Math.abs(n - 5) < Math.abs(best.n - 5))) best = { top, step, n };
  }
  if (!best) { const step = integer ? Math.max(1, Math.ceil(max / 5)) : max / 5; best = { step, n: Math.ceil(max / step), top: step * Math.ceil(max / step) }; }
  const ticks = [];
  for (let i = 0; i <= best.n; i++) ticks.push(Math.round(i * best.step * 1e6) / 1e6);
  return { max: best.top, ticks };
}
const statusWord = { ok: 'Passing', warn: 'Needs a look', bad: 'Failing', idle: 'Nothing to check yet' };
const SICON = {
  ok: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l3 3 6-6.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="12.3" r="1.2" fill="currentColor"/></svg>',
  bad: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  idle: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const sicon = (s) => `<span class="sicon ${esc(s)}" role="img" aria-label="${esc(statusWord[s] || s)}">${SICON[s] || SICON.idle}</span>`;

const INDEXED_CARDS = new Set(['lists', 'referrals']);
/** A chart card: title, optional legend, a Table button that swaps the chart for the same numbers as a table. */
function vcard({ id, title, sub = '', legend = '', body, table = '', foot = '', span = 'span-6' }) {
  const tv = !!(table && state.tableView[id]);
  // the cards the Overview's index jumps to carry an index id
  return `<article class="card vcard ${span}" data-card="${esc(id)}"${INDEXED_CARDS.has(id) ? ` data-index-id="${esc(id)}"` : ''} aria-labelledby="h-${esc(id)}">
    <div class="card-head"><h3 id="h-${esc(id)}">${esc(title)}</h3>${sub ? `<span class="sub">${sub}</span>` : ''}
      <div class="card-tools">${legend && !tv ? legend : ''}${table ? `<button class="tbl-toggle" type="button" data-card="${esc(id)}" aria-pressed="${tv}" >Table</button>` : ''}</div>
    </div>
    <div class="card-body">${tv ? table : body}</div>
    ${foot ? `<div class="card-foot">${foot}</div>` : ''}
  </article>`;
}
function dtable(head, rows, numericFrom = 1) {
  return `<table class="dtable"><thead><tr>${head.map((h, i) => `<th${i >= numericFrom ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.length ? rows.map((r) => `<tr>${r.map((c, i) => `<td${i >= numericFrom ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${head.length}" class="muted">No rows yet.</td></tr>`}</tbody></table>`;
}
const tierLegend = (keys = TIER_ORDER) => `<div class="legend" aria-label="Tier colors">${keys.map((t) => `<span><i class="sw ${t}"></i>${t === 'X' ? 'X' : t}</span>`).join('')}</div>`;

/** Gridlines and the bottom axis share the bar scale: positions are a fraction of (track width minus the value reserve). */
const scalePos = (frac) => `calc((100% - var(--r, 56px)) * ${Math.max(0, Math.min(1, frac)).toFixed(4)})`;
function gridlines(scale) {
  return `<div class="gridlines" aria-hidden="true">${scale.ticks.map((t) => `<i style="left:${scalePos(t / scale.max)}"></i>`).join('')}</div>`;
}
function axisRow(scale, fmt, lw, val = '0px') {
  return `<div class="axis" style="--lab:${lw}px;--val:${val}" aria-hidden="true"><span></span><div class="ticks">${scale.ticks.map((t) => `<span style="left:${scalePos(t / scale.max)}">${esc(fmt(t))}</span>`).join('')}</div><span></span></div>`;
}
/** Single-series horizontal bars: context bars in Serif's pale blue, the one bar the chart is about in the key gradient. */
function hbars(rows, { lw = 170, keyIndex = -1, fmt = nf } = {}) {
  const max = Math.max(0, ...rows.map((r) => r.value || 0));
  const scale = niceScale(max, 6, true);
  return `<div class="hbars" style="--lab:${lw}px;--val:0px;--r:64px">${rows.map((r, i) => `
    <div class="vrow" style="grid-template-columns:${lw}px minmax(0,1fr) 0">
      <div class="lab">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>
      <div class="track">${gridlines(scale)}<span class="bar1${i === keyIndex ? ' key' : ''}${r.value ? '' : ' zero'}" style="width:${scalePos((r.value || 0) / scale.max)}"></span><span class="bar-end">${esc(fmt(r.value))}${r.endSmall ? `<small>${esc(r.endSmall)}</small>` : ''}</span></div>
      <div></div>
    </div>`).join('')}</div>${axisRow(scale, fmt, lw)}`;
}
/** Stacked tier bars, one per row; parts carry the tier ramp, a 2px gap separates them, the total sits at the tip. */
function stackRow(label, tiers, total, scale, lw, extra = '', sub = '') {
  const scaleMax = scale.max;
  const parts = [...TIER_ORDER, 'pending'].filter((t) => tiers[t] > 0);
  return `<div class="vrow" style="grid-template-columns:${lw}px minmax(0,1fr) ${extra ? 'var(--val)' : '0'}">
    <div class="lab">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    <div class="track">${gridlines(scale)}${total ? `<span class="stack" style="width:${scalePos(total / scaleMax)}">${parts.map((t) => `<span class="seg-${t}" style="flex:${tiers[t]} 1 0"></span>`).join('')}</span>` : ''}<span class="bar-end">${nf(total)}</span></div>
    ${extra ? `<div>${extra}</div>` : '<div></div>'}
  </div>`;
}

function renderStrip() {
  const d = state.dash;
  const box = $('#envStrip');
  if (!box) return;
  const items = ['Synthetic people, real organizations (the CRM accounts are fictional)'];
  if (d && d.env) {
    const live = d.env.hubspot === 'live';
    items.push(live ? 'HubSpot: <span class="live-tag">LIVE</span>' : 'HubSpot: dry-run, nothing sent');
    const m = d.env.model || {};
    items.push(m.provider === 'rules' ? 'Classifier: rules only, no model' : m.provider === 'anthropic' ? 'Classifier: rules + model slot (hosted model)' : 'Classifier: rules + model slot (demo model on this machine)');
    items.push(d.env.registry === 'real' ? 'Registry: CMS, AHRQ, NPPES' : 'Registry: hand-made mini set');
  }
  if (state.mode === 'sample') items.push('Sample data: the API is offline');
  box.innerHTML = `<div class="strip-in"><b>Prototype</b>${items.map((t, i) => `${i ? '<span class="sep" aria-hidden="true">·</span>' : ''}<span class="item">${t}</span>`).join('')}</div>`;
}

function ovHeader(d) {
  const live = state.mode === 'live';
  return `<div class="ov-head">
    <div>
      <h1>Every inbound lead, routed <span class="grad-text">in seconds</span></h1>
    </div>
    <div class="ov-updated${live ? ' is-live' : ''}" id="ovUpdated"><span class="pulse" aria-hidden="true"></span>${live ? `Updated ${esc(new Date(d.generatedAt).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' }))} ET` : 'Sample data'}</div>
  </div>`;
}

function ovWindow(d) {
  const w = d.window;
  const range = !w.from ? 'No leads yet' : etDay(w.from) === etDay(w.to) ? dayLabel(etDay(w.from)) : `${dayLabel(etDay(w.from))} – ${dayLabel(etDay(w.to))}`;
  // arrivals per Eastern day, every day in the window (up to the last 14), zeros included
  let cols = '';
  if (w.arrivals.length) {
    const counts = new Map();
    for (const a of w.arrivals) counts.set(etDay(a.at), (counts.get(etDay(a.at)) || 0) + 1);
    const days = [];
    const last = etDay(w.to);
    for (let t = Date.parse(`${etDay(w.from)}T12:00:00Z`); ; t += 86400000) {
      const k = new Date(t).toISOString().slice(0, 10);
      days.push(k);
      if (k >= last || days.length > 400) break;
    }
    const shown = days.slice(-14);
    const max = Math.max(...shown.map((k) => counts.get(k) || 0));
    const keyDay = shown.find((k) => (counts.get(k) || 0) === max);
    cols = `<div class="arrivals"><div class="arrivals-head"><span>Leads by day received (ET)</span><span>${shown.length < days.length ? `last ${shown.length} days` : ''}</span></div>
      <div class="cols">${shown.map((k) => { const n = counts.get(k) || 0; return `<div class="col"><span class="col-val">${n || ''}</span><span class="col-bar${k === keyDay ? ' key' : ''}" style="height:${max ? Math.max(n ? 3 : 0, Math.round((n / max) * 52)) : 0}px"></span></div>`; }).join('')}</div>
      <div class="col-labels">${shown.map((k) => `<span>${esc(dayLabel(k, { weekday: 'short' }))}</span>`).join('')}</div></div>`;
  }
  const processed = w.processedTo ? fmtShort(w.processedTo) : null;
  return `<div class="window">
    <div class="eyebrow">Data window, by time received</div>
    <div class="window-range">${esc(range)}</div>
    <div class="window-facts">
      <div><b>${nf(w.webhooks)}</b> webhooks → <b>${nf(w.leads)}</b> leads from <b>${nf(w.doors)}</b> of ${nf(w.doorsTotal)} doors</div>
      <div><b>${nf(w.afterHours)}</b> arrived after hours${w.inFlight ? ` · <b>${nf(w.inFlight)}</b> still processing` : ''}${w.failed ? ` · <b>${nf(w.failed)}</b> failed` : ''}</div>
      ${processed ? `<div class="muted">Processed ${esc(processed.day)}, ${esc(processed.time)} ET</div>` : ''}
    </div>
    ${cols}
  </div>`;
}

/** One line on the model's second opinion after the alert: what it said and what it would have changed. */
function secondOpinionLine(so) {
  if (!so) return '';
  if (so.state !== 'done' || !so.result) return `<div class="meta-line">Second opinion: due, the model is asked after the alert.</div>`;
  const r = so.result;
  if (r.error) return `<div class="meta-line" style="color:var(--warn)">Second opinion failed: ${esc(r.error)}</div>`;
  const field = { useCase: 'use case', buyingRole: 'buying role', disqualifier: 'disqualifier', reviewReason: 'review' };
  const when = r.afterAlertMs != null ? ` ${esc(fmtMs(r.afterAlertMs))} after the alert` : '';
  if (!r.answered) return `<div class="meta-line">Second opinion${when}: no answer (${esc(r.fallbackReason || 'model unavailable')}).</div>`;
  if (r.doubt) return `<div class="meta-line" style="color:var(--warn)">Second opinion${when}: the model flagged ${esc(r.doubt.disqualifier.replace(/_/g, ' '))} at ${esc(r.doubt.confidence.toFixed(2))} and no rule agreed. ${r.followedUp ? 'RevOps is checking it; the alert channel was told.' : 'Recorded only: this route would not have changed.'}</div>`;
  if (r.agreed) return `<div class="meta-line">Second opinion${when}: the model agrees with the route.</div>`;
  return `<div class="meta-line">Second opinion${when}: it would change ${esc(r.changed.map((k) => field[k] || k).join(', '))}${r.roleFilled ? ` (buying role ${esc(lab('role', r.roleFilled))})` : ''}; the route stands.</div>`;
}

function ovPath(d) {
  const counts = { ok: 0, warn: 0, bad: 0, idle: 0 };
  for (const p of d.path) counts[p.status] = (counts[p.status] || 0) + 1;
  const checked = d.path.length - counts.idle;
  const badge = counts.bad ? `<span class="badge bad">${counts.bad} failing</span>` : counts.warn ? `<span class="badge warn">${counts.warn} to look at</span>` : checked ? `<span class="badge ok">${counts.ok} of ${checked} passing</span>` : '<span class="badge">Waiting for leads</span>';
  return `<div class="card path-card">
    <div class="card-head"><h3>Speed-to-lead path</h3><div class="card-tools">${badge}</div></div>
    <ul class="path">${d.path.map((p) => `<li>${sicon(p.status)}<div class="line"><b>${esc(p.label)}</b><span class="fact">${esc(p.fact)}</span></div></li>`).join('')}</ul>
  </div>`;
}

function ovKpis(d) {
  const k = d.kpis;
  const sr = k.salesReady;
  const t = k.timeToRoute;
  const thin = (parts) => `<div class="thin" aria-hidden="true">${parts.filter((p) => p[1] > 0).map(([cls, n]) => `<span class="${cls}" style="flex:${n} 1 0"></span>`).join('')}</div>`;
  const tile = (label, inner, key = false) => `<div class="card kpi${key ? ' is-key' : ''}" role="group" aria-label="${esc(label)}"><div class="kpi-label">${esc(label)}</div>${inner}</div>`;
  return `<section class="kpis" aria-label="Summary">
    ${tile('Leads in', `<div class="kpi-value">${nf(k.leadsIn.value)}</div>`)}
    ${tile('Sales-ready', `<div class="kpi-value">${nf(sr.value)}${sr.pct != null ? `<small>${pctTxt(sr.pct)} of leads</small>` : ''}</div>${thin([['seg-A', sr.a], ['seg-B', sr.b], ['seg-X', Math.max(0, k.leadsIn.value - sr.a - sr.b)]])}`, true)}
    ${tile('Time to route, p50', t.processingP50 == null ? '<div class="kpi-value">—</div>' : `<div class="kpi-value">${esc(fmtMs(t.processingP50))}<small>processing</small></div><div class="kpi-q"><b>${esc(fmtMs(t.queueP50))}</b> queue wait</div>`)}
    ${tile('SLA met, A-tier', `<div class="kpi-value">${k.sla.aRouted ? `${nf(k.sla.aWithin)}/${nf(k.sla.aRouted)}` : '—'}<small>${k.sla.aRouted ? 'alerted in time' : 'no A-tier yet'}</small></div>`)}
    ${tile('Matched on a stable ID', k.matched.pct == null ? '<div class="kpi-value">—</div>' : `<div class="kpi-value">${nf(k.matched.matched)}<small>of ${nf(k.matched.of)}</small></div>`)}
    ${tile('Needs a person', `<div class="kpi-value">${nf(k.needsPerson.open)}</div>`)}
  </section>`;
}

function ovDoors(d) {
  const lw = 150;
  const max = Math.max(0, ...d.doors.map((x) => x.total));
  const scale = niceScale(max, 6, true);
  let body = `<div class="hbars" style="--lab:${lw}px;--r:44px">`;
  for (const m of d.motions) {
    body += `<div class="grp" style="--lab:${lw}px"><span>${esc(m.label)}</span><span>${nf(m.total)} leads · ${nf(m.salesReady)} A or B</span></div>`;
    for (const x of d.doors.filter((r) => r.motion === m.id)) body += stackRow(lab('source', x.source), x.tiers, x.total, scale, lw);
  }
  body += `</div>${axisRow(scale, nf, lw)}`;
  const table = dtable(['Door', 'Motion', 'Leads', 'A', 'B', 'C', 'D', 'X'], d.doors.map((x) => [lab('source', x.source), d.motions.find((m) => m.id === x.motion)?.label || '', x.total, x.tiers.A, x.tiers.B, x.tiers.C, x.tiers.D, x.tiers.X]), 2);
  return vcard({ id: 'doors', title: 'Leads by door', legend: tierLegend(), body, table, span: 'span-7' });
}

function ovFunnel(d) {
  const f = d.funnel;
  const top = f[0]?.n || 0;
  const keyIdx = f.findIndex((s) => s.id === 'sales_ready');
  const body = `<div class="fconv-head"><span></span><span></span><span>step</span></div>
    ${f.map((s, i) => `<div class="frow">
      <div class="lab">${esc(s.label)}</div>
      <div class="track" style="--r:44px">${top ? `<span class="bar1${i === keyIdx ? ' key' : ''}${s.n ? '' : ' zero'}" style="width:${scalePos(s.n / top)}"></span>` : ''}<span class="bar-end">${nf(s.n)}</span></div>
      <div class="conv">${i === 0 ? '' : `<b>${pctTxt(s.pctOfPrev)}</b>`}</div>
    </div>`).join('')}`;
  const last = f[f.length - 1];
  const table = dtable(['Step', 'Leads', 'Of received', 'Of the step before'], f.map((s) => [s.label, s.n, pctTxt(s.pctOfFirst), s.pctOfPrev == null ? '' : pctTxt(s.pctOfPrev)]));
  return vcard({ id: 'funnel', title: 'Lead funnel', body, table, span: 'span-5',
    foot: top ? `<span><b>${pctTxt(last.pctOfFirst)}</b> of received leads made it through every step</span>` : '' });
}

function ovMarkets(d) {
  const lw = 182;
  const max = Math.max(0, ...d.markets.map((m) => m.total));
  const scale = niceScale(max, 6, true);
  const chips = (m) => `<div class="chip-row">${m.teams.slice(0, 2).map((t) => `<span class="tchip" title="${esc(teamName(t.team))}">${esc(TEAM_SHORT[t.team] || t.team)} <b>${nf(t.n)}</b></span>`).join('')}${m.teams.length > 2 ? `<span class="tchip more" title="${esc(m.teams.slice(2).map((t) => `${teamName(t.team)} ${t.n}`).join(', '))}">+${m.teams.length - 2}</span>` : ''}</div>`;
  const body = `<div class="colhead" style="grid-template-columns:${lw}px minmax(0,1fr) 236px"><span></span><span></span><span>Routed to</span></div>
    <div class="hbars tall-rows" style="--lab:${lw}px;--val:236px;--r:44px">${d.markets.map((m) => stackRow(m.label, m.tiers, m.total, scale, lw, chips(m))).join('')}</div>${axisRow(scale, nf, lw, '236px')}`;
  const table = dtable(['Buyer type', 'Leads', 'A', 'B', 'C', 'D', 'X', 'Routed to'], d.markets.map((m) => [m.label, m.total, m.tiers.A, m.tiers.B, m.tiers.C, m.tiers.D, m.tiers.X, m.teams.map((t) => `${TEAM_SHORT[t.team] || t.team} ${t.n}`).join(', ')]), 1);
  return vcard({ id: 'markets', title: 'Buyer type', legend: tierLegend(), body, table, span: 'span-7',
    foot: d.unsegmented ? `<span>${nf(d.unsegmented)} still processing</span>` : '' });
}

function ovNotForSales(d) {
  const n = d.notForSales;
  const rows = n.reasons.map((r) => ({ label: r.label, value: r.n }));
  const body = rows.length ? hbars(rows, { lw: 190, keyIndex: 0 }) : '<div class="none">Every lead so far is on a sales path.</div>';
  const table = dtable(['Reason', 'Leads'], n.reasons.map((r) => [r.label, r.n]));
  return vcard({ id: 'nfs', title: 'Why leads are not for sales', body, table, span: 'span-5',
    foot: `<span><b>${nf(n.total)}</b> of ${nf(d.kpis.leadsIn.value)} leads</span><span><b>${nf(n.nurture)}</b> to nurture below the rep threshold</span>` });
}

function ovLists(d) {
  const lists = d.lists || [];
  if (!lists.length) return '';
  const tiers = (t) => TIER_ORDER.filter((k) => t[k]).map((k) => `${k} ${nf(t[k])}`).join(' · ') || '—';
  const actions = (a) => Object.entries(a).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${lab('action', k)} ${nf(n)}`).join(' · ');
  const rows = lists.map((l) => [l.name, l.rows, tiers(l.byTier), actions(l.byAction), l.repeatsAttached, l.unknownOrgs, l.digests, l.firstAccepted ? fmtFull(l.firstAccepted) : '—', l.lastAccepted ? fmtFull(l.lastAccepted) : '—']);
  const body = `<ul class="fq" aria-label="Uploaded lists">${lists.map((l) => `<li>
      <div class="who"><span class="who-line"><a class="jump" href="${buildAddress('stream', { list: l.name })}" title="Open this list's rows in the Lead stream"><b>${esc(l.name)}</b></a></span><span class="d">${nf(l.rows)} rows · ${esc(tiers(l.byTier))}</span><span class="d">${esc(actions(l.byAction))}</span></div>
      <div class="act"><span class="wait">${nf(l.digests)} digest${l.digests === 1 ? '' : 's'}${l.waitingForDigest ? ` · ${nf(l.waitingForDigest)} waiting` : ''}</span><span class="wait">${nf(l.repeatsAttached)} repeat${l.repeatsAttached === 1 ? '' : 's'} · ${nf(l.unknownOrgs)} unknown</span></div>
    </li>`).join('')}</ul>`;
  const table = dtable(['List', 'Rows', 'By tier', 'By action', 'Repeats attached', 'Unknown organizations', 'Digests', 'First accepted', 'Last accepted'], rows, 9);
  return vcard({ id: 'lists', title: 'Uploaded lists', sub: `${nf(lists.length)} list${lists.length === 1 ? '' : 's'}`, body, table, span: 'span-5',
    foot: '<span>One Slack digest per list and team in place of one alert per row; a rep alert still goes out on its own.</span>' });
}

/** Named referrals (decision 26): the people who named who sent them, beside everyone else, and the referrers ranked. */
function ovReferrals(d) {
  const r = d.referrals;
  if (!r) return '';
  const tiers = (t) => TIER_ORDER.filter((k) => t[k]).map((k) => `${k} ${nf(t[k])}`).join(' · ') || '—';
  const pct = (v) => (v == null ? '—' : `${v}%`);
  const kind = (x) => (x.customer ? '<span class="badge ok">customer</span>' : x.key ? '<span class="badge">not a customer</span>' : '<span class="badge warn">not identified</span>');
  const compare = `<ul class="fq" aria-label="Named referrals beside everyone else">
      <li><div class="who"><span class="who-line"><a class="jump" href="${buildAddress('stream', { referral: true })}" title="Open the referred leads in the Lead stream"><b>Named a referrer</b></a></span><span class="d">${nf(r.named)} lead${r.named === 1 ? '' : 's'} · ${esc(tiers(r.tiers.referred))}</span></div><div class="act"><span class="wait">${pct(r.salesReady.referred)} sales-ready</span></div></li>
      <li><div class="who"><span class="who-line"><b>Everyone else</b></span><span class="d">${nf(r.people - r.named)} lead${r.people - r.named === 1 ? '' : 's'} · ${esc(tiers(r.tiers.others))}</span></div><div class="act"><span class="wait">${pct(r.salesReady.others)} sales-ready</span></div></li>
    </ul>`;
  const ranked = r.referrers.length
    ? `<div class="eyebrow ref-h">Referrers, by leads sent</div><ul class="fq" aria-label="Referrers by leads sent">${r.referrers.slice(0, 5).map((x) => `<li>
        <div class="who"><span class="who-line"><a class="jump" href="${buildAddress('stream', { referrer: x.name })}" title="Open this referrer's leads in the Lead stream"><b>${esc(x.name)}</b></a> ${kind(x)}</span><span class="d">${x.owner ? `owner ${esc(x.owner)}` : 'no owner'}</span></div>
        <div class="act"><span class="wait">${nf(x.leads)} lead${x.leads === 1 ? '' : 's'} · ${nf(x.salesReady)} sales-ready</span></div></li>`).join('')}</ul>`
    : '<div class="none">Nobody has named a referrer yet.</div>';
  const table = dtable(['Referrer', 'Customer', 'Owner', 'Leads', 'Sales-ready'], r.referrers.map((x) => [x.name, x.customer ? 'yes' : x.key ? 'no' : 'not identified', x.owner || '—', x.leads, x.salesReady]), 3);
  return vcard({ id: 'referrals', title: 'Named referrals', sub: `${nf(r.named)} of ${nf(r.people)} leads${r.share != null ? ` · ${r.share}%` : ''}`, body: compare + ranked, table, span: 'span-7',
    foot: `<span><b>${nf(r.webOrUtmReferral)}</b> more read referral from a web referrer or UTM only, with nobody named</span><span><b>${nf(r.thanksPlanned)}</b> thank-you task${r.thanksPlanned === 1 ? '' : 's'} planned for an owner (dry-run)</span>` });
}

function ovSpeed(d) {
  const sp = d.speed;
  const stageLabel = { normalize: 'Normalize', resolve: 'Resolve', qualify: 'Qualify', score: 'Score', route: 'Route', crm: 'CRM plan', notify: 'Alert' };
  const rows = [{ id: 'queue', label: 'Queue wait', ...sp.queue, wait: true }];
  const stages = sp.stages.map((s) => ({ id: s.stage, label: stageLabel[s.stage] || s.stage, ...s }));
  const slowest = stages.reduce((a, s) => ((s.p50 ?? -1) > (a?.p50 ?? -1) ? s : a), null);
  const so = sp.secondOpinion || { ran: 0 }; // absent in sample data recorded before the model moved off the path
  const alert = sp.timeToAlert || { n: 0, p50: null, p90: null };
  const opinion = so.ran ? { label: 'Second opinion', sub: true, n: so.answered, p50: so.p50, p90: so.p90 } : null;
  const max = Math.max(1, ...[...rows, ...stages, sp.model || {}, opinion || {}].map((r) => r.p90 || 0));
  const scale = niceScale(max, 4, false);
  const srow = (r, cls = '') => `<div class="srow ${cls}">
      <div class="lab">${r.sub ? `<small>${esc(r.label)}</small>` : esc(r.label)}</div>
      <div class="bars" style="--r:0px">${r.p90 != null ? `<span class="p90" style="width:${scalePos(r.p90 / scale.max)}"></span>` : ''}${r.p50 != null ? `<span class="p50" style="width:${scalePos(r.p50 / scale.max)}"></span>` : ''}</div>
      <div class="v"><b>${esc(fmtMs(r.p50))}</b> · ${esc(fmtMs(r.p90))}</div>
    </div>`;
  let chart = srow(rows[0], 'wait') + '<div class="srow-div"></div>';
  for (const s of stages) {
    chart += srow(s, s === slowest && (s.p50 || 0) > 0 ? 'is-key' : '');
    if (s.id === 'qualify' && sp.model) chart += srow({ label: 'model call', sub: true, ...sp.model }, 'sub');
  }
  // the second opinion runs after the alert, off the path: drawn below a divider so it is not read as part of the route
  if (opinion) chart += '<div class="srow-div"></div>' + srow({ ...opinion, label: 'second opinion' }, 'sub');
  const axis = `<div class="axis" style="grid-template-columns:104px minmax(0,1fr) 112px;--r:0px" aria-hidden="true"><span></span><div class="ticks">${scale.ticks.map((t) => `<span style="left:${scalePos(t / scale.max)}">${esc(t === 0 ? '0' : fmtMs(t))}</span>`).join('')}</div><span></span></div>`;
  const sum = `<div class="speed-sum">
    <div><div class="k"><i class="sw p50"></i>Processing</div><div class="v">${esc(fmtMs(sp.processing.p50))}<small>p90 ${esc(fmtMs(sp.processing.p90))}</small></div></div>
    <div><div class="k"><i class="sw wait"></i>Queue wait</div><div class="v">${esc(fmtMs(sp.queue.p50))}<small>p90 ${esc(fmtMs(sp.queue.p90))}</small></div></div>
    <div><div class="k">Time to route</div><div class="v">${esc(fmtMs(sp.timeToRoute.p50))}<small>p90 ${esc(fmtMs(sp.timeToRoute.p90))}</small></div></div>
    <div title="${esc(sp.digestDelay?.n ? `Leads with their own alert. ${sp.digestDelay.n} list rows were alerted by their list's digest, about ${fmtMs(sp.digestDelay.p50)} after arriving.` : 'Leads with their own alert.')}"><div class="k">Time to alert</div><div class="v">${esc(fmtMs(alert.p50))}<small>p90 ${esc(fmtMs(alert.p90))}</small></div></div>
  </div>`;
  const legend = `<div class="legend"><span><i class="sw p50"></i>p50</span><span><i class="sw p90"></i>p90</span></div>`;
  const table = dtable(['Step', 'Leads', 'p50', 'p90'], [
    rows[0], ...stages,
    ...(sp.model ? [{ label: 'Model call the route waited for (part of Qualify)', ...sp.model }] : []),
    ...(opinion ? [{ ...opinion, label: 'Second opinion, after the alert (off the path)' }] : []),
    { label: 'Time to alert, sales routes', ...alert },
  ].map((r) => [r.label, r.n, fmtMs(r.p50), fmtMs(r.p90)]));
  const waited = sp.model ? `The route waited for the model on <b>${nf(sp.model.n)}</b> lead${sp.model.n === 1 ? '' : 's'}` : 'No route waited for the model';
  const after = so.ran ? ` · second opinion on <b>${nf(so.ran)}</b> after the alert: <b>${nf(so.changed)}</b> would change a field, <b>${nf(so.doubts)}</b> raised a doubt` : '';
  return vcard({ id: 'speed', title: 'Where the time goes', legend, body: sum + chart + axis, table, span: 'span-5',
    foot: sp.model || so.ran ? `<span>${waited}${after}${so.due ? ` · ${nf(so.due)} still due` : ''}</span>` : `<span>No model calls in this data: the classifier ran on rules alone</span>` });
}

function ovSpeedBy(d) {
  const sp = d.speed;
  const rows = [...sp.byDoor.map((r) => ({ ...r, label: lab('source', r.source), grp: 'door' })), ...sp.byMarket.map((r) => ({ ...r, grp: 'market' }))];
  const max = Math.max(1, ...rows.map((r) => r.routeP50 || 0));
  const line = (r) => `<tr>
      <td>${esc(r.label)}</td><td class="num">${nf(r.n)}</td><td class="num">${esc(fmtMs(r.processingP50))}</td><td class="num">${esc(fmtMs(r.queueP50))}</td>
      <td class="ibar-cell"><span class="ibar"><i style="width:${((r.routeP50 || 0) / max) * 100}%"></i></span><span class="strong">${esc(fmtMs(r.routeP50))}</span></td></tr>`;
  const head = `<thead><tr><th></th><th class="num">Leads</th><th class="num">Processing</th><th class="num">Queue</th><th>Time to route</th></tr></thead>`;
  const body = `<table class="dtable compact">${head}<tbody>
      <tr class="divider"><td colspan="5">By door</td></tr>${rows.filter((r) => r.grp === 'door').map(line).join('')}
      <tr class="divider"><td colspan="5">By buyer type</td></tr>${rows.filter((r) => r.grp === 'market').map(line).join('')}
    </tbody></table>`;
  return vcard({ id: 'speedby', title: 'Speed by door and buyer type', sub: 'medians', body, span: 'span-7' });
}

function ovReps(d) {
  const due = (iso) => { if (!iso) return '<span class="muted">none open</span>'; const f = fmtShort(iso); return `${esc(f.day.split(',')[0])} ${esc(f.time)}`; };
  const row = (r) => `<tr>
    <td class="strong">${esc(r.name)}</td><td>${esc(teamName(r.team))}</td>
    <td class="num">${nf(r.assigned)}</td><td class="num">${nf(r.aTier)}</td>
    <td class="num">${r.kind === 'rep' ? nf(r.claimed) : '<span class="muted">—</span>'}</td>
    <td>${r.kind === 'rep' ? `<span class="meter"><span class="m"><i class="${r.load24h >= r.capacity ? 'full' : ''}" style="width:${Math.min(100, (r.load24h / Math.max(1, r.capacity)) * 100)}%"></i></span><span>${nf(r.load24h)}/${nf(r.capacity)}</span></span>` : '<span class="muted">—</span>'}</td>
    <td>${due(r.nextSlaDue)}</td>
    <td class="num">${r.alertP50 == null ? '<span class="muted">—</span>' : esc(fmtMs(r.alertP50))}</td>
  </tr>`;
  const head = `<thead><tr><th>Owner</th><th>Team</th><th class="num">Assigned</th><th class="num">A-tier</th><th class="num">Accounts claimed</th><th>Load, 24 h</th><th>Next SLA due</th><th class="num">Time to alert</th></tr></thead>`;
  const body = `<table class="dtable">${head}<tbody>${d.reps.map(row).join('')}<tr class="divider"><td colspan="8">Queues and shared owners</td></tr>${d.queues.filter((q) => q.assigned > 0).map(row).join('') || '<tr><td colspan="8" class="muted">Nothing in a queue yet.</td></tr>'}</tbody></table>`;
  return vcard({ id: 'reps', title: 'Rep and team load', body, span: 'span-12' });
}

function ovSync(d, span = 'span-5') {
  const h = d.hubspot;
  const rows = h.requests.filter((r) => r.planned > 0 || ['contacts_upsert', 'companies_upsert', 'association', 'task_create'].includes(r.id)).map((r) => ({ label: r.object, value: r.planned }));
  const maxIdx = rows.reduce((bi, r, i, a) => (r.value > a[bi].value ? i : bi), 0);
  const body = hbars(rows, { lw: 110, keyIndex: rows.length ? maxIdx : -1 });
  const recOk = h.record.lines === h.plannedDryRun;
  const table = dtable(['Object', 'Operation', 'Planned', 'Failed', 'Reused'], h.requests.map((r) => [r.object, r.op, r.planned, r.failed, r.reused]), 2);
  return vcard({ id: 'sync', title: h.mode === 'dry_run' ? 'HubSpot requests planned' : 'HubSpot requests sent', sub: h.mode === 'dry_run' ? 'dry-run' : 'live', body, table, span,
    foot: `<span><b>${nf(h.failed)}</b> failed</span><span><b>${nf(h.leadsNotWritten)}</b> ${h.leadsNotWritten === 1 ? 'lead' : 'leads'} with no CRM write, by design</span><span><b>${nf(h.redeliveriesWithoutWrites)}</b> ${h.redeliveriesWithoutWrites === 1 ? 're-delivery' : 're-deliveries'} wrote nothing</span>${h.mode === 'live' ? `<span><b>${nf(h.reused)}</b> open tasks reused</span>` : ''}${h.plannedDryRun ? `<span>${recOk ? '' : '<b style="color:var(--warn)">differs</b> '}record: <b>${nf(h.record.lines)}</b> lines in out/hubspot</span>` : ''}` });
}

function ovProps(d) {
  const h = d.hubspot;
  const props = h.properties;
  const utm = props.filter((p) => /_touch_utm_/.test(p.name));
  const main = props.filter((p) => !/_touch_utm_/.test(p.name));
  const prow = (p) => (p.writer === 'reverse_etl'
    ? `<div class="prop etl"><span class="pn">${esc(p.name)}</span><span class="pv span2">reverse ETL</span></div>`
    : `<div class="prop"><span class="pn">${esc(p.name)}</span><span class="pm"><i style="width:${p.of ? (p.written / p.of) * 100 : 0}%"></i></span><span class="pv">${nf(p.written)}/${nf(p.of)}</span></div>`);
  const utmRow = (prefix, label) => {
    const set = utm.filter((p) => p.name.startsWith(prefix));
    const src = set.find((p) => p.name.endsWith('_source'));
    if (!set.length || !src) return '';
    return `<div class="prop"><span class="pn">${esc(label)}</span><span class="pm"><i style="width:${src.of ? (src.written / src.of) * 100 : 0}%"></i></span><span class="pv">${nf(src.written)}/${nf(src.of)}</span></div>`;
  };
  const contacts = main.filter((p) => p.object === 'contact'), companies = main.filter((p) => p.object === 'company');
  const body = props.length ? `<div class="props">
      <div class="props-h">Contacts<span>${nf(h.contactUpserts)} upserts</span></div>
      ${contacts.map(prow).join('')}${utmRow('first_touch_utm_', 'first_touch_utm_*')}${utmRow('last_touch_utm_', 'last_touch_utm_*')}
      <div class="props-h">Companies<span>${nf(h.companyUpserts)} upserts</span></div>
      ${companies.map(prow).join('')}
    </div>` : '<div class="none">docs/hubspot-properties.json was not found.</div>';
  const table = dtable(['Object', 'Property', 'Written', 'Of upserts'], props.map((p) => [p.object, p.name, p.writer === 'reverse_etl' ? 'reverse ETL' : p.written, p.of]), 2);
  return vcard({ id: 'props', title: 'Custom properties written', body, table, span: 'span-7' });
}

function ovLifecycle(d, span = 'span-4') {
  const h = d.hubspot;
  const total = h.lifecycle.reduce((a, x) => a + x.n, 0);
  const parts = h.lifecycle.filter((x) => x.n > 0);
  const inkDark = { D: true, X: true };
  const tall = total ? `<div class="tall" role="img" aria-label="${esc(parts.map((x) => `${(LIFECYCLE[x.stage] || [x.stage])[0]} ${x.n}`).join(', '))}">${parts.map((x) => { const [name, tier] = LIFECYCLE[x.stage] || [x.stage, 'X']; const share = Math.round((x.n / total) * 100); return `<span class="seg-${tier}${inkDark[tier] ? ' dark-ink' : ''}" style="flex:${x.n} 1 0">${share >= 12 ? `${share}%` : ''}</span>`; }).join('')}</div>` : '<div class="none">No contact upserts yet.</div>';
  const legend = `<div class="legend" style="margin-bottom:4px">${h.lifecycle.map((x) => { const [name, tier] = LIFECYCLE[x.stage] || [x.stage, 'X']; return `<span><i class="sw ${tier}"></i>${esc(name)} <b style="color:var(--ink);font-weight:600">${nf(x.n)}</b></span>`; }).join('')}</div>`;
  const table = dtable(['Lifecycle stage', 'Contacts'], h.lifecycle.map((x) => [(LIFECYCLE[x.stage] || [x.stage])[0], x.n]));
  return vcard({ id: 'lifecycle', title: 'Lifecycle stage set', body: tall + legend, table, span });
}

function ovMatching(d) {
  const m = d.matching;
  const conf = (x) => { const parts = ['high', 'medium', 'low'].filter((c) => x[c]); return parts.length === 1 ? `${parts[0]} confidence` : parts.map((c) => `${x[c]} ${c}`).join(', '); };
  const rows = m.methods.map((x) => ({ label: lab('method', x.method), value: x.n, endSmall: conf(x) }));
  const body = rows.length ? hbars(rows, { lw: 170, keyIndex: 0 }) : '<div class="none">No leads have reached matching yet.</div>';
  const table = dtable(['Method', 'Matched', 'High', 'Medium', 'Low'], m.methods.map((x) => [lab('method', x.method), x.n, x.high, x.medium, x.low]));
  return vcard({ id: 'matching', title: 'Match method and confidence', body, table, span: 'span-8',
    foot: `<span><b>${nf(m.matched)}</b> of ${nf(m.reached)} matched</span><span><b>${nf(m.ambiguous)}</b> ambiguous</span><span><b>${nf(m.unresolved)}</b> unmatched</span><span>keys: ${esc(m.keyKinds.map((k) => `${KEY_KIND[k.kind] || k.kind} ${k.n}`).join(' · ') || 'none')}</span>` });
}

function ovHygiene(d) {
  const h = d.hygiene || {};
  const items = [
    [h.utmFixed, 'campaign tags fixed'],
    [h.titlesNormalized, 'job titles normalized'],
    [h.duplicatesMerged, 'repeat contacts attached'],
    [h.idempotentReplays, 're-deliveries ignored'],
    [h.freeMailResolved, 'free-mail leads matched'],
    [h.spamDropped, 'spam dropped'],
    [h.nonUs, 'outside the US'],
    [d.stageFailures ?? 0, 'stage failures'],
  ];
  const body = `<div class="counters two">${items.map(([n, l]) => `<div class="counter"><div class="n">${nf(n ?? 0)}</div><div class="l">${esc(l)}</div></div>`).join('')}</div>`;
  return vcard({ id: 'hygiene', title: 'Hygiene counters', body, span: 'span-4' });
}

function feedItem(a, isNew) {
  const who = [a.person, a.org].filter(Boolean).join(', ') || 'Unknown';
  let title, detail, dot = a.kind;
  switch (a.kind) {
    case 'alerted':
      if (a.action === 'review') { title = 'Sent to a person'; detail = `RevOps · ${who}`; dot = 'review'; }
      else if (a.action === 'competitor_flag') { title = 'Competitor flagged'; detail = `marketing · ${who}`; dot = 'not_for_sales'; }
      else if (a.action === 'team_queue') { title = `Team queue alerted: ${TEAM_SHORT[a.team] || a.team || ''}`; detail = who; dot = 'routed'; }
      else if (a.action === 'owner_task') { title = `Account owner alerted: ${a.owner || ''}`; detail = who; }
      else if (a.action === 'attach_to_existing') { title = `Owner re-alerted: ${a.owner || ''}`; detail = who; }
      else { title = `Rep alerted: ${a.owner || ''}`; detail = who; }
      break;
    case 'review': title = 'Sent to a person'; detail = who; break;
    case 'nurture': title = 'Sent to nurture'; detail = who; break;
    case 'signal': title = 'Account signal logged'; detail = a.org || 'web visits'; break;
    case 'attached': title = `Repeat contact kept with ${a.owner || 'its owner'}`; detail = who; break;
    case 'not_for_sales': title = `Not for sales: ${(a.reason || lab('action', a.action)).toLowerCase()}`; detail = who; break;
    case 'crm': title = `CRM write planned: ${nf(a.requests)} request${a.requests === 1 ? '' : 's'}`; detail = `HubSpot ${a.mode === 'live' ? 'live' : 'dry-run'} · ${who}`; break;
    case 'duplicate': title = 'Duplicate absorbed'; detail = `${lab('source', a.source)} re-delivered, no new lead`; break;
    case 'failed': title = `Step failed: ${a.stage}`; detail = a.note || who; break;
    default: title = `Routed to ${a.owner || a.team || 'a queue'}`; detail = who; dot = 'routed';
  }
  return `<li class="${isNew ? 'is-new' : ''}${a.kind === 'crm' ? ' quiet' : ''}"><span class="fdot ${esc(dot)}" aria-hidden="true"></span>
    <div class="ft"><a class="jump" href="${leadHref(a.leadId)}"><b>${esc(title)}</b></a><span class="d">${esc(detail)}</span></div>
    <span class="when" title="${esc(`${fmtFull(a.at)} · ${utcExact(a.at)}`)}">${esc(ago(a.at))}</span></li>`;
}
function ovActivity(d) {
  const keyOf = (a) => `${a.leadId}|${a.kind}|${a.at}`;
  const first = state.seenFeed.size === 0;
  const body = d.activity.length ? `<ul class="feed" aria-label="Recent router activity">${d.activity.map((a) => feedItem(a, !first && !state.seenFeed.has(keyOf(a)))).join('')}</ul>` : '<div class="none">Nothing yet.</div>';
  for (const a of d.activity) state.seenFeed.add(keyOf(a));
  return vcard({ id: 'activity', title: 'Activity', body, span: 'span-7' });
}
function ovFollowUp(d, span = 'span-5') {
  const r = d.review;
  // a list's review rows collapse to one line here; the Needs a person tab lists them under the list's heading
  const byList = new Map();
  for (const x of r) if (x.list) byList.set(x.list, [...(byList.get(x.list) || []), x]);
  const listLines = [...byList.entries()].map(([name, rows]) => `<li>
      <div class="who"><span class="who-line"><b>${esc(name)}</b></span><span class="d">${nf(rows.length)} row${rows.length === 1 ? '' : 's'} from this uploaded list</span></div>
      <div class="act"><a class="btn btn-sm fq-open" href="${buildAddress('review', { lead: rows[0].leadId })}" aria-label="Open the ${esc(name)} rows in Needs a person">Open</a></div>
    </li>`).join('');
  const body = r.length ? `<ul class="fq" aria-label="Leads waiting for a person">${listLines}${r.filter((x) => !x.list).map((x) => `<li>
      <div class="who"><span class="who-line">${tierBadge(x.tier)}<b>${esc(x.name || 'Unknown')}</b></span><span class="d">${esc([x.title, x.company ? `said "${x.company}"` : null].filter(Boolean).join(' · '))}</span>
        <span class="why">${SICON.warn.replace('<svg', '<svg width="12" height="12"')}${esc(OV_REASON[x.reason] || x.reason)}</span></div>
      <div class="act"><span class="wait" title="Queued ${esc(`${fmtFull(x.createdAt)} · ${utcExact(x.createdAt)}`)}">${esc(dur(x.createdAt ? Date.now() - Date.parse(x.createdAt) : x.waitMs))}</span><a class="btn btn-sm fq-open" href="${buildAddress('review', { lead: x.leadId })}" aria-label="Open ${esc(x.name || 'this lead')} in Needs a person">Open</a></div>
    </li>`).join('')}</ul>` : '<div class="none">Nothing is waiting for a person.</div>';
  return vcard({ id: 'followup', title: 'Needs a person', sub: r.length ? `${nf(r.length)} waiting` : '', body, span });
}
function ovClocks(d, span = 'span-5') {
  const now = Date.now();
  const o = d.sla.open || [];
  const body = o.length ? `<ul class="fq" aria-label="SLA due times still ahead">${o.map((x) => { const f = fmtShort(x.dueAt); return `<li>
      <div class="who"><span class="who-line">${tierBadge(x.tier)}<a class="jump" href="${leadHref(x.leadId)}"><b>${esc(x.name || 'Unknown')}</b></a></span><span class="d">${esc([x.org, x.owner].filter(Boolean).join(' · '))}</span></div>
      <div class="act"><span class="due" title="${esc(`${fmtFull(x.dueAt)} · ${utcExact(x.dueAt)}`)}">${esc(f.day.split(',')[0])} ${esc(f.time)}</span><span class="wait">${Date.parse(x.dueAt) > now ? `in ${esc(dur(Date.parse(x.dueAt) - now))}` : 'passed'}</span></div>
    </li>`; }).join('')}</ul>` : '<div class="none">No SLA due times ahead of now.</div>';
  return vcard({ id: 'clocks', title: 'SLA clocks running', sub: d.sla.openCount ? `${nf(d.sla.openCount)} open` : '', body, span });
}

/** The sticky index of the Overview: its four groups, and the two cards people look for first, each with a count. */
function overviewIndex(d) {
  return indexHTML([
    { id: 'pipeline', label: 'Pipeline', count: d.kpis.leadsIn.value },
    { id: 'lists', label: 'Uploaded lists', count: (d.lists || []).length },
    { id: 'referrals', label: 'Named referrals', count: d.referrals ? d.referrals.named : 0 },
    { id: 'speed', label: 'Speed to lead', count: d.speed?.timeToAlert?.n ?? 0 },
    { id: 'data', label: 'HubSpot and data quality', count: d.hubspot ? d.hubspot.failed : 0 },
    { id: 'live', label: 'Live', count: (d.activity || []).length },
  ], 'Sections of the Overview');
}
function renderOverview() {
  const box = $('#overview');
  const d = state.dash;
  if (!box || !d) return;
  const section = (id, title, inner) => `<section class="sec" data-index-id="${id}"><div class="sec-head"><h2>${esc(title)}</h2></div><div class="grid">${inner}</div></section>`;
  let html = ovHeader(d) + `<section class="band" aria-label="Status">${ovWindow(d)}${ovPath(d)}</section>` + ovKpis(d) + (d.empty ? '' : overviewIndex(d));
  if (d.empty) {
    html += `<div class="card empty-card"><h3>No leads yet</h3></div>`;
  } else {
    html += section('pipeline', 'Pipeline', ovDoors(d) + ovFunnel(d) + ovMarkets(d) + ovNotForSales(d) + ovLists(d) + ovReferrals(d));
    html += section('speed', 'Speed to lead', ovSpeed(d) + ovSpeedBy(d) + ovReps(d));
    html += section('data', 'HubSpot and data quality', `<div class="span-5 colstack">${ovSync(d, '')}${ovLifecycle(d, '')}</div>` + ovProps(d) + ovMatching(d) + ovHygiene(d));
    html += section('live', 'Live', ovActivity(d) + `<div class="span-5 colstack">${ovFollowUp(d, '')}${ovClocks(d, '')}</div>`);
  }
  const y = window.scrollY;
  const feedTop = box.querySelector('.feed')?.scrollTop ?? 0;
  box.innerHTML = html;
  const feed = box.querySelector('.feed');
  if (feed) feed.scrollTop = feedTop;
  if (state.tab === 'overview') window.scrollTo(0, y);
}

let dashTimer = null, dashLast = 0, dashInFlight = false, dashAgain = false;
function scheduleDashboard() {
  if (state.mode !== 'live' || dashTimer) return;
  const wait = Math.max(350, 1200 - (Date.now() - dashLast));
  dashTimer = setTimeout(() => { dashTimer = null; loadDashboard(); }, wait);
}
async function loadDashboard() {
  if (dashInFlight) { dashAgain = true; return; }
  dashInFlight = true;
  dashLast = Date.now();
  const upd = $('#ovUpdated');
  if (upd) upd.classList.add('is-busy');
  try {
    state.dash = await getJSON('/dashboard');
    state.reviewOpen = null; // the dashboard is newer than the tab's last read
    renderReviewTabCount();
    renderStrip();
    renderOverview();
  } catch (e) {
    // keep the last render; say so only when there is nothing on screen yet
    if (!state.dash) $('#overview').innerHTML = `<div class="card empty-card"><h3>The overview could not load</h3><p>${esc(e.message)}</p></div>`;
  } finally {
    dashInFlight = false;
    const u = $('#ovUpdated');
    if (u) u.classList.remove('is-busy');
    if (dashAgain) { dashAgain = false; scheduleDashboard(); }
  }
}

// ─── live updates ────────────────────────────────────────────────────────────
function connectStream() {
  if (state.mode !== 'live' || state.sse || typeof EventSource === 'undefined') return;
  const es = new EventSource('/api/stream');
  const onEvent = (ev) => {
    let data = null;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (!data || !data.id) return;
    state.details.delete(data.id);
    refreshList();
    if (data.id === state.selectedId) refreshDetail();
  };
  es.addEventListener('lead', onEvent);
  es.addEventListener('replay', () => { refreshList(); scheduleDashboard(); });
  es.addEventListener('list', () => { state.details.clear(); refreshList(); scheduleDashboard(); if (state.selectedId) refreshDetail(); });
  es.onmessage = onEvent;
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      state.sse = null;
      startPolling();
    }
  };
  state.sse = es;
}
function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    if (state.mode !== 'live') return;
    loadList();
    loadDashboard();
    if (state.selectedId) loadDetail(state.selectedId, true);
  }, 3000);
}
function startProbing() {
  if (state.probeTimer) return;
  state.probeTimer = setInterval(async () => {
    if (state.mode === 'live') return;
    if (await probeLive()) {
      clearInterval(state.probeTimer);
      state.probeTimer = null;
      await switchToLive();
    }
  }, 8000);
}
async function switchToLive() {
  setMode('live');
  state.leads = [];
  state.known.clear();
  state.details.clear();
  state.selectedId = null;
  state.seenFeed.clear();
  await Promise.all([loadList(), loadDashboard(), loadEval()]);
  connectStream();
}

// ─── actions ─────────────────────────────────────────────────────────────────
let replayArmed = false;
async function onReplay() {
  const btn = $('#replayBtn');
  if (!replayArmed) {
    replayArmed = true;
    btn.lastChild.textContent = 'Click again to clear and replay';
    setTimeout(() => { replayArmed = false; btn.lastChild.textContent = 'Replay a day'; }, 3500);
    return;
  }
  replayArmed = false;
  btn.lastChild.textContent = 'Replay a day';
  if (state.mode !== 'live') return simulateReplay();
  btn.disabled = true;
  try {
    state.leads = [];
    state.known = new Set(['__replay__']);
    state.details.clear();
    state.selectedId = null;
    state.follow = true;
    drawList();
    $('#detail').innerHTML = '<div class="empty"><div class="empty-title">Replaying the day</div></div>';
    state.seenFeed.clear();
    await postJSON('/demo/replay', { paceMs: 2000 });
    scheduleDashboard();
  } catch (e) {
    alertInline(`Replay failed: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}
async function simulateReplay() {
  const all = (await getJSON('/leads')).leads || [];
  all.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  state.leads = [];
  state.known = new Set(['__sim__']);
  state.follow = true;
  drawList();
  for (const l of all) {
    await new Promise((r) => setTimeout(r, 500));
    state.leads = [l, ...state.leads];
    state.fresh.add(l.id);
    drawList();
    select(l.id, { keepFollow: true });
  }
  state.follow = false;
}
function alertInline(msg) {
  $('#detail').innerHTML = `<div class="empty"><div class="empty-title">${esc(msg)}</div></div>`;
}

// drawer
const PRESETS = [
  { label: 'Health-system contracting VP', v: { name: 'Jamie Patel', email: 'jpatel@piedmont.org', title: 'VP, Managed Care', company: 'Piedmont Healthcare', state: 'GA', source: 'calendly_demo', utmPreset: 'linkedin_paid', message: 'Our biggest commercial contract renews next quarter and we need peer rate benchmarks before talks start.' } },
  { label: 'Consultant at an owned account', v: { name: 'Robin Hale', email: 'rhale@alderfinch.example', title: 'Senior Vice President, Health & Benefits', company: 'Alder & Finch Benefits', state: 'NY', source: 'calendly_demo', utmPreset: 'google_brand', message: 'Several self-funded clients renew in Q1. Looking at network benchmarking for their RFPs.' } },
  { label: 'Payer network team', v: { name: 'Robin Ellis', email: 'rellis@ibx.com', title: 'Director, Provider Network Strategy', company: 'Independence Blue Cross', state: 'PA', source: 'calendly_demo', utmPreset: 'newsletter', message: 'Comparing our facility rates with other plans in Philadelphia before budget planning next month.' } },
  { label: 'Free-mail, ambiguous company', v: { name: 'Jesse Lin', email: 'jesse.lin@gmail.com', title: 'Director of Managed Care', company: 'Baptist Health', state: '', source: 'calendly_demo', utmPreset: 'none', message: 'Need commercial rate benchmarks.' } },
  { label: 'Organization in the rate file', v: { name: 'Morgan Reyes', email: 'mreyes@integrisok.com', title: 'Director, Managed Care Contracting', company: 'INTEGRIS Health', state: 'OK', source: 'calendly_demo', utmPreset: 'none', message: 'We are preparing for our UnitedHealthcare behavioral health renewal and want to see peer rates before we sit down.' } },
  { label: 'Job seeker', v: { name: 'Pat Kim', email: 'pat.kim@gmail.com', title: 'Data Analyst', company: '', state: '', source: 'calendly_demo', utmPreset: 'none', message: "Not a buyer, but I'd love to work at Serif. Are you hiring analysts?" } },
];
function openDrawer() {
  $('#drawer').classList.add('is-open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  $('#formMsg').textContent = '';
  // focus the first field once the drawer is open, unless the person (or a browser test) is already typing in the form:
  // a late focus would move their next keystrokes into the name field
  setTimeout(() => { if (!$('#leadForm').contains(document.activeElement)) $('#leadForm [name=name]').focus(); }, 50);
}
function closeDrawer() {
  $('#drawer').classList.remove('is-open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
}
function fillPreset(v) {
  const f = $('#leadForm');
  for (const [k, val] of Object.entries(v)) if (f.elements[k]) f.elements[k].value = val;
}
async function onSubmit(ev) {
  ev.preventDefault();
  const f = ev.currentTarget;
  const body = Object.fromEntries(new FormData(f).entries());
  body.state = (body.state || '').toUpperCase();
  const msg = $('#formMsg');
  msg.className = 'form-msg';
  msg.textContent = 'Sending…';
  try {
    const res = await postJSON('/demo/submit', body);
    msg.textContent = 'Accepted. Watch it route.';
    state.follow = false;
    closeDrawer();
    goTab('stream');
    if (res && res.leadId) {
      state.selectedId = res.leadId;
      state.addressLead = res.leadId;
      syncAddress({ push: false });
      stream.markSelected(res.leadId);
      loadDetail(res.leadId, false);
      refreshList();
    }
  } catch (e) {
    msg.className = 'form-msg err';
    msg.textContent = e.message;
  }
}

// ─── tabs and the address ───────────────────────────────────────────────────────
// Four tabs are their own modules, loaded and mounted the first time the tab opens. Each hands back show() for when the tab opens,
// applyAddress(params) to take the view an address names, and address() to give its view back as parameters.
const leadHref = (id) => buildAddress('stream', { lead: id });
const TAB_MODULES = {
  review: {
    file: './review.js', body: '#reviewBody', name: 'Needs a person',
    mount: (m, el, host) => m.mountReview(el, { ...host, fmtTime: fmtFull, onCount: (n) => { state.reviewOpen = n; renderReviewTabCount(); }, openLead: (id) => navigate(leadHref(id)) }),
  },
  outbound: { file: './outbound.js', body: '#outboundBody', name: 'Outbound', mount: (m, el, host) => m.mountOutbound(el, host) },
  'feature-pipeline': { file: './feature-pipeline.js', body: '#featurePipelineBody', name: 'Feature to pipeline', mount: (m, el, host) => m.mountFeaturePipeline(el, host) },
  today: { file: './today.js', body: '#todayBody', name: 'Today', mount: (m, el, host) => m.mountToday(el, host) },
};
const tabLoads = {};
const mounted = {};
/** What a tab module is given: the API, JSON highlighting, and a way to say its view changed so the address follows. */
const hostFor = (tab) => ({ getJSON, postJSON, deleteJSON, jsonHTML, syncAddress: (opts) => { if (state.tab === tab) syncAddress(opts); } });
function tabModule(tab) {
  const def = TAB_MODULES[tab];
  tabLoads[tab] ??= import(def.file)
    .then((m) => def.mount(m, $(def.body), hostFor(tab)))
    .then((api) => { mounted[tab] = api; return api; })
    .catch((e) => { $(def.body).innerHTML = `<div class="card ob-empty"><h3>${esc(def.name)} is not available</h3><p>${esc(e.message)}</p></div>`; throw e; });
  return tabLoads[tab];
}

/** The parameters a tab writes into the address. The Lead stream adds the open lead to its view. */
function paramsFor(tab) {
  if (tab === 'stream') return { ...(state.addressLead ? { lead: state.addressLead } : {}), ...stream.address() };
  return mounted[tab]?.address?.() ?? {};
}
let appliedHash = '';
/** Writes the address for the tab that is open. A change of what is open adds a history entry; a change of filter or sort replaces it. */
function syncAddress({ push = false } = {}) {
  const hash = buildAddress(state.tab, paramsFor(state.tab));
  if (sameAddress(hash, location.hash)) return;
  appliedHash = hash;
  history[push ? 'pushState' : 'replaceState'](null, '', hash);
}
/** Goes to an address: writes it as a new history entry and shows what it names. */
function navigate(hash) {
  appliedHash = hash;
  history[sameAddress(hash, location.hash) ? 'replaceState' : 'pushState'](null, '', hash);
  applyAddress(hash);
}
/** Shows the tab and the view an address names. */
function applyAddress(hash = location.hash) {
  const { tab, params } = parseAddress(hash);
  appliedHash = hash;
  showTab(tab, { then: (m) => m?.applyAddress?.(params) });
  if (tab === 'stream') applyStreamAddress(params);
}
function applyStreamAddress(params) {
  stream.applyParams(params);
  state.addressLead = params.lead || null;
  if (params.lead) {
    state.follow = false;
    state.revealLead = params.lead;
    stream.openListOf(params.lead);
    select(params.lead, { how: 'address' });
    stream.reveal(params.lead);
  } else if (isNarrow()) {
    $('#detail').classList.remove('is-open');
  }
}
/** A tab was clicked: show it as it was left, and add it to the history. */
function goTab(tab) {
  showTab(tab);
  syncAddress({ push: true });
}
window.addEventListener('hashchange', () => { if (!sameAddress(location.hash, appliedHash)) applyAddress(); });
window.addEventListener('popstate', () => { if (!sameAddress(location.hash, appliedHash)) applyAddress(); });

/** Marks a tab as the open one, without loading anything. */
function paintTab(tab) {
  state.tab = tab;
  document.body.classList.toggle('is-fixed', tab === 'stream');
  for (const b of $$('.tab')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const v of $$('.view')) v.classList.toggle('is-active', v.id === `view-${tab}`);
}
function showTab(tab, { then } = {}) {
  const changed = state.tab !== tab;
  paintTab(tab);
  if (changed) window.scrollTo(0, 0);
  if (tab === 'overview' && state.dash) renderOverview();
  if (tab === 'evals') loadEval();
  if (tab === 'quality') loadQuality();
  if (TAB_MODULES[tab]) tabModule(tab).then((m) => m.show().then(() => then?.(m))).catch(() => {});
  else then?.(null);
}

// ─── wiring ──────────────────────────────────────────────────────────────────
function wire() {
  wireIndex($('#overview'));
  $$('.tab').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.tab)));
  stream = mountStream(
    { chips: $('#filterChips'), bar: $('#filterBar'), count: $('#listCount'), head: $('#listHead'), list: $('#leadList'), search: $('#search'), pane: $('.pane-list') },
    { onPick: (id, how) => select(id, { how }), onChange: () => syncAddress({ push: false }), selectedId: () => state.selectedId },
  );
  $('#detail').addEventListener('click', (e) => {
    const copy = e.target.closest('[data-copy-lead]');
    if (copy) { copyAddress(leadHref(copy.dataset.copyLead), copy); return; }
    if (e.target.closest('[data-close-detail]')) {
      $('#detail').classList.remove('is-open');
      state.addressLead = null;
      syncAddress({ push: false });
    }
  });
  // every in-page link that names a view is an address: follow it without leaving the page, unless the person means a new tab
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = a.getAttribute('href');
    if (href === '#') { e.preventDefault(); return; }
    e.preventDefault();
    navigate(href);
  });
  $('#replayBtn').addEventListener('click', onReplay);
  $('#submitBtn').addEventListener('click', openDrawer);
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#presets').innerHTML = PRESETS.map((p, i) => `<button type="button" data-i="${i}">${esc(p.label)}</button>`).join('');
  $('#presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) fillPreset(PRESETS[Number(b.dataset.i)].v);
  });
  $('#leadForm').addEventListener('submit', onSubmit);
  $('#overview').addEventListener('click', (e) => {
    const t = e.target.closest('.tbl-toggle');
    if (t) { state.tableView[t.dataset.card] = !state.tableView[t.dataset.card]; renderOverview(); }
  });
}

/** Keeps --topbar-h equal to the sticky top bar's height, so a bar that sticks under it (Needs a person's name field) sits flush. */
function trackTopbar() {
  const bar = $('.topbar');
  if (!bar || typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => document.documentElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`)).observe(bar);
}

async function boot() {
  wire();
  trackTopbar();
  paintTab(parseAddress(location.hash).tab);
  const live = await probeLive();
  setMode(live ? 'live' : 'sample');
  // the tabs read the API, so the address is applied once the mode is known
  applyAddress();
  // How it works is its own module (how.js): the click-to-explain panel, and the registry counts once the mode is known
  import('./how.js').then((m) => m.mountHow($('#view-how'), { getJSON })).catch(() => {});
  await Promise.all([loadList(), loadDashboard(), loadEval()]);
  if (live) connectStream();
  else startProbing();
}
boot();

