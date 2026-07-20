import { dist2, dist, randPick } from '../../utils/helpers.js';
import { BOT_THINK_RATE } from '../constants.js';

/**
 * AISystem
 * ────────
 * Three-tier bot AI:
 *   passive   — expand slowly, harvest eatables, avoid combat
 *   standard  — expand, harvest, occasionally attack weak neighbors
 *   aggressive — actively hunts trunk links, steals orphaned nodes
 */
export class AISystem {
  update(state, dtMs) {
    for (const [, player] of state.players) {
      if (!player.isBot || !player.alive) continue;

      player._thinkTimer -= dtMs;
      if (player._thinkTimer > 0) continue;
      player._thinkTimer = BOT_THINK_RATE + Math.random() * 500; // stagger bots

      this._think(state, player);
    }
  }

  _think(state, player) {
    const tier  = player.botTier;
    const brain = player._brain;
    const base  = player.base;

    // Gather my soldiers
    const mySoldiers = [];
    for (const [, sol] of state.soldiers) {
      if (sol.ownerId === player.id && sol.hp > 0) mySoldiers.push(sol);
    }

    const myNodes = state.nodeCount(player.id);

    // ── 1. Try to expand (all tiers do this) ─────────────────────────────
    if (mySoldiers.length > 0) {
      const claimTarget = this._findClaimTarget(state, player);
      if (claimTarget) {
        // Send 1-2 idle grunts to claim
        const idle = mySoldiers.filter(s => s.order.kind === 'idle').slice(0, 2);
        for (const sol of idle) {
          sol.order = { kind: 'claim', targetId: claimTarget.id, position: null };
        }
      }
    }

    // ── 2. Harvest eatables ───────────────────────────────────────────────
    if (tier !== 'passive' || myNodes < 3) {
      const eat = this._findNearestEatable(state, player);
      if (eat) {
        const idle = mySoldiers.filter(s => s.order.kind === 'idle').slice(0, 1);
        for (const sol of idle) {
          sol.order = { kind: 'harvest', targetId: eat.id, position: null };
        }
      }
    }

    // ── 3. Attack (standard and aggressive only) ─────────────────────────
    if (tier === 'passive') return;

    if (mySoldiers.length < 4) return; // not enough soldiers to attack

    if (tier === 'standard') {
      // Random chance to attack
      if (Math.random() < 0.35) {
        this._standardAttack(state, player, mySoldiers);
      }
    } else if (tier === 'aggressive') {
      this._aggressiveAttack(state, player, mySoldiers);
    }

    // ── 4. Reclaim orphaned nodes ─────────────────────────────────────────
    for (const [, node] of state.nodeSites) {
      if (node.status !== 'neutral' && node.status !== 'orphaned') continue;
      if (!this._inRange(state, player, node)) continue;
      const sol = mySoldiers.find(s => s.order.kind === 'idle');
      if (sol) {
        sol.order = { kind: 'claim', targetId: node.id, position: null };
        break;
      }
    }
  }

  // ── Expansion ────────────────────────────────────────────────────────────

  _findClaimTarget(state, player) {
    // Find nearest unclaimed/neutral node within link range of our network
    let best = null, bestD2 = Infinity;
    const lrange = player.base.linkRange;

    for (const [, node] of state.nodeSites) {
      if (node.status === 'claimed' || node.claimerSoldierId) continue;
      if (node.ownerId === player.id) continue;

      // Must be reachable from our base or a claimed node
      if (!this._inRange(state, player, node)) continue;

      // Prefer nodes close to our base
      const d2 = dist2(node.position, player.base.position);
      if (d2 < bestD2) { bestD2 = d2; best = node; }
    }
    return best;
  }

  _inRange(state, player, node) {
    const lrange = player.base.linkRange;
    if (dist2(player.base.position, node.position) < lrange * lrange) return true;
    for (const [, n] of state.nodeSites) {
      if (n.ownerId !== player.id || n.status !== 'claimed') continue;
      if (dist2(n.position, node.position) < lrange * lrange) return true;
    }
    return false;
  }

  // ── Harvesting ───────────────────────────────────────────────────────────

  _findNearestEatable(state, player) {
    let best = null, bestD2 = Infinity;
    const anchorPos = player.base.position;
    for (const [, eat] of state.eatables) {
      const d2 = dist2(eat.position, anchorPos);
      if (d2 < bestD2) { bestD2 = d2; best = eat; }
    }
    return best;
  }

  // ── Standard attack ───────────────────────────────────────────────────────

  _standardAttack(state, player, mySoldiers) {
    // Find the closest enemy network and attack nearest visible node/link
    let target = null, targetD2 = Infinity;

    for (const [, enemy] of state.players) {
      if (enemy.id === player.id || !enemy.alive) continue;
      const d2 = dist2(player.base.position, enemy.base.position);
      if (d2 < targetD2) { targetD2 = d2; target = enemy; }
    }
    if (!target) return;

    // Attack their nearest node
    for (const [, node] of state.nodeSites) {
      if (node.ownerId !== target.id || node.status !== 'claimed') continue;
      const attackers = mySoldiers.filter(s => s.order.kind === 'idle').slice(0, 3);
      for (const sol of attackers) {
        sol.order = { kind: 'attack', targetId: node.id, position: null };
      }
      return;
    }

    // If no nodes, attack their base
    const attackers = mySoldiers.filter(s => s.order.kind === 'idle').slice(0, 3);
    for (const sol of attackers) {
      sol.order = { kind: 'attack', targetId: target.base.id, position: null };
    }
  }

  // ── Aggressive attack ─────────────────────────────────────────────────────

  _aggressiveAttack(state, player, mySoldiers) {
    // Find the thinnest (lowest HP) trunk link closest to an enemy base
    let bestLink = null, bestScore = Infinity;

    for (const [, link] of state.links) {
      if (link.ownerId === player.id) continue;
      const from = state.resolve(link.fromId);
      const to   = state.resolve(link.toId);
      if (!from || !to) continue;

      // Score = distance to enemy base × link HP  (prefer close, weak links)
      const owner = state.players.get(link.ownerId);
      if (!owner?.alive) continue;
      const dToBase = dist(from.position, owner.base.position) +
                      dist(to.position,   owner.base.position);
      const score = dToBase * 0.001 + link.hp;
      if (score < bestScore) { bestScore = score; bestLink = link; }
    }

    if (bestLink) {
      const attackers = mySoldiers.filter(s => s.order.kind === 'idle').slice(0, 5);
      for (const sol of attackers) {
        sol.order = { kind: 'attack', targetId: bestLink.id, position: null };
      }
      return;
    }

    // Fallback to standard
    this._standardAttack(state, player, mySoldiers);
  }
}
