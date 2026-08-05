import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

/**
 * Match telemetry — turning "was it fun?" into something measurable.
 * ────────────────────────────────────────────────────────────────
 *
 * A playtest usually produces opinions: "it felt like Ravi just ran away with
 * it". Opinions are worth having, but they don't tell you WHICH number to
 * change, or by how much.
 *
 * MULTIPLAYER_PLAN.md §11.6 names one specific fear: CONQUEST_INCOME_BONUS
 * gives +2 gold/second permanently for every base you destroy, and stacks. The
 * worry is a runaway leader — whoever gets the first kill earns faster, so they
 * get the second kill more easily, and by minute eight the other seven players
 * are playing out a decided match.
 *
 * That is a *testable claim*, not a matter of taste. This records what actually
 * happened in each match, so `analyse.mjs` can answer:
 *
 *   • Does whoever draws first blood usually win?
 *   • How far ahead is the leader over time, and when does the gap become
 *     unrecoverable?
 *   • Do matches end by elimination, or grind to the 20-minute timeout?
 *   • How long do eliminated players sit there spectating?
 *
 * One JSON object per line (JSONL). It appends, never rewrites, so a crash
 * cannot cost you earlier matches.
 */

/** Where to sample the economy, so we can see a gap opening. Every 15 seconds. */
export const SAMPLE_EVERY_MS = 15_000;

export interface PlayerSample {
  seat: number;
  gold: number;
  xp: number;
  level: number;
  soldiers: number;
  alive: boolean;
}

export interface MatchSample {
  atMs: number;
  players: PlayerSample[];
}

export interface MatchRecord {
  matchId: string;
  mode: string;
  endedAt: string;
  durationMs: number;
  reason: 'lastStanding' | 'timeLimit';
  humanCount: number;
  players: Array<{
    seat: number;
    name: string;
    isBot: boolean;
    wasHuman: boolean;
    xp: number;
    level: number;
    alive: boolean;
    /** When their base fell, in match time. null if they survived. */
    eliminatedAtMs: number | null;
    /** Owner id of whoever destroyed them, if any. */
    eliminatedBy: string | null;
    /** How many rival bases this player destroyed. */
    conquests: number;
  }>;
  /** Economy over time — this is what reveals a snowball. */
  samples: MatchSample[];
}

import { config } from './config.js';

const DIR = config.telemetryDir;
const FILE = path.join(DIR, 'matches.jsonl');

let warned = false;

export function recordMatch(record: MatchRecord): void {
  // Always log it too, so telemetry survives even without a writable volume.
  log.info('match recorded', {
    matchId: record.matchId,
    reason: record.reason,
    durationSec: Math.round(record.durationMs / 1000),
    humans: record.humanCount,
  });

  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    // Never let telemetry break a match. Warn once, then stay quiet.
    if (!warned) {
      warned = true;
      log.warn('could not write telemetry — continuing without it', {
        file: FILE, err: String((err as Error)?.message ?? err),
      });
    }
  }
}

// ── Feedback ─────────────────────────────────────────────────────────────────

export interface FeedbackRecord {
  at: string;
  matchId: string | null;
  rating: number;          // 1..5
  comment: string;
  /** What the player experienced, so a complaint can be read in context. */
  context: {
    won: boolean | null;
    survivedMs: number | null;
    ping: number | null;
  };
}

const FEEDBACK_FILE = path.join(DIR, 'feedback.jsonl');

export function recordFeedback(fb: FeedbackRecord): void {
  log.info('feedback', { rating: fb.rating, comment: fb.comment.slice(0, 120) });
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(fb) + '\n', 'utf8');
  } catch (err) {
    log.warn('could not write feedback', { err: String((err as Error)?.message ?? err) });
  }
}

/** Validate an untrusted feedback payload from a browser. */
export function parseFeedback(raw: unknown): FeedbackRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;

  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return null;

  const comment = typeof b.comment === 'string' ? b.comment.slice(0, 1000) : '';
  const matchId = typeof b.matchId === 'string' ? b.matchId.slice(0, 64) : null;

  const ctx = (typeof b.context === 'object' && b.context !== null)
    ? b.context as Record<string, unknown> : {};

  return {
    at: new Date().toISOString(),
    matchId,
    rating,
    comment,
    context: {
      won: typeof ctx.won === 'boolean' ? ctx.won : null,
      survivedMs: Number.isFinite(Number(ctx.survivedMs)) ? Number(ctx.survivedMs) : null,
      ping: Number.isFinite(Number(ctx.ping)) ? Math.round(Number(ctx.ping)) : null,
    },
  };
}
