import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSnapshot, decodeSnapshot } from '@nexus/protocol';
// @ts-expect-error — the simulation is plain JavaScript by design.
import { Simulation, TICK_MS, WORLD_SIZE } from '@nexus/sim';

/**
 * The binary codec is a pure optimisation, so the bar is not "does it produce
 * bytes" but "does the client end up seeing the same world". Every test here
 * drives a REAL simulation and checks what survives the round trip.
 *
 * Quantization deliberately loses a little precision — positions land within
 * ~0.7px, which is invisible on a map drawn zoomed out. Anything else must
 * come back exactly.
 */

const quiet = { error: () => {}, warn: () => {}, log: () => {} };

function developed(seconds = 180, mode = 'ffa') {
  const sim = new Simulation({ mode, logger: quiet });
  sim.claimSeat('s1', 'Chirag');
  for (let i = 0; i < (seconds * 1000) / TICK_MS; i++) sim.step(TICK_MS);
  return sim;
}

test('round-trips a developed match', () => {
  const sim = developed();
  const snap = sim.getSnapshot();
  const decoded = decodeSnapshot(encodeSnapshot(snap, true));

  assert.equal(decoded.tick, snap.tick);
  assert.equal(decoded.mode, snap.mode);
  assert.equal(decoded.players.length, snap.players.length);
  assert.equal(decoded.soldiers.length, snap.soldiers.length);
  assert.equal(decoded.groups.length, snap.groups.length);
});

test('soldier positions survive within the quantization step', () => {
  const sim = developed();
  const snap = sim.getSnapshot();
  const decoded = decodeSnapshot(encodeSnapshot(snap, true));

  const byId = new Map(decoded.soldiers.map((s: any) => [s.id, s]));
  let worst = 0;
  for (const s of snap.soldiers) {
    const d = byId.get(s.id);
    assert.ok(d, `soldier ${s.id} vanished in transit`);
    worst = Math.max(worst, Math.hypot(d.x - s.x, d.y - s.y));
    assert.equal(d.type, s.type, 'unit type changed');
    assert.equal(d.ownerId, s.ownerId, 'soldier changed owner');
  }
  // 12 bits over a 2,800px map ≈ 0.68px per step, so under 1px of error.
  assert.ok(worst < 1.0, `worst position error was ${worst.toFixed(3)}px, expected under 1px`);
});

test('base state survives exactly where it must', () => {
  const sim = developed();
  const snap = sim.getSnapshot();
  const decoded = decodeSnapshot(encodeSnapshot(snap, true));

  for (const p of snap.players) {
    const d = decoded.players.find((x: any) => x.id === p.id);
    assert.ok(d, `player ${p.id} vanished`);
    assert.equal(d.seat, p.seat);
    assert.equal(d.alive, p.alive);
    assert.equal(d.isBot, p.isBot);
    assert.equal(d.name, p.name, 'player name changed');
    assert.equal(d.color, p.color, 'player colour changed');
    assert.equal(d.base.level, p.base.level);
    assert.equal(d.base.garrison, p.base.garrison);
    assert.equal(d.base.skillPoints, p.base.skillPoints);
    assert.equal(d.base.specialization, p.base.specialization);
    assert.equal(d.base.spawnProtected, p.base.spawnProtected);
    assert.equal(d.base.id, p.base.id, 'base id changed — attack targeting would break');
    assert.deepEqual(d.buffs, p.buffs);
    assert.deepEqual([...d.base.unlocked].sort(), [...p.base.unlocked].sort());

    assert.ok(Math.abs(d.base.hp - p.base.hp) <= 1, 'base HP drifted');
    assert.ok(Math.abs(d.base.gold - p.base.gold) <= 1, 'gold drifted');
    assert.ok(Math.abs(d.base.x - p.base.x) < 1, 'base moved');
    assert.ok(Math.abs(d.base.y - p.base.y) < 1, 'base moved');
  }
});

test('squads and their membership survive', () => {
  const sim = developed();
  const snap = sim.getSnapshot();
  const decoded = decodeSnapshot(encodeSnapshot(snap, true));

  for (const g of snap.groups) {
    const d = decoded.groups.find((x: any) => x.id === g.id);
    assert.ok(d, `squad ${g.id} vanished`);
    assert.equal(d.ownerId, g.ownerId);
    assert.equal(d.status, g.status);
    assert.equal(d.locked, g.locked);
    assert.equal(d.formed, g.formed);
    assert.deepEqual(d.memberIds, g.memberIds, 'squad membership changed');
    assert.ok(Math.abs(d.anchorX - g.anchorX) < 1);
  }
});

test('soldier→squad links are rebuilt without being sent', () => {
  // We drop 2 bytes per soldier by not sending the link, and reconstruct it
  // from the squads' member lists. If that ever breaks, selection rings and
  // click-to-select a squad both stop working.
  const sim = developed();
  const snap = sim.getSnapshot();
  const decoded = decodeSnapshot(encodeSnapshot(snap, true));

  let checked = 0;
  const byId = new Map(decoded.soldiers.map((s: any) => [s.id, s]));
  for (const s of snap.soldiers) {
    if (s.groupId == null) continue;
    assert.equal(byId.get(s.id).groupId, s.groupId,
      `soldier ${s.id} lost its squad link`);
    checked++;
  }
  assert.ok(checked > 10, 'expected plenty of soldiers in squads to verify');
});

test('walls survive with their per-cell damage', () => {
  const sim = developed(300);
  // Guarantee some walls exist and one is damaged.
  const base = sim.state.players.get('p1').base;
  for (let i = 0; i < 12; i++) sim.applyCommand('p1', { t: 'queue', unit: 'sentinel', n: 1 });
  for (let i = 0; i < 2000; i++) sim.step(TICK_MS);
  if (base.walls[0]?.cells[0]) base.walls[0].cells[0].hp *= 0.4;

  const snap = sim.getSnapshot();
  const decoded = decodeSnapshot(encodeSnapshot(snap, true));

  for (const p of snap.players) {
    const d = decoded.players.find((x: any) => x.id === p.id);
    assert.equal(d.base.walls.length, p.base.walls.length, 'wall ring count changed');
    for (let l = 0; l < p.base.walls.length; l++) {
      assert.equal(d.base.walls[l].cells.length, p.base.walls[l].cells.length, 'cell count changed');
      assert.equal(d.base.walls[l].maxCells, p.base.walls[l].maxCells);
      for (let c = 0; c < p.base.walls[l].cells.length; c++) {
        assert.equal(d.base.walls[l].cells[c].slot, p.base.walls[l].cells[c].slot, 'cell slot changed');
        const wantPct = p.base.walls[l].cells[c].hp / p.base.walls[l].cells[c].maxHp;
        const gotPct = d.base.walls[l].cells[c].hp / d.base.walls[l].cells[c].maxHp;
        assert.ok(Math.abs(gotPct - wantPct) < 0.01, 'cell damage drifted');
      }
    }
  }
});

test('non-keyframes carry the static fields forward from the last keyframe', () => {
  // Names, colours and maxHp only travel on keyframes. If the carry-forward is
  // wrong, every player would be renamed "Seat 3" between keyframes.
  const sim = developed();
  const key = decodeSnapshot(encodeSnapshot(sim.getSnapshot(), true));
  for (let i = 0; i < 20; i++) sim.step(TICK_MS);
  const delta = decodeSnapshot(encodeSnapshot(sim.getSnapshot(), false), key);

  for (const p of key.players) {
    const d = delta.players.find((x: any) => x.id === p.id);
    assert.equal(d.name, p.name, 'name lost between keyframes');
    assert.equal(d.color, p.color, 'colour lost between keyframes');
    assert.equal(d.base.maxHp, p.base.maxHp, 'maxHp lost between keyframes');
    assert.equal(d.base.id, p.base.id, 'base id lost between keyframes');
    assert.ok(Math.abs(d.base.x - p.base.x) < 1, 'base position lost between keyframes');
  }
});

test('the mining mode nodes survive', () => {
  const sim = developed(120, 'mining');
  const snap = sim.getSnapshot();
  const decoded = decodeSnapshot(encodeSnapshot(snap, true));

  assert.equal(decoded.mineNodes.length, snap.mineNodes.length);
  for (const n of snap.mineNodes) {
    const d = decoded.mineNodes.find((x: any) => x.id === n.id);
    assert.ok(d, `node ${n.id} vanished`);
    assert.equal(d.ownerId, n.ownerId, 'node ownership changed');
    assert.ok(Math.abs(d.x - n.x) < 1);
  }
});

test('rejects a snapshot from an incompatible version', () => {
  const sim = developed(30);
  const buf = new Uint8Array(encodeSnapshot(sim.getSnapshot(), true));
  buf[0] = 99;   // pretend it came from a future server
  assert.throws(() => decodeSnapshot(buf), /version/i);
});

test('IS DRAMATICALLY SMALLER THAN JSON — the whole point', () => {
  const sim = developed(300);
  const snap = sim.getSnapshot();

  const jsonBytes = JSON.stringify(snap).length;
  const keyBytes = encodeSnapshot(snap, true).byteLength;
  const deltaBytes = encodeSnapshot(snap, false).byteLength;

  const ratio = jsonBytes / deltaBytes;
  console.log(`      ${snap.soldiers.length} soldiers · JSON ${jsonBytes.toLocaleString()}B ` +
              `→ binary ${deltaBytes.toLocaleString()}B (keyframe ${keyBytes.toLocaleString()}B) ` +
              `= ${ratio.toFixed(1)}x smaller`);

  assert.ok(ratio > 6, `expected >6x smaller, got ${ratio.toFixed(1)}x`);
  assert.ok(deltaBytes < keyBytes, 'a delta frame should be smaller than a keyframe');
});
