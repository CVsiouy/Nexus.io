import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';

/**
 * Metrics — knowing something is wrong before your players tell you.
 * ────────────────────────────────────────────────────────────────
 *
 * Once real people are playing, "is it working?" stops being answerable by
 * looking at it. This exposes a `/metrics` page in the format Prometheus reads,
 * which Grafana then draws as graphs and fires alerts from. Both have free
 * tiers that comfortably cover this game's size.
 *
 * THE ONE NUMBER THAT MATTERS MOST is tick duration. The server must finish
 * simulating every room within its 50ms budget. If the 99th percentile starts
 * climbing toward 50ms, matches are about to start running slow for everyone on
 * that machine — and that shows up here long before a player notices and
 * complains.
 *
 * Everything is prefixed `basewar_` so it can't collide with the default Node
 * metrics (heap size, garbage-collection pauses, event-loop lag) that are
 * collected alongside it.
 */

export const registry = new Registry();

// Node process health: memory, GC pauses, event-loop lag. A memory leak or a
// GC problem shows up in these first, and they cost nothing to collect.
collectDefaultMetrics({ register: registry, prefix: 'basewar_node_' });

/**
 * How long it takes to advance one match by one tick.
 *
 * Buckets are chosen around the 50ms budget: most ticks should land in the
 * sub-millisecond buckets, and anything past 25ms means we are running out of
 * headroom.
 */
export const tickDuration = new Histogram({
  name: 'basewar_tick_duration_ms',
  help: 'Time to advance one match by one simulation tick, in milliseconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100],
  registers: [registry],
});

/** Time spent packing a snapshot into bytes — the other per-tick cost. */
export const encodeDuration = new Histogram({
  name: 'basewar_encode_duration_ms',
  help: 'Time to encode one snapshot, in milliseconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25],
  registers: [registry],
});

export const roomsActive = new Gauge({
  name: 'basewar_rooms_active',
  help: 'Matches currently running on this process',
  registers: [registry],
});

export const playersConnected = new Gauge({
  name: 'basewar_players_connected',
  help: 'Human players currently connected to this process',
  registers: [registry],
});

export const botsActive = new Gauge({
  name: 'basewar_bots_active',
  help: 'Seats currently driven by the AI (never claimed, or disconnected)',
  registers: [registry],
});

/**
 * Bytes of snapshot sent. Divide by players to get per-player bandwidth — the
 * number that decides the hosting bill (see §12 of MULTIPLAYER_PLAN.md).
 */
export const snapshotBytes = new Counter({
  name: 'basewar_snapshot_bytes_total',
  help: 'Total snapshot bytes broadcast',
  registers: [registry],
});

export const snapshotsSent = new Counter({
  name: 'basewar_snapshots_total',
  help: 'Snapshots broadcast, by kind',
  labelNames: ['kind'] as const,
  registers: [registry],
});

/**
 * Commands by outcome. A sudden spike in rejections means either a bug in a
 * released client or somebody probing the server — both worth knowing about.
 */
export const commands = new Counter({
  name: 'basewar_commands_total',
  help: 'Player commands received, by outcome',
  labelNames: ['result'] as const,   // accepted | refused | malformed | ratelimited
  registers: [registry],
});

export const roomErrors = new Counter({
  name: 'basewar_room_errors_total',
  help: 'Simulation ticks that threw. Should be zero.',
  registers: [registry],
});

export const matchesCompleted = new Counter({
  name: 'basewar_matches_completed_total',
  help: 'Matches that finished, by how they ended',
  labelNames: ['reason'] as const,   // lastStanding | timeLimit
  registers: [registry],
});

export const joins = new Counter({
  name: 'basewar_joins_total',
  help: 'Join attempts, by outcome',
  labelNames: ['result'] as const,   // ok | full | protocolMismatch
  registers: [registry],
});

export const disconnects = new Counter({
  name: 'basewar_disconnects_total',
  help: 'Players leaving, by kind',
  labelNames: ['kind'] as const,     // consented | dropped | reconnected | abandoned
  registers: [registry],
});

/**
 * Nudge a gauge by a signed amount.
 *
 * prom-client's Gauge has separate inc/dec, so this saves every caller from
 * branching on the sign. Rooms use it to adjust process-wide totals by their
 * own delta rather than overwriting them.
 */
export function applyDelta(gauge: Gauge<string>, delta: number): void {
  if (delta > 0) gauge.inc(delta);
  else if (delta < 0) gauge.dec(-delta);
}

/** Render everything in the text format Prometheus scrapes. */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
