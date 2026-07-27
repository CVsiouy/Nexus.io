import { LEVELS, WORLD_SIZE, SOLDIER_DEFS, TURRET_DEFS, CENTER_RADIUS } from '../constants.js';
import { hexToCSS } from '../../utils/helpers.js';
import { goldRate, mineUpgradeCost } from '../systems/ProgressionSystem.js';

const STATUS_LABEL = {
  idle:      'IDLE',
  moving:    'MOVING',
  attacking: 'ATTACKING',
  defending: 'DEFENDING',
  farming:   'FARMING',
};
const STATUS_COLOR = {
  idle:      '#7b8fa1',
  moving:    '#0077cc',
  attacking: '#dc2626',
  defending: '#16a34a',
  farming:   '#d97706',
};

/**
 * HUDRenderer — DOM HUD.
 * • Base panel: level, HP, XP, GOLD
 * • Group panel (left): each squad as a big semi-transparent number + status
 * • Build panel: soldiers + turrets, priced in gold
 * • Skill/buffs panel, leaderboard, limited minimap, notifications
 */
export class HUDRenderer {
  constructor() {
    this._lvl    = document.getElementById('hud-lvl');
    this._xpEl   = document.getElementById('hud-xp');
    this._xpNext = document.getElementById('hud-xp-next');
    this._xpBar  = document.getElementById('xp-fill');
    this._hpEl   = document.getElementById('hud-hp');
    this._maxHp  = document.getElementById('hud-maxhp');
    this._hpBar  = document.getElementById('hp-fill');
    this._goldEl = document.getElementById('hud-gold');
    this._goldRate = document.getElementById('hud-gold-rate');
    this._specBadge = document.getElementById('hud-spec');

    this._lbEntries = document.getElementById('lb-entries');
    this._groupList = document.getElementById('group-list');

    this._mmCanvas = document.getElementById('minimap');
    this._mmCtx    = this._mmCanvas.getContext('2d');
    this._cmdBase  = document.getElementById('cmd-base'); // blinks red when base attacked

    this._buildBtns  = [...document.querySelectorAll('#build-panel .unit-btn')];
    this._turretBtns = [...document.querySelectorAll('#build-panel .turret-btn')];
    this._bpGold = document.getElementById('bp-gold');
    this._bpPop  = document.getElementById('bp-pop');
    this._mineBtn  = document.getElementById('mine-btn');
    this._mineCost = document.getElementById('mine-cost');
    this._mineLvl  = document.getElementById('mine-lvl');

    this._skPanel = document.getElementById('skill-panel');
    this._skPts   = document.getElementById('sk-pts');
    this._skRows  = [...document.querySelectorAll('#skill-panel .sk-row')];
    this._skVals  = {
      atk: document.getElementById('sk-atk'),
      def: document.getElementById('sk-def'),
      spd: document.getElementById('sk-spd'),
    };

    this._prevLbHash    = '';
    this._prevBuildHash = '';
    this._prevSkillHash = '';
    this._prevGroupHash = '';

    // Set by Game so clicking a group in the panel focuses it.
    this.onGroupClick = null;
  }

  update(state) {
    const player = state.players.get(state.playerId);
    if (!player) return;
    this._updateBasePanel(state, player);
    this._updateBaseAlert(state, player);
    this._updateGroupPanel(state, player);
    this._updateLeaderboard(state);
    this._updateMinimap(state);
    this._updateBuildPanel(state, player);
    this._updateSkillPanel(state, player);
  }

  // Blink the Base button red while the mother base (or its walls) is under attack.
  _updateBaseAlert(state, player) {
    if (!this._cmdBase) return;
    const underAttack = (state.time - (player.base.lastAttackedAt ?? -Infinity)) < 1500;
    this._cmdBase.classList.toggle('under-attack', underAttack);
  }

  // ── Base panel ─────────────────────────────────────────────────────────────
  _updateBasePanel(state, player) {
    const base = player.base;
    const level = base.level;
    const xpEarned = Math.floor(base.xpEarned);
    const nextLv = LEVELS.find(l => l.lv === level + 1);
    const xpNext = nextLv ? nextLv.xp : xpEarned;
    const prevLv = LEVELS.find(l => l.lv === level);
    const xpPrev = prevLv ? prevLv.xp : 0;
    const xpPct = xpNext > xpPrev ? Math.min(100, ((xpEarned - xpPrev) / (xpNext - xpPrev)) * 100) : 100;

    this._lvl.textContent    = level;
    this._xpEl.textContent   = xpEarned;
    this._xpNext.textContent = xpNext;
    this._xpBar.style.width  = xpPct + '%';

    const hp = Math.ceil(base.hp);
    this._hpEl.textContent  = hp;
    this._maxHp.textContent = base.maxHp;
    this._hpBar.style.width = (hp / base.maxHp * 100) + '%';

    this._goldEl.textContent = Math.floor(base.gold);
    if (this._goldRate) this._goldRate.textContent = `+${Math.round(goldRate(base))}/s`;

    if (base.specialization) {
      this._specBadge.textContent = base.specialization.toUpperCase();
      this._specBadge.style.display = 'inline-block';
    }
  }

  // ── Group panel (left) ──────────────────────────────────────────────────────
  _updateGroupPanel(state, player) {
    const groups = state.groupsOf(player.id);
    const hash = groups.map(g => `${g.id}:${g.memberIds.length}:${g.status}:${g.selected ? 1 : 0}:${g.locked ? 1 : 0}`).join('|');
    if (hash === this._prevGroupHash) return;
    this._prevGroupHash = hash;

    if (groups.length === 0) {
      this._groupList.innerHTML = '<div class="group-empty">No squads yet</div>';
      return;
    }

    this._groupList.innerHTML = groups.map(g => `
      <div class="group-entry ${g.selected ? 'sel' : ''} ${g.locked ? 'locked' : ''}" data-id="${g.id}">
        <span class="g-count">${g.memberIds.length}</span>
        <span class="g-status" style="color:${STATUS_COLOR[g.status]}">${STATUS_LABEL[g.status]}${g.locked ? ' 🔒' : ''}</span>
      </div>
    `).join('');

    for (const el of this._groupList.querySelectorAll('.group-entry')) {
      el.addEventListener('click', () => {
        if (this.onGroupClick) this.onGroupClick(el.dataset.id);
      });
    }
  }

  // ── Build panel (soldiers + turrets) ─────────────────────────────────────────
  _updateBuildPanel(state, player) {
    const base = player.base;
    const gold = Math.floor(base.gold);
    const pop  = state.soldierPop(player.id);
    const cap  = state.popCap(player);

    const queued = {}; // soldiers + walls (two separate queues, shown per button)
    for (const e of base.soldierQueue) queued[e.type] = (queued[e.type] || 0) + e.count;
    for (const e of base.wallQueue)    queued[e.type] = (queued[e.type] || 0) + e.count;
    const turretQ = {};
    for (const e of base.turretQueue) turretQ[e.type] = (turretQ[e.type] || 0) + 1;

    const hash = base.level + '|' + gold + '|' + pop + '/' + cap + '|' + base.mineLevel + '|' +
      this._buildBtns.map(b => queued[b.dataset.unit] || 0).join(',') + '|' +
      this._turretBtns.map(b => turretQ[b.dataset.turret] || 0).join(',');
    if (hash === this._prevBuildHash) return;
    this._prevBuildHash = hash;

    if (this._bpGold) this._bpGold.textContent = gold;
    if (this._bpPop)  this._bpPop.textContent  = `${pop}/${cap}`;

    // Mining upgrade button
    if (this._mineBtn) {
      const cost = mineUpgradeCost(base);
      if (this._mineLvl)  this._mineLvl.textContent  = `Lv ${base.mineLevel}`;
      if (cost == null) {
        if (this._mineCost) this._mineCost.textContent = 'MAX';
        this._mineBtn.classList.add('locked');
        this._mineBtn.classList.remove('cant-afford');
      } else {
        if (this._mineCost) this._mineCost.textContent = `${cost}g`;
        this._mineBtn.classList.remove('locked');
        this._mineBtn.classList.toggle('cant-afford', gold < cost);
      }
    }

    for (const btn of this._buildBtns) {
      const unit = btn.dataset.unit;
      const def  = SOLDIER_DEFS[unit];
      if (!def) continue; // safety: ignore any button without a valid unit type
      const locked = !base.unlocked.has(unit);
      const count  = queued[unit] || 0;
      const isWall = unit === 'sentinel'; // the Defender is a wall — no population cost
      const cantAfford = !locked && (gold < def.cost || (!isWall && pop + def.pop > cap));
      btn.classList.toggle('locked', locked);
      btn.classList.toggle('active', count > 0 && !locked);
      btn.classList.toggle('cant-afford', cantAfford && count === 0);
      const badge = btn.querySelector('.u-badge');
      if (badge) badge.textContent = count > 0 ? String(count) : '';
    }

    for (const btn of this._turretBtns) {
      const type = btn.dataset.turret;
      const def  = TURRET_DEFS[type];
      if (!def) continue; // safety: skip non-turret buttons (e.g. the mine upgrade)
      const locked = base.level < def.unlockLv;
      const count  = turretQ[type] || 0;
      const cantAfford = !locked && gold < def.cost;
      btn.classList.toggle('locked', locked);
      btn.classList.toggle('active', count > 0 && !locked);
      btn.classList.toggle('cant-afford', cantAfford && count === 0);
      const badge = btn.querySelector('.u-badge');
      if (badge) badge.textContent = count > 0 ? String(count) : '';
    }
  }

  // ── Skill panel ──────────────────────────────────────────────────────────
  _updateSkillPanel(state, player) {
    const base = player.base;
    const buffs = player.buffs;
    const pts = base.skillPoints;
    const hash = `${pts}|${buffs.atk},${buffs.def},${buffs.spd}`;
    if (hash === this._prevSkillHash) return;
    this._prevSkillHash = hash;
    if (this._skPts) this._skPts.textContent = pts;
    if (this._skPanel) this._skPanel.classList.toggle('has-pts', pts > 0);
    this._skVals.atk.textContent = `+${buffs.atk * 10}%`;
    this._skVals.def.textContent = `+${buffs.def * 10}%`;
    this._skVals.spd.textContent = `+${buffs.spd * 10}%`;
    for (const row of this._skRows) row.classList.toggle('spendable', pts > 0);
  }

  // ── Leaderboard ──────────────────────────────────────────────────────────
  _updateLeaderboard(state) {
    const entries = [];
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      entries.push({
        id: player.id,
        isMe: player.id === state.playerId,
        color: player.color,
        name: player.id === state.playerId ? 'YOU' : player.id.replace('bot_', 'Bot '),
        score: player.base.level * 5 + state.soldierCount(player.id),
        lvl: player.base.level,
      });
    }
    entries.sort((a, b) => b.score - a.score);
    const hash = entries.map(e => e.id + e.score).join(',');
    if (hash === this._prevLbHash) return;
    this._prevLbHash = hash;

    this._lbEntries.innerHTML = entries.slice(0, 10).map((e, i) => `
      <div class="lb-entry ${e.isMe ? 'is-player' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-dot" style="background:${hexToCSS(e.color)}"></span>
        <span class="lb-name">${e.name}</span>
        <span class="lb-score">Lv${e.lvl}</span>
      </div>
    `).join('');
  }

  // ── Minimap (limited: only your own base + squads; enemies stay hidden) ───────
  _updateMinimap(state) {
    const ctx = this._mmCtx;
    const W = this._mmCanvas.width;
    const H = this._mmCanvas.height;
    const scale = W / WORLD_SIZE;
    const me = state.players.get(state.playerId);

    ctx.fillStyle = '#08081a';
    ctx.fillRect(0, 0, W, H);

    if (state.mode === 'mining') {
      // Mining nodes (owner-coloured, grey if neutral).
      for (const [, node] of state.mineNodes) {
        const owner = node.ownerId ? state.players.get(node.ownerId) : null;
        ctx.fillStyle = owner ? hexToCSS(owner.color) : '#9aa5b1';
        ctx.beginPath();
        ctx.arc(node.position.x * scale, node.position.y * scale, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Neutral centre hunting ground + wildlings.
      ctx.strokeStyle = 'rgba(196,181,160,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc((WORLD_SIZE / 2) * scale, (WORLD_SIZE / 2) * scale, CENTER_RADIUS * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#a78bfa';
      for (const [, w] of state.wildlings) {
        ctx.beginPath();
        ctx.arc(w.position.x * scale, w.position.y * scale, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Boss is announced to everyone.
    if (state.boss) {
      ctx.fillStyle = '#d4a017';
      ctx.beginPath();
      ctx.arc(state.boss.position.x * scale, state.boss.position.y * scale, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Your squads.
    for (const g of state.groupsOf(state.playerId)) {
      ctx.fillStyle = STATUS_COLOR[g.status];
      ctx.beginPath();
      ctx.arc(g.anchor.x * scale, g.anchor.y * scale, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Your base.
    if (me?.alive) {
      const { x, y } = me.base.position;
      ctx.fillStyle = hexToCSS(me.color);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x * scale, y * scale, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
}
