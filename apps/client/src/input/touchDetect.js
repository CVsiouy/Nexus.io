/**
 * touchDetect — "is this a touch device?", asked carefully.
 * ───────────────────────────────────────────────────────
 *
 * The rule that keeps this honest:
 *
 *     CAPABILITY decides LAYOUT.  e.pointerType decides BEHAVIOUR.
 *
 * Layout can be a one-time decision — bigger buttons harm nobody. Behaviour
 * must NEVER be, because a hybrid device has both. A Surface user with a
 * trackpad and a touchscreen should get mouse behaviour from one and touch
 * behaviour from the other, in the same session, with no mode flicker. That
 * falls out for free if every input branch tests the EVENT rather than the
 * device — see InputSystem._bindEvents.
 *
 * Deliberately NOT used:
 *   • User-agent sniffing — wrong on principle and wrong in practice.
 *   • `'ontouchstart' in window` — true in desktop Chrome's device emulation
 *     and on plenty of touch-capable laptops that are mouse-driven in reality.
 */

const mq = (q) => (typeof matchMedia === 'function' ? matchMedia(q) : null);

/**
 * `pointer: coarse` means the PRIMARY pointer is imprecise — a finger.
 *
 * Note `pointer`, not `any-pointer`: `any-pointer: coarse` is true on a Windows
 * laptop with a touchscreen AND a mouse, which is exactly the machine we want
 * left on the desktop layout.
 *
 * The `maxTouchPoints && !any-pointer:fine` clause is a fallback for browsers
 * that report the media query poorly but do have touch and no fine pointer.
 */
export function detectTouch() {
  const coarse  = mq('(pointer: coarse)')?.matches ?? false;
  const anyFine = mq('(any-pointer: fine)')?.matches ?? false;
  const points  = typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0;

  // An explicit ?touch=1 forces the touch path so desktop Chrome's device
  // emulation exercises the real code rather than an approximation of it.
  if (typeof location !== 'undefined' && /[?&]touch=1\b/.test(location.search)) return true;

  return coarse || (points > 0 && !anyFine);
}

export const touchLikely = detectTouch();

/**
 * "Is this a touch device?", asked at the MOMENT IT MATTERS.
 *
 * `touchLikely` above is evaluated once, when this module is first imported.
 * That is fine for the initial CSS class, but it is wrong for any decision made
 * later — and it caused a real bug: CameraController captured it at
 * construction and used it to gate the 1.8x touch zoom, so on any device where
 * the media query did not fire at load (a tablet with a mouse attached, or
 * Chrome's device emulation, where the host mouse keeps `any-pointer: fine`
 * matching) the game rendered at 44% of the intended size for the whole match.
 *
 * The `body.touch` check comes first because it is the strongest evidence there
 * is: it is only ever added after a REAL touch pointer has been seen, and it is
 * never removed. So once the player has actually touched the screen, this
 * answers correctly regardless of what the media queries claim.
 */
export function isTouchNow() {
  if (typeof document !== 'undefined' && document.body?.classList.contains('touch')) return true;
  return detectTouch();
}

/**
 * Mark the document so CSS can respond, and keep marking it as evidence
 * arrives. Classes are only ever ADDED, never removed: a hybrid user who has
 * touched once ends up with `.touch` and `.has-mouse` together, meaning large
 * targets plus mouse behaviour. That is the right outcome — shrinking the
 * buttons again the moment they pick up the mouse would be jarring, and a
 * large button costs a mouse user nothing.
 */
export function installTouchClass(doc = document) {
  if (touchLikely) doc.body.classList.add('touch');

  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') doc.body.classList.add('touch');
    else if (e.pointerType === 'mouse') doc.body.classList.add('has-mouse');
  }, { capture: true, passive: true });

  // A tablet docking to a keyboard, or a phone pairing a mouse.
  mq('(pointer: coarse)')?.addEventListener?.('change', (ev) => {
    if (ev.matches) doc.body.classList.add('touch');
  });
}
