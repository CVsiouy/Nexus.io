import test from 'node:test';
import assert from 'node:assert/strict';
import { HashGrid } from '../spatial/HashGrid.js';
import { WORLD_SIZE } from '../constants.js';

/**
 * The grid is an OPTIMISATION, which means the bar is not "does it work" but
 * "does it give exactly the same answers as the slow version it replaces".
 * If it ever disagrees, gameplay silently changes — soldiers ignoring an enemy
 * standing next to them, or a turret picking the wrong target.
 *
 * So most of these tests compare the grid against brute force on random data.
 */

let seed = 12345;
/** Deterministic pseudo-random, so a failure can be reproduced exactly. */
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function makeEntities(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i,
      hp: 10,
      ownerId: `p${i % 8}`,
      position: { x: rnd() * WORLD_SIZE, y: rnd() * WORLD_SIZE },
    });
  }
  return out;
}

const bruteNearest = (ents, x, y, r, accept) => {
  let best = null, bestD2 = r * r;
  for (const e of ents) {
    if (accept && !accept(e)) continue;
    const d2 = (e.position.x - x) ** 2 + (e.position.y - y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = e; }
  }
  return best;
};

test('nearest() agrees with brute force over many random queries', () => {
  const ents = makeEntities(600);
  const grid = new HashGrid(WORLD_SIZE).rebuild(ents);

  for (let q = 0; q < 500; q++) {
    const x = rnd() * WORLD_SIZE, y = rnd() * WORLD_SIZE;
    const r = 40 + rnd() * 260;
    const got = grid.nearest(x, y, r);
    const want = bruteNearest(ents, x, y, r);
    assert.equal(got?.id ?? null, want?.id ?? null,
      `disagreement at (${x.toFixed(0)}, ${y.toFixed(0)}) r=${r.toFixed(0)}`);
  }
});

test('nearest() respects the accept filter, like the enemy checks do', () => {
  const ents = makeEntities(400);
  const grid = new HashGrid(WORLD_SIZE).rebuild(ents);
  const isEnemy = (e) => e.ownerId !== 'p0';

  for (let q = 0; q < 300; q++) {
    const x = rnd() * WORLD_SIZE, y = rnd() * WORLD_SIZE;
    const r = 50 + rnd() * 250;
    assert.equal(
      grid.nearest(x, y, r, isEnemy)?.id ?? null,
      bruteNearest(ents, x, y, r, isEnemy)?.id ?? null,
    );
  }
});

test('any() agrees with brute force', () => {
  const ents = makeEntities(300);
  const grid = new HashGrid(WORLD_SIZE).rebuild(ents);

  for (let q = 0; q < 300; q++) {
    const x = rnd() * WORLD_SIZE, y = rnd() * WORLD_SIZE;
    const r = 30 + rnd() * 200;
    const want = ents.some(e => (e.position.x - x) ** 2 + (e.position.y - y) ** 2 < r * r);
    // any() is a broad-phase test — it may report true for something just
    // outside the radius, so we only assert it never MISSES anything.
    if (want) assert.equal(grid.any(x, y, r), true, 'grid missed an entity brute force found');
  }
});

test('forEachNear never misses an entity inside the radius', () => {
  // The one guarantee that actually matters. Extra candidates are fine (callers
  // do their own exact distance check); a missed one is a gameplay bug.
  const ents = makeEntities(500);
  const grid = new HashGrid(WORLD_SIZE).rebuild(ents);

  for (let q = 0; q < 200; q++) {
    const x = rnd() * WORLD_SIZE, y = rnd() * WORLD_SIZE;
    const r = 20 + rnd() * 300;

    const seen = new Set();
    grid.forEachNear(x, y, r, (e) => seen.add(e.id));

    for (const e of ents) {
      const d2 = (e.position.x - x) ** 2 + (e.position.y - y) ** 2;
      if (d2 <= r * r) {
        assert.ok(seen.has(e.id), `entity ${e.id} inside radius ${r.toFixed(0)} was missed`);
      }
    }
  }
});

test('handles entities exactly on the map edges and outside it', () => {
  const grid = new HashGrid(WORLD_SIZE);
  const ents = [
    { id: 1, hp: 1, position: { x: 0, y: 0 } },
    { id: 2, hp: 1, position: { x: WORLD_SIZE, y: WORLD_SIZE } },
    { id: 3, hp: 1, position: { x: -50, y: -50 } },        // shouldn't happen, mustn't crash
    { id: 4, hp: 1, position: { x: WORLD_SIZE + 99, y: 10 } },
  ];
  assert.doesNotThrow(() => grid.rebuild(ents));
  assert.equal(grid.size, 4);
  assert.ok(grid.any(0, 0, 20), 'entity at the origin should be findable');
  assert.ok(grid.any(WORLD_SIZE, WORLD_SIZE, 20), 'entity at the far corner should be findable');
});

test('skips dead entities on rebuild', () => {
  const grid = new HashGrid(WORLD_SIZE).rebuild([
    { id: 1, hp: 10, position: { x: 100, y: 100 } },
    { id: 2, hp: 0,  position: { x: 100, y: 100 } },
  ]);
  assert.equal(grid.size, 1);
  assert.equal(grid.nearest(100, 100, 50)?.id, 1);
});

test('rebuild fully clears the previous tick', () => {
  // Cells are reused rather than reallocated, so a bug here would leave ghost
  // soldiers that were killed several ticks ago still being targeted.
  const grid = new HashGrid(WORLD_SIZE);
  grid.rebuild(makeEntities(200));
  grid.rebuild([{ id: 999, hp: 1, position: { x: 500, y: 500 } }]);

  assert.equal(grid.size, 1);
  let count = 0;
  grid.forEachNear(500, 500, WORLD_SIZE, () => count++);
  assert.equal(count, 1, 'stale entities survived a rebuild');
});

test('count() only counts what is genuinely inside the radius', () => {
  const ents = makeEntities(400);
  const grid = new HashGrid(WORLD_SIZE).rebuild(ents);

  for (let q = 0; q < 200; q++) {
    const x = rnd() * WORLD_SIZE, y = rnd() * WORLD_SIZE;
    const r = 50 + rnd() * 200;
    const want = ents.filter(e => (e.position.x - x) ** 2 + (e.position.y - y) ** 2 <= r * r).length;
    assert.equal(grid.count(x, y, r), want);
  }
});

test('is dramatically faster than brute force at realistic entity counts', () => {
  // Not a strict assertion about wall-clock time (CI machines vary wildly),
  // but a sanity check that the whole exercise was worth it.
  const ents = makeEntities(500);
  const grid = new HashGrid(WORLD_SIZE).rebuild(ents);

  let checksNaive = 0, checksGrid = 0;
  for (const e of ents) {
    checksNaive += ents.length;
    grid.forEachNear(e.position.x, e.position.y, 210, () => checksGrid++);
  }

  const ratio = checksNaive / checksGrid;
  assert.ok(ratio > 5,
    `expected the grid to cut candidate checks by >5x, got ${ratio.toFixed(1)}x ` +
    `(${checksNaive} naive vs ${checksGrid} grid)`);
  console.log(`      grid examines ${ratio.toFixed(0)}x fewer candidates ` +
              `(${checksNaive.toLocaleString()} → ${checksGrid.toLocaleString()})`);
});
