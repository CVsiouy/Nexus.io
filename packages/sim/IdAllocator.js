/**
 * IdAllocator — hands out entity IDs for ONE simulation.
 * ─────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS
 *
 * Every soldier, base, squad and projectile needs a name so that messages can
 * refer to it ("soldier 42 died"). The old code did this:
 *
 *     let _id = 0;
 *     export const uid = () => `e${++_id}`;
 *
 * That counter sits at the top of a module, which in Node.js means it is
 * shared by EVERY match running inside that server process, and it only ever
 * counts upward — for as long as the server stays running.
 *
 * IDs stayed unique, so nothing broke in single-player. The problem is what
 * happens once we put this on a server and start sending IDs over the network.
 *
 * To keep bandwidth low we want to refer to an entity in 2 bytes, which can
 * hold values 0..65535. That is plenty for one match — even a busy match has
 * well under 2,000 things in it at any moment. But with one shared counter:
 *
 *     30 matches per process × ~400 soldiers created per match per minute
 *       ≈ 12,000 new IDs every minute
 *       → past 65,535 in about five minutes of server uptime
 *
 * After that, IDs would wrap around and start pointing at the wrong entities:
 * damage applied to the wrong unit, soldiers appearing to teleport. We could
 * use 4 bytes instead, but entity IDs appear many times in every snapshot, so
 * that quietly doubles a large slice of our bandwidth bill forever.
 *
 * The fix: one allocator per simulation, and reuse IDs after entities die.
 * Then no match ever climbs above a couple of thousand, 2 bytes is safe
 * permanently, and each match becomes fully self-contained.
 *
 *
 * WHY REUSE IS DELAYED
 *
 * Reusing an ID the instant it's freed is dangerous over a network. Picture:
 *
 *     tick 100  soldier 42 dies, id 42 goes back in the pool
 *     tick 100  a new soldier spawns and is also given id 42
 *     tick 101  a client that was one snapshot behind processes the update,
 *               and applies "soldier 42 is at (900, 400) with 12 HP" to the
 *               NEW soldier — which is somewhere else entirely
 *
 * So freed IDs go to the back of a queue and are only reissued once enough
 * others are waiting ahead of them. By then every client has certainly
 * processed the removal.
 */

const DEFAULT_MAX = 65535;   // fits in 2 bytes (Uint16)
const DEFAULT_REUSE_DELAY = 512;
const COMPACT_AT = 4096;     // tidy the queue's dead prefix past this point

export class IdAllocator {
  /**
   * @param {object} [opts]
   * @param {number} [opts.max]        Highest ID this allocator may issue.
   * @param {number} [opts.reuseDelay] How many freed IDs must be queued before
   *                                   the oldest becomes reusable.
   */
  constructor({ max = DEFAULT_MAX, reuseDelay = DEFAULT_REUSE_DELAY } = {}) {
    this._next = 1;          // next never-used ID (0 is reserved for "none")
    this._freed = [];        // queue of returned IDs, oldest first
    this._head = 0;          // read position into _freed (avoids costly shift())
    this._max = max;
    this._reuseDelay = reuseDelay;
  }

  /** Take an ID. Throws only if a single match somehow exceeds `max` live entities. */
  alloc() {
    // Prefer a recycled ID, but only once the queue is deep enough (see above).
    if (this._freed.length - this._head > this._reuseDelay) return this._takeFreed();

    // Otherwise hand out a fresh one.
    if (this._next <= this._max) return this._next++;

    // Fresh range exhausted — recycle early rather than fail.
    if (this._head < this._freed.length) return this._takeFreed();

    throw new Error(
      `IdAllocator exhausted: ${this._max} simultaneously live entities in one simulation. ` +
      `This should be impossible in a normal match — look for a leak (entities deleted ` +
      `from a Map without free() being called).`
    );
  }

  _takeFreed() {
    const id = this._freed[this._head++];
    // The consumed prefix is dead weight; drop it occasionally so the array
    // doesn't grow without bound over a long match.
    if (this._head > COMPACT_AT) {
      this._freed = this._freed.slice(this._head);
      this._head = 0;
    }
    return id;
  }

  /** Return an ID after its entity is destroyed. Safe to call with null/undefined. */
  free(id) {
    if (id == null) return;
    this._freed.push(id);
  }

  /** How many IDs are currently checked out. Useful as a leak detector in tests. */
  get liveCount() {
    return (this._next - 1) - (this._freed.length - this._head);
  }

  /** Highest ID ever issued. Should stay small — if it climbs, recycling isn't working. */
  get highWater() {
    return this._next - 1;
  }
}
