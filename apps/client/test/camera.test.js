import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD_SIZE } from '@basewar/sim';
import {
  fitZoom, zoomMin, zoomMax, clampCamera, CameraController, FIT_PLAY,
  PLAY_ZOOM_MULT, OVERSCROLL,
} from '../src/input/CameraController.js';

/**
 * The fit formula changed from width-only to max(width, height). These tests
 * exist mainly to prove that change is a STRICT improvement — identical on
 * every landscape viewport (i.e. every desktop), better on portrait.
 */

test('desktop zoom is byte-identical to the old width-only formula', () => {
  for (const [w, h] of [[1920, 1080], [1366, 768], [2560, 1440], [1440, 900]]) {
    assert.equal(fitZoom(w, h, FIT_PLAY), (w / WORLD_SIZE) * FIT_PLAY,
      `${w}x${h} must not change on desktop`);
  }
  assert.ok(Math.abs(fitZoom(1920, 1080, FIT_PLAY) - 0.672) < 1e-9);
});

test('a portrait phone gets a usable zoom instead of a 2.7px soldier', () => {
  const before = (390 / WORLD_SIZE) * FIT_PLAY;   // 0.1365
  const after  = fitZoom(390, 844, FIT_PLAY);     // 0.2954
  assert.ok(Math.abs(after - 0.29540) < 1e-4, `got ${after}`);
  assert.ok(after / before > 2.1, `only improved ${(after / before).toFixed(2)}x`);
});

test('rotating a phone no longer changes the zoom floor', () => {
  // Width-only meant portrait and landscape disagreed by 2.16x, so every
  // rotation was a jarring jump.
  assert.equal(fitZoom(390, 844, FIT_PLAY), fitZoom(844, 390, FIT_PLAY));
});

test('the clamp bounds the visible RECT, allowing a measured overscroll', () => {
  // Two things at once here.
  //
  // The old clamp bounded the camera CENTRE to [0, WORLD_SIZE], which let you
  // pan until the map was almost entirely off screen. The rect is what matters.
  //
  // But the rect is NOT pinned flush to the world edge either: OVERSCROLL lets
  // it travel a little further, so a base sitting on the rim can be pulled away
  // from the screen edge instead of being trapped underneath the HUD. This
  // asserts the slack exists AND that it is bounded — an unbounded version
  // would just be the old centre-clamp bug again.
  for (const [w, h] of [[844, 390], [390, 844], [1920, 1080]]) {
    const zoom = fitZoom(w, h, FIT_PLAY) * PLAY_ZOOM_MULT;
    const hw = w / (2 * zoom), hh = h / (2 * zoom);
    const padX = hw * 2 * OVERSCROLL, padY = hh * 2 * OVERSCROLL;

    for (const [x, y] of [[-9999, -9999], [99999, 99999], [0, WORLD_SIZE]]) {
      const cam = { x, y, zoom, width: w, height: h };
      clampCamera(cam);
      assert.ok(cam.x - hw >= -padX - 0.001 && cam.x + hw <= WORLD_SIZE + padX + 0.001,
        `x rect ${cam.x - hw}..${cam.x + hw} escaped world+overscroll`);
      assert.ok(cam.y - hh >= -padY - 0.001 && cam.y + hh <= WORLD_SIZE + padY + 0.001,
        `y rect ${cam.y - hh}..${cam.y + hh} escaped world+overscroll`);
    }
  }
});

test('overscroll can lift a rim base clear of the bottom of the screen', () => {
  // The concrete complaint this exists for: your mother base spawns on the
  // spawn ring, and if that is the bottom of the map it used to sit pinned
  // under the build strip with no way to move it.
  const RING_Y = WORLD_SIZE / 2 + WORLD_SIZE * 0.42;   // bottom-most spawn slot

  for (const [w, h] of [[852, 393], [393, 852], [1366, 768]]) {
    const zoom = Math.min(fitZoom(w, h, FIT_PLAY) * PLAY_ZOOM_MULT, zoomMax(w, h));
    const cam = { x: WORLD_SIZE / 2, y: 99999, zoom, width: w, height: h };
    clampCamera(cam);

    // Where the base lands on screen once the camera is pushed fully down.
    const screenY = h / 2 + (RING_Y - cam.y) * zoom;
    const clearance = h - screenY;
    assert.ok(clearance > 120,
      `${w}x${h}: base only ${clearance.toFixed(0)}px above the bottom edge`);
  }
});

test('a viewport wider than the world locks to centre rather than inverting', () => {
  // min bound exceeds max bound here; that is not an error, it means "no
  // freedom on this axis".
  const cam = { x: 10, y: 10, zoom: 0.05, width: 1920, height: 1080 };
  clampCamera(cam);
  assert.equal(cam.x, WORLD_SIZE / 2);
  assert.equal(cam.y, WORLD_SIZE / 2);
});

test('a URL-bar resize does not disturb the zoom', () => {
  // The old handler recomputed zoom from scratch on every resize, so the view
  // jumped every time the mobile URL bar slid in or out.
  const cam = { x: 1400, y: 1400, zoom: 0, width: 390, height: 844 };
  const ctl = new CameraController(cam);
  ctl.fit(FIT_PLAY);
  const settled = cam.zoom;

  ctl.onViewportResize(390, 745);        // URL bar appears
  assert.ok(cam.zoom >= zoomMin(390, 745) - 1e-9);
  ctl.onViewportResize(390, 844);        // and retracts
  assert.ok(Math.abs(cam.zoom - settled) < 1e-6,
    `zoom drifted ${settled} -> ${cam.zoom} across a URL-bar cycle`);
});

test('an orientation flip preserves how far the player had zoomed in', () => {
  const cam = { x: 1400, y: 1400, zoom: 0, width: 390, height: 844 };
  const ctl = new CameraController(cam);
  ctl.fit(FIT_PLAY);
  cam.zoom = Math.min(zoomMin(390, 844) * 2, zoomMax(390, 844));
  const ratioBefore = cam.zoom / zoomMin(390, 844);

  ctl.onViewportResize(844, 390);
  const ratioAfter = cam.zoom / zoomMin(844, 390);
  assert.ok(Math.abs(ratioAfter - ratioBefore) < 1e-6,
    `zoom ratio changed ${ratioBefore} -> ${ratioAfter} on rotation`);
});

test('a live match opens ZOOMED IN, not fitted to the whole map', () => {
  // Fitting the whole map sounds desirable and plays badly: the entire world
  // width is on screen, so there is nothing to pan left or right to. A match
  // should be a window you move around the battlefield.
  for (const [w, h] of [[1920, 1080], [1366, 768], [852, 393], [393, 852]]) {
    const cam = { x: 1400, y: 1400, zoom: 0, width: w, height: h };
    new CameraController(cam).fit(FIT_PLAY);

    // 1.2, not a copy of PLAY_ZOOM_MULT. The property under test is "a play
    // zoom was actually applied", and the regression it guards against is the
    // multiplier silently going to 1.0. Pinning it to the current tuning meant
    // the test failed the moment the framing was adjusted — which is exactly
    // when you want it to keep holding still and check the invariant.
    assert.ok(cam.zoom > fitZoom(w, h, FIT_PLAY) * 1.2,
      `${w}x${h} opened at ${cam.zoom}, barely above the fit floor`);
    assert.ok(cam.zoom <= zoomMax(w, h) + 1e-9, `${w}x${h} exceeded zoomMax`);

    // The point of all of it: both axes must have somewhere to go.
    const visW = (w / cam.zoom) / WORLD_SIZE;
    assert.ok(visW < 0.85, `${w}x${h} still shows ${(visW * 100).toFixed(0)}% of the map width`);
  }
});

test('zoomMax always leaves room for the play zoom', () => {
  // The ceiling used to be a flat 1.2, which on a large monitor was BELOW the
  // zoom a match opens at — so the clamp silently undid the zoom-in. Any
  // ceiling must clear the value fit() is about to ask for.
  for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440], [3440, 1440]]) {
    assert.ok(zoomMax(w, h) >= zoomMin(w, h) * PLAY_ZOOM_MULT - 1e-9,
      `${w}x${h}: max ${zoomMax(w, h)} < play zoom ${zoomMin(w, h) * PLAY_ZOOM_MULT}`);
  }
});

test('there is no device branch in the zoom at all', () => {
  // The zoom used to depend on a touch flag captured at construction, from a
  // module-level const evaluated at import time. On a device where the media
  // query did not fire at load, the multiplier silently never applied and the
  // match rendered at 44% of the intended size — with no way to recover.
  //
  // Removing the branch removes the whole bug class, so this asserts the
  // absence: the same viewport must produce the same zoom no matter what the
  // document claims about pointers.
  const zoomFor = (touchClass) => {
    const body = globalThis.document?.body;
    if (body) { if (touchClass) body.classList.add('touch'); else body.classList.remove('touch'); }
    const cam = { x: 1400, y: 1400, zoom: 0, width: 852, height: 393 };
    new CameraController(cam).fit(FIT_PLAY);
    return cam.zoom;
  };
  assert.equal(zoomFor(true), zoomFor(false),
    'zoom must not depend on touch detection');
});
