// A sticky index of a long page's sections, each with its count, that jumps to the section. Today and the Overview use it. A section
// is any element carrying data-index-id; the buttons carry data-jump with the same id. Nothing here changes the address.

/**
 * @typedef {{ id: string, label: string, count?: number | string | null }} IndexEntry
 */

const esc = (/** @type {unknown} */ v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[/** @type {string} */ (c)] ?? c));

/**
 * The index as markup. An entry with no count shows just its label.
 * @param {IndexEntry[]} entries
 * @param {string} label what the list of jumps is called for a screen reader
 */
export function indexHTML(entries, label) {
  if (!entries.length) return '';
  const items = entries.map((e) => `<button type="button" class="sec-jump" data-jump="${esc(e.id)}">${esc(e.label)}${e.count == null ? '' : ` <span class="sec-n">${esc(typeof e.count === 'number' ? e.count.toLocaleString('en-US') : e.count)}</span>`}</button>`).join('');
  return `<nav class="sec-index" aria-label="${esc(label)}">${items}</nav>`;
}

/**
 * Makes the index's buttons scroll to their section and put focus on its heading, so a keyboard reader lands where the page did.
 * Safe to call once per root: it listens on the root, so a redraw of the contents keeps working.
 * @param {HTMLElement} root
 */
export function wireIndex(root) {
  root.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-jump]') : null;
    if (!(b instanceof HTMLElement) || !b.dataset.jump) return;
    const target = root.querySelector(`[data-index-id="${CSS.escape(b.dataset.jump)}"]`);
    if (!(target instanceof HTMLElement)) return;
    target.scrollIntoView({ block: 'start' });
    const heading = target.querySelector('h2, h3');
    if (heading instanceof HTMLElement) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  });
}
