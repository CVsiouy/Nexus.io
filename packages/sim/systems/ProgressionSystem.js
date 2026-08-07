import {
  LEVELS, SKILL_PTS_PER_LEVEL,
  GOLD_PER_SEC, GOLD_PER_LEVEL, XP_PER_SEC,
  MINE_UPGRADE_BASE_COST, MINE_UPGRADE_GROWTH, MINE_BONUS_STEP, MAX_MINE_LEVEL,
  BASE_HP_REGEN_DELAY, BASE_HP_REGEN_RATE,
} from '../constants.js';
import { randPick } from '../utils/helpers.js';

/**
 * Current passive gold income (per second) for a base — used by economy + HUD.
 *
 * Income comes only from the base itself and from mining upgrades you paid for.
 * Destroying a rival grants a one-time lump sum (CONQUEST_GOLD_LUMP) and no
 * ongoing income, so nobody can compound kills into a permanently better economy.
 *
 * Every term is defaulted: this is called on both the server's real Base objects
 * and on decoded snapshot data in the browser, and a single missing field here
 * would produce NaN, which then poisons base.gold on the very next tick and
 * silently shows every player 0 gold rather than throwing anything.
 */
export function goldRate(base) {
  const level   = base.level ?? 1;
  const mining  = base.miningBonus ?? 0;
  const bossOwn = base.bossBonus ?? 0;   // permanent, but bounded by BOSS_COUNT
  const mult    = base.goldMult ?? 1;
  return (GOLD_PER_SEC + level * GOLD_PER_LEVEL + mining + bossOwn) * mult;
}

/** Gold cost of the next mining upgrade (null if maxed). */
export function mineUpgradeCost(base) {
  if (base.mineLevel >= MAX_MINE_LEVEL) return null;
  return Math.round(MINE_UPGRADE_BASE_COST * Math.pow(MINE_UPGRADE_GROWTH, base.mineLevel));
}

/** Buy one mining upgrade if affordable & not maxed. Returns true on success. */
export function buyMineUpgrade(state, base) {
  const cost = mineUpgradeCost(base);
  if (cost == null || base.gold < cost) return false;
  base.gold       -= cost;
  base.mineLevel  += 1;
  base.miningBonus += MINE_BONUS_STEP;
  return true;
}

/**
 * ProgressionSystem
 * ─────────────────
 * • Mines passive GOLD into every base (the base's whole job) and trickles XP.
 * • Awards combat XP, handles level-ups, unlocks, skill points, specialization.
 * • Spawns the Boss on a timer at map centre.
 */
export class ProgressionSystem {
  constructor() {
    this.onSpecReady = null;  // callback → show spec modal
  }

  update(state, dtMs) {
    this._mineAndTrickle(state, dtMs);
    this._regenBases(state, dtMs);
    this._awardXP(state);
    // Bosses are handled by BossSystem now. They no longer appear on a
    // repeating timer and they are not creatures that wander — see that file.
  }

  // Mother base heals once it hasn't been hit for BASE_HP_REGEN_DELAY.
  _regenBases(state, dtMs) {
    const dt = dtMs / 1000;
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const b = player.base;
      if (b.hp >= b.maxHp) continue;
      if (state.time - (b.lastAttackedAt ?? -Infinity) < BASE_HP_REGEN_DELAY) continue;
      b.hp = Math.min(b.maxHp, b.hp + BASE_HP_REGEN_RATE * dt);
    }
  }

  // ── Passive gold mining + XP trickle ────────────────────────────────────────
  _mineAndTrickle(state, dtMs) {
    const dt = dtMs / 1000;
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const base = player.base;
      base.gold += goldRate(base) * dt;
      player.pendingXP += XP_PER_SEC * dt;
    }
  }

  _awardXP(state) {
    for (const [, player] of state.players) {
      if (!player.alive || player.pendingXP <= 0) continue;
      const base = player.base;
      base.xp       += player.pendingXP;
      base.xpEarned += player.pendingXP;
      player.pendingXP = 0;
      this._checkLevelUp(state, player, base);
    }
  }

  // ── Level Up ─────────────────────────────────────────────────────────────
  _checkLevelUp(state, player, base) {
    let changed = true;
    while (changed) {
      changed = false;
      if (base.level >= LEVELS.length) break;
      const next = LEVELS.find(l => l.lv === base.level + 1);
      if (!next) break;
      if (base.xpEarned >= next.xp) {
        base.level++;
        changed = true;
        this._applyLevelUp(state, player, base, next);
      }
    }
  }

  _applyLevelUp(state, player, base, levelDef) {
    base.skillPoints += SKILL_PTS_PER_LEVEL;
    if (player.isBot) {
      const stats = ['atk', 'def', 'spd'];
      while (base.skillPoints > 0) {
        player.buffs[stats[base.level % stats.length]] += 1;
        base.skillPoints--;
      }
    }

    if (levelDef.baseHpBonus) {
      base.maxHp = Math.round(base.maxHp * levelDef.baseHpBonus);
      base.hp    = Math.min(base.hp + 200, base.maxHp);
    }
    if (levelDef.unlock) {
      for (const unit of levelDef.unlock.split(',')) base.unlocked.add(unit.trim());
    }
    if (levelDef.spec && base.specialization === null) {
      // Bots choose immediately; humans get prompted. The callback now receives
      // WHICH player reached the milestone — with eight seats in one match,
      // "somebody may specialize" is not enough information to act on.
      if (player.isBot) this.applySpecialization(state, player, randPick(['bastion', 'warmonger']));
      else if (this.onSpecReady) this.onSpecReady(player);
    }

    state.notify(`⬆️ Level ${base.level}!`, 'success', player.id);
  }

  applySpecialization(state, player, spec) {
    const base = player.base;
    base.specialization = spec;
    if (spec === 'bastion') {
      base.maxHp = Math.round(base.maxHp * 1.3);
      base.hp    = Math.min(base.hp + 300, base.maxHp);
    } else if (spec === 'prospector') {
      base.goldMult *= 1.5;
    }
    state.notify(`✨ Specialization: ${spec.toUpperCase()}!`, 'success', player.id);
  }

}
