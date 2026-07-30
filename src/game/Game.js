import * as PIXI from 'pixi.js';

import { GameState }         from './GameState.js';
import { buildWorld }        from './World.js';
import { CombatSystem }      from './systems/CombatSystem.js';
import { ProductionSystem }  from './systems/ProductionSystem.js';
import { GroupSystem, releaseGarrison } from './systems/GroupSystem.js';
import { InputSystem }       from './systems/InputSystem.js';
import { AISystem }          from './systems/AISystem.js';
import { CenterSystem }      from './systems/CenterSystem.js';
import { MiningSystem }      from './systems/MiningSystem.js';
import { ProgressionSystem } from './systems/ProgressionSystem.js';
import { GameRenderer }      from './renderer/GameRenderer.js';
import { HUDRenderer }       from './renderer/HUDRenderer.js';
import { buyMineUpgrade }    from './systems/ProgressionSystem.js';
import { canAddWall }        from './walls.js';
import { DEF_ZOOM, MIN_ZOOM, WORLD_SIZE, SOLDIER_DEFS, TURRET_DEFS, MAX_TURRETS_PER_BASE } from './constants.js';

export class Game {
  constructor() {
    this._app      = null;
    this._state    = null;
    this._camera   = null;
    this._systems  = {};
    this._renderer = null;
    this._hud      = null;
    this._input    = null;
    this._running  = false;
    this._gameOver = false;
    this._paused   = false;
  }

  async init() {
    this._app = new PIXI.Application({
      width:  window.innerWidth,
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
      zoom: DEF_ZOOM,
      width: window.innerWidth,
      height: window.innerHeight,
      focusType: 'base',   // 'base' | 'group'
      focusId: null,
    };

    this._state = new GameState('player');
    // World is built in startMatch(mode) once the player picks a mode on the intro.

    this._renderer = new GameRenderer(this._app);
    this._hud      = new HUDRenderer();

    const combat = new CombatSystem();
    const prod   = new ProductionSystem();
    const group  = new GroupSystem();
    const ai     = new AISystem();
    const center = new CenterSystem();
    const mining = new MiningSystem();
    const prog   = new ProgressionSystem();
    const input  = new InputSystem(this._app, this._renderer.worldContainer, this._camera, this._state);

    this._systems = { combat, prod, group, ai, center, mining, prog };
    this._input   = input;

    prog.onSpecReady = () => this._showSpecModal();

    // Clicking a squad in the left panel focuses/selects it.
    this._hud.onGroupClick = (id) => {
      const g = this._state.groups.get(id);
      if (g) this._input.focusGroup(g);
    };

    // Specialization buttons
    document.querySelectorAll('.spec-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const spec = btn.dataset.spec;
        const player = this._state.players.get('player');
        if (player) prog.applySpecialization(this._state, player, spec);
        document.getElementById('spec-modal').classList.remove('vis');
        this._paused = false;
      });
    });

    // Build panel — soldiers (click = queue, right-click = remove)
    document.querySelectorAll('#build-panel .unit-btn').forEach(btn => {
      const unit = btn.dataset.unit;
      btn.addEventListener('click', () => this._enqueueUnit(unit));
      btn.addEventListener('contextmenu', e => { e.preventDefault(); this._dequeueUnit(unit); });
    });
    // Build panel — turrets (click = buy)
    document.querySelectorAll('#build-panel .turret-btn').forEach(btn => {
      const type = btn.dataset.turret;
      btn.addEventListener('click', () => this._enqueueTurret(type));
    });
    // Build panel — mining upgrade (click = buy, raises gold rate)
    this._wireBtn('mine-btn', () => {
      const base = this._state.players.get('player')?.base;
      if (!base) return;
      if (buyMineUpgrade(this._state, base))
        this._state.notify('⛏️ Mining upgraded — gold rate up!', 'success', 'player');
      else
        this._state.notify('❌ Can\'t afford the mining upgrade (or it\'s maxed)', 'warning', 'player');
    });

    // Skill panel
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

    // Squad command buttons (mirror the keyboard shortcuts)
    this._wireBtn('cmd-defend',  () => this._input._doDefend());
    this._wireBtn('cmd-base',    () => this._input.focusBase());
    this._wireBtn('cmd-release', () => this._releaseGarrison());

    window.addEventListener('resize', () => {
      this._app.renderer.resize(window.innerWidth, window.innerHeight);
      this._camera.width = window.innerWidth;
      this._camera.height = window.innerHeight;
      this._camera.zoom = (this._camera.width / WORLD_SIZE) * 0.98; // keep the fixed wide view
    });

    document.getElementById('menu-btn')  .addEventListener('click', () => this.togglePause());
    document.getElementById('resume-btn').addEventListener('click', () => this.togglePause(false));
    document.getElementById('exit-btn')  .addEventListener('click', () => this._exit());
    document.getElementById('go-exit-btn').addEventListener('click', () => this._exit());
    window.addEventListener('keydown', e => {
      if (e.code === 'Escape' && this._running && !this._gameOver) {
        const specOpen = document.getElementById('spec-modal').classList.contains('vis');
        if (!specOpen) this.togglePause();
      }
      if (e.code === 'KeyR' && this._running && !this._gameOver) this._releaseGarrison();
    });
    document.getElementById('restart-btn').addEventListener('click', () => location.reload());
  }

  _wireBtn(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  /** Release the player's garrison as a fresh defending formation. */
  _releaseGarrison() {
    const base = this._state.players.get('player')?.base;
    if (base) releaseGarrison(this._state, base);
  }

  /** Build the world for the chosen mode ('ffa' | 'team') and begin play. */
  startMatch(mode = 'ffa') {
    this._mode = mode;
    buildWorld(this._state, mode);

    // Default view: the whole map, from the centre (not following the base).
    const cam = this._camera;
    cam.focusType = 'free';
    cam.focusId   = null;
    cam.x = WORLD_SIZE / 2;
    cam.y = WORLD_SIZE / 2;
    cam.zoom = (cam.width / WORLD_SIZE) * 0.98; // fixed wide view — whole map width

    this.start();
  }

  start() {
    this._running = true;
    this._app.ticker.add(delta => this._tick(delta));
  }

  _tick(delta) {
    if (!this._running || this._gameOver || this._paused) return;
    try { this._step(delta); }
    catch (err) {
      console.error('[Nexus.io] tick error:', err);
      this._state?.notify?.('⚠️ A glitch was caught — game continues', 'warning', 'player');
    }
  }

  _step(delta) {
    const dtMs = Math.min(this._app.ticker.elapsedMS, 50);
    const dt   = dtMs / 1000;
    this._state.time += dtMs;

    const { combat, prod, group, ai, center, mining, prog } = this._systems;
    prog.update(this._state, dtMs);
    prod.update(this._state, dt, dtMs);
    ai.update(this._state, dtMs);
    center.update(this._state, dt, dtMs);
    mining.update(this._state, dt, dtMs);
    group.update(this._state, dt, dtMs);
    combat.update(this._state, dt, dtMs);
    this._input.update(dt);

    this._updateCamera();

    for (const [, player] of this._state.players) {
      if (!player.alive) continue;
      player.base.rotation += 0.3 * dt;
    }

    this._updateBoss(dt);

    this._renderer.render(this._state, this._camera);
    this._hud.update(this._state);

    for (const ev of this._state.flushEvents()) {
      if (ev.type === 'explosion') this._renderer.addParticle(ev.data.x, ev.data.y, ev.data.color ?? 0xef4444, 10);
      else if (ev.type === 'bossKilled') { /* handled elsewhere */ }
    }

    this._checkGameOver();
  }

  /** Camera focuses on either the base or one squad — never free-roams. */
  _updateCamera() {
    const cam = this._camera;
    if (cam.focusType === 'free') return; // whole-map overview — stays put, user zooms
    let target = null;
    if (cam.focusType === 'group' && cam.focusId) {
      const g = this._state.groups.get(cam.focusId);
      if (g) target = g.anchor;
      else { cam.focusType = 'base'; cam.focusId = null; }
    }
    if (!target) {
      const pBase = this._state.players.get('player')?.base;
      if (pBase) target = pBase.position;
    }
    if (target) {
      cam.x += (target.x - cam.x) * 0.12;
      cam.y += (target.y - cam.y) * 0.12;
    }
  }

  _updateBoss(dt) {
    const boss = this._state.boss;
    if (!boss) return;
    boss.rotation += 1.5 * dt;
    let nearest = null, nearestD2 = Infinity;
    for (const [, p] of this._state.players) {
      if (!p.alive) continue;
      const dx = p.base.position.x - boss.position.x;
      const dy = p.base.position.y - boss.position.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearestD2) { nearestD2 = d2; nearest = p.base; }
    }
    if (nearest) {
      const dx = nearest.position.x - boss.position.x;
      const dy = nearest.position.y - boss.position.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 60) {
        boss.position.x += (dx / len) * boss.speed * dt;
        boss.position.y += (dy / len) * boss.speed * dt;
      }
    }
  }

  _checkGameOver() {
    const state = this._state;
    const playerAlive = state.players.get('player')?.alive;
    let over = false, won = false;

    if (this._mode === 'team') {
      const teams = state.aliveTeams();
      if (teams.length <= 1) {
        over = true;
        won = playerAlive || (teams[0] && teams[0] === state.teamOf('player'));
      }
    } else {
      const aliveCount = [...state.players.values()].filter(p => p.alive).length;
      if (aliveCount <= 1) { over = true; won = !!playerAlive; }
    }
    if (!over) return;

    this._gameOver = true;
    const goTitle = document.getElementById('go-title');
    const goSub   = document.getElementById('go-sub');
    const goEl    = document.getElementById('gameover');
    if (won) {
      goTitle.textContent = 'VICTORY';
      goTitle.className = 'win';
      goSub.textContent = this._mode === 'team' ? 'Your team wiped out the enemy team.' : 'You destroyed every rival mother base.';
    } else {
      goTitle.textContent = 'ELIMINATED';
      goTitle.className = 'lose';
      goSub.textContent = 'Your mother base was destroyed. Better luck next time.';
    }
    goEl.classList.add('vis');
  }

  _showSpecModal() {
    this._paused = true;
    document.getElementById('spec-modal').classList.add('vis');
    this._state.notify('⭐ Level 15 — choose a specialization to continue', 'info', 'player');
  }

  togglePause(force) {
    if (this._gameOver) return;
    this._paused = (force === undefined) ? !this._paused : force;
    document.getElementById('pause-modal').classList.toggle('vis', this._paused);
    const btn = document.getElementById('menu-btn');
    if (btn) btn.textContent = this._paused ? '▶ RESUME' : '⏸ MENU';
  }

  _exit() { location.reload(); }

  // ── Build queue helpers ────────────────────────────────────────────────────
  // Grunts go to the soldier queue; the Defender ('sentinel') to the wall queue —
  // they build in parallel.
  _queueFor(base, unit) { return unit === 'sentinel' ? base.wallQueue : base.soldierQueue; }

  _enqueueUnit(unit) {
    const base = this._state.players.get('player')?.base;
    if (!base) return;
    if (!base.unlocked.has(unit)) return;
    if (unit === 'sentinel' && !canAddWall(base) && base.wallQueue.length === 0) return; // walls maxed
    const q = this._queueFor(base, unit);
    const tail = q[q.length - 1];
    if (tail && tail.type === unit) tail.count++;
    else q.push({ type: unit, count: 1 });
  }

  _dequeueUnit(unit) {
    const base = this._state.players.get('player')?.base;
    if (!base) return;
    const q = this._queueFor(base, unit);
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].type === unit) {
        q[i].count--;
        if (q[i].count <= 0) q.splice(i, 1);
        break;
      }
    }
  }

  _enqueueTurret(type) {
    const base = this._state.players.get('player')?.base;
    if (!base) return;
    const def = TURRET_DEFS[type];
    if (base.level < def.unlockLv) {
      this._state.notify(`🔒 ${type.toUpperCase()} turret unlocks at Level ${def.unlockLv}`, 'warning', 'player');
      return;
    }
    if (this._state.turretCount(base.id) + base.turretQueue.length >= MAX_TURRETS_PER_BASE) {
      this._state.notify('❌ All turret mounts are full', 'warning', 'player');
      return;
    }
    base.turretQueue.push({ type });
  }
}
