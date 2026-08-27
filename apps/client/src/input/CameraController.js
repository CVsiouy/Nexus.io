import { WORLD_SIZE } from '@basewar/sim';

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

/**
 * How far ABOVE the fit floor a live match sits.
 *
 * `fitZoom(…, FIT_PLAY)` shows the entire map at once. That sounds desirable
 * and plays badly: on any landscape screen the whole width is on screen, so
 * there is nothing to pan left or right to, and every unit is drawn tiny. The
 * match view should be a window onto the battlefield you move around, not a
 * wall map you read.
 *
 * At 1.5 a landscape viewport shows roughly 68% of the world across, which
 * leaves real room to move in both axes. It sat at 1.8 until side-by-side
 * phone play against diep.io showed that framing noticeably tighter than the
 * genre expects; 1.5 is the wider view.
 *
 * This used to apply on touch only, and desktop sat at the bare fit — hence the
 * complaint that the map was "too zoomed out" with only vertical panning. One
 * multiplier for everyone also removes the bug class where a mis-detected
 * device silently got the wrong zoom: there is no longer a device branch here
 * at all. Finger-versus-mouse precision is handled where it belongs, by
 * MIN_TOUCH_PX in hitTest.js, which is zoom-independent.
 */
export const PLAY_ZOOM_MULT = 1.5;

/**
 * How far past the world edge the camera may travel, as a fraction of the
 * visible extent.
 *
 * Without this the map edge can never move inside the screen edge, so a base
 * near the rim is permanently pinned against it — and on a phone that is
 * exactly where the build strip and squad rail live, so your own base sits
 * underneath the HUD with no way to shift it. A little overscroll lets you push
 * the edge inward and put your base somewhere you can actually see it.
 */
export const OVERSCROLL = 0.25;

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
 * The highest zoom we allow — enough context to still read the battlefield.
 *
 * The absolute ceiling has to clear PLAY_ZOOM_MULT, or the clamp would quietly
 * undo the play zoom on large monitors: at 2560px wide the fit floor alone is
 * 0.896, and 0.896 x 1.8 = 1.61 would have been clipped back to the old 1.2.
 * The floor of the range is likewise raised so the ceiling is never below the
 * zoom a match actually opens at.
 */
export function zoomMax(width, height) {
  const min = zoomMin(width, height);
  // Four times the floor, capped at 2.0 — but NEVER below the zoom a match
  // actually opens at, or the clamp in fit() would silently undo the zoom-in.
  //
  // Deliberately not written as clamp(min*4, min*PLAY, 2.0): in that helper the
  // upper bound wins, so on an ultrawide monitor (floor 1.20, play zoom 2.17)
  // the 2.0 cap would have clipped the play zoom back down — the very bug this
  // line exists to prevent. The floor has to be applied last.
  return Math.max(Math.min(min * 4, 2.0), min * PLAY_ZOOM_MULT);
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

  // Slack past each edge, so a base on the rim can be pulled away from the
  // screen edge (and out from under the HUD) instead of being pinned there.
  const padX = hw * 2 * OVERSCROLL;
  const padY = hh * 2 * OVERSCROLL;

  cam.x = clamp(cam.x, Math.min(hw - padX, mid), Math.max(WORLD_SIZE - hw + padX, mid));
  cam.y = clamp(cam.y, Math.min(hh - padY, mid), Math.max(WORLD_SIZE - hh + padY, mid));
}

export class CameraController {
  /** @param {object} cam  the plain camera object owned by Game */
  constructor(cam) {
    this.cam = cam;
    this._resizeQueued = false;
  }

  get min() { return zoomMin(this.cam.width, this.cam.height); }
  get max() { return zoomMax(this.cam.width, this.cam.height); }

  /**
   * Re-fit the view. Called on deliberate transitions only — match start,
   * attract mode, "show me everything" — never from a resize.
   */
  fit(k = FIT_PLAY) {
    const cam = this.cam;
    // Only a live match is zoomed in past the fit. Attract mode has its own
    // framing (FIT_ATTRACT) and must not be multiplied on top of it.
    //
    // No device branch here, deliberately: it used to read a `touch` flag
    // captured at construction from a module-level const evaluated at import
    // time, so on any device where the media query did not fire at load — a
    // tablet with a mouse, or Chrome device emulation, where the host mouse
    // keeps `any-pointer: fine` matching — the multiplier silently never
    // applied and the match rendered at 44% of the intended size.
    const mult = (k === FIT_PLAY) ? PLAY_ZOOM_MULT : 1;
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
