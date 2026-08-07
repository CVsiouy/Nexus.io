import {
  LEVELS, WORLD_SIZE, SOLDIER_DEFS, TURRET_DEFS,
  hexToCSS, goldRate, mineUpgradeCost,
} from '@nexus/sim';
import { MATCH_LIMIT_MS } from '@nexus/protocol';

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
    this._bpGarrison = document.getElementById('bp-garrison');
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

  /**
   * @param {object} state      WorldView
   * @param {object} selection  Selection — this player's highlighted squads
   * @param {object} [net]      { online, ping } — connection info, online only
   */
  update(state, selection, net) {
    this._updateMatchBar(state, net);

    const player = state.players.get(state.playerId);
    if (!player) return;
    this._selection = selection;
    this._updateBasePanel(state, player);
    this._updateBaseAlert(state, player);
    this._updateGroupPanel(state, player);
    this._updateLeaderboard(state);
    this._updateMinimap(state);
    this._updateBuildPanel(state, player);
    this._updateSkillPanel(state, player);
  }

  /**
   * Time left in the match, and how good the connection is.
   *
   * The clock counts SIMULATION time, the same clock the server uses to decide
   * when the match ends — so the number on screen can never disagree with the
   * actual deadline.
   */
  _updateMatchBar(state, net) {
    if (!this._matchBar) {
      this._matchBar = document.getElementById('match-bar');
      this._matchClock = document.getElementById('match-clock');
      this._matchPing = document.getElementById('match-ping');
    }
    if (!this._matchBar || !net?.online) return;
    this._matchBar.classList.add('vis');

    const leftMs = Math.max(0, MATCH_LIMIT_MS - state.time);
    const total = Math.ceil(leftMs / 1000);
    const mm = Math.floor(total / 60);
    const ss = String(total % 60).padStart(2, '0');
    const label = `${mm}:${ss}`;
    if (label !== this._prevClock) {
      this._prevClock = label;
      this._matchClock.textContent = label;
      this._matchClock.classList.toggle('urgent', leftMs < 60_000);
    }

    // Round to 10ms so the display isn't jittering every frame.
    const ping = Math.round((net.ping ?? 0) / 10) * 10;
    if (ping !== this._prevPing) {
      this._prevPing = ping;
      this._matchPing.textContent = `${ping}ms`;
      this._matchPing.className =
        ping < 90 ? 'ping-good' : ping < 200 ? 'ping-ok' : 'ping-bad';
    }
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
    if (this._goldRate) {
      let rate = goldRate(base);                       // passive mother-base mining
      if (state.mode === 'mining') {                    // + every captured node's income
        for (const [, n] of state.mineNodes) if (n.ownerId === player.id) rate += n.goldRate;
      }
      this._goldRate.textContent = `+${Math.round(rate)}/s`;
    }

    if (base.specialization) {
      this._specBadge.textContent = base.specialization.toUpperCase();
      this._specBadge.style.display = 'inline-block';
    }
  }

  // ── Group panel (left) ──────────────────────────────────────────────────────
  _updateGroupPanel(state, player) {
    const groups = state.groupsOf(player.id);
    const isSel = (g) => !!this._selection?.has(g.id);
    const hash = groups.map(g => `${g.id}:${g.memberIds.length}:${g.status}:${isSel(g) ? 1 : 0}:${g.locked ? 1 : 0}`).join('|');
    if (hash === this._prevGroupHash) return;
    this._prevGroupHash = hash;

    if (groups.length === 0) {
      this._groupList.innerHTML = '<div class="group-empty">No squads yet</div>';
      return;
    }

    this._groupList.innerHTML = groups.map(g => {
      const ready = g.memberIds.length >= 15 && !g.locked;
      return `
      <div class="group-entry ${isSel(g) ? 'sel' : ''} ${g.locked ? 'locked' : ''} ${ready ? 'ready' : ''}" data-id="${g.id}">
        <span class="g-count">${g.memberIds.length}/15</span>
        <span class="g-status" style="color:${STATUS_COLOR[g.status]}">${g.locked ? 'ATTACKING 🔒' : ready ? 'READY ▶' : STATUS_LABEL[g.status]}</span>
      </div>`;
    }).join('');

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

    const hash = base.level + '|' + gold + '|' + pop + '/' + cap + '|' + base.mineLevel + '|' + base.garrison + '|' +
      this._buildBtns.map(b => queued[b.dataset.unit] || 0).join(',') + '|' +
      this._turretBtns.map(b => turretQ[b.dataset.turret] || 0).join(',');
    if (hash === this._prevBuildHash) return;
    this._prevBuildHash = hash;

    if (this._bpGold) this._bpGold.textContent = gold;
    if (this._bpPop)  this._bpPop.textContent  = `${pop}/${cap}`;
    if (this._bpGarrison) this._bpGarrison.textContent = `${base.garrison}/15`;

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
        // Real player names now, not "Bot 3" — the simulation carries a name
        // per seat, set when a human claims it.
        name: player.id === state.playerId ? 'YOU' : (player.name ?? player.id),
        score: Math.floor(player.base.xpEarned), // rank by XP earned
      });
    }
    entries.sort((a, b) => b.score - a.score);
    const hash = entries.map(e => e.id + e.score).join(',');
    if (hash === this._prevLbHash) return;
    this._prevLbHash = hash;

    const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    this._lbEntries.innerHTML = entries.slice(0, 10).map((e, i) => `
      <div class="lb-entry ${e.isMe ? 'is-player' : ''}">
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-dot" style="background:${hexToCSS(e.color)}"></span>
        <span class="lb-name">${e.name}</span>
        <span class="lb-score">${fmt(e.score)} XP</span>
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

    // Mining nodes (owner-coloured, grey if neutral).
    for (const [, node] of state.mineNodes) {
      const owner = node.ownerId ? state.players.get(node.ownerId) : null;
      ctx.fillStyle = owner ? hexToCSS(owner.color) : '#9aa5b1';
      ctx.beginPath();
      ctx.arc(node.position.x * scale, node.position.y * scale, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Boss is announced to everyone.
    // Bosses are announced to everyone — they are the contested objective.
    for (const [, boss] of state.bosses) {
      ctx.fillStyle = '#d4a017';
      ctx.beginPath();
      ctx.arc(boss.position.x * scale, boss.position.y * scale, 3.5, 0, Math.PI * 2);
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
