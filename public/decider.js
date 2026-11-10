// The name a person decides under, shared by the Needs a person and Outbound tabs and remembered in this browser under one
// key. Sign-in is not built, so this typed name is what the server stores as who decided. Storage can be blocked (a private
// window, cleared site data), so every read and write is guarded and the field simply starts empty then.

export const DECIDER_KEY = 'inbound-router.decidingAs';

/** The remembered name, or '' when there is none or storage is unavailable. */
export function readDecider() {
  try { return localStorage.getItem(DECIDER_KEY) ?? ''; } catch { return ''; }
}

/** Remembers the name for the next visit; a blank name forgets it. */
export function saveDecider(/** @type {string} */ name) {
  try {
    if (name.trim()) localStorage.setItem(DECIDER_KEY, name.trim());
    else localStorage.removeItem(DECIDER_KEY);
  } catch { /* storage blocked: the field still works for this visit */ }
}
