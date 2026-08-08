import { dist2 } from '../utils/helpers.js';
import { MINE_CAPTURE_RANGE, MINE_CAPTURE_TIME, MINE_NODE_GOLD } from '../constants.js';

/**
 * MiningSystem (Mining mode only)
 * ───────────────────────────────
 * Neutral gold nodes are captured by presence: park a squad on a node and it
 * flips to you (more soldiers on it = faster). A held node pays its owner a
 * flat +1 gold/sec. Bring more soldiers than the current owner to take it.
 *
 * A node grows nothing and produces nothing. Holding one costs you soldiers
 * that could have been attacking somebody, and that trade — spread out for
 * income, or concentrate and go for a kill — is the mode.
 */
export class MiningSystem {
  update(state, dt, dtMs) {
    if (state.mode !== 'mining') return;
    for (const [, node] of state.mineNodes) this._updateNode(state, node, dt, dtMs);
  }

  _updateNode(state, node, dt, dtMs) {
    const r2 = MINE_CAPTURE_RANGE * MINE_CAPTURE_RANGE;

    // Tally soldiers present by owner. Only soldiers near the node can matter,
    // so ask the grid rather than scanning the whole map per node.
    const counts = new Map();
    state.grid.forEachNear(node.position.x, node.position.y, MINE_CAPTURE_RANGE, (s) => {
      if (s.hp <= 0) return;
      if (dist2(s.position, node.position) > r2) return;
      counts.set(s.ownerId, (counts.get(s.ownerId) || 0) + 1);
    });
    let dom = null, domN = 0;
    for (const [oid, n] of counts) if (n > domN) { domN = n; dom = oid; }

    if (dom && dom !== node.ownerId) {
      node.capturingBy = dom;
      node.captureProg += (domN / MINE_CAPTURE_TIME) * dtMs; // scaled by how many are on it
      if (node.captureProg >= 1) { node.ownerId = dom; node.captureProg = 0; node.capturingBy = null; }
    } else if (dom && dom === node.ownerId) {
      node.captureProg = 0; node.capturingBy = null;         // owner holding it
    } else {
      node.captureProg = Math.max(0, node.captureProg - (dtMs / MINE_CAPTURE_TIME) * 0.5);
      if (node.captureProg === 0) node.capturingBy = null;
    }

    // A held node pays a flat trickle. It does NOT grow soldiers of its own and
    // it does NOT pay more for parking an army on it — a node is income you
    // have to hold, not a second base that fights for you.
    if (node.ownerId) {
      const owner = state.players.get(node.ownerId);
      if (!owner?.alive) { node.ownerId = null; node.goldRate = 0; return; }
      node.goldRate = MINE_NODE_GOLD;
      owner.base.gold += node.goldRate * dt;
    }
  }
}
