import {
  BASE_HP, SPAWN_PROTECT, SOLDIER_DEFS, TURRET_DEFS,
  STARTING_GOLD, EATABLE_DEFS, BOSS_HP,
  WILDLING_HP, WILDLING_DAMAGE, WILDLING_SPEED,
} from './constants.js';

// Every constructor now takes its `id` as the first argument, issued by the
// simulation's IdAllocator (state.ids.alloc()). Previously each one called a
// module-global uid() — see IdAllocator.js for why that had to change.

// ─── Base (mother base — a stationary gold miner) ──────────────────────────────
export class Base {
  constructor(id, ownerId, x, y) {
    this.id              = id;
    this.ownerId         = ownerId;
    this.position        = { x, y };
    this.hp              = BASE_HP;
    this.maxHp           = BASE_HP;
    this.level           = 1;
    this.gold            = STARTING_GOLD; // spendable gold (shared pool: turrets + soldiers)
    this.goldMult        = 1;             // mining multiplier (raised by the Prospector spec)
    this.mineLevel       = 0;             // purchased mining upgrades
    this.miningBonus     = 0;             // +gold/sec from those upgrades
    // How many rival mother bases this base has destroyed. Purely a record —
    // it grants no ongoing benefit. (It replaced `conquestGoldBonus`, which
    // gave permanent stacking income and produced runaway leaders.)
    this.conquests         = 0;

    // Permanent +gold/sec from bosses killed. This IS ongoing income, but
    // unlike the old per-kill bonus it is hard-bounded: only BOSS_COUNT bosses
    // ever exist, so the ceiling is fixed and known.
    this.bossBonus         = 0;
    this.lastAttackerId  = null;          // owner id of the last soldier to damage this base (kill credit)
    this.xp              = 0;             // spendable XP (unused for now; kept for parity)
    this.xpEarned        = 0;             // lifetime XP earned (drives leveling)
    this.specialization  = null;
    this.rotation        = 0;             // visual gear rotation (radians)
    this.spawnProtected  = true;
    this.protectTimer    = SPAWN_PROTECT;
    this.unlocked        = new Set(['grunt', 'sentinel']); // grunt + Defender(walls) from start
    this.lastAttackedAt  = -Infinity; // last time the base or its walls took damage

    // SEPARATE queues so soldiers and walls build in PARALLEL (neither blocks the
    // other). Each has its own build timer. Shape: [{ type, count }].
    this.soldierQueue    = [];
    this.wallQueue       = [];
    this.soldierBuildTimer = 0;
    this.wallBuildTimer    = 0;

    // Garrison: soldiers held inside the base (count), released together as a squad.
    this.garrison          = 0;

    // Turret build queue (dormant — turrets disabled for now). Shape: [{ type }].
    this.turretQueue     = [];

    // Defensive walls: concentric ring layers of static cells (see walls.js).
    this.walls           = [];

    // Skill points earned on level-up, spent on soldier buffs (see player.buffs).
    this.skillPoints     = 0;
  }
}

// ─── Soldier ──────────────────────────────────────────────────────────────────
// Soldiers no longer carry individual orders — they belong to a Group and follow
// its formation. `groupId` links them; `slot` is their index within the wedge.
export class Soldier {
  constructor(id, ownerId, type, x, y) {
    const def       = SOLDIER_DEFS[type];
    this.id         = id;
    this.ownerId    = ownerId;
    this.type       = type;
    this.position   = { x, y };
    this.hp         = def.hp;
    this.maxHp      = def.hp;
    this.damage     = def.damage;
    this.speed      = def.speed;
    this.autoR      = def.autoR;
    this.facing     = Math.random() * Math.PI * 2;
    this.pop        = def.pop ?? 1;
    this.atkCd      = 0;   // ms until next attack

    this.groupId    = null; // which Group this soldier belongs to
    this.slot       = 0;    // formation slot index within the group
    this.donateTo   = null; // (Team mode) teammate id this soldier is walking over to join

    // Where this soldier was at the start of the tick. Wall collision compares
    // the two to tell "walked through standing wall" from "already inside".
    this.prevX      = x;
    this.prevY      = y;
  }
}

// ─── Group (formation of soldiers — the unit the player commands) ──────────────
// status: 'idle' | 'moving' | 'attacking' | 'defending'
// An 'attacking' group is LOCKED: it cannot be recalled, split, merged or
// rebalanced until its target is destroyed or all its members die.
export class Group {
  constructor(id, ownerId, x, y) {
    this.id        = id;
    this.ownerId   = ownerId;
    this.memberIds = [];              // soldier ids, in slot order
    this.status    = 'idle';
    this.targetId  = null;            // base/soldier/boss id when attacking
    this.anchor    = { x, y };        // formation centre the members steer toward
    this.facing    = -Math.PI / 2;    // FIXED heading (apex up) — formations never rotate/spin
    // NOTE: `selected` used to live here. Selection is per-player interface
    // state, not game state — if it were shared, one player selecting a squad
    // would draw a selection ring on everyone else's screen. It now lives in
    // the client (apps/client/src/Selection.js).
    this.locked    = false;           // true while committed to an attack
    this.attackToken = null;          // soldier id currently allowed to strike (one-at-a-time)
    this.attackCd    = 0;             // ms pacing between the squad's turn-taking strikes
    this.defendNodeId = null;         // if set, this squad orbits/defends a mining node instead of the base
    // An explicit point to guard, used by squads with no mother base of their
    // own — currently the boss's garrison.
    this.guardPos     = null;
    this.formed      = false;         // true once it has reached a full 15 — then deployable even below 15
  }
}

// ─── Turret (auto-firing base defense) ─────────────────────────────────────────
export class Turret {
  constructor(id, ownerId, type, baseId, x, y, angle) {
    const def       = TURRET_DEFS[type];
    this.id         = id;
    this.ownerId    = ownerId;
    this.type       = type;
    this.baseId     = baseId;
    this.position   = { x, y };   // mounted point on the base ring
    this.angle      = angle;      // mount angle around the base (for drawing)
    this.range      = def.range;
    this.damage     = def.damage;
    this.cooldMs    = def.cooldMs;
    this.splash     = def.splash;
    this.cd         = 0;          // ms until next shot
    this.aimFacing  = angle;      // current barrel direction (radians)
  }
}

// ─── Projectile (turret shot) ───────────────────────────────────────────────────
export class Projectile {
  constructor(id, ownerId, type, x, y, vx, vy, damage, splash, color) {
    this.id       = id;
    this.ownerId  = ownerId;
    this.type     = type;
    this.position = { x, y };
    this.vx       = vx;
    this.vy       = vy;
    this.damage   = damage;
    this.splash   = splash;
    this.color    = color;
    this.life     = 2500; // ms before it fizzles
  }
}

// ─── Eatable (destructible XP shape in the centre) ─────────────────────────────
export class Eatable {
  constructor(id, type, x, y) {
    const def      = EATABLE_DEFS[type];
    this.id        = id;
    this.ownerId   = null;        // neutral — every soldier treats it as attackable
    this.type      = type;
    this.position  = { x, y };
    this.hp        = def.hp;
    this.maxHp     = def.hp;
    this.xpValue   = def.xp;
    this.pulse     = Math.random() * Math.PI * 2;
    this.rot       = Math.random() * Math.PI * 2;
  }
}

// ─── Wildling (neutral roaming unit in the centre) ─────────────────────────────
export class Wildling {
  constructor(id, x, y) {
    this.id       = id;
    this.ownerId  = 'neutral';
    this.position = { x, y };
    this.hp       = WILDLING_HP;
    this.maxHp    = WILDLING_HP;
    this.damage   = WILDLING_DAMAGE;
    this.speed    = WILDLING_SPEED;
    this.atkCd    = 0;
    this.facing   = Math.random() * Math.PI * 2;
    this.wander   = { x, y };        // current roam target
    this.rot      = 0;
  }
}

// ─── MineNode (capturable gold node — Mining mode) ─────────────────────────────
export class MineNode {
  constructor(id, x, y) {
    this.id           = id;
    this.position     = { x, y };
    this.ownerId      = null;   // null = neutral; else the capturing player's id
    this.capturingBy  = null;   // owner id currently making capture progress
    this.captureProg  = 0;      // 0..1
    this.spawnTimer   = 0;      // ms toward growing a defender
    this.goldRate     = 0;      // current gold/sec (scales with garrison)
    this.rot          = Math.random() * Math.PI * 2;
  }
}

// ─── Boss (a fortified neutral objective, not a roaming monster) ───────────────
//
// It never moves, never heals, and never rebuilds its wall. It grows a small
// garrison on a slow timer and otherwise just sits there being worth taking.
export class Boss {
  constructor(id, x, y, index = 0) {
    this.id         = id;
    this.ownerId    = 'boss';     // so areEnemies() treats it as hostile to all
    this.index      = index;      // 0, 1 — which boss this is
    this.position   = { x, y };
    this.hp         = BOSS_HP;
    this.maxHp      = BOSS_HP;
    this.rotation   = 0;
    this.damage     = 18;
    this.atkCd      = 0;

    /** One ring, built once at spawn. Never repaired, never extended. */
    this.walls      = [];

    this.spawnTimer = 0;          // ms toward the next defensive squad
    this.squadsMade = 0;
    this.lastAttackedAt = -Infinity;
    this.contrib    = new Map();  // playerId → damage dealt (for the XP split)
  }
}
