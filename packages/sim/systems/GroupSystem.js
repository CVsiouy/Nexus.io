import { dist, dist2 } from '../utils/helpers.js';
import { Group, Soldier } from '../entities.js';
import {
  FORMATION_SPACING, GROUP_MERGE_RANGE, GROUP_ARRIVE, GROUP_MAX_SIZE,
  BASE_RADIUS, BOSS_RADIUS, SOLDIER_RADIUS, WORLD_SIZE,
  ATTACK_RANGE, WALL_CELL_SIZE, BASE_DEFENSE_RADIUS,
} from '../constants.js';
import { outerBlockingLayer, outermostLayer, nearestCell, crossesWall, pushOutside } from '../walls.js';

/** True if the target is a "structure" (a base or the boss) that gets surrounded. */
export function isStructureTarget(state, target) {
  if (!target) return false;
  return state.bases.has(target.id) || state.bosses.has(target.id);
}

/** Physical radius of a target, for range checks & the surround ring. */
export function targetRadius(state, target) {
  if (!target) return SOLDIER_RADIUS;
  if (state.bases.has(target.id)) return BASE_RADIUS;
  if (state.bosses.has(target.id)) return BOSS_RADIUS;
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
    // Remember where everyone started this tick. Wall collision needs the
    // before-and-after pair to tell "walked through a standing wall" apart from
    // "already inside, having come in through a breach".
    for (const [, s] of state.soldiers) {
      s.prevX = s.position.x;
      s.prevY = s.position.y;
    }

    this._updateGroups(state, dt);
    this._updateDonations(state, dt);
    this._enforceWalls(state);
    this._cull(state);
  }

  /**
   * Team-mode donations: a soldier with `donateTo` set has left its squad and
   * WALKS to that teammate's base; on arrival it changes hands and joins the
   * teammate's home squad. (Cancels back to its owner if the teammate dies.)
   */
  _updateDonations(state, dt) {
    for (const [, s] of state.soldiers) {
      if (s.hp <= 0 || !s.donateTo) continue;
      const mate = state.players.get(s.donateTo);
      if (!mate?.alive) {                        // teammate gone → keep the soldier
        s.donateTo = null;
        if (!state.groups.get(s.groupId)) addSoldierToNearestGroup(state, s);
        continue;
      }
      const bp = mate.base.position;
      const dx = bp.x - s.position.x, dy = bp.y - s.position.y;
      const d = Math.hypot(dx, dy);
      if (d < 60) {                              // arrived → transfer to the teammate
        s.ownerId  = s.donateTo;
        s.donateTo = null;
        s.groupId  = null;
        addSoldierToNearestGroup(state, s);
      } else {
        const step = Math.min(s.speed * dt, d);
        s.position.x += (dx / d) * step;
        s.position.y += (dy / d) * step;
        s.facing = -Math.PI / 2;
      }
    }
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
          // Press the base — or, if it's still walled, the nearest outer wall cell
          // to breach. We do NOT converge on individual defenders (that let the
          // whole wedge focus-fire one defender and made attackers unbeatable);
          // the defending formation comes out to meet us and both fight fair.
          let ax = target.position.x, ay = target.position.y;
          if (state.bases.has(target.id)) {
            const layer = outerBlockingLayer(target);
            if (layer) {
              const near = nearestCell(target, layer, this._centroid(members)); // breach wall first
              if (near) { ax = near.pos.x; ay = near.pos.y; }
            }
          }
          g.anchor = { x: ax, y: ay };
        }
      } else if (g.status === 'defending') {
        // Guard point: an explicit one (boss squads), a mining node, else the
        // mother base.
        let cpos = g.guardPos ?? player?.base?.position;
        let guarded = g.guardPos ? null : player?.base;
        if (g.defendNodeId) {
          const node = state.mineNodes.get(g.defendNodeId);
          if (node) { cpos = node.position; guarded = null; } else g.defendNodeId = null;
        }
        // If an enemy has entered the guarded ring, the WHOLE FORMATION shifts
        // toward the nearest one (staying concentrated — no scattering), but is
        // clamped near home so defenders keep their home-ground advantage.
        if (cpos) {
          let anchor = { x: cpos.x, y: cpos.y };
          let bd = Infinity;
          const best = state.grid.nearest(
            cpos.x, cpos.y, BASE_DEFENSE_RADIUS,
            (e) => e.hp > 0 && state.areEnemies(g.ownerId, e.ownerId),
          );
          if (best) bd = dist2(best.position, cpos);
          if (best) {
            const dx = best.position.x - cpos.x, dy = best.position.y - cpos.y;
            const d = Math.sqrt(bd) || 1;
            let reach = Math.min(d, 0.55 * BASE_DEFENSE_RADIUS);

            // ── Hold the line behind your own wall ──────────────────────────
            //
            // If this base has a wall standing, the squad stops INSIDE it
            // instead of marching out to meet the attackers. Everything then
            // falls out of the existing combat rules: the soldiers whose range
            // reaches past the wall shoot, the rest simply hold, and the wall —
            // not the defenders — soaks the incoming damage.
            //
            // That is the trade a wall is supposed to buy. Walking out in front
            // of it threw that away, which is why a big defending squad used to
            // fare WORSE than two or three soldiers who happened to stay put.
            const wall = guarded ? outermostLayer(guarded) : null;
            if (wall) {
              const inside = Math.max(0, wall.radius - WALL_CELL_SIZE - FORMATION_SPACING);
              reach = Math.min(reach, inside);
            }

            anchor = { x: cpos.x + (dx / d) * reach, y: cpos.y + (dy / d) * reach };
          }
          g.anchor = anchor;
        }
      }
      // 'moving' | 'idle' keep whatever anchor was assigned.

      // The wedge keeps a FIXED heading (apex up) — no rotation ever. We only
      // need the centroid→anchor distance to know when a 'moving' squad arrived.
      const cen = this._centroid(members);
      const ax = g.anchor.x - cen.x, ay = g.anchor.y - cen.y;
      if (g.status === 'moving' && ax * ax + ay * ay <= GROUP_ARRIVE * GROUP_ARRIVE) g.status = 'idle';

      // ── Steer each member to its RIGID wedge slot ───────────────────────
      // The formation never breaks apart (no scattering); combat fires from the
      // in-range soldiers WITHOUT moving them, so the triangle stays clean and
      // concentrated — attackers and defenders now focus-fire equally.
      for (let i = 0; i < members.length; i++) {
        const sol = members[i];
        sol.slot  = i;
        const slot = this._slotPos(g, i);
        const dx = slot.x - sol.position.x, dy = slot.y - sol.position.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 4) {
          const len  = Math.sqrt(d2);
          const step = Math.min(sol.speed * spdMult(player) * dt, len);
          sol.position.x += (dx / len) * step;
          sol.position.y += (dy / len) * step;
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
  /**
   * Stop enemies walking through standing wall.
   *
   * The rule is about CROSSING, not about being inside. A ring is solid at the
   * bearings where its cells still stand and open where one has been destroyed,
   * so knocking out a single cell opens a doorway that attackers must funnel
   * through — and anyone who came in that way is then free to move about
   * inside rather than being shoved back out.
   *
   * Previously an incomplete ring stopped blocking entirely, so one broken cell
   * made the whole wall irrelevant and soldiers crossed it anywhere.
   */
  _enforceWalls(state) {
    const structures = [];
    for (const [, b] of state.bases) structures.push(b);
    for (const [, boss] of state.bosses) structures.push(boss);

    for (const b of structures) {
      if (!b.walls?.length) continue;

      for (const layer of b.walls) {
        if (!layer.cells.length) continue;
        const R = layer.radius + WALL_CELL_SIZE * 0.6;

        state.grid.forEachNear(b.position.x, b.position.y, R + 40, (s) => {
          if (s.hp <= 0 || !state.areEnemies(s.ownerId, b.ownerId)) return;
          const from = { x: s.prevX ?? s.position.x, y: s.prevY ?? s.position.y };
          if (!crossesWall(b, layer, from, s.position)) return;
          const p = pushOutside(b, layer, s.position);
          s.position.x = p.x;
          s.position.y = p.y;
        });
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
        state.event('groupWiped', { id, ownerId: g.ownerId });
        state.groups.delete(id);
        state.freeId(id);
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

/**
 * Release a base's garrison: spawn all held soldiers AT ONCE as one fresh
 * DEFENDING formation at the base. Returns the new group (or null if empty).
 */
export function releaseGarrison(state, base) {
  const n = base.garrison;
  if (n <= 0) return null;
  base.garrison = 0;
  const g = new Group(state.newId(), base.ownerId, base.position.x, base.position.y);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 25;
    const s = new Soldier(state.newId(), base.ownerId, 'grunt', base.position.x + Math.cos(a) * r, base.position.y + Math.sin(a) * r);
    state.soldiers.set(s.id, s);
    s.groupId = g.id;
    g.memberIds.push(s.id);
  }
  g.formed = n >= GROUP_MAX_SIZE; // a full release is immediately deployable
  state.groups.set(g.id, g);
  setDefending(g, base);
  return g;
}

/** Create a fresh group for one soldier at its position. */
export function createGroup(state, sol) {
  const g = new Group(state.newId(), sol.ownerId, sol.position.x, sol.position.y);
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

  const ng = new Group(state.newId(), g.ownerId, g.anchor.x + 30, g.anchor.y + 30);
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
  state.freeId(g.id);
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
    const ng = new Group(state.newId(), ownerId, a.x, a.y);
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
