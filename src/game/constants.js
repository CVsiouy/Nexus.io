// ─── World ───────────────────────────────────────────────────────────────────
export const WORLD_SIZE       = 6000;
export const MIN_NODE_DIST    = 120;  // denser node sites

// ─── Timing (ms) ─────────────────────────────────────────────────────────────
export const SPAWN_INTERVAL   = 4000;
export const CLAIM_TIME       = 5000;
export const ORPHAN_GRACE     = 30000;  // 30 seconds to reconnect orphaned nodes
export const LINK_REGEN_DELAY = 5000;
export const BOSS_INTERVAL    = 15 * 60 * 1000;
export const SPAWN_PROTECT    = 20000;
export const BOT_THINK_RATE   = 2000;

// ─── HP ──────────────────────────────────────────────────────────────────────
export const BASE_HP          = 1000;
export const NODE_HP          = 300;
export const LINK_HP          = 120;
export const BOSS_HP          = 5000;
export const LINK_REGEN_RATE  = 2;   // HP per second

// ─── Ranges ──────────────────────────────────────────────────────────────────
export const LINK_RANGE       = 550;  // wider — nodes reachable more easily
export const LINK_CAPACITY    = 3;
export const VISION_RADIUS    = 950;
export const ATTACK_RANGE     = 32;
export const CLAIM_RANGE      = 52;   // slightly wider claim radius
export const HARVEST_RANGE    = 42;
// Territory: no player may claim a node this close to an ENEMY claimed node or
// base. Keeps opponents from planting nodes inside your network.
export const NODE_TERRITORY_RANGE = 300;

// ─── Soldier definitions ──────────────────────────────────────────────────────
// pop     = population budget this unit consumes (cap is a budget, not a headcount)
// xpCost  = spendable XP to queue one
// spawnMs = time the base takes to produce one (higher tiers are slower)
export const SOLDIER_DEFS = {
  grunt:     { hp: 20, damage: 4,  speed: 80,  autoR: 130, color: 0xffffff,  xpGain: 2,  unlockLv: 1,  pop: 1, xpCost: 10, spawnMs: 2500 },
  harvester: { hp: 15, damage: 1,  speed: 52,  autoR: 90,  color: 0xffd700,  xpGain: 1,  unlockLv: 3,  pop: 1, xpCost: 15, spawnMs: 3200, xpMult: 1.75 },
  sentinel:  { hp: 45, damage: 6,  speed: 96,  autoR: 210, color: 0x3b82f6,  xpGain: 3,  unlockLv: 8,  pop: 2, xpCost: 35, spawnMs: 5000, defBonus: 1.5 },
  saboteur:  { hp: 15, damage: 3,  speed: 108, autoR: 90,  color: 0x1a1a1a,  xpGain: 3,  unlockLv: 8,  pop: 2, xpCost: 30, spawnMs: 4500, structMult: 2 },
  vanguard:  { hp: 50, damage: 9,  speed: 80,  autoR: 160, color: 0xfbbf24,  xpGain: 6,  unlockLv: 20, pop: 4, xpCost: 90, spawnMs: 8000 },
};

// ─── Economy ──────────────────────────────────────────────────────────────────
export const STARTING_XP    = 70;   // spendable XP each base starts with (opening force)
export const BASE_XP_INCOME = 0.5;  // passive spendable XP/sec from the base (anti-softlock)

// ─── Population & supply ──────────────────────────────────────────────────────
export const POP_BASE       = 8;    // base population budget
export const POP_PER_LEVEL  = 3;    // extra budget per base level
export const SUPPLY_RANGE    = 620;  // soldiers within this of base/owned node are supplied
export const SUPPLY_GRACE_MS = 6000; // time out of supply before attrition starts
export const ATTRITION_DPS   = 4;    // HP/sec lost while out of supply

// ─── Eatable definitions ──────────────────────────────────────────────────────
export const EATABLE_DEFS = {
  1: { xp: 1,  color: 0xfcd34d, shape: 'square',   sz: 7,  weight: 50 },
  2: { xp: 4,  color: 0xa855f7, shape: 'triangle', sz: 8,  weight: 30 },
  3: { xp: 12, color: 0x3b82f6, shape: 'square',   sz: 10, weight: 15 },
  4: { xp: 35, color: 0xef4444, shape: 'star',     sz: 13, weight: 5  },
};
export const EATABLE_TARGET   = 250;  // target eatable count on map
export const EATABLE_SPAWN_MS = 2500; // ms between spawn attempts

// ─── Level table ─────────────────────────────────────────────────────────────
export const LEVELS = [
  { lv:1,  xp:0 },
  { lv:2,  xp:50 },
  { lv:3,  xp:150,  unlock:'harvester' },
  { lv:4,  xp:300 },
  { lv:5,  xp:500,  linkSlots:4, linkRange:600 },  // never shrink below starting 550
  { lv:6,  xp:800 },
  { lv:7,  xp:1200 },
  { lv:8,  xp:1800, unlock:'sentinel,saboteur', autoBonus:1.25 },
  { lv:9,  xp:2600 },
  { lv:10, xp:3600 },
  { lv:11, xp:5000 },
  { lv:12, xp:7000, nodeReinforce:true },
  { lv:13, xp:9500 },
  { lv:14, xp:13000 },
  { lv:15, xp:17000, spec:true, linkSlots:5 },
  { lv:16, xp:22000 },
  { lv:17, xp:28000 },
  { lv:18, xp:35000 },
  { lv:19, xp:43000 },
  { lv:20, xp:52000, unlock:'vanguard', baseHpBonus:1.3 },
];

// ─── Skill points / buffs ─────────────────────────────────────────────────────
export const SKILL_PTS_PER_LEVEL = 1;    // points granted each level-up
export const BUFF_STEP            = 0.10; // +10% per point spent in a stat

// ─── Bots ─────────────────────────────────────────────────────────────────────
export const BOT_COUNT   = 10;
export const BOT_COLORS  = [
  0xff4444, 0xff8c00, 0xffd700, 0x44ff66,
  0x00ffcc, 0xff44dd, 0xff6699, 0x88ff44,
  0xff9944, 0x44ddff,
];
export const PLAYER_COLOR = 0x00bfff;

// ─── Camera / Vision ────────────────────────────────────────────────────────
export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2.5;
export const DEF_ZOOM = 1.1;  // (legacy) start zoom — no longer used for free cam

// Viewport is LOCKED to the active view (mother base or an active formation).
// The visible window radius = 65% of the base link-range. The camera cannot be
// freely scrolled/zoomed; it only shows this window around whatever you view.
export const VISION_FACTOR      = 0.65;                 // of base link-range
export const VISION_RADIUS_VIEW = LINK_RANGE * VISION_FACTOR; // ≈ 357px

// ─── Formations ───────────────────────────────────────────────────────────────
export const FORMATION_RADIUS   = 46;   // how tightly grunts cluster around center
export const FORMATION_SPEED     = 78;   // formation travel speed (world px/sec)
export const MERGE_DIST          = 70;   // two friendly formations this close → merge
export const FORMATION_VISION     = 240; // (reserved) a formation's own view radius
export const FORMATION_CLAIM_RANGE = 60; // formation center within this of a node → claim
