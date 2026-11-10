// "Copy link": puts the address of a view on the clipboard, and says so beside the button. A browser that refuses the clipboard (an
// insecure page, a blocked permission) gets the link printed instead, so it can still be copied by hand.

/**
 * @param {string} hash the address to copy, as "#stream?lead=..."
 * @param {HTMLElement} button the button that was pressed; its sibling with class copy-msg shows the result
 */
export async function copyAddress(hash, button) {
  const url = new URL(location.href);
  url.hash = hash;
  const note = button.parentElement?.querySelector('.copy-msg');
  /** @param {string} text */
  const say = (text) => {
    if (!(note instanceof HTMLElement)) return;
    note.textContent = text;
    setTimeout(() => { if (note.textContent === text) note.textContent = ''; }, 4000);
  };
  try {
    await navigator.clipboard.writeText(url.href);
    say('Link copied');
  } catch {
    say(`Copy failed. The link is ${url.href}`);
  }
}
