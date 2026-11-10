// Redrawing a list throws away the control that had focus. keepFocus runs a redraw and gives focus back to the same control (the one
// carrying the same data-fk) inside `scope`, with the caret where it was in a text box, and without moving the page.

/**
 * @param {ParentNode} scope where to look for the control after the redraw
 * @param {() => void} redraw
 */
export function keepFocus(scope, redraw) {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && scope.contains(active) ? active.dataset.fk : undefined;
  const caret = active instanceof HTMLInputElement ? active.selectionStart : null;
  redraw();
  if (!key) return;
  const again = /** @type {HTMLElement | null} */ (scope.querySelector(`[data-fk="${CSS.escape(key)}"]`));
  again?.focus({ preventScroll: true });
  if (again instanceof HTMLInputElement && caret != null) again.setSelectionRange(caret, caret);
}
