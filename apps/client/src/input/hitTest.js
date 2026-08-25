import { dist2, BASE_DEFENSE_RADIUS, MINE_NODE_RADIUS } from '@basewar/sim';

/**
 * hitTest — "what did the player mean to click on?"
 * ─────────────────────────────────────────────────
 *
 * Free functions rather than InputSystem methods, so the tests can drive them
 * against a real Simulation + WorldView without constructing an InputSystem
 * (which needs a canvas, and therefore a DOM).
 *
 *
 * THE PROBLEM THIS SOLVES
 *
 * Pick radii are in WORLD units — 20 for your own soldier, 16 for an enemy. On
 * screen they are `radius * cam.zoom` pixels. At a phone's play zoom that made
 * a soldier a 2.7-pixel target. A fingertip is about 40 pixels across, so touch
 * selection was not merely awkward, it was arithmetically impossible.
 *
 *
 * THE TWO HALVES OF THE FIX
 *
 * 1. A minimum SCREEN-space radius (MIN_TOUCH_PX), converted back into world
 *    units at the current zoom. The target is finger-sized whatever the zoom.
 *
 * 2. Scoring by NORMALISED distance, d²/R², instead of raw distance. Raw
 *    nearest-wins would be wrong the moment radii differ: a base's 160-unit
 *    ring would swallow every soldier standing near it. Normalised distance
 *    asks "how deep inside its own target zone is this candidate", which is the
 *    only fair comparison between targets of wildly different size.
 *
 *
 * WHY THE PRIORITY ORDER CHANGES FOR TOUCH
 *
 * The old code was first-match-wins in a fixed order, with your own soldier
 * tested BEFORE enemies. With a 40-unit effective radius your own soldier and
 * an adjacent enemy are frequently both under the finger, so first-match-wins
 * meant you could never attack into a melee — you would just re-select your own
 * squad, forever. That is the single most infuriating failure mode an RTS can
 * have on a touchscreen.
 *
 * Nearest-normalised-wins instead gives you whatever is under the CENTRE of
 * your finger, which is both what you meant and what you can aim at.
 *
 * Mouse keeps minTouchPx = 0 and the original first-match order, so desktop
 * behaviour is bit-for-bit unchanged. Same function, different config.
 */

/** Minimum on-screen pick radius in CSS px. 22 => a 44px target (Apple HIG). */
export const MIN_TOUCH_PX = 22;

export const MOUSE_CONFIG = { minTouchPx: 0,             nearestWins: false };
export const TOUCH_CONFIG = { minTouchPx: MIN_TOUCH_PX,  nearestWins: true  };

/** World-space radius that guarantees at least `minTouchPx` on screen. */
export function effectiveRadius(worldRadius, zoom, minTouchPx) {
  if (!minTouchPx || !zoom) return worldRadius;
  return Math.max(worldRadius, minTouchPx / zoom);
}

const RADIUS = {
  ownSoldier:   20,
  enemySoldier: 16,
  boss:         55,
  mineNode:     MINE_NODE_RADIUS + 20,   // 46
  baseRing:     BASE_DEFENSE_RADIUS,     // 160
};

/**
 * Resolve a world point to a target.
 *
 * @returns {{kind:string, entity:object}|null}
 *   kind is one of: 'ownSoldier' | 'teammateBase' | 'enemy' | 'mineNode'
 */
export function pickTarget(world, wp, zoom, cfg = MOUSE_CONFIG) {
  const me = world.playerId;
  const { minTouchPx, nearestWins } = cfg;

  // ── Pass A: base defence rings ──────────────────────────────────────────
  //
  // Never inflated, and always first. The existing behaviour is deliberate:
  // clicking anywhere inside a base's defence ring targets the BASE, so the
  // soldiers milling around it never steal the click. At any real play zoom
  // 160 world units is already the largest target on screen — inflating it
  // would make it swallow half the screen.
  const ring2 = RADIUS.baseRing * RADIUS.baseRing;

  const myTeam = world.teamOf?.(me);
  if (world.mode === 'team' && myTeam) {
    for (const [, p] of world.players) {
      if (!p.alive || p.id === me || p.team !== myTeam) continue;
      if (dist2(p.base.position, wp) < ring2) return { kind: 'teammateBase', entity: p.base };
    }
  }
  for (const [, p] of world.players) {
    if (!p.alive || !world.areEnemies(me, p.id)) continue;
    if (dist2(p.base.position, wp) < ring2) return { kind: 'enemy', entity: p.base };
  }

  // ── Pass B: point-like entities ─────────────────────────────────────────
  const candidates = [];
  const consider = (kind, entity, worldR) => {
    const r = effectiveRadius(worldR, zoom, minTouchPx);
    const d2 = dist2(entity.position, wp);
    if (d2 >= r * r) return;
    candidates.push({ kind, entity, score: d2 / (r * r) });
  };

  for (const [, s] of world.soldiers) {
    if (s.hp <= 0) continue;
    if (s.ownerId === me) consider('ownSoldier', s, RADIUS.ownSoldier);
    else if (world.areEnemies(me, s.ownerId)) consider('enemy', s, RADIUS.enemySoldier);
  }
  for (const [, boss] of world.bosses) consider('enemy', boss, RADIUS.boss);
  if (world.mode === 'mining') {
    for (const [, n] of world.mineNodes) consider('mineNode', n, RADIUS.mineNode);
  }

  if (!candidates.length) return null;

  if (nearestWins) {
    let best = candidates[0];
    for (const c of candidates) if (c.score < best.score) best = c;
    return { kind: best.kind, entity: best.entity };
  }

  // Mouse: reproduce the historical first-match order exactly —
  // own soldier, then enemy, then mine node.
  const ORDER = ['ownSoldier', 'enemy', 'mineNode'];
  for (const kind of ORDER) {
    let best = null;
    for (const c of candidates) {
      if (c.kind !== kind) continue;
      if (!best || c.score < best.score) best = c;
    }
    if (best) return { kind: best.kind, entity: best.entity };
  }
  return null;
}
