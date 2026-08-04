import http from 'node:http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ArenaRoom } from './ArenaRoom.js';

/**
 * The game server.
 * ───────────────
 *
 * This is the backend: a plain Node program, completely separate from the
 * website. The browser downloads the frontend from a static host (a CDN) and
 * then opens a WebSocket to this — two different programs, deployable to two
 * different machines, which is exactly what we want for Phase 4.
 *
 * It listens for connections, puts players into matches, and runs those matches
 * authoritatively. It holds no per-player secrets and no persistent data, so
 * scaling up is just "run more copies of this".
 */

const PORT = Number(process.env.PORT ?? 2567);

const httpServer = http.createServer((req, res) => {
  // A tiny health endpoint. Load balancers and monitoring poll this to decide
  // whether the process is alive, and it's the easiest way to confirm from a
  // browser or curl that the backend is actually up.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      rooms: gameServer.presence ? undefined : undefined,
    }));
    return;
  }
  res.writeHead(404);
  res.end('Nexus.io game server. Connect over WebSocket.');
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// "arena" is the name the client asks to join. joinOrCreate('arena') finds a
// match with a free seat, or starts a new one — so a player never waits.
gameServer.define('arena', ArenaRoom)
  .filterBy(['mode']);   // never put a Team-mode player into an FFA match

gameServer.listen(PORT).then(() => {
  console.log(`[server] listening on ${PORT}`);
});

// Finish cleanly on shutdown so in-progress matches end tidily rather than
// every connection dropping at once.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    console.log(`[server] ${signal} — shutting down`);
    await gameServer.gracefullyShutdown();
    process.exit(0);
  });
}
