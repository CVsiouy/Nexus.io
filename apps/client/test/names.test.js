import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, TICK_MS } from '@nexus/sim';
import { WorldView, INTERP_DELAY_MS } from '../src/net/WorldView.js';
import { isTypingInto } from '../src/dom.js';

const quiet = { error: () => {}, warn: () => {}, log: () => {} };

/**
 * Two bugs that both surfaced as "the interface is wrong":
 *   1. Other players displayed as "p3" instead of their chosen name.
 *   2. Letters used as hotkeys (H, Q, B) could not be typed into any field.
 *
 * These drive WorldView with raw snapshots — the same path practice mode uses.
 * The binary/online path is covered by apps/server/test/snapshot.test.ts, which
 * asserts the name survives an encode/decode round trip.
 */

function feed(view, sim, clock) {
  view.ingest(sim.getSnapshot(), clock);
  view.sample(clock + INTERP_DELAY_MS + 10);
}

// ── Names ────────────────────────────────────────────────────────────────────

test('player names reach the screen instead of raw seat ids', () => {
  // The original bug: WorldView copied id, colour, team and so on out of each
  // snapshot but never `name`, so every display fell back to the seat id.
  const sim = new Simulation({ logger: quiet });
  sim.claimSeat('s1', 'Chirag');
  sim.claimSeat('s2', 'Ravi');
  for (let i = 0; i < 40; i++) sim.step(TICK_MS);

  const view = new WorldView();
  feed(view, sim, 10_000);

  const names = [...view.players.values()].map(p => p.name);
  assert.ok(names.includes('Chirag'), `expected Chirag in ${JSON.stringify(names)}`);
  assert.ok(names.includes('Ravi'), `expected Ravi in ${JSON.stringify(names)}`);

  for (const [, p] of view.players) {
    assert.ok(p.name, `${p.id} has no name at all`);
    assert.notEqual(p.name, p.id, `${p.id} is showing its raw seat id`);
  }
});

test('a name is not lost across later updates', () => {
  const sim = new Simulation({ logger: quiet });
  sim.claimSeat('s1', 'Chirag');
  for (let i = 0; i < 40; i++) sim.step(TICK_MS);

  const view = new WorldView();
  feed(view, sim, 10_000);

  for (let i = 1; i <= 6; i++) {
    for (let t = 0; t < 4; t++) sim.step(TICK_MS);
    feed(view, sim, 10_000 + i * 200);
  }

  const me = [...view.players.values()].find(p => p.name === 'Chirag');
  assert.ok(me, 'the name was lost over successive updates');
});

test('a roster update names a player immediately', () => {
  // Names only travel on keyframes over the wire, so somebody joining
  // mid-match would otherwise show as "p5" for up to two seconds.
  const sim = new Simulation({ logger: quiet });
  for (let i = 0; i < 20; i++) sim.step(TICK_MS);

  const view = new WorldView();
  feed(view, sim, 10_000);

  const target = [...view.players.values()][3];
  view.setNames({ [target.id]: 'LateJoiner' });
  assert.equal(view.players.get(target.id).name, 'LateJoiner');
});

test('a roster naming a not-yet-seen player is applied once they appear', () => {
  const view = new WorldView();
  view.setNames({ p2: 'EarlyBird' });   // arrives before any snapshot

  const sim = new Simulation({ logger: quiet });
  for (let i = 0; i < 10; i++) sim.step(TICK_MS);
  feed(view, sim, 10_000);

  assert.equal(view.players.get('p2').name, 'EarlyBird');
});

test('setNames tolerates junk without throwing', () => {
  const view = new WorldView();
  assert.doesNotThrow(() => view.setNames(undefined));
  assert.doesNotThrow(() => view.setNames(null));
  assert.doesNotThrow(() => view.setNames({}));
  assert.doesNotThrow(() => view.setNames({ p1: '' }));
});

// ── Typing ───────────────────────────────────────────────────────────────────

test('typing into a field is detected, so hotkeys can stand aside', () => {
  // The game listens on window for bare letters — H opens help, Q the build
  // bar, B the buffs panel — and calls preventDefault. Without this check the
  // letter never reaches the field and you cannot type your own name.
  const typing = [
    { target: { tagName: 'INPUT' } },
    { target: { tagName: 'input' } },
    { target: { tagName: 'TEXTAREA' } },
    { target: { tagName: 'SELECT' } },
    { target: { tagName: 'DIV', isContentEditable: true } },
  ];
  for (const e of typing) {
    assert.equal(isTypingInto(e), true, `should have detected typing: ${JSON.stringify(e.target)}`);
  }

  const notTyping = [
    { target: { tagName: 'DIV' } },
    { target: { tagName: 'CANVAS' } },
    { target: { tagName: 'BUTTON' } },
    { target: { tagName: 'BODY', isContentEditable: false } },
    { target: null },
    {},
    null,
  ];
  for (const e of notTyping) {
    assert.equal(isTypingInto(e), false, `should NOT have blocked: ${JSON.stringify(e)}`);
  }
});

test('every key bound to a game action is still typeable in a field', () => {
  // Regression guard. If someone adds a new single-letter shortcut later, this
  // records that it must stand aside while a field has focus.
  const bound = ['KeyH', 'KeyQ', 'KeyB', 'KeyF', 'KeyR', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
                 'Space', 'Tab', 'Digit1', 'Digit2', 'Digit3', 'Digit4'];
  for (const code of bound) {
    assert.equal(isTypingInto({ code, target: { tagName: 'INPUT' } }), true,
      `${code} would still be swallowed while typing`);
  }
});
