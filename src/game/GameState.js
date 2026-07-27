import { POP_BASE, POP_PER_LEVEL } from './constants.js';

let _notifId = 0;

export class GameState {
  constructor(playerId) {
    this.time       = 0;       // ms since game start
    this.playerId   = playerId;
    this.mode       = 'ffa';   // 'ffa' | 'team' | 'mining' (set by buildWorld)

    /** @type {Map<string, import('./entities').Base>} */
    this.bases      = new Map();

    /** @type {Map<string, { id, isBot, botTier, base, color, alive, pendingXP, buffs }>} */
    this.players    = new Map();

    /** @type {Map<string, import('./entities').Soldier>} */
    this.soldiers   = new Map();

    /** @type {Map<string, import('./entities').Group>} */
    this.groups     = new Map();

    /** @type {Map<string, import('./entities').Turret>} */
    this.turrets    = new Map();

    /** @type {Map<string, import('./entities').Projectile>} */
    this.projectiles = new Map();

    /** @type {Map<string, import('./entities').Eatable>} */
    this.eatables   = new Map();

    /** @type {Map<string, import('./entities').Wildling>} */
    this.wildlings  = new Map();

    /** @type {Map<string, import('./entities').MineNode>} */
    this.mineNodes  = new Map();

    /** @type {import('./entities').Boss|null} */
    this.boss       = null;

    this.bossTimer  = 15 * 60 * 1000;
    this.eatTimer   = 0;
    this.wildTimer  = 0;

    this._notifs    = [];  // active notifications
    this._events    = [];  // queued events for renderer
  }

  /**
   * Notifications are disabled (toasts were noisy). Kept as a no-op so existing
   * call sites still work; base-under-attack is surfaced by the blinking Base
   * button instead (see HUDRenderer._updateBaseAlert).
   */
  notify(_msg, _type = 'info', _targetId = 'player') { /* intentionally silent */ }

  /** Queue a one-frame event for the renderer (explosions, bloom, etc.) */
  event(type, data) {
    this._events.push({ type, data });
  }

  flushEvents() {
    const ev = this._events;
    this._events = [];
    return ev;
  }

  /** Resolve a target ID to an entity (soldier, base, boss, eatable, wildling) */
  resolve(id) {
    if (!id) return null;
    if (this.soldiers.has(id))  return this.soldiers.get(id);
    if (this.bases.has(id))     return this.bases.get(id);
    if (this.eatables.has(id))  return this.eatables.get(id);
    if (this.wildlings.has(id)) return this.wildlings.get(id);
    if (this.boss && this.boss.id === id) return this.boss;
    return null;
  }

  getPlayer(id) { return this.players.get(id); }
  getPlayerBase(playerId) { return this.players.get(playerId)?.base; }

  /**
   * Are two owner-ids hostile to each other? Same owner → no. In Team mode,
   * teammates (same team) → no. Everything else (incl. neutral wildlings) → yes.
   */
  areEnemies(a, b) {
    if (!a || !b || a === b) return false;
    const pa = this.players.get(a), pb = this.players.get(b);
    if (pa && pb && pa.team && pb.team && pa.team === pb.team) return false;
    return true;
  }

  teamOf(playerId) { return this.players.get(playerId)?.team ?? null; }

  /** Alive teams remaining (Team mode) — used for win checks. */
  aliveTeams() {
    const s = new Set();
    for (const [, p] of this.players) if (p.alive && p.team) s.add(p.team);
    return [...s];
  }

  /** Returns soldier count for a player */
  soldierCount(playerId) {
    let n = 0;
    for (const [, s] of this.soldiers) if (s.ownerId === playerId) n++;
    return n;
  }

  /** Returns total population used by a player's soldiers (pop-weighted). */
  soldierPop(playerId) {
    let n = 0;
    for (const [, s] of this.soldiers) if (s.ownerId === playerId) n += (s.pop ?? 1);
    return n;
  }

  /** Population budget (cap) for a player, scaling with base level. */
  popCap(player) {
    return POP_BASE + player.base.level * POP_PER_LEVEL;
  }

  /** All groups owned by a player. */
  groupsOf(playerId) {
    const out = [];
    for (const [, g] of this.groups) if (g.ownerId === playerId) out.push(g);
    return out;
  }

  /** Turret count on a base. */
  turretCount(baseId) {
    let n = 0;
    for (const [, t] of this.turrets) if (t.baseId === baseId) n++;
    return n;
  }
}
