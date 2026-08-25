import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, TICK_MS } from '../Simulation.js';
import { AISystem } from '../systems/AISystem.js';
import { Soldier, Group } from '../entities.js';

const quiet = { error: () => {}, warn: () => {}, log: () => {} };

/**
 * The bait: letting two rivals fight each other.
 *
 * When two mutually-hostile armies converge on one base, meeting them means
 * absorbing both at full strength. Stepping aside costs base HP and buys a
 * better fight — they collide, and the survivor arrives already mauled.
 *
 * It is a gamble, so the value of these tests is mostly in what the bot
 * REFUSES to do. A bot that baits whenever it is losing would simply be a bot
 * that abandons its base.
 */

const ai = new AISystem();

function world() {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  for (const [, p] of sim.state.players) p.isBot = true;
  return sim;
}

/** Drop a formed squad of `n` for `owner` at (x, y). */
function squad(st, owner, n, x, y) {
  const g = new Group(st.newId(), owner, x, y);
  for (let i = 0; i < n; i++) {
    const s = new Soldier(st.newId(), owner, 'grunt', x + (i % 4) * 5, y + Math.floor(i / 4) * 5);
    st.soldiers.set(s.id, s);
    s.groupId = g.id;
    g.memberIds.push(s.id);
  }
  g.formed = true;
  st.groups.set(g.id, g);
  return g;
}

/** Settle the grid, then read the bot's assessment of its own position. */
function assess(sim, me) {
  for (let i = 0; i < 3; i++) sim.step(TICK_MS);
  return ai._assess(sim.state, me, 'standard', ai._census(sim.state));
}

test('two rival armies converging on one base is recognised as a bait chance', () => {
  const sim = world();
  const me = sim.state.players.get('p0');
  const { x, y } = me.base.position;

  squad(sim.state, 'p0', 12, x + 30, y);     // my defence — outnumbered
  squad(sim.state, 'p1', 20, x + 300, y);    // rival A
  squad(sim.state, 'p2', 20, x - 300, y);    // rival B, hostile to A as well as me

  const view = assess(sim, me);
  assert.ok(view.rivalFactions >= 2, 'two mutually hostile factions should be seen');
  assert.ok(ai._shouldBait(sim.state, me, view),
    `should step aside (incoming ${view.totalIncoming} vs mine ${view.available})`);
});

test('ONE army is never baited — there is nobody for it to fight', () => {
  // The whole mechanism depends on the attackers fighting EACH OTHER. Against a
  // single enemy, withdrawing just hands over the base.
  const sim = world();
  const me = sim.state.players.get('p0');
  const { x, y } = me.base.position;

  squad(sim.state, 'p0', 12, x + 30, y);
  squad(sim.state, 'p1', 40, x + 300, y);    // overwhelming, but alone

  const view = assess(sim, me);
  assert.ok(!ai._shouldBait(sim.state, me, view),
    'withdrew from a single enemy, which just concedes the base');
});

test('a winnable defence is never given up', () => {
  // A base ringed by its own soldiers takes no damage at all. Trading that for
  // a gamble you did not need is strictly worse.
  const sim = world();
  const me = sim.state.players.get('p0');
  const { x, y } = me.base.position;

  squad(sim.state, 'p0', 60, x + 30, y);     // overwhelming defence
  squad(sim.state, 'p1', 6, x + 300, y);
  squad(sim.state, 'p2', 6, x - 300, y);

  const view = assess(sim, me);
  assert.ok(!ai._shouldBait(sim.state, me, view), 'gave up a fight it was winning');
});

test('a badly damaged base does not gamble', () => {
  // The plan involves taking hits while you wait. A base near death cannot
  // afford any, so the bait becomes a slower way of losing.
  const sim = world();
  const me = sim.state.players.get('p0');
  me.base.hp = me.base.maxHp * 0.2;
  const { x, y } = me.base.position;

  squad(sim.state, 'p0', 12, x + 30, y);
  squad(sim.state, 'p1', 20, x + 300, y);
  squad(sim.state, 'p2', 20, x - 300, y);

  const view = assess(sim, me);
  assert.ok(!ai._shouldBait(sim.state, me, view), 'baited with a base about to fall');
});

test('withdrawing moves AWAY from the attackers, not through them', () => {
  // Retreating into an incoming army is not a retreat.
  const sim = world();
  const me = sim.state.players.get('p0');
  const { x, y } = me.base.position;

  const mine = squad(sim.state, 'p0', 12, x + 30, y);
  squad(sim.state, 'p1', 20, x + 320, y);    // both threats to the RIGHT
  squad(sim.state, 'p2', 20, x + 300, y + 60);

  const view = assess(sim, me);
  ai._withdraw(sim.state, me, view, [mine]);

  assert.ok(mine.anchor.x < x, `withdrew toward the threat (anchor ${mine.anchor.x} vs base ${x})`);
});

test('bots still resolve matches with the bait available', () => {
  // A tactic that makes every bot turtle would be worse than no tactic. This is
  // a smoke test that the behaviour does not deadlock a whole match.
  const sim = world();
  let errors = 0;
  const s = new Simulation({ mode: 'ffa', logger: { error: () => errors++, warn: () => {} } });
  for (const [, p] of s.state.players) p.isBot = true;
  for (let i = 0; i < (10 * 60 * 1000) / TICK_MS; i++) s.step(TICK_MS);

  assert.equal(errors, 0, 'the bait logic threw during a full match');
  const dead = [...s.state.players.values()].filter(p => !p.alive).length;
  assert.ok(dead > 0, 'ten minutes passed with nobody eliminated — bots are turtling');
});
