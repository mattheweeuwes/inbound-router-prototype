// The cockpit's address, with no DOM in it. The tab, the lead or group or feature that is open, the filters, the sort and the search
// all live in location.hash, as "#stream?lead=<id>&enterprise=1&sort=score". That makes a view a link, lets a reload and the back
// button come back to it, and gives every "Open in ..." control a real href. A tab module reads its own parameters from the address
// (applyAddress) and writes them back (address); this file only turns text into parameters and back.

/** The tab ids the page has, and the short word each one uses in the address (a tab with no entry uses its own id). */
export const TAB_IDS = /** @type {const} */ (['overview', 'today', 'stream', 'review', 'outbound', 'feature-pipeline', 'evals', 'quality', 'how']);
/** @typedef {typeof TAB_IDS[number]} TabId */
/** @typedef {Record<string, string>} Params */

/** @type {Partial<Record<TabId, string>>} */
const SLUG = { 'feature-pipeline': 'feature' };

export const slugOf = (/** @type {TabId} */ tab) => SLUG[tab] ?? tab;

/** The tab an address word names, or null when it names none. */
export function tabOfSlug(/** @type {string} */ slug) {
  return TAB_IDS.find((t) => slugOf(t) === slug) ?? null;
}

/** Decodes one piece of a query string, where a plus is a space. A piece that does not decode is kept as it was written. */
function decode(/** @type {string} */ s) {
  const spaced = s.replace(/\+/g, ' ');
  try { return decodeURIComponent(spaced); } catch { return spaced; }
}

/**
 * Reads a hash. Anything that names no tab lands on the Overview with no parameters, so a stale or mistyped link still opens the page.
 * @param {string} hash
 * @returns {{ tab: TabId, params: Params }}
 */
export function parseAddress(hash) {
  const body = hash.replace(/^#\/?/, '');
  const at = body.indexOf('?');
  const word = at < 0 ? body : body.slice(0, at);
  const tab = tabOfSlug(decode(word));
  if (!tab) return { tab: 'overview', params: {} };
  /** @type {Params} */
  const params = {};
  if (at >= 0) {
    for (const part of body.slice(at + 1).split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const key = decode(eq < 0 ? part : part.slice(0, eq));
      if (key) params[key] = eq < 0 ? '1' : decode(part.slice(eq + 1));
    }
  }
  return { tab, params };
}

/**
 * The hash for a tab and its parameters, in the order given. A parameter that is empty, false or missing is left out, and true is "1",
 * so a view with nothing set is just "#stream".
 * @param {TabId} tab
 * @param {Record<string, string | number | boolean | null | undefined>} [params]
 */
export function buildAddress(tab, params = {}) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === true ? '1' : String(v))}`);
  return `#${slugOf(tab)}${parts.length ? `?${parts.join('&')}` : ''}`;
}

/** Whether two hashes name the same view, whatever order their parameters were written in. */
export function sameAddress(/** @type {string} */ a, /** @type {string} */ b) {
  const x = parseAddress(a);
  const y = parseAddress(b);
  const kx = Object.keys(x.params).sort();
  const ky = Object.keys(y.params).sort();
  return x.tab === y.tab && kx.length === ky.length && kx.every((k, i) => k === ky[i] && x.params[k] === y.params[k]);
}

/** A parameter that means yes: "1", "true" or "yes". */
export const isOn = (/** @type {string | undefined} */ v) => v === '1' || v === 'true' || v === 'yes';

/** The value when it is one of the allowed words, else the fallback: a hand-edited address cannot put a view in a state it does not have. */
export function oneOf(/** @type {string | undefined} */ v, /** @type {readonly string[]} */ allowed, /** @type {string} */ fallback) {
  return v !== undefined && allowed.includes(v) ? v : fallback;
}
