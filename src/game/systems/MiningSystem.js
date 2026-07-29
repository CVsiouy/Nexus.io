import { dist2 } from '../../utils/helpers.js';
import { Soldier } from '../entities.js';
import { addSoldierToNearestGroup } from './GroupSystem.js';
import {
  MINE_CAPTURE_RANGE, MINE_CAPTURE_TIME, MINE_NODE_GOLD, MINE_NODE_SPAWN_MS,
  MINE_NODE_GOLD_PER_SOLDIER, MINE_STATION_CAP,
} from '../constants.js';

/**
 * MiningSystem (Mining mode only)
 * ───────────────────────────────
 * Neutral gold nodes are captured by presence: park a squad on a node and it
 * flips to you (more soldiers = faster). A held node feeds gold to your base and
 * slowly grows its own defenders — a forward outpost. Bring more soldiers than
 * the current owner to take it from them.
 */
export class MiningSystem {
  update(state, dt, dtMs) {
    if (state.mode !== 'mining') return;
    for (const [, node] of state.mineNodes) this._updateNode(state, node, dt, dtMs);
  }

  _updateNode(state, node, dt, dtMs) {
    const r2 = MINE_CAPTURE_RANGE * MINE_CAPTURE_RANGE;

    // Tally soldiers present by owner.
    const counts = new Map();
    for (const [, s] of state.soldiers) {
      if (s.hp <= 0) continue;
      if (dist2(s.position, node.position) > r2) continue;
      counts.set(s.ownerId, (counts.get(s.ownerId) || 0) + 1);
    }
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

    // Held node: pump gold (more stationed soldiers → higher rate) + grow defenders.
    if (node.ownerId) {
      const owner = state.players.get(node.ownerId);
      if (!owner?.alive) { node.ownerId = null; return; }
      const garrison = Math.min(counts.get(node.ownerId) || 0, MINE_STATION_CAP);
      node.goldRate = MINE_NODE_GOLD + garrison * MINE_NODE_GOLD_PER_SOLDIER;
      owner.base.gold += node.goldRate * dt;

      node.spawnTimer += dtMs;
      if (node.spawnTimer >= MINE_NODE_SPAWN_MS && state.soldierPop(node.ownerId) + 1 <= state.popCap(owner)) {
        node.spawnTimer = 0;
        const a = Math.random() * Math.PI * 2, r = 30;
        const s = new Soldier(node.ownerId, 'grunt', node.position.x + Math.cos(a) * r, node.position.y + Math.sin(a) * r);
        state.soldiers.set(s.id, s);
        addSoldierToNearestGroup(state, s);
      }
    }
  }
}
