/**
 * Verifies the WebSocket origin allowlist.
 *
 * WHY THIS MATTERS: without it, anyone can host a copy of the client on their
 * own website, point it at your game servers, and you pay for every byte their
 * visitors use. The server has no way to bill them and no way to notice, so the
 * check has to happen at the door.
 *
 * Run against a server started with ALLOWED_ORIGINS set:
 *   docker compose exec server npx tsx test/origin.mjs
 *
 * The target defaults to a separate instance so this can be run without
 * reconfiguring the development server.
 */
import { Client } from 'colyseus.js';

const URL = process.env.ORIGIN_TEST_URL || 'ws://origintest:2567';
let failures = 0;

const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failures++; };

async function tryJoin(label) {
  try {
    const room = await new Client(URL).joinOrCreate('arena', {
      mode: 'ffa', name: 'Probe', protocol: 1,
    });
    await room.leave(true);
    return { joined: true };
  } catch (err) {
    return { joined: false, reason: String(err?.message ?? err) };
  }
}

console.log(`\nProbing ${URL} (ALLOWED_ORIGINS is set on that server)\n`);

// A Node client sends no Origin header, which is exactly what a scraper, a bot,
// or a rehosted client would look like. It must be refused.
const r = await tryJoin('no origin header');
if (r.joined) {
  bad('a client with NO origin header was allowed in — the allowlist is not working');
} else {
  ok(`client with no origin header was refused (${r.reason.slice(0, 60)})`);
}

if (failures) {
  console.error(`\n✗ ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\n✓ origin allowlist is enforced\n');
process.exit(0);
