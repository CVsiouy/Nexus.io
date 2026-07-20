import { dist2 } from '../../utils/helpers.js';
import { Soldier, Link } from '../entities.js';
import {
  SPAWN_INTERVAL, CLAIM_TIME, CLAIM_RANGE, HARVEST_RANGE,
  EATABLE_TARGET, EATABLE_SPAWN_MS, WORLD_SIZE,
} from '../constants.js';
import { spawnEatable } from '../World.js';

/**
 * ProductionSystem
 * ────────────────
 * • Spawns soldiers at Bases on a timer
 * • Moves all soldiers toward their ordered position/target
 * • Handles node claiming (channeling logic)
 * • Handles eatable harvesting on contact
 * • Periodically respawns eatables
 */
export class ProductionSystem {
  update(state, dt, dtMs) {
    this._spawnSoldiers(state, dtMs);
    this._moveSoldiers(state, dt, dtMs);
    this._updateClaiming(state, dtMs);
    this._updateEatableRespawn(state, dtMs);
    this._updateSpawnProtect(state, dtMs);
  }

  // ── Soldier Spawning ──────────────────────────────────────────────────────
  _spawnSoldiers(state, dtMs) {
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const base = player.base;
      const interval = this._spawnInterval(player);

      base.spawnTimer -= dtMs;
      if (base.spawnTimer > 0) continue;
      base.spawnTimer = interval;

      // Population cap = 6 + level*3 (per player)
      const cap = 6 + base.level * 3;
      if (state.soldierCount(player.id) >= cap) continue;

      // Spawn position: ring around base
      const angle = Math.random() * Math.PI * 2;
      const r     = 35 + Math.random() * 20;
      const x     = base.position.x + Math.cos(angle) * r;
      const y     = base.position.y + Math.sin(angle) * r;

      // Bots might spawn harvesters/sentinels when unlocked
      let type = 'grunt';
      if (player.isBot && base.level >= 3 && Math.random() < 0.2) type = 'harvester';
      if (player.isBot && base.level >= 8 && Math.random() < 0.15) type = 'sentinel';

      const sol = new Soldier(player.id, type, x, y);
      state.soldiers.set(sol.id, sol);
    }
  }

  _spawnInterval(player) {
    let interval = SPAWN_INTERVAL;
    if (player.base.specialization === 'warmonger') interval *= 0.7;
    return interval;
  }

  // ── Soldier Movement ──────────────────────────────────────────────────────
  _moveSoldiers(state, dt, dtMs) {
    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0) continue;
      const { kind, targetId, position } = sol.order;

      let targetPos = null;
      let stopDist  = 8;

      if (kind === 'move' || kind === 'attackMove') {
        targetPos = position;
        stopDist  = 12;
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
        const len   = Math.sqrt(d2);
        const speed = sol.speed * dt;
        sol.position.x += (dx / len) * speed;
        sol.position.y += (dy / len) * speed;
        sol.facing = Math.atan2(dy, dx);
      } else {
        // Arrived
        if (kind === 'move') {
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
  _updateClaiming(state, dtMs) {
    for (const [, sol] of state.soldiers) {
      if (sol.order.kind !== 'claim' || sol.hp <= 0) continue;

      const node = state.nodeSites.get(sol.order.targetId);
      if (!node) { sol.order = { kind: 'idle', targetId: null, position: null }; continue; }

      // Already owned by us
      if (node.ownerId === sol.ownerId && node.status === 'claimed') {
        sol.order = { kind: 'idle', targetId: null, position: null }; continue;
      }

      // Must be in range
      if (dist2(sol.position, node.position) > CLAIM_RANGE * CLAIM_RANGE) continue;

      // Assign claimer
      if (node.claimerSoldierId !== sol.id) {
        node.claimerSoldierId = sol.id;
        node.claimProgress    = 0;
      }

      // Progress
      const player = state.players.get(sol.ownerId);
      let rate = 1 / CLAIM_TIME;
      if (player?.base.specialization === 'sprawl') rate /= 0.6; // 40% faster

      node.claimProgress += rate * dtMs;

      if (node.claimProgress >= 1) {
        this._claimNode(state, sol, node);
      }
    }
  }

  _claimNode(state, soldier, node) {
    const prevOwner = node.ownerId;
    node.ownerId        = soldier.ownerId;
    node.status         = 'claimed';
    node.claimProgress  = 0;
    node.claimerSoldierId = null;
    node.hp             = node.maxHp;

    // Find closest anchor (base or owned node) within link range
    const player = state.players.get(soldier.ownerId);
    if (!player) return;

    let anchor = null, anchorD2 = Infinity;
    const lrange = player.base.linkRange;

    // Check base
    const bd2 = dist2(node.position, player.base.position);
    if (bd2 < lrange * lrange && bd2 < anchorD2) {
      anchor = player.base; anchorD2 = bd2;
    }
    // Check owned nodes
    for (const [, n] of state.nodeSites) {
      if (n.ownerId !== soldier.ownerId || n.status !== 'claimed' || n.id === node.id) continue;
      const d2 = dist2(node.position, n.position);
      if (d2 < lrange * lrange && d2 < anchorD2) { anchor = n; anchorD2 = d2; }
    }

    if (anchor) {
      // Check link capacity on anchor
      const cap = player.base.linkCapacity + (player.base.specialization === 'sprawl' ? 1 : 0);
      const used = state.linkCountFrom(soldier.ownerId, anchor.id);
      if (used < cap) {
        const link = new Link(soldier.ownerId, anchor.id, node.id);
        state.links.set(link.id, link);
      }
    }

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
