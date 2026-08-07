/**
 * Small DOM helpers shared across the client.
 */

/**
 * Is the user currently typing into a field?
 *
 * Every global keyboard shortcut MUST check this first. The game listens on
 * `window` for single-letter hotkeys (H for help, Q for build, B for buffs, F
 * to defend, R to release the garrison, 1-4 to ping) and several of them call
 * preventDefault. Without this guard those letters are silently unusable in
 * any text field — you could not type "Chirag" because the H never arrives,
 * and pressing space or F while naming yourself would fire game commands.
 */
export function isTypingInto(event) {
  const el = event?.target;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}
