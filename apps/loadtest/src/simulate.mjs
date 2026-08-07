/**
 * Play many bot-only matches headless and report what happens.
 *
 * This is the substitute for sitting and watching: it plays dozens of full
 * matches, records how they went, and flags anything that looks wrong —
 * stalemates, runaway leaders, stuck squads, unspent gold, leaked entities.
 *
 * Run:  MATCHES=30 node apps/loadtest/src/simulate.mjs
 */
import { Simulation, TICK_MS } from '@nexus/sim';
import {
  GROUP_MAX_SIZE, GARRISON_MAX, WORLD_SIZE, POP_BASE, POP_PER_LEVEL,
} from '@nexus/sim';

const MATCHES = Number(process.env.MATCHES ?? 30);
const LIMIT_MS = Number(process.env.LIMIT_MS ?? 20 * 60 * 1000);
const SAMPLE_EVERY = 40;   // ticks between deep state inspections

const quiet = { error: () => {}, warn: () => {}, log: () => {} };
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(0) : '0') + '%';
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const anomalies = new Map();
function flag(kind, detail) {
  if (!anomalies.has(kind)) anomalies.set(kind, { count: 0, examples: [] });
  const a = anomalies.get(kind);
  a.count++;
  if (a.examples.length < 3) a.examples.push(detail);
}

const matches = [];

for (let m = 0; m < MATCHES; m++) {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });

  const rec = {
    ticks: 0,
    resolved: false,
    winner: null,
    winnerTier: null,
    firstBloodMs: null,
    eliminations: [],
    leaderAt5min: null,
    attacksLaunched: 0,
    peakArmy: {},
    goldPeak: {},
    maxLevel: 0,
    specsChosen: 0,
    wallsBuilt: 0,
    bossSpawned: false,
    idleSquadTicks: 0,
    squadTicks: 0,
  };

  const seenAttack = new Set();
  const lastPos = new Map();
  const stuckSince = new Map();

  const maxTicks = Math.round(LIMIT_MS / TICK_MS);

  for (let t = 0; t < maxTicks; t++) {
    sim.step(TICK_MS);
    rec.ticks++;

    // Count each squad's commitment once, when it first turns to attacking.
    for (const [, g] of sim.state.groups) {
      if (g.status === 'attacking' && !seenAttack.has(g.id)) {
        seenAttack.add(g.id);
        rec.attacksLaunched++;
      }
    }

    if (t % SAMPLE_EVERY === 0) {
      const s = sim.state;

      // ── Correctness checks ────────────────────────────────────────────────
      for (const [, p] of s.players) {
        if (!Number.isFinite(p.base.gold)) flag('base gold is not a finite number', `${p.id} gold=${p.base.gold}`);
        if (p.base.gold < 0) flag('base gold went negative', `${p.id} gold=${p.base.gold}`);
        if (p.base.hp > p.base.maxHp + 1) flag('base HP above maximum', `${p.id} ${p.base.hp}/${p.base.maxHp}`);
        if (p.alive && p.base.hp <= 0) flag('base at 0 HP but still alive', `${p.id}`);
        rec.goldPeak[p.id] = Math.max(rec.goldPeak[p.id] ?? 0, p.base.gold);
        rec.maxLevel = Math.max(rec.maxLevel, p.base.level);
        if (p.base.specialization) rec.specsChosen++;
        rec.wallsBuilt = Math.max(rec.wallsBuilt, p.base.walls.reduce((n, l) => n + l.cells.length, 0));
      }

      for (const [, sol] of s.soldiers) {
        const { x, y } = sol.position;
        if (!Number.isFinite(x) || !Number.isFinite(y)) flag('soldier position is not a number', `${sol.id}`);
        if (x < -2 || y < -2 || x > WORLD_SIZE + 2 || y > WORLD_SIZE + 2) {
          flag('soldier outside the map', `${sol.id} at ${x.toFixed(0)},${y.toFixed(0)}`);
        }
        if (sol.hp <= 0) flag('dead soldier left in the world', `${sol.id}`);
      }

      for (const [, g] of s.groups) {
        rec.squadTicks++;
        if (g.status === 'idle') rec.idleSquadTicks++;
        if (g.memberIds.length === 0) flag('empty squad not cleaned up', `${g.id}`);
        for (const mid of g.memberIds) {
          if (!s.soldiers.has(mid)) flag('squad references a soldier that does not exist', `squad ${g.id} -> ${mid}`);
        }
        // A squad that has not moved at all while trying to move is stuck.
        if (g.status === 'moving' || g.status === 'attacking') {
          const key = g.id;
          const prev = lastPos.get(key);
          const now = { x: g.anchor.x, y: g.anchor.y };
          if (prev && Math.hypot(now.x - prev.x, now.y - prev.y) < 0.5) {
            const since = (stuckSince.get(key) ?? 0) + SAMPLE_EVERY;
            stuckSince.set(key, since);
            if (since > 1200) {   // ~60s of game time going nowhere
              flag('squad stuck without moving for 60s+', `squad ${g.id} status=${g.status}`);
              stuckSince.set(key, 0);
            }
          } else {
            stuckSince.set(key, 0);
          }
          lastPos.set(key, now);
        }
      }

      for (const [, p] of s.players) {
        if (!p.alive) continue;
        rec.peakArmy[p.id] = Math.max(rec.peakArmy[p.id] ?? 0, s.soldierCount(p.id));
      }

      const hw = s.ids.highWater;
      if (hw > 60000) flag('entity ids approaching the 2-byte network limit', `highWater=${hw}`);
    }

    if (sim.state.bossesSpawned > 0) rec.bossSpawned = true;

    // Eliminations
    for (const ev of sim.drainEvents()) {
      if (ev.type === 'bossKilled') rec.bossesKilled = (rec.bossesKilled ?? 0) + 1;
      if (ev.type === 'playerEliminated') {
        const atMs = sim.state.time;
        rec.eliminations.push({ id: ev.data.ownerId, by: ev.data.killerId, atMs });
        if (rec.firstBloodMs == null) rec.firstBloodMs = atMs;
      }
    }

    if (Math.abs(sim.state.time - 5 * 60 * 1000) < TICK_MS) {
      const rank = [...sim.state.players.values()]
        .filter(p => p.alive)
        .sort((a, b) => b.base.xpEarned - a.base.xpEarned)[0];
      rec.leaderAt5min = rank?.id ?? null;
    }

    const result = sim.matchResult();
    if (result) {
      rec.resolved = true;
      rec.winner = result.winner;
      rec.winnerTier = sim.state.players.get(result.winner)?.botTier ?? null;
      break;
    }
  }

  if (!rec.resolved) {
    const standing = sim.standings();
    rec.winner = standing[0]?.id ?? null;
    rec.winnerTier = sim.state.players.get(rec.winner)?.botTier ?? null;
  }

  rec.errorCount = sim.errorCount;
  rec.finalAlive = [...sim.state.players.values()].filter(p => p.alive).length;
  rec.unspentGold = [...sim.state.players.values()].filter(p => p.alive).map(p => p.base.gold);
  rec.finalLevels = [...sim.state.players.values()].map(p => p.base.level);
  rec.popUse = [...sim.state.players.values()].filter(p => p.alive).map(p => {
    const cap = POP_BASE + p.base.level * POP_PER_LEVEL;
    return sim.state.soldierPop(p.id) / cap;
  });
  matches.push(rec);

  process.stdout.write(`  match ${String(m + 1).padStart(2)}/${MATCHES}  ` +
    `${rec.resolved ? 'resolved' : 'TIMED OUT'}  ` +
    `${((rec.ticks * TICK_MS) / 60000).toFixed(1)}min  ` +
    `${rec.eliminations.length} kills  ` +
    `winner=${rec.winner}(${rec.winnerTier})\n`);
}

// ── Report ───────────────────────────────────────────────────────────────────

const resolved = matches.filter(m => m.resolved);
const timedOut = matches.filter(m => !m.resolved);
const lengths = matches.map(m => (m.ticks * TICK_MS) / 60000);

console.log(`\n${'='.repeat(70)}`);
console.log(`  ${MATCHES} BOT-ONLY MATCHES`);
console.log('='.repeat(70));

console.log(`\n── Do matches resolve? ──`);
console.log(`  resolved (one base left)   ${resolved.length}/${MATCHES}  ${pct(resolved.length, MATCHES)}`);
console.log(`  ran out the clock          ${timedOut.length}/${MATCHES}  ${pct(timedOut.length, MATCHES)}`);
console.log(`  match length  median ${median(lengths).toFixed(1)}min   mean ${mean(lengths).toFixed(1)}min   ` +
            `range ${Math.min(...lengths).toFixed(1)}-${Math.max(...lengths).toFixed(1)}min`);

const fb = matches.map(m => m.firstBloodMs).filter(Boolean).map(v => v / 60000);
console.log(`  first base destroyed at    median ${median(fb).toFixed(1)}min` +
            (fb.length < MATCHES ? `   (${MATCHES - fb.length} matches had NO kills at all)` : ''));
console.log(`  bases destroyed per match  median ${median(matches.map(m => m.eliminations.length))}`);
console.log(`  survivors at the end       median ${median(matches.map(m => m.finalAlive))}`);

console.log(`\n── Snowball check ──`);
const withLeader = matches.filter(m => m.leaderAt5min && m.winner);
const leaderWon = withLeader.filter(m => m.leaderAt5min === m.winner);
console.log(`  leader at 5min went on to win   ${leaderWon.length}/${withLeader.length}  ${pct(leaderWon.length, withLeader.length)}`);
console.log(`  (1 in 8 = 13% is pure chance; over ~50% means the early lead decides it)`);

console.log(`\n── Bot behaviour ──`);
console.log(`  attacks launched per match     median ${median(matches.map(m => m.attacksLaunched))}`);
const idleShare = mean(matches.map(m => (m.squadTicks ? m.idleSquadTicks / m.squadTicks : 0)));
console.log(`  squad-time spent idle          ${(idleShare * 100).toFixed(1)}%`);
console.log(`  peak army (best bot)           median ${median(matches.map(m => Math.max(...Object.values(m.peakArmy), 0)))} soldiers`);
console.log(`  population cap usage           mean ${(mean(matches.flatMap(m => m.popUse)) * 100).toFixed(0)}%`);
console.log(`  wall cells built (best bot)    median ${median(matches.map(m => m.wallsBuilt))}`);
console.log(`  highest level reached          median ${median(matches.map(m => m.maxLevel))}`);
console.log(`  bosses appeared                ${matches.filter(m => m.bossSpawned).length}/${MATCHES} matches`);
console.log(`  bosses killed per match        median ${median(matches.map(m => m.bossesKilled ?? 0))}`);

console.log(`\n── Economy ──`);
const unspent = matches.flatMap(m => m.unspentGold);
console.log(`  unspent gold at the end        median ${median(unspent).toFixed(0)}   max ${Math.max(...unspent).toFixed(0)}`);
console.log(`  (a large figure means bots are earning faster than they can spend)`);

console.log(`\n── Which bot personality wins? ──`);
const byTier = {};
for (const m of matches) byTier[m.winnerTier] = (byTier[m.winnerTier] ?? 0) + 1;
for (const [tier, n] of Object.entries(byTier).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(tier).padEnd(12)} ${String(n).padStart(3)} wins  ${pct(n, MATCHES)}`);
}
console.log(`  (seat mix is 2 passive / 4 standard / 2 aggressive)`);

console.log(`\n── Correctness ──`);
const errs = matches.reduce((n, m) => n + m.errorCount, 0);
console.log(`  simulation exceptions          ${errs}`);
if (anomalies.size === 0) {
  console.log(`  anomalies                      none detected`);
} else {
  console.log(`  anomalies:`);
  for (const [kind, a] of [...anomalies].sort((x, y) => y[1].count - x[1].count)) {
    console.log(`    ${String(a.count).padStart(6)}x  ${kind}`);
    for (const ex of a.examples) console.log(`              e.g. ${ex}`);
  }
}
console.log('');
