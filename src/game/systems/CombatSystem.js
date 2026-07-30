import { dist2 } from '../../utils/helpers.js';
import { Projectile } from '../entities.js';
import {
  ATTACK_RANGE, TURRET_DEFS, STRUCTURE_DMG_MULT, WALL_DMG_MULT, SOLDIER_RADIUS, WALL_CELL_SIZE,
  CONQUEST_INCOME_BONUS, CONQUEST_GOLD_LUMP, CONQUEST_XP, KILL_XP,
  EATABLE_DEFS, WILDLING_XP_BOUNTY, BASE_DEFENSE_RADIUS, DEFENDER_ATK_MULT, DEFENDER_DMG_TAKEN,
} from '../constants.js';
import { isStructureTarget, targetRadius } from './GroupSystem.js';
import { outerBlockingLayer, nearestCell, damageCell, repairWalls } from '../walls.js';

const STRIKE_CD = 500; // ms baseline between strikes (2/sec)

/**
 * CombatSystem
 * ────────────
 * • Structure assaults: a squad attacking a base/boss SURROUNDS it, but only
 *   one soldier strikes at a time (the squad takes turns).
 * • Skirmishes: soldiers auto-engage the nearest enemy soldier in range.
 * • Turrets auto-fire projectiles at enemy soldiers; missiles splash.
 * • Boss swipes nearby soldiers.
 * • Cleans up the dead; on a base kill, credits the attacker (claim the mine).
 */
export class CombatSystem {
  update(state, dt, dtMs) {
    const now = state.time;
    this._repairWalls(state, now, dt);
    this._structureAssaults(state, dtMs, now);
    this._skirmish(state, dtMs, now);
    this._turretFire(state, dtMs);
    this._moveProjectiles(state, dt, dtMs);
    this._bossSwipe(state, dtMs);
    this._cleanup(state);
    this._checkElimination(state);
  }

  _repairWalls(state, now, dt) {
    for (const [, b] of state.bases) repairWalls(b, now, dt);
  }

  // ── Structure assault: punch through walls (one cell = a gap), then the base ──
  _structureAssaults(state, dtMs, now) {
    for (const [, g] of state.groups) {
      if (g.status !== 'attacking') continue;
      const base = state.resolve(g.targetId);
      if (!base || base.hp <= 0 || !isStructureTarget(state, base)) continue;

      const layer = state.bases.has(base.id) ? outerBlockingLayer(base) : null;
      if (layer) this._assaultWall(state, g, base, layer, dtMs, now);
      else       this._assaultBase(state, g, base, dtMs, now);
    }
  }

  /**
   * Wall breach: the squad focus-fires the nearest cell of the outermost COMPLETE
   * ring. Destroying that ONE cell opens a gap (the rest of the ring stays up) and
   * the squad advances to the next ring / the base next tick.
   */
  _assaultWall(state, g, base, layer, dtMs, now) {
    const cen = this._groupCentroid(state, g);
    const near = nearestCell(base, layer, cen);
    if (!near) return;
    const eff = ATTACK_RANGE + WALL_CELL_SIZE;

    for (const id of g.memberIds) {
      const s = state.soldiers.get(id);
      if (!s || s.hp <= 0) continue;
      if (s.atkCd > 0) continue;
      if (dist2(s.position, near.pos) > eff * eff) continue;  // must be at the breach point
      // NOTE: unlike the base, walls take damage even with enemy soldiers around.

      const destroyed = damageCell(base, layer, near.cell, this._siegeDamage(state, s), now);
      s.atkCd = STRIKE_CD;
      if (destroyed) break; // gap opened — retarget next tick
    }
  }

  /** True if the base still has living defenders inside its muster ring. */
  _baseShielded(state, base) {
    const r2 = BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS;
    for (const [, s] of state.soldiers) {
      if (s.hp <= 0 || s.ownerId !== base.ownerId) continue;
      if (dist2(s.position, base.position) < r2) return true;
    }
    return false;
  }

  /** Base assault: the surrounding squad focus-fires the base (big armies crack it). */
  _assaultBase(state, g, base, dtMs, now) {
    // A base ringed by its own soldiers can't be touched until they're cleared.
    if (this._baseShielded(state, base)) return;
    const eff = ATTACK_RANGE + targetRadius(state, base);
    for (const id of g.memberIds) {
      const s = state.soldiers.get(id);
      if (!s || s.hp <= 0) continue;
      if (s.atkCd > 0) continue;
      if (this._enemyNear(state, s)) continue;               // priority: enemy soldiers over the base
      if (dist2(s.position, base.position) > eff * eff) continue;
      this._dealDamage(state, s, base, now, /*siege*/ true);
      s.atkCd = STRIKE_CD * (state.players.get(s.ownerId)?.base.specialization === 'warmonger' ? 0.85 : 1);
    }
  }

  /** True if an enemy soldier (or wildling) is within this soldier's auto-engage radius. */
  _enemyNear(state, sol) {
    const r2 = sol.autoR * sol.autoR;
    for (const [, e] of state.soldiers) {
      if (e.hp <= 0 || !state.areEnemies(sol.ownerId, e.ownerId)) continue;
      if (dist2(sol.position, e.position) < r2) return true;
    }
    for (const [, w] of state.wildlings) {
      if (w.hp <= 0) continue;
      if (dist2(sol.position, w.position) < r2) return true;
    }
    return false;
  }

  /** Siege damage a soldier deals to a WALL cell, with buffs. */
  _siegeDamage(state, attacker) {
    const player = state.players.get(attacker.ownerId);
    let dmg = attacker.damage;
    if (player?.base.specialization === 'warmonger') dmg *= 1.25;
    dmg *= 1 + (player?.buffs?.atk ?? 0) * 0.10;
    if (attacker.type === 'saboteur') dmg *= 2;
    return dmg * WALL_DMG_MULT;
  }

  _groupCentroid(state, g) {
    let x = 0, y = 0, n = 0;
    for (const id of g.memberIds) {
      const s = state.soldiers.get(id);
      if (s && s.hp > 0) { x += s.position.x; y += s.position.y; n++; }
    }
    return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
  }

  // ── Skirmish: soldiers auto-engage whatever's actually IN ATTACK RANGE ────────
  // Priority: enemy soldiers & wildlings (hostile) first, then XP eatables (food).
  // Only in-range targets count, so a distant hostile never blocks nearby farming.
  _skirmish(state, dtMs, now) {
    const effS2 = (ATTACK_RANGE + SOLDIER_RADIUS) ** 2;
    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0) continue;
      if (sol.atkCd > 0) { sol.atkCd -= dtMs; continue; }

      // 1. nearest hostile within attack range (enemy soldier or wildling)
      let best = null, bestD2 = Infinity, kind = null;
      for (const [, e] of state.soldiers) {
        if (e.hp <= 0 || !state.areEnemies(sol.ownerId, e.ownerId)) continue;
        const d2 = dist2(sol.position, e.position);
        if (d2 <= effS2 && d2 < bestD2) { bestD2 = d2; best = e; kind = 'soldier'; }
      }
      const effW2 = (ATTACK_RANGE + 20) ** 2;
      for (const [, w] of state.wildlings) {
        if (w.hp <= 0) continue;
        const d2 = dist2(sol.position, w.position);
        if (d2 <= effW2 && d2 < bestD2) { bestD2 = d2; best = w; kind = 'wildling'; }
      }
      // 2. else nearest eatable within attack range (food)
      if (!best) {
        for (const [, ea] of state.eatables) {
          const eff2 = (ATTACK_RANGE + (EATABLE_DEFS[ea.type]?.sz ?? 12)) ** 2;
          const d2 = dist2(sol.position, ea.position);
          if (d2 <= eff2 && d2 < bestD2) { bestD2 = d2; best = ea; kind = 'eatable'; }
        }
      }
      if (!best) continue;

      const p = state.players.get(sol.ownerId);
      sol.atkCd = STRIKE_CD * (p?.base.specialization === 'warmonger' ? 0.85 : 1);

      if (kind === 'soldier') {
        this._dealDamage(state, sol, best, now, false);
      } else {
        // Wildlings & eatables: apply plain damage; award XP + remove on death.
        let dmg = sol.damage * (1 + (p?.buffs?.atk ?? 0) * 0.10);
        if (p?.base.specialization === 'warmonger') dmg *= 1.25;
        const wasAlive = best.hp > 0;
        best.hp = Math.max(0, best.hp - dmg);

        // Body damage: ramming an eatable hurts the soldier a little.
        if (kind === 'eatable') {
          const body = EATABLE_DEFS[best.type]?.body ?? 1;
          sol.hp = Math.max(0, sol.hp - body);
          if (sol.hp <= 0) continue; // the soldier died on the shape
        }

        if (wasAlive && best.hp <= 0 && p) {
          if (kind === 'wildling') {
            p.pendingXP += WILDLING_XP_BOUNTY;
            state.wildlings.delete(best.id);
            state.event('explosion', { x: best.position.x, y: best.position.y, color: 0x8b5cf6 });
            state.notify(`🐗 Wildling slain! +${WILDLING_XP_BOUNTY} XP`, 'success', sol.ownerId);
          } else {
            p.pendingXP += best.xpValue;
            state.eatables.delete(best.id);
            state.event('explosion', { x: best.position.x, y: best.position.y, color: EATABLE_DEFS[best.type]?.color ?? 0xfcd34d });
          }
        }
      }
    }
  }

  _dealDamage(state, attacker, target, now, siege) {
    let dmg = attacker.damage;
    const player = state.players.get(attacker.ownerId);
    if (player?.base.specialization === 'warmonger') dmg *= 1.25;
    dmg *= 1 + (player?.buffs?.atk ?? 0) * 0.10;

    // DEFENDER'S ADVANTAGE (stance-based): a soldier in a DEFENDING squad hits
    // harder; a soldier being hit while in a DEFENDING squad takes less.
    const ag = state.groups.get(attacker.groupId);
    if (ag && ag.status === 'defending') dmg *= DEFENDER_ATK_MULT;

    const targetIsBase = state.bases.has(target.id);
    if (siege) dmg *= STRUCTURE_DMG_MULT;                          // siege bonus vs structures
    if (attacker.type === 'saboteur' && targetIsBase) dmg *= 2;    // saboteur specialty

    const targetIsSoldier = state.soldiers.has(target.id);
    if (targetIsSoldier) {
      const tp = state.players.get(target.ownerId);
      dmg /= 1 + (tp?.buffs?.def ?? 0) * 0.10;
      const tg = state.groups.get(target.groupId);
      if (tg && tg.status === 'defending') dmg *= DEFENDER_DMG_TAKEN;
    }

    const before = target.hp;
    target.hp = Math.max(0, before - dmg);
    if (targetIsBase) {
      target.lastAttackerId = attacker.ownerId; // kill credit
      target.lastAttackedAt = now;              // drives the "base under attack" blink
    }

    // Big XP for killing an enemy soldier (drives leveling → unlocks).
    if (targetIsSoldier && before > 0 && target.hp <= 0) {
      const ap = state.players.get(attacker.ownerId);
      if (ap) ap.pendingXP += KILL_XP;
    }

    if (state.boss && target.id === state.boss.id) {
      const prev = state.boss.contrib.get(attacker.ownerId) || 0;
      state.boss.contrib.set(attacker.ownerId, prev + dmg);
    }
  }

  // ── Turret fire ──────────────────────────────────────────────────────────────
  _turretFire(state, dtMs) {
    for (const [, t] of state.turrets) {
      if (t.cd > 0) t.cd -= dtMs;
      let best = null, bestD2 = t.range * t.range;
      for (const [, e] of state.soldiers) {
        if (e.ownerId === t.ownerId || e.hp <= 0) continue;
        const d2 = dist2(t.position, e.position);
        if (d2 < bestD2) { bestD2 = d2; best = e; }
      }
      if (!best) continue;
      t.aimFacing = Math.atan2(best.position.y - t.position.y, best.position.x - t.position.x);
      if (t.cd > 0) continue;

      const def = TURRET_DEFS[t.type];
      const vx = Math.cos(t.aimFacing) * def.projSpeed;
      const vy = Math.sin(t.aimFacing) * def.projSpeed;
      const p = new Projectile(t.ownerId, t.type, t.position.x, t.position.y, vx, vy, t.damage, t.splash, def.projColor);
      state.projectiles.set(p.id, p);
      t.cd = t.cooldMs;
    }
  }

  // ── Projectiles ────────────────────────────────────────────────────────────
  _moveProjectiles(state, dt, dtMs) {
    const HIT_R = 12;
    for (const [id, p] of state.projectiles) {
      p.position.x += p.vx * dt;
      p.position.y += p.vy * dt;
      p.life -= dtMs;

      let hit = null;
      for (const [, e] of state.soldiers) {
        if (e.ownerId === p.ownerId || e.hp <= 0) continue;
        if (dist2(p.position, e.position) < HIT_R * HIT_R) { hit = e; break; }
      }

      if (hit) {
        if (p.splash > 0) {
          for (const [, e] of state.soldiers) {
            if (e.ownerId === p.ownerId || e.hp <= 0) continue;
            if (dist2(p.position, e.position) < p.splash * p.splash) {
              e.hp = Math.max(0, e.hp - p.damage);
            }
          }
          state.event('explosion', { x: p.position.x, y: p.position.y, color: p.color });
        } else {
          hit.hp = Math.max(0, hit.hp - p.damage);
        }
        state.projectiles.delete(id);
        continue;
      }
      if (p.life <= 0) state.projectiles.delete(id);
    }
  }

  // ── Boss ─────────────────────────────────────────────────────────────────────
  _bossSwipe(state, dtMs) {
    if (!state.boss) return;
    if (state.boss.atkCd > 0) { state.boss.atkCd -= dtMs; return; }
    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0) continue;
      if (dist2(sol.position, state.boss.position) < 55 * 55) {
        sol.hp = Math.max(0, sol.hp - state.boss.damage);
        state.boss.atkCd = 800;
        break;
      }
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  _cleanup(state) {
    for (const [id, sol] of state.soldiers) {
      if (sol.hp <= 0) state.soldiers.delete(id);
    }

    if (state.boss && state.boss.hp <= 0) {
      const contributions = [...state.boss.contrib.entries()].sort((a, b) => b[1] - a[1]);
      contributions.forEach(([pid], rank) => {
        const p = state.players.get(pid);
        if (p) {
          const bonus = rank === 0 ? 500 : 200;
          p.pendingXP += bonus;
          p.base.gold += bonus;
          state.notify(`🏆 Boss slain! +${bonus} gold & XP!`, 'success', pid);
        }
      });
      state.boss = null;
      state.event('bossKilled', {});
    }
  }

  // ── Elimination + conquest reward ──────────────────────────────────────────────
  _checkElimination(state) {
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      if (player.base.hp > 0) continue;

      player.alive = false;

      // Credit the destroyer: claim the fallen base's mine (permanent income) + bounty.
      const killer = state.players.get(player.base.lastAttackerId);
      if (killer && killer.alive && killer.id !== player.id) {
        const factor = 1 + player.base.level * 0.1;
        const goldReward = Math.round(CONQUEST_GOLD_LUMP * factor);
        killer.base.gold += goldReward;
        killer.pendingXP += Math.round(CONQUEST_XP * factor);
        killer.base.conquestGoldBonus += CONQUEST_INCOME_BONUS;
        state.notify(`🏆 Rival base destroyed! Claimed their mine (+${CONQUEST_INCOME_BONUS}/s, +${goldReward} gold)`, 'success', killer.id);
      }

      for (const [sid, sol] of state.soldiers)
        if (sol.ownerId === player.id) state.soldiers.delete(sid);
      for (const [gid, g] of state.groups)
        if (g.ownerId === player.id) state.groups.delete(gid);
      for (const [tid, t] of state.turrets)
        if (t.ownerId === player.id) state.turrets.delete(tid);

      if (player.id === state.playerId)
        state.notify('💀 Your mother base was destroyed!', 'warning', 'player');
      else if (!killer || killer.id !== state.playerId)
        state.notify(`✅ ${player.id.replace('bot_', 'Bot ')} eliminated!`, 'success', 'player');
    }
  }
}
