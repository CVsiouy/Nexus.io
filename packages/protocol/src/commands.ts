/**
 * Commands — everything a player is allowed to ask the game to do.
 * ───────────────────────────────────────────────────────────────
 *
 * These travel client → server. They are the ONLY way a player can affect the
 * game, which is what makes cheating structurally impossible: the browser never
 * says "I now have 5000 gold", it says "I would like to buy an upgrade", and
 * the server decides.
 *
 * This file is TypeScript on purpose. It is the one place client and server
 * must agree exactly, and a silent disagreement here (client sends `unit`,
 * server reads `type`) would not crash anything — it would just quietly not
 * work, which is far harder to debug than an error.
 *
 * Everything here arrives from a stranger's browser and is therefore hostile
 * until validated. `validateCommand` below is the front door.
 */

export type UnitType   = 'grunt' | 'sentinel' | 'saboteur' | 'vanguard';
export type TurretKind = 'gun' | 'missile';
export type SkillStat  = 'atk' | 'def' | 'spd';
export type SpecChoice = 'bastion' | 'warmonger' | 'prospector';
export type PingKind   = 'attack' | 'defend' | 'help' | 'retreat';

/** Entity ids are plain numbers (see packages/sim/IdAllocator.js). */
export type EntityId = number;

export type Command =
  | { t: 'queue';      unit: UnitType; n: 1 | -1 }
  | { t: 'turret';     kind: TurretKind }
  | { t: 'mine' }
  | { t: 'skill';      stat: SkillStat }
  | { t: 'spec';       choice: SpecChoice }
  | { t: 'release' }
  | { t: 'move';       g: EntityId[]; x: number; y: number }
  | { t: 'attack';     g: EntityId[]; target: EntityId }
  | { t: 'defend';     g: EntityId[] }
  | { t: 'defendNode'; g: EntityId[]; node: EntityId }
  | { t: 'split';      g: EntityId }
  | { t: 'merge';      g: EntityId }
  | { t: 'balance' }
  | { t: 'donate';     g: EntityId; to: string }
  | { t: 'ping';       x: number; y: number; kind: PingKind };

export type CommandType = Command['t'];

// ── Validation ───────────────────────────────────────────────────────────────

const UNITS   = new Set<string>(['grunt', 'sentinel', 'saboteur', 'vanguard']);
const TURRETS = new Set<string>(['gun', 'missile']);
const STATS   = new Set<string>(['atk', 'def', 'spd']);
const SPECS   = new Set<string>(['bastion', 'warmonger', 'prospector']);
const PINGS   = new Set<string>(['attack', 'defend', 'help', 'retreat']);

/** A squad order may never name more than this many squads in one message. */
export const MAX_GROUPS_PER_COMMAND = 32;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isId  = (v: unknown): v is EntityId => isNum(v) && v >= 0 && v <= 65535 && Number.isInteger(v);

function idList(v: unknown): EntityId[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_GROUPS_PER_COMMAND) return null;
  const out: EntityId[] = [];
  for (const x of v) { if (!isId(x)) return null; out.push(x); }
  return out;
}

/**
 * Turn untrusted input into a Command, or null if it is malformed.
 *
 * This is deliberately strict and total: anything not explicitly allowed is
 * rejected. A rejected command is dropped, never partially applied — a
 * half-understood message is worse than no message.
 *
 * Note this only checks the SHAPE of the message. Whether the player can
 * actually afford it, owns that squad, or is still alive is decided by the
 * simulation (Simulation.applyCommand), because only it knows the game state.
 */
export function validateCommand(raw: unknown): Command | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;

  switch (c.t) {
    case 'queue':
      if (typeof c.unit !== 'string' || !UNITS.has(c.unit)) return null;
      if (c.n !== 1 && c.n !== -1) return null;
      return { t: 'queue', unit: c.unit as UnitType, n: c.n };

    case 'turret':
      if (typeof c.kind !== 'string' || !TURRETS.has(c.kind)) return null;
      return { t: 'turret', kind: c.kind as TurretKind };

    case 'mine':    return { t: 'mine' };
    case 'release': return { t: 'release' };
    case 'balance': return { t: 'balance' };

    case 'skill':
      if (typeof c.stat !== 'string' || !STATS.has(c.stat)) return null;
      return { t: 'skill', stat: c.stat as SkillStat };

    case 'spec':
      if (typeof c.choice !== 'string' || !SPECS.has(c.choice)) return null;
      return { t: 'spec', choice: c.choice as SpecChoice };

    case 'move': {
      const g = idList(c.g);
      if (!g || !isNum(c.x) || !isNum(c.y)) return null;
      // Coordinates are clamped to the map by the simulation, so a wild value
      // here is harmless — but NaN/Infinity are not, hence isNum.
      return { t: 'move', g, x: c.x, y: c.y };
    }

    case 'attack': {
      const g = idList(c.g);
      if (!g || !isId(c.target)) return null;
      return { t: 'attack', g, target: c.target };
    }

    case 'defend': {
      const g = idList(c.g);
      if (!g) return null;
      return { t: 'defend', g };
    }

    case 'defendNode': {
      const g = idList(c.g);
      if (!g || !isId(c.node)) return null;
      return { t: 'defendNode', g, node: c.node };
    }

    case 'split':
      if (!isId(c.g)) return null;
      return { t: 'split', g: c.g };

    case 'merge':
      if (!isId(c.g)) return null;
      return { t: 'merge', g: c.g };

    case 'donate':
      if (!isId(c.g) || typeof c.to !== 'string' || c.to.length > 16) return null;
      return { t: 'donate', g: c.g, to: c.to };

    case 'ping':
      if (!isNum(c.x) || !isNum(c.y)) return null;
      if (typeof c.kind !== 'string' || !PINGS.has(c.kind)) return null;
      return { t: 'ping', x: c.x, y: c.y, kind: c.kind as PingKind };

    default:
      return null;
  }
}
