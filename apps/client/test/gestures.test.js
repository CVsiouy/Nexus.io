import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GestureRecognizer, TAP_SLOP, MULTI_WINDOW, TWO_TAP_MS, STALE_MS,
} from '../src/input/GestureRecognizer.js';

/**
 * The recognizer is pure and clock-injected, so these run with no DOM, no
 * browser and no fake timers — every timestamp below is just a number we chose.
 */
function rec() {
  const events = [];
  const r = new GestureRecognizer({
    onTap:          (x, y)         => events.push(['tap', x, y]),
    onBoxMove:      (x0, y0, x, y) => events.push(['boxMove', x0, y0, x, y]),
    onBoxEnd:       (x0, y0, x, y) => events.push(['boxEnd', x0, y0, x, y]),
    onBoxCancel:    ()             => events.push(['boxCancel']),
    onTwoFingerTap: ()             => events.push(['twoFingerTap']),
  });
  return { r, events, kinds: () => events.map(e => e[0]) };
}

test('a still press and lift is a tap', () => {
  const { r, events, kinds } = rec();
  r.down(1, 100, 100, 0);
  r.up(1, 100, 100, 90);
  assert.deepEqual(kinds(), ['tap']);
  assert.deepEqual(events[0].slice(1), [100, 100]);
  assert.equal(r.state, 'idle');
});

test('a finger that rolls under the slop is still a tap', () => {
  // A deliberate tap drags the skin 5-10px. Treating that as a drag would eat
  // a large fraction of every player's taps.
  const { r, kinds } = rec();
  r.down(1, 100, 100, 0);
  r.move(1, 100 + TAP_SLOP - 2, 100, 40);
  r.up(1, 100 + TAP_SLOP - 2, 100, 80);
  assert.deepEqual(kinds(), ['tap']);
});

test('moving past the slop becomes a box select, and never also a tap', () => {
  const { r, events, kinds } = rec();
  r.down(1, 50, 50, 0);
  r.move(1, 50 + TAP_SLOP + 5, 60, 40);
  r.move(1, 200, 180, 80);
  r.up(1, 200, 180, 120);

  assert.ok(kinds().includes('boxEnd'), 'should have ended a box');
  assert.ok(!kinds().includes('tap'), 'a drag must NOT also fire a tap');

  const end = events.find(e => e[0] === 'boxEnd');
  assert.deepEqual(end.slice(1), [50, 50, 200, 180], 'box spans origin to release');
});

test('the box rect is reported live while dragging', () => {
  const { r, kinds } = rec();
  r.down(1, 10, 10, 0);
  r.move(1, 60, 60, 30);
  r.move(1, 90, 70, 60);
  assert.equal(kinds().filter(k => k === 'boxMove').length, 2);
});

test('two fingers down and up quickly is a deselect, not two taps', () => {
  const { r, kinds } = rec();
  r.down(1, 100, 100, 0);
  r.down(2, 160, 120, MULTI_WINDOW - 20);   // inside the window
  r.up(1, 100, 100, 200);
  r.up(2, 160, 120, 220);

  assert.deepEqual(kinds(), ['twoFingerTap']);
  assert.equal(r.state, 'idle');
});

test('two fingers held too long is not a deselect', () => {
  const { r, kinds } = rec();
  r.down(1, 100, 100, 0);
  r.down(2, 160, 120, 50);
  r.up(1, 100, 100, 50 + TWO_TAP_MS + 100);
  r.up(2, 160, 120, 50 + TWO_TAP_MS + 120);
  assert.deepEqual(kinds(), [], 'a long two-finger hold is not a tap');
});

test('a second finger arriving late does not hijack a committed gesture', () => {
  // The first finger has already committed to a box select. Stealing that would
  // lose the selection the player was halfway through making.
  const { r, events, kinds } = rec();
  r.down(1, 20, 20, 0);
  r.move(1, 120, 120, 40);          // now BOX
  r.down(2, 300, 300, 100);         // passenger
  r.move(2, 320, 320, 120);         // must not affect the marquee
  r.up(1, 140, 140, 160);

  const end = events.find(e => e[0] === 'boxEnd');
  assert.ok(end, 'the box still ends normally');
  assert.deepEqual(end.slice(1), [20, 20, 140, 140]);
  assert.ok(!kinds().includes('twoFingerTap'));
});

test('pointercancel mid-tap issues no order at all', () => {
  // iOS fires pointercancel whenever a system gesture steals the touch. A
  // notification banner must not cost the player a stray move order.
  const { r, kinds } = rec();
  r.down(1, 100, 100, 0);
  r.cancel(1, 50);
  assert.deepEqual(kinds(), [], 'no tap from a cancelled press');
  assert.equal(r.state, 'idle');
});

test('pointercancel mid-box cancels the marquee without selecting', () => {
  const { r, kinds } = rec();
  r.down(1, 10, 10, 0);
  r.move(1, 120, 120, 40);
  r.cancel(1, 80);
  assert.deepEqual(kinds(), ['boxMove', 'boxCancel']);
  assert.ok(!kinds().includes('boxEnd'), 'a cancelled box must not commit');
});

test('the watchdog recovers from a dropped pointer', () => {
  // Cheap Android panels sometimes drop a pointerId without ever firing up or
  // cancel. Without this the recognizer would stay wedged for the whole match.
  const { r } = rec();
  r.down(1, 100, 100, 0);
  r.move(1, 200, 200, 10);
  assert.equal(r.state, 'box');

  r.tick(10 + STALE_MS + 1);
  assert.equal(r.state, 'idle', 'a stale gesture is force-reset');
});

test('the watchdog leaves a live gesture alone', () => {
  const { r } = rec();
  r.down(1, 100, 100, 0);
  r.tick(STALE_MS - 100);
  assert.equal(r.state, 'pending');
});

test('every finger lifting always returns to idle', () => {
  // A recognizer that leaks pointers stops responding partway through a match,
  // which is far worse than any single mis-read gesture.
  const { r } = rec();
  for (const seq of [
    () => { r.down(1, 0, 0, 0); r.up(1, 0, 0, 10); },
    () => { r.down(1, 0, 0, 0); r.move(1, 99, 99, 5); r.up(1, 99, 99, 10); },
    () => { r.down(1, 0, 0, 0); r.down(2, 9, 9, 20); r.up(1, 0, 0, 30); r.up(2, 9, 9, 40); },
    () => { r.down(1, 0, 0, 0); r.down(2, 9, 9, 20); r.up(2, 9, 9, 30); r.up(1, 0, 0, 40); },
    () => { r.down(1, 0, 0, 0); r.down(2, 9, 9, 500); r.up(2, 9, 9, 510); r.up(1, 0, 0, 520); },
    () => { r.down(1, 0, 0, 0); r.cancel(1, 5); },
  ]) {
    r.reset();
    seq();
    assert.equal(r.state, 'idle', 'left in state: ' + r.state);
  }
});
