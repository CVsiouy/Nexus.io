import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, TICK_MS } from '../Simulation.js';
import { Soldier, Group } from '../entities.js';
import { setDefendNode } from '../systems/GroupSystem.js';
import { goldRate } from '../systems/ProgressionSystem.js';
import { addWallCell } from '../walls.js';
import {
  MINE_NODE_GOLD, MINE_CAPTURE_RANGE, BOT_MINE_TARGET, GARRISON_MAX,
  WALL_CELLS_BASE, WALL_BODY_HP, GROUP_MAX_SIZE, BOT_ATTACK_EDGE, BOT_MINE_SOLO_RADIUS,
} from '../constants.js';

const quiet = { error: () => {}, warn: () => {}, log: () => {} };

/**
 * Mining mode
 * ───────────
 * A node used to do two extra things: pay MORE gold the more soldiers you
 * parked on it, and periodically spawn free soldiers of its own. Both rewarded
 * sitting still — the more you camped, the more you got for camping, and a bot
 * that grabbed three nodes early could out-produce everyone without ever
 * fighting. A node is now flat income you have to *hold*, and nothing more.
 *
 * These tests pin that down, and pin down the bot behaviour that follows from
 * it, because nothing in the suite covered mining mode's rules at all before.
 */

/** Spawn a formed squad of `n` soldiers for `ownerId` centred on (x, y). */
function squadAt(sim, ownerId, n, x, y) {
  const st = sim.state;
  const g = new Group(st.newId(), ownerId, x, y);
  for (let i = 0; i < n; i++) {
    const s = new Soldier(st.newId(), ownerId, 'grunt',
      x + (i % 4) * 5, y + Math.floor(i / 4) * 5);
    st.soldiers.set(s.id, s);
    s.groupId = g.id;
    g.memberIds.push(s.id);
  }
  g.formed = true;
  st.groups.set(g.id, g);
  return g;
}

/**
 * Park a squad ON a node and keep it there.
 *
 * setDefendNode matters: a squad left in the default 'defending' state walks
 * back to its base, so it drifts out of capture range after a second or two and
 * the node never flips. Holding a node is an explicit order, in the test as in
 * the game.
 */
function occupy(sim, node, ownerId, n) {
  const g = squadAt(sim, ownerId, n, node.position.x, node.position.y);
  setDefendNode(g, node);
  return g;
}

const firstNode = (sim) => [...sim.state.mineNodes.values()][0];

test('a held node pays a flat rate, no matter how big the army sitting on it', () => {
  // Two identical worlds. The only difference is squad size on the node.
  const earned = [];
  for (const crowd of [1, 12]) {
    const sim = new Simulation({ mode: 'mining', logger: quiet });
    const node = firstNode(sim);
    const owner = sim.state.players.get('p0');
    owner.isBot = false;                 // a bot would spend the gold we mean to count
    occupy(sim, node, 'p0', crowd);

    // Let the capture finish.
    for (let i = 0; i < 200; i++) sim.step(TICK_MS);
    assert.equal(node.ownerId, 'p0', `${crowd} soldiers should have captured the node`);

    assert.equal(node.goldRate, MINE_NODE_GOLD,
      `a node must report exactly ${MINE_NODE_GOLD}/sec with ${crowd} soldiers on it`);

    // Measure over 10 seconds with nothing else touching the purse.
    const SECONDS = 10;
    owner.base.gold = 0;
    let baseIncome = 0;
    for (let i = 0; i < (SECONDS * 1000) / TICK_MS; i++) {
      owner.base.soldierQueue.length = 0;         // nothing gets spent
      sim.step(TICK_MS);
      baseIncome += goldRate(owner.base) * (TICK_MS / 1000);
    }

    // Total minus what the base itself produced is the node's contribution.
    const fromNode = owner.base.gold - baseIncome;
    assert.ok(fromNode > 0, 'the node should actually be paying');
    earned.push(fromNode / SECONDS);
  }

  for (const rate of earned) {
    assert.ok(Math.abs(rate - MINE_NODE_GOLD) < 0.15,
      `a node must pay ~${MINE_NODE_GOLD}/sec, measured ${rate.toFixed(3)}`);
  }
  assert.ok(Math.abs(earned[0] - earned[1]) < 0.1,
    `twelve soldiers on a node must earn what one earns — camping is not an economy ` +
    `(${earned[0].toFixed(3)} vs ${earned[1].toFixed(3)})`);
});

test('nodes never spawn soldiers of their own', () => {
  const sim = new Simulation({ mode: 'mining', logger: quiet });
  const node = firstNode(sim);
  occupy(sim, node, 'p0', 2);

  // Hold it for four minutes — far longer than the old spawn interval.
  for (let i = 0; i < 200; i++) sim.step(TICK_MS);
  assert.equal(node.ownerId, 'p0');

  const owned = () => [...sim.state.soldiers.values()]
    .filter(s => s.ownerId === 'p0' && s.hp > 0).length;
  const before = owned();

  // Stop the base producing so any growth can only have come from the node.
  const base = sim.state.players.get('p0').base;
  for (let i = 0; i < (240 * 1000) / TICK_MS; i++) {
    base.soldierQueue.length = 0;
    base.gold = 0;
    sim.step(TICK_MS);
  }

  assert.ok(owned() <= before,
    `holding a node for 4 minutes must not manufacture soldiers (${before} -> ${owned()})`);
  assert.equal(sim.errorCount, 0);
});

test('a node is released when its owner dies', () => {
  const sim = new Simulation({ mode: 'mining', logger: quiet });
  const node = firstNode(sim);
  occupy(sim, node, 'p0', 2);
  for (let i = 0; i < 200; i++) sim.step(TICK_MS);
  assert.equal(node.ownerId, 'p0');

  const victim = sim.state.players.get('p0');
  victim.alive = false;
  victim.base.hp = 0;
  sim.step(TICK_MS);

  assert.equal(node.ownerId, null, 'a dead player must not keep earning from a node');
  assert.equal(node.goldRate, 0);
});

test('bots take nodes but do not hoard them, and still go for kills', () => {
  const sim = new Simulation({ mode: 'mining', logger: quiet });
  for (const [, p] of sim.state.players) p.isBot = true;

  let assaults = 0;
  let peakForOne = 0;
  let peakSquadsMining = 0;
  let peakDoubleBooked = 0;

  for (let i = 0; i < (8 * 60 * 1000) / TICK_MS; i++) {
    sim.step(TICK_MS);

    for (const [, g] of sim.state.groups) {
      if (g.status === 'attacking' && g.targetId && !g._seen) { g._seen = true; assaults++; }
      if (g.status !== 'attacking') g._seen = false;
    }
    const per = new Map();
    for (const [, n] of sim.state.mineNodes) {
      if (n.ownerId) per.set(n.ownerId, (per.get(n.ownerId) ?? 0) + 1);
    }
    for (const v of per.values()) peakForOne = Math.max(peakForOne, v);

    // How much of one bot's army is tied up mining, and whether any two of its
    // squads were ever sent to the same node.
    const mining = new Map();
    for (const [, g] of sim.state.groups) {
      if (!g.defendNodeId) continue;
      const seen = mining.get(g.ownerId) ?? [];
      seen.push(g.defendNodeId);
      mining.set(g.ownerId, seen);
    }
    for (const nodes of mining.values()) {
      peakSquadsMining = Math.max(peakSquadsMining, nodes.length);
      peakDoubleBooked = Math.max(peakDoubleBooked, nodes.length - new Set(nodes).size);
    }
  }

  const held = [...sim.state.mineNodes.values()].filter(n => n.ownerId).length;

  assert.ok(held > 0, 'bots must actually capture nodes in mining mode');

  // BOT_MINE_TARGET caps COMMITMENT — squads deliberately assigned to nodes —
  // not ownership. Ownership can legitimately run higher, because a squad
  // marching past a node captures it incidentally: MiningSystem counts every
  // soldier in range whatever its orders are, and that applies to human players
  // just the same. Asserting on ownership here would be asserting on luck.
  assert.ok(peakSquadsMining <= BOT_MINE_TARGET,
    `a bot must never tie up more than ${BOT_MINE_TARGET} squads mining, saw ${peakSquadsMining}`);
  assert.equal(peakDoubleBooked, 0,
    'two squads from the same bot must never be sent to the same node');
  void peakForOne;
  // The regression this guards: the old mining brain flipped a coin and
  // RETURNED, so it never reached target evaluation and bots simply shoved
  // each other off nodes for twenty minutes without attacking anyone.
  // Threshold chosen from the measured distribution, not picked by feel.
  //
  // Over 12 runs of this exact scenario the count ranged 8..25, so the previous
  // `> 10` clipped the lower tail and failed roughly one run in twelve — a
  // flaky test, which is worse than no test because it teaches you to ignore
  // red. The regression this guards against (the old mining brain flipped a
  // coin and RETURNED, so bots never reached target evaluation at all)
  // produced approximately ZERO assaults, so 4 still catches it outright while
  // sitting at half the observed minimum.
  assert.ok(assaults > 4,
    `bots must still attack bases in mining mode, saw only ${assaults} assaults`);
  assert.equal(sim.errorCount, 0);
});

/**
 * Run exactly one bot decision against a hand-built position.
 *
 * The two tests below are about a single branch, so they drive the AI directly
 * instead of stepping a live match. Stepping the match brings in the garrison
 * releasing into an extra squad, production, movement and think-timer jitter —
 * all of which change the very thing under test (how many squads are on the
 * map), so a full-sim version of these ends up either flaky or vacuous.
 */
function decideOnce(sim, botId, squadSizes, { attackableRivals = false } = {}) {
  const st = sim.state;
  const bot = st.players.get(botId);
  bot.isBot = true;

  // Mining is what a bot does when it cannot usefully ATTACK, so unless a test
  // wants a rival on the menu, take them off it. Bosses too — a boss is a
  // target like any other and would otherwise soak up the decision.
  if (!attackableRivals) {
    for (const [, p] of st.players) if (p.id !== botId) p.alive = false;
    st.bosses.clear();
  }

  const groups = squadSizes.map((n, i) =>
    squadAt(sim, botId, n, bot.base.position.x + 40 + i * 50, bot.base.position.y));

  // Let the grid and formations settle without letting the bot think yet.
  bot._thinkTimer = Infinity;
  for (let i = 0; i < 5; i++) sim.step(TICK_MS);

  const ai = sim._systems.ai;
  bot._calm = 1e9;                    // past the feint-patience gate
  bot.base.garrison = GARRISON_MAX - 1;  // fat budget, but under the release threshold
  ai._think(st, bot, ai._census(st));

  return groups;
}

/** Leave exactly one node in the world, `d` pixels from p0's base. */
function onlyNodeAt(sim, d) {
  const st = sim.state;
  const base = st.players.get('p0').base;
  const [first] = [...st.mineNodes.values()];
  for (const [id] of st.mineNodes) if (id !== first.id) st.mineNodes.delete(id);
  first.position.x = base.position.x + d;
  first.position.y = base.position.y;
  first.ownerId = null;
  return first;
}

test('a bot down to its last squad takes a NEARBY node but not a distant one', () => {
  // Node duty is the one commitment that is reversible — _holdHome recalls a
  // node-sitter the moment the base is threatened — so the "never send your
  // last squad" caution that rightly governs attacks does not apply, PROVIDED
  // the squad can actually get home. Distance is what makes that true, so
  // distance is what the rule is written on.
  const near = new Simulation({ mode: 'mining', logger: quiet });
  onlyNodeAt(near, BOT_MINE_SOLO_RADIUS * 0.5);
  const [nearSquad] = decideOnce(near, 'p0', [45]);
  // defendNodeId, not status: setDefendNode leaves the status as 'defending',
  // so a node-holder and a base-guard look identical apart from this field.
  assert.ok(nearSquad.defendNodeId,
    'a node in the bot\'s own quarter of the map is worth its last squad');

  const far = new Simulation({ mode: 'mining', logger: quiet });
  onlyNodeAt(far, BOT_MINE_SOLO_RADIUS * 2);
  const [farSquad] = decideOnce(far, 'p0', [45]);
  assert.equal(farSquad.defendNodeId, null,
    'a bot must not send its only squad across the map, however free it looks');
});

test('a bot with two squads spends the SMALLER one on a node', () => {
  // The mirror of the test above — proving the guard is a real condition and
  // not just "mining errands never happen" — and that it picks sensibly.
  // Capturing a node is decided by bodies present, so the big squad is the one
  // that should stay free to threaten a base.
  const sim = new Simulation({ mode: 'mining', logger: quiet });
  const [big, small] = decideOnce(sim, 'p0', [45, 15]);

  assert.ok(small.defendNodeId,
    'with two squads spare, a bot should put the smaller one on a node');
  assert.equal(big.defendNodeId, null,
    'the big squad is the only thing that can crack a base — it must not babysit a node');
});

test('a bot will not throw one squad at a walled base', () => {
  // THE BUG A PLAYER ACTUALLY HIT: required force was
  //
  //     max(1, defenders * DEFENDER_EDGE * walls * edge)
  //
  // Walls were a MULTIPLIER on the defender count, so a base with intact walls
  // and every soldier tucked safely in its garrison scored defenders = 0 — and
  // zero times any wall factor is zero. The whole thing collapsed to max(1, 0),
  // meaning ONE attacker was deemed enough for a fully fortified base. Bots
  // fed single squads into walls all match.
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  const st = sim.state;
  const bot = st.players.get('p0');
  const victim = st.players.get('p1');

  // Everyone else out of the picture so p1 is the only candidate.
  for (const [, p] of st.players) if (p.id !== 'p0' && p.id !== 'p1') p.alive = false;
  st.bosses.clear();

  // A full ring of wall, and not one defender visible outside the base.
  for (let i = 0; i < WALL_CELLS_BASE; i++) addWallCell(victim.base, 0, i);
  const wallHp = victim.base.walls[0].cells.reduce((t, c) => t + c.hp, 0);
  assert.ok(wallHp > 0, 'the test needs a wall to exist');

  const ai = sim._systems.ai;
  const census = ai._census(st);

  // One squad of 15 must not qualify; a committed assault must.
  const lone = ai._pickTarget(st, bot, 'standard', GROUP_MAX_SIZE, census);
  assert.equal(lone, null,
    `a single ${GROUP_MAX_SIZE}-soldier squad must not be judged enough to crack ` +
    `a ${wallHp} HP wall`);

  // …but a force that genuinely covers the wall, at this tier's demanded edge,
  // must still commit. Otherwise the fix would just be "never attack walls".
  const enough = (wallHp / WALL_BODY_HP) * BOT_ATTACK_EDGE.standard + GROUP_MAX_SIZE;
  const host = ai._pickTarget(st, bot, 'standard', enough, census);
  assert.ok(host, `a committed assault of ${Math.ceil(enough)} should still be willing`);
});

test('walls raise the required force even with zero defenders on the map', () => {
  // The same defect stated as an invariant, so a future refactor that folds the
  // wall term back into a product fails here rather than in someone's match.
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  const base = sim.state.players.get('p1').base;
  const ai = sim._systems.ai;

  const bare = ai._forceNeeded(0, ai._wallBodies(base), 1);
  for (let i = 0; i < WALL_CELLS_BASE; i++) addWallCell(base, 0, i);
  const walled = ai._forceNeeded(0, ai._wallBodies(base), 1);

  assert.ok(walled > bare * 5,
    `walls must cost real bodies with no defenders present (${bare} -> ${walled})`);
});

void MINE_CAPTURE_RANGE;
