import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD_SIZE } from '@basewar/sim';
import {
  pickTarget, effectiveRadius, MOUSE_CONFIG, TOUCH_CONFIG, MIN_TOUCH_PX,
} from '../src/input/hitTest.js';
import { fitZoom, FIT_PLAY } from '../src/input/CameraController.js';

/**
 * A minimal stand-in for WorldView. pickTarget only reads Maps and two helper
 * predicates, so a literal is clearer here than a whole Simulation — and it
 * lets each test state exactly the geometry it is about.
 */
const mkWorld = (over = {}) => ({
  playerId: 'p0',
  mode: 'ffa',
  players: new Map(), soldiers: new Map(), bosses: new Map(),
  mineNodes: new Map(), groups: new Map(),
  areEnemies: (a, b) => a !== b,
  teamOf: () => null,
  ...over,
});

const PHONE_ZOOM   = fitZoom(390, 844, FIT_PLAY) * 1.8;   // touch play zoom
const DESKTOP_ZOOM = fitZoom(1920, 1080, FIT_PLAY);

test('a soldier is a finger-sized target at phone zoom', () => {
  // The bug in one assertion: at the OLD width-derived zoom a 20-unit soldier
  // was under 3 CSS px, which no finger can hit.
  const oldZoom = (390 / WORLD_SIZE) * FIT_PLAY;
  assert.ok(20 * oldZoom < 3, `old size was ${(20 * oldZoom).toFixed(1)}px`);

  const eff = effectiveRadius(20, PHONE_ZOOM, MIN_TOUCH_PX);
  assert.ok(Math.abs(eff * PHONE_ZOOM - MIN_TOUCH_PX) < 0.01,
    `now ${(eff * PHONE_ZOOM).toFixed(1)}px, wanted ${MIN_TOUCH_PX}`);
});

test('the minimum stops applying once the natural radius is big enough', () => {
  // It is a floor that disappears when no longer needed, not a permanent
  // distortion of the geometry.
  assert.equal(effectiveRadius(20, 2.0, MIN_TOUCH_PX), 20);
});

test('mouse never inflates anything', () => {
  assert.equal(effectiveRadius(20, 0.1, MOUSE_CONFIG.minTouchPx), 20);
});

test('TOUCH: nearest-wins lets you attack into a melee', () => {
  // THE behavioural change. With first-match-wins and a ~41-unit effective
  // radius, your own soldier and an adjacent enemy are both under the finger,
  // so tapping to attack would just re-select your own squad forever.
  const w = mkWorld();
  w.soldiers.set(1, { id: 1, ownerId: 'p0', hp: 10, groupId: 7, position: { x: 125, y: 100 } });
  w.soldiers.set(2, { id: 2, ownerId: 'p1', hp: 10, position: { x: 110, y: 100 } });

  const hit = pickTarget(w, { x: 100, y: 100 }, PHONE_ZOOM, TOUCH_CONFIG);
  assert.equal(hit.kind, 'enemy', 'the thing under the finger centre must win');
});

test('DESKTOP REGRESSION LOCK: mouse keeps the historical first-match order', () => {
  const w = mkWorld();
  w.soldiers.set(1, { id: 1, ownerId: 'p0', hp: 10, groupId: 7, position: { x: 110, y: 100 } });
  w.soldiers.set(2, { id: 2, ownerId: 'p1', hp: 10, position: { x: 105, y: 100 } });

  // Own soldier is FARTHER, and must still win for the mouse.
  const hit = pickTarget(w, { x: 100, y: 100 }, DESKTOP_ZOOM, MOUSE_CONFIG);
  assert.equal(hit.kind, 'ownSoldier', 'desktop behaviour must not change');
});

test('a base defence ring still beats soldiers standing inside it', () => {
  // Long-standing deliberate behaviour: clicking anywhere in the ring targets
  // the base, so the soldiers milling around it never steal the click.
  const w = mkWorld();
  w.players.set('p1', { id: 'p1', alive: true, base: { id: 99, ownerId: 'p1', position: { x: 100, y: 100 } } });
  w.soldiers.set(2, { id: 2, ownerId: 'p1', hp: 10, position: { x: 150, y: 100 } });

  for (const cfg of [MOUSE_CONFIG, TOUCH_CONFIG]) {
    const hit = pickTarget(w, { x: 150, y: 100 }, PHONE_ZOOM, cfg);
    assert.equal(hit.entity.id, 99);
  }
});

test('dead soldiers are never targets', () => {
  const w = mkWorld();
  w.soldiers.set(2, { id: 2, ownerId: 'p1', hp: 0, position: { x: 100, y: 100 } });
  assert.equal(pickTarget(w, { x: 100, y: 100 }, PHONE_ZOOM, TOUCH_CONFIG), null);
});

test('mine nodes are only targets in mining mode', () => {
  const ffa = mkWorld({ mode: 'ffa' });
  ffa.mineNodes.set(5, { id: 5, position: { x: 100, y: 100 } });
  assert.equal(pickTarget(ffa, { x: 100, y: 100 }, PHONE_ZOOM, TOUCH_CONFIG), null);

  const mining = mkWorld({ mode: 'mining' });
  mining.mineNodes.set(5, { id: 5, position: { x: 100, y: 100 } });
  assert.equal(pickTarget(mining, { x: 100, y: 100 }, PHONE_ZOOM, TOUCH_CONFIG).kind, 'mineNode');
});

test('teammate bases are only targets in team mode', () => {
  const mk = (mode) => mkWorld({
    mode,
    teamOf: () => 'blue',
    players: new Map([['p1', {
      id: 'p1', alive: true, team: 'blue',
      base: { id: 42, ownerId: 'p1', position: { x: 100, y: 100 } },
    }]]),
    areEnemies: () => false,
  });
  assert.equal(pickTarget(mk('team'), { x: 100, y: 100 }, PHONE_ZOOM, TOUCH_CONFIG).kind, 'teammateBase');
  assert.equal(pickTarget(mk('ffa'),  { x: 100, y: 100 }, PHONE_ZOOM, TOUCH_CONFIG), null);
});

test('empty ground resolves to nothing, so it becomes a move order', () => {
  assert.equal(pickTarget(mkWorld(), { x: 0, y: 0 }, PHONE_ZOOM, TOUCH_CONFIG), null);
});
