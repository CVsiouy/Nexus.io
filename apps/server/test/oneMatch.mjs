/**
 * Plays one match to completion and reports how it ended.
 *
 * Used to verify the telemetry pipeline without waiting 20 minutes: run the
 * server with a short MATCH_LIMIT_MS and this will sit through a whole match.
 *
 *   docker run ... -e MATCH_LIMIT_MS=40000 ...
 *   docker exec <container> node test/oneMatch.mjs
 */
import { Client } from 'colyseus.js';

const URL = process.env.SERVER_URL || 'ws://127.0.0.1:2567';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000);

const room = await new Client(URL).joinOrCreate('arena', {
  mode: 'ffa', name: process.env.PLAYER_NAME || 'Tester', protocol: 1,
});

// Register every channel so colyseus.js doesn't warn about unhandled types.
for (const t of ['w', 's', 'e', 'r', 'p', 'l']) room.onMessage(t, () => {});

console.log(`joined ${room.roomId} — waiting for the match to end…`);

const ended = await new Promise((resolve) => {
  room.onMessage('x', resolve);
  setTimeout(() => resolve(null), TIMEOUT_MS);
});

if (!ended) {
  console.error(`\n✗ no round-end message within ${TIMEOUT_MS / 1000}s.`);
  console.error('  Is MATCH_LIMIT_MS set low enough for this test?\n');
  process.exit(1);
}

console.log(`\n✓ match ended: ${ended.reason}`);
console.log(`  winner: ${ended.standings?.find(s => s.id === ended.winner)?.name ?? ended.winner}`);
console.log(`  standings: ${ended.standings?.slice(0, 3).map(s => `${s.name} ${s.xp}xp`).join(' · ')}`);

await room.leave(true);
process.exit(0);
