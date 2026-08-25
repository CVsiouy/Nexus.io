/**
 * How many matches can one CPU core actually run?
 * ───────────────────────────────────────────────
 *
 * Every capacity and cost figure in MULTIPLAYER_PLAN.md rests on one number:
 * matches per core. Until now that number was an estimate ("20-40, measure it").
 * This measures it.
 *
 * Method: create N simulations in one process, let them develop so entity
 * counts are realistic, then step them all at the real 20Hz rate and time it.
 * No network, no clients — just the game logic, which is what the CPU actually
 * spends its time on.
 *
 * Node runs JavaScript on ONE core per process, so "how much of this process's
 * core did N rooms consume" is exactly the question we need answered.
 *
 * Run:  ROOMS=25 docker compose exec server node ../loadtest/src/rooms.mjs
 */
import { Simulation, TICK_MS } from '@basewar/sim';

const ROOMS      = Number(process.env.ROOMS ?? 20);
const WARMUP_SEC = Number(process.env.WARMUP_SEC ?? 120);
const SAMPLE_SEC = Number(process.env.SAMPLE_SEC ?? 20);

const quiet = { error: () => {}, warn: () => {}, log: () => {} };

console.log(`\nBuilding ${ROOMS} matches…`);
const sims = Array.from({ length: ROOMS }, () => new Simulation({ mode: 'ffa', logger: quiet }));

// Warm up: a fresh match has 8 soldiers, a developed one has hundreds. Measuring
// the empty case would flatter the result enormously.
const warmupTicks = Math.round((WARMUP_SEC * 1000) / TICK_MS);
console.log(`Warming up ${WARMUP_SEC}s of game time so entity counts are realistic…`);
for (let i = 0; i < warmupTicks; i++) for (const s of sims) s.step(TICK_MS);

const soldiers = sims.reduce((n, s) => n + s.state.soldiers.size, 0);
const groups   = sims.reduce((n, s) => n + s.state.groups.size, 0);
console.log(`  ${(soldiers / ROOMS).toFixed(0)} soldiers and ${(groups / ROOMS).toFixed(1)} squads per match on average`);

// ── Measure ──────────────────────────────────────────────────────────────────
// Time one "server tick": stepping every room once. That is the unit of work
// the real server must finish inside TICK_MS.
const sampleTicks = Math.round((SAMPLE_SEC * 1000) / TICK_MS);
const timings = new Float64Array(sampleTicks);

console.log(`Measuring ${sampleTicks} server ticks…\n`);
for (let i = 0; i < sampleTicks; i++) {
  const t0 = performance.now();
  for (const s of sims) s.step(TICK_MS);
  timings[i] = performance.now() - t0;
}

timings.sort();
const pct = (p) => timings[Math.min(timings.length - 1, Math.floor(timings.length * p))];
const mean = timings.reduce((a, b) => a + b, 0) / timings.length;

const p50 = pct(0.50), p95 = pct(0.95), p99 = pct(0.99);
const perRoom = mean / ROOMS;
const budgetUsed = (mean / TICK_MS) * 100;
const roomsPerCore = Math.floor(TICK_MS / perRoom);

// Leave headroom: running a core at 100% means any hiccup makes the game stutter
// for everyone on it. 60% sustained is a sane operating point.
const safeRoomsPerCore = Math.floor(roomsPerCore * 0.6);

const errors = sims.reduce((n, s) => n + s.errorCount, 0);

console.log(`─── ${ROOMS} matches in one process ───────────────────────────`);
console.log(`  time to step all ${ROOMS} rooms once`);
console.log(`    mean            ${mean.toFixed(2)} ms`);
console.log(`    p50             ${p50.toFixed(2)} ms`);
console.log(`    p95             ${p95.toFixed(2)} ms`);
console.log(`    p99             ${p99.toFixed(2)} ms`);
console.log(`    budget (${TICK_MS}ms)  ${budgetUsed.toFixed(1)}% used`);
console.log(`  per match         ${perRoom.toFixed(3)} ms/tick`);
console.log(`  sim errors        ${errors}`);
console.log(`
─── Capacity ────────────────────────────────────────────────
  theoretical max   ${roomsPerCore} matches per core (100% busy)
  safe operating    ${safeRoomsPerCore} matches per core (60% busy)
                    = ${safeRoomsPerCore * 8} players per core

  at 100 players    ${Math.ceil(100 / 8 / safeRoomsPerCore)} core(s)
  at 1,000 players  ${Math.ceil(1000 / 8 / safeRoomsPerCore)} core(s)
  at 10,000 players ${Math.ceil(10000 / 8 / safeRoomsPerCore)} core(s)

  NOTE: this measures the simulation only. The real server also encodes and
  sends snapshots, so treat these as an upper bound — but simulation is the
  part that scales with player count, and it is what the spatial grid fixed.
─────────────────────────────────────────────────────────────
`);
