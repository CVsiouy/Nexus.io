import {
  BASE_RADIUS, WALL_GAP, WALL_LAYER_GAP,
  WALL_CELLS_BASE, WALL_CELLS_PER_LAYER, DEFENDER_HP,
  WALL_REPAIR_DELAY, WALL_REPAIR_RATE,
} from './constants.js';

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
