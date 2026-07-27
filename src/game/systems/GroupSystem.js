import { dist, dist2 } from '../../utils/helpers.js';
import { Group } from '../entities.js';
import {
  FORMATION_SPACING, GROUP_MERGE_RANGE, GROUP_ARRIVE,
  BASE_RADIUS, BOSS_RADIUS, SOLDIER_RADIUS, SURROUND_GAP,
  DEFENSE_RADIUS, ORBIT_RADIUS, ORBIT_SPEED,
} from '../constants.js';
import { outerBlockingLayer, nearestCell } from '../walls.js';

/** True if the target is a "structure" (a base or the boss) that gets surrounded. */
export function isStructureTarget(state, target) {
  if (!target) return false;
  return state.bases.has(target.id) || (state.boss && state.boss.id === target.id);
}

/** Physical radius of a target, for range checks & the surround ring. */
export function targetRadius(state, target) {
  if (!target) return SOLDIER_RADIUS;
  if (state.bases.has(target.id)) return BASE_RADIUS;
  if (state.boss && state.boss.id === target.id) return BOSS_RADIUS;
  return SOLDIER_RADIUS;
}

/** Speed multiplier from the owner's Speed buff. */
function spdMult(player) { return 1 + (player?.buffs?.spd ?? 0) * 0.10; }

/**
 * GroupSystem
 * ───────────
 * Soldiers are never commanded individually — they belong to a Group and hold a
 * wedge/triangle formation around the group's anchor. This system:
 *   • steers each soldier toward its formation slot
 *   • advances a group's anchor toward its move target / attack target
 *   • unlocks an attacking group once its target is gone (attack = commitment)
 *   • removes empty groups
 *
 * Split / merge / balance operations live here too (called from Input & AI).
 */
export class GroupSystem {
  update(state, dt, dtMs) {
    this._updateGroups(state, dt);
    this._cull(state);
  }

  _updateGroups(state, dt) {
    for (const [, g] of state.groups) {
      const members = this._members(state, g);
      if (members.length === 0) continue;

      const player = state.players.get(g.ownerId);

      // Defending squads don't hold formation — they orbit the base and each
      // soldier peels off to hit its own nearest threat independently.
      if (g.status === 'defending') { this._updateDefending(state, g, members, dt, player); continue; }

      // Farming squads spread out over the centre, each hunting its nearest eatable.
      if (g.status === 'farming') { this._updateFarming(state, g, members, dt, player); continue; }

      // ── Resolve anchor goal by status ──────────────────────────────────
      // For a structure assault we compute a "surround centre" + radius: the base
      // itself (wide ring), or — if it still has walls — the nearest cell of the
      // OUTERMOST intact wall layer, which the squad clusters on to breach it.
      let surroundCenter = null, surroundR = 0;
      if (g.status === 'attacking') {
        const target = state.resolve(g.targetId);
        if (!target || target.hp <= 0) {
          this._release(state, g, members);
        } else {
          g.anchor = { x: target.position.x, y: target.position.y };
          if (isStructureTarget(state, target)) {
            const cen0 = this._centroid(members);
            const layer = state.bases.has(target.id) ? outerBlockingLayer(target) : null;
            const near  = layer ? nearestCell(target, layer, cen0) : null;
            if (near) {
              surroundCenter = { x: near.pos.x, y: near.pos.y };
              surroundR = 18; // cluster tight on the focused wall cell
            } else {
              surroundCenter = { x: target.position.x, y: target.position.y };
              surroundR = targetRadius(state, target) + SURROUND_GAP;
            }
            g.anchor = { x: surroundCenter.x, y: surroundCenter.y };
          }
        }
      }
      // 'moving' | 'idle' keep whatever anchor was assigned.

      // ── Facing: point the wedge from the group centroid toward the anchor ──
      const cen = this._centroid(members);
      const ax = g.anchor.x - cen.x, ay = g.anchor.y - cen.y;
      if (ax * ax + ay * ay > GROUP_ARRIVE * GROUP_ARRIVE) {
        g.facing = Math.atan2(ay, ax);
      }

      // A 'moving' group that has arrived settles to idle.
      if (g.status === 'moving' && ax * ax + ay * ay <= GROUP_ARRIVE * GROUP_ARRIVE) {
        g.status = 'idle';
      }

      // ── Steer each member toward its formation slot ─────────────────────
      for (let i = 0; i < members.length; i++) {
        const sol = members[i];
        sol.slot  = i;
        const slotPos = surroundCenter
          ? this._ringPos(surroundCenter, i, members.length, surroundR)
          : this._slotPos(g, i);
        const dx = slotPos.x - sol.position.x;
        const dy = slotPos.y - sol.position.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 4) {
          const len   = Math.sqrt(d2);
          const speed = sol.speed * spdMult(player) * dt;
          const step  = Math.min(speed, len);
          sol.position.x += (dx / len) * step;
          sol.position.y += (dy / len) * step;
        }
        if (surroundCenter) {
          sol.facing = Math.atan2(surroundCenter.y - sol.position.y, surroundCenter.x - sol.position.x);
        } else {
          sol.facing = g.facing;
        }
      }
    }
  }

  /** Evenly spaced point on a ring around a centre (for surrounding a target). */
  _ringPos(center, i, n, r) {
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    return { x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r };
  }

  /**
   * Defending: each soldier independently charges the nearest enemy that has
   * come within DEFENSE_RADIUS of the base; with no threats, the squad slowly
   * orbits the base in a rotating ring. (Combat damage is handled by the skirmish
   * pass — this just steers them.)
   */
  _updateDefending(state, g, members, dt, player) {
    // Always circle the base's ACTUAL position (not a stale cached anchor).
    const bpos = player?.base?.position ?? g.anchor;
    g.anchor = { x: bpos.x, y: bpos.y }; // keep ring/camera centred on the real base
    const base = g.anchor;
    const threatR2 = DEFENSE_RADIUS * DEFENSE_RADIUS;
    const spd = spdMult(player);
    const n = Math.max(1, members.length);

    for (let i = 0; i < members.length; i++) {
      const sol = members[i];
      sol.slot = i;

      // Nearest enemy (to THIS soldier) that is threatening the base.
      let best = null, bestD2 = Infinity;
      for (const [, e] of state.soldiers) {
        if (e.ownerId === sol.ownerId || e.hp <= 0) continue;
        if (dist2(e.position, base) > threatR2) continue;      // must be near the base
        const d2 = dist2(sol.position, e.position);
        if (d2 < bestD2) { bestD2 = d2; best = e; }
      }

      let tx, ty;
      if (best) {
        tx = best.position.x; ty = best.position.y;            // charge it independently
      } else {
        const ang = (i / n) * Math.PI * 2 + state.time * ORBIT_SPEED;
        tx = base.x + Math.cos(ang) * ORBIT_RADIUS;
        ty = base.y + Math.sin(ang) * ORBIT_RADIUS;            // orbit when calm
      }

      const dx = tx - sol.position.x, dy = ty - sol.position.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 4) {
        const len  = Math.sqrt(d2);
        const step = Math.min(sol.speed * spd * dt, len);
        sol.position.x += (dx / len) * step;
        sol.position.y += (dy / len) * step;
        sol.facing = Math.atan2(dy, dx);
      }
    }
  }

  /**
   * Farming: each soldier moves to its OWN nearest eatable (naturally spreading
   * the squad over the centre). With no eatables left it gathers at the anchor.
   * Combat (skirmish) does the actual damage/XP.
   */
  _updateFarming(state, g, members, dt, player) {
    const spd = spdMult(player);
    for (let i = 0; i < members.length; i++) {
      const sol = members[i];
      sol.slot = i;

      let best = null, bestD2 = Infinity;
      for (const [, ea] of state.eatables) {
        const d2 = dist2(sol.position, ea.position);
        if (d2 < bestD2) { bestD2 = d2; best = ea; }
      }

      const tx = best ? best.position.x : g.anchor.x;
      const ty = best ? best.position.y : g.anchor.y;
      const dx = tx - sol.position.x, dy = ty - sol.position.y;
      const d2 = dx * dx + dy * dy;
      // Stop just short so the soldier sits in attack range of the eatable.
      if (d2 > 26 * 26) {
        const len  = Math.sqrt(d2);
        const step = Math.min(sol.speed * spd * dt, len);
        sol.position.x += (dx / len) * step;
        sol.position.y += (dy / len) * step;
        sol.facing = Math.atan2(dy, dx);
      }
    }
  }

  /** Free an attacking group after its target dies: send it home to defend the base. */
  _release(state, g, members) {
    g.locked   = false;
    g.targetId = null;
    const player = state.players.get(g.ownerId);
    setDefending(g, player?.base); // return home and circle the mother base
    if (g.ownerId === state.playerId)
      state.notify('✅ Objective destroyed — squad returning to defend base', 'success', g.ownerId);
  }

  _cull(state) {
    for (const [id, g] of state.groups) {
      const alive = g.memberIds.filter(mid => {
        const s = state.soldiers.get(mid);
        return s && s.hp > 0;
      });
      g.memberIds = alive;
      if (alive.length === 0) {
        if (g.selected && g.ownerId === state.playerId)
          state.notify('💀 A squad was wiped out', 'warning', g.ownerId);
        state.groups.delete(id);
      }
    }
  }

  // ── Formation math ─────────────────────────────────────────────────────────
  // Triangle wedge: apex at the anchor pointing along facing, rows trailing back.
  // Row r holds r+1 slots; slot i sits at row r, column c.
  _slotPos(g, i) {
    const { row, col } = _rowCol(i);
    const back    = -row * FORMATION_SPACING;             // trail behind the apex
    const lateral = (col - row / 2) * FORMATION_SPACING;  // spread across the row
    const f = g.facing;
    const fx = Math.cos(f), fy = Math.sin(f);   // forward
    const rx = -Math.sin(f), ry = Math.cos(f);  // right
    return {
      x: g.anchor.x + fx * back + rx * lateral,
      y: g.anchor.y + fy * back + ry * lateral,
    };
  }

  _members(state, g) {
    const out = [];
    for (const id of g.memberIds) {
      const s = state.soldiers.get(id);
      if (s && s.hp > 0) out.push(s);
    }
    return out;
  }

  _centroid(members) {
    let x = 0, y = 0;
    for (const s of members) { x += s.position.x; y += s.position.y; }
    return { x: x / members.length, y: y / members.length };
  }
}

// ─── Group operations (shared by Input + AI) ───────────────────────────────────

/** Row/column of a triangular-wedge slot index. */
function _rowCol(i) {
  const row = Math.floor((-1 + Math.sqrt(1 + 8 * i)) / 2);
  const col = i - (row * (row + 1)) / 2;
  return { row, col };
}

/** Create a fresh group for one soldier at its position. */
export function createGroup(state, sol) {
  const g = new Group(sol.ownerId, sol.position.x, sol.position.y);
  g.memberIds.push(sol.id);
  sol.groupId = g.id;
  state.groups.set(g.id, g);
  return g;
}

/**
 * A newly spawned soldier auto-defends: it joins the owner's nearest home
 * (defending/idle, non-locked) group and ensures that group is circling the
 * base. If there's no such group it forms a new defending one. Groups that are
 * moving or committed to an attack don't absorb reinforcements.
 */
export function addSoldierToNearestGroup(state, sol) {
  const player = state.players.get(sol.ownerId);
  const base   = player?.base;

  let home = null, bestD2 = Infinity;
  for (const [, g] of state.groups) {
    if (g.ownerId !== sol.ownerId || g.locked) continue;
    if (g.status !== 'defending' && g.status !== 'idle') continue;
    const d2 = dist2(g.anchor, sol.position);
    if (d2 < bestD2) { bestD2 = d2; home = g; }
  }

  if (home) {
    home.memberIds.push(sol.id);
    sol.groupId = home.id;
    setDefending(home, base);   // keep the home squad circling the base
    return home;
  }

  const g = createGroup(state, sol);
  setDefending(g, base);        // brand-new squads defend by default
  return g;
}

/** Move a group to a position (ignored if the group is locked in an attack). */
export function moveGroup(g, x, y) {
  if (g.locked) return false;
  g.status   = 'moving';
  g.targetId = null;
  g.anchor   = { x, y };
  return true;
}

/** Commit a group to attack a target. Locks it until the target dies / it wipes. */
export function attackWithGroup(g, targetId) {
  if (g.locked) return false;
  g.status   = 'attacking';
  g.locked   = true;
  g.targetId = targetId;
  return true;
}

/**
 * Set a group to defend the mother base: it returns to the base and holds a
 * guarding stance there, auto-engaging any enemy that comes near.
 */
export function setDefending(g, base) {
  if (g.locked) return false;
  g.status   = 'defending';
  g.targetId = null;
  if (base) g.anchor = { x: base.position.x, y: base.position.y };
  return true;
}

/** Send a group to farm eatables in the centre (spreads out, not locked). */
export function setFarming(g, center) {
  if (g.locked) return false;
  g.status   = 'farming';
  g.targetId = null;
  if (center) g.anchor = { x: center.x, y: center.y };
  return true;
}

/** Split a group into two halves. Returns the new group (or null if not allowed). */
export function splitGroup(state, g) {
  if (g.locked || g.memberIds.length < 2) return null;
  const half = Math.floor(g.memberIds.length / 2);
  const moved = g.memberIds.splice(half); // second half → new group

  const first = state.soldiers.get(moved[0]);
  const ng = new Group(g.ownerId, g.anchor.x + 30, g.anchor.y + 30);
  ng.facing = g.facing;
  ng.status = g.status === 'attacking' ? 'idle' : g.status; // never inherit a lock
  for (const id of moved) {
    ng.memberIds.push(id);
    const s = state.soldiers.get(id);
    if (s) s.groupId = ng.id;
  }
  state.groups.set(ng.id, ng);
  return ng;
}

/**
 * Merge a group into a nearby friendly (non-locked) group within range.
 * Returns the surviving group, or null if there was nothing close to merge with.
 */
export function mergeGroup(state, g) {
  if (g.locked) return null;
  let best = null, bestD2 = GROUP_MERGE_RANGE * GROUP_MERGE_RANGE;
  for (const [, o] of state.groups) {
    if (o === g || o.ownerId !== g.ownerId || o.locked) continue;
    const d2 = dist2(g.anchor, o.anchor);
    if (d2 < bestD2) { bestD2 = d2; best = o; }
  }
  if (!best) return null;
  for (const id of g.memberIds) {
    best.memberIds.push(id);
    const s = state.soldiers.get(id);
    if (s) s.groupId = best.id;
  }
  g.memberIds = [];
  state.groups.delete(g.id);
  return best;
}

/** Evenly redistribute members across all of an owner's non-locked groups. */
export function balanceGroups(state, ownerId) {
  const groups = [];
  for (const [, g] of state.groups)
    if (g.ownerId === ownerId && !g.locked) groups.push(g);
  if (groups.length < 2) return false;

  const pool = [];
  for (const g of groups) { pool.push(...g.memberIds); g.memberIds = []; }
  let gi = 0;
  for (const id of pool) {
    const g = groups[gi % groups.length];
    g.memberIds.push(id);
    const s = state.soldiers.get(id);
    if (s) s.groupId = g.id;
    gi++;
  }
  return true;
}
