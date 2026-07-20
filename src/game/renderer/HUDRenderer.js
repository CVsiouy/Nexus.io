import { LEVELS, WORLD_SIZE } from '../constants.js';
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

    this._prevNotifIds = new Set();
    this._prevLbHash   = '';
  }

  update(state) {
    const player = state.players.get(state.playerId);
    if (!player) return;

    this._updateLevelBar(state, player);
    this._updateLeaderboard(state);
    this._updateMinimap(state);
    this._updateNotifications(state);
    this._updateUnitPanel(state);
  }

  // ── Level Bar ────────────────────────────────────────────────────────────
  _updateLevelBar(state, player) {
    const base   = player.base;
    const level  = base.level;
    const xp     = Math.floor(base.xp);
    const nextLv = LEVELS.find(l => l.lv === level + 1);
    const xpNext = nextLv ? nextLv.xp : xp;
    const prevLv = LEVELS.find(l => l.lv === level);
    const xpPrev = prevLv ? prevLv.xp : 0;
    const xpPct  = xpNext > xpPrev
      ? Math.min(100, ((xp - xpPrev) / (xpNext - xpPrev)) * 100)
      : 100;

    this._lvl.textContent   = level;
    this._xpEl.textContent  = xp;
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

  // ── Minimap ───────────────────────────────────────────────────────────────
  _updateMinimap(state) {
    const ctx = this._mmCtx;
    const W   = this._mmCanvas.width;
    const H   = this._mmCanvas.height;
    const scale = W / WORLD_SIZE;

    ctx.fillStyle = '#08081a';
    ctx.fillRect(0, 0, W, H);

    // Node sites (unclaimed) — tiny dots
    ctx.fillStyle = 'rgba(100,100,150,0.3)';
    for (const [, node] of state.nodeSites) {
      if (node.status !== 'unclaimed') continue;
      ctx.fillRect(node.position.x * scale - 0.5, node.position.y * scale - 0.5, 1, 1);
    }

    // Links
    for (const [, link] of state.links) {
      if (link.hp <= 0) continue;
      const from   = state.resolve(link.fromId);
      const to     = state.resolve(link.toId);
      if (!from || !to) continue;
      const player = state.players.get(link.ownerId);
      if (!player) continue;
      ctx.strokeStyle = hexToCSS(player.color) + '99';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(from.position.x * scale, from.position.y * scale);
      ctx.lineTo(to.position.x   * scale, to.position.y   * scale);
      ctx.stroke();
    }

    // Claimed nodes
    for (const [, node] of state.nodeSites) {
      if (node.status !== 'claimed') continue;
      const player = state.players.get(node.ownerId);
      if (!player) continue;
      ctx.fillStyle = hexToCSS(player.color) + 'cc';
      ctx.beginPath();
      ctx.arc(node.position.x * scale, node.position.y * scale, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Bases
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const { x, y } = player.base.position;
      ctx.fillStyle   = hexToCSS(player.color);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.arc(x * scale, y * scale, player.id === state.playerId ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Viewport indicator
    // (skipped for simplicity — minimap is small enough to show full map)
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
