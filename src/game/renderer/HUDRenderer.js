import { LEVELS, WORLD_SIZE, SOLDIER_DEFS } from '../constants.js';
import { hexToCSS } from '../../utils/helpers.js';

/**
 * HUDRenderer
 * ───────────
 * Updates all DOM-based HUD elements:
 * • Level bar (XP, HP, stats)
 * • Leaderboard
 * • Minimap canvas
 * • Notifications
 * • Unit info panel
 */
export class HUDRenderer {
  constructor() {
    this._lvl       = document.getElementById('hud-lvl');
    this._xpEl      = document.getElementById('hud-xp');
    this._xpNext    = document.getElementById('hud-xp-next');
    this._xpBar     = document.getElementById('xp-fill');
    this._hpEl      = document.getElementById('hud-hp');
    this._maxHp     = document.getElementById('hud-maxhp');
    this._hpBar     = document.getElementById('hp-fill');
    this._nodesEl   = document.getElementById('hud-nodes');
    this._solsEl    = document.getElementById('hud-soldiers');
    this._specBadge = document.getElementById('hud-spec');

    this._lbEntries = document.getElementById('lb-entries');

    this._mmCanvas  = document.getElementById('minimap');
    this._mmCtx     = this._mmCanvas.getContext('2d');

    this._notifsEl  = document.getElementById('notifs');

    this._upPanel   = document.getElementById('unit-panel');
    this._upName    = document.getElementById('up-name');
    this._upHpFill  = document.getElementById('up-hp-fill');
    this._upStats   = document.getElementById('up-stats');

    this._buildBtns = [...document.querySelectorAll('#build-panel .unit-btn')];
    this._bpXp      = document.getElementById('bp-xp');
    this._bpPop     = document.getElementById('bp-pop');

    this._skPanel   = document.getElementById('skill-panel');
    this._skPts     = document.getElementById('sk-pts');
    this._skRows    = [...document.querySelectorAll('#skill-panel .sk-row')];
    this._skVals    = {
      atk: document.getElementById('sk-atk'),
      def: document.getElementById('sk-def'),
      spd: document.getElementById('sk-spd'),
    };

    this._prevNotifIds = new Set();
    this._prevLbHash   = '';
    this._prevBuildHash = '';
    this._prevSkillHash = '';
  }

  update(state, camera) {
    const player = state.players.get(state.playerId);
    if (!player) return;
    this._camRef = camera;

    this._updateLevelBar(state, player);
    this._updateLeaderboard(state);
    this._updateMinimap(state);
    this._updateNotifications(state);
    this._updateUnitPanel(state);
    this._updateBuildPanel(state, player);
    this._updateSkillPanel(state, player);
  }

  // ── Build Panel ────────────────────────────────────────────────────────────
  _updateBuildPanel(state, player) {
    const base = player.base;

    // Per-type queued totals (sum across queue entries of the same type).
    const queued = {};
    for (const e of base.spawnQueue) queued[e.type] = (queued[e.type] || 0) + e.count;

    const xp   = Math.floor(base.xp);
    const pop  = state.soldierPop(player.id);
    const cap  = state.popCap(player);

    // Cheap hash so we only touch the DOM when something changed.
    const hash = base.level + '|' + [...base.unlocked].sort().join(',') + '|' +
                 xp + '|' + pop + '/' + cap + '|' +
                 this._buildBtns.map(b => queued[b.dataset.unit] || 0).join(',');
    if (hash === this._prevBuildHash) return;
    this._prevBuildHash = hash;

    if (this._bpXp)  this._bpXp.textContent  = xp;
    if (this._bpPop) this._bpPop.textContent = `${pop}/${cap}`;

    for (const btn of this._buildBtns) {
      const unit   = btn.dataset.unit;
      const def    = SOLDIER_DEFS[unit];
      const reqLv  = parseInt(btn.dataset.lv, 10);
      const locked = !base.unlocked.has(unit);
      const count  = queued[unit] || 0;

      // Can't-afford = not enough XP for one, or no population room for one.
      const cantAfford = !locked && (xp < def.xpCost || pop + def.pop > cap);

      btn.classList.toggle('locked', locked);
      btn.classList.toggle('active', count > 0 && !locked);
      btn.classList.toggle('cant-afford', cantAfford && count === 0);

      const sub = btn.querySelector('.u-sub');
      if (sub) sub.textContent = locked ? `🔒 Lv ${reqLv}` : `Lv ${reqLv}`;

      const badge = btn.querySelector('.u-badge');
      if (badge) badge.textContent = count > 0 ? String(count) : '';
    }
  }

  // ── Skill / Buffs Panel ──────────────────────────────────────────────────
  _updateSkillPanel(state, player) {
    const base  = player.base;
    const buffs = player.buffs;
    const pts   = base.skillPoints;

    const hash = `${pts}|${buffs.atk},${buffs.def},${buffs.spd}`;
    if (hash === this._prevSkillHash) return;
    this._prevSkillHash = hash;

    if (this._skPts) this._skPts.textContent = pts;
    if (this._skPanel) this._skPanel.classList.toggle('has-pts', pts > 0);

    this._skVals.atk.textContent = `+${buffs.atk * 10}%`;
    this._skVals.def.textContent = `+${buffs.def * 10}%`;
    this._skVals.spd.textContent = `+${buffs.spd * 10}%`;

    // Rows become clickable (spendable) only when points are available.
    for (const row of this._skRows) row.classList.toggle('spendable', pts > 0);
  }

  // ── Level Bar ────────────────────────────────────────────────────────────
  _updateLevelBar(state, player) {
    const base   = player.base;
    const level  = base.level;
    // Level progress uses LIFETIME earned XP (spending on soldiers must not
    // shrink the level bar). Spendable XP is shown separately in the build bar.
    const xpEarned = Math.floor(base.xpEarned);
    const nextLv = LEVELS.find(l => l.lv === level + 1);
    const xpNext = nextLv ? nextLv.xp : xpEarned;
    const prevLv = LEVELS.find(l => l.lv === level);
    const xpPrev = prevLv ? prevLv.xp : 0;
    const xpPct  = xpNext > xpPrev
      ? Math.min(100, ((xpEarned - xpPrev) / (xpNext - xpPrev)) * 100)
      : 100;

    this._lvl.textContent   = level;
    this._xpEl.textContent  = xpEarned;
    this._xpNext.textContent = xpNext;
    this._xpBar.style.width = xpPct + '%';

    const hp    = Math.ceil(base.hp);
    const maxHp = base.maxHp;
    this._hpEl.textContent   = hp;
    this._maxHp.textContent  = maxHp;
    this._hpBar.style.width  = (hp / maxHp * 100) + '%';

    this._nodesEl.textContent = state.nodeCount(state.playerId);
    this._solsEl.textContent  = state.soldierCount(state.playerId);

    if (base.specialization) {
      this._specBadge.textContent = base.specialization.toUpperCase();
      this._specBadge.style.display = 'inline-block';
    }
  }

  // ── Leaderboard ──────────────────────────────────────────────────────────
  _updateLeaderboard(state) {
    const entries = [];
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      entries.push({
        id:     player.id,
        isMe:   player.id === state.playerId,
        color:  player.color,
        name:   player.id === state.playerId ? 'YOU' : player.id.replace('bot_', 'Bot '),
        score:  state.nodeCount(player.id) + player.base.level * 3,
        nodes:  state.nodeCount(player.id),
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
        <span class="lb-score">${e.nodes}n</span>
      </div>
    `).join('');
  }

  // ── Minimap (YOUR stuff only) ──────────────────────────────────────────────
  // Shows only the player's base, own nodes/links, and formations — the main
  // viewport is limited, so this is the player's orientation aid for THEIR
  // network. Click base/formation dots to switch the active view.
  _updateMinimap(state) {
    const ctx = this._mmCtx;
    const W   = this._mmCanvas.width;
    const H   = this._mmCanvas.height;
    const scale = W / WORLD_SIZE;
    const pid = state.playerId;
    const me  = state.players.get(pid);

    ctx.fillStyle = '#08081a';
    ctx.fillRect(0, 0, W, H);
    if (!me) return;
    const col = hexToCSS(me.color);

    // Own links
    ctx.strokeStyle = col + 'aa'; ctx.lineWidth = 1;
    for (const [, link] of state.links) {
      if (link.hp <= 0 || link.ownerId !== pid) continue;
      const from = state.resolve(link.fromId), to = state.resolve(link.toId);
      if (!from || !to) continue;
      ctx.beginPath();
      ctx.moveTo(from.position.x * scale, from.position.y * scale);
      ctx.lineTo(to.position.x   * scale, to.position.y   * scale);
      ctx.stroke();
    }

    // Own claimed nodes
    ctx.fillStyle = col + 'cc';
    for (const [, node] of state.nodeSites) {
      if (node.status !== 'claimed' || node.ownerId !== pid) continue;
      ctx.beginPath();
      ctx.arc(node.position.x * scale, node.position.y * scale, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Formations (small squares); active one ringed white
    if (state.formations) {
      for (const [, f] of state.formations) {
        if (f.ownerId !== pid || f.memberIds.size === 0) continue;
        const fx = f.center.x * scale, fy = f.center.y * scale;
        ctx.fillStyle = col;
        ctx.fillRect(fx - 3, fy - 3, 6, 6);
        if (f.id === state.activeFormationId) {
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
          ctx.strokeRect(fx - 4, fy - 4, 8, 8);
        }
      }
    }

    // Base — bigger dot; red ping ring if recently attacked
    const bx = me.base.position.x * scale, by = me.base.position.y * scale;
    const attacked = this._baseHpPrev !== undefined && me.base.hp < this._baseHpPrev - 0.5;
    this._baseHpPrev = me.base.hp;
    if (attacked) this._basePingUntil = state.time + 1500;
    if (this._basePingUntil && state.time < this._basePingUntil) {
      const p = (Math.sin(state.time / 90) * 0.5 + 0.5);
      ctx.strokeStyle = `rgba(255,60,60,${0.4 + 0.5 * p})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(bx, by, 7 + p * 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = col; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

    // Highlight where the viewport currently is (a hollow box).
    const cam = this._camRef;
    if (cam) {
      const halfW = (cam.width  / 2 / cam.zoom) * scale;
      const halfH = (cam.height / 2 / cam.zoom) * scale;
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
      ctx.strokeRect(cam.x * scale - halfW, cam.y * scale - halfH, halfW * 2, halfH * 2);
    }
  }

  // ── Notifications ─────────────────────────────────────────────────────────
  _updateNotifications(state) {
    const now    = state.time;
    const active = state._notifs.filter(n => n.expires > now);
    state._notifs = active;

    const rendered = new Set(
      [...this._notifsEl.querySelectorAll('.notif')].map(el => el.dataset.id)
    );

    // Remove expired
    for (const el of this._notifsEl.querySelectorAll('.notif')) {
      if (!active.find(n => n.id === el.dataset.id)) el.remove();
    }

    // Add new
    for (const notif of active) {
      if (rendered.has(notif.id)) continue;
      const el = document.createElement('div');
      el.className    = `notif ${notif.type}`;
      el.dataset.id   = notif.id;
      el.textContent  = notif.msg;
      this._notifsEl.prepend(el);
      setTimeout(() => el.remove(), 4500);
    }
  }

  // ── Unit Panel ────────────────────────────────────────────────────────────
  _updateUnitPanel(state) {
    const selected = [];
    for (const [, sol] of state.soldiers) {
      if (sol.ownerId === state.playerId && sol.selected) selected.push(sol);
    }

    if (selected.length === 0) {
      this._upPanel.classList.remove('vis');
      return;
    }

    this._upPanel.classList.add('vis');

    if (selected.length === 1) {
      const sol = selected[0];
      this._upName.textContent = sol.type.toUpperCase();
      const hpR = sol.hp / sol.maxHp;
      this._upHpFill.style.width = (hpR * 100) + '%';
      this._upHpFill.style.background = hpR > 0.5 ? '#4ade80' : hpR > 0.25 ? '#fbbf24' : '#f87171';
      this._upStats.textContent = `HP: ${Math.ceil(sol.hp)}/${sol.maxHp} · DMG: ${sol.damage} · Order: ${sol.order.kind}`;
    } else {
      this._upName.textContent = `${selected.length} UNITS SELECTED`;
      const avgHp = selected.reduce((a, s) => a + s.hp / s.maxHp, 0) / selected.length;
      this._upHpFill.style.width = (avgHp * 100) + '%';
      const types = [...new Set(selected.map(s => s.type))].join(', ');
      this._upStats.textContent = `Types: ${types}`;
    }
  }
}
