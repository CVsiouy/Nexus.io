// ─── World ───────────────────────────────────────────────────────────────────
export const WORLD_SIZE       = 6000;
export const MIN_NODE_DIST    = 145;

// ─── Timing (ms) ─────────────────────────────────────────────────────────────
export const SPAWN_INTERVAL   = 4000;
export const CLAIM_TIME       = 5000;
export const ORPHAN_GRACE     = 12000;
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
export const LINK_RANGE       = 420;
export const LINK_CAPACITY    = 3;
export const VISION_RADIUS    = 950;
export const ATTACK_RANGE     = 32;
export const CLAIM_RANGE      = 48;
export const HARVEST_RANGE    = 42;

// ─── Soldier definitions ──────────────────────────────────────────────────────
export const SOLDIER_DEFS = {
  grunt:     { hp: 20, damage: 4,  speed: 80,  autoR: 130, color: 0xffffff,  xpGain: 2,  unlockLv: 1  },
  harvester: { hp: 15, damage: 2,  speed: 110, autoR: 90,  color: 0xffd700,  xpGain: 1,  unlockLv: 3, xpMult: 1.75 },
  sentinel:  { hp: 35, damage: 5,  speed: 55,  autoR: 200, color: 0x60a5fa,  xpGain: 3,  unlockLv: 8, defBonus: 1.5  },
  saboteur:  { hp: 15, damage: 3,  speed: 110, autoR: 90,  color: 0xf472b6,  xpGain: 3,  unlockLv: 8, structMult: 2 },
  vanguard:  { hp: 50, damage: 9,  speed: 80,  autoR: 160, color: 0xfbbf24,  xpGain: 6,  unlockLv: 20 },
};

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
  { lv:5,  xp:500,  linkSlots:4, linkRange:500 },
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

// ─── Bots ─────────────────────────────────────────────────────────────────────
export const BOT_COUNT   = 10;
export const BOT_COLORS  = [
  0xff4444, 0xff8c00, 0xffd700, 0x44ff66,
  0x00ffcc, 0xff44dd, 0xff6699, 0x88ff44,
  0xff9944, 0x44ddff,
];
export const PLAYER_COLOR = 0x00bfff;

// ─── Camera ───────────────────────────────────────────────────────────────────
export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2.0;
export const DEF_ZOOM = 0.75;
