import { LEVELS, SOLDIER_DEFS, BOSS_INTERVAL, BOSS_HP } from '../constants.js';
import { Boss } from '../entities.js';
import { randRange, randInt } from '../../utils/helpers.js';

/**
 * ProgressionSystem
 * ─────────────────
 * • Awards accumulated XP to player bases
 * • Handles level-ups and associated unlocks
 * • Triggers specialization modal for human player at level 15
 * • Spawns the Boss on a timer
 */
export class ProgressionSystem {
  constructor() {
    this.onSpecReady = null;  // callback → show spec modal
  }

  update(state, dtMs) {
    this._awardXP(state);
    this._nodeXPTrickle(state, dtMs);
    this._checkBoss(state, dtMs);
  }

  // ── XP ────────────────────────────────────────────────────────────────────
  _awardXP(state) {
    for (const [, player] of state.players) {
      if (!player.alive || player.pendingXP <= 0) continue;
      const base = player.base;
      base.xp += player.pendingXP;
      player.pendingXP = 0;
      this._checkLevelUp(state, player, base);
    }
  }

  _nodeXPTrickle(state, dtMs) {
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const nodes = state.nodeCount(player.id);
      if (nodes === 0) continue;
      // 0.5 XP/sec per owned node
      player.pendingXP += nodes * 0.5 * (dtMs / 1000);
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
      if (base.xp >= next.xp) {
        base.level++;
        changed = true;
        this._applyLevelUp(state, player, base, next);
      }
    }
  }

  _applyLevelUp(state, player, base, levelDef) {
    if (levelDef.linkSlots)    base.linkCapacity = levelDef.linkSlots;
    if (levelDef.linkRange)    base.linkRange    = levelDef.linkRange;
    if (levelDef.autoBonus)    base._autoBonus   = levelDef.autoBonus;
    if (levelDef.baseHpBonus)  {
      base.maxHp = Math.round(base.maxHp * levelDef.baseHpBonus);
      base.hp    = Math.min(base.hp + 200, base.maxHp);
    }
    if (levelDef.unlock) {
      for (const unit of levelDef.unlock.split(',')) {
        base.unlocked.add(unit.trim());
      }
    }
    if (levelDef.spec && base.specialization === null) {
      if (player.isBot) {
        // Bots pick randomly
        const specs = ['sprawl', 'bastion', 'warmonger'];
        this.applySpecialization(state, player, randPick(specs));
      } else {
        // Human player — show modal
        if (this.onSpecReady) this.onSpecReady();
      }
    }

    state.notify(`⬆️ Level ${base.level}!`, 'success', player.id);
  }

  applySpecialization(state, player, spec) {
    const base = player.base;
    base.specialization = spec;

    if (spec === 'bastion') {
      // +40% node & link HP, +30% base HP
      base.maxHp = Math.round(base.maxHp * 1.3);
      base.hp    = Math.min(base.hp + 300, base.maxHp);
      for (const [, node] of state.nodeSites) {
        if (node.ownerId !== player.id) continue;
        node.maxHp = Math.round(node.maxHp * 1.4);
      }
      for (const [, link] of state.links) {
        if (link.ownerId !== player.id) continue;
        link.maxHp = Math.round(link.maxHp * 1.4);
      }
    }

    state.notify(`✨ Specialization: ${spec.toUpperCase()}!`, 'success', player.id);
  }

  // ── Boss ─────────────────────────────────────────────────────────────────
  _checkBoss(state, dtMs) {
    if (state.boss) return;
    state.bossTimer -= dtMs;
    if (state.bossTimer > 0) return;

    state.bossTimer = BOSS_INTERVAL;
    // Spawn at random mid-map location
    const W   = 6000;
    const ang = Math.random() * Math.PI * 2;
    const r   = W * 0.15 + Math.random() * W * 0.15;
    const x   = W / 2 + Math.cos(ang) * r;
    const y   = W / 2 + Math.sin(ang) * r;
    state.boss = new Boss(x, y);
    state.notify('☠️ BOSS spawned at map centre!', 'warning', 'player');
  }
}

function randPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
