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
    key: 'boss-up',
    when: (w) => w.bossAlive,
    text: '⭐ A boss has appeared in the centre. Killing it grants permanent gold per second — but it needs three or four squads, not one.',
    kind: 'info',
  },
];

/*
 * Two tips were removed deliberately, and the reasons are different:
 *
 *   `under-attack` — the base button already beams red the moment the base is
 *   hit. A message that only restates something the HUD is already shouting is
 *   pure noise, and it fires at the exact moment the player has least attention
 *   to spare.
 *
 *   `wall-gap` — accurate but rarely actionable in the moment; the tutorial
 *   covers it, and every message that is not worth reading makes the ones that
 *   are worth reading less likely to be read.
 */

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

    // Is anything hostile close to home? Proximity is the right question for
    // this one — `garrison-trickle` warns about sending a half-squad out while
    // enemies are about, and a squad merely passing by is still a threat to it.
    const bx = base.position.x, by = base.position.y;
    const R2 = 700 * 700;
    let enemyNear = false;
    for (const [, s] of world.soldiers) {
      if (s.hp <= 0 || s.ownerId === world.playerId || s.ownerId === 'boss') continue;
      const dx = s.position.x - bx, dy = s.position.y - by;
      if (dx * dx + dy * dy > R2) continue;
      enemyNear = true;
      break;                    // one is enough; nothing here needs a count
    }

    // Which enemies are actually COMING FOR US — a different, much stricter
    // question than the one above, and it used to be answered with the same
    // proximity test. In FFA everyone is hostile to everyone, so two unrelated
    // squads passing near your base both counted as "factions", and the tip
    // announced that two enemies were "heading for you" when neither was.
    // That false alarm is what was reported.
    //
    // Groups are serialised with `status` and `targetId`, so the real question
    // is answerable: a group that is attacking, and whose target belongs to me.
    const factions = new Set();
    for (const [, g] of world.groups) {
      if (g.ownerId === world.playerId || g.ownerId === 'boss') continue;
      if (g.status !== 'attacking' || g.memberIds.length === 0) continue;
      if (!world.areEnemies(world.playerId, g.ownerId)) continue;
      const target = world.resolve(g.targetId);
      if (!target || target.ownerId !== world.playerId) continue;  // aimed at someone else
      factions.add(g.ownerId);
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

    // `underAttack`, `wallCells` and `wallGaps` used to be computed here for
    // the two tips that have since been removed. The wall figures in
    // particular meant walking every layer of every ring on every frame to
    // decide something nothing asked about any more, so they went with their
    // tips rather than being left as a view nobody reads.
    return {
      garrison: base.garrison ?? 0,
      pop: world.soldierPop?.(world.playerId) ?? 0,
      cap: world.popCap?.(me) ?? 0,
      smallestSquad: smallest,
      enemyNear,
      rivalFactionsInbound: rivals,
      bossAlive: (world.bosses?.size ?? 0) > 0,
    };
  }
}
