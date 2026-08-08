import {
  BASE_RADIUS, WALL_GAP, WALL_LAYER_GAP, WALL_CELL_SIZE,
  WALL_CELLS_BASE, WALL_CELLS_PER_LAYER, DEFENDER_HP,
  WALL_REPAIR_DELAY, WALL_REPAIR_RATE, MAX_WALL_LAYERS,
} from './constants.js';

/** True if the base can accept another wall cell (a ring has room, or a new ring is allowed). */
export function canAddWall(base) {
  if (base.walls.some(l => l.cells.length < l.maxCells)) return true;
  return base.walls.length < MAX_WALL_LAYERS;
}

/**
 * Defensive walls
 * ───────────────
 * A base's walls are concentric ring LAYERS of static cells. Each CELL has its
 * OWN HP. A layer only BLOCKS attackers when it's a complete ring (every slot
 * filled). Destroy any one cell and a GAP opens — the rest of the ring stays
 * standing, but the layer no longer blocks, so soldiers pour through the gap to
 * the next layer, then the base. Damaged cells auto-repair after a calm spell.
 *
 * Layer: { ring, radius, maxCells, cells: [{ slot, hp, maxHp, lastHit }] }
 */

export function addWallCell(base) {
  // Fill the innermost layer that still has an empty slot; else start a new ring.
  let layer = base.walls.find(l => l.cells.length < l.maxCells);
  if (!layer) {
    if (base.walls.length >= MAX_WALL_LAYERS) return null; // capped at 3 rings
    const ring     = base.walls.length;
    const radius   = BASE_RADIUS + WALL_GAP + ring * WALL_LAYER_GAP;
    const maxCells = WALL_CELLS_BASE + ring * WALL_CELLS_PER_LAYER;
    layer = { ring, radius, maxCells, cells: [] };
    base.walls.push(layer);
  }
  // Lowest free slot index (so gaps get refilled in place).
  const used = new Set(layer.cells.map(c => c.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  layer.cells.push({ slot, hp: DEFENDER_HP, maxHp: DEFENDER_HP, lastHit: -Infinity });
  return layer;
}

/** A layer blocks only when it's a full ring of (still-alive) cells. */
export function layerComplete(layer) {
  return layer.cells.length >= layer.maxCells;
}

/** Outermost COMPLETE ring — the one attackers must punch a hole in. null if none. */
export function outerBlockingLayer(base) {
  let best = null;
  for (const l of base.walls) {
    if (!layerComplete(l)) continue;
    if (!best || l.radius > best.radius) best = l;
  }
  return best;
}

/** Outermost ring that still has ANY cells standing, complete or not. */
export function outermostLayer(base) {
  let best = null;
  for (const l of base.walls) {
    if (!l.cells.length) continue;
    if (!best || l.radius > best.radius) best = l;
  }
  return best;
}

// ─── Where a wall is solid, and where it has a hole ──────────────────────────
//
// A ring is divided into `maxCells` equal sectors, one per slot. A sector is
// solid if its cell is still standing, and open if that cell has been
// destroyed. That is what makes a breach mean something: knock out ONE cell and
// you have opened a doorway, and attackers have to funnel through that doorway
// rather than strolling across the ring wherever they like.
//
// (Previously an incomplete ring simply stopped blocking anywhere at all, so
// destroying a single cell made the entire wall meaningless.)

/** The slot whose sector contains `angle` (radians, same frame as cellPos). */
export function slotAtAngle(layer, angle) {
  const TAU = Math.PI * 2;
  // cellPos puts slot s at (s / maxCells) * TAU - PI/2, so undo that offset.
  let t = (angle + Math.PI / 2) / TAU;
  t -= Math.floor(t);                       // wrap into 0..1
  return Math.round(t * layer.maxCells) % layer.maxCells;
}

/** Is this ring solid at `angle`, i.e. is the cell covering that sector alive? */
export function solidAtAngle(layer, angle) {
  const slot = slotAtAngle(layer, angle);
  for (const c of layer.cells) if (c.slot === slot) return true;
  return false;
}

/**
 * Would moving from `from` to `to` cross this ring through solid wall?
 *
 * Crossing is what we block, NOT simply being inside. A soldier that came in
 * legitimately through a breach must be free to move around inside; only the
 * act of passing through a standing section is forbidden.
 */
/**
 * Tolerance on the "was I outside?" test.
 *
 * This is not cosmetic. A soldier held at the wall gets placed exactly on the
 * boundary, and recomputing its distance from those coordinates lands a hair
 * UNDER the boundary through ordinary floating-point error. A strict `>=` then
 * reads it as "already inside", stops blocking, and the soldier strolls through
 * a wall that is fully intact — which is precisely the leak that let squads
 * reach the boss with all twelve cells standing.
 */
const BOUNDARY_EPS = 1.0;

export function crossesWall(base, layer, from, to) {
  const cx = base.position.x, cy = base.position.y;
  const rOut = layer.radius + WALL_CELL_SIZE * 0.6;

  const dFrom = Math.hypot(from.x - cx, from.y - cy);
  const dTo = Math.hypot(to.x - cx, to.y - cy);

  // Only an inward crossing of the ring boundary counts. The epsilon keeps a
  // soldier pinned ON the boundary counted as outside.
  if (!(dFrom >= rOut - BOUNDARY_EPS && dTo < rOut)) return false;

  // Check the wall at the angle where the crossing happens.
  return solidAtAngle(layer, Math.atan2(to.y - cy, to.x - cx));
}

/**
 * Push a point back to just outside `layer`, keeping its bearing from the base.
 * Placed a little beyond the boundary rather than exactly on it, so the next
 * tick unambiguously sees it as outside.
 */
export function pushOutside(base, layer, pos) {
  const cx = base.position.x, cy = base.position.y;
  const dx = pos.x - cx, dy = pos.y - cy;
  const d = Math.hypot(dx, dy) || 1;
  const rOut = layer.radius + WALL_CELL_SIZE * 0.6 + BOUNDARY_EPS;
  return { x: cx + (dx / d) * rOut, y: cy + (dy / d) * rOut };
}

export function hasBlockingWall(base) {
  return outerBlockingLayer(base) !== null;
}

/** World position of a cell. */
export function cellPos(base, layer, cell) {
  const a = (cell.slot / layer.maxCells) * Math.PI * 2 - Math.PI / 2;
  return {
    x: base.position.x + Math.cos(a) * layer.radius,
    y: base.position.y + Math.sin(a) * layer.radius,
    angle: a,
  };
}

/** All cell positions of a layer (for rendering). */
export function cellPositions(base, layer) {
  return layer.cells.map(c => ({ ...cellPos(base, layer, c), cell: c }));
}

/**
 * Which ring is actually standing between `fromPos` and the centre?
 *
 * Bases can have up to MAX_WALL_LAYERS concentric rings, and the answer is
 * neither "the outermost ring" nor "the outermost complete ring" — it is the
 * outermost ring that BOTH still encloses this point AND is solid on its
 * bearing. Anything the attacker is already inside of, or that has a hole where
 * they are standing, is not in their way.
 *
 * Getting this wrong is what stranded squads between two rings: after breaching
 * the outer ring they were judged to be "past the wall", so they stopped
 * attacking walls — while the inner ring still blocked them from the base. They
 * could neither advance nor break anything.
 *
 * Returns null when the path to the centre is clear.
 */
export function blockingLayerFor(base, fromPos) {
  const dx = fromPos.x - base.position.x;
  const dy = fromPos.y - base.position.y;
  const d = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);

  let best = null;
  for (const l of base.walls) {
    if (!l.cells.length) continue;
    if (d <= l.radius) continue;              // already inside this ring
    if (!solidAtAngle(l, angle)) continue;    // a hole sits on our bearing
    if (!best || l.radius > best.radius) best = l;   // the first one we'd meet
  }
  return best;
}

/**
 * The breach nearest to `fromPos`, if this ring has one.
 *
 * Returns a point just INSIDE the ring at the missing slot, i.e. the doorway to
 * walk through. Null when the ring is still complete.
 *
 * This is what stops attackers standing uselessly against an already-broken
 * wall: if there is a way in, head for it.
 */
export function nearestGap(base, layer, fromPos) {
  const present = new Set(layer.cells.map(c => c.slot));
  let best = null, bestD2 = Infinity;

  for (let slot = 0; slot < layer.maxCells; slot++) {
    if (present.has(slot)) continue;
    const a = (slot / layer.maxCells) * Math.PI * 2 - Math.PI / 2;
    // Aim a little inside the ring so they actually pass through it.
    const r = layer.radius - WALL_CELL_SIZE;
    const p = {
      x: base.position.x + Math.cos(a) * r,
      y: base.position.y + Math.sin(a) * r,
    };
    const d2 = (p.x - fromPos.x) ** 2 + (p.y - fromPos.y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = { slot, pos: p, angle: a }; }
  }
  return best;
}

/** Nearest alive cell of a layer to a point. Returns { cell, pos } or null. */
export function nearestCell(base, layer, fromPos) {
  let best = null, bestD2 = Infinity;
  for (const c of layer.cells) {
    const p = cellPos(base, layer, c);
    const d2 = (p.x - fromPos.x) ** 2 + (p.y - fromPos.y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = { cell: c, pos: p }; }
  }
  return best;
}

/** Damage one cell. Removes it (opens a gap) and returns true if destroyed. */
export function damageCell(base, layer, cell, dmg, now) {
  cell.hp -= dmg;
  cell.lastHit = now;
  base.lastAttackedAt = now; // drives the "base under attack" blink
  if (cell.hp <= 0) {
    const i = layer.cells.indexOf(cell);
    if (i >= 0) layer.cells.splice(i, 1);
    return true;
  }
  return false;
}

/** Auto-repair: cells not hit for WALL_REPAIR_DELAY regen toward their max. */
export function repairWalls(base, now, dt) {
  for (const l of base.walls) {
    for (const c of l.cells) {
      if (c.hp >= c.maxHp) continue;
      if (now - c.lastHit < WALL_REPAIR_DELAY) continue;
      c.hp = Math.min(c.maxHp, c.hp + WALL_REPAIR_RATE * dt);
    }
  }
}
