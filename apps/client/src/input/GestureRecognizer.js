/**
 * GestureRecognizer — turns raw pointer events into game gestures.
 * ───────────────────────────────────────────────────────────────
 *
 * Pure and DOM-free on purpose. It never touches an event object, never reads a
 * clock, and never calls into the game. You feed it (pointerId, x, y, time) and
 * it calls back with semantic gestures. That is what makes it testable under
 * plain `node --test` with no browser and no fake timers — the caller passes
 * `e.timeStamp`, and tests pass whatever numbers they like.
 *
 *
 * WHY THIS IS SO MUCH SIMPLER THAN A NORMAL RTS RECOGNIZER
 *
 * Because the camera is driven by an on-screen joystick, one-finger drag is not
 * needed for panning — which means a drag on the map is UNAMBIGUOUS and can be
 * box-select directly. No long-press arming, no 400ms delay, no "did they mean
 * to pan or to select" disambiguation, and no need for haptic feedback to tell
 * the player which mode they ended up in. Deleting the pan gesture deleted most
 * of the complexity along with it.
 *
 *
 * THE STATES
 *
 *   IDLE     nothing down
 *   PENDING  one finger down, not yet moved past the slop — could still be a tap
 *   BOX      moved past slop; a marquee is live
 *   MULTI    two fingers down; may become a two-finger tap (deselect)
 *   TAIL     gesture is over but fingers remain; swallow everything until clear
 */

export const TAP_SLOP     = 12;   // px a finger may roll and still count as a tap
export const MULTI_WINDOW = 120;  // ms within which a 2nd finger means "always 2"
export const TWO_TAP_MS   = 300;  // ms both fingers must lift within
export const TWO_TAP_SLOP = 16;   // px each finger may move and still be a tap
export const STALE_MS     = 3000; // watchdog: fingers "down" this long with no events

const IDLE = 'idle', PENDING = 'pending', BOX = 'box', MULTI = 'multi', TAIL = 'tail';

export class GestureRecognizer {
  /**
   * @param {object} handlers
   * @param {(x:number,y:number)=>void}                     handlers.onTap
   * @param {(x0:number,y0:number,x:number,y:number)=>void} handlers.onBoxMove
   * @param {(x0:number,y0:number,x:number,y:number)=>void} handlers.onBoxEnd
   * @param {()=>void}                                      handlers.onBoxCancel
   * @param {()=>void}                                      handlers.onTwoFingerTap
   */
  constructor(handlers = {}) {
    this.h = handlers;
    this.reset();
  }

  reset() {
    this.state = IDLE;
    this._pts = new Map();   // pointerId -> { x0, y0, t0, x, y, moved }
    this._lastEventAt = 0;
  }

  get isBoxing() { return this.state === BOX; }

  down(id, x, y, t) {
    this._lastEventAt = t;
    const pt = { x0: x, y0: y, t0: t, x, y, moved: 0 };

    switch (this.state) {
      case IDLE:
        this._pts.set(id, pt);
        this.state = PENDING;
        return;

      case PENDING: {
        // A second finger landing quickly means this was ALWAYS a two-finger
        // gesture — the first finger's pending tap is cancelled silently, with
        // no side effects, rather than firing a stray tap.
        const first = this._firstPoint();
        this._pts.set(id, pt);
        if (first && (t - first.t0) <= MULTI_WINDOW) this.state = MULTI;
        else this.state = TAIL;   // committed to one finger; ignore the rest
        return;
      }

      case BOX:
        // A box-select is a committed action. Hijacking it into something else
        // would lose the selection AND surprise the player, so extra fingers
        // are ignored outright for the rest of the gesture.
        this._pts.set(id, pt);
        return;

      default:
        this._pts.set(id, pt);
        return;
    }
  }

  move(id, x, y, t) {
    this._lastEventAt = t;
    const pt = this._pts.get(id);
    if (!pt) return;
    pt.x = x; pt.y = y;
    pt.moved = Math.max(pt.moved, Math.hypot(x - pt.x0, y - pt.y0));

    if (this.state === PENDING && this._pts.size === 1 && pt.moved > TAP_SLOP) {
      this.state = BOX;
      this.h.onBoxMove?.(pt.x0, pt.y0, x, y);
      return;
    }
    if (this.state === BOX && this._isPrimary(id)) {
      this.h.onBoxMove?.(pt.x0, pt.y0, x, y);
    }
  }

  up(id, x, y, t) {
    this._lastEventAt = t;
    const pt = this._pts.get(id);
    if (pt) { pt.x = x; pt.y = y; pt.upAt = t; }

    switch (this.state) {
      case PENDING:
        // Below slop and never promoted to BOX — a tap.
        this._pts.delete(id);
        this.state = this._pts.size ? TAIL : IDLE;
        if (pt) this.h.onTap?.(pt.x0, pt.y0);
        return;

      case BOX: {
        const primary = this._isPrimary(id);
        this._pts.delete(id);
        if (primary) {
          this.state = this._pts.size ? TAIL : IDLE;
          if (pt) this.h.onBoxEnd?.(pt.x0, pt.y0, x, y);
        }
        return;
      }

      case MULTI: {
        const pts = [...this._pts.values()];
        // Keep BOTH points until every one of them has lifted. Deleting the
        // first on its own up() destroys the very evidence the two-finger tap
        // is judged on, and the gesture can then never fire.
        const allUp = pts.length >= 2 && pts.every(p => p.upAt != null);
        if (!allUp) return;   // stay in MULTI; the watchdog covers a stuck finger

        // Both must lift promptly after the SECOND one landed, and neither may
        // have travelled — otherwise this was a hesitant drag or a palm.
        const second = pts.reduce((a, b) => (a.t0 > b.t0 ? a : b));
        const quick  = pts.every(p => (p.upAt - second.t0) <= TWO_TAP_MS);
        const still  = pts.every(p => p.moved <= TWO_TAP_SLOP);

        this._pts.clear();
        this.state = IDLE;
        if (pts.length === 2 && quick && still) this.h.onTwoFingerTap?.();
        return;
      }

      default:
        this._pts.delete(id);
        if (!this._pts.size) this.state = IDLE;
        return;
    }
  }

  /**
   * The touch was taken away from us — a system gesture, a notification banner,
   * an incoming call. Treat it as "lift, with no action": the player must not
   * lose their selection or issue a stray order because a banner appeared.
   */
  cancel(id, t) {
    this._lastEventAt = t;
    const wasBoxing = this.state === BOX && this._isPrimary(id);
    this._pts.delete(id);
    if (!this._pts.size) this.state = IDLE;
    else if (this.state !== TAIL) this.state = TAIL;
    if (wasBoxing) this.h.onBoxCancel?.();
  }

  /**
   * Called from the frame loop. Cheap Android panels occasionally drop a
   * pointer without ever firing up or cancel, which would otherwise leave the
   * recognizer wedged believing a finger is still down.
   */
  tick(t) {
    if (this.state === IDLE || !this._lastEventAt) return;
    if (t - this._lastEventAt < STALE_MS) return;
    const wasBoxing = this.state === BOX;
    this.reset();
    if (wasBoxing) this.h.onBoxCancel?.();
  }

  _firstPoint() {
    let best = null;
    for (const p of this._pts.values()) if (!best || p.t0 < best.t0) best = p;
    return best;
  }

  /** The oldest live pointer owns the gesture; later ones are passengers. */
  _isPrimary(id) {
    let bestId = null, bestT = Infinity;
    for (const [pid, p] of this._pts) if (p.t0 < bestT) { bestT = p.t0; bestId = pid; }
    return bestId === id;
  }
}
