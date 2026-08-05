import http from 'node:http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ArenaRoom } from './ArenaRoom.js';
import { config, validateConfig } from './config.js';
import { log } from './log.js';
import { renderMetrics, metricsContentType } from './metrics.js';
import { parseFeedback, recordFeedback } from './telemetry.js';

/**
 * The game server.
 * ───────────────
 *
 * This is the backend: a plain Node program, completely separate from the
 * website. The browser downloads the frontend from a static host (a CDN) and
 * then opens a WebSocket to this — two different programs, deployable to two
 * different machines.
 *
 * It holds no persistent data and no per-player secrets, so scaling up is
 * literally "run more copies of this".
 *
 * HTTP endpoints:
 *   /health   is the process alive?            (load balancers, uptime checks)
 *   /ready    should it receive new players?   (goes false during shutdown)
 *   /metrics  numbers for Prometheus/Grafana
 */

let shuttingDown = false;

const httpServer = http.createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  // The frontend is on a different domain from the backend, so the browser
  // blocks POSTs to it unless we explicitly allow that origin. Only the sites
  // in ALLOWED_ORIGINS are permitted (any origin in development).
  const origin = req.headers.origin;
  if (origin && (config.allowedOrigins.length === 0 || config.allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.writeHead(204);
    return res.end();
  }

  // Player feedback from the end-of-match screen. Anonymous, no account needed.
  if (url === '/feedback' && req.method === 'POST') {
    // Cap the body: an unbounded read is a trivial way to exhaust memory.
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return json(res, 413, { error: 'too large' });
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
      const fb = parseFeedback(parsed);
      if (!fb) return json(res, 400, { error: 'bad feedback' });
      recordFeedback(fb);
      json(res, 200, { ok: true });
    });
    return;
  }

  if (url === '/health') {
    return json(res, 200, {
      ok: true,
      node: config.nodeName,
      region: config.region,
      uptimeSec: Math.round(process.uptime()),
    });
  }

  // Kept separate from /health on purpose. During a graceful shutdown the
  // process is still alive and finishing its matches (healthy), but must stop
  // being sent new players (not ready).
  if (url === '/ready') {
    return json(res, shuttingDown ? 503 : 200, { ready: !shuttingDown });
  }

  if (url === '/metrics') {
    if (!config.metricsEnabled) return json(res, 404, { error: 'metrics disabled' });
    res.writeHead(200, { 'Content-Type': metricsContentType });
    return res.end(await renderMetrics());
  }

  json(res, 404, { error: 'Nexus.io game server. Connect over WebSocket.' });
});

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// "arena" is the name the client asks to join. joinOrCreate('arena') finds a
// match with a free seat, or starts a new one — so a player never waits.
gameServer.define('arena', ArenaRoom)
  .filterBy(['mode']);   // never put a Team-mode player into an FFA match

validateConfig((msg) => log.warn(msg));

gameServer.listen(config.port).then(() => {
  log.info('server listening', {
    port: config.port,
    env: config.env,
    origins: config.allowedOrigins.length ? config.allowedOrigins.join(',') : '(any — development only)',
  });
});

/**
 * Graceful shutdown.
 *
 * Matches are capped at 20 minutes (MATCH_LIMIT_MS), so on a deploy we stop
 * accepting new players and let the running matches finish naturally rather
 * than cutting eight people off mid-game. New matches go to the new version.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down — no longer accepting new players', { signal });
    await gameServer.gracefullyShutdown();
    log.info('shutdown complete');
    process.exit(0);
  });
}

// A crash must be loud. Silently continuing after an unhandled rejection is how
// a server ends up serving subtly broken matches for hours.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled promise rejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  log.error('uncaught exception — exiting', { err: err?.stack ?? String(err) });
  process.exit(1);
});
