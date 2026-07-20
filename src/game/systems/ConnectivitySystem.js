import { ORPHAN_GRACE } from '../constants.js';

/**
 * ConnectivitySystem
 * ─────────────────
 * Runs a BFS from each player's Base outward along their Links.
 * Any owned Node not reachable gets flagged "orphaned".
 * Orphaned nodes that aren't reconnected within ORPHAN_GRACE ms flip to "neutral".
 *
 * Called: every tick (cheap — only iterates owned links/nodes).
 * Also called immediately when a Link is destroyed (onLinkDestroyed).
 */
export class ConnectivitySystem {
  update(state) {
    const now = state.time;

    for (const [playerId, player] of state.players) {
      if (!player.alive) continue;
      this._check(state, playerId, now);
    }

    // Orphan timer expiry
    for (const [, node] of state.nodeSites) {
      if (node.status === 'orphaned' && node.orphanedAt !== null) {
        if (now - node.orphanedAt > ORPHAN_GRACE) {
          this._neutralize(state, node, now);
        }
      }
    }
  }

  /** Call this immediately whenever a link's HP hits 0. */
  onLinkDestroyed(state, link) {
    state.links.delete(link.id);
    const player = state.players.get(link.ownerId);
    if (player && player.alive) {
      this._check(state, link.ownerId, state.time);
    }
  }

  _check(state, playerId, now) {
    const player = state.players.get(playerId);
    if (!player?.base) return;

    // BFS from base
    const reachable = new Set();
    reachable.add(player.base.id);
    const queue = [player.base.id];

    while (queue.length > 0) {
      const cur = queue.shift();
      for (const [, link] of state.links) {
        if (link.ownerId !== playerId) continue;
        if (link.hp <= 0) continue;

        let next = null;
        if      (link.fromId === cur && !reachable.has(link.toId))   next = link.toId;
        else if (link.toId   === cur && !reachable.has(link.fromId)) next = link.fromId;

        if (next) { reachable.add(next); queue.push(next); }
      }
    }

    // Orphan / restore nodes
    for (const [, node] of state.nodeSites) {
      if (node.ownerId !== playerId) continue;

      if (node.status === 'claimed') {
        if (!reachable.has(node.id)) {
          node.status    = 'orphaned';
          node.orphanedAt = now;
          if (playerId === state.playerId)
            state.notify('⚠️ Node orphaned! Reconnect within 12s', 'warning', playerId);
        }
      } else if (node.status === 'orphaned') {
        if (reachable.has(node.id)) {
          node.status    = 'claimed';
          node.orphanedAt = null;
          state.notify('✓ Node reconnected!', 'success', playerId);
        }
      }
    }
  }

  _neutralize(state, node, now) {
    const prevOwner = node.ownerId;
    node.status         = 'neutral';
    node.ownerId        = null;
    node.orphanedAt     = null;
    node.hp             = node.maxHp;
    node.claimProgress  = 0;
    node.claimerSoldierId = null;

    // Remove links that belonged to prev owner touching this node
    for (const [lid, link] of state.links) {
      if (link.ownerId === prevOwner &&
          (link.fromId === node.id || link.toId === node.id)) {
        state.links.delete(lid);
      }
    }

    if (prevOwner === state.playerId)
      state.notify('💀 Node lost — reclaim it!', 'warning', prevOwner);
  }
}
