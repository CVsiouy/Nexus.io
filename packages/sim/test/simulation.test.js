import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, TICK_MS } from '../Simulation.js';
import { WORLD_SIZE, STARTING_GARRISON } from '../constants.js';

/** Silence expected-error logging so test output stays readable. */
const quiet = { error: () => {}, warn: () => {}, log: () => {} };

/** Run a simulation forward by `seconds` of game time. */
function run(sim, seconds) {
  const ticks = Math.round((seconds * 1000) / TICK_MS);
  for (let i = 0; i < ticks; i++) sim.step(TICK_MS);
  return ticks;
}

test('builds 8 identical seats, all AI-driven until a human claims one', () => {
  const sim = new Simulation({ mode: 'ffa' });
  assert.equal(sim.state.players.size, 8, 'expected 8 mother bases');
  assert.equal(sim.state.bases.size, 8);

  // Every seat starts as a bot. That is what makes a match never look empty
  // and joining instant — the seats you would otherwise wait for are already
  // being played.
  assert.equal([...sim.state.players.values()].every(p => p.isBot), true);
  assert.equal(sim.freeSeats, 8);

  const seats = [...sim.state.players.values()].map(p => p.seat).sort((a, b) => a - b);
  assert.deepEqual(seats, [0, 1, 2, 3, 4, 5, 6, 7]);

  const ids = [...sim.state.players.keys()].sort();
  assert.deepEqual(ids, ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
});

test('every seat starts equal — nobody gets a free head start', () => {
  // Previously one hardcoded seat was "the player" and got a starting grunt the
  // others did not. Now nobody does: a lone soldier loitering outside the base
  // could only ever be picked off, and the first real troops come out of the
  // garrison together as a formation.
  const sim = new Simulation({ mode: 'ffa' });

  assert.equal(sim.state.soldiers.size, 0, 'nobody should start with soldiers on the map');
  assert.equal(sim.state.groups.size, 0, 'nobody should start with a squad');

  const gold = [...sim.state.players.values()].map(p => p.base.gold);
  assert.equal(new Set(gold).size, 1, 'all seats should start with the same gold');

  const hp = [...sim.state.players.values()].map(p => p.base.hp);
  assert.equal(new Set(hp).size, 1, 'all seats should start with the same HP');
});

// ── Seats: claiming, releasing, AI takeover ──────────────────────────────────

test('claiming a seat converts a bot into a human player', () => {
  const sim = new Simulation({ logger: quiet });
  const me = sim.claimSeat('session-abc', 'Chirag');

  assert.ok(me, 'expected to get a seat');
  assert.equal(me.isBot, false);
  assert.equal(me.sessionId, 'session-abc');
  assert.equal(me.name, 'Chirag');
  assert.equal(sim.freeSeats, 7);
  assert.equal(sim.playerBySession('session-abc').id, me.id);
});

test('a match holds exactly 8 humans and then reports full', () => {
  const sim = new Simulation({ logger: quiet });
  const claimed = [];
  for (let i = 0; i < 8; i++) claimed.push(sim.claimSeat(`s${i}`, `P${i}`));

  assert.equal(claimed.every(Boolean), true, 'all 8 seats should be claimable');
  assert.equal(new Set(claimed.map(p => p.id)).size, 8, 'two players got the same seat');
  assert.equal(sim.freeSeats, 0);
  assert.equal(sim.claimSeat('s8', 'Late'), null, 'a 9th player should be refused');
});

test('leaving hands the base back to the AI, it is not destroyed', () => {
  // A disconnected player's base must keep playing: their allies are not
  // abandoned, and their enemies do not get a free kill.
  const sim = new Simulation({ logger: quiet });
  const me = sim.claimSeat('sess', 'Chirag');
  const baseHp = me.base.hp;

  sim.releaseSeat('sess');

  const after = sim.state.players.get(me.id);
  assert.equal(after.isBot, true, 'the AI should have taken over');
  assert.equal(after.sessionId, null);
  assert.equal(after.alive, true, 'the base must survive a disconnect');
  assert.equal(after.base.hp, baseHp, 'the base should be untouched');
  assert.equal(sim.freeSeats, 8, 'the seat should be available again');
});

test('an AI-taken-over base keeps playing', () => {
  const sim = new Simulation({ logger: quiet });
  const me = sim.claimSeat('sess', 'Chirag');
  sim.releaseSeat('sess');

  const goldBefore = me.base.gold;
  for (let i = 0; i < 1200; i++) sim.step(TICK_MS);   // one minute

  assert.equal(sim.errorCount, 0);
  assert.notEqual(me.base.gold, goldBefore, 'the abandoned base stopped earning');
  assert.ok(me.base.soldierQueue.length > 0 || sim.state.soldierCount(me.id) > 1,
    'the AI should be building something');
});

test('joining seats you away from the strongest player', () => {
  // Landing next to a runaway leader is close to an instant loss, and a
  // miserable first impression for someone who just clicked Play.
  const sim = new Simulation({ logger: quiet });

  const strong = sim.state.players.get('p0');
  strong.base.xpEarned = 999999;

  const me = sim.claimSeat('sess', 'Late');
  assert.notEqual(me.id, 'p0', 'should never be seated as the leader themselves');

  const d = (a, b) => Math.hypot(a.base.position.x - b.base.position.x, a.base.position.y - b.base.position.y);
  const mine = d(me, strong);
  for (const [, p] of sim.state.players) {
    if (p.id === me.id || p.id === 'p0' || !p.isBot) continue;
    assert.ok(mine >= d(p, strong) - 1, `seated closer to the leader than ${p.id}`);
  }
});

test('a claimed seat is no longer driven by the AI', () => {
  const sim = new Simulation({ logger: quiet });
  const me = sim.claimSeat('sess', 'Chirag');
  const aBot = [...sim.state.players.values()].find(p => p.isBot);

  run(sim, 60);

  // The AI keeps its seats busy building. A human seat must build NOTHING it
  // wasn't told to — otherwise your base would spend your gold on units you
  // never ordered.
  // `> STARTING_GARRISON`, not `> 0`: every base now opens with a garrison, so
  // `garrison > 0` was true at tick zero and the assertion stopped meaning
  // anything the moment that constant was introduced.
  assert.ok(aBot.base.soldierQueue.length > 0 || aBot.base.garrison > STARTING_GARRISON || sim.state.soldierCount(aBot.id) > 0,
    'the AI should have been building on its own seats');
  assert.equal(me.base.soldierQueue.length, 0,
    'the AI queued units on a human-controlled seat');
  assert.equal(sim.state.soldierCount(me.id), 0,
    'a human seat gained soldiers it never ordered');
});

test('GOLDEN TEST: 5 minutes of play produces no errors and no corrupt state', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  run(sim, 300);

  assert.equal(sim.errorCount, 0, 'the simulation threw during a normal match');

  // Nothing should have escaped the map or gone non-numeric.
  for (const [, s] of sim.state.soldiers) {
    assert.ok(Number.isFinite(s.position.x) && Number.isFinite(s.position.y),
      `soldier ${s.id} has a non-finite position`);
    assert.ok(s.position.x >= -1 && s.position.x <= WORLD_SIZE + 1, 'soldier left the map in x');
    assert.ok(s.position.y >= -1 && s.position.y <= WORLD_SIZE + 1, 'soldier left the map in y');
    assert.ok(s.hp > 0, 'a dead soldier was left in the map');
  }

  for (const [, p] of sim.state.players) {
    assert.ok(Number.isFinite(p.base.gold) && p.base.gold >= 0, 'gold went negative or NaN');
    assert.ok(p.base.hp >= 0 && p.base.hp <= p.base.maxHp, 'base HP out of range');
    assert.ok(p.base.level >= 1 && p.base.level <= 20, 'base level out of range');
  }

  // Every squad's members must actually exist — a dangling id would crash the renderer.
  for (const [, g] of sim.state.groups) {
    for (const mid of g.memberIds) {
      assert.ok(sim.state.soldiers.has(mid), `squad ${g.id} references missing soldier ${mid}`);
    }
  }
});

test('entity ids stay small over a long match (2-byte network field)', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  run(sim, 600);   // a full 10-minute match

  const { highWaterId, liveIds } = sim.stats();
  assert.ok(highWaterId <= 65535,
    `ids must fit in 2 bytes but reached ${highWaterId} — recycling is not working`);
  assert.ok(liveIds < 5000, `unexpectedly many live entities: ${liveIds}`);
});

test('the game actually progresses — bots build armies and earn gold', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  const goldBefore = [...sim.state.players.values()].map(p => p.base.gold);
  run(sim, 120);

  assert.ok(sim.state.soldiers.size > 8, 'no soldiers were produced in two minutes');
  const levelled = [...sim.state.players.values()].some(p => p.base.level > 1);
  assert.ok(levelled, 'nobody gained a level in two minutes');
  const earned = [...sim.state.players.values()].some((p, i) => p.base.gold !== goldBefore[i]);
  assert.ok(earned, 'no gold income happened');
});

test('all three modes run without throwing', () => {
  for (const mode of ['ffa', 'team', 'mining']) {
    const sim = new Simulation({ mode, logger: quiet });
    run(sim, 60);
    assert.equal(sim.errorCount, 0, `mode '${mode}' threw during simulation`);
  }
});

test('snapshots are plain data — safe to send across a thread or network', () => {
  const sim = new Simulation({ mode: 'mining', logger: quiet });
  run(sim, 30);
  const snap = sim.getSnapshot();

  // structuredClone fails on class instances, Maps with methods, functions —
  // exactly the things that must not leak into a snapshot.
  assert.doesNotThrow(() => structuredClone(snap), 'snapshot is not cloneable');

  assert.equal(snap.players.length, 8);
  assert.ok(Array.isArray(snap.soldiers));
  assert.ok(Array.isArray(snap.players[0].base.unlocked), 'Set must be converted to an array');
  assert.equal(typeof snap.tick, 'number');
});

// ── Commands: the only legal way to change the game ──────────────────────────

test('rejects commands from unknown or eliminated players', () => {
  const sim = new Simulation({ logger: quiet });
  assert.equal(sim.applyCommand('nobody', { t: 'mine' }).ok, false);

  const bot = sim.state.players.get('p1');
  bot.alive = false;
  assert.equal(sim.applyCommand('p1', { t: 'mine' }).ok, false);
});

test('rejects malformed and unknown commands', () => {
  const sim = new Simulation({ logger: quiet });
  assert.equal(sim.applyCommand('p0', null).ok, false);
  assert.equal(sim.applyCommand('p0', {}).ok, false);
  assert.equal(sim.applyCommand('p0', { t: 'selfDestructEveryone' }).ok, false);
});

test('you cannot command another player\'s squads', () => {
  const sim = new Simulation({ logger: quiet });

  // Give a bot a squad deterministically rather than waiting for one. Bots
  // stockpile soldiers in the garrison and only field them once it's full, so
  // "just run for 60s" is not reliable — and only the human starts with a grunt.
  const bot = sim.state.players.get('p1');
  bot.base.garrison = 15;
  assert.equal(sim.applyCommand('p1', { t: 'release' }).ok, true);

  const botGroup = [...sim.state.groups.values()].find(g => g.ownerId === 'p1');
  assert.ok(botGroup, 'releasing the garrison should have created a squad');

  const before = { ...botGroup.anchor };
  const res = sim.applyCommand('p0', { t: 'move', g: [botGroup.id], x: 10, y: 10 });

  assert.equal(res.ok, false, 'a player was allowed to move an enemy squad');
  assert.deepEqual(botGroup.anchor, before, 'the enemy squad moved anyway');
});

test('you cannot buy what you cannot afford', () => {
  const sim = new Simulation({ logger: quiet });
  const base = sim.state.players.get('p0').base;
  base.gold = 0;

  const res = sim.applyCommand('p0', { t: 'mine' });
  assert.equal(res.ok, false);
  assert.equal(base.gold, 0, 'gold changed despite the purchase failing');
  assert.equal(base.mineLevel, 0, 'upgrade was applied despite being unaffordable');
});

test('you cannot spend skill points you do not have', () => {
  const sim = new Simulation({ logger: quiet });
  const player = sim.state.players.get('p0');
  player.base.skillPoints = 0;

  assert.equal(sim.applyCommand('p0', { t: 'skill', stat: 'atk' }).ok, false);
  assert.equal(player.buffs.atk, 0, 'a buff was applied without paying for it');

  player.base.skillPoints = 1;
  assert.equal(sim.applyCommand('p0', { t: 'skill', stat: 'atk' }).ok, true);
  assert.equal(player.buffs.atk, 1);
  assert.equal(player.base.skillPoints, 0);
});

test('queueing a unit adds to the right queue and respects unlocks', () => {
  const sim = new Simulation({ logger: quiet });
  const base = sim.state.players.get('p0').base;

  assert.equal(sim.applyCommand('p0', { t: 'queue', unit: 'grunt', n: 1 }).ok, true);
  assert.equal(base.soldierQueue.length, 1);

  // The Defender builds walls, so it goes to the parallel wall queue.
  assert.equal(sim.applyCommand('p0', { t: 'queue', unit: 'sentinel', n: 1 }).ok, true);
  assert.equal(base.wallQueue.length, 1);

  // Vanguard unlocks at level 20 — not available at level 1.
  assert.equal(sim.applyCommand('p0', { t: 'queue', unit: 'vanguard', n: 1 }).ok, false);
  assert.equal(sim.applyCommand('p0', { t: 'queue', unit: 'nonsense', n: 1 }).ok, false);
});

test('move orders are clamped inside the map', () => {
  const sim = new Simulation({ logger: quiet });
  // Nobody starts with soldiers now, so field a squad first.
  sim.state.players.get('p0').base.garrison = 15;
  sim.applyCommand('p0', { t: 'release' });
  run(sim, 5);

  const mine = [...sim.state.groups.values()].filter(g => g.ownerId === 'p0');
  assert.ok(mine.length, 'player should have a squad');

  // Deployment requires a full 15-strong squad, so this may legitimately be
  // refused — what matters is that a wild coordinate never lands out of bounds.
  sim.applyCommand('p0', { t: 'move', g: mine.map(g => g.id), x: 999999, y: -999999 });
  for (const g of mine) {
    assert.ok(g.anchor.x >= 0 && g.anchor.x <= WORLD_SIZE, 'anchor escaped the map in x');
    assert.ok(g.anchor.y >= 0 && g.anchor.y <= WORLD_SIZE, 'anchor escaped the map in y');
  }
});

test('donate is refused outside team mode', () => {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  sim.state.players.get('p0').base.garrison = 15;
  sim.applyCommand('p0', { t: 'release' });
  const g = [...sim.state.groups.values()].find(x => x.ownerId === 'p0');
  assert.equal(sim.applyCommand('p0', { t: 'donate', g: g.id, to: 'p1' }).ok, false);
});

test('a thrown error is counted and reported, never silently swallowed', () => {
  const sim = new Simulation({ logger: quiet });
  // Corrupt the state in a way the systems cannot survive.
  sim.state.players.get('p1').base = null;
  sim.step(TICK_MS);

  assert.ok(sim.errorCount > 0, 'the error was swallowed instead of counted');
  const events = sim.drainEvents();
  assert.ok(events.some(e => e.type === 'simError'), 'no simError event was raised');
});
