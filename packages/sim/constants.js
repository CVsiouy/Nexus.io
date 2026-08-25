// ─── World ───────────────────────────────────────────────────────────────────
// Bases sit in a ring; the tight camera (see below) means you only ever see a
// small slice of this. Larger map + wider spacing gives room to build walls and
// time to react before an enemy squad arrives.
export const WORLD_SIZE       = 2800;
// The middle of the map is a neutral zone: no bases spawn here. It holds XP
// "eatables" and roaming neutral units (see below) — a diep.io-style hunting ground.
export const CENTER_RADIUS    = 560;

// ─── Timing (ms) ─────────────────────────────────────────────────────────────
export const BOSS_INTERVAL    = 15 * 60 * 1000;
export const SPAWN_PROTECT    = 20000;
export const BOT_THINK_RATE   = 2000;

// ─── Late-join compensation (multiplayer) ─────────────────────────────────────
// Someone joining a match at minute 12 lands next to bases that have had twelve
// minutes to level up and build walls. A flat 20s of protection is right when
// everyone starts together and useless when you don't, so both the protection
// and a little starting gold scale with how late you arrived.
export const LATE_JOIN_PROTECT_BASE_MS    = 20000;
export const LATE_JOIN_PROTECT_PER_MIN_MS = 2000;
export const LATE_JOIN_PROTECT_MAX_MS     = 60000;
export const LATE_JOIN_GOLD_PER_MIN       = 40;
export const LATE_JOIN_GOLD_MAX           = 600;

// ─── HP ──────────────────────────────────────────────────────────────────────
export const BASE_HP          = 10000; // mother base is a fortress (all modes)
// ─── Bosses ───────────────────────────────────────────────────────────────────
//
// A boss is a fortified neutral objective sitting in the middle of the map, not
// a monster that wanders over and hits you. It:
//   • never moves
//   • starts with one ring of wall it can never repair or rebuild
//   • grows a small defensive garrison on a slow timer, purely to defend itself
//   • has no economy, no healing, and no wall repair
//
// Killing one is worth permanent income, which makes the centre of the map
// worth fighting over — and worth fighting over EARLY, since whoever takes a
// boss compounds that advantage for the rest of the match.
export const BOSS_HP           = 14000;
export const BOSS_COUNT        = 2;                 // start with two
export const BOSS_FIRST_MS     = 3.5 * 60 * 1000;   // first appears at 3m30
export const BOSS_STAGGER_MS   = 4 * 60 * 1000;     // the second, this much later
export const BOSS_SPREAD       = 260;               // how far each sits from map centre

/** Its wall: one ring, deliberately softer than a player's, never repaired. */
export const BOSS_WALL_CELLS    = 12;
export const BOSS_WALL_RADIUS   = 96;
export const BOSS_WALL_CELL_HP  = 5200;

/**
 * Its garrison: purely defensive, but individually tougher than anything a
 * player fields. Two squads of ordinary grunts made a boss a formality — one
 * player squad could walk in and take it. These are elite guards, so cracking a
 * boss is a real commitment rather than a detour.
 */
export const BOSS_SQUAD_SIZE     = 5;
export const BOSS_SQUAD_INTERVAL_MS = 40000;
export const BOSS_MAX_SQUADS     = 3;     // up to 24 guards, grown over ~2.5 min
export const BOSS_SOLDIER_HP_MULT  = 2; // each guard is worth ~2.4 grunts of HP
export const BOSS_SOLDIER_DMG_MULT = 1.5;

/**
 * Permanent income granted to whoever lands the killing blow.
 *
 * Two schemes, chosen by BOSS_REWARD_SCALED:
 *
 *   false — flat: always BOSS_GOLD_REWARD, whoever you are.
 *   true  — tapered: the full amount if you are still poor, a reduced amount
 *           once your income is already above BOSS_REWARD_RICH_AT. Rewards the
 *           kill either way, but stops the player who is already winning from
 *           compounding hardest off the same objective.
 */
export const BOSS_GOLD_REWARD      = 2;    // gold/sec, forever — bounded by BOSS_COUNT
export const BOSS_GOLD_REWARD_RICH = 1;    // …if already wealthy (scaled scheme)
export const BOSS_REWARD_RICH_AT   = 6;    // gold/sec that counts as "already wealthy"
export const BOSS_REWARD_SCALED    = true;
export const BOSS_XP_REWARD        = 400;
// Mother base slowly heals if it hasn't been hit for a while.
// NOTE: healing this fast means a battered base is back to full in about a
// minute, so damage only counts if you finish the job in one push. That looked
// like the cause of stalled endgames, but slowing it to 70 HP/sec over 30 bot
// matches changed the resolution rate by exactly nothing — so it was reverted
// rather than kept on a hunch. Still worth revisiting against HUMAN play,
// where follow-up assaults are better coordinated than a bot manages.
export const BASE_HP_REGEN_DELAY = 20000; // ms of calm before the base heals
export const BASE_HP_REGEN_RATE  = 220;   // HP/sec healed

// ─── Ranges ──────────────────────────────────────────────────────────────────
export const ATTACK_RANGE     = 32;

// ─── Soldier definitions ──────────────────────────────────────────────────────
// pop     = population budget this unit consumes (cap is a budget, not a headcount)
// cost    = GOLD spent to queue one (shared gold pool — see Economy)
// spawnMs = time the base takes to produce one
// unlockLv= base level at which the unit becomes buyable
// color = the unit's own tint (used for the saboteur's black body); most units
// render in their owner's colour — see GameRenderer._drawSoldiers.
export const SOLDIER_DEFS = {
  grunt:    { hp: 20, damage: 4,  speed: 80,  autoR: 130, color: 0xffffff, xpGain: 2, unlockLv: 1,  pop: 1, cost: 25,  spawnMs: 2500 },
  // 'sentinel' is the DEFENDER (a static wall cell — see walls.js). Available from the start.
  sentinel: { hp: 45, damage: 6,  speed: 96,  autoR: 210, color: 0x3b82f6, xpGain: 3, unlockLv: 1,  pop: 2, cost: 40,  spawnMs: 3000, defBonus: 1.5 },
  saboteur: { hp: 15, damage: 3,  speed: 108, autoR: 90,  color: 0x1a1a1a, xpGain: 3, unlockLv: 8,  pop: 2, cost: 60,  spawnMs: 4500, structMult: 2 },
  vanguard: { hp: 50, damage: 9,  speed: 80,  autoR: 160, color: 0xfbbf24, xpGain: 6, unlockLv: 20, pop: 4, cost: 180, spawnMs: 8000 },
};

// ─── Combat tuning ─────────────────────────────────────────────────────────────
// Radii used for range checks & the surround ring when a squad assaults a target.
export const BASE_RADIUS    = 44;
export const BOSS_RADIUS    = 40;
export const SOLDIER_RADIUS = 10;
// Muster/defense ring around a mother base (~3× its size). Soldiers stationed
// inside it shield the base: enemies must kill them before they can hit the base.
export const BASE_DEFENSE_RADIUS = 160;
// Defender's advantage — REMOVED for players.
//
// A defending squad used to hit 1.1× and take 0.82×, a net ~1.34× edge, so an
// equal force always lost on attack. Combined with walls that made attacking
// even worse, the stable strategy was to sit still, and matches stopped
// resolving. Attacking is now decided by numbers, positioning and walls alone —
// all things a player controls — rather than by a hidden stance multiplier.
//
// 1.0 rather than deleting the terms: walls, base defence radius and the bot's
// force budget all reason in units of "how many attackers is a defender worth",
// and keeping the constant at unity leaves that arithmetic intact and one edit
// away from being tuned back.
export const DEFENDER_ATK_MULT   = 1.0;
export const DEFENDER_DMG_TAKEN  = 1.0;

// The BOSS keeps its defender's advantage, unchanged, at the old values.
// Its guards are meant to be a fortified objective rather than a fair fight,
// and this is deliberately separate from the player numbers above so that
// tuning one never silently moves the other. Applied on top of
// BOSS_SOLDIER_HP_MULT / BOSS_SOLDIER_DMG_MULT, exactly as before.
export const BOSS_DEFENDER_ATK_MULT  = 1.1;
export const BOSS_DEFENDER_DMG_TAKEN = 0.82;
export const SURROUND_GAP   = 18;  // squad forms a ring this far outside the target
// Soldiers hit far harder against a mother base (siege), so a slow one-at-a-time
// assault still brings a base down in a reasonable time.
export const STRUCTURE_DMG_MULT = 4;

// ─── Defensive walls (the "Defender" build — static cells ringing the base) ─────
// Defenders are stationary cells arranged in concentric ring LAYERS around the
// mother base. Cells in a layer share one pooled HP: to breach a layer, attackers
// focus its nearest cell and must drain the whole layer's HP there. Layers stack.
export const DEFENDER_HP        = 8000; // HP each defender cell contributes to its layer's pool (very tanky)
export const WALL_DMG_MULT      = 16;   // siege multiplier vs WALLS (so a committed army can still breach)
export const WALL_GAP           = 34;   // distance from base edge to the innermost wall layer
export const WALL_LAYER_GAP     = 30;   // distance between successive wall layers
export const WALL_CELLS_BASE    = 10;   // cell capacity of the innermost ring
export const WALL_CELLS_PER_LAYER = 3;  // extra capacity per outer ring
export const WALL_CELL_SIZE     = 12;   // radius of a rendered hexagonal wall cell

/**
 * How many soldiers can work on one wall cell at the same time.
 *
 * A wall is a frontage, not a damage sponge. Without this cap every member of a
 * 15-strong squad struck the same cell every tick, so walls took fifteen times
 * the damage their frontage could deliver and broke almost instantly. Four is
 * roughly how many bodies fit around one cell.
 */
export const WALL_ATTACKERS_MAX = 4;
export const MAX_WALL_LAYERS    = 3;    // at most this many wall rings around a base
// Walls auto-repair a fixed rate once they've gone this long without being hit.
// Wall repair is deliberately slow: it waits TWICE as long as the mother base
// before it begins, so a wall you've battered stays broken far longer.
export const WALL_REPAIR_DELAY  = BASE_HP_REGEN_DELAY * 2; // ms of calm before repair begins
export const WALL_REPAIR_RATE   = 260;   // HP/sec repaired per cell (up to its max)

// ─── Turret definitions (auto-firing base defenses) ────────────────────────────
// cost    = GOLD to build one (shared pool)
// range   = auto-acquire radius (world px)
// damage  = per shot
// cooldMs = ms between shots
// splash  = AoE radius on impact (0 = single target)
// unlockLv= base level required
export const TURRET_DEFS = {
  gun:     { cost: 80,  range: 200, damage: 6,  cooldMs: 500,  splash: 0,  unlockLv: 1,  color: 0x2c3e50, projSpeed: 520, projColor: 0x334155 },
  missile: { cost: 160, range: 300, damage: 18, cooldMs: 1600, splash: 55, unlockLv: 8,  color: 0x7f1d1d, projSpeed: 320, projColor: 0xef4444 },
};
export const MAX_TURRETS_PER_BASE = 6;   // mounting slots around the base ring

// ─── Economy (shared gold pool) ────────────────────────────────────────────────
export const STARTING_GOLD  = 120;  // enough for a couple of grunts or one gun
export const GOLD_PER_SEC   = 3;    // base passive mining rate (the base IS a miner)
export const GOLD_PER_LEVEL = 0.2;  // gentle extra gold/sec per level (flattened — was too steep)
export const XP_PER_SEC     = 1.0;  // passive XP trickle (keeps leveling advancing)
export const KILL_XP        = 40;   // XP to the owner for each enemy soldier killed (levels you fast)

// ─── Mining upgrade (buy to raise your gold rate) ──────────────────────────────
export const MINE_UPGRADE_BASE_COST = 120;  // cost of the first upgrade
export const MINE_UPGRADE_GROWTH    = 1.7;  // cost multiplier per level (steeper → diminishing)
export const MINE_BONUS_STEP        = 0.7;  // +gold/sec per upgrade (flattened)
export const MAX_MINE_LEVEL         = 10;

// ─── Conquest reward (destroy a rival mother base) ─────────────────────────────
//
// A ONE-TIME payment, deliberately flat.
//
// This used to also grant CONQUEST_INCOME_BONUS: a permanent +2 gold/sec per
// kill, which STACKED. That is a compounding reward — the first kill made you
// richer, which made the second kill easier, which made you richer still — and
// it is the classic recipe for a runaway leader who has decided the match by
// minute eight while seven other people are still playing it.
//
// A flat lump sum rewards aggression without compounding: it buys you one good
// army, not a permanently better economy.
export const CONQUEST_GOLD_LUMP = 300;  // one-time gold bounty, flat
export const CONQUEST_XP        = 180;  // one-time XP bounty (× victim level factor)

// ─── Population & supply ──────────────────────────────────────────────────────
// A cap only does something if it is actually reached. The old numbers gave a
// level-13 base room for 156 soldiers, and 30 bot-only matches showed players
// using barely 30% of that — so it never bound, never forced a decision, and
// the HUD just displayed a meaningless "34/156".
//
// Chosen by measurement, not feel. Three settings over 24 matches each:
//     26 + 10/level   37% of cap used   (never binds — the old numbers)
//     24 +  8/level   51% of cap used   ← this one
//     20 +  5/level   70% of cap used   (binds hard, and matches stopped
//                                        resolving: armies too small to finish)
//
// 24 + 8 makes the ceiling real for a strong player without shrinking armies so
// far that nobody can crack a defended base. Hitting it is the point: once your
// army is full, gold has to go somewhere else — walls, or
// mining upgrades — and that is a real choice rather than an automatic one.
export const POP_BASE       = 15;
export const POP_PER_LEVEL  = 8;
// Garrison: soldiers can be HELD safely inside the base and released together as
// a full formation (so they aren't picked off one-by-one as they spawn).
export const GARRISON_MAX   = 15;

// ─── Groups & formation ────────────────────────────────────────────────────────
export const FORMATION_SPACING = 22;   // px between soldiers in a wedge/triangle
export const GROUP_MERGE_RANGE = 90;   // two groups this close can merge
export const GROUP_ARRIVE      = 18;   // group counts as "arrived" within this of anchor
export const GROUP_MAX_SIZE    = 15;   // a squad can hold at most this many soldiers

// ─── Defense (no formation — soldiers orbit the base & engage independently) ────
export const DEFENSE_RADIUS  = 280;    // enemies within this of the base are engaged by defenders
export const ORBIT_RADIUS    = 74;     // radius defenders circle the base at when idle
export const ORBIT_SPEED     = 0.0016; // radians/ms the defensive ring rotates

// ─── Camera / visibility ────────────────────────────────────────────────────────
// Zoom is unlocked: the player can scroll all the way out to see the whole map,
// or zoom right in. DEF_ZOOM is the starting (base-focused) zoom.
export const MIN_ZOOM  = 0.2;   // fully out → entire map fits on screen
export const MAX_ZOOM  = 2.6;
export const DEF_ZOOM  = 1.6;

// ─── Level table ─────────────────────────────────────────────────────────────
export const LEVELS = [
  { lv:1,  xp:0 },
  { lv:2,  xp:50 },
  { lv:3,  xp:150 },
  { lv:4,  xp:300 },
  { lv:5,  xp:500 },
  { lv:6,  xp:800 },
  { lv:7,  xp:1200, spec:true },   // specialization upgrade (moved earlier from 15)
  { lv:8,  xp:1800, unlock:'saboteur' },
  { lv:9,  xp:2600 },
  { lv:10, xp:3600 },
  { lv:11, xp:5000 },
  { lv:12, xp:7000 },
  { lv:13, xp:9500 },
  { lv:14, xp:13000 },
  { lv:15, xp:17000 },
  { lv:16, xp:22000 },
  { lv:17, xp:28000 },
  { lv:18, xp:35000 },
  { lv:19, xp:43000 },
  { lv:20, xp:52000, unlock:'vanguard', baseHpBonus:1.3 },
];

// ─── Skill points / buffs ─────────────────────────────────────────────────────
export const SKILL_PTS_PER_LEVEL = 1;    // points granted each level-up
export const BUFF_STEP            = 0.10; // +10% per point spent in a stat

// ─── Center hunting ground ─────────────────────────────────────────────────────
// Eatables: destructible shapes soldiers attack for XP (level up → more pop).
// body = HP an eatable deals back to the soldier hitting it (ramming shapes hurts).
export const EATABLE_DEFS = {
  1: { xp: 12, hp: 30,  body: 1, color: 0xfcd34d, shape: 'square',   sz: 11 },
  2: { xp: 32, hp: 70,  body: 2, color: 0xa855f7, shape: 'triangle', sz: 13 },
  3: { xp: 95, hp: 170, body: 3, color: 0x3b82f6, shape: 'pentagon', sz: 18 },
};
export const EATABLE_TARGET   = 46;    // target eatable count in the centre
export const EATABLE_SPAWN_MS = 1400;  // ms between spawn attempts

// Neutral "wildlings": map-owned units that roam the centre and attack any
// soldier nearby. They spawn sparingly and give a big XP bounty when killed.
export const WILDLING_HP        = 220;
export const WILDLING_DAMAGE    = 6;
export const WILDLING_SPEED     = 32;
export const WILDLING_DETECT    = 230;  // attacks/chases soldiers within this range
export const WILDLING_XP_BOUNTY = 140;
export const WILDLING_TARGET    = 4;    // how many roam the centre at once
export const WILDLING_SPAWN_MS  = 13000;// sparing spawn cadence

// ─── Mining mode (Space STG 3-style node capture) ──────────────────────────────
// Neutral gold nodes scattered across the map (never in the centre). Send a squad
// to sit on one and it's captured, then it feeds gold to your base and slowly
// grows its own defenders. Capturing more nodes is the main growth path here.
export const MINE_NODE_COUNT     = 9;    // total nodes on the map
export const MINE_NODE_RADIUS    = 26;   // node body radius (also the capture ring)
export const MINE_CAPTURE_RANGE  = 90;   // soldiers within this of a node contest it
export const MINE_CAPTURE_TIME   = 4000; // ms for 1 soldier to flip a node (more = faster)
/**
 * A held node is worth a flat +1 gold/sec. Nothing else.
 *
 * It used to pay 1.5 plus 0.3 per soldier parked on it, which quietly turned
 * every node into a reason to garrison it heavily — and it used to grow its own
 * soldiers too, so nodes fought their own war. Both are gone: a node is a small
 * steady income you have to hold, and holding it costs you soldiers you could
 * have used elsewhere. That trade is the whole point of the mode.
 */
export const MINE_NODE_GOLD      = 1;    // flat gold/sec per captured node
export const MINE_STATION_CAP    = 10;   // (kept: still caps capture-speed scaling)
export const MINE_NODE_MIN_SEP   = 360;  // min spacing between nodes / from bases

// ─── Bot decision-making ──────────────────────────────────────────────────────
//
// Bots run a "force budget": each think tick they work out how much army must
// stay home to survive, and only the surplus above that is allowed to attack.
// This is what stops a bot with one squad from throwing it at an enemy who has
// three, and what stops a bot under attack from marching its defenders away.
//
// Committing to an attack is IRREVERSIBLE in this game (an attacking squad is
// locked until its target dies or it is wiped), so the cost of guessing wrong
// is high and these numbers are deliberately cautious.

/**
 * Net worth of a defending soldier versus an attacking one, derived from the
 * stance bonuses so it can never drift out of sync with them.
 *   attack 1.10x  and  damage taken 0.82x  →  1.10 / 0.82 ≈ 1.34
 * So ~10 defenders can be expected to hold against ~13 attackers.
 */
export const DEFENDER_EDGE = DEFENDER_ATK_MULT / DEFENDER_DMG_TAKEN;
// What one boss guard is worth in attackers, from its stance alone. The
// BOSS_SOLDIER_* multipliers are on top of this.
export const BOSS_DEFENDER_EDGE = BOSS_DEFENDER_ATK_MULT / BOSS_DEFENDER_DMG_TAKEN;

/** Enemies this close to a base are pressing it right now. */
export const BOT_THREAT_RADIUS = 420;

/**
 * A threat only counts as one if it is big enough to matter. Without this, a
 * single cheap soldier parked outside a bot's base would pin it down for the
 * rest of the match — the classic failure mode of "defend when threatened",
 * and a strategy so cheap it would make the bots worse than the old ones.
 *
 * Threat must exceed BOTH a flat floor and a fraction of the bot's own army,
 * so a scout is ignored whether the bot is small or large.
 */
export const BOT_THREAT_FLOOR = 4;
export const BOT_THREAT_FRACTION = 0.12;

/**
 * Margin a bot wants over the force actually attacking it. Above 1 means it
 * keeps more defenders than the raw maths demands.
 */
export const BOT_DEFENCE_SAFETY = { passive: 1.7, standard: 1.3, aggressive: 1.05 };

/**
 * How much a bot worries about the biggest enemy army that ISN'T attacking it
 * yet. This is the term that answers "they have 3 squads and I have 1" — the
 * threat is only potential, so it is weighted well below a real attack, but it
 * is enough to stop a lone squad wandering off.
 */
export const BOT_CAUTION = { passive: 0.55, standard: 0.38, aggressive: 0.22 };

/** A bot always keeps at least this many soldiers home, even in total peace. */
export const BOT_MIN_HOME = { passive: 12, standard: 8, aggressive: 5 };

/**
 * Force advantage required before committing to an assault, over and above what
 * the defender's edge already demands. Attacking into a prepared defence is a
 * losing trade, so bots want a real edge before spending a locked squad.
 */
export const BOT_ATTACK_EDGE = { passive: 1.9, standard: 1.5, aggressive: 1.2 };

/**
 * Consecutive calm think-ticks before a bot will start an attack. Prevents a
 * bot lurching out the instant a raider steps back, and gives a human room to
 * feint — while the escalation below guarantees it cannot be stalled forever.
 */
export const BOT_PATIENCE = { passive: 5, standard: 3, aggressive: 1 };

/**
 * Anti-stalemate. Eight cautious bots must not sit and stare at each other
 * until the match timer runs out, so their required attack advantage decays the
 * longer they go without committing to anything.
 */
export const BOT_RESTLESS_AFTER = 45;     // think-ticks (~90s) before impatience starts
export const BOT_RESTLESS_DECAY = 0.025;  // edge requirement lost per tick beyond that

/**
 * The floor must sit BELOW 1/DEFENDER_EDGE, and that is not a rounding choice —
 * it is the difference between a game and a staring contest.
 *
 * Population is capped, so eight even bots all plateau at a similar army size.
 * If a bot always demanded more attackers than the enemy has defenders, no
 * even matchup could ever be attacked and every match would run to the timer.
 * Below this line a patient bot eventually commits at roughly equal numbers —
 * a real gamble, which is the correct behaviour when waiting is also losing.
 *
 * DEFENDER_EDGE is now 1.0 (the defender's advantage was removed), so the
 * ceiling this must stay under is 1.0 rather than the ~0.75 it was written
 * against. It stays at 0.55 regardless: walls are still priced into the
 * requirement, so a patient bot needs to fall below parity on bodies before a
 * fortified base looks takeable.
 */
export const BOT_RESTLESS_FLOOR = 0.55;

/**
 * How much more attractive a boss is than an equally-defended rival base.
 *
 * Above zero because a boss is worth permanent income and, unlike a player,
 * never marches on your home while you are busy — so committing to one risks
 * only the squads you send. Raise it and bots fight over the middle; lower it
 * and they ignore the objective entirely.
 *
 * Was 1.2, which turned out to be most of the score. The boss and base scores
 * are otherwise on the same scale (roughly -1 to +2), so a flat +1.2 meant a
 * boss beat a rival base at almost any force ratio, and measurement bore that
 * out: bosses drew 190 commitments to bases' 219 while mining nodes were
 * ignored entirely. A boss should be a strong pull, not a default.
 */
export const BOT_BOSS_APPEAL = 0.8;

/**
 * How many mining nodes a bot tries to hold before it stops chasing more.
 *
 * There are MINE_NODE_COUNT (9) on the map and each is worth only +1 gold/sec,
 * so hoovering up every one is a poor use of an army that could be ending
 * somebody. Three is enough to matter economically while leaving most of the
 * bot's force free to fight — and it stops two bots spending an entire match
 * shoving each other off nodes while a weaker player is left alone.
 */
export const BOT_MINE_TARGET = 3;

/**
 * How far from home a bot will send its LAST free squad to sit on a node.
 *
 * With two or more squads free, any node is fair game. Down to one, the node
 * has to be close enough that recalling it costs little — a squad sent to the
 * far side of the map is, in practice, not available for defence however
 * recallable it is on paper. Roughly the distance between neighbouring seats on
 * the spawn ring, so "a node in my own quarter of the map".
 */
export const BOT_MINE_SOLO_RADIUS = 900;

/**
 * The largest share of a bot's squads that may be tied up on mining nodes.
 *
 * A bot may always claim one node regardless (see _canSpareForMining), so this
 * only bites once it has enough squads for the fraction to matter. At 0.5 half
 * the army is always free to fight, which is what stops mining mode turning
 * into eight bots quietly farming while nobody attacks anybody.
 */
export const BOT_MINE_MAX_SHARE = 0.5;

/**
 * ─── The bait: let two rivals fight each other ───────────────────────────────
 *
 * When two mutually-hostile armies converge on the same base at once, standing
 * between them means absorbing both at full strength. Stepping aside costs some
 * base HP and buys a fight you did not have to be in: they collide, and
 * whoever survives arrives at your wall already mauled.
 *
 * It is a real gamble, not a free win — you trade base damage for a better
 * fight — so the conditions in AISystem._shouldBait are deliberately strict.
 */

/** How far out to look for converging armies. Wider than BOT_THREAT_RADIUS:
 *  the decision has to be made BEFORE they arrive, not once they are on top of
 *  the base, or there is no time left to withdraw. */
export const BOT_BAIT_RADIUS = 620;

/** Margin demanded on both the "would standing lose?" and "would waiting win?"
 *  arithmetic. Above 1 so the bot needs a clear answer, not a coin flip. */
export const BOT_BAIT_SAFETY = 1.15;

/** How much of the smaller faction's strength is taken out of the larger one
 *  when they collide. 0.8 assumes an attacker trades at slightly under par —
 *  they arrive piecemeal and fight without the defender's ground. */
export const BOT_BAIT_ATTRITION = 0.8;

/** Never bait with a base already this hurt: the plan involves taking hits, and
 *  a base near death cannot afford any. */
export const BOT_BAIT_MIN_HP = 0.55;

/** How far to pull back — beyond weapon range, close enough to return quickly. */
export const BOT_BAIT_DISTANCE = 430;

/**
 * How much wall HP one attacker is reckoned to be worth when a bot decides
 * whether an assault can succeed. Only used for that judgement — it changes no
 * combat maths.
 *
 * Calibrated against the boss, whose difficulty was already tuned by
 * simulation: its ring is BOSS_WALL_CELLS × BOSS_WALL_CELL_HP = 62,400 HP, and
 * the force that actually cracked it in testing was three to four squads
 * (45–60 soldiers). 62,400 / 52 ≈ 1200.
 *
 * A player's ring of ten DEFENDER_HP cells is 80,000 HP, so ~67 bodies — four
 * or five squads. That is the point: a walled base should demand a committed
 * assault, and a bot that cannot raise one should go and do something else
 * rather than feed single squads into it.
 */
export const WALL_BODY_HP = 1200;

// ─── Seats ────────────────────────────────────────────────────────────────────
// A match has exactly SEAT_COUNT mother bases. Every seat is identical: it
// starts driven by the AI, and a joining human takes one over. That is what
// makes a match never feel empty, joining instant, and a disconnect harmless
// (the AI simply takes the base back).
export const SEAT_COUNT  = 8;

export const BOT_COUNT   = 7;   // deprecated: kept so old callers still resolve
export const BOT_COLORS  = [
  0xff4444, 0xff8c00, 0xffd700, 0x44ff66,
  0x00ffcc, 0xff44dd, 0x88ff44,
];
export const PLAYER_COLOR = 0x00bfff;

/** One distinct colour per seat (FFA). Team mode uses TEAM_TINTS instead. */
export const SEAT_COLORS = [PLAYER_COLOR, ...BOT_COLORS];

// ─── Teams (Team mode: Blue vs Red) ─────────────────────────────────────────────
export const TEAM_COLORS = { blue: 0x2b7fff, red: 0xff4444 };
// Per-member tint variation so teammates are distinguishable within a team colour.
export const TEAM_TINTS  = {
  blue: [0x2b7fff, 0x4f9dff, 0x1e63d6, 0x6fb0ff],
  red:  [0xff4444, 0xff6b6b, 0xd62828, 0xff8c8c],
};
