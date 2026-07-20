import { uid } from '../utils/helpers.js';

let _notifId = 0;

export class GameState {
  constructor(playerId) {
    this.time       = 0;       // ms since game start
    this.playerId   = playerId;

    /** @type {Map<string, import('../entities').Base>} */
    this.bases      = new Map();   // baseId → Base (convenience map)

    /** @type {Map<string, { id, isBot, botTier, base, color, alive, pendingXP }>} */
    this.players    = new Map();

    /** @type {Map<string, import('../entities').GraphNode>} */
    this.nodeSites  = new Map();

    /** @type {Map<string, import('../entities').Link>} */
    this.links      = new Map();

    /** @type {Map<string, import('../entities').Soldier>} */
    this.soldiers   = new Map();

    /** @type {Map<string, import('../entities').Eatable>} */
    this.eatables   = new Map();

    /** @type {import('../entities').Boss|null} */
    this.boss       = null;

    this.bossTimer  = 15 * 60 * 1000;
    this.eatTimer   = 0;

    this._notifs    = [];  // active notifications
    this._events    = [];  // queued events for renderer
  }

  /** Add a notification (only shows for human player or 'all') */
  notify(msg, type = 'info', targetId = 'player') {
    if (targetId !== this.playerId && targetId !== 'all') return;
    this._notifs.push({ id: `n${++_notifId}`, msg, type, expires: this.time + 4200 });
  }

  /** Queue a one-frame event for the renderer (explosions, bloom, etc.) */
  event(type, data) {
    this._events.push({ type, data });
  }

  flushEvents() {
    const ev = this._events;
    this._events = [];
    return ev;
  }

  /** Resolve a target ID to an entity (soldier, node, link, or base) */
  resolve(id) {
    if (!id) return null;
    if (this.soldiers.has(id))  return this.soldiers.get(id);
    if (this.nodeSites.has(id)) return this.nodeSites.get(id);
    if (this.links.has(id))     return this.links.get(id);
    if (this.bases.has(id))     return this.bases.get(id);
    return null;
  }

  getPlayer(id) { return this.players.get(id); }
  getPlayerBase(playerId) { return this.players.get(playerId)?.base; }

  /** How many links does a player currently own from a given anchor? */
  linkCountFrom(ownerId, anchorId) {
    let n = 0;
    for (const [, l] of this.links)
      if (l.ownerId === ownerId && (l.fromId === anchorId || l.toId === anchorId)) n++;
    return n;
  }

  /** Returns node count for a player */
  nodeCount(playerId) {
    let n = 0;
    for (const [, nd] of this.nodeSites)
      if (nd.ownerId === playerId && nd.status === 'claimed') n++;
    return n;
  }

  /** Returns soldier count for a player */
  soldierCount(playerId) {
    let n = 0;
    for (const [, s] of this.soldiers) if (s.ownerId === playerId) n++;
    return n;
  }
}
