/**
 * HashGrid — "who is near this point?" without checking everyone.
 * ─────────────────────────────────────────────────────────────
 *
 * THE PROBLEM
 *
 * Combat asks the same question constantly: "are there any enemies near this
 * soldier?" The original code answered it by looking at every soldier on the
 * map, for every soldier on the map:
 *
 *     for (const soldier of allSoldiers)      // 400
 *       for (const other of allSoldiers)      // × 400
 *         if (close enough) ...               // = 160,000 checks
 *
 * At 20 ticks per second that is 3.2 million distance checks every second, in
 * ONE match. And it scales badly: double the soldiers and the work goes up four
 * times, not two. That is what "O(n²)" means, and it is the single biggest
 * thing standing between renting 3 servers and renting 30.
 *
 * THE FIX — an analogy
 *
 * You are in a stadium of 50,000 people looking for a friend.
 *   Naive:  check every seat.                        50,000 checks
 *   Smart:  they tell you "Section C, Row 12."       ~200 checks
 *
 * That is all this is. We divide the map into a grid of squares. Every tick,
 * each soldier records which square it is standing in — that is 400 cheap
 * operations. Then "any enemies within 210 pixels?" only looks at the handful
 * of squares that could possibly contain something in range, instead of the
 * whole map.
 *
 * 400 checks becomes roughly 10.
 *
 * CHOOSING THE CELL SIZE
 *
 * Cells want to be about the size of a typical query radius. Too small and you
 * walk many empty cells; too large and each cell holds too many entities and
 * you are back to scanning. The largest radius in this game is 280
 * (BASE_DEFENSE_RADIUS) and the biggest soldier aggro radius is 210, so 128 is
 * a good starting point over a 2,800px map — a 22×22 grid where a 210px query
 * touches about 4×4 cells.
 */

export const DEFAULT_CELL_SIZE = 128;

export class HashGrid {
  /**
   * @param {number} worldSize  width/height of the (square) map
   * @param {number} [cellSize]
   */
  constructor(worldSize, cellSize = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
    this.cols = Math.ceil(worldSize / cellSize) + 1;
    this.rows = this.cols;

    // One array per cell, allocated once and reused. Rebuilding these arrays
    // every tick would generate a lot of garbage, and garbage collection
    // pauses are exactly the kind of stutter a game server must not have.
    this._cells = new Array(this.cols * this.rows);
    for (let i = 0; i < this._cells.length; i++) this._cells[i] = [];

    this._count = 0;
  }

  get size() { return this._count; }

  /** Empty every cell, keeping the arrays themselves for reuse. */
  clear() {
    for (let i = 0; i < this._cells.length; i++) {
      const c = this._cells[i];
      if (c.length) c.length = 0;
    }
    this._count = 0;
  }

  _index(x, y) {
    let cx = (x / this.cellSize) | 0;
    let cy = (y / this.cellSize) | 0;
    if (cx < 0) cx = 0; else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0; else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  /** Add one entity. It must have a `position` with x/y. */
  insert(entity) {
    this._cells[this._index(entity.position.x, entity.position.y)].push(entity);
    this._count++;
  }

  /** Clear and refill from an iterable (a Map's .values(), typically). */
  rebuild(entities) {
    this.clear();
    for (const e of entities) {
      if (e.hp !== undefined && e.hp <= 0) continue;   // skip the dead
      this.insert(e);
    }
    return this;
  }

  /**
   * Call `fn(entity)` for everything in the cells overlapping a circle.
   *
   * NOTE: this is a BROAD phase — it returns everything in the nearby squares,
   * which includes some entities slightly outside the radius. Callers still do
   * their own exact distance check. That is normal and intended: the grid's job
   * is to shrink the candidate list from 400 to ~10, not to be exact.
   *
   * Takes a callback rather than returning an array so that nothing is
   * allocated per query — this runs hundreds of times per tick.
   */
  forEachNear(x, y, radius, fn) {
    const cs = this.cellSize;
    let minX = ((x - radius) / cs) | 0;
    let maxX = ((x + radius) / cs) | 0;
    let minY = ((y - radius) / cs) | 0;
    let maxY = ((y + radius) / cs) | 0;

    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX >= this.cols) maxX = this.cols - 1;
    if (maxY >= this.rows) maxY = this.rows - 1;

    for (let cy = minY; cy <= maxY; cy++) {
      const row = cy * this.cols;
      for (let cx = minX; cx <= maxX; cx++) {
        const cell = this._cells[row + cx];
        for (let i = 0; i < cell.length; i++) fn(cell[i]);
      }
    }
  }

  /**
   * Nearest entity to (x, y) within `radius` that passes `accept`.
   * Returns null if there is nothing.
   */
  nearest(x, y, radius, accept) {
    let best = null;
    let bestD2 = radius * radius;
    this.forEachNear(x, y, radius, (e) => {
      if (accept && !accept(e)) return;
      const dx = e.position.x - x, dy = e.position.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = e; }
    });
    return best;
  }

  /** True if anything within `radius` passes `accept`. Stops early where it can. */
  any(x, y, radius, accept) {
    // forEachNear has no early exit, so we track a flag. Still vastly cheaper
    // than scanning every entity on the map.
    let found = false;
    this.forEachNear(x, y, radius, (e) => {
      if (found) return;
      if (!accept || accept(e)) found = true;
    });
    return found;
  }

  /** How many entities within `radius` pass `accept`. */
  count(x, y, radius, accept) {
    let n = 0;
    this.forEachNear(x, y, radius, (e) => {
      if (!accept || accept(e)) {
        const dx = e.position.x - x, dy = e.position.y - y;
        if (dx * dx + dy * dy <= radius * radius) n++;
      }
    });
    return n;
  }
}
