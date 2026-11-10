// How it works: click a box on the drawing to see what it is built with, how it works, and the tests that prove it. The
// registry counts on the drawing are read from the server (GET /api/how), so they are the registry it runs on; with no
// server the figures written in the page stay. The words are in how-model.js, which a test checks against the code.
import { TOPO } from './how-model.js';

/**
 * @typedef {{ getJSON: (path: string) => Promise<any> }} Host
 * @typedef {import('./how-model.js').Node} Node
 */

const esc = (/** @type {unknown} */ v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[/** @type {string} */ (c)] ?? c));

/**
 * Wires the drawing inside `el` once.
 * @param {HTMLElement} el the How it works section
 * @param {Host} host
 */
export function mountHow(el, host) {
  const svg = /** @type {SVGSVGElement | null} */ (el.querySelector('.diagram svg'));
  const box = /** @type {HTMLElement | null} */ (el.querySelector('#topoDetail'));
  if (!svg || !box) return;
  /** @type {string | null} */
  let openId = null;

  const mark = (/** @type {string | null} */ id) => svg.querySelectorAll('[data-node]').forEach((g) => g.classList.toggle('is-active', /** @type {HTMLElement} */ (/** @type {unknown} */ (g)).dataset.node === id));
  const show = (/** @type {string} */ id) => {
    const n = TOPO[id];
    if (!n) return;
    openId = id;
    box.innerHTML = nodeHTML(n);
    box.hidden = false;
    mark(id);
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
  };
  const hide = () => { openId = null; box.hidden = true; box.innerHTML = ''; mark(null); };
  const nodeOf = (/** @type {EventTarget | null} */ t) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (t).closest?.('[data-node]') ?? null);

  svg.addEventListener('click', (e) => { const g = nodeOf(e.target); if (g?.dataset.node) show(g.dataset.node); });
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = nodeOf(e.target);
    if (g?.dataset.node) { e.preventDefault(); show(g.dataset.node); }
  });
  box.addEventListener('click', (e) => { if (/** @type {Element} */ (e.target).closest('.topo-close')) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) hide(); });
  void fillRegistry(el, host);
}

/** One box's panel: what it is, how it is built, what changes in production, and the tests behind it. */
function nodeHTML(/** @type {Node} */ n) {
  const facts = n.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  const secs = n.sections.map((s) => {
    const t = s.ordered ? 'ol' : 'ul';
    return `<div class="topo-sec"><h4>${esc(s.h)}</h4><${t}>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</${t}></div>`;
  }).join('');
  const tests = n.tests.map(([file, title]) => `<li><code>${esc(file)}</code>: ${esc(title)}</li>`).join('');
  return `<div class="topo-head"><div><div class="topo-kicker">How it's built</div><h3>${esc(n.title)}</h3><div class="topo-files">${esc(n.files)}</div></div><button type="button" class="topo-close">Close</button></div>`
    + `<p class="topo-sum">${esc(n.sum)}</p><dl class="topo-facts">${facts}</dl><div class="topo-cols">${secs}</div>`
    + `<p class="topo-prod"><b>In production:</b> ${esc(n.prod)}</p>`
    + `<div class="topo-sec topo-tests"><h4>Proved by</h4><ul>${tests}</ul></div>`;
}

/** Puts the running registry's counts in the drawing. */
async function fillRegistry(/** @type {HTMLElement} */ el, /** @type {Host} */ host) {
  try {
    const { registry } = await host.getJSON('/how');
    for (const span of el.querySelectorAll('[data-fact]')) {
      const v = registry[/** @type {HTMLElement} */ (/** @type {unknown} */ (span)).dataset.fact ?? ''];
      if (typeof v === 'number') span.textContent = v.toLocaleString('en-US');
    }
  } catch { /* sample mode, or an older server: the counts written in the page stay */ }
}
