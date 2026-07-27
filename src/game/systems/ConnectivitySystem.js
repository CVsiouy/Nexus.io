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

    // Build a per-owner adjacency map in ONE pass over all links, so each
    // player's BFS is O(V+E) instead of re-scanning every link per node.
    // (This is the game's hottest loop at scale — dense maps have 1000+ links.)
    const adjByOwner = this._buildAdjacency(state);

    for (const [playerId, player] of state.players) {
      if (!player.alive) continue;
      this._check(state, playerId, now, adjByOwner.get(playerId));
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

  /** Map<ownerId, Map<nodeId, neighborId[]>> for all live links. */
  _buildAdjacency(state) {
    const adj = new Map();
    for (const [, link] of state.links) {
      if (link.hp <= 0) continue;
      let owner = adj.get(link.ownerId);
      if (!owner) { owner = new Map(); adj.set(link.ownerId, owner); }
      _addEdge(owner, link.fromId, link.toId);
      _addEdge(owner, link.toId, link.fromId);
    }
    return adj;
  }

  /** Call this immediately whenever a link's HP hits 0. */
  onLinkDestroyed(state, link) {
    state.links.delete(link.id);
    const player = state.players.get(link.ownerId);
    if (player && player.alive) {
      // Rebuild just this owner's adjacency for the immediate re-check.
      const owner = new Map();
      for (const [, l] of state.links) {
        if (l.ownerId !== link.ownerId || l.hp <= 0) continue;
        _addEdge(owner, l.fromId, l.toId);
        _addEdge(owner, l.toId, l.fromId);
      }
      this._check(state, link.ownerId, state.time, owner);
    }
  }

  _check(state, playerId, now, adj) {
    const player = state.players.get(playerId);
    if (!player?.base) return;

    // BFS from base over the prebuilt adjacency list. Index-pointer queue
    // avoids the O(n) cost of Array.shift() on every dequeue.
    const reachable = new Set();
    reachable.add(player.base.id);
    const queue = [player.base.id];
    let head = 0;

    while (head < queue.length) {
      const cur = queue[head++];
      const neighbors = adj?.get(cur);
      if (!neighbors) continue;
      for (const next of neighbors) {
        if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
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
            state.notify('⚠️ Node orphaned! Reconnect within 30s', 'warning', playerId);
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

/** Push `b` onto the neighbor list of `a` in an adjacency Map. */
function _addEdge(adj, a, b) {
  let list = adj.get(a);
  if (!list) { list = []; adj.set(a, list); }
  list.push(b);
}
