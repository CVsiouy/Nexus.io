import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, TICK_MS } from '@basewar/sim';
import { WorldView, INTERP_DELAY_MS } from '../src/net/WorldView.js';
import { Selection } from '../src/Selection.js';

const quiet = { error: () => {}, warn: () => {}, log: () => {} };

/** Build a simulation and a view fed from it, as the real client does. */
function harness(mode = 'ffa') {
  const sim = new Simulation({ mode, logger: quiet });
  const view = new WorldView();
  let clock = 10_000;

  // Claim a seat exactly as a real client does, and tell the view which base is
  // ours — that fact arrives in the welcome message, never in a snapshot,
  // because the server sends one identical snapshot to all eight players.
  const me = sim.claimSeat('test-session', 'Tester');
  view.setLocalId(me.id);

  return {
    sim, view, me,
    /** Advance the sim and deliver a snapshot, as the worker does. */
    push(ticks = 1) {
      for (let i = 0; i < ticks; i++) sim.step(TICK_MS);
      clock += ticks * TICK_MS;   // wall-clock must track game time, or
      view.ingest(sim.getSnapshot(), clock);  // interpolation maths goes wrong
      return clock;
    },
    /** Give the player a full squad and send it somewhere — deterministically. */
    deployMovingSquad(x, y) {
      me.base.garrison = 15;
      sim.applyCommand(me.id, { t: 'release' });
      const g = [...sim.state.groups.values()]
        .find(gr => gr.ownerId === me.id && gr.memberIds.length >= 15);
      if (g) sim.applyCommand(me.id, { t: 'move', g: [g.id], x, y });
      return g;
    },
    /** Render as if it were `t` on the same clock. */
    draw(t) { view.sample(t); },
    now: () => clock,
  };
}

test('a view starts empty and becomes ready after the first snapshot', () => {
  const h = harness();
  assert.equal(h.view.ready, false);
  h.push();
  assert.equal(h.view.ready, true);
});

test('the view reproduces the simulation it was fed', () => {
  const h = harness();
  h.deployMovingSquad(1400, 1400);
  h.push(60);
  h.push();
  // Draw far enough ahead that we hold on the newest snapshot.
  h.draw(h.now() + INTERP_DELAY_MS + 10);

  assert.equal(h.view.players.size, h.sim.state.players.size);
  assert.equal(h.view.soldiers.size, h.sim.state.soldiers.size);
  assert.equal(h.view.groups.size, h.sim.state.groups.size);
  assert.equal(h.view.playerId, h.me.id);
  assert.equal(h.view.mode, 'ffa');

  // Entities must be shaped like the old GameState so the renderers work
  // unchanged: position objects, not flat x/y.
  const s = [...h.view.soldiers.values()][0];
  assert.ok(s.position && typeof s.position.x === 'number', 'soldier needs position.x');

  const p = h.view.players.get(h.me.id);
  assert.ok(p.base.position && typeof p.base.position.x === 'number');
  assert.ok(p.base.unlocked instanceof Set, 'unlocked must be a Set for .has()');
  assert.ok(p.base.unlocked.has('grunt'));
});

test('positions are interpolated, not snapped', () => {
  const h = harness();

  // Make soldiers that are definitely in motion. Just running the clock isn't
  // enough: the player's lone starting grunt settles into its formation slot
  // and then sits still, and bots stockpile in the garrison before fielding
  // anything, so early on almost nothing is moving.
  assert.ok(h.deployMovingSquad(1400, 1400), 'expected a released squad');

  // Two snapshots with a known gap, and a soldier that actually moved.
  const t0 = h.push();
  const before = new Map([...h.sim.state.soldiers].map(([id, s]) => [id, { ...s.position }]));
  const t1 = h.push(4);
  const after = new Map([...h.sim.state.soldiers].map(([id, s]) => [id, { ...s.position }]));

  const moved = [...before.keys()].find(id => {
    const a = before.get(id), b = after.get(id);
    return b && Math.hypot(b.x - a.x, b.y - a.y) > 4;
  });
  assert.ok(moved, 'expected at least one soldier to have moved');

  // Sample exactly halfway between the two snapshots.
  h.draw((t0 + t1) / 2 + INTERP_DELAY_MS);
  const shown = h.view.soldiers.get(moved).position;
  const a = before.get(moved), b = after.get(moved);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  assert.ok(Math.abs(shown.x - mid.x) < 1.5, `x should be near the midpoint (${shown.x} vs ${mid.x})`);
  assert.ok(Math.abs(shown.y - mid.y) < 1.5, `y should be near the midpoint (${shown.y} vs ${mid.y})`);
  // And crucially NOT sitting on either endpoint — that would mean no smoothing.
  assert.ok(Math.hypot(shown.x - a.x, shown.y - a.y) > 0.5, 'view snapped to the old position');
});

test('holds on the newest snapshot instead of guessing past it', () => {
  const h = harness();
  h.push(30);
  const t = h.push();

  // Ask for a moment far beyond anything we have. It must clamp, not extrapolate:
  // a guess would have to be yanked back later, which reads as rubber-banding.
  h.draw(t + 5000);
  const a = [...h.view.soldiers.values()].map(s => ({ ...s.position }));
  h.draw(t + 9000);
  const b = [...h.view.soldiers.values()].map(s => ({ ...s.position }));

  assert.deepEqual(a, b, 'the world drifted forward with no new data');
});

test('entities that disappear from snapshots are removed from the view', () => {
  const h = harness();
  h.deployMovingSquad(1400, 1400);
  h.push(80);
  h.draw(h.now() + INTERP_DELAY_MS + 10);
  assert.ok(h.view.soldiers.size > 0);

  // Wipe every soldier in the simulation, then deliver two clean snapshots.
  for (const [id] of h.sim.state.soldiers) { h.sim.state.soldiers.delete(id); h.sim.state.freeId(id); }
  h.push();
  h.push();
  h.draw(h.now() + INTERP_DELAY_MS + 10);

  assert.equal(h.view.soldiers.size, 0, 'stale soldiers were left in the view');
});

test('read helpers match the simulation', () => {
  const h = harness('team');
  h.push(60);
  h.draw(h.now() + INTERP_DELAY_MS + 10);

  const w = h.view;
  assert.equal(w.groupsOf(h.me.id).length, h.sim.state.groupsOf(h.me.id).length);
  assert.equal(w.soldierPop(h.me.id), h.sim.state.soldierPop(h.me.id));

  const me = w.players.get(h.me.id);
  assert.equal(w.popCap(me), h.sim.state.popCap(h.sim.state.players.get(h.me.id)));

  // Team awareness has to survive the trip, or you could order an attack on an ally.
  for (const [id] of w.players) {
    assert.equal(w.areEnemies(h.me.id, id), h.sim.state.areEnemies(h.me.id, id),
      `disagreement about whether ${id} is an enemy`);
  }
});

test('the buffer does not grow without bound', () => {
  const h = harness();
  for (let i = 0; i < 400; i++) h.push();
  assert.ok(h.view._buffer.length < 40, `buffer grew to ${h.view._buffer.length} entries`);
});

// ── Selection is client-only state ───────────────────────────────────────────

test('selection tracks squads and drops ones that no longer exist', () => {
  const h = harness();
  h.deployMovingSquad(1400, 1400);
  h.push(60);
  h.draw(h.now() + INTERP_DELAY_MS + 10);

  const sel = new Selection();
  const mine = h.view.groupsOf(h.me.id);
  assert.ok(mine.length, 'player should have a squad');

  sel.only(mine[0].id);
  assert.equal(sel.has(mine[0].id), true);
  assert.equal(sel.resolve(h.view).length, 1);

  // A wiped-out squad must never reach the renderer as a dangling id.
  sel.add(999999);
  assert.equal(sel.resolve(h.view).length, 1, 'a non-existent squad survived resolve()');
  assert.equal(sel.has(999999), false, 'the stale id should have been pruned');
});

test('selection never enters the simulation', () => {
  // The whole point of moving it out: game state is shared with everyone, so a
  // selection stored there would show up on other players' screens.
  const h = harness();
  h.push(30);
  for (const [, g] of h.sim.state.groups) {
    assert.equal('selected' in g, false, 'Group still carries a `selected` flag');
  }
  const snap = h.sim.getSnapshot();
  assert.equal(JSON.stringify(snap).includes('"selected"'), false,
    'selection leaked into the snapshot sent over the wire');
});
