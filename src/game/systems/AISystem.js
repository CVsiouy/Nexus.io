import { dist2 } from '../../utils/helpers.js';
import { BOT_THINK_RATE, SOLDIER_DEFS, TURRET_DEFS, GROUP_MAX_SIZE, GARRISON_MAX } from '../constants.js';
import { attackWithGroup, setDefending, moveGroup, releaseGarrison } from './GroupSystem.js';
import { buyMineUpgrade, mineUpgradeCost } from './ProgressionSystem.js';

/**
 * AISystem — bot brains for the 7 rival mother bases
 * ───────────────────────────────────────────────────
 * Each tier balances economy (buy soldiers/turrets from gold) against
 * aggression (send a formed-up squad at the nearest enemy base):
 *   passive    — turtles: buys turrets, only attacks with a big squad
 *   standard   — buys a mix, attacks at a moderate squad size
 *   aggressive — buys soldiers fast, attacks early and often
 */
export class AISystem {
  update(state, dtMs) {
    for (const [, player] of state.players) {
      if (!player.isBot || !player.alive) continue;
      player._thinkTimer -= dtMs;
      if (player._thinkTimer > 0) continue;
      player._thinkTimer = BOT_THINK_RATE + Math.random() * 800;
      this._think(state, player);
    }
  }

  _think(state, player) {
    const tier = player.botTier;
    const base = player.base;

    this._economy(state, player, tier);

    // Squad size to commit an attack, by tier.
    // Only FULL formations (15) can deploy — same rule as the player.
    const threat = this._threatNearBase(state, player);
    const groups = state.groupsOf(player.id).filter(g => !g.locked);

    if (threat) {
      // Under attack: dump the garrison out to reinforce the defence …
      if (base.garrison > 0) releaseGarrison(state, base);
      // … and pull the biggest free squad back to defend the base.
      const def = groups.sort((a, b) => b.memberIds.length - a.memberIds.length)[0];
      if (def) setDefending(def, base);
      return;
    }

    // Not under attack: once the garrison is full, field it as a formation.
    if (base.garrison >= GARRISON_MAX) releaseGarrison(state, base);

    const ready = groups.filter(g => g.memberIds.length >= GROUP_MAX_SIZE && g.status !== 'moving');

    // Team mode: if a teammate is under attack and we can spare a formation
    // (keep at least one in reserve for our own defence), send help.
    if (state.mode === 'team' && ready.length >= 2) {
      const ally = this._teammateUnderAttack(state, player);
      // setDefending re-anchors the squad on the ally's base — it walks there and
      // holds a defending stance (earning the defender bonus once it arrives).
      if (ally) { setDefending(ready[0], ally.base); return; }
    }

    // Mining mode: send a full squad to grab the nearest node we don't own.
    if (state.mode === 'mining' && ready.length) {
      const node = this._nearestCapturableNode(state, player);
      if (node && Math.random() < 0.7) { moveGroup(ready[0], node.position.x, node.position.y); return; }
    }

    // Commit any full free squad to the nearest enemy base.
    for (const g of ready) {
      const target = this._nearestEnemyBase(state, player);
      if (target) attackWithGroup(g, target.id);
    }
  }

  _nearestCapturableNode(state, player) {
    let best = null, bestD2 = Infinity;
    for (const [, node] of state.mineNodes) {
      if (node.ownerId === player.id) continue;
      const d2 = dist2(player.base.position, node.position);
      if (d2 < bestD2) { bestD2 = d2; best = node; }
    }
    return best;
  }

  // ── Economy ──────────────────────────────────────────────────────────────
  _economy(state, player, tier) {
    const base = player.base;

    // Invest in mining sometimes — passive turtles reinvest the most.
    const mineChance = tier === 'passive' ? 0.35 : tier === 'standard' ? 0.2 : 0.12;
    const mc = mineUpgradeCost(base);
    if (mc != null && base.gold >= mc * 2 && Math.random() < mineChance) buyMineUpgrade(state, base);

    // ── Turrets disabled for now (soldiers-only build). Kept for later re-enable. ──
    // const turretChance = tier === 'passive' ? 0.5 : tier === 'standard' ? 0.25 : 0.1;
    // if (base.turretQueue.length === 0 && Math.random() < turretChance) {
    //   const type = base.level >= TURRET_DEFS.missile.unlockLv && Math.random() < 0.4 ? 'missile' : 'gun';
    //   const def  = TURRET_DEFS[type];
    //   if (base.gold >= def.cost && base.level >= def.unlockLv) base.turretQueue.push({ type });
    // }

    // Build a WALL sometimes (own queue → runs in parallel with soldiers).
    const wallChance = tier === 'passive' ? 0.4 : tier === 'standard' ? 0.25 : 0.12;
    if (base.wallQueue.length === 0 && Math.random() < wallChance && base.gold >= SOLDIER_DEFS.sentinel.cost) {
      base.wallQueue.push({ type: 'sentinel', count: 1 });
    }

    // Keep a grunt queued (soldier queue) if there's population room.
    if (base.soldierQueue.length === 0) {
      const def = SOLDIER_DEFS.grunt;
      if (state.soldierPop(player.id) + def.pop <= state.popCap(player)) {
        base.soldierQueue.push({ type: 'grunt', count: 1 });
      }
    }
  }

  // ── Targeting / threat (team-aware) ─────────────────────────────────────────
  _nearestEnemyBase(state, player) {
    let best = null, bestD2 = Infinity;
    for (const [, p] of state.players) {
      if (!p.alive || !state.areEnemies(player.id, p.id)) continue;
      const d2 = dist2(player.base.position, p.base.position);
      if (d2 < bestD2) { bestD2 = d2; best = p.base; }
    }
    return best;
  }

  _threatNearBase(state, player) {
    const R2 = 220 * 220;
    for (const [, e] of state.soldiers) {
      if (e.hp <= 0 || !state.areEnemies(player.id, e.ownerId)) continue;
      if (dist2(e.position, player.base.position) < R2) return e;
    }
    return null;
  }

  /** A living teammate whose base has enemies pressing on it (nearest one). */
  _teammateUnderAttack(state, player) {
    const R2 = 220 * 220;
    let best = null, bestD2 = Infinity;
    for (const [, ally] of state.players) {
      if (!ally.alive || ally.id === player.id) continue;
      if (state.areEnemies(player.id, ally.id)) continue; // teammate only
      // Is anyone attacking this teammate's base?
      let pressed = false;
      for (const [, e] of state.soldiers) {
        if (e.hp <= 0 || !state.areEnemies(ally.id, e.ownerId)) continue;
        if (dist2(e.position, ally.base.position) < R2) { pressed = true; break; }
      }
      if (!pressed) continue;
      const d2 = dist2(player.base.position, ally.base.position);
      if (d2 < bestD2) { bestD2 = d2; best = ally; }
    }
    return best;
  }
}
