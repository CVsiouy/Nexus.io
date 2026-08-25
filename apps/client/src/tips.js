/**
 * tips.js — teaching in context, once each.
 * ────────────────────────────────────────
 *
 * The tutorial overlay explains the ideas up front, which is the wrong moment
 * for most of them: nobody retains "release at fifteen" before they have a
 * garrison. These fire the first time each situation is actually TRUE for the
 * player, which is when the advice is worth something.
 *
 * Three rules keep this from becoming nagging:
 *
 *   1. ONCE PER MATCH, EVER. Each tip has a key and fires once. A tip that
 *      repeats is noise, and noise trains you to ignore the notification area
 *      you also use for real events.
 *   2. NEVER MORE THAN ONE AT A TIME. A cooldown between tips, so a busy moment
 *      cannot dump four of them at once.
 *   3. THEY STOP. Once a tip has been seen in a few separate matches, the
 *      player evidently knows; it is retired permanently via localStorage.
 *
 * They are advisory only — nothing here sends a command or changes the game.
 */

import { GARRISON_MAX } from '@basewar/sim';

const STORE_KEY = 'basewar.tipsSeen';
const RETIRE_AFTER = 3;          // matches in which a tip was shown before retiring it
const COOLDOWN_MS  = 12_000;     // minimum gap between two tips

/** Long-term "the player has seen this N times" memory. */
function loadSeen() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function saveSeen(seen) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(seen)); } catch { /* ignore */ }
}

/**
 * Each tip: when it becomes true, and what to say.
 *
 * `when` gets a small view of the world and must be cheap — it runs every
 * frame. Anything expensive belongs behind a cheaper guard.
 */
const TIPS = [
  {
    key: 'garrison-ready',
    when: (w) => w.garrison >= GARRISON_MAX,
    text: '🏰 Your garrison is full — release it as one squad of 15. Sending them out one at a time gets them picked off.',
    kind: 'success',
  },
  {
    key: 'garrison-trickle',
    // A squad on the map that is far too small to survive contact.
    when: (w) => w.smallestSquad > 0 && w.smallestSquad < 6 && w.enemyNear,
    text: '⚠️ That squad is too small to fight. Squads win by arriving together — wait for 15.',
    kind: 'warn',
  },
  {
    key: 'pop-full',
    when: (w) => w.pop >= w.cap && w.cap > 0,
    text: '👥 Population is full. Level up your base to raise the cap, or spend what you have.',
    kind: 'info',
  },
  {
    key: 'two-enemies',
    // THE tactic. Two mutually hostile forces converging on your base.
    when: (w) => w.rivalFactionsInbound >= 2,
    text: '🎣 Two different enemies are heading for you at once. Consider moving your soldiers AWAY and letting them fight each other — then clean up the survivor.',
    kind: 'warn',
  },
  {
    key: 'under-attack',
    when: (w) => w.underAttack,
    text: '🛡️ Your base is under attack. Soldiers standing around it shield it — mass them at home rather than spreading out.',
    kind: 'warn',
  },
  {
    key: 'boss-up',
    when: (w) => w.bossAlive,
    text: '⭐ A boss has appeared in the centre. Killing it grants permanent gold per second — but it needs three or four squads, not one.',
    kind: 'info',
  },
  {
    key: 'wall-gap',
    // A ring that has been started but left incomplete is the classic trap.
    when: (w) => w.wallCells > 0 && w.wallGaps > 0,
    text: '🧱 Your wall ring has a gap. Enemies will walk straight through it — a complete ring is worth far more than a longer broken one.',
    kind: 'info',
  },
];

export class Tips {
  constructor(notify) {
    this.notify = notify;              // (text, kind) => void
    this.seen = loadSeen();
    this.reset();
  }

  /** New match: forget what fired, keep the long-term memory. */
  reset() {
    this.fired = new Set();
    this.nextAllowedAt = 0;
    this.enabled = true;
  }

  /** Called every frame with the world view. Cheap, and mostly a no-op. */
  update(world, nowMs) {
    if (!this.enabled) return;
    if (nowMs < this.nextAllowedAt) return;

    const w = this._sample(world);
    if (!w) return;

    for (const tip of TIPS) {
      if (this.fired.has(tip.key)) continue;
      if ((this.seen[tip.key] ?? 0) >= RETIRE_AFTER) continue;
      let hit = false;
      try { hit = !!tip.when(w); } catch { hit = false; }
      if (!hit) continue;

      this.fired.add(tip.key);
      this.seen[tip.key] = (this.seen[tip.key] ?? 0) + 1;
      saveSeen(this.seen);
      this.notify?.(tip.text, tip.kind);
      this.nextAllowedAt = nowMs + COOLDOWN_MS;
      return;                          // one at a time, always
    }
  }

  /**
   * Reduce the world to the handful of facts the tips ask about.
   *
   * Done once per frame rather than per tip, and it is the only place that
   * knows the shape of WorldView — a tip's `when` reads plain numbers.
   */
  _sample(world) {
    const me = world?.players?.get(world.playerId);
    if (!me?.alive) return null;
    const base = me.base;

    const groups = world.groupsOf(world.playerId);
    let smallest = 0;
    for (const g of groups) {
      const n = g.memberIds.length;
      if (n > 0 && (smallest === 0 || n < smallest)) smallest = n;
    }

    // Anything hostile within a generous radius of home, grouped by owner, so
    // "two DIFFERENT enemies" can be told from "one enemy with two squads".
    const bx = base.position.x, by = base.position.y;
    const R2 = 700 * 700;
    const factions = new Set();
    let enemyNear = false;
    for (const [, s] of world.soldiers) {
      if (s.hp <= 0 || s.ownerId === world.playerId || s.ownerId === 'boss') continue;
      const dx = s.position.x - bx, dy = s.position.y - by;
      if (dx * dx + dy * dy > R2) continue;
      enemyNear = true;
      if (world.areEnemies(world.playerId, s.ownerId)) factions.add(s.ownerId);
    }
    // Only count them as rivals if they are hostile to EACH OTHER too — two
    // teammates will not oblige by fighting.
    const ids = [...factions];
    let rivals = 0;
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        if (world.areEnemies(ids[a], ids[b])) rivals = 2;
      }
    }

    // A ring is "gapped" if it has cells but is not full.
    let wallCells = 0, wallGaps = 0;
    for (const layer of (base.walls ?? [])) {
      const have = layer?.cells?.length ?? 0;
      wallCells += have;
      if (have > 0 && have < (layer.maxCells ?? have)) wallGaps += layer.maxCells - have;
    }

    return {
      garrison: base.garrison ?? 0,
      pop: world.soldierPop?.(world.playerId) ?? 0,
      cap: world.popCap?.(me) ?? 0,
      smallestSquad: smallest,
      enemyNear,
      rivalFactionsInbound: rivals,
      underAttack: (world.time - (base.lastAttackedAt ?? -Infinity)) < 2500,
      bossAlive: (world.bosses?.size ?? 0) > 0,
      wallCells,
      wallGaps,
    };
  }
}
