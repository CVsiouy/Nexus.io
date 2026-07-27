import { dist2, weightedRandom } from '../../utils/helpers.js';
import { Eatable, Wildling } from '../entities.js';
import {
  WORLD_SIZE, CENTER_RADIUS,
  EATABLE_TARGET, EATABLE_SPAWN_MS,
  WILDLING_TARGET, WILDLING_SPAWN_MS, WILDLING_DETECT,
} from '../constants.js';

const CX = WORLD_SIZE / 2;
const CY = WORLD_SIZE / 2;

/** A random point uniformly-ish within the centre disc (with a margin). */
function centrePoint(margin = 40) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * (CENTER_RADIUS - margin);
  return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r };
}

/** Spawn one XP eatable in the centre (exported for world seeding). */
export function spawnEatable(state) {
  const p = centrePoint();
  const type = parseInt(weightedRandom({ 1: 60, 2: 30, 3: 10 }), 10);
  const e = new Eatable(type, p.x, p.y);
  state.eatables.set(e.id, e);
}

/**
 * CenterSystem
 * ────────────
 * Maintains the neutral hunting ground in the middle of the map:
 *  • keeps the centre stocked with XP eatables
 *  • spawns roaming "wildlings" sparingly
 *  • drives wildling movement + attacks (they chase/attack nearby soldiers)
 * (Soldiers damaging eatables/wildlings — and the XP for killing them — live in
 *  CombatSystem, alongside the rest of soldier combat.)
 */
export class CenterSystem {
  update(state, dt, dtMs) {
    if (state.mode === 'mining') return; // mining mode uses capturable nodes, not the centre
    this._respawnEatables(state, dtMs);
    this._spawnWildlings(state, dtMs);
    this._updateWildlings(state, dt, dtMs);
  }

  _respawnEatables(state, dtMs) {
    if (state.eatables.size >= EATABLE_TARGET) return;
    state.eatTimer += dtMs;
    if (state.eatTimer >= EATABLE_SPAWN_MS) {
      state.eatTimer = 0;
      const n = Math.min(4, EATABLE_TARGET - state.eatables.size);
      for (let i = 0; i < n; i++) spawnEatable(state);
    }
  }

  _spawnWildlings(state, dtMs) {
    if (state.wildlings.size >= WILDLING_TARGET) return;
    state.wildTimer += dtMs;
    if (state.wildTimer >= WILDLING_SPAWN_MS) {
      state.wildTimer = 0;
      const p = centrePoint(60);
      const w = new Wildling(p.x, p.y);
      state.wildlings.set(w.id, w);
    }
  }

  _updateWildlings(state, dt, dtMs) {
    const det2 = WILDLING_DETECT * WILDLING_DETECT;
    for (const [, w] of state.wildlings) {
      w.rot += 1.2 * dt;
      if (w.atkCd > 0) w.atkCd -= dtMs;

      // Chase the nearest soldier in detection range; otherwise wander the centre.
      let best = null, bestD2 = det2;
      for (const [, s] of state.soldiers) {
        if (s.hp <= 0) continue;
        const d2 = dist2(w.position, s.position);
        if (d2 < bestD2) { bestD2 = d2; best = s; }
      }

      let tx, ty;
      if (best) {
        tx = best.position.x; ty = best.position.y;
        if (bestD2 < 34 * 34 && w.atkCd <= 0) {
          best.hp = Math.max(0, best.hp - w.damage); // wildlings hit soldiers
          w.atkCd = 900;
        }
      } else {
        if (dist2(w.position, w.wander) < 30 * 30) w.wander = centrePoint(60);
        tx = w.wander.x; ty = w.wander.y;
      }

      const dx = tx - w.position.x, dy = ty - w.position.y;
      const d = Math.hypot(dx, dy);
      if (d > 2) {
        const step = Math.min(w.speed * dt, d);
        w.position.x += (dx / d) * step;
        w.position.y += (dy / d) * step;
        w.facing = Math.atan2(dy, dx);
      }
    }
  }
}
