import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD_SIZE } from '@basewar/sim';
import {
  fitZoom, zoomMin, zoomMax, clampCamera, CameraController, FIT_PLAY,
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

test('the clamp keeps the visible rect inside the world, not just its centre', () => {
  // The old clamp bounded the camera CENTRE to [0, WORLD_SIZE], which allowed
  // panning until the map was almost entirely off screen.
  for (const [w, h] of [[844, 390], [390, 844], [1920, 1080]]) {
    const zoom = fitZoom(w, h, FIT_PLAY) * 1.8;
    for (const [x, y] of [[-9999, -9999], [99999, 99999], [0, WORLD_SIZE]]) {
      const cam = { x, y, zoom, width: w, height: h };
      clampCamera(cam);
      const hw = w / (2 * zoom), hh = h / (2 * zoom);
      assert.ok(cam.x - hw >= -0.001 && cam.x + hw <= WORLD_SIZE + 0.001,
        `x rect ${cam.x - hw}..${cam.x + hw} escaped the world`);
      assert.ok(cam.y - hh >= -0.001 && cam.y + hh <= WORLD_SIZE + 0.001,
        `y rect ${cam.y - hh}..${cam.y + hh} escaped the world`);
    }
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

test('touch starts closer in than desktop, and inside the allowed range', () => {
  const mk = (touch) => {
    const cam = { x: 1400, y: 1400, zoom: 0, width: 390, height: 844 };
    new CameraController(cam, { touch }).fit(FIT_PLAY);
    return cam.zoom;
  };
  const desktop = mk(false), touch = mk(true);
  assert.ok(touch > desktop, 'touch must start zoomed in for finger-sized targets');
  assert.ok(touch <= zoomMax(390, 844) + 1e-9, 'and still within the clamp');
});

test('the touch decision is made LIVE, not frozen at construction', () => {
  // THE REGRESSION THIS LOCKS: `touch` used to be captured once, from a
  // module-level const evaluated at import time. On any device where the media
  // query did not fire at load — a tablet with a mouse attached, or Chrome's
  // device emulation, where the host mouse keeps `any-pointer: fine` matching —
  // the 1.8x touch multiplier silently never applied, and the entire match
  // rendered at 44% of the intended size. Worse, nothing could recover it: a
  // device that became touch-capable later kept desktop zoom all session.
  //
  // Driven through `document.body.classList`, which is the strongest evidence
  // isTouchNow() consults and the one that survives a lying media query.
  const body = globalThis.document?.body;
  if (!body) return;                       // no DOM in this runner; nothing to assert

  const had = body.classList.contains('touch');
  const cam = { x: 1400, y: 1400, zoom: 0, width: 852, height: 393 };
  const ctl = new CameraController(cam);   // no explicit touch → decide live

  try {
    body.classList.remove('touch');
    ctl.fit(FIT_PLAY);
    const withoutTouch = cam.zoom;

    body.classList.add('touch');
    ctl.fit(FIT_PLAY);
    const withTouch = cam.zoom;

    assert.ok(withTouch > withoutTouch * 1.7,
      `the SAME controller must change its answer: ${withoutTouch} -> ${withTouch}`);
  } finally {
    if (had) body.classList.add('touch'); else body.classList.remove('touch');
  }
});
