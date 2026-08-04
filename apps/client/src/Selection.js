/**
 * Selection — which squads THIS player has highlighted.
 * ────────────────────────────────────────────────────
 *
 * This used to be a `selected` flag on the Group entity itself, inside the
 * shared game state. That was fine with one player and wrong with eight: the
 * game state is broadcast to everyone, so Player A clicking a squad would have
 * drawn a selection ring on Player B's screen too.
 *
 * Selection isn't part of the game — it's part of the interface. It never
 * leaves this machine and is never sent to the server.
 */
export class Selection {
  constructor() {
    /** @type {Set<number>} squad ids */
    this._ids = new Set();
  }

  has(groupId) { return this._ids.has(groupId); }
  get size() { return this._ids.size; }
  get ids() { return [...this._ids]; }

  clear() { this._ids.clear(); }
  add(groupId) { this._ids.add(groupId); }

  only(groupId) {
    this._ids.clear();
    if (groupId != null) this._ids.add(groupId);
  }

  set(groupIds) {
    this._ids.clear();
    for (const id of groupIds) this._ids.add(id);
  }

  /**
   * Squads that are both selected AND still exist. Squads get wiped out, so a
   * stale id must never reach the renderer.
   */
  resolve(world) {
    const out = [];
    for (const id of this._ids) {
      const g = world.groups.get(id);
      if (g) out.push(g); else this._ids.delete(id);
    }
    return out;
  }

  first(world) { return this.resolve(world)[0] ?? null; }
}
