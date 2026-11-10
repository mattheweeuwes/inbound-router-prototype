// How the cockpit prints a time, in one place. Every time reads in Eastern time (the team's clock and the stream's from the start),
// and the exact UTC time is on hover, so a figure on Today and the same moment in the Lead stream never disagree. No DOM in here
// except the markup string timeTag() returns.

export const TZ = 'America/New_York';

/** @param {unknown} v */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[/** @type {string} */ (c)] ?? c));

/** A valid date for the text, or null. */
const asDate = (/** @type {string | null | undefined} */ iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * "Tue, Nov 10" and "9:05 AM": the two halves a row prints on two lines.
 * @param {string | null | undefined} iso
 */
export function shortParts(iso) {
  const d = asDate(iso);
  if (!d) return { day: '', time: '—' };
  return {
    day: d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }),
  };
}

/** "Tue, Nov 10, 9:05:07 AM ET", or a dash. */
export function fullTime(/** @type {string | null | undefined} */ iso) {
  const d = asDate(iso);
  if (!d) return '—';
  return `${d.toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })} ET`;
}

/** "Nov 10, 9:05 AM": a time in a table cell, where the column already says what it is. */
export function cellTime(/** @type {string | null | undefined} */ iso) {
  const d = asDate(iso);
  if (!d) return '—';
  return d.toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "2026-11-10 14:05:07 UTC": the exact moment, for the hover. */
export function utcExact(/** @type {string | null | undefined} */ iso) {
  const d = asDate(iso);
  return d ? `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC` : '';
}

/**
 * A time as markup: the text a reader sees, with the exact UTC time on hover. An empty or unreadable time is a dash.
 * @param {string | null | undefined} iso
 * @param {'cell' | 'full' | 'short'} [style]
 */
export function timeTag(iso, style = 'cell') {
  const d = asDate(iso);
  if (!d) return '—';
  const text = style === 'full' ? fullTime(iso) : style === 'short' ? (({ day, time }) => `${day.split(',')[0]} ${time}`)(shortParts(iso)) : cellTime(iso);
  return `<time datetime="${esc(d.toISOString())}" title="${esc(utcExact(iso))}">${esc(text)}</time>`;
}

const STAMP = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/g;

/**
 * Text the server wrote with "2026-11-10 14:05 UTC" in it, escaped, with each such time turned into a local time with the UTC
 * time on hover. Everything else in the text is only escaped.
 * @param {string} text
 */
export function withLocalTimes(text) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(STAMP)) {
    out += esc(text.slice(last, m.index));
    out += timeTag(`${m[1]}T${m[2]}:00Z`, 'short');
    last = (m.index ?? 0) + m[0].length;
  }
  return out + esc(text.slice(last));
}
