import { dist2 } from '../../utils/helpers.js';
import { Soldier, Link } from '../entities.js';
import {
  SPAWN_INTERVAL, CLAIM_TIME, CLAIM_RANGE, HARVEST_RANGE,
  EATABLE_TARGET, EATABLE_SPAWN_MS, WORLD_SIZE, LINK_RANGE,
  SOLDIER_DEFS, SUPPLY_RANGE, SUPPLY_GRACE_MS, ATTRITION_DPS,
} from '../constants.js';
import { spawnEatable } from '../World.js';

// Harvesters look this far for an eatable to auto-harvest.
const AUTO_HARVEST_RADIUS = 700;
// How often idle soldiers re-evaluate (throttled — cheap and per-frame is wasteful).
const AUTO_EXPAND_INTERVAL = 400; // ms
// How close a soldier must get to its guard post to count as "on station".
const STATION_ARRIVE = 24;

/** Speed multiplier from the owner's Speed buff. */
function spdMult(player) { return 1 + (player?.buffs?.spd ?? 0) * 0.10; }

/**
 * ProductionSystem
 * ────────────────
 * • Spawns soldiers at Bases on a timer
 * • Moves all soldiers toward their ordered position/target
 * • Handles node claiming (channeling logic)
 * • Handles eatable harvesting on contact
 * • Auto-expand: idle unselected soldiers claim nearby nodes / harvest
 * • Periodically respawns eatables
 */
export class ProductionSystem {
  update(state, dt, dtMs) {
    this._spawnSoldiers(state, dtMs);

    // Throttle idle re-evaluation — cheap and per-frame precision isn't needed.
    state._autoExpandTimer = (state._autoExpandTimer || 0) + dtMs;
    if (state._autoExpandTimer >= AUTO_EXPAND_INTERVAL) {
      state._autoExpandTimer = 0;
      this._idleBehavior(state);
    }

    this._moveSoldiers(state, dt, dtMs);
    this._updateClaiming(state, dtMs);
    this._updateSupply(state, dtMs);
    this._updateEatableRespawn(state, dtMs);
    this._updateSpawnProtect(state, dtMs);
  }

  // ── Idle behaviour ──────────────────────────────────────────────────────────
  // Idle, unselected soldiers do NOT auto-claim or auto-harvest (that's manual).
  // Instead each idle soldier holds its guard post: if it has drifted off-station
  // (e.g. after chasing an attacker via auto-defence) it walks back. The one
  // exception is the Harvester — a non-combat unit that auto-harvests eatables.
  _idleBehavior(state) {
    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0 || sol.selected) continue;
      if (sol.order.kind !== 'idle') continue;
      // The human player's grunts are driven by the FormationSystem — never
      // auto-task them here (would fight the formation's orders).
      if (sol.ownerId === state.playerId) continue;

      const player = state.players.get(sol.ownerId);
      if (!player?.alive) continue;

      // Let auto-defence (CombatSystem) claim any soldier with an enemy in range.
      if (this._enemyNear(state, sol)) continue;

      // Harvesters keep farming on their own.
      if (sol.type === 'harvester') {
        const eat = this._nearestEatableWithin(state, sol.position, AUTO_HARVEST_RADIUS);
        if (eat) { sol.order = { kind: 'harvest', targetId: eat.id, position: null }; continue; }
      }

      // Stationed soldier that drifted off its post → return to it.
      if (sol.stationed && sol.guardPos) {
        if (dist2(sol.position, sol.guardPos) > STATION_ARRIVE * STATION_ARRIVE) {
          sol.order = { kind: 'return', targetId: null, position: { ...sol.guardPos } };
        }
      }
    }
  }

  _enemyNear(state, sol) {
    const r2 = sol.autoR * sol.autoR;
    for (const [, e] of state.soldiers) {
      if (e.ownerId === sol.ownerId || e.hp <= 0) continue;
      if (dist2(sol.position, e.position) < r2) return true;
    }
    return false;
  }

  // ── Supply attrition ─────────────────────────────────────────────────────────
  // A soldier kept far from its own network (base or any owned node) for too long
  // starts bleeding HP until it returns to supply range. Keeps armies tethered to
  // the graph instead of roaming the map forever.
  _updateSupply(state, dtMs) {
    const sr2 = SUPPLY_RANGE * SUPPLY_RANGE;
    // Cache owned supply points per player lazily.
    const supplyByPlayer = new Map();
    const supplyPoints = (pid, player) => {
      let pts = supplyByPlayer.get(pid);
      if (!pts) {
        pts = [player.base.position];
        for (const [, n] of state.nodeSites)
          if (n.ownerId === pid && n.status === 'claimed') pts.push(n.position);
        supplyByPlayer.set(pid, pts);
      }
      return pts;
    };

    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0) continue;
      const player = state.players.get(sol.ownerId);
      if (!player?.alive) continue;

      const pts = supplyPoints(sol.ownerId, player);
      let supplied = false;
      for (const p of pts) {
        if (dist2(sol.position, p) < sr2) { supplied = true; break; }
      }

      if (supplied) {
        sol.outOfSupplyMs = 0;
      } else {
        sol.outOfSupplyMs += dtMs;
        if (sol.outOfSupplyMs > SUPPLY_GRACE_MS) {
          sol.hp = Math.max(0, sol.hp - ATTRITION_DPS * (dtMs / 1000));
        }
      }
    }
  }

  _nearestEatableWithin(state, pos, radius) {
    const r2 = radius * radius;
    let best = null, bestD2 = r2;
    for (const [, eat] of state.eatables) {
      const d2 = dist2(eat.position, pos);
      if (d2 < bestD2) { bestD2 = d2; best = eat; }
    }
    return best;
  }

  // ── Soldier Spawning ──────────────────────────────────────────────────────
  _spawnSoldiers(state, dtMs) {
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      if (player.isBot) this._spawnBot(state, player, dtMs);
      else              this._spawnFromQueue(state, player, dtMs);
    }
  }

  /**
   * Human player: work through the base's spawn queue. The player clicks a unit
   * button N times to enqueue N of it; the base produces one at a time (each
   * unit's own spawnMs), spending the unit's XP cost and respecting the pop
   * budget. If the head unit can't be afforded / doesn't fit, we hold.
   */
  _spawnFromQueue(state, player, dtMs) {
    const base = player.base;
    const q    = base.spawnQueue;
    if (!q.length) { base.buildTimer = 0; return; }

    const head = q[0];
    const def  = SOLDIER_DEFS[head.type];
    if (!def || !base.unlocked.has(head.type)) { q.shift(); return; } // stale entry

    // Accumulate build progress (Warmonger builds faster).
    const speedMul = base.specialization === 'warmonger' ? 0.7 : 1;
    base.buildTimer += dtMs;
    if (base.buildTimer < def.spawnMs * speedMul) return;

    // Ready to pop one — check XP and population budget.
    if (base.xp < def.xpCost) return;                       // can't afford; wait for XP
    if (state.soldierPop(player.id) + def.pop > state.popCap(player)) return; // no room

    base.buildTimer = 0;
    base.xp -= def.xpCost;

    this._emitSoldier(state, player, head.type);

    // Decrement the queue entry
    head.count--;
    if (head.count <= 0) q.shift();
  }

  /** Bots auto-spawn on a timer, respecting the population budget. */
  _spawnBot(state, player, dtMs) {
    const base = player.base;
    base.spawnTimer -= dtMs;
    if (base.spawnTimer > 0) return;
    base.spawnTimer = this._spawnInterval(player);

    const type = this._botSpawnType(base);
    const def  = SOLDIER_DEFS[type];
    if (state.soldierPop(player.id) + def.pop > state.popCap(player)) return;
    this._emitSoldier(state, player, type);
  }

  /** Create a soldier in a ring around the base (shared by player + bots). */
  _emitSoldier(state, player, type) {
    const base  = player.base;
    const angle = Math.random() * Math.PI * 2;
    const r     = 35 + Math.random() * 20;
    const x     = base.position.x + Math.cos(angle) * r;
    const y     = base.position.y + Math.sin(angle) * r;
    const sol   = new Soldier(player.id, type, x, y);
    state.soldiers.set(sol.id, sol);
    return sol;
  }

  _spawnInterval(player) {
    let interval = SPAWN_INTERVAL;
    if (player.base.specialization === 'warmonger') interval *= 0.7;
    return interval;
  }

  /**
   * Bots spawn grunts only (other unit types disabled for now — see
   * SOLDIER_DEFS / build UI. The smart-mix logic is preserved below, commented,
   * for when the other types are re-enabled).
   */
  _botSpawnType(/* base */) {
    // if (base.level >= 8) {
    //   const r = Math.random();
    //   if (r < 0.15) return 'saboteur';
    //   if (r < 0.30) return 'sentinel';
    //   if (r < 0.45) return 'harvester';
    // } else if (base.level >= 3 && Math.random() < 0.25) {
    //   return 'harvester';
    // }
    return 'grunt';
  }

  // ── Soldier Movement ──────────────────────────────────────────────────────
  _moveSoldiers(state, dt, dtMs) {
    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0) continue;
      const { kind, targetId, position } = sol.order;

      let targetPos = null;
      let stopDist  = 8;

      if (kind === 'move' || kind === 'attackMove' || kind === 'return') {
        targetPos = position;
        stopDist  = kind === 'return' ? STATION_ARRIVE : 12;
      } else if (kind === 'attack') {
        const t = state.resolve(targetId);
        if (!t || t.hp <= 0) { sol.order = { kind: 'idle', targetId: null, position: null }; continue; }
        targetPos = t.position ?? _linkMid(state, t);
        stopDist  = 28;
      } else if (kind === 'harvest') {
        const eat = state.eatables.get(targetId);
        if (!eat) { sol.order = { kind: 'idle', targetId: null, position: null }; continue; }
        targetPos = eat.position;
        stopDist  = HARVEST_RANGE;
      } else if (kind === 'claim') {
        const node = state.nodeSites.get(targetId);
        if (!node) { sol.order = { kind: 'idle', targetId: null, position: null }; continue; }
        targetPos = node.position;
        stopDist  = CLAIM_RANGE;
      }

      if (!targetPos) continue;

      const dx = targetPos.x - sol.position.x;
      const dy = targetPos.y - sol.position.y;
      const d2 = dx * dx + dy * dy;

      if (d2 > stopDist * stopDist) {
        const player = state.players.get(sol.ownerId);
        const len   = Math.sqrt(d2);
        const speed = sol.speed * spdMult(player) * dt;
        sol.position.x += (dx / len) * speed;
        sol.position.y += (dy / len) * speed;
        sol.facing = Math.atan2(dy, dx);
      } else {
        // Arrived
        if (kind === 'move' || kind === 'return') {
          // Reaching a move destination sets it as the guard post (stationed).
          if (kind === 'move' && position) { sol.stationed = true; sol.guardPos = { ...position }; }
          sol.order = { kind: 'idle', targetId: null, position: null };
        } else if (kind === 'attackMove' && !targetId) {
          sol.order = { kind: 'idle', targetId: null, position: null };
        }
        // claim/harvest handled separately below
      }

      // ── Eatable collection on proximity ──────────────────────────────────
      if (kind === 'harvest') {
        const eat = state.eatables.get(targetId);
        if (eat && dist2(sol.position, eat.position) < HARVEST_RANGE * HARVEST_RANGE) {
          let xp = eat.xpValue;
          if (sol.type === 'harvester') xp = Math.floor(xp * 1.75);
          const player = state.players.get(sol.ownerId);
          if (player) player.pendingXP += xp;
          state.eatables.delete(eat.id);
          sol.order = { kind: 'idle', targetId: null, position: null };
          state.event('eatableCollected', { x: eat.position.x, y: eat.position.y, xp });
        }
      }
    }
  }

  // ── Node Claiming ─────────────────────────────────────────────────────────
  // Node-centric: a node is claimed by however many of a player's soldiers are
  // standing on it with a `claim` order. More soldiers → faster claim (each
  // extra body adds its share of progress, capped so it can't be instant).
  _updateClaiming(state, dtMs) {
    // Bucket claim-ordered soldiers by the node they're actually in range of.
    // Map<nodeId, { ownerId → [soldier,…] }>
    const claimers = new Map();

    for (const [, sol] of state.soldiers) {
      if (sol.order.kind !== 'claim' || sol.hp <= 0) continue;

      const node = state.nodeSites.get(sol.order.targetId);
      if (!node) { sol.order = { kind: 'idle', targetId: null, position: null }; continue; }

      // Already owned by us and connected — nothing to do
      if (node.ownerId === sol.ownerId && node.status === 'claimed') {
        sol.order = { kind: 'idle', targetId: null, position: null }; continue;
      }

      // Only count soldiers actually within claim range of the node
      if (dist2(sol.position, node.position) > CLAIM_RANGE * CLAIM_RANGE) continue;

      let byOwner = claimers.get(node.id);
      if (!byOwner) { byOwner = new Map(); claimers.set(node.id, byOwner); }
      let list = byOwner.get(sol.ownerId);
      if (!list) { list = []; byOwner.set(sol.ownerId, list); }
      list.push(sol);
    }

    // Resolve each contested node
    for (const [nodeId, byOwner] of claimers) {
      const node = state.nodeSites.get(nodeId);
      if (!node) continue;

      // Pick the owner with the most soldiers present (ties → current claimer)
      let winner = null, winnerCount = 0;
      for (const [ownerId, list] of byOwner) {
        if (list.length > winnerCount) { winnerCount = list.length; winner = ownerId; }
      }
      if (!winner) continue;

      // Territory rule (authoritative): cannot claim inside enemy territory,
      // no matter how the claim order was issued. Cancel and bail if so.
      if (!state.canClaim(node, winner)) {
        node.claimProgress = 0;
        node.claimerSoldierId = null;
        for (const [, list] of byOwner)
          for (const s of list)
            if (s.order.kind === 'claim' && s.order.targetId === nodeId)
              s.order = { kind: 'idle', targetId: null, position: null };
        continue;
      }

      // If a different player is contesting, reset progress on ownership change
      if (node.claimerSoldierId !== winner) {
        node.claimerSoldierId = winner;
        node.claimProgress    = 0;
      }

      const winners = byOwner.get(winner);
      const player  = state.players.get(winner);

      // Base claim rate (1 soldier = CLAIM_TIME ms). Extra soldiers add
      // diminishing speed-up: N soldiers finish in ~CLAIM_TIME / N.
      let rate = winners.length / CLAIM_TIME;
      if (player?.base.specialization === 'sprawl') rate *= 1.4; // 40% faster

      node.claimProgress += rate * dtMs;

      if (node.claimProgress >= 1) {
        // Attribute the claim to the closest winning soldier (for link anchoring)
        let closest = winners[0], closestD2 = Infinity;
        for (const s of winners) {
          const d2 = dist2(s.position, node.position);
          if (d2 < closestD2) { closestD2 = d2; closest = s; }
        }
        this._claimNode(state, closest, node);
        // Free up every soldier that was claiming this node
        for (const [, list] of byOwner)
          for (const s of list)
            if (s.order.kind === 'claim' && s.order.targetId === nodeId)
              s.order = { kind: 'idle', targetId: null, position: null };
      }
    }

    // Decay stale progress: a node being claimed by nobody this frame slowly
    // resets so an abandoned half-claim doesn't linger forever.
    for (const [, node] of state.nodeSites) {
      if (node.claimProgress > 0 && node.status !== 'claimed' && !claimers.has(node.id)) {
        node.claimProgress = Math.max(0, node.claimProgress - (dtMs / CLAIM_TIME) * 0.5);
        if (node.claimProgress === 0) node.claimerSoldierId = null;
      }
    }
  }

  _claimNode(state, soldier, node) {
    const player = state.players.get(soldier.ownerId);
    if (!player) return;

    // TRANSACTIONAL CLAIM: a node may only become `claimed` if we can create a
    // link back to a valid anchor (base or an owned claimed node) within link
    // range AND with a free link slot. Otherwise the claim ABORTS — the node
    // stays neutral/unclaimed and can be retried once a real anchor exists.
    // (Fixes bots stranding disconnected nodes far from their network.)
    const lrange = player.base.linkRange;
    const lr2    = lrange * lrange;
    const cap    = player.base.linkCapacity + (player.base.specialization === 'sprawl' ? 1 : 0);

    // Gather every in-range anchor with a free link slot, nearest first.
    const anchors = [];
    const bd2 = dist2(node.position, player.base.position);
    if (bd2 < lr2 && state.linkCountFrom(soldier.ownerId, player.base.id) < cap) {
      anchors.push({ ent: player.base, d2: bd2 });
    }
    for (const [, n] of state.nodeSites) {
      if (n.ownerId !== soldier.ownerId || n.status !== 'claimed' || n.id === node.id) continue;
      const d2 = dist2(node.position, n.position);
      if (d2 < lr2 && state.linkCountFrom(soldier.ownerId, n.id) < cap) {
        anchors.push({ ent: n, d2 });
      }
    }

    if (anchors.length === 0) {
      // No valid anchor → abort the claim, leave the node as-is for a retry.
      node.claimProgress    = 0;
      node.claimerSoldierId = null;
      soldier.order = { kind: 'idle', targetId: null, position: null };
      state.notify('⚠️ Claim failed — no link back in range', 'warning', soldier.ownerId);
      return;
    }

    anchors.sort((a, b) => a.d2 - b.d2);
    const anchor = anchors[0].ent;

    // Commit: mark claimed and create the anchor link atomically.
    node.ownerId          = soldier.ownerId;
    node.status           = 'claimed';
    node.claimProgress    = 0;
    node.claimerSoldierId = null;
    node.hp               = node.maxHp;

    const link = new Link(soldier.ownerId, anchor.id, node.id);
    state.links.set(link.id, link);

    state.notify('🔵 Node claimed!', 'success', soldier.ownerId);
    soldier.order = { kind: 'idle', targetId: null, position: null };
  }

  // ── Eatable Respawn ───────────────────────────────────────────────────────
  _updateEatableRespawn(state, dtMs) {
    if (state.eatables.size >= EATABLE_TARGET) return;
    state.eatTimer = (state.eatTimer || 0) + dtMs;
    if (state.eatTimer > EATABLE_SPAWN_MS) {
      state.eatTimer = 0;
      const toSpawn = Math.min(5, EATABLE_TARGET - state.eatables.size);
      for (let i = 0; i < toSpawn; i++) spawnEatable(state);
    }
  }

  // ── Spawn Protection ─────────────────────────────────────────────────────
  _updateSpawnProtect(state, dtMs) {
    for (const [, player] of state.players) {
      if (!player.alive || !player.base.spawnProtected) continue;
      player.base.protectTimer -= dtMs;
      if (player.base.protectTimer <= 0) player.base.spawnProtected = false;
    }
  }
}

/** Get the midpoint of a link for soldiers to walk toward */
function _linkMid(state, link) {
  const from = state.resolve(link.fromId);
  const to   = state.resolve(link.toId);
  if (!from || !to) return null;
  return {
    x: (from.position.x + to.position.x) / 2,
    y: (from.position.y + to.position.y) / 2,
  };
}
