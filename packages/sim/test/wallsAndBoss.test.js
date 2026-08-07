import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, TICK_MS } from '../Simulation.js';
import { AISystem } from '../systems/AISystem.js';
import {
  slotAtAngle, solidAtAngle, crossesWall, outermostLayer,
} from '../walls.js';
import {
  WORLD_SIZE, BOSS_COUNT, BOSS_FIRST_MS, BOSS_STAGGER_MS, BOSS_GOLD_REWARD,
  BOSS_MAX_SQUADS, BOSS_SQUAD_SIZE, GROUP_MAX_SIZE, WALL_CELL_SIZE,
  BASE_DEFENSE_RADIUS,
} from '../constants.js';
import { goldRate } from '../systems/ProgressionSystem.js';

const quiet = { error: () => {}, warn: () => {}, log: () => {} };
const run = (sim, sec) => { for (let i = 0; i < (sec * 1000) / TICK_MS; i++) sim.step(TICK_MS); };

/**
 * Run with the players unable to interfere.
 *
 * Bots now genuinely go for bosses (see the last test), which is the point —
 * but it means a test that wants to observe a boss over several minutes has to
 * stop them killing it first. Sweeping away non-boss soldiers each tick leaves
 * the boss alone without disabling any of its own behaviour.
 */
function runUndisturbed(sim, sec) {
  for (let i = 0; i < (sec * 1000) / TICK_MS; i++) {
    sim.step(TICK_MS);
    for (const [id, s] of sim.state.soldiers) {
      if (s.ownerId !== 'boss') { sim.state.soldiers.delete(id); sim.state.freeId(id); }
    }
  }
}

// ── Walls are solid except where they are broken ─────────────────────────────

function ring(radius = 100, maxCells = 12, missing = []) {
  return {
    ring: 0, radius, maxCells,
    cells: Array.from({ length: maxCells }, (_, slot) => ({ slot, hp: 100, maxHp: 100 }))
      .filter(c => !missing.includes(c.slot)),
  };
}
const at = (base, layer, slot, dist) => {
  const a = (slot / layer.maxCells) * Math.PI * 2 - Math.PI / 2;
  return { x: base.position.x + Math.cos(a) * dist, y: base.position.y + Math.sin(a) * dist };
};

test('every slot of an intact ring is solid', () => {
  const layer = ring();
  for (let s = 0; s < layer.maxCells; s++) {
    const angle = (s / layer.maxCells) * Math.PI * 2 - Math.PI / 2;
    assert.equal(slotAtAngle(layer, angle), s, `angle for slot ${s} resolved to the wrong slot`);
    assert.equal(solidAtAngle(layer, angle), true, `slot ${s} should be solid`);
  }
});

test('destroying one cell opens exactly that sector and no other', () => {
  // The whole point of a breach: it is a doorway at a known place, not a
  // general collapse of the wall.
  const layer = ring(100, 12, [4]);
  for (let s = 0; s < layer.maxCells; s++) {
    const angle = (s / layer.maxCells) * Math.PI * 2 - Math.PI / 2;
    assert.equal(solidAtAngle(layer, angle), s !== 4,
      `slot ${s} solidity is wrong after breaching slot 4`);
  }
});

test('an enemy cannot walk through a standing section', () => {
  const base = { position: { x: 500, y: 500 } };
  const layer = ring(100, 12, [4]);
  const outside = at(base, layer, 0, 200);
  const inside = at(base, layer, 0, 40);
  assert.equal(crossesWall(base, layer, outside, inside), true,
    'walked straight through an intact part of the wall');
});

test('an enemy CAN walk through the breach', () => {
  const base = { position: { x: 500, y: 500 } };
  const layer = ring(100, 12, [4]);
  const outside = at(base, layer, 4, 200);
  const inside = at(base, layer, 4, 40);
  assert.equal(crossesWall(base, layer, outside, inside), false,
    'the breach did not let anyone in — it is supposed to be a doorway');
});

test('somebody already inside is free to move around', () => {
  // Blocking is about CROSSING, not about being inside. Someone who came in
  // through the gap must not be teleported back out for standing in the wrong
  // place afterwards.
  const base = { position: { x: 500, y: 500 } };
  const layer = ring(100, 12, [4]);
  const a = at(base, layer, 4, 40);
  const b = at(base, layer, 0, 40);   // moving inside, behind a standing cell
  assert.equal(crossesWall(base, layer, a, b), false,
    'a soldier inside the wall was treated as crossing it');
});

test('leaving is never blocked', () => {
  const base = { position: { x: 500, y: 500 } };
  const layer = ring();
  const inside = at(base, layer, 0, 40);
  const outside = at(base, layer, 0, 200);
  assert.equal(crossesWall(base, layer, inside, outside), false, 'walls should not trap you inside');
});

test('an incomplete ring still blocks where it stands (the old bug)', () => {
  // Previously ANY missing cell made the whole ring stop blocking, so one
  // broken piece let attackers cross anywhere they liked.
  const base = { position: { x: 500, y: 500 } };
  const layer = ring(100, 12, [4, 5]);
  let blocked = 0;
  for (let s = 0; s < layer.maxCells; s++) {
    if (crossesWall(base, layer, at(base, layer, s, 200), at(base, layer, s, 40))) blocked++;
  }
  assert.equal(blocked, 10, `expected 10 of 12 sectors to still block, got ${blocked}`);
});

test('soldiers do not end up inside a walled base in a real match', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  const base = sim.state.players.get('p0').base;
  for (let i = 0; i < 14; i++) sim.applyCommand('p0', { t: 'queue', unit: 'sentinel', n: 1 });
  run(sim, 260);

  const layer = outermostLayer(base);
  if (!layer || layer.cells.length < layer.maxCells) return;   // no intact ring to test

  for (const [, s] of sim.state.soldiers) {
    if (s.ownerId === 'p0' || s.hp <= 0) continue;
    const d = Math.hypot(s.position.x - base.position.x, s.position.y - base.position.y);
    assert.ok(d > layer.radius - WALL_CELL_SIZE * 2,
      `enemy soldier ${s.id} is inside an intact wall (${d.toFixed(0)} < ${layer.radius})`);
  }
});

// ── Defenders hold behind their wall ─────────────────────────────────────────

test('a defending squad stays inside its own wall instead of marching out', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  const me = sim.state.players.get('p0');

  // Build a wall, then put a defending squad behind it.
  for (let i = 0; i < 12; i++) sim.applyCommand('p0', { t: 'queue', unit: 'sentinel', n: 1 });
  run(sim, 240);
  const layer = outermostLayer(me.base);
  if (!layer) return;   // never got a wall up; nothing to assert

  me.base.garrison = GROUP_MAX_SIZE;
  sim.applyCommand('p0', { t: 'release' });

  // Park an attacker just outside the wall so the defenders are tempted out.
  const enemy = sim.state.players.get('p4');
  enemy.base.garrison = GROUP_MAX_SIZE;
  sim.applyCommand('p4', { t: 'release' });
  for (const [, s] of sim.state.soldiers) {
    if (s.ownerId !== 'p4') continue;
    s.position.x = me.base.position.x + layer.radius + 40;
    s.position.y = me.base.position.y;
  }
  run(sim, 6);

  const mine = sim.state.groupsOf('p0').filter(g => g.status === 'defending');
  for (const g of mine) {
    const d = Math.hypot(g.anchor.x - me.base.position.x, g.anchor.y - me.base.position.y);
    assert.ok(d <= layer.radius,
      `defending squad anchored OUTSIDE its own wall (${d.toFixed(0)} > ${layer.radius})`);
  }
});

// ── Bosses ───────────────────────────────────────────────────────────────────

test('bosses appear on schedule, not on a repeating timer', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  assert.equal(sim.state.bosses.size, 0, 'no boss should exist at the start');

  runUndisturbed(sim, (BOSS_FIRST_MS / 1000) - 5);
  assert.equal(sim.state.bossesSpawned, 0, 'the first boss arrived early');

  runUndisturbed(sim, 10);
  assert.equal(sim.state.bossesSpawned, 1, 'the first boss should have appeared');
  assert.equal(sim.state.bosses.size, 1);

  runUndisturbed(sim, BOSS_STAGGER_MS / 1000);
  assert.equal(sim.state.bossesSpawned, BOSS_COUNT, 'the second boss should have appeared');

  // And no more, ever — they are a fixed set, not a repeating spawn.
  runUndisturbed(sim, 400);
  assert.equal(sim.state.bossesSpawned, BOSS_COUNT, 'more bosses spawned than BOSS_COUNT');
});

test('a boss never moves', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  run(sim, (BOSS_FIRST_MS / 1000) + 5);
  const boss = [...sim.state.bosses.values()][0];
  const at0 = { ...boss.position };

  run(sim, 180);
  assert.equal(boss.position.x, at0.x, 'the boss drifted in x');
  assert.equal(boss.position.y, at0.y, 'the boss drifted in y');
});

test('a boss starts walled and never repairs or rebuilds it', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  run(sim, (BOSS_FIRST_MS / 1000) + 5);
  const boss = [...sim.state.bosses.values()][0];

  assert.equal(boss.walls.length, 1, 'a boss should start with exactly one ring');
  const layer = boss.walls[0];
  const cellsAtStart = layer.cells.length;

  // Damage a cell and destroy another, then wait a long quiet while.
  layer.cells[0].hp *= 0.3;
  const damaged = layer.cells[0].hp;
  layer.cells.splice(1, 1);

  run(sim, 200);

  assert.equal(layer.cells[0].hp, damaged, 'a boss wall healed itself');
  assert.equal(layer.cells.length, cellsAtStart - 1, 'a boss rebuilt a destroyed wall cell');
});

test('a boss never heals', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  run(sim, (BOSS_FIRST_MS / 1000) + 5);
  const boss = [...sim.state.bosses.values()][0];

  boss.hp = boss.maxHp * 0.4;
  const hurt = boss.hp;
  run(sim, 200);
  assert.ok(boss.hp <= hurt, `the boss regenerated: ${hurt} → ${boss.hp}`);
});

test('a boss garrison is defensive, capped, and never leaves', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  runUndisturbed(sim, (BOSS_FIRST_MS / 1000) + 400);

  const bossGroups = [...sim.state.groups.values()].filter(g => g.ownerId === 'boss');
  assert.ok(bossGroups.length > 0, 'the boss never grew a garrison');
  assert.ok(bossGroups.length <= BOSS_COUNT * BOSS_MAX_SQUADS,
    `boss garrison exceeded its cap: ${bossGroups.length} squads`);

  for (const g of bossGroups) {
    assert.equal(g.status, 'defending', 'a boss squad went on the offensive');
    assert.equal(g.formed, false, 'a boss squad became deployable');
    assert.ok(g.guardPos, 'a boss squad has no point to guard');
  }
});

test('killing a boss grants permanent income, bounded by the number of bosses', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  run(sim, (BOSS_FIRST_MS / 1000) + 5);

  const boss = [...sim.state.bosses.values()][0];
  const killer = sim.state.players.get('p0');
  const rateBefore = goldRate(killer.base);

  boss.hp = 0;
  boss.lastAttackerId = 'p0';
  sim.step(TICK_MS);

  assert.equal(sim.state.bosses.size, 0, 'the boss was not removed');
  assert.equal(killer.base.bossBonus, BOSS_GOLD_REWARD);
  assert.ok(goldRate(killer.base) > rateBefore, 'the reward did not raise income');

  // The ceiling is what makes ongoing income safe here: only BOSS_COUNT exist.
  assert.ok(killer.base.bossBonus <= BOSS_COUNT * BOSS_GOLD_REWARD);
});

test('a boss garrison dies with its boss', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  runUndisturbed(sim, (BOSS_FIRST_MS / 1000) + 120);

  const boss = [...sim.state.bosses.values()][0];
  const before = [...sim.state.soldiers.values()].filter(s => s.ownerId === 'boss').length;
  assert.ok(before > 0, 'expected a garrison to exist');

  boss.hp = 0;
  boss.lastAttackerId = 'p0';
  sim.step(TICK_MS);
  sim.step(TICK_MS);

  const after = [...sim.state.soldiers.values()].filter(s => s.ownerId === 'boss').length;
  assert.ok(after < before, 'the garrison outlived its boss');
});

test('bots do commit to bosses, and bosses are beatable', () => {
  // The old boss was effectively unkillable: it wandered away from whoever was
  // fighting it and the bots had no notion of it at all.
  let killed = 0, spawned = 0;
  for (let m = 0; m < 4; m++) {
    const sim = new Simulation({ mode: 'ffa', logger: quiet });
    for (let t = 0; t < (16 * 60 * 1000) / TICK_MS; t++) {
      sim.step(TICK_MS);
      for (const ev of sim.drainEvents()) {
        if (ev.type === 'bossSpawned') spawned++;
        if (ev.type === 'bossKilled') killed++;
      }
      if (sim.matchResult()) break;
    }
  }
  assert.ok(spawned > 0, 'no bosses spawned at all');
  assert.ok(killed > 0, `bots never killed a boss (${killed}/${spawned}) — it is not beatable`);
});
