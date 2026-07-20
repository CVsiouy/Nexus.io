import { dist2 } from '../../utils/helpers.js';
import { ATTACK_RANGE, LINK_REGEN_DELAY, LINK_REGEN_RATE, SOLDIER_DEFS } from '../constants.js';

/**
 * CombatSystem
 * ────────────
 * • Updates attack cooldowns
 * • Auto-defense: idle unselected soldiers engage nearby enemies
 * • Executes attack orders (damage dealing)
 * • Link HP regen after idle period
 * • Cleans up dead entities, awards XP, checks elimination
 */
export class CombatSystem {
  constructor(connectivity) {
    this._conn = connectivity;
  }

  update(state, dt, dtMs) {
    const now = state.time;

    this._autoDefense(state);
    this._processAttacks(state, dtMs, now);
    this._regenLinks(state, dt, now);
    this._cleanup(state, now);
    this._checkElimination(state);
  }

  // ── Auto-defense ──────────────────────────────────────────────────────────
  _autoDefense(state) {
    for (const [, sol] of state.soldiers) {
      if (sol.selected || sol.order.kind !== 'idle' || sol.hp <= 0) continue;
      const player = state.players.get(sol.ownerId);
      if (!player?.alive) continue;

      let best = null, bestD2 = sol.autoR * sol.autoR;

      // Look for nearest enemy soldier
      for (const [, enemy] of state.soldiers) {
        if (enemy.ownerId === sol.ownerId || enemy.hp <= 0) continue;
        const d2 = dist2(sol.position, enemy.position);
        if (d2 < bestD2) { bestD2 = d2; best = enemy; }
      }

      // Also look for nearby enemy soldiers attacking friendly structures
      if (!best) {
        const bigR = sol.autoR * 1.5;
        for (const [, enemy] of state.soldiers) {
          if (enemy.ownerId === sol.ownerId || enemy.hp <= 0) continue;
          if (enemy.order.kind !== 'attack') continue;
          const target = state.resolve(enemy.order.targetId);
          if (!target) continue;
          if (target.ownerId !== sol.ownerId) continue;
          const d2 = dist2(sol.position, enemy.position);
          if (d2 < bigR * bigR) { best = enemy; break; }
        }
      }

      if (best) {
        sol.order = { kind: 'attack', targetId: best.id, position: null };
      }
    }
  }

  // ── Attack execution ─────────────────────────────────────────────────────
  _processAttacks(state, dtMs, now) {
    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0) continue;
      if (sol.atkCd > 0) { sol.atkCd -= dtMs; continue; }

      const { kind, targetId } = sol.order;
      if (kind !== 'attack' && kind !== 'attackMove') continue;
      if (!targetId) continue;

      const target = state.resolve(targetId);
      if (!target || target.hp <= 0 || (target.ownerId === sol.ownerId)) {
        sol.order = { kind: 'idle', targetId: null, position: null };
        continue;
      }

      const targetPos = _pos(target);
      if (!targetPos) continue;
      const d2 = dist2(sol.position, targetPos);
      const range = ATTACK_RANGE;

      if (d2 <= range * range) {
        this._dealDamage(state, sol, target, now);
        const atkSpeedMult = sol.ownerId !== state.playerId ? 1 :
          (state.players.get(sol.ownerId)?.base.specialization === 'warmonger' ? 0.85 : 1);
        sol.atkCd = 500 * atkSpeedMult; // 2 attacks/sec baseline
      }
    }

    // Boss attacks nearby player soldiers
    if (state.boss) {
      if (state.boss.atkCd > 0) state.boss.atkCd -= dtMs;
      else {
        for (const [, sol] of state.soldiers) {
          if (sol.hp <= 0) continue;
          if (dist2(sol.position, state.boss.position) < 55 * 55) {
            sol.hp = Math.max(0, sol.hp - state.boss.damage);
            state.boss.atkCd = 800;
            break;
          }
        }
      }
    }
  }

  _dealDamage(state, attacker, target, now) {
    const def = SOLDIER_DEFS[attacker.type];
    let dmg = attacker.damage;

    // Specialization bonus
    const player = state.players.get(attacker.ownerId);
    if (player?.base.specialization === 'warmonger') dmg *= 1.25;

    // Saboteur vs structures
    const isStructure = state.links.has(target.id) || state.nodeSites.has(target.id) || state.bases.has(target.id);
    if (attacker.type === 'saboteur' && isStructure) dmg *= 2;

    // Sentinel defense bonus (when defending = auto-defending)
    if (attacker.type === 'sentinel' && !attacker.selected) dmg *= 1.5;

    target.hp = Math.max(0, target.hp - dmg);
    if (target.lastDamagedAt !== undefined) target.lastDamagedAt = now;

    // Track boss damage for XP split
    if (state.boss && target.id === state.boss.id) {
      const prev = state.boss.contrib.get(attacker.ownerId) || 0;
      state.boss.contrib.set(attacker.ownerId, prev + dmg);
    }

    // Link destroyed?
    if (state.links.has(target.id) && target.hp <= 0) {
      state.event('linkDestroyed', { x: (state.resolve(target.fromId)?.position.x + state.resolve(target.toId)?.position.x) / 2 });
      this._conn.onLinkDestroyed(state, target);
      state.notify('⚡ Enemy link severed!', 'success', attacker.ownerId);
      state.notify('💔 Your link was cut!',  'warning', target.ownerId);
      // Award XP to attacker
      const ap = state.players.get(attacker.ownerId);
      if (ap) ap.pendingXP += 20;
    }
  }

  // ── Link regen ────────────────────────────────────────────────────────────
  _regenLinks(state, dt, now) {
    for (const [, link] of state.links) {
      if (link.hp >= link.maxHp) continue;
      if (now - link.lastDamagedAt > LINK_REGEN_DELAY) {
        // Bastion spec bonus
        const player = state.players.get(link.ownerId);
        const mult = player?.base.specialization === 'bastion' ? 1.4 : 1;
        link.hp = Math.min(link.maxHp, link.hp + LINK_REGEN_RATE * dt * mult);
      }
    }
  }

  // ── Cleanup dead entities ─────────────────────────────────────────────────
  _cleanup(state, now) {
    for (const [id, sol] of state.soldiers) {
      if (sol.hp <= 0) {
        // Award XP to any attacker that killed this soldier
        // (simplified: just remove)
        state.soldiers.delete(id);
      }
    }

    // Boss death
    if (state.boss && state.boss.hp <= 0) {
      // Split XP among top contributors
      const contributions = [...state.boss.contrib.entries()]
        .sort((a, b) => b[1] - a[1]);
      contributions.forEach(([pid, _dmg], rank) => {
        const p = state.players.get(pid);
        if (p) {
          const bonus = rank === 0 ? 500 : 200;
          p.pendingXP += bonus;
          state.notify(`🏆 Boss slain! +${bonus} XP!`, 'success', pid);
        }
      });
      state.boss = null;
      state.event('bossKilled', {});
    }

    // Destroyed nodes
    for (const [, node] of state.nodeSites) {
      if (node.hp <= 0 && (node.status === 'claimed' || node.status === 'orphaned')) {
        const prevOwner = node.ownerId;
        node.status    = 'neutral';
        node.ownerId   = null;
        node.hp        = node.maxHp;
        node.claimProgress = 0;
        node.claimerSoldierId = null;
        // Remove associated links
        for (const [lid, link] of state.links) {
          if (link.ownerId === prevOwner && (link.fromId === node.id || link.toId === node.id)) {
            this._conn.onLinkDestroyed(state, link);
          }
        }
        state.notify('💥 Node destroyed!', 'warning', prevOwner);
      }
    }
  }

  // ── Elimination ───────────────────────────────────────────────────────────
  _checkElimination(state) {
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      if (player.base.hp <= 0) {
        player.alive = false;
        // Neutralize all their nodes
        for (const [, node] of state.nodeSites) {
          if (node.ownerId === player.id) {
            node.status   = 'neutral';
            node.ownerId  = null;
            node.claimProgress = 0;
          }
        }
        // Remove all their links
        for (const [lid, link] of state.links) {
          if (link.ownerId === player.id) state.links.delete(lid);
        }
        // Remove their soldiers
        for (const [sid, sol] of state.soldiers) {
          if (sol.ownerId === player.id) state.soldiers.delete(sid);
        }
        if (player.id === state.playerId) {
          state.notify('💀 Your Base was destroyed!', 'warning', 'player');
        } else {
          state.notify(`✅ ${player.id} eliminated!`, 'success', 'player');
        }
      }
    }
  }
}

// Helper: get position from any entity type
function _pos(entity) {
  return entity.position ?? null;
}
