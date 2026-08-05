import * as PIXI from 'pixi.js';

import { WORLD_SIZE } from '@nexus/sim';
import { WorkerConnection, WebSocketConnection } from './net/Connection.js';

/**
 * Where the backend lives. Set by docker-compose in development; in production
 * this becomes a real address like wss://eu1.nexus.io — the frontend is served
 * from a CDN and the backend from game machines, so this is genuinely a
 * different host, not just a different port.
 */
const SERVER_URL = import.meta.env?.VITE_SERVER_URL ?? 'ws://localhost:2567';
import { WorldView } from './net/WorldView.js';
import { Selection } from './Selection.js';
import { InputSystem } from './input/InputSystem.js';
import { GameRenderer } from './renderer/GameRenderer.js';
import { HUDRenderer } from './renderer/HUDRenderer.js';

/**
 * Game — the client.
 * ─────────────────
 *
 * WHAT CHANGED IN PHASE 0
 *
 * This class used to BE the game: it owned the state, ran all seven systems
 * every frame, and let the HUD reach in and change gold directly.
 *
 * Now it owns none of that. The simulation runs somewhere else — today a Web
 * Worker, in Phase 1 a server — and this class does exactly three things:
 *
 *   1. draws whatever the latest snapshot says
 *   2. sends the player's orders as commands
 *   3. manages purely local things: camera, selection, which panels are open
 *
 * The two loops are now separate and run at different rates:
 *
 *   simulation   20 times/second, in the worker, in fixed 50ms steps
 *   rendering    60 times/second, here, interpolating between snapshots
 */
export class Game {
  constructor() {
    this._app = null;
    this._camera = null;
    this._renderer = null;
    this._hud = null;
    this._input = null;
    this._conn = null;
    this._world = null;
    this._selection = null;
    this._running = false;
    this._gameOver = false;
    this._paused = false;
    this._mode = 'ffa';
    this._online = false;
    this._spectating = false;
    this._name = 'Player';
    /** Live map pings, drawn for ~2s then dropped. */
    this._pings = [];
  }

  async init() {
    this._app = new PIXI.Application({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0xf4f4f4,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    });
    document.getElementById('app').appendChild(this._app.view);

    this._camera = {
      x: WORLD_SIZE / 2,
      y: WORLD_SIZE / 2,
      zoom: 1,
      width: window.innerWidth,
      height: window.innerHeight,
      focusType: 'free',
      focusId: null,
    };

    this._world = new WorldView();
    this._selection = new Selection();
    this._renderer = new GameRenderer(this._app);
    this._hud = new HUDRenderer();

    this._input = new InputSystem(
      this._app, this._camera, this._world, this._selection,
      (cmd) => this._send(cmd),
    );

    this._wireUI();

    window.addEventListener('resize', () => {
      this._app.renderer.resize(window.innerWidth, window.innerHeight);
      this._camera.width = window.innerWidth;
      this._camera.height = window.innerHeight;
      this._camera.zoom = (this._camera.width / WORLD_SIZE) * 0.98;
    });
  }

  // ── Sending orders ─────────────────────────────────────────────────────────

  /** Every player action funnels through here. Nothing else changes the game. */
  _send(cmd) {
    if (this._gameOver) return;
    this._conn?.send(cmd);
  }

  /**
   * Attach handlers to whichever connection we ended up with. Identical for
   * practice and online — that symmetry is the reason this refactor was worth
   * doing, and the reason a bug can't exist in one mode but not the other.
   */
  _bindConnection() {
    const conn = this._conn;

    // Which of the eight bases is mine. The server sends ONE snapshot to all
    // eight players, so this cannot come from the snapshot — it arrives once,
    // here, on joining.
    conn.onWelcome((msg) => {
      this._world.setLocalId(msg.youAre);
      this._seat = msg.seat;
      this._matchId = msg.matchId ?? null;
      console.info(`[nexus] you are ${msg.youAre} (seat ${msg.seat + 1}) in a ${msg.mode} match`);
    });

    conn.onSnapshot((snap, sentAt) => this._world.ingest(snap, sentAt));
    conn.onEvents((events) => this._handleEvents(events));

    conn.onRejected((reason, cmd) => {
      // An order can be refused for perfectly ordinary reasons — not enough
      // gold, squad not yet 15 strong. Online it is also where "the server
      // disagreed with you" surfaces, which is the system working correctly.
      console.debug('[order refused]', cmd?.t, '—', reason);
    });

    // Online, the SERVER decides when the match is over — never the client.
    conn.onRoundEnd((result) => this._showRoundEnd(result));

    conn.onStatus((state, detail) => this._setConnectionStatus(state, detail));
  }

  _wireUI() {
    // Specialization choice
    document.querySelectorAll('.spec-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._send({ t: 'spec', choice: btn.dataset.spec });
        document.getElementById('spec-modal').classList.remove('vis');
        this._setPaused(false);
      });
    });

    // Build panel — soldiers (left-click queues, right-click removes)
    document.querySelectorAll('#build-panel .unit-btn').forEach(btn => {
      const unit = btn.dataset.unit;
      btn.addEventListener('click', () => this._send({ t: 'queue', unit, n: 1 }));
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        this._send({ t: 'queue', unit, n: -1 });
      });
    });

    // Build panel — turrets
    document.querySelectorAll('#build-panel .turret-btn').forEach(btn => {
      btn.addEventListener('click', () => this._send({ t: 'turret', kind: btn.dataset.turret }));
    });

    // Mining upgrade
    this._wireBtn('mine-btn', () => this._send({ t: 'mine' }));

    // Skill points
    document.querySelectorAll('#skill-panel .sk-row').forEach(row => {
      row.addEventListener('click', () => this._send({ t: 'skill', stat: row.dataset.buff }));
    });

    // Squad commands
    this._wireBtn('cmd-defend',  () => this._input.doDefend());
    this._wireBtn('cmd-base',    () => this._input.focusBase());
    this._wireBtn('cmd-release', () => this._send({ t: 'release' }));

    // Clicking a squad in the left panel focuses it. DOM dataset values are
    // always strings, and squad ids are numbers now — hence the Number().
    this._hud.onGroupClick = (id) => {
      const g = this._world.groups.get(Number(id));
      if (g) this._input.focusGroup(g);
    };

    document.getElementById('menu-btn').addEventListener('click', () => this.togglePause());
    document.getElementById('resume-btn').addEventListener('click', () => this.togglePause(false));
    document.getElementById('exit-btn').addEventListener('click', () => this._exit());
    document.getElementById('go-exit-btn').addEventListener('click', () => this._exit());
    document.getElementById('restart-btn').addEventListener('click', () => this._requeue());

    window.addEventListener('keydown', e => {
      if (!this._running || this._gameOver) return;
      if (e.code === 'Escape') {
        const specOpen = document.getElementById('spec-modal').classList.contains('vis');
        if (!specOpen) this.togglePause();
      }
      if (e.code === 'KeyR') this._send({ t: 'release' });
    });
  }

  _wireBtn(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  // ── Match lifecycle ────────────────────────────────────────────────────────

  /**
   * @param {string} mode   'ffa' | 'team' | 'mining'
   * @param {object} [opts]
   * @param {boolean} [opts.online]  true = play against real people on the
   *                                 server; false = practice against bots,
   *                                 simulated locally at zero server cost.
   * @param {string}  [opts.name]    display name shown to other players
   */
  async startMatch(mode = 'ffa', { online = false, name = 'Player' } = {}) {
    this._mode = mode;
    this._online = online;
    this._name = name;   // kept so "Play Again" can rejoin without asking again

    // The ONLY line that differs between single-player and multiplayer.
    this._conn = online ? new WebSocketConnection(SERVER_URL, name) : new WorkerConnection();
    this._bindConnection();

    const started = await this._conn.start(mode);
    if (!started) {
      // Couldn't reach the server. Say so, rather than dropping the player into
      // a world that will silently never update.
      this._conn = null;
      this.onConnectionFailed?.(this._lastConnError ?? 'unreachable');
      return false;
    }

    // Pausing stops time for everyone, which is not a thing you can offer in a
    // match seven other people are also playing.
    const menuBtn = document.getElementById('menu-btn');
    if (menuBtn && online) menuBtn.style.display = 'none';

    const cam = this._camera;
    cam.focusType = 'free';
    cam.focusId = null;
    cam.x = WORLD_SIZE / 2;
    cam.y = WORLD_SIZE / 2;
    cam.zoom = (cam.width / WORLD_SIZE) * 0.98;

    this._running = true;
    this._app.ticker.add(() => this._frame());
    return true;
  }

  /**
   * One drawn frame. Note what is NOT here any more: no system updates, no
   * combat, no gold. Drawing and simulating are now completely separate.
   */
  _frame() {
    if (!this._running) return;

    const dt = Math.min(this._app.ticker.elapsedMS, 50) / 1000;
    const world = this._world;

    // Rebuild the visible world for "now minus a little", smoothly.
    world.sample(performance.now());
    if (!world.ready) return;

    this._input.update(dt);
    this._updateCamera();

    // Drop pings that have finished animating.
    if (this._pings.length) {
      const now = performance.now();
      this._pings = this._pings.filter(p => now - p.at < 2000);
    }

    this._renderer.render(world, this._camera, this._selection, this._input.pendingOrders, this._pings);
    this._hud.update(world, this._selection, {
      online: this._online,
      ping: this._conn?.ping ?? 0,
    });

    this._checkGameOver();
  }

  _updateCamera() {
    const cam = this._camera;
    if (cam.focusType === 'free') return;

    let target = null;
    if (cam.focusType === 'group' && cam.focusId != null) {
      const g = this._world.groups.get(cam.focusId);
      if (g) target = g.anchor;
      else { cam.focusType = 'base'; cam.focusId = null; }
    }
    if (!target) {
      const base = this._world.getPlayerBase(this._world.playerId);
      if (base) target = base.position;
    }
    if (target) {
      cam.x += (target.x - cam.x) * 0.12;
      cam.y += (target.y - cam.y) * 0.12;
    }
  }

  // ── Events from the simulation ─────────────────────────────────────────────

  _handleEvents(events) {
    for (const ev of events) {
      switch (ev.type) {
        case 'explosion':
          this._renderer.addParticle(ev.data.x, ev.data.y, ev.data.color ?? 0xef4444, 10);
          break;
        case 'soldierDied':
          // A small puff so deaths read at a glance. Previously the renderer
          // never knew a soldier had died — it just stopped being drawn.
          this._renderer.addParticle(ev.data.x, ev.data.y, 0x999999, 4);
          break;
        case 'specReady':
          // Eight players share one event stream, so check it's actually mine
          // before opening a modal.
          if (ev.data.ownerId === this._world.playerId) this._showSpecModal();
          break;

        case 'ping': {
          // In team mode a ping is only for your own side — otherwise you'd be
          // telling your enemies exactly where you plan to attack.
          const myTeam = this._world.teamOf(this._world.playerId);
          const mine = ev.data.ownerId === this._world.playerId;
          if (myTeam && ev.data.team && ev.data.team !== myTeam && !mine) break;
          this._pings.push({ ...ev.data, at: performance.now() });
          break;
        }
        case 'simError':
          console.error('[sim] tick error at', ev.data.tick, '—', ev.data.message);
          break;
      }
    }
  }

  _showSpecModal() {
    this._setPaused(true);
    document.getElementById('spec-modal').classList.add('vis');
  }

  /** The server's verdict on a finished online match. Authoritative. */
  _showRoundEnd(result) {
    if (this._gameOver) return;
    this._gameOver = true;
    this._input.setEnabled(false);

    document.getElementById('spectate-banner')?.classList.remove('vis');
    document.getElementById('spectate-tag')?.classList.remove('vis');

    const won = result.winner === this._world.playerId;
    const title = document.getElementById('go-title');
    title.textContent = won ? 'VICTORY' : 'MATCH OVER';
    title.className = won ? 'win' : 'lose';

    const top = result.standings?.[0];
    document.getElementById('go-sub').textContent = won
      ? (result.reason === 'timeLimit' ? 'Time ran out and you led on XP.' : 'You outlasted every rival.')
      : (result.reason === 'timeLimit'
          ? `Time ran out. ${top?.name ?? 'Someone else'} led on XP.`
          : `${top?.name ?? 'Another player'} took the match.`);

    this._renderStandings(result.standings ?? [], result.winner);
    this._showFeedback(won);
    document.getElementById('gameover').classList.add('vis');
  }

  /**
   * Ask the player how the match went.
   *
   * Playtest feedback is worth far more when it arrives while the match is still
   * fresh, so it lives on the scoreboard rather than in a form somewhere else.
   * Anonymous, one tap, and the answer carries context (did they win, how long
   * did they last, what was their ping) so a complaint can be read fairly —
   * "boring" from someone eliminated at minute three means something different
   * from "boring" from the winner.
   */
  _showFeedback(won) {
    const panel = document.getElementById('feedback');
    if (!panel || this._feedbackWired) { panel?.classList.add('vis'); return; }
    this._feedbackWired = true;

    let rating = 0;
    const stars = [...panel.querySelectorAll('.fb-star')];
    const sendBtn = document.getElementById('fb-send');

    for (const star of stars) {
      star.addEventListener('click', () => {
        rating = Number(star.dataset.rating);
        for (const s of stars) s.classList.toggle('sel', Number(s.dataset.rating) <= rating);
      });
    }

    sendBtn?.addEventListener('click', async () => {
      if (!rating) {
        // Nudge rather than block — a rating with no comment is still useful.
        stars.forEach(s => s.classList.add('sel'));
        setTimeout(() => stars.forEach(s => s.classList.remove('sel')), 180);
        return;
      }
      sendBtn.disabled = true;

      const me = this._world.players.get(this._world.playerId);
      const body = {
        matchId: this._matchId ?? null,
        rating,
        comment: document.getElementById('fb-comment')?.value ?? '',
        context: {
          won: !!won,
          survivedMs: me?.alive ? this._world.time : (this._eliminatedAt ?? null),
          ping: Math.round(this._conn?.ping ?? 0),
        },
      };

      try {
        // The backend is on a different domain, so this is a cross-origin POST —
        // the server allows it only from the approved frontend.
        await fetch(`${SERVER_URL.replace(/^ws/, 'http')}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Never let a failed submission spoil the moment; it is not important
        // enough to show the player an error.
        console.debug('[nexus] feedback not sent:', err);
      }
      panel.classList.add('sent');
    });

    panel.classList.add('vis');
  }

  /** Final scoreboard: who finished where, and how much XP they earned. */
  _renderStandings(standings, winnerId) {
    const el = document.getElementById('go-standings');
    if (!el) return;

    const colourOf = (id) => {
      const p = this._world.players.get(id);
      return p ? `#${(p.color ?? 0x888888).toString(16).padStart(6, '0')}` : '#888';
    };
    const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

    el.innerHTML = standings.map((s, i) => `
      <div class="go-row ${s.id === this._world.playerId ? 'me' : ''} ${s.alive ? '' : 'dead'}">
        <span class="r-rank">${s.id === winnerId ? '👑' : `#${i + 1}`}</span>
        <span class="r-dot" style="background:${colourOf(s.id)}"></span>
        <span class="r-name">${escapeHtml(s.name)}${s.id === this._world.playerId ? ' (you)' : ''}</span>
        <span class="r-xp">${fmt(s.xp)} XP</span>
      </div>`).join('');
    el.classList.add('vis');
  }

  /**
   * Play again without reloading the page: drop the old match, build a fresh
   * world, and join a new one. A reload would work too, but it throws away the
   * loaded game and shows a blank screen — and the whole point of Phase 2 is
   * that a player never waits.
   */
  async _requeue() {
    if (!this._online) { location.reload(); return; }

    this._conn?.close();

    for (const id of ['gameover', 'spectate-banner', 'spectate-tag', 'go-standings', 'pause-modal', 'spec-modal', 'feedback']) {
      document.getElementById(id)?.classList.remove('vis');
    }
    // Let them rate the next match too.
    const fb = document.getElementById('feedback');
    fb?.classList.remove('sent');
    fb?.querySelectorAll('.fb-star').forEach(s => s.classList.remove('sel'));
    const fbSend = document.getElementById('fb-send');
    if (fbSend) fbSend.disabled = false;
    const fbComment = document.getElementById('fb-comment');
    if (fbComment) fbComment.value = '';
    this._eliminatedAt = null;

    // A brand-new world and selection — stale entity ids from the last match
    // must never leak into the next one.
    this._world = new WorldView();
    this._selection = new Selection();
    this._pings = [];
    this._input.rebind(this._world, this._selection);
    this._input.setEnabled(true);
    this._gameOver = false;
    this._spectating = false;
    this._lastConnError = null;

    this._conn = new WebSocketConnection(SERVER_URL, this._name);
    this._bindConnection();

    const ok = await this._conn.start(this._mode);
    if (!ok) this._setConnectionStatus('error', this._lastConnError ?? 'unreachable');
  }

  /** Surface connection trouble instead of silently freezing. */
  _setConnectionStatus(state, detail) {
    if (state === 'error' || state === 'disconnected') {
      this._lastConnError = detail;
      console.error('[nexus] connection', state, detail ?? '');
      // Failing before the match started is handled by startMatch's return
      // value, which puts the message on the intro screen.
      if (!this._running) return;
      const sub = document.getElementById('go-sub');
      const title = document.getElementById('go-title');
      if (title && !this._gameOver) {
        this._gameOver = true;
        this._input?.setEnabled(false);
        title.textContent = 'DISCONNECTED';
        title.className = 'lose';
        if (sub) sub.textContent = detail ? `Lost contact with the server (${detail}).` : 'Lost contact with the server.';
        document.getElementById('gameover').classList.add('vis');
      }
    } else {
      console.info('[nexus] connection', state);
    }
  }

  /**
   * Your base fell, but the match hasn't. Keep watching rather than ejecting
   * the player — losing your base at minute 4 shouldn't mean staring at a
   * modal for sixteen minutes, and the whole-map camera means spectating costs
   * us nothing to build: we simply stop accepting orders.
   */
  _checkSpectate() {
    if (this._spectating || this._gameOver) return;
    const me = this._world.players.get(this._world.playerId);
    if (!me || me.alive) return;

    this._spectating = true;
    this._eliminatedAt = this._world.time;   // for feedback context
    this._input.setEnabled(false);
    this._input.focusFree();
    this._selection.clear();
    document.getElementById('spectate-banner')?.classList.add('vis');
    document.getElementById('spectate-tag')?.classList.add('vis');
  }

  _checkGameOver() {
    // Online, the server decides when the match ends — see _showRoundEnd.
    // Deciding it locally too would mean two authorities that can disagree,
    // which is exactly the class of bug server authority exists to prevent.
    if (this._online) { this._checkSpectate(); return; }

    if (this._gameOver) return;
    const world = this._world;
    const me = world.players.get(world.playerId);
    if (!me) return;

    let over = false, won = false;
    if (this._mode === 'team') {
      const teams = world.aliveTeams();
      if (teams.length <= 1) {
        over = true;
        won = me.alive || (teams[0] && teams[0] === world.teamOf(world.playerId));
      }
    } else {
      const aliveCount = [...world.players.values()].filter(p => p.alive).length;
      if (aliveCount <= 1) { over = true; won = !!me.alive; }
    }
    if (!over) return;

    this._gameOver = true;
    this._input.setEnabled(false);

    const goTitle = document.getElementById('go-title');
    const goSub = document.getElementById('go-sub');
    if (won) {
      goTitle.textContent = 'VICTORY';
      goTitle.className = 'win';
      goSub.textContent = this._mode === 'team'
        ? 'Your team wiped out the enemy team.'
        : 'You destroyed every rival mother base.';
    } else {
      goTitle.textContent = 'ELIMINATED';
      goTitle.className = 'lose';
      goSub.textContent = 'Your mother base was destroyed. Better luck next time.';
    }
    document.getElementById('gameover').classList.add('vis');
  }

  // ── Pause ──────────────────────────────────────────────────────────────────
  // Practice mode only. You cannot pause a match seven other people are also
  // playing, so the online client simply won't offer this.

  togglePause(force) {
    if (this._gameOver) return;
    this._setPaused(force === undefined ? !this._paused : force);
    document.getElementById('pause-modal').classList.toggle('vis', this._paused);
    const btn = document.getElementById('menu-btn');
    if (btn) btn.textContent = this._paused ? '▶ RESUME' : '⏸ MENU';
  }

  _setPaused(v) {
    this._paused = v;
    this._conn.setPaused(v);
    this._input.setEnabled(!v);
  }

  _exit() {
    this._conn?.close();
    location.reload();
  }
}

/**
 * Player names come from other people and are injected into HTML, so they must
 * be escaped. Without this, someone calling themselves `<img onerror=…>` runs
 * script in every other player's browser.
 */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
