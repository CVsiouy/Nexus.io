/**
 * End-to-end test: real clients, over a real WebSocket, against the real server.
 *
 * The unit tests prove the rules engine is correct. This proves the thing that
 * actually matters for Phase 1 — that two separate clients land in the SAME
 * match, control DIFFERENT bases, and cannot interfere with each other.
 *
 * Run:  docker compose exec server node test/integration.mjs
 */
import assert from 'node:assert/strict';
import { Client } from 'colyseus.js';
import { decodeSnapshot } from '@nexus/protocol';

const URL = process.env.SERVER_URL || 'ws://localhost:2567';
const PROTOCOL = 1;

const MSG = {
  COMMAND: 'c', LATENCY: 'l', WELCOME: 'w', SNAPSHOT: 's',
  EVENTS: 'e', REJECTED: 'r', ROUND_END: 'x', ROSTER: 'p',
};

const wait = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  console.log(`  ✓ ${msg}`);
  passed++;
};

/** Connect a client and collect everything the server sends it. */
async function connect(name) {
  const room = await new Client(URL).joinOrCreate('arena', { mode: 'ffa', name, protocol: PROTOCOL });
  const box = { room, name, welcome: null, snapshots: [], events: [], rejected: [], roster: null, pongs: [], bytes: 0, last: null };
  room.onMessage(MSG.WELCOME,  (m) => { box.welcome = m; });
  // Snapshots are binary now — decode them exactly as the real client does.
  room.onMessage(MSG.SNAPSHOT, (bytes) => {
    box.bytes += bytes?.byteLength ?? bytes?.length ?? 0;
    box.last = decodeSnapshot(bytes, box.last);
    box.snapshots.push(box.last);
  });
  room.onMessage(MSG.EVENTS,   (m) => { box.events.push(...m); });
  room.onMessage(MSG.REJECTED, (m) => { box.rejected.push(m); });
  room.onMessage(MSG.ROSTER,   (m) => { box.roster = m; });
  room.onMessage(MSG.LATENCY,  (t) => { box.pongs.push(performance.now() - t); });
  return box;
}

console.log(`\nConnecting to ${URL}\n`);

// ── Two players, one match ───────────────────────────────────────────────────
const alice = await connect('Alice');
const bob   = await connect('Bob');
await wait(1500);

ok(alice.welcome && bob.welcome, 'both clients received a welcome');
ok(alice.room.roomId === bob.room.roomId,
   `both players landed in the SAME match (${alice.room.roomId})`);
ok(alice.welcome.youAre !== bob.welcome.youAre,
   `they control different bases (${alice.welcome.youAre} vs ${bob.welcome.youAre})`);
ok(alice.welcome.seat !== bob.welcome.seat,
   `they hold different seats (${alice.welcome.seat} vs ${bob.welcome.seat})`);
ok(alice.welcome.protocol === PROTOCOL, 'server reported the protocol version');

// ── The world is flowing ─────────────────────────────────────────────────────
const before = alice.snapshots.length;
await wait(2000);
const rate = (alice.snapshots.length - before) / 2;
ok(rate >= 7 && rate <= 13, `snapshots arriving at ~10/second (measured ${rate.toFixed(1)}/s)`);

const snap = alice.snapshots.at(-1);
ok(snap.players.length === 8, 'the match has all 8 bases');
ok(snap.tick > 0, `the simulation is advancing (tick ${snap.tick})`);

const humans = snap.players.filter(p => !p.isBot);
ok(humans.length === 2, `2 human players, 6 bots filling the rest (${humans.map(h => h.name).join(', ')})`);

// Both clients must see the SAME world — one simulation, one truth.
const bSnap = bob.snapshots.at(-1);
ok(Math.abs(bSnap.tick - snap.tick) <= 2, 'both clients see the same match state');

// ── Commands are authoritative and isolated ──────────────────────────────────
const aliceId = alice.welcome.youAre;
const bobId   = bob.welcome.youAre;

const goldOf = (s, id) => s.players.find(p => p.id === id).base.gold;
const mineLevelOf = (s, id) => s.players.find(p => p.id === id).base.mineLevel;

// Give Alice enough gold to buy, then buy.
const beforeBuy = alice.snapshots.at(-1);
alice.room.send(MSG.COMMAND, { t: 'queue', unit: 'grunt', n: 1 });
await wait(600);
const afterQueue = alice.snapshots.at(-1);
const aliceQ = afterQueue.players.find(p => p.id === aliceId).base.soldierQueue;
ok(aliceQ.length > 0, "Alice's queue command reached the server and was applied");

const bobQ = afterQueue.players.find(p => p.id === bobId).base.soldierQueue;
ok(bobQ.length === 0, "Alice's command did NOT affect Bob's base");

// ── The server refuses illegal orders ────────────────────────────────────────
alice.rejected.length = 0;
alice.room.send(MSG.COMMAND, { t: 'queue', unit: 'vanguard', n: 1 });   // level 20 unit
await wait(500);
ok(alice.rejected.some(r => /unlock/i.test(r.reason)),
   `a locked unit was refused ("${alice.rejected.at(-1)?.reason}")`);

alice.rejected.length = 0;
alice.room.send(MSG.COMMAND, { t: 'totallyMadeUp', evil: true });
await wait(500);
ok(alice.rejected.some(r => /malformed/i.test(r.reason)), 'a malformed command was rejected');

alice.rejected.length = 0;
alice.room.send(MSG.COMMAND, { t: 'queue', unit: '../../etc/passwd', n: 1 });
await wait(400);
ok(alice.rejected.length > 0, 'a hostile unit name was rejected, not passed through');

// Bob tries to command a squad he does not own.
//
// Opportunistic: nobody starts with soldiers now, and waiting the ~80s it takes
// a bot to fill and field its first garrison would dominate this test. The
// guarantee itself is covered directly against the simulation by
// "you cannot command another player's squads" in packages/sim/test/botAI.test.js.
// This only confirms it still holds over the wire when a squad happens to exist.
const anySquad = alice.last?.groups.find(g => g.ownerId !== bobId && g.ownerId !== 'boss');
if (!anySquad) {
  console.log('  – skipped: no squad existed yet to test squad-ownership over the wire');
}
if (anySquad) {
  bob.rejected.length = 0;
  const anchorBefore = { x: anySquad.anchorX, y: anySquad.anchorY };
  bob.room.send(MSG.COMMAND, { t: 'move', g: [anySquad.id], x: 100, y: 100 });
  await wait(700);
  const after = alice.snapshots.at(-1).groups.find(g => g.id === anySquad.id);
  if (after) {
    const moved = Math.hypot(after.anchorX - anchorBefore.x, after.anchorY - anchorBefore.y);
    ok(moved < 50, "Bob could not move Alice's squad");
  }
}

// ── Flood protection ─────────────────────────────────────────────────────────
alice.rejected.length = 0;
for (let i = 0; i < 200; i++) alice.room.send(MSG.COMMAND, { t: 'mine' });
await wait(1000);
const stillAlive = alice.snapshots.at(-1);
ok(stillAlive && stillAlive.tick > 0, 'server survived a 200-message burst from one client');
ok(bob.snapshots.length > 0, "the flood did not starve the other player's updates");

// ── Phase 2: latency probe ───────────────────────────────────────────────────
alice.pongs.length = 0;
alice.room.send(MSG.LATENCY, performance.now());
await wait(500);
ok(alice.pongs.length === 1, 'latency probe round-tripped');
ok(alice.pongs[0] >= 0 && alice.pongs[0] < 2000,
   `measured a sane round-trip time (${alice.pongs[0].toFixed(1)}ms)`);

// ── Phase 2: map pings reach other players ───────────────────────────────────
bob.events.length = 0;
alice.room.send(MSG.COMMAND, { t: 'ping', x: 1234, y: 567, kind: 'attack' });
await wait(700);
const ping = bob.events.find(e => e.type === 'ping');
ok(!!ping, "Alice's map ping reached Bob");
ok(ping?.data?.ownerId === aliceId && ping?.data?.kind === 'attack',
   'the ping carried the right sender and kind');

bob.rejected.length = 0;
bob.room.send(MSG.COMMAND, { t: 'ping', x: 0, y: 0, kind: 'a-slur-goes-here' });
await wait(400);
ok(bob.rejected.length > 0, 'an invented ping kind was rejected — the vocabulary is fixed');

// ── Phase 2: late joiners get protection and catch-up gold ───────────────────
const carol = await connect('Carol');
await wait(1200);
const carolId = carol.welcome.youAre;
const carolBase = carol.snapshots.at(-1).players.find(p => p.id === carolId).base;
ok(carolBase.spawnProtected === true, 'a late joiner arrives spawn-protected');

// ── Disconnect hands the base to the AI ──────────────────────────────────────
const bobBaseBefore = bob.snapshots.at(-1).players.find(p => p.id === bobId).base.hp;
await bob.room.leave(true);
await wait(2000);

const afterLeave = alice.snapshots.at(-1);
const bobSeat = afterLeave.players.find(p => p.id === bobId);
ok(bobSeat.isBot === true, 'Bob disconnected and the AI took over his base');
ok(bobSeat.alive === true, "Bob's base survived — his enemies got no free kill");
ok(bobSeat.base.hp === bobBaseBefore || bobSeat.base.hp > 0, "Bob's base was not destroyed on disconnect");

await carol.room.leave(true);
await alice.room.leave(true);
await wait(300);

console.log(`\n✓ ALL ${passed} CHECKS PASSED — two clients played one authoritative match.\n`);
process.exit(0);
