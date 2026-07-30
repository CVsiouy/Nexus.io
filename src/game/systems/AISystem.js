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
      // Pull the biggest free squad back to defend the base first.
      const def = groups.sort((a, b) => b.memberIds.length - a.memberIds.length)[0];
      if (def) setDefending(def, base);

      // Garrison discipline: DON'T trickle soldiers out one-by-one to be picked
      // off. Stockpile them and release a single wall sized to the attack.
      //   • attackers = enemy soldiers pressing the base (their specs unknown)
      //   • ownField  = our living soldiers already fighting near the base
      //   • shortfall = how many more defenders the fight is asking for
      // How big a wall we hold out for depends on how safe the base still is —
      // the base heals once the attack is beaten, so a healthy base can afford
      // to bank up for a stronger wall, while a hurt one must act now:
      //   • hp > 40%  → comfortable: wait for a full-strength wall (~0.8× shortfall,
      //                 the defender bonus lets a slightly smaller wall hold)
      //   • 15–40%    → pressured: release a PARTIAL wave (~0.6×) now — even 5-vs-8
      //                 kills several, so afterwards the base bleeds far slower
      //   • hp < 15%  → emergency: dump whatever is banked to survive
      if (base.garrison > 0) {
        const attackers = this._countAttackers(state, player.id, base.position);
        const ownField  = this._countOwnSoldiers(state, player.id);
        const shortfall = Math.max(0, attackers - ownField);
        const hpFrac    = base.hp / base.maxHp;

        let need;
        if (hpFrac < 0.15)      need = 1;                                                    // emergency: dump it
        else if (hpFrac < 0.40) need = Math.min(GARRISON_MAX, Math.max(4, Math.ceil(shortfall * 0.6))); // partial thinning wave
        else                    need = Math.min(GARRISON_MAX, Math.max(5, Math.ceil(shortfall * 0.8))); // full-strength wall

        if (base.garrison >= need || base.garrison >= GARRISON_MAX) {
          releaseGarrison(state, base);
        }
      }
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

  /** How many enemy soldiers are pressing this position (their specs unknown). */
  _countAttackers(state, ownerId, pos) {
    const R2 = 260 * 260;
    let n = 0;
    for (const [, e] of state.soldiers) {
      if (e.hp <= 0 || !state.areEnemies(ownerId, e.ownerId)) continue;
      if (dist2(e.position, pos) < R2) n++;
    }
    return n;
  }

  /** How many living soldiers this owner already has on the field. */
  _countOwnSoldiers(state, ownerId) {
    let n = 0;
    for (const [, s] of state.soldiers) if (s.hp > 0 && s.ownerId === ownerId) n++;
    return n;
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
