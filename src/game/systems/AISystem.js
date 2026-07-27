import { dist2 } from '../../utils/helpers.js';
import { BOT_THINK_RATE, SOLDIER_DEFS, TURRET_DEFS } from '../constants.js';
import { attackWithGroup, setDefending, moveGroup } from './GroupSystem.js';
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
    const attackAt = tier === 'aggressive' ? 4 : tier === 'standard' ? 6 : 9;

    const threat = this._threatNearBase(state, player);
    const groups = state.groupsOf(player.id).filter(g => !g.locked);

    if (threat) {
      // Pull the biggest free squad back to defend the base.
      const def = groups.sort((a, b) => b.memberIds.length - a.memberIds.length)[0];
      if (def) setDefending(def, base);
      return;
    }

    // Mining mode: send free squads to grab the nearest node we don't own.
    if (state.mode === 'mining') {
      for (const g of groups) {
        if (g.status === 'moving' || g.memberIds.length < 2) continue;
        const node = this._nearestCapturableNode(state, player);
        if (node && Math.random() < 0.6) { moveGroup(g, node.position.x, node.position.y); return; }
      }
    }

    // Commit any free squad that has reached attack strength.
    for (const g of groups) {
      if (g.memberIds.length < attackAt) continue;
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
}
