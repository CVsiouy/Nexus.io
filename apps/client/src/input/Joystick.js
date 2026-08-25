/**
 * Joystick — the touch equivalent of WASD.
 * ───────────────────────────────────────
 *
 * There is no pinch-zoom yet, so the player is fixed at one zoom level and
 * needs a way to travel across a 2800-unit world. Drag-to-pan was the obvious
 * alternative, but it would have to share the map surface with tap-to-command
 * and drag-to-box-select, and disambiguating three gestures on one surface is
 * exactly the kind of guesswork that feels unreliable under a thumb.
 *
 * A dedicated stick keeps the map surface unambiguous: on the map, a tap is
 * always a command and a drag is always a selection box. Nothing is contextual.
 *
 * It feeds InputSystem.setStick(), which merges into the SAME pan code WASD
 * uses, so the two can never drift apart in speed or in camera bookkeeping.
 */

const RADIUS   = 52;   // px from centre at which the stick reads full deflection
const DEADZONE = 0.14; // fraction below which we report zero — thumbs rest crooked

export class Joystick {
  /**
   * @param {HTMLElement} el      the stick container (already in the DOM)
   * @param {(x:number,y:number)=>void} onMove  vector, each component in [-1,1]
   */
  constructor(el, onMove) {
    this.el = el;
    this.knob = el.querySelector('.js-knob');
    this.onMove = onMove;
    this._id = null;
    this._bind();
  }

  _bind() {
    // touch-action:none is set in CSS; without it the browser would claim the
    // drag for scrolling before we ever see a move.
    this.el.addEventListener('pointerdown', (e) => {
      if (this._id !== null) return;
      this._id = e.pointerId;
      this.el.setPointerCapture?.(e.pointerId);
      this.el.classList.add('active');
      this._update(e);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._id) return;
      this._update(e);
    });
    const end = (e) => {
      if (e.pointerId !== this._id) return;
      this._id = null;
      this.el.classList.remove('active');
      this._reset();
    };
    this.el.addEventListener('pointerup', end);
    // A system gesture stealing the touch must release the stick, or the camera
    // would pan forever in the last direction held.
    this.el.addEventListener('pointercancel', end);
  }

  _update(e) {
    const r = this.el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;

    const dist = Math.hypot(dx, dy);
    if (dist > RADIUS) { dx = (dx / dist) * RADIUS; dy = (dy / dist) * RADIUS; }

    // Knob follows the thumb, clamped to the ring.
    if (this.knob) this.knob.style.transform = `translate(${dx}px, ${dy}px)`;

    let nx = dx / RADIUS, ny = dy / RADIUS;
    if (Math.hypot(nx, ny) < DEADZONE) { nx = 0; ny = 0; }
    this.onMove(nx, ny);
  }

  _reset() {
    if (this.knob) this.knob.style.transform = 'translate(0px, 0px)';
    this.onMove(0, 0);
  }
}
