// Small pieces of markup and wording the tabs share: escaping, the tier badge, the route pill, a duration, the short door and team
// names a row uses. No state in here.
import { lab } from './labels.js';

/** @param {unknown} v */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[/** @type {string} */ (c)] ?? c));
}

/** "<1 ms", "340 ms", "1.4 s", or a dash. */
export function fmtMs(/** @type {number | null | undefined} */ ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '—';
  const n = Number(ms);
  if (n < 0.5) return '<1 ms';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`;
}

/** The tier as a small square badge. */
export function tierBadge(/** @type {string | null | undefined} */ t, cls = 'tier') {
  const v = t == null ? null : String(t);
  return `<span class="${cls} tier-${v ?? 'none'}">${esc(v ?? '·')}</span>`;
}

/** The route action as a pill; no action yet is "Processing…". */
export function actionPill(/** @type {string | null | undefined} */ a) {
  return a ? `<span class="pill act-${esc(a)}">${esc(lab('action', a))}</span>` : '<span class="pill act-nurture">Processing…</span>';
}

/** A door in a few words, for a row. */
export const SRC_SHORT = /** @type {Record<string, string>} */ ({
  calendly_demo: 'Demo request', guide_download: 'Guide', signal_ask_waitlist: 'Signal Ask', sample_signup: 'Try Signal',
  marketplace: 'Marketplace', api_key: 'API key', event_scan: 'Event scan', web_intent: 'Web intent',
});

/** A team in a few words, for a row. */
export const TEAM_SHORT = /** @type {Record<string, string>} */ ({ HSP: 'Health systems', BW: 'Benefits', PLS: 'Payers & LS', API: 'Data & API', Review: 'RevOps', Nurture: 'Marketing' });
