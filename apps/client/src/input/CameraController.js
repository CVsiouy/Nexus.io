import { WORLD_SIZE } from '@basewar/sim';
import { isTouchNow } from './touchDetect.js';

/**
 * CameraController — the single owner of camera zoom and bounds.
 * ─────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS
 *
 * `cam.zoom` used to be written from four unrelated places (the resize handler,
 * attract mode, match start, and focusFree). Nothing owned it, so nothing could
 * enforce a rule about it — and the resize handler in particular RECOMPUTED
 * zoom from scratch on every resize event. On a phone that fires every time the
 * URL bar shows or hides, so any zoom state was destroyed constantly.
 *
 * THE FIT FORMULA, AND WHY IT CHANGED
 *
 * Zoom used to be derived from viewport WIDTH alone:
 *
 *     zoom = (cam.width / WORLD_SIZE) * k
 *
 * The world is square, so on a tall narrow phone that draws the whole world
 * `width * k` pixels across AND tall — leaving the map tiny with huge vertical
 * letterboxing. Concretely, at 393px wide that is zoom 0.1365, at which a
 * 20-world-unit soldier is 2.7 CSS PIXELS on screen. Touch selection was not
 * "fiddly" at that size, it was arithmetically impossible.
 *
 * Fitting the LONGER axis instead makes the map cover the screen:
 *
 *     zoom = (max(cam.width, cam.height) / WORLD_SIZE) * k
 *
 * The important property: on any landscape viewport — i.e. every desktop —
 * max(w,h) IS w, so this produces byte-identical results to the old formula.
 * 1920x1080 gives 0.672 before and after. It is a strict improvement with zero
 * desktop regression, which is why camera.test.js locks those exact numbers.
 */

/** Fraction of the viewport the world spans when "fitted". */
export const FIT_PLAY    = 0.98;   // in a match
export const FIT_ATTRACT = 1.7;    // menu demo, deliberately zoomed in

/** Touch play sits above the floor so targets are finger-sized. See below. */
export const TOUCH_ZOOM_MULT = 1.8;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Zoom at which the world exactly covers the longer viewport axis, times `k`.
 * Pure and exported so it can be tested without a DOM.
 */
export function fitZoom(width, height, k = FIT_PLAY) {
  return (Math.max(width, height) / WORLD_SIZE) * k;
}

/** The lowest zoom we allow: the map must always cover the screen. */
export function zoomMin(width, height) {
  return fitZoom(width, height, FIT_PLAY);
}

/**
 * The highest zoom we allow. Four times the floor, but never so close that the
 * player loses all context — bounded in absolute terms as well as relative.
 */
export function zoomMax(width, height) {
  return clamp(zoomMin(width, height) * 4, 0.9, 1.2);
}

/**
 * Keep the VISIBLE RECT inside the world, rather than the camera centre.
 *
 * The old clamp bounded cam.x/y to [0, WORLD_SIZE] — the centre point. That let
 * you pan until the map was almost entirely off screen, showing a screenful of
 * background. Clamping the rect means the edge of the world stops at the edge
 * of the screen, which is what every map application does.
 *
 * When the viewport is WIDER than the world at this zoom, the min bound exceeds
 * the max bound; that is not an error, it means "no freedom on this axis", and
 * locking to the world centre is the right answer.
 */
export function clampCamera(cam) {
  const hw = cam.width  / (2 * cam.zoom);
  const hh = cam.height / (2 * cam.zoom);
  const mid = WORLD_SIZE / 2;
  cam.x = clamp(cam.x, Math.min(hw, mid), Math.max(WORLD_SIZE - hw, mid));
  cam.y = clamp(cam.y, Math.min(hh, mid), Math.max(WORLD_SIZE - hh, mid));
}

export class CameraController {
  /**
   * @param {object} cam    the plain camera object owned by Game
   * @param {object} [opts]
   * @param {boolean} [opts.touch]  FORCE the touch play zoom on or off. Leave
   *   undefined in the real app so `fit()` decides live; tests pass it
   *   explicitly to pin one branch without needing a DOM.
   */
  constructor(cam, { touch } = {}) {
    this.cam = cam;
    this.touch = touch;              // undefined === "decide at fit() time"
    this._resizeQueued = false;
  }

  /** Live where possible, overridden when a caller was explicit. */
  _isTouch() {
    return typeof this.touch === 'boolean' ? this.touch : isTouchNow();
  }

  get min() { return zoomMin(this.cam.width, this.cam.height); }
  get max() { return zoomMax(this.cam.width, this.cam.height); }

  /**
   * Re-fit the view. Called on deliberate transitions only — match start,
   * attract mode, "show me everything" — never from a resize.
   */
  fit(k = FIT_PLAY) {
    const cam = this.cam;
    // On touch there is no pinch gesture yet, so this one value is the entire
    // zoom experience and it has to be picked for target size, not for overview.
    // At FIT * 1.8 the 22px minimum touch radius maps to ~41 world units, which
    // is about one squad's half-span — big enough to hit reliably, small enough
    // that two adjacent squads never merge into one target.
    //
    // Asked LIVE, not read from a flag captured at construction. It used to be
    // the latter, and the flag came from a module-level const evaluated at
    // import time — so on any device where the media query did not fire at load
    // (a tablet with a mouse, or Chrome device emulation, where the host mouse
    // keeps `any-pointer: fine` matching) the multiplier silently never applied
    // and the whole match rendered at 44% of the intended size.
    const mult = (this._isTouch() && k === FIT_PLAY) ? TOUCH_ZOOM_MULT : 1;
    cam.zoom = clamp(fitZoom(cam.width, cam.height, k) * mult, this.min, this.max);
    clampCamera(cam);
    return cam.zoom;
  }

  /**
   * The viewport changed size. Crucially this does NOT re-fit zoom.
   *
   * A mobile URL bar showing or hiding changes only the height, and the old
   * handler responded by recomputing zoom from scratch — so the view jumped
   * every time the player scrolled the page chrome into view. Here we update
   * the dimensions, recompute the allowed range, and re-clamp into it. A player
   * sitting comfortably inside the range sees nothing change at all.
   *
   * On a genuine orientation flip the zoom is carried across PROPORTIONALLY, so
   * someone zoomed 2x above the floor is still 2x above it afterwards.
   */
  onViewportResize(width, height) {
    const cam = this.cam;
    const oldMin = this.min;
    const oldZoom = cam.zoom;
    const wasLandscape = cam.width >= cam.height;

    cam.width = width;
    cam.height = height;

    const flipped = wasLandscape !== (width >= height);
    if (flipped && oldMin > 0) {
      cam.zoom = clamp(this.min * (oldZoom / oldMin), this.min, this.max);
    } else {
      cam.zoom = clamp(cam.zoom, this.min, this.max);
    }
    clampCamera(cam);
  }
}
