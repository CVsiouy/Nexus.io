import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, TICK_MS } from '../Simulation.js';
import { LATE_JOIN_PROTECT_MAX_MS, SPAWN_PROTECT } from '../constants.js';

const quiet = { error: () => {}, warn: () => {}, log: () => {} };
const run = (sim, seconds) => {
  for (let i = 0; i < Math.round((seconds * 1000) / TICK_MS); i++) sim.step(TICK_MS);
};

// ── Spawn protection actually protects ───────────────────────────────────────
// This flag existed from the start but nothing ever checked it — it only drew a
// pulsing ring. Barely mattered against bots; it is the whole basis of
// late-join fairness with real players.

test('a spawn-protected base takes no damage', () => {
  const sim = new Simulation({ logger: quiet });
  const victim = sim.state.players.get('p0');
  const attacker = sim.state.players.get('p4');

  victim.base.spawnProtected = true;
  victim.base.protectTimer = 60_000;
  const hpBefore = victim.base.hp;

  // Park an enemy squad right on top of the base and let it swing.
  attacker.base.garrison = 15;
  sim.applyCommand(attacker.id, { t: 'release' });
  const squad = [...sim.state.groups.values()].find(g => g.ownerId === attacker.id && g.memberIds.length >= 15);
  for (const id of squad.memberIds) {
    const s = sim.state.soldiers.get(id);
    s.position.x = victim.base.position.x + 10;
    s.position.y = victim.base.position.y + 10;
  }
  sim.applyCommand(attacker.id, { t: 'attack', g: [squad.id], target: victim.base.id });

  run(sim, 5);
  assert.equal(victim.base.hp, hpBefore, 'a protected base lost HP');
});

test('protection ends the moment you throw the first punch', () => {
  // Otherwise a late joiner could attack with total impunity for a minute.
  const sim = new Simulation({ logger: quiet });
  const me = sim.state.players.get('p0');
  const victim = sim.state.players.get('p4');

  me.base.spawnProtected = true;
  me.base.protectTimer = 60_000;

  // The victim must be attackable, or the strike returns before we ever reach
  // the forfeit rule.
  victim.base.spawnProtected = false;
  victim.base.protectTimer = 0;

  me.base.garrison = 15;
  sim.applyCommand('p0', { t: 'release' });
  const squad = [...sim.state.groups.values()].find(g => g.ownerId === 'p0' && g.memberIds.length >= 15);
  for (const id of squad.memberIds) {
    const s = sim.state.soldiers.get(id);
    s.position.x = victim.base.position.x + 10;
    s.position.y = victim.base.position.y + 10;
  }
  sim.applyCommand('p0', { t: 'attack', g: [squad.id], target: victim.base.id });

  run(sim, 5);
  assert.equal(me.base.spawnProtected, false, 'attacking should forfeit protection');
});

test('defending your own base does NOT forfeit protection', () => {
  // The subtle one. An earlier version forfeited protection on any damage
  // dealt — so your own grunt fighting off an attacker at your own base
  // instantly stripped your protection, and it protected nobody, ever.
  const sim = new Simulation({ logger: quiet });
  const me = sim.state.players.get('p0');
  const raider = sim.state.players.get('p4');

  me.base.spawnProtected = true;
  me.base.protectTimer = 60_000;

  // Throw raiders at my base so my starting grunt has to fight back.
  raider.base.garrison = 15;
  sim.applyCommand('p4', { t: 'release' });
  const squad = [...sim.state.groups.values()].find(g => g.ownerId === 'p4' && g.memberIds.length >= 15);
  for (const id of squad.memberIds) {
    const s = sim.state.soldiers.get(id);
    s.position.x = me.base.position.x + 20;
    s.position.y = me.base.position.y + 20;
  }

  run(sim, 5);

  assert.equal(me.base.spawnProtected, true,
    'fighting off an attacker at your own base should not cost you protection');
  assert.equal(me.base.hp, 10000, 'the protected base should be untouched');
});

test('protection expires on its own', () => {
  const sim = new Simulation({ logger: quiet });
  const p = sim.state.players.get('p0');
  assert.equal(p.base.spawnProtected, true, 'bases start protected');
  run(sim, (SPAWN_PROTECT / 1000) + 2);
  assert.equal(p.base.spawnProtected, false, 'protection should have run out');
});

// ── Late joiners ─────────────────────────────────────────────────────────────

test('joining at the start gets no special treatment', () => {
  const sim = new Simulation({ logger: quiet });
  const goldBefore = sim.state.players.get('p0').base.gold;
  const me = sim.claimSeat('s1', 'Early');
  assert.equal(me.base.gold, goldBefore, 'an on-time joiner should get no bonus gold');
});

test('joining late grants more protection and some catch-up gold', () => {
  const sim = new Simulation({ logger: quiet });
  run(sim, 600);   // ten minutes in

  const baseline = sim.state.players.get('p0').base.gold;
  const me = sim.claimSeat('late', 'Latecomer');

  assert.equal(me.base.spawnProtected, true, 'a late joiner must be protected');
  assert.ok(me.base.protectTimer > SPAWN_PROTECT,
    `expected more than the flat ${SPAWN_PROTECT}ms, got ${me.base.protectTimer}`);
  assert.ok(me.base.gold > baseline, 'a late joiner should get catch-up gold');
});

test('late-join compensation is capped', () => {
  // Generous is good; unbounded is exploitable.
  const sim = new Simulation({ logger: quiet });
  sim.state.time = 60 * 60 * 1000;   // an hour in
  const me = sim.claimSeat('late', 'VeryLate');

  assert.ok(me.base.protectTimer <= LATE_JOIN_PROTECT_MAX_MS,
    `protection should cap at ${LATE_JOIN_PROTECT_MAX_MS}ms, got ${me.base.protectTimer}`);
  assert.ok(me.base.gold < 2000, `catch-up gold should be capped, got ${me.base.gold}`);
});

// ── Map pings ────────────────────────────────────────────────────────────────

test('a ping is broadcast as an event and changes nothing else', () => {
  const sim = new Simulation({ logger: quiet });
  const goldBefore = sim.state.players.get('p0').base.gold;

  const res = sim.applyCommand('p0', { t: 'ping', x: 500, y: 600, kind: 'attack' });
  assert.equal(res.ok, true);

  const ev = sim.drainEvents().find(e => e.type === 'ping');
  assert.ok(ev, 'no ping event was raised');
  assert.equal(ev.data.ownerId, 'p0');
  assert.equal(ev.data.kind, 'attack');
  assert.equal(ev.data.x, 500);
  assert.equal(sim.state.players.get('p0').base.gold, goldBefore, 'pinging must not affect the game');
});

test('ping coordinates are clamped to the map', () => {
  const sim = new Simulation({ logger: quiet });
  sim.applyCommand('p0', { t: 'ping', x: -99999, y: 99999, kind: 'help' });
  const ev = sim.drainEvents().find(e => e.type === 'ping');
  assert.ok(ev.data.x >= 0 && ev.data.y >= 0, 'ping escaped the map');
});

test('a ping carries the sender\'s team so enemies can be filtered out', () => {
  // Otherwise pinging "attack here" would tell your enemies your plan.
  const sim = new Simulation({ mode: 'team', logger: quiet });
  sim.applyCommand('p0', { t: 'ping', x: 100, y: 100, kind: 'attack' });
  const ev = sim.drainEvents().find(e => e.type === 'ping');
  assert.equal(ev.data.team, sim.state.players.get('p0').team);
});
