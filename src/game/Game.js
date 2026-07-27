import * as PIXI from 'pixi.js';

import { GameState }           from './GameState.js';
import { buildWorld }          from './World.js';
import { ConnectivitySystem }  from './systems/ConnectivitySystem.js';
import { CombatSystem }        from './systems/CombatSystem.js';
import { ProductionSystem }    from './systems/ProductionSystem.js';
import { InputSystem }         from './systems/InputSystem.js';
import { AISystem }            from './systems/AISystem.js';
import { ProgressionSystem }   from './systems/ProgressionSystem.js';
import { FormationSystem }     from './systems/FormationSystem.js';
import { GameRenderer }        from './renderer/GameRenderer.js';
import { HUDRenderer }         from './renderer/HUDRenderer.js';
import { DEF_ZOOM, WORLD_SIZE, VISION_RADIUS_VIEW } from './constants.js';

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
    this._paused    = false;
  }

  async init() {
    // ── PixiJS Application ────────────────────────────────────────────────
    this._app = new PIXI.Application({
      width:           window.innerWidth,
      height:          window.innerHeight,
      backgroundColor: 0xf4f4f4,
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
    const form   = new FormationSystem();
    const input  = new InputSystem(this._app, this._renderer.worldContainer, this._camera, this._state);

    this._systems = { conn, combat, prod, ai, prog, form };
    this._input   = input;
    input.game    = this;   // let input drive view switching / split

    // Specialization modal callback
    prog.onSpecReady = () => this._showSpecModal();

    // ── Specialization buttons ────────────────────────────────────────────
    document.querySelectorAll('.spec-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const spec = btn.dataset.spec;
        const player = this._state.players.get('player');
        if (player) prog.applySpecialization(this._state, player, spec);
        document.getElementById('spec-modal').classList.remove('vis');
        this._paused = false; // resume after choosing
      });
    });

    // ── Build panel: click = queue one unit, right-click = remove one ──────
    document.querySelectorAll('#build-panel .unit-btn').forEach(btn => {
      const unit  = btn.dataset.unit;
      const reqLv = parseInt(btn.dataset.lv, 10);

      btn.addEventListener('click', () => this._enqueueUnit(unit, reqLv));
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        this._dequeueUnit(unit);
      });
    });

    // ── Skill panel: click a stat to spend a point on it ───────────────────
    document.querySelectorAll('#skill-panel .sk-row').forEach(row => {
      row.addEventListener('click', () => {
        const player = this._state.players.get('player');
        if (!player || player.base.skillPoints <= 0) return;
        const stat = row.dataset.buff;
        player.buffs[stat] += 1;
        player.base.skillPoints -= 1;
        this._state.notify(`✨ ${stat.toUpperCase()} +10%`, 'success', 'player');
      });
    });

    // ── Split button: divide the active formation into two ─────────────────
    document.getElementById('rally-btn').addEventListener('click', () => {
      this._input._splitActive();
    });

    // ── Minimap click → switch view to nearest own formation, else base ────
    const mm = document.getElementById('minimap');
    mm.addEventListener('click', (e) => {
      const rect = mm.getBoundingClientRect();
      const wx = ((e.clientX - rect.left) / rect.width)  * WORLD_SIZE;
      const wy = ((e.clientY - rect.top)  / rect.height) * WORLD_SIZE;
      const state = this._state;
      // Nearest own formation to the click?
      let best = null, bestD = Infinity;
      for (const [, f] of state.formations) {
        if (f.ownerId !== 'player' || f.memberIds.size === 0) continue;
        const dx = f.center.x - wx, dy = f.center.y - wy, d = dx*dx + dy*dy;
        if (d < bestD) { bestD = d; best = f; }
      }
      const base = state.players.get('player')?.base;
      const bd = base ? (base.position.x - wx)**2 + (base.position.y - wy)**2 : Infinity;
      // Pick whichever is closer to the click (base vs a formation).
      if (best && bestD < bd) this.setView('formation', best.id);
      else this.setView('base');
    });

    // ── Window resize ─────────────────────────────────────────────────────
    window.addEventListener('resize', () => {
      this._app.renderer.resize(window.innerWidth, window.innerHeight);
      this._camera.width  = window.innerWidth;
      this._camera.height = window.innerHeight;
    });

    // ── Menu / Pause / Exit ────────────────────────────────────────────────
    document.getElementById('menu-btn')  .addEventListener('click', () => this.togglePause());
    document.getElementById('resume-btn').addEventListener('click', () => this.togglePause(false));
    document.getElementById('exit-btn')  .addEventListener('click', () => this._exit());
    document.getElementById('go-exit-btn').addEventListener('click', () => this._exit());
    window.addEventListener('keydown', e => {
      // Esc toggles pause (but only mid-game, and not while a modal is open)
      if (e.code === 'Escape' && this._running && !this._gameOver) {
        const specOpen = document.getElementById('spec-modal').classList.contains('vis');
        if (!specOpen) this.togglePause();
      }
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
    if (!this._running || this._gameOver || this._paused) return;

    try {
      this._step(delta);
    } catch (err) {
      // A thrown exception inside the rAF/ticker callback would otherwise leave
      // the last frame frozen on screen — looking exactly like an unexplained
      // "pause". Surface it instead of dying silently, and keep the loop alive.
      console.error('[Nexus.io] tick error:', err);
      this._state?.notify?.('⚠️ A glitch was caught — game continues', 'warning', 'player');
    }
  }

  _step(delta) {
    const dtMs = Math.min(this._app.ticker.elapsedMS, 50); // cap at 50ms (20fps min)
    const dt   = dtMs / 1000;

    this._state.time += dtMs;

    // ── Update systems ────────────────────────────────────────────────────
    const { conn, combat, prod, ai, prog, form } = this._systems;

    prod.update(this._state, dt, dtMs);
    form.update(this._state, dt, dtMs);   // player grunts → formations
    combat.update(this._state, dt, dtMs);
    conn.update(this._state);
    prog.update(this._state, dtMs);
    ai.update(this._state, dtMs);
    this._input.update(dt);

    // ── Locked viewport: follow the active view (base or a formation) ──────
    this._updateLockedCamera(dt);
    // ── Base-under-attack alert while looking away from the base ───────────
    this._checkBaseAttack();

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
    this._hud.update(this._state, this._camera);

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
    // Pause while the player chooses — otherwise the full-screen modal sits over
    // a still-running game and reads as an unexplained "freeze".
    this._paused = true;
    document.getElementById('spec-modal').classList.add('vis');
    this._state.notify('⭐ Level 15 — choose a specialization to continue', 'info', 'player');
  }

  /**
   * The viewport is LOCKED to whatever the player is currently viewing — the
   * mother base or one active formation — and zoomed so the visible window
   * radius equals VISION_RADIUS_VIEW (65% of base link-range). No free pan/zoom.
   */
  _updateLockedCamera(dt) {
    const state = this._state;
    const cam   = this._camera;

    // Resolve the point we're viewing.
    let cx, cy;
    const activeF = state.activeFormationId ? state.formations.get(state.activeFormationId) : null;
    if (state.viewMode === 'formation' && activeF) {
      cx = activeF.center.x; cy = activeF.center.y;
    } else {
      // Fallback to base (also if the active formation vanished)
      const base = state.players.get('player')?.base;
      if (!base) return;
      cx = base.position.x; cy = base.position.y;
      if (state.viewMode === 'formation' && !activeF) {
        state.viewMode = 'base'; state.activeFormationId = null;
      }
    }

    // Smoothly track the view center.
    cam.x += (cx - cam.x) * Math.min(1, 0.12 + dt); // snappy but not jarring
    cam.y += (cy - cam.y) * Math.min(1, 0.12 + dt);

    // Lock zoom so half the smaller screen dimension == VISION_RADIUS_VIEW.
    const halfMin = Math.min(cam.width, cam.height) / 2;
    cam.zoom = halfMin / VISION_RADIUS_VIEW;
  }

  /** Notify once when the base takes damage while the player is looking elsewhere. */
  _checkBaseAttack() {
    const state = this._state;
    const base  = state.players.get('player')?.base;
    if (!base) return;
    if (this._lastBaseHp === undefined) this._lastBaseHp = base.hp;

    const tookDamage = base.hp < this._lastBaseHp - 0.5;
    const lookingAway = state.viewMode === 'formation';
    if (tookDamage && lookingAway) {
      // Throttle to once every ~3s
      if (!this._baseAlertAt || state.time - this._baseAlertAt > 3000) {
        this._baseAlertAt = state.time;
        state.notify('🚨 Your base is under attack! Press SPACE to return', 'warning', 'player');
        state.event('baseAttack', {});
      }
    }
    this._lastBaseHp = base.hp;
  }

  /** Switch the locked view. mode='base' or 'formation' (with a formation id). */
  setView(mode, formationId = null) {
    this._state.viewMode = mode;
    this._state.activeFormationId = (mode === 'formation') ? formationId : null;
  }

  /** Cycle to the next formation (Tab). Falls back to base if none. */
  cycleView() {
    const state = this._state;
    const ids = [...state.formations.keys()];
    if (ids.length === 0) { this.setView('base'); return; }
    if (state.viewMode === 'base') { this.setView('formation', ids[0]); return; }
    const i = ids.indexOf(state.activeFormationId);
    const next = ids[(i + 1) % ids.length];
    // After the last formation, return to base view.
    if (i === ids.length - 1) this.setView('base');
    else this.setView('formation', next);
  }

  /** Pause / resume the game. Pass a bool to force a state, or omit to toggle. */
  togglePause(force) {
    if (this._gameOver) return;
    this._paused = (force === undefined) ? !this._paused : force;
    document.getElementById('pause-modal').classList.toggle('vis', this._paused);
    const btn = document.getElementById('menu-btn');
    if (btn) btn.textContent = this._paused ? '▶ RESUME' : '⏸ MENU';
  }

  /** Leave the current match and return to the intro screen. */
  _exit() {
    // Simplest robust reset: reload back to a fresh intro screen.
    location.reload();
  }

  // ── Spawn queue helpers ──────────────────────────────────────────────────
  _enqueueUnit(unit, reqLv) {
    const base = this._state.players.get('player')?.base;
    if (!base) return;
    if (!base.unlocked.has(unit)) {
      this._state.notify(`🔒 ${unit.toUpperCase()} unlocks at Level ${reqLv}`, 'warning', 'player');
      return;
    }
    // Merge with the tail entry if it's the same type (keeps click-order FIFO).
    const q = base.spawnQueue;
    const tail = q[q.length - 1];
    if (tail && tail.type === unit) tail.count++;
    else q.push({ type: unit, count: 1 });
  }

  _dequeueUnit(unit) {
    const base = this._state.players.get('player')?.base;
    if (!base) return;
    // Remove one from the LAST queue entry of this type.
    const q = base.spawnQueue;
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].type === unit) {
        q[i].count--;
        if (q[i].count <= 0) q.splice(i, 1);
        break;
      }
    }
  }
}
