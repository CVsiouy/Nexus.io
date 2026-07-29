import { dist, dist2 } from '../../utils/helpers.js';
import { Group } from '../entities.js';
import {
  FORMATION_SPACING, GROUP_MERGE_RANGE, GROUP_ARRIVE, GROUP_MAX_SIZE,
  BASE_RADIUS, BOSS_RADIUS, SOLDIER_RADIUS, WORLD_SIZE,
  ATTACK_RANGE, WALL_CELL_SIZE, BASE_DEFENSE_RADIUS,
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
    this._enforceWalls(state);
    this._cull(state);
  }

  _updateGroups(state, dt) {
    for (const [, g] of state.groups) {
      const members = this._members(state, g);
      if (members.length === 0) continue;
      if (members.length >= GROUP_MAX_SIZE) g.formed = true; // a real formation, forever after

      const player = state.players.get(g.ownerId);

      // ── Resolve the formation anchor by status ─────────────────────────
      // Every state holds the SAME triangular wedge — no orbiting, no surround
      // ring. Only the anchor point differs.
      if (g.status === 'attacking') {
        const target = state.resolve(g.targetId);
        if (!target || target.hp <= 0) {
          this._release(state, g, members);                                 // objective gone
        } else {
          // Assault priority for a base: outer WALL cell → its DEFENDERS → the base.
          let ax = target.position.x, ay = target.position.y;
          if (state.bases.has(target.id)) {
            const cen0 = this._centroid(members);
            const layer = outerBlockingLayer(target);
            if (layer) {
              const near = nearestCell(target, layer, cen0);            // breach the wall first
              if (near) { ax = near.pos.x; ay = near.pos.y; }
            } else {
              const def = this._nearestDefender(state, target, cen0);   // then hunt its defenders
              if (def) { ax = def.position.x; ay = def.position.y; }     // else the base itself
            }
          }
          g.anchor = { x: ax, y: ay };
        }
      } else if (g.status === 'defending') {
        // Hold formation at what we guard: a mining node, else the mother base.
        let cpos = player?.base?.position;
        if (g.defendNodeId) {
          const node = state.mineNodes.get(g.defendNodeId);
          if (node) cpos = node.position; else g.defendNodeId = null;
        }
        if (cpos) g.anchor = { x: cpos.x, y: cpos.y };
      }
      // 'moving' | 'idle' keep whatever anchor was assigned.

      // The wedge keeps a FIXED heading (apex up) — no rotation ever. We only
      // need the centroid→anchor distance to know when a 'moving' squad arrived.
      const cen = this._centroid(members);
      const ax = g.anchor.x - cen.x, ay = g.anchor.y - cen.y;
      if (g.status === 'moving' && ax * ax + ay * ay <= GROUP_ARRIVE * GROUP_ARRIVE) g.status = 'idle';

      // Defending squads INTERCEPT: if enemies have entered the guarded area,
      // each soldier peels off to its nearest intruder; otherwise it re-forms.
      // Every OTHER status (moving / attacking) holds the RIGID wedge — the
      // formation never breaks apart; combat (skirmish/assault) fires from the
      // in-range soldiers WITHOUT moving them, so the triangle stays clean.
      let threats = null;
      if (g.status === 'defending') {
        const r2 = BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS;
        threats = [];
        for (const [, e] of state.soldiers) {
          if (e.hp <= 0 || !state.areEnemies(g.ownerId, e.ownerId)) continue;
          if (dist2(e.position, g.anchor) < r2) threats.push(e);
        }
      }

      // ── Steer each member ───────────────────────────────────────────────
      for (let i = 0; i < members.length; i++) {
        const sol = members[i];
        sol.slot  = i;

        let tx, ty;
        if (threats && threats.length) {
          // intercept the nearest intruder (defending only)
          let best = null, bd = Infinity;
          for (const e of threats) { const d = dist2(sol.position, e.position); if (d < bd) { bd = d; best = e; } }
          tx = best.position.x; ty = best.position.y;
        } else {
          const slot = this._slotPos(g, i);   // rigid wedge slot
          tx = slot.x; ty = slot.y;
        }

        {
          const dx = tx - sol.position.x, dy = ty - sol.position.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 4) {
            const len  = Math.sqrt(d2);
            const step = Math.min(sol.speed * spdMult(player) * dt, len);
            sol.position.x += (dx / len) * step;
            sol.position.y += (dy / len) * step;
          }
        }
        sol.facing = g.facing; // fixed (apex up); soldiers never rotate on their axis
        sol.position.x = Math.max(0, Math.min(WORLD_SIZE, sol.position.x));
        sol.position.y = Math.max(0, Math.min(WORLD_SIZE, sol.position.y));
      }
    }
  }

  /** Nearest soldier defending `base` (within its ring), closest to `from`. */
  _nearestDefender(state, base, from) {
    const r2 = BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS;
    let best = null, bd = Infinity;
    for (const [, s] of state.soldiers) {
      if (s.hp <= 0 || s.ownerId !== base.ownerId) continue;
      if (dist2(s.position, base.position) > r2) continue;
      const d = dist2(s.position, from);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  /** Is there an enemy soldier within r² of this soldier? */
  _enemySoldierInRange(state, sol, r2) {
    for (const [, e] of state.soldiers) {
      if (e.hp <= 0 || !state.areEnemies(sol.ownerId, e.ownerId)) continue;
      if (dist2(sol.position, e.position) <= r2) return true;
    }
    return false;
  }

  /**
   * Wall collision: an enemy soldier cannot cross a base's outermost COMPLETE
   * wall ring — it's pushed back to just outside until that ring is breached.
   * (Own soldiers pass freely.)
   */
  _enforceWalls(state) {
    for (const [, b] of state.bases) {
      const layer = outerBlockingLayer(b);
      if (!layer) continue;
      const R = layer.radius + WALL_CELL_SIZE * 0.6;
      const R2 = R * R;
      for (const [, s] of state.soldiers) {
        if (s.hp <= 0 || !state.areEnemies(s.ownerId, b.ownerId)) continue;
        const dx = s.position.x - b.position.x, dy = s.position.y - b.position.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < R2 && d2 > 1) {
          const d = Math.sqrt(d2);
          s.position.x = b.position.x + (dx / d) * R;
          s.position.y = b.position.y + (dy / d) * R;
        }
      }
    }
  }

  /** Free an attacking group after its target dies: hold position (do NOT retreat). */
  _release(state, g, members) {
    g.locked   = false;
    g.targetId = null;
    g.status   = 'idle';
    g.anchor   = this._centroid(members); // stay where they are, ready for new orders
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
    if (g.memberIds.length >= GROUP_MAX_SIZE) continue; // squad is full
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

/**
 * A squad is deployable once it has FORMED a full 15. After that it stays
 * deployable even if casualties drop it below 15 (a veteran formation).
 */
export function canDeploy(g) { return !g.locked && (g.memberIds.length >= GROUP_MAX_SIZE || g.formed); }

/** Move a group to a position (only a full 15-squad; target clamped to the map). */
export function moveGroup(g, x, y) {
  if (!canDeploy(g)) return false;
  const M = 24;
  g.status   = 'moving';
  g.targetId = null;
  g.anchor   = { x: Math.max(M, Math.min(WORLD_SIZE - M, x)), y: Math.max(M, Math.min(WORLD_SIZE - M, y)) };
  return true;
}

/** Commit a full squad to attack a target. Locks it until the target dies / it wipes. */
export function attackWithGroup(g, targetId) {
  if (!canDeploy(g)) return false;
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
  g.status     = 'defending';
  g.targetId   = null;
  g.defendNodeId = null; // defend the mother base
  if (base) g.anchor = { x: base.position.x, y: base.position.y };
  return true;
}

/** Send a full squad to garrison a mining node (captures it by presence). */
export function setDefendNode(g, node) {
  if (!canDeploy(g)) return false; // needs a full 15 to deploy to a node
  g.status       = 'defending';
  g.targetId     = null;
  g.defendNodeId = node.id;
  g.anchor       = { x: node.position.x, y: node.position.y };
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
  ng.formed = g.formed; // split-off veterans stay deployable
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
    if (o.memberIds.length + g.memberIds.length > GROUP_MAX_SIZE) continue; // would exceed the 15 cap
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

/**
 * Evenly redistribute members across an owner's non-locked groups, never letting
 * a squad exceed the 15 cap (spawns extra squads if there are more than fit).
 */
export function balanceGroups(state, ownerId) {
  const groups = [];
  for (const [, g] of state.groups)
    if (g.ownerId === ownerId && !g.locked) groups.push(g);
  if (groups.length < 2) return false;

  const pool = [];
  for (const g of groups) { pool.push(...g.memberIds); g.memberIds = []; }
  if (pool.length === 0) return false;

  // Make sure there are enough squads so none has to exceed the cap.
  const needed = Math.max(groups.length, Math.ceil(pool.length / GROUP_MAX_SIZE));
  const base = state.players.get(ownerId)?.base;
  while (groups.length < needed) {
    const a = base ? base.position : (groups[0]?.anchor ?? { x: 0, y: 0 });
    const ng = new Group(ownerId, a.x, a.y);
    ng.status = 'defending';
    state.groups.set(ng.id, ng);
    groups.push(ng);
  }

  // Round-robin, skipping any squad that's already full.
  let gi = 0;
  for (const id of pool) {
    let tries = 0;
    while (groups[gi % groups.length].memberIds.length >= GROUP_MAX_SIZE && tries < groups.length) { gi++; tries++; }
    const g = groups[gi % groups.length];
    g.memberIds.push(id);
    const s = state.soldiers.get(id);
    if (s) s.groupId = g.id;
    gi++;
  }
  return true;
}
