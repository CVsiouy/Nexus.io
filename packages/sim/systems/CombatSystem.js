import { dist2 } from '../utils/helpers.js';
import { Projectile } from '../entities.js';
import {
  ATTACK_RANGE, TURRET_DEFS, STRUCTURE_DMG_MULT, WALL_DMG_MULT, SOLDIER_RADIUS, WALL_CELL_SIZE,
  CONQUEST_GOLD_LUMP, CONQUEST_XP, KILL_XP, BOSS_GOLD_REWARD, BOSS_XP_REWARD,
  EATABLE_DEFS, WILDLING_XP_BOUNTY, BASE_DEFENSE_RADIUS, DEFENDER_ATK_MULT, DEFENDER_DMG_TAKEN,
} from '../constants.js';
import { isStructureTarget, targetRadius } from './GroupSystem.js';
import { outerBlockingLayer, nearestCell, damageCell, repairWalls } from '../walls.js';

const STRIKE_CD = 500; // ms baseline between strikes (2/sec)

/** Attacking an enemy structure gives up your own spawn protection. */
function forfeitProtection(player) {
  if (!player?.base?.spawnProtected) return;
  player.base.spawnProtected = false;
  player.base.protectTimer = 0;
}

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
    // Walls are shielded too, or protection would just funnel attackers into
    // demolishing the defences while the base itself sat untouchable.
    if (state.players.get(base.ownerId)?.base.spawnProtected) return;

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

      forfeitProtection(state.players.get(s.ownerId));   // besieging walls is an attack too
      const destroyed = damageCell(base, layer, near.cell, this._siegeDamage(state, s), now);
      s.atkCd = STRIKE_CD;
      if (destroyed) break; // gap opened — retarget next tick
    }
  }

  /** True if the base still has living defenders inside its muster ring. */
  _baseShielded(state, base) {
    const r2 = BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS;
    const bx = base.position.x, by = base.position.y;
    return state.grid.any(bx, by, BASE_DEFENSE_RADIUS, (s) => {
      if (s.hp <= 0 || s.ownerId !== base.ownerId) return false;
      const dx = s.position.x - bx, dy = s.position.y - by;
      return dx * dx + dy * dy < r2;
    });
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
    const px = sol.position.x, py = sol.position.y;

    const found = state.grid.any(px, py, sol.autoR, (e) => {
      if (e === sol || e.hp <= 0 || !state.areEnemies(sol.ownerId, e.ownerId)) return false;
      const dx = e.position.x - px, dy = e.position.y - py;
      return dx * dx + dy * dy < r2;
    });
    if (found) return true;

    if (state.wildlings.size) {
      for (const [, w] of state.wildlings) {
        if (w.hp <= 0) continue;
        if (dist2(sol.position, w.position) < r2) return true;
      }
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
      //
      // This used to scan every soldier on the map for every soldier on the
      // map — 160,000 distance checks per tick at 400 soldiers. The grid cuts
      // the candidates to whatever shares a nearby map square, typically ~10.
      let best = null, bestD2 = Infinity, kind = null;
      const px = sol.position.x, py = sol.position.y;
      state.grid.forEachNear(px, py, ATTACK_RANGE + SOLDIER_RADIUS, (e) => {
        if (e === sol || e.hp <= 0) return;
        if (!state.areEnemies(sol.ownerId, e.ownerId)) return;
        const dx = e.position.x - px, dy = e.position.y - py;
        const d2 = dx * dx + dy * dy;
        if (d2 <= effS2 && d2 < bestD2) { bestD2 = d2; best = e; kind = 'soldier'; }
      });

      // Wildlings and eatables are disabled in every mode today (CenterSystem
      // returns immediately), so these maps are empty and the loops cost
      // nothing. Guarded by .size so they stay free rather than being removed —
      // the hunting-ground feature may come back.
      if (state.wildlings.size) {
        const effW2 = (ATTACK_RANGE + 20) ** 2;
        for (const [, w] of state.wildlings) {
          if (w.hp <= 0) continue;
          const d2 = dist2(sol.position, w.position);
          if (d2 <= effW2 && d2 < bestD2) { bestD2 = d2; best = w; kind = 'wildling'; }
        }
      }
      // 2. else nearest eatable within attack range (food)
      if (!best && state.eatables.size) {
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
            state.freeId(best.id);
            state.event('explosion', { x: best.position.x, y: best.position.y, color: 0x8b5cf6 });
            state.notify(`🐗 Wildling slain! +${WILDLING_XP_BOUNTY} XP`, 'success', sol.ownerId);
          } else {
            p.pendingXP += best.xpValue;
            state.eatables.delete(best.id);
            state.freeId(best.id);
            state.event('explosion', { x: best.position.x, y: best.position.y, color: EATABLE_DEFS[best.type]?.color ?? 0xfcd34d });
          }
        }
      }
    }
  }

  _dealDamage(state, attacker, target, now, siege) {
    const player = state.players.get(attacker.ownerId);

    // ── Spawn protection ────────────────────────────────────────────────────
    // This flag existed but was never checked — it only drew a pulsing ring.
    // Alone that hardly mattered (bots take ~90s to mount an attack). With
    // real players it is the whole basis of late-join fairness: someone
    // dropped into minute 12 beside a level-18 neighbour needs a moment before
    // they can be attacked at all.
    if (state.bases.has(target.id)) {
      const owner = state.players.get(target.ownerId);
      if (owner?.base.spawnProtected) return;

      // …but protection is a shield, not a licence: laying into somebody else's
      // base gives yours up.
      //
      // Note this only triggers on attacking a BASE, never on a skirmish. An
      // earlier version forfeited protection on any damage dealt, which meant
      // your own grunt defending your own base instantly stripped your
      // protection — so it protected nobody, ever.
      forfeitProtection(player);
    }

    let dmg = attacker.damage;
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

    const bossTarget = state.bosses.get(target.id);
    if (bossTarget) {
      bossTarget.contrib.set(attacker.ownerId, (bossTarget.contrib.get(attacker.ownerId) || 0) + dmg);
      bossTarget.lastAttackerId = attacker.ownerId;   // who gets the kill credit
      bossTarget.lastAttackedAt = now;
    }
  }

  // ── Turret fire ──────────────────────────────────────────────────────────────
  _turretFire(state, dtMs) {
    for (const [, t] of state.turrets) {
      if (t.cd > 0) t.cd -= dtMs;
      const best = state.grid.nearest(
        t.position.x, t.position.y, t.range,
        (e) => e.hp > 0 && e.ownerId !== t.ownerId,
      );
      if (!best) continue;
      t.aimFacing = Math.atan2(best.position.y - t.position.y, best.position.x - t.position.x);
      if (t.cd > 0) continue;

      const def = TURRET_DEFS[t.type];
      const vx = Math.cos(t.aimFacing) * def.projSpeed;
      const vy = Math.sin(t.aimFacing) * def.projSpeed;
      const p = new Projectile(state.newId(), t.ownerId, t.type, t.position.x, t.position.y, vx, vy, t.damage, t.splash, def.projColor);
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

      const hit = state.grid.nearest(
        p.position.x, p.position.y, HIT_R,
        (e) => e.hp > 0 && e.ownerId !== p.ownerId,
      );

      if (hit) {
        if (p.splash > 0) {
          const sp2 = p.splash * p.splash;
          state.grid.forEachNear(p.position.x, p.position.y, p.splash, (e) => {
            if (e.ownerId === p.ownerId || e.hp <= 0) return;
            if (dist2(p.position, e.position) < sp2) {
              e.hp = Math.max(0, e.hp - p.damage);
            }
          });
          state.event('explosion', { x: p.position.x, y: p.position.y, color: p.color });
        } else {
          hit.hp = Math.max(0, hit.hp - p.damage);
        }
        state.projectiles.delete(id);
        state.freeId(id);
        continue;
      }
      if (p.life <= 0) { state.projectiles.delete(id); state.freeId(id); }
    }
  }

  // ── Boss ─────────────────────────────────────────────────────────────────────
  _bossSwipe(state, dtMs) {
    // A boss lashes out at anything that gets right up against it. It never
    // chases — this only reaches attackers who have already committed to
    // standing on top of it.
    for (const [, boss] of state.bosses) {
      if (boss.atkCd > 0) continue;
      const hit = state.grid.nearest(
        boss.position.x, boss.position.y, 55,
        (s) => s.hp > 0 && s.ownerId !== 'boss',
      );
      if (!hit) continue;
      hit.hp = Math.max(0, hit.hp - boss.damage);
      boss.atkCd = 800;
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  _cleanup(state) {
    for (const [id, sol] of state.soldiers) {
      if (sol.hp <= 0) {
        // Drop the soldier from its squad in the SAME step it is deleted.
        //
        // GroupSystem._cull also prunes dead members, but it runs earlier in the
        // tick order (group → combat), so a squad would spend one whole tick
        // listing a soldier that no longer exists. That was invisible while the
        // renderer read live memory, but this state is now snapshotted and sent
        // to every player, and a dangling id is exactly the kind of thing that
        // goes badly wrong once ids get recycled.
        const g = state.groups.get(sol.groupId);
        if (g) {
          const i = g.memberIds.indexOf(id);
          if (i >= 0) g.memberIds.splice(i, 1);

          // If that was the last member, retire the squad here and now.
          //
          // GroupSystem._cull also removes empty squads, but it runs EARLIER in
          // the tick order (group → combat), so a squad wiped out during combat
          // would survive as an empty shell until the next tick — long enough
          // to be snapshotted and sent to every client, which showed up as a
          // phantom "0/15" entry flickering in the squad panel.
          if (g.memberIds.length === 0) {
            state.event('groupWiped', { id: g.id, ownerId: g.ownerId });
            state.groups.delete(g.id);
            state.freeId(g.id);
          }
        }

        state.event('soldierDied', { id, ownerId: sol.ownerId, x: sol.position.x, y: sol.position.y });
        state.soldiers.delete(id);
        state.freeId(id);
      }
    }

    for (const [bid, boss] of state.bosses) {
      if (boss.hp > 0) continue;

      // Permanent income to whoever landed the killing blow.
      //
      // This is the one place ongoing income is still granted, and unlike the
      // old per-kill conquest bonus it CANNOT run away: there are only ever
      // BOSS_COUNT bosses, so the most anyone can hold is a fixed, known
      // amount. That bound is what makes it safe.
      const killer = state.players.get(boss.lastAttackerId);
      if (killer?.alive) {
        killer.base.bossBonus = (killer.base.bossBonus ?? 0) + BOSS_GOLD_REWARD;
        killer.pendingXP += BOSS_XP_REWARD;
        state.notify(`🏆 Boss slain! +${BOSS_GOLD_REWARD} gold/sec for the rest of the match`, 'success', killer.id);
      }

      // Everyone who helped gets XP — bosses are meant to draw a crowd.
      for (const [pid, dealt] of boss.contrib) {
        const p = state.players.get(pid);
        if (p?.alive && pid !== boss.lastAttackerId) {
          p.pendingXP += Math.round(BOSS_XP_REWARD * 0.35);
        }
      }

      // Its garrison dies with it. Nothing inherits a leaderless boss squad.
      for (const [sid, sol] of state.soldiers) {
        if (sol.ownerId !== 'boss') continue;
        const g = state.groups.get(sol.groupId);
        if (g && g.guardPos &&
            Math.hypot(g.guardPos.x - boss.position.x, g.guardPos.y - boss.position.y) < 5) {
          state.soldiers.delete(sid);
          state.freeId(sid);
        }
      }
      for (const [gid, g] of state.groups) {
        if (g.ownerId === 'boss' && g.memberIds.every(id => !state.soldiers.has(id))) {
          state.groups.delete(gid);
          state.freeId(gid);
        }
      }

      state.bosses.delete(bid);
      state.freeId(bid);
      state.event('bossKilled', { id: bid, killerId: killer?.id ?? null, x: boss.position.x, y: boss.position.y });
    }
  }

  // ── Elimination + conquest reward ──────────────────────────────────────────────
  _checkElimination(state) {
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      if (player.base.hp > 0) continue;

      player.alive = false;

      // Credit the destroyer with a ONE-TIME bounty.
      //
      // This used to also grant permanent, stacking income (+2 gold/sec per
      // kill). That compounded: each kill made the next one easier, so a single
      // early kill could decide a 20-minute match. A flat lump sum still
      // rewards aggression — 300 gold buys a serious army right now — without
      // making the winner permanently richer than everyone else.
      //
      // The gold is deliberately NOT scaled by the victim's level: killing the
      // leader paying double is itself a snowball vector. XP keeps its scaling
      // because levels are capped and self-limiting.
      const killer = state.players.get(player.base.lastAttackerId);
      if (killer && killer.alive && killer.id !== player.id) {
        killer.base.gold += CONQUEST_GOLD_LUMP;
        killer.pendingXP += Math.round(CONQUEST_XP * (1 + player.base.level * 0.1));
        killer.base.conquests += 1;
        state.notify(`🏆 Rival base destroyed! +${CONQUEST_GOLD_LUMP} gold`, 'success', killer.id);
      }

      for (const [sid, sol] of state.soldiers)
        if (sol.ownerId === player.id) { state.soldiers.delete(sid); state.freeId(sid); }
      for (const [gid, g] of state.groups)
        if (g.ownerId === player.id) { state.groups.delete(gid); state.freeId(gid); }
      for (const [tid, t] of state.turrets)
        if (t.ownerId === player.id) { state.turrets.delete(tid); state.freeId(tid); }

      state.event('playerEliminated', { ownerId: player.id, killerId: killer?.id ?? null });

      if (player.id === state.playerId)
        state.notify('💀 Your mother base was destroyed!', 'warning', 'player');
      else if (!killer || killer.id !== state.playerId)
        state.notify(`✅ ${player.id.replace('bot_', 'Bot ')} eliminated!`, 'success', 'player');
    }
  }
}
