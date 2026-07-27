import { uid } from '../utils/helpers.js';
import {
  BASE_HP, NODE_HP, LINK_HP,
  LINK_RANGE, LINK_CAPACITY, VISION_RADIUS,
  SPAWN_PROTECT, SOLDIER_DEFS, EATABLE_DEFS, STARTING_XP,
} from './constants.js';

// ─── Base ─────────────────────────────────────────────────────────────────────
export class Base {
  constructor(ownerId, x, y) {
    this.id              = uid();
    this.ownerId         = ownerId;
    this.position        = { x, y };
    this.hp              = BASE_HP;
    this.maxHp           = BASE_HP;
    this.level           = 1;
    this.xp              = STARTING_XP; // spendable XP balance (spent to queue soldiers)
    this.xpEarned        = 0;           // lifetime XP earned (drives leveling; never spent)
    this.linkCapacity    = LINK_CAPACITY;
    this.linkRange       = LINK_RANGE;
    this.visionRadius    = VISION_RADIUS;
    this.specialization  = null;
    this.spawnTimer      = 0;      // ms countdown to next soldier
    this.rotation        = 0;     // visual gear rotation (radians)
    this.spawnProtected  = true;
    this.protectTimer    = SPAWN_PROTECT;
    this.unlocked        = new Set(['grunt']); // available soldier types

    // Spawn queue: player clicks a unit N times to enqueue N of it. The base
    // produces them one at a time (each unit's own spawnMs), decrementing the
    // count. FIFO across types so a mixed queue builds in click order.
    // Shape: [{ type, count }] — bots leave this empty and auto-spawn instead.
    this.spawnQueue      = [];
    this.buildTimer      = 0;   // ms accumulated toward the current unit's spawnMs

    // Skill points earned on level-up, spent on soldier buffs (see player.buffs).
    this.skillPoints     = 0;
  }
}

// ─── GraphNode ────────────────────────────────────────────────────────────────
export class GraphNode {
  constructor(x, y) {
    this.id               = uid();
    this.ownerId          = null;
    this.position         = { x, y };
    this.hp               = NODE_HP;
    this.maxHp            = NODE_HP;
    this.reinforced       = false;
    this.status           = 'unclaimed'; // unclaimed | claimed | orphaned | neutral
    this.orphanedAt       = null;
    this.claimerSoldierId = null;
    this.claimProgress    = 0;           // 0..1
    this.prodTimer        = 0;           // reinforced node production timer
  }
}

// ─── Link ─────────────────────────────────────────────────────────────────────
export class Link {
  constructor(ownerId, fromId, toId) {
    this.id             = uid();
    this.ownerId        = ownerId;
    this.fromId         = fromId; // Base or GraphNode id
    this.toId           = toId;   // GraphNode id
    this.hp             = LINK_HP;
    this.maxHp          = LINK_HP;
    this.lastDamagedAt  = -Infinity;
  }
}

// ─── Soldier ──────────────────────────────────────────────────────────────────
export class Soldier {
  constructor(ownerId, type, x, y) {
    const def       = SOLDIER_DEFS[type];
    this.id         = uid();
    this.ownerId    = ownerId;
    this.type       = type;
    this.position   = { x, y };
    this.hp         = def.hp;
    this.maxHp      = def.hp;
    this.damage     = def.damage;
    this.speed      = def.speed;
    this.autoR      = def.autoR;
    this.order      = { kind: 'idle', targetId: null, position: null };
    this.selected   = false;
    this.atkCd      = 0;   // ms until next attack
    this.facing     = Math.random() * Math.PI * 2;
    this.pop        = def.pop ?? 1;   // population budget this unit consumes

    // Stationing: a stationed soldier holds guardPos, auto-defends, and returns
    // to the post after a fight. Freshly-spawned soldiers are NOT stationed
    // (they idle near the base as free reserves the Rally button can grab).
    this.stationed  = false;
    this.guardPos   = null;

    this.outOfSupplyMs = 0; // time spent away from the network (drives attrition)
  }
}

// ─── Eatable ─────────────────────────────────────────────────────────────────
export class Eatable {
  constructor(type, x, y) {
    const def       = EATABLE_DEFS[type];
    this.id         = uid();
    this.type       = type;
    this.position   = { x, y };
    this.xpValue    = def.xp;
    this.pulse      = Math.random() * Math.PI * 2; // animation phase
  }
}

// ─── Boss ─────────────────────────────────────────────────────────────────────
export class Boss {
  constructor(x, y) {
    this.id         = uid();
    this.position   = { x, y };
    this.hp         = 5000;
    this.maxHp      = 5000;
    this.speed      = 28;
    this.rotation   = 0;
    this.damage     = 18;
    this.atkCd      = 0;
    this.contrib    = new Map(); // playerId → damage dealt (for XP split)
  }
}
