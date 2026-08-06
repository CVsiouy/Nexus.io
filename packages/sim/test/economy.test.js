import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, TICK_MS } from '../Simulation.js';
import { goldRate } from '../systems/ProgressionSystem.js';
import { CONQUEST_GOLD_LUMP, GOLD_PER_SEC, GOLD_PER_LEVEL } from '../constants.js';

const quiet = { error: () => {}, warn: () => {}, log: () => {} };

/**
 * The conquest reward used to be permanent, stacking income (+2 gold/sec per
 * kill). That compounds: the first kill funds the second, which funds the
 * third, and one early kill can decide a twenty-minute match while seven other
 * people are still playing it.
 *
 * It is now a one-time flat lump sum. These tests pin that down, because
 * nothing in the suite covered the conquest reward at all before — which is
 * exactly why a half-finished change here could have shipped unnoticed.
 */

/**
 * Destroy `victim`'s base, crediting `killer`. Returns after the sim reacts.
 *
 * `lastAttackedAt` must be set too: bases regenerate once they have gone
 * BASE_HP_REGEN_DELAY without being hit, and ProgressionSystem runs before
 * CombatSystem — so a base "destroyed" without that would simply heal a few HP
 * and never be eliminated at all.
 */
function destroyBase(sim, victimId, killerId) {
  const victim = sim.state.players.get(victimId);
  victim.base.hp = 0;
  victim.base.lastAttackerId = killerId;
  victim.base.lastAttackedAt = sim.state.time;
  sim.step(TICK_MS);
  return victim;
}

test('destroying a base pays a flat one-time bounty', () => {
  const sim = new Simulation({ logger: quiet });
  const killer = sim.state.players.get('p0');
  const goldBefore = killer.base.gold;

  destroyBase(sim, 'p4', 'p0');

  const gained = killer.base.gold - goldBefore;
  // One tick of passive income also lands, so allow a little slack.
  assert.ok(Math.abs(gained - CONQUEST_GOLD_LUMP) < 5,
    `expected about ${CONQUEST_GOLD_LUMP} gold, got ${gained.toFixed(1)}`);
  assert.equal(sim.state.players.get('p4').alive, false);
});

test('the bounty does NOT scale with the victim level', () => {
  // Killing the leader paying double is itself a snowball vector: it makes
  // whoever is ahead the most profitable target only for whoever is already
  // strong enough to reach them.
  const a = new Simulation({ logger: quiet });
  a.state.players.get('p4').base.level = 1;
  const beforeA = a.state.players.get('p0').base.gold;
  destroyBase(a, 'p4', 'p0');
  const gainedA = a.state.players.get('p0').base.gold - beforeA;

  const b = new Simulation({ logger: quiet });
  b.state.players.get('p4').base.level = 18;
  const beforeB = b.state.players.get('p0').base.gold;
  destroyBase(b, 'p4', 'p0');
  const gainedB = b.state.players.get('p0').base.gold - beforeB;

  assert.ok(Math.abs(gainedA - gainedB) < 5,
    `killing a level-18 base paid ${gainedB.toFixed(0)} vs ${gainedA.toFixed(0)} for level 1 — should be flat`);
});

test('a kill grants NO permanent income — the anti-snowball guarantee', () => {
  const sim = new Simulation({ logger: quiet });
  const killer = sim.state.players.get('p0');

  // Income legitimately rises with LEVEL (GOLD_PER_LEVEL), and conquest XP can
  // push you up a level, so the test has to isolate the conquest effect from
  // the levelling effect rather than just comparing raw rates.
  const rateFor = (level) => goldRate({ ...killer.base, level });
  const levelBefore = killer.base.level;
  const rateBefore = goldRate(killer.base);

  destroyBase(sim, 'p4', 'p0');
  assert.equal(goldRate(killer.base), rateFor(killer.base.level),
    'income after a kill must be explainable by level alone');

  destroyBase(sim, 'p5', 'p0');
  destroyBase(sim, 'p6', 'p0');

  // Three kills: income may have risen from levelling, but by EXACTLY the
  // amount levelling accounts for and not a penny more.
  const levelsGained = killer.base.level - levelBefore;
  const expected = rateBefore + levelsGained * GOLD_PER_LEVEL * (killer.base.goldMult ?? 1);
  assert.ok(Math.abs(goldRate(killer.base) - expected) < 1e-9,
    `three kills changed income beyond levelling: got ${goldRate(killer.base)}, expected ${expected}`);
});

test('income comes only from the base and paid-for mining upgrades', () => {
  const sim = new Simulation({ logger: quiet });
  const base = sim.state.players.get('p0').base;

  assert.ok(goldRate(base) >= GOLD_PER_SEC, 'a fresh base should earn the baseline');

  const before = goldRate(base);
  base.miningBonus += 1.4;                       // as a purchased upgrade would
  assert.ok(goldRate(base) > before, 'mining upgrades must still raise income');
});

test('goldRate never returns NaN, even on partial base data', () => {
  // goldRate is public API and is called client-side on DECODED snapshot data,
  // not just on real Base objects. A single missing field used to make it NaN,
  // which then poisoned base.gold on the next tick and silently showed every
  // player zero gold rather than throwing anything.
  const partials = [
    {},
    { level: 3 },
    { level: 3, miningBonus: 1 },
    { level: 3, miningBonus: 1, goldMult: 1.5 },
    { level: undefined, miningBonus: undefined, goldMult: undefined },
  ];
  for (const b of partials) {
    const r = goldRate(b);
    assert.ok(Number.isFinite(r), `goldRate(${JSON.stringify(b)}) returned ${r}`);
    assert.ok(r >= 0, 'income should never be negative');
  }
});

test('a base records its conquests without gaining anything from them', () => {
  const sim = new Simulation({ logger: quiet });
  const killer = sim.state.players.get('p0');

  assert.equal(killer.base.conquests, 0);
  destroyBase(sim, 'p4', 'p0');
  destroyBase(sim, 'p5', 'p0');
  assert.equal(killer.base.conquests, 2, 'kills should be counted for telemetry');
  assert.equal(killer.base.conquestGoldBonus, undefined,
    'the permanent income field should be gone entirely, not merely zero');
});

test('the economy stays finite over a long match', () => {
  // A regression guard for the NaN class of bug: play a full match and assert
  // every player's gold is still a real number afterwards.
  const sim = new Simulation({ logger: quiet });
  for (let i = 0; i < (600 * 1000) / TICK_MS; i++) sim.step(TICK_MS);

  for (const [, p] of sim.state.players) {
    assert.ok(Number.isFinite(p.base.gold), `${p.id} gold is ${p.base.gold}`);
    assert.ok(p.base.gold >= 0, `${p.id} gold went negative`);
    assert.ok(Number.isFinite(goldRate(p.base)), `${p.id} income rate is not finite`);
  }
  assert.equal(sim.errorCount, 0);
});
