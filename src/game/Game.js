import * as PIXI from 'pixi.js';

import { GameState }           from './GameState.js';
import { buildWorld }          from './World.js';
import { ConnectivitySystem }  from './systems/ConnectivitySystem.js';
import { CombatSystem }        from './systems/CombatSystem.js';
import { ProductionSystem }    from './systems/ProductionSystem.js';
import { InputSystem }         from './systems/InputSystem.js';
import { AISystem }            from './systems/AISystem.js';
import { ProgressionSystem }   from './systems/ProgressionSystem.js';
import { GameRenderer }        from './renderer/GameRenderer.js';
import { HUDRenderer }         from './renderer/HUDRenderer.js';
import { DEF_ZOOM, WORLD_SIZE } from './constants.js';

export class Game {
  constructor() {
    this._app       = null;
    this._state     = null;
    this._camera    = null;
    this._systems   = {};
    this._renderer  = null;
    this._hud       = null;
    this._input     = null;
    this._running   = false;
    this._gameOver  = false;
  }

  async init() {
    // ── PixiJS Application ────────────────────────────────────────────────
    this._app = new PIXI.Application({
      width:           window.innerWidth,
      height:          window.innerHeight,
      backgroundColor: 0x06060f,
      antialias:       true,
      resolution:      Math.min(window.devicePixelRatio || 1, 2),
      autoDensity:     true,
    });
    document.getElementById('app').appendChild(this._app.view);

    // ── Camera ────────────────────────────────────────────────────────────
    this._camera = {
      x:      WORLD_SIZE / 2,
      y:      WORLD_SIZE / 2,
      zoom:   DEF_ZOOM,
      width:  window.innerWidth,
      height: window.innerHeight,
      follow: true,
    };

    // ── State ─────────────────────────────────────────────────────────────
    this._state = new GameState('player');

    // ── World Generation ──────────────────────────────────────────────────
    buildWorld(this._state);

    // ── Renderers ─────────────────────────────────────────────────────────
    this._renderer = new GameRenderer(this._app);
    this._hud      = new HUDRenderer();

    // ── Systems ───────────────────────────────────────────────────────────
    const conn   = new ConnectivitySystem();
    const combat = new CombatSystem(conn);
    const prod   = new ProductionSystem();
    const ai     = new AISystem();
    const prog   = new ProgressionSystem();
    const input  = new InputSystem(this._app, this._renderer.worldContainer, this._camera, this._state);

    this._systems = { conn, combat, prod, ai, prog };
    this._input   = input;

    // Specialization modal callback
    prog.onSpecReady = () => this._showSpecModal();

    // ── Specialization buttons ────────────────────────────────────────────
    document.querySelectorAll('.spec-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const spec = btn.dataset.spec;
        const player = this._state.players.get('player');
        if (player) prog.applySpecialization(this._state, player, spec);
        document.getElementById('spec-modal').classList.remove('vis');
      });
    });

    // ── Window resize ─────────────────────────────────────────────────────
    window.addEventListener('resize', () => {
      this._app.renderer.resize(window.innerWidth, window.innerHeight);
      this._camera.width  = window.innerWidth;
      this._camera.height = window.innerHeight;
    });

    // ── Restart button ────────────────────────────────────────────────────
    document.getElementById('restart-btn').addEventListener('click', () => {
      location.reload();
    });

    // Snap camera to player base initially
    const playerBase = this._state.players.get('player')?.base;
    if (playerBase) {
      this._camera.x = playerBase.position.x;
      this._camera.y = playerBase.position.y;
    }
  }

  start() {
    this._running = true;
    this._app.ticker.add(delta => this._tick(delta));
  }

  _tick(delta) {
    if (!this._running || this._gameOver) return;

    const dtMs = Math.min(this._app.ticker.elapsedMS, 50); // cap at 50ms (20fps min)
    const dt   = dtMs / 1000;

    this._state.time += dtMs;

    // ── Update systems ────────────────────────────────────────────────────
    const { conn, combat, prod, ai, prog } = this._systems;

    prod.update(this._state, dt, dtMs);
    combat.update(this._state, dt, dtMs);
    conn.update(this._state);
    prog.update(this._state, dtMs);
    ai.update(this._state, dtMs);
    this._input.update(dt);

    // ── Camera follow ─────────────────────────────────────────────────────
    if (this._camera.follow) {
      const pBase = this._state.players.get('player')?.base;
      if (pBase) {
        this._camera.x += (pBase.position.x - this._camera.x) * 0.08;
        this._camera.y += (pBase.position.y - this._camera.y) * 0.08;
      }
    }

    // ── Base rotation ────────────────────────────────────────────────────
    for (const [, player] of this._state.players) {
      if (!player.alive) continue;
      player.base.rotation += 0.3 * dt;
    }

    // ── Boss movement ─────────────────────────────────────────────────────
    if (this._state.boss) {
      const boss = this._state.boss;
      boss.rotation += 1.5 * dt;
      // Move toward nearest player
      let nearest = null, nearestD2 = Infinity;
      for (const [, p] of this._state.players) {
        if (!p.alive) continue;
        const dx = p.base.position.x - boss.position.x;
        const dy = p.base.position.y - boss.position.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearestD2) { nearestD2 = d2; nearest = p.base; }
      }
      if (nearest) {
        const dx  = nearest.position.x - boss.position.x;
        const dy  = nearest.position.y - boss.position.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 60) {
          boss.position.x += (dx / len) * boss.speed * dt;
          boss.position.y += (dy / len) * boss.speed * dt;
        }
      }
    }

    // ── Render ────────────────────────────────────────────────────────────
    this._renderer.render(this._state, this._camera, this._input);
    this._hud.update(this._state);

    // Handle particle events
    for (const ev of this._state.flushEvents()) {
      if (ev.type === 'eatableCollected') {
        this._renderer.addParticle(ev.data.x, ev.data.y, 0xffd700, 4);
      } else if (ev.type === 'linkDestroyed') {
        this._renderer.addParticle(ev.data.x, ev.data.y, 0xff4444, 8);
      }
    }

    // ── Game over check ───────────────────────────────────────────────────
    this._checkGameOver();
  }

  _checkGameOver() {
    const players    = [...this._state.players.values()];
    const aliveCount = players.filter(p => p.alive).length;
    if (aliveCount <= 1) {
      this._gameOver = true;
      const playerAlive = this._state.players.get('player')?.alive;
      const goTitle = document.getElementById('go-title');
      const goSub   = document.getElementById('go-sub');
      const goEl    = document.getElementById('gameover');
      if (playerAlive) {
        goTitle.textContent = 'VICTORY';
        goTitle.className   = 'win';
        goSub.textContent   = 'Your network conquered all rivals.';
      } else {
        goTitle.textContent = 'ELIMINATED';
        goTitle.className   = 'lose';
        goSub.textContent   = 'Your Base was destroyed. Better luck next time.';
      }
      goEl.classList.add('vis');
    }
  }

  _showSpecModal() {
    document.getElementById('spec-modal').classList.add('vis');
  }
}
