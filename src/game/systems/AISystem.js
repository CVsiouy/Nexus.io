import { dist2, dist } from '../../utils/helpers.js';
import { BOT_THINK_RATE } from '../constants.js';

/**
 * AISystem — Improved Bot Intelligence
 * ─────────────────────────────────────
 * Three-tier bot AI with real-time threat detection and active defense:
 *
 *   passive    — expand slowly, harvest, flee when overwhelmed
 *   standard   — expand, harvest, opportunistic attack, defend when threatened
 *   aggressive — rapid expansion, trunk-link hunting, active defense, counter-attack
 *
 * Key improvements:
 *   - THREAT DETECTION: scans enemy soldiers near own nodes/links/base each tick
 *   - ACTIVE DEFENSE: immediately sends soldiers to defend threatened structures
 *   - COUNTER-ATTACK: after repelling attack, aggressive bots pursue the attacker
 *   - SCOUT PHASE: sends a soldier to explore when idle
 *   - SMARTER TARGETS: prefers trunk links (single-link nodes = easy orphan chain)
 */
export class AISystem {
  update(state, dtMs) {
    for (const [, player] of state.players) {
      if (!player.isBot || !player.alive) continue;

      player._thinkTimer -= dtMs;
      if (player._thinkTimer > 0) continue;
      player._thinkTimer = BOT_THINK_RATE + Math.random() * 800;

      this._think(state, player);
    }
  }

  _think(state, player) {
    const tier  = player.botTier;
    const brain = player._brain;

    // Gather state
    const mySoldiers = [];
    for (const [, sol] of state.soldiers) {
      if (sol.ownerId === player.id && sol.hp > 0) mySoldiers.push(sol);
    }
    const myNodes = state.nodeCount(player.id);

    // Available pool: soldiers we're allowed to re-task this cycle. We CONSUME
    // from this list as we assign jobs so a single soldier never receives two
    // conflicting orders in one think (the old bug: claim → then overwritten by
    // harvest/attack in the same pass, so nothing ever got claimed).
    // Claiming/attacking soldiers already committed to a job are left alone.
    const pool = mySoldiers.filter(s =>
      s.order.kind === 'idle' || s.order.kind === 'harvest' || s.order.kind === 'move'
    );
    const take = (n) => pool.splice(0, n);

    // How many soldiers are ALREADY claiming a given node (so we don't over-commit)
    const claimingNode = (nodeId) =>
      mySoldiers.filter(s => s.order.kind === 'claim' && s.order.targetId === nodeId).length;

    // ── 0. THREAT DETECTION (all tiers) ──────────────────────────────────
    const threat = this._detectThreat(state, player);
    if (threat) {
      const maxDef = tier === 'aggressive' ? 4 : tier === 'standard' ? 3 : 2;
      const defenders = take(maxDef);
      for (const sol of defenders) {
        sol.order = { kind: 'attack', targetId: threat.id, position: null };
      }
      if (tier === 'aggressive' && threat.ownerId) brain.counterTarget = threat.ownerId;
    }

    // ── 1. RECLAIM ORPHANED NODES (high priority after defense) ──────────
    for (const [, node] of state.nodeSites) {
      if (node.ownerId !== player.id || node.status !== 'orphaned') continue;
      if (claimingNode(node.id) >= 1) continue;
      const sol = take(1)[0];
      if (sol) sol.order = { kind: 'claim', targetId: node.id, position: null };
    }

    // ── 2. STEAL FRESH NEUTRAL NODES (all tiers) ─────────────────────────
    for (const [, node] of state.nodeSites) {
      if (node.status !== 'neutral' || node.claimerSoldierId) continue;
      if (!this._inRange(state, player, node)) continue;
      if (!state.canClaim(node, player.id)) continue; // not inside enemy territory
      if (claimingNode(node.id) >= 1) continue;
      const sol = take(1)[0];
      if (sol) { sol.order = { kind: 'claim', targetId: node.id, position: null }; break; }
    }

    // ── 3. EXPAND: claim unclaimed nodes (ALL tiers expand — passive just slower) ─
    // Every tier should build a network; a passive bot that never expands is a
    // dead opponent. We keep expanding until the tier's node cap.
    {
      const claimTarget = this._findClaimTarget(state, player, myNodes);
      if (claimTarget && claimingNode(claimTarget.id) === 0) {
        // Send 2 soldiers so the claim finishes quickly (halves claim time)
        const nClaimers = tier === 'passive' ? 1 : 2;
        const claimers = take(nClaimers);
        for (const sol of claimers) {
          sol.order = { kind: 'claim', targetId: claimTarget.id, position: null };
        }
      }
    }

    // ── 4. HARVEST EATABLES (leftover soldiers farm XP) ──────────────────
    // Leave a small idle reserve for auto-defense; send the rest to harvest.
    {
      const reserve = tier === 'aggressive' ? 1 : 2;
      const spare   = Math.max(0, pool.length - reserve);
      const harvesters = take(Math.min(spare, 3));
      for (const sol of harvesters) {
        const eat = this._findNearestEatable(state, sol.position);
        if (eat) sol.order = { kind: 'harvest', targetId: eat.id, position: null };
      }
    }

    // ── 5. ATTACK ─────────────────────────────────────────────────────────
    if (tier === 'passive') return;
    if (mySoldiers.length < 3) return; // need minimum force

    if (tier === 'standard') {
      if (myNodes >= 3 && pool.length >= 2 && Math.random() < 0.5) {
        this._standardAttack(state, player, take(3));
      }
    } else if (tier === 'aggressive') {
      // Counter-attack a specific enemy if we just defended
      if (brain.counterTarget && pool.length >= 2) {
        const didCounter = this._counterAttack(state, player, take(4), brain.counterTarget);
        brain.counterTarget = null;
        if (didCounter) return;
      }
      // Regular aggressive attack — hunt trunk links
      if (myNodes >= 2 && pool.length >= 2) {
        this._aggressiveAttack(state, player, take(4));
      }
    }
  }

  // ── Threat Detection ────────────────────────────────────────────────────

  /**
   * Returns the most dangerous enemy entity near our structures.
   * Priority: base > claimed nodes > links
   */
  _detectThreat(state, player) {
    const THREAT_RADIUS = 200; // world px — detection range
    let worstThreat = null;
    let worstDanger = 0;

    for (const [, enemy] of state.soldiers) {
      if (enemy.ownerId === player.id || enemy.hp <= 0) continue;

      // Check proximity to our base (top priority)
      const dBase = dist(enemy.position, player.base.position);
      if (dBase < THREAT_RADIUS + 100) {
        const danger = 300 - dBase;
        if (danger > worstDanger) { worstDanger = danger; worstThreat = enemy; }
        continue;
      }

      // Check proximity to our nodes
      for (const [, node] of state.nodeSites) {
        if (node.ownerId !== player.id || node.status !== 'claimed') continue;
        const d = dist(enemy.position, node.position);
        if (d < THREAT_RADIUS) {
          const danger = 100 - d;
          if (danger > worstDanger) { worstDanger = danger; worstThreat = enemy; }
        }
      }

      // Check proximity to our links
      for (const [, link] of state.links) {
        if (link.ownerId !== player.id) continue;
        const from = state.resolve(link.fromId);
        const to   = state.resolve(link.toId);
        if (!from || !to) continue;
        // Use midpoint of link as threat check
        const mx = (from.position.x + to.position.x) / 2;
        const my = (from.position.y + to.position.y) / 2;
        const d = dist(enemy.position, { x: mx, y: my });
        if (d < THREAT_RADIUS * 0.7) {
          const danger = 70 - d;
          if (danger > worstDanger) { worstDanger = danger; worstThreat = enemy; }
        }
      }
    }

    return worstThreat;
  }

  // ── Expansion ────────────────────────────────────────────────────────────

  _findClaimTarget(state, player, myNodes) {
    let best = null, bestScore = -Infinity;
    const maxNodes = player.botTier === 'aggressive' ? 16 : player.botTier === 'standard' ? 12 : 7;
    if (myNodes >= maxNodes) return null;

    const lrange = player.base.linkRange;
    const center = { x: 3000, y: 3000 };

    for (const [, node] of state.nodeSites) {
      if (node.status === 'claimed' || node.status === 'orphaned' || node.claimerSoldierId) continue;
      if (node.ownerId === player.id) continue;
      if (!this._inRange(state, player, node)) continue;
      if (!state.canClaim(node, player.id)) continue; // not inside enemy territory

      // Distance from the nearest anchor (base or owned node) — prefer nodes that
      // sit near the FRONTIER of our reach so the network spreads outward as a
      // tree rather than piling up right on top of the base.
      let anchorD = dist(node.position, player.base.position);
      for (const [, n] of state.nodeSites) {
        if (n.ownerId !== player.id || n.status !== 'claimed') continue;
        const d = dist(node.position, n.position);
        if (d < anchorD) anchorD = d;
      }

      // Prefer nodes that are reachable (anchorD < lrange) but toward the outer
      // edge of that reach (good spread), and biased slightly toward the map
      // centre where the richer eatables and the boss live.
      const spread   = anchorD / lrange;                       // 0..1, higher = further out
      const centrePull = 1 - dist(node.position, center) / 4200; // ~1 near centre
      const score = spread * 0.7 + centrePull * 0.3;

      if (score > bestScore) { bestScore = score; best = node; }
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

  // ── Harvesting ────────────────────────────────────────────────────────────

  _findNearestEatable(state, fromPos) {
    let best = null, bestD2 = Infinity;
    for (const [, eat] of state.eatables) {
      const d2 = dist2(eat.position, fromPos);
      if (d2 < bestD2) { bestD2 = d2; best = eat; }
    }
    return best;
  }

  // ── Standard Attack ───────────────────────────────────────────────────────

  _standardAttack(state, player, idleSoldiers) {
    // Find nearest enemy, attack their nearest exposed node
    let target = null, targetD2 = Infinity;
    for (const [, enemy] of state.players) {
      if (enemy.id === player.id || !enemy.alive) continue;
      const d2 = dist2(player.base.position, enemy.base.position);
      if (d2 < targetD2) { targetD2 = d2; target = enemy; }
    }
    if (!target) return;

    // Find the enemy's node closest to our base (easiest to attack)
    let bestNode = null, bestD2 = Infinity;
    for (const [, node] of state.nodeSites) {
      if (node.ownerId !== target.id || node.status !== 'claimed') continue;
      const d2 = dist2(player.base.position, node.position);
      if (d2 < bestD2) { bestD2 = d2; bestNode = node; }
    }

    if (bestNode) {
      const attackers = idleSoldiers.slice(0, 3);
      for (const sol of attackers) {
        sol.order = { kind: 'attack', targetId: bestNode.id, position: null };
      }
    } else {
      // No nodes — go for the base
      const attackers = idleSoldiers.slice(0, 3);
      for (const sol of attackers) {
        sol.order = { kind: 'attack', targetId: target.base.id, position: null };
      }
    }
  }

  // ── Aggressive Attack ─────────────────────────────────────────────────────

  _aggressiveAttack(state, player, idleSoldiers) {
    // Strategy: find the enemy trunk link that would orphan the most nodes if cut.
    // A trunk link is one that, if removed, disconnects a sub-tree from the enemy base.
    // Heuristic: pick the link CLOSEST to an enemy base (most likely to be the trunk).

    let bestLink = null, bestScore = -Infinity;

    for (const [, link] of state.links) {
      if (link.ownerId === player.id) continue;
      const owner = state.players.get(link.ownerId);
      if (!owner?.alive) continue;

      const from = state.resolve(link.fromId);
      const to   = state.resolve(link.toId);
      if (!from || !to) continue;

      // Score: lower HP = easier to cut. fromId being the base = it's a trunk link.
      const isFromBase = link.fromId === owner.base.id;
      const hpScore    = (link.maxHp - link.hp) / link.maxHp; // 0 = full, 1 = dead
      const trunkBonus = isFromBase ? 2 : 0;
      const distScore  = 1 / (1 + dist(player.base.position, from.position) * 0.001);

      const score = trunkBonus + hpScore + distScore;
      if (score > bestScore) { bestScore = score; bestLink = link; }
    }

    if (bestLink) {
      const count = idleSoldiers.length >= 4 ? 4 : idleSoldiers.length;
      for (let i = 0; i < count; i++) {
        idleSoldiers[i].order = { kind: 'attack', targetId: bestLink.id, position: null };
      }
      return;
    }

    // No links found — do standard attack
    this._standardAttack(state, player, idleSoldiers);
  }

  // ── Counter Attack ────────────────────────────────────────────────────────

  _counterAttack(state, player, idleSoldiers, enemyId) {
    const enemy = state.players.get(enemyId);
    if (!enemy?.alive) return false;

    // Find their nearest node to us and attack it
    let bestNode = null, bestD2 = Infinity;
    for (const [, node] of state.nodeSites) {
      if (node.ownerId !== enemyId || node.status !== 'claimed') continue;
      const d2 = dist2(player.base.position, node.position);
      if (d2 < bestD2) { bestD2 = d2; bestNode = node; }
    }

    if (bestNode) {
      const attackers = idleSoldiers.slice(0, 4);
      for (const sol of attackers) {
        sol.order = { kind: 'attack', targetId: bestNode.id, position: null };
      }
      return true;
    }
    return false;
  }
}
