/**
 * Messages — what the server sends back, and the shared rules of the exchange.
 */

/**
 * Bumped whenever the message shapes change incompatibly. A client with an old
 * version is refused at the door with a clear reason, instead of connecting and
 * then misbehaving in confusing ways ten seconds later.
 */
export const PROTOCOL_VERSION = 1;

/** Simulation rate. 50ms per step = 20 steps per second. */
export const TICK_MS = 50;

/** How often the server sends the world to clients. Every 2nd tick = 10/second. */
export const SNAPSHOT_EVERY_TICKS = 2;

/**
 * Most a single client may send per second. A normal busy player issues one to
 * three commands a second; 30 is generous headroom while still stopping a
 * scripted client from flooding a room and starving the other seven players.
 */
export const COMMAND_RATE_LIMIT = 30;

/** Seats per match. Every number in constants.js is tuned for exactly 8 bases. */
export const SEATS = 8;

/** Hard cap on match length, so a stalemate between turtling players still ends. */
export const MATCH_LIMIT_MS = 20 * 60 * 1000;

/** How long a disconnected player's seat is held before it's given away. */
export const RECONNECT_GRACE_MS = 90 * 1000;

// ── Server → client ──────────────────────────────────────────────────────────

/** Sent once on join: who you are and what match you're in. */
export interface WelcomeMessage {
  protocol: number;
  /** Identifies this match, so feedback and telemetry can be joined up. */
  matchId: string;
  /** The in-game owner id of your base, e.g. "p3". Everything you own carries it. */
  youAre: string;
  /** Your seat index 0..7. */
  seat: number;
  mode: 'ffa' | 'team' | 'mining';
  /** Display names by owner id, so the HUD can show real players not "Bot 3". */
  names: Record<string, string>;
  /** Server time when the match began, for the match clock. */
  startedAt: number;
  phase: MatchPhase;
}

export type MatchPhase = 'live' | 'ended';

export interface RejectedMessage {
  /** Which command was refused, and why — shown to the player where useful. */
  cmd: string;
  reason: string;
}

export interface RoundEndMessage {
  /** Owner id of the winner, or null if the match timed out with no clear victor. */
  winner: string | null;
  reason: 'lastStanding' | 'timeLimit';
  standings: Array<{ id: string; name: string; xp: number; alive: boolean }>;
}

/** Somebody joined, left, or was taken over by the AI. */
export interface RosterMessage {
  names: Record<string, string>;
  /** Owner ids currently driven by the AI (either never human, or disconnected). */
  bots: string[];
}

/** Message names, kept in one place so client and server can't misspell them. */
export const MSG = {
  // client → server
  COMMAND: 'c',
  /** Latency probe: client sends a timestamp, server echoes it straight back. */
  LATENCY: 'l',
  // server → client
  WELCOME: 'w',
  SNAPSHOT: 's',
  EVENTS: 'e',
  REJECTED: 'r',
  ROUND_END: 'x',
  ROSTER: 'p',
} as const;

/** How often the client measures its round-trip time to the server. */
export const LATENCY_PROBE_MS = 2000;

// NOTE: late-join compensation (spawn protection scaling, catch-up gold) is
// game balance, not wire protocol — it lives in packages/sim/constants.js so
// all the tuning numbers stay in one file.
