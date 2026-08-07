/**
 * Follow-up diagnostics for the three things the bulk run surfaced:
 *   1. Why do 43% of matches run out the clock?
 *   2. Are "empty squads" a real leak or a one-tick artefact?
 *   3. Can an attacking squad get permanently stuck? (It cannot be recalled.)
 *
 * Run:  node apps/loadtest/src/diagnose.mjs
 */
import { Simulation, TICK_MS, GROUP_MAX_SIZE, POP_BASE, POP_PER_LEVEL } from '@nexus/sim';

const quiet = { error: () => {}, warn: () => {}, log: () => {} };
const LIMIT = 20 * 60 * 1000;

// ── 1. What does a stalled match look like at the final whistle? ─────────────
console.log('\n=== 1. STATE OF MATCHES THAT RAN OUT THE CLOCK ===\n');

let stalls = 0;
for (let m = 0; m < 12 && stalls < 4; m++) {
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  for (let t = 0; t < LIMIT / TICK_MS; t++) {
    sim.step(TICK_MS);
    if (sim.matchResult()) break;
  }
  if (sim.matchResult()) continue;   // resolved; not what we're studying
  stalls++;

  const alive = [...sim.state.players.values()].filter(p => p.alive);
  console.log(`  Stalled match ${stalls}: ${alive.length} bases still standing`);
  for (const p of alive) {
    const army = sim.state.soldierCount(p.id);
    const cap = POP_BASE + p.base.level * POP_PER_LEVEL;
    const squads = sim.state.groupsOf(p.id);
    const walls = p.base.walls.reduce((n, l) => n + l.cells.length, 0);
    const rings = p.base.walls.filter(l => l.cells.length >= l.maxCells).length;
    console.log(
      `    ${p.id} ${String(p.botTier).padEnd(10)} lv${String(p.base.level).padStart(2)} ` +
      `army ${String(army).padStart(3)}/${cap}  squads ${squads.length} ` +
      `(${squads.filter(g => g.status === 'attacking').length} attacking) ` +
      `hp ${(p.base.hp / p.base.maxHp * 100).toFixed(0)}%  ` +
      `walls ${walls} cells / ${rings} complete rings  gold ${p.base.gold.toFixed(0)}`);
  }
  console.log('');
}

// ── 2. How long does an empty squad actually survive? ───────────────────────
console.log('=== 2. EMPTY SQUAD LIFETIME ===\n');
{
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  const emptySince = new Map();
  const lifetimes = [];
  let everSnapshotted = 0;

  for (let t = 0; t < (12 * 60 * 1000) / TICK_MS; t++) {
    sim.step(TICK_MS);

    for (const [id, g] of sim.state.groups) {
      if (g.memberIds.length === 0) {
        if (!emptySince.has(id)) emptySince.set(id, t);
      } else if (emptySince.has(id)) {
        lifetimes.push(t - emptySince.get(id));
        emptySince.delete(id);
      }
    }
    for (const [id, since] of emptySince) {
      if (!sim.state.groups.has(id)) { lifetimes.push(t - since); emptySince.delete(id); }
    }

    // Would a client ever SEE one? Snapshots go out every other tick.
    if (t % 2 === 0) {
      const snap = sim.getSnapshot();
      if (snap.groups.some(g => g.memberIds.length === 0)) everSnapshotted++;
    }
  }

  const sorted = lifetimes.sort((a, b) => a - b);
  console.log(`  empty squads observed        ${lifetimes.length}`);
  console.log(`  lifetime in ticks            median ${sorted[Math.floor(sorted.length / 2)] ?? 0}` +
              `   max ${sorted.at(-1) ?? 0}`);
  console.log(`  snapshots containing one     ${everSnapshotted}`);
  console.log(`  → ${everSnapshotted > 0
      ? 'YES, clients receive empty squads. The squad list would flicker.'
      : 'never reaches a client; internal only.'}\n`);
}

// ── 3. Can a locked attacking squad get stuck forever? ──────────────────────
console.log('=== 3. LOCKED SQUADS THAT NEVER RESOLVE ===\n');
{
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  const lockedSince = new Map();
  const targetHpAt = new Map();
  const stuck = [];

  for (let t = 0; t < LIMIT / TICK_MS; t++) {
    sim.step(TICK_MS);

    for (const [id, g] of sim.state.groups) {
      if (g.status !== 'attacking') { lockedSince.delete(id); targetHpAt.delete(id); continue; }
      if (!lockedSince.has(id)) {
        lockedSince.set(id, t);
        targetHpAt.set(id, sim.state.resolve(g.targetId)?.hp ?? 0);
      }
      const heldFor = t - lockedSince.get(id);
      if (heldFor > 0 && heldFor % 2400 === 0) {           // every 2 minutes
        const target = sim.state.resolve(g.targetId);
        const hpThen = targetHpAt.get(id);
        const hpNow = target?.hp ?? 0;
        // Locked for 2 minutes AND the target has lost no health = no progress.
        if (target && hpNow >= hpThen - 1) {
          stuck.push({ id, mins: (heldFor * TICK_MS) / 60000, members: g.memberIds.length,
                       targetHp: hpNow.toFixed(0) });
        }
        targetHpAt.set(id, hpNow);
      }
    }
  }

  if (!stuck.length) {
    console.log('  No locked squad ever went 2 minutes without damaging its target.');
    console.log('  → attacking squads always make progress or die. Good.\n');
  } else {
    console.log(`  ${stuck.length} cases of a locked squad making NO progress for 2+ minutes:`);
    for (const s of stuck.slice(0, 6)) {
      console.log(`    squad ${s.id}: locked ${s.mins.toFixed(0)}min, ${s.members} members, target hp ${s.targetHp}`);
    }
    console.log('  → these squads are permanently lost: they cannot be recalled.\n');
  }
}

// ── 4. Is defence simply too strong? ────────────────────────────────────────
console.log('=== 4. ATTACK VS DEFENCE OUTCOMES ===\n');
{
  const sim = new Simulation({ mode: 'ffa', logger: quiet });
  let launched = 0, succeeded = 0, wiped = 0;
  const watching = new Map();

  for (let t = 0; t < LIMIT / TICK_MS; t++) {
    sim.step(TICK_MS);
    for (const [id, g] of sim.state.groups) {
      if (g.status === 'attacking' && !watching.has(id)) {
        watching.set(id, { target: g.targetId, size: g.memberIds.length });
        launched++;
      }
    }
    for (const [id, info] of watching) {
      const g = sim.state.groups.get(id);
      if (!g) { wiped++; watching.delete(id); continue; }
      if (g.status !== 'attacking') {
        const target = sim.state.resolve(info.target);
        if (!target || target.hp <= 0) succeeded++;
        watching.delete(id);
      }
    }
  }
  console.log(`  assaults launched            ${launched}`);
  console.log(`  target destroyed             ${succeeded}  (${((succeeded / launched) * 100).toFixed(0)}%)`);
  console.log(`  squad wiped out instead      ${wiped}  (${((wiped / launched) * 100).toFixed(0)}%)`);
  console.log(`  → if wipes hugely outnumber successes, attacking is a losing trade`);
  console.log(`    and bots are correct to turtle — the imbalance is in the GAME,`);
  console.log(`    not in the AI.\n`);
}
