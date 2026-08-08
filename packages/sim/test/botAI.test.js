import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, TICK_MS } from '../Simulation.js';
import { AISystem } from '../systems/AISystem.js';
import {
  GROUP_MAX_SIZE, BOT_THINK_RATE,
  DEFENDER_EDGE, DEFENDER_ATK_MULT, DEFENDER_DMG_TAKEN,
  BOSS_DEFENDER_EDGE, BOSS_DEFENDER_ATK_MULT, BOSS_DEFENDER_DMG_TAKEN,
} from '../constants.js';

const quiet = { error: () => {}, warn: () => {}, log: () => {} };

/**
 * Bots must weigh staying home against attacking.
 *
 * The old brain committed every full squad to the nearest enemy base
 * unconditionally — so a bot with one squad would throw it at an enemy with
 * three, and a bot being attacked would march its defenders away. These tests
 * pin down the behaviour that replaced it.
 */

/** Give a player N full squads, bypassing the slow production path. */
function giveSquads(sim, ownerId, count) {
  const base = sim.state.players.get(ownerId).base;
  const made = [];
  for (let i = 0; i < count; i++) {
    base.garrison = GROUP_MAX_SIZE;
    const g = sim.applyCommand(ownerId, { t: 'release' });
    assert.equal(g.ok, true, 'garrison release should succeed');
    made.push([...sim.state.groups.values()].filter(x => x.ownerId === ownerId).at(-1));
  }
  return made;
}

/** Park `count` of `ownerId`'s soldiers right next to `targetId`'s base. */
function siege(sim, ownerId, targetId, count) {
  const target = sim.state.players.get(targetId).base;
  giveSquads(sim, ownerId, Math.ceil(count / GROUP_MAX_SIZE));
  let moved = 0;
  for (const [, s] of sim.state.soldiers) {
    if (s.ownerId !== ownerId || moved >= count) continue;
    s.position.x = target.position.x + 30 + (moved % 5) * 6;
    s.position.y = target.position.y + 30;
    moved++;
  }
  sim.state.grid.rebuild(sim.state.soldiers.values());
  return moved;
}

/** Force every bot to think right now. */
function think(sim) {
  new AISystem().update(sim.state, BOT_THINK_RATE + 5000);
}

const attackingSquads = (sim, ownerId) =>
  [...sim.state.groups.values()].filter(g => g.ownerId === ownerId && g.status === 'attacking');

const defendingSquads = (sim, ownerId) =>
  [...sim.state.groups.values()].filter(g => g.ownerId === ownerId && g.status === 'defending');

// ── The owner's exact scenario ───────────────────────────────────────────────

test('a bot with ONE squad does not attack an enemy who has THREE', () => {
  const sim = new Simulation({ logger: quiet });

  giveSquads(sim, 'p0', 1);   // the bot
  giveSquads(sim, 'p4', 3);   // a much stronger rival
  sim.state.grid.rebuild(sim.state.soldiers.values());

  // Let patience elapse so we are testing the force budget, not the delay.
  for (let i = 0; i < 12; i++) think(sim);

  assert.equal(attackingSquads(sim, 'p0').length, 0,
    'the bot threw its only squad at a stronger enemy');
  assert.ok(defendingSquads(sim, 'p0').length >= 1,
    'the bot should be holding its squad at home instead');
});

test('a bot WITH a real advantage does attack', () => {
  // The mirror image. A bot that never attacks is as broken as one that always
  // does, and matches have to resolve.
  const sim = new Simulation({ logger: quiet });

  giveSquads(sim, 'p0', 6);   // overwhelming
  giveSquads(sim, 'p4', 1);
  sim.state.grid.rebuild(sim.state.soldiers.values());

  for (let i = 0; i < 12; i++) think(sim);

  assert.ok(attackingSquads(sim, 'p0').length >= 1,
    'a bot with a big surplus should commit to an attack');
});

// ── Under attack ─────────────────────────────────────────────────────────────

test('a bot under attack does not send squads away', () => {
  const sim = new Simulation({ logger: quiet });

  giveSquads(sim, 'p0', 3);
  siege(sim, 'p4', 'p0', 30);              // 30 enemies at p0's door
  sim.state.players.get('p0').base.lastAttackedAt = sim.state.time;

  for (let i = 0; i < 12; i++) think(sim);

  assert.equal(attackingSquads(sim, 'p0').length, 0,
    'a besieged bot marched its defenders away');
  assert.ok(defendingSquads(sim, 'p0').length >= 1,
    'a besieged bot should mass at home');
});

test('squads already committed are not falsely re-tasked when danger appears', () => {
  // Attacking squads are LOCKED by the game rules. The AI must recognise it
  // cannot recall them rather than silently issuing orders that do nothing.
  const sim = new Simulation({ logger: quiet });

  giveSquads(sim, 'p0', 6);
  giveSquads(sim, 'p4', 1);
  sim.state.grid.rebuild(sim.state.soldiers.values());
  for (let i = 0; i < 12; i++) think(sim);

  const committed = attackingSquads(sim, 'p0');
  assert.ok(committed.length >= 1, 'expected a committed squad to test with');
  assert.ok(committed.every(g => g.locked), 'attacking squads must be locked');

  // Now threaten home. The locked squads must stay locked and on target.
  siege(sim, 'p5', 'p0', 30);
  sim.state.players.get('p0').base.lastAttackedAt = sim.state.time;
  think(sim);

  for (const g of committed) {
    assert.equal(g.locked, true, 'a committed squad was somehow unlocked');
    assert.equal(g.status, 'attacking', 'a committed squad was re-tasked, which is impossible');
  }
});

// ── Anti-exploit ─────────────────────────────────────────────────────────────

test('a single scout cannot freeze a bot forever', () => {
  // The obvious failure mode of "defend when threatened": park one cheap
  // soldier outside a bot's base and it turtles for the rest of the match.
  // Threat is measured as FORCE, so one grunt barely moves the budget.
  const sim = new Simulation({ logger: quiet });

  giveSquads(sim, 'p0', 6);
  giveSquads(sim, 'p4', 1);
  siege(sim, 'p5', 'p0', 1);               // exactly one lone scout
  sim.state.grid.rebuild(sim.state.soldiers.values());

  for (let i = 0; i < 20; i++) think(sim);

  assert.ok(attackingSquads(sim, 'p0').length >= 1,
    'one enemy soldier was enough to suppress a bot with six squads');
});

test('eight bots do not stalemate — matches actually resolve', () => {
  // The game-health check. Cautious bots are good; eight bots staring at each
  // other until the twenty-minute timer is not.
  //
  // This runs the REAL simulation rather than poking the AI directly, because
  // production is part of the answer: armies grow at different rates, someone
  // pulls ahead, and the force budget then lets them commit.
  const sim = new Simulation({ mode: 'ffa', logger: quiet });

  let sawAttack = false;
  let sawKill = false;
  for (let i = 0; i < (900 * 1000) / TICK_MS; i++) {   // 15 minutes
    sim.step(TICK_MS);
    if (!sawAttack) {
      sawAttack = [...sim.state.groups.values()].some(g => g.status === 'attacking');
    }
    if (!sawKill) {
      sawKill = [...sim.state.players.values()].some(p => !p.alive);
    }
    if (sawKill) break;
  }

  assert.ok(sawAttack, 'no bot committed to an attack in fifteen minutes');
  assert.ok(sawKill, 'no base fell in fifteen minutes — bots are turtling');
  assert.equal(sim.errorCount, 0);
});

test('bots do not read hidden enemy garrisons', () => {
  // Garrisoned soldiers are invisible to human players. A bot that could see
  // them would be cheating, so a huge hidden garrison must not deter it.
  const sim = new Simulation({ logger: quiet });

  giveSquads(sim, 'p0', 6);
  const victim = sim.state.players.get('p4');
  victim.base.garrison = 15;               // invisible to everyone
  sim.state.grid.rebuild(sim.state.soldiers.values());

  for (let i = 0; i < 12; i++) think(sim);

  assert.ok(attackingSquads(sim, 'p0').length >= 1,
    'the bot avoided a target based on a garrison it should not be able to see');
});

// ── The defender advantage ───────────────────────────────────────────────────

test('players get no defender bonus; the boss keeps its own', () => {
  // The stance advantage was removed for PLAYERS: an equal defending force used
  // to beat an attacking one automatically, which made sitting still the
  // correct play and stopped matches resolving. Attacking is now settled by
  // numbers, positioning and walls — things a player can actually see and act
  // on — rather than a hidden multiplier.
  assert.equal(DEFENDER_ATK_MULT, 1, 'players must not hit harder for defending');
  assert.equal(DEFENDER_DMG_TAKEN, 1, 'players must not take less for defending');
  assert.equal(DEFENDER_EDGE, 1, 'a defender is worth exactly one attacker');

  // The boss's guards are a separate, deliberately unfair objective, and
  // removing the player bonus must not have quietly nerfed them.
  assert.ok(BOSS_DEFENDER_EDGE > 1.2 && BOSS_DEFENDER_EDGE < 1.6,
    `BOSS_DEFENDER_EDGE is ${BOSS_DEFENDER_EDGE.toFixed(3)} — the boss should still favour defence`);

  // Both are still DERIVED, so retuning either pair keeps the bots' arithmetic
  // in step instead of silently going stale.
  assert.equal(DEFENDER_EDGE, DEFENDER_ATK_MULT / DEFENDER_DMG_TAKEN);
  assert.equal(BOSS_DEFENDER_EDGE, BOSS_DEFENDER_ATK_MULT / BOSS_DEFENDER_DMG_TAKEN);
});

/**
 * Reduce a match to a duel, so target choice is unambiguous.
 * Otherwise a bot will quite correctly ignore the target under test and go for
 * whichever of the other six bots is softest.
 */
function duel(sim, a, b) {
  for (const [, p] of sim.state.players) {
    if (p.id === a || p.id === b) continue;
    p.alive = false;
  }
  for (const [id, s] of sim.state.soldiers) {
    if (s.ownerId !== a && s.ownerId !== b) { sim.state.soldiers.delete(id); }
  }
  sim.state.grid.rebuild(sim.state.soldiers.values());
}

test('a bot needs a bigger force to attack a well-defended base than a bare one', () => {
  // Same attacker, two different opponents: the defended one should be refused
  // while the undefended one is taken.
  const defended = new Simulation({ logger: quiet });
  giveSquads(defended, 'p0', 3);
  giveSquads(defended, 'p4', 5);           // massed on their own base
  duel(defended, 'p0', 'p4');
  for (let i = 0; i < 12; i++) think(defended);

  const bare = new Simulation({ logger: quiet });
  giveSquads(bare, 'p0', 3);
  duel(bare, 'p0', 'p4');                  // p4 left with nothing
  for (let i = 0; i < 12; i++) think(bare);

  assert.equal(attackingSquads(defended, 'p0').length, 0,
    'attacked into a defence far larger than the force it could spare');
  assert.ok(attackingSquads(bare, 'p0').length >= 1,
    'refused an undefended target it could clearly take');
});

// ── Robustness ───────────────────────────────────────────────────────────────

test('bots survive a long match without throwing', () => {
  const sim = new Simulation({ logger: quiet });
  for (let i = 0; i < (900 * 1000) / TICK_MS; i++) sim.step(TICK_MS);
  assert.equal(sim.errorCount, 0, 'the new AI threw during a full match');
});

test('all three modes run with the new AI', () => {
  for (const mode of ['ffa', 'team', 'mining']) {
    const sim = new Simulation({ mode, logger: quiet });
    for (let i = 0; i < (240 * 1000) / TICK_MS; i++) sim.step(TICK_MS);
    assert.equal(sim.errorCount, 0, `mode '${mode}' threw`);
  }
});

test('a bot taking over a disconnected human base behaves sanely', () => {
  const sim = new Simulation({ logger: quiet });
  const me = sim.claimSeat('sess', 'Human');
  giveSquads(sim, me.id, 2);
  sim.releaseSeat('sess');                 // AI takes over mid-match

  for (let i = 0; i < 400; i++) sim.step(TICK_MS);
  assert.equal(sim.errorCount, 0);
  assert.equal(sim.state.players.get(me.id).isBot, true);
});
