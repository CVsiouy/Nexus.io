/**
 * Measures how much data the server sends each player, per second.
 *
 * This is THE number that decides the hosting bill. The plan estimates
 * 12–18 KB/s per player after optimisation; this measures what we actually
 * send today, so Phase 3 has a real baseline to improve on rather than a guess.
 *
 * Run:  docker compose exec server node test/bandwidth.mjs
 */
import { Client } from 'colyseus.js';
import { decodeSnapshot } from '@basewar/protocol';

const URL = process.env.SERVER_URL || 'ws://localhost:2567';
const WARMUP_SEC = Number(process.env.WARMUP_SEC ?? 90);
const SAMPLE_SEC = 10;

const room = await new Client(URL).joinOrCreate('arena', {
  mode: 'ffa', name: 'Meter', protocol: 1,
});

let bytes = 0, count = 0, sampling = false;
let lastSnap = null;

room.onMessage('e', () => {});   // events channel — registered so it isn't logged as unhandled

let keyframes = 0, deltas = 0, keyBytes = 0, deltaBytes = 0;

room.onMessage('s', (raw) => {
  // Measure the ACTUAL bytes on the wire, then decode as the real client does.
  const n = raw?.byteLength ?? raw?.length ?? 0;
  lastSnap = decodeSnapshot(raw, lastSnap);
  if (!sampling) return;
  bytes += n;
  count++;
  if (lastSnap.keyframe) { keyframes++; keyBytes += n; }
  else { deltas++; deltaBytes += n; }
});

/** Where are the bytes actually going? This decides what is worth optimising. */
function breakdown(snap) {
  const size = (v) => JSON.stringify(v)?.length ?? 0;
  const rows = [
    ['players (bases, walls, queues)', size(snap.players)],
    ['  └ of which: wall geometry', snap.players.reduce((n, p) => n + size(p.base.walls), 0)],
    ['  └ of which: build queues', snap.players.reduce((n, p) => n + size(p.base.soldierQueue) + size(p.base.wallQueue) + size(p.base.turretQueue), 0)],
    ['  └ of which: unlocked list', snap.players.reduce((n, p) => n + size(p.base.unlocked), 0)],
    ['soldiers', size(snap.soldiers)],
    ['groups', size(snap.groups)],
    ['mineNodes / eatables / other', size(snap.mineNodes) + size(snap.eatables) + size(snap.wildlings) + size(snap.projectiles) + size(snap.turrets)],
  ];
  const total = size(snap);
  console.log('\n─── Where the bytes go (one snapshot) ───────────────────');
  for (const [label, n] of rows) {
    const pct = ((n / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${pct}%  ${String(n).padStart(7)} B  ${label}`);
  }
  console.log(`          ${String(total).padStart(7)} B  TOTAL`);
}

console.log(`\nLetting a match develop for ${WARMUP_SEC}s so entity counts are realistic…`);
await new Promise(r => setTimeout(r, WARMUP_SEC * 1000));

const s = lastSnap;
console.log(`\nAt sample time: ${s.soldiers.length} soldiers, ${s.groups.length} squads, tick ${s.tick}`);
breakdown(s);

sampling = true;
await new Promise(r => setTimeout(r, SAMPLE_SEC * 1000));
sampling = false;

const perSec = bytes / SAMPLE_SEC;
const perSnap = bytes / Math.max(count, 1);

console.log(`
─── Downstream, per player ──────────────────────────────
  snapshots/sec     ${(count / SAMPLE_SEC).toFixed(1)}
  bytes/snapshot    ${Math.round(perSnap).toLocaleString()}
  KB/sec            ${(perSec / 1024).toFixed(1)}
  keyframes         ${keyframes} avg ${keyframes ? Math.round(keyBytes / keyframes) : 0} B
  delta frames      ${deltas} avg ${deltas ? Math.round(deltaBytes / deltas) : 0} B

─── Extrapolated (8 players/match) ──────────────────────
  per match         ${(perSec * 8 / 1024).toFixed(1)} KB/s
  at 100 players    ${(perSec * 100 / 1024 / 1024).toFixed(2)} MB/s
  at 10,000 players ${(perSec * 10000 / 1024 / 1024).toFixed(1)} MB/s
                    ≈ ${(perSec * 10000 * 2.6e6 * 0.3 / 1e12).toFixed(0)} TB/month at 30% duty

  Measured on the wire, after Phase 3's binary encoding. Compare with the
  JSON baseline this replaced: 141 KB/s per player.
─────────────────────────────────────────────────────────
`);

await room.leave(true);
process.exit(0);
