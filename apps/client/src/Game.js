import * as PIXI from 'pixi.js';

import { WORLD_SIZE } from '@basewar/sim';
import { WorkerConnection, WebSocketConnection } from './net/Connection.js';
import { isTypingInto } from './dom.js';

/**
 * Where the backend lives. Set by docker-compose in development; in production
 * this becomes a real address like wss://eu1.basewar.io — the frontend is served
 * from a CDN and the backend from game machines, so this is genuinely a
 * different host, not just a different port.
 */
const SERVER_URL = import.meta.env?.VITE_SERVER_URL ?? 'ws://localhost:2567';

/**
 * The size the canvas should actually be, in CSS pixels.
 *
 * NOT `window.innerHeight`. On a phone with `viewport-fit=cover` that is the
 * LAYOUT viewport, which extends underneath the browser's own toolbars, and it
 * is bigger than what the player can see. Because PixiJS runs with
 * `autoDensity: true` it writes an INLINE `style.height` onto the canvas from
 * whatever it is resized to — and an inline style beats the stylesheet, so it
 * silently overrode `#app { height: 100dvh }`. The canvas then hung below the
 * visible area and the bottom strip of the map sat behind the browser chrome.
 *
 * This is invisible in desktop device emulation, which draws no browser chrome
 * and therefore reports innerHeight == the visible height. It only reproduces
 * on real hardware, which is why it survived the mobile pass.
 *
 * `#app` is already sized by CSS to `100dvh`, so its clientHeight IS the
 * visible height — asking the element means JS and CSS can no longer disagree.
 * The fallbacks are for the moment before the element exists.
 */
function viewportSize() {
  const el = document.getElementById('app');
  return {
    w: el?.clientWidth  || window.innerWidth,
    h: el?.clientHeight || window.visualViewport?.height || window.innerHeight,
  };
}
import { WorldView } from './net/WorldView.js';
import { Selection } from './Selection.js';
import { InputSystem } from './input/InputSystem.js';
import { CameraController, FIT_PLAY, FIT_ATTRACT } from './input/CameraController.js';
import { installTouchClass } from './input/touchDetect.js';
import { Joystick } from './input/Joystick.js';
import { readQuality, qualityOpts } from './quality.js';
import { GameRenderer } from './renderer/GameRenderer.js';
import { HUDRenderer } from './renderer/HUDRenderer.js';
import { Tips } from './tips.js';
import { FirstRun } from './firstRun.js';

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
    /** True while a demo match is playing behind the menu. */
    this._attract = false;
    this._tickerAdded = false;
    /** Live map pings, drawn for ~2s then dropped. */
    this._pings = [];
  }

  /**
   * Change quality at runtime.
   *
   * Only resolution differs between the two profiles now (see quality.js), and
   * resolution CAN be changed on a live renderer — so unlike before, the switch
   * takes full effect immediately and the menu no longer has to caveat itself.
   */
  applyQuality(q) {
    const opts = qualityOpts(q);
    const r = this._app?.renderer;
    if (!r) return;
    r.resolution = opts.resolution;
    const { w, h } = viewportSize();
    r.resize(w, h);
    this._input?.invalidateCanvasRect();
  }

  async init() {
    // Quality is read once, here, because antialias is fixed at WebGL context
    // creation. A phone reporting devicePixelRatio 3 would otherwise render at
    // 2x WITH multisampling, which is most of a mid-range mobile GPU budget.
    const q = qualityOpts(readQuality());
    // #app is already laid out by CSS at this point, so its box is the honest
    // one to build against — see viewportSize().
    const view0 = viewportSize();
    this._app = new PIXI.Application({
      width: view0.w,
      height: view0.h,
      backgroundColor: 0xf4f4f4,
      antialias: q.antialias,
      resolution: q.resolution,
      autoDensity: true,
    });
    document.getElementById('app').appendChild(this._app.view);

    this._camera = {
      x: WORLD_SIZE / 2,
      y: WORLD_SIZE / 2,
      zoom: 1,
      width: view0.w,
      height: view0.h,
      focusType: 'free',
      focusId: null,
    };

    this._world = new WorldView();
    this._selection = new Selection();
    this._renderer = new GameRenderer(this._app);
    this._hud = new HUDRenderer();
    // Contextual coaching. Advisory only — it never sends a command.
    this._tips = new Tips((msg, kind) => this.showNotice(msg, kind));
    this._firstRun = new FirstRun();

    this._input = new InputSystem(
      this._app, this._camera, this._world, this._selection,
      (cmd) => this._send(cmd),
    );

    // No `touch` option: the controller asks live at fit() time. Passing a
    // flag captured here is what caused the zoom regression.
    this._cameraCtl = new CameraController(this._camera);
    this._input.setCameraController(this._cameraCtl);

    // Marks <body> so the CSS can switch to touch sizing, and keeps watching:
    // classes are only ever added, so a hybrid device that has been touched
    // once keeps its large targets even when the mouse is picked back up.
    installTouchClass();

    // The stick feeds the same pan path as WASD rather than moving the camera
    // itself — see InputSystem.update.
    const stickEl = document.getElementById('joystick');
    if (stickEl) new Joystick(stickEl, (x, y) => this._input.setStick(x, y));

    this._wireUI();

    /*
     * Viewport changes.
     *
     * This used to recompute zoom from scratch on every event, which on a phone
     * meant the view jumped every time the URL bar slid in or out. Now the
     * controller only re-clamps into the new allowed range — see
     * CameraController.onViewportResize.
     *
     * rAF-coalesced because iOS fires resize in bursts during chrome
     * transitions, and we would otherwise resize the renderer a dozen times per
     * gesture.
     *
     * NOTE: no `orientationchange` listener, deliberately. On iOS it fires
     * BEFORE the new dimensions are readable, so it reports stale values.
     * `resize` fires afterwards with correct ones, and the controller derives
     * orientation from width >= height itself.
     */
    let resizeQueued = false;
    const applyResize = () => {
      resizeQueued = false;

      // An on-screen keyboard shrinks the visual viewport dramatically, and
      // resizing the canvas down to the keyboard-reduced height and back is
      // both expensive and visibly ugly. So skip those resizes — but ONLY
      // those.
      //
      // This used to test the shrink ratio alone:
      //
      //     if (vv && vv.height < window.innerHeight * 0.75) return;
      //
      // Browser chrome shrinks the visual viewport too, and on a landscape
      // phone it routinely eats more than a quarter of the layout viewport: a
      // 393px-tall viewport under a ~100px toolbar measures 0.745, just under
      // the threshold. Every resize was then skipped for the rest of the
      // session, the canvas kept whatever size it had, and a strip of dead
      // space sat along the bottom of the map — the "footer" that was reported
      // twice and survived one fix already.
      //
      // It cannot reproduce in device emulation, which draws no browser chrome
      // and therefore always measures a ratio of 1.0. That is why it kept
      // coming back.
      //
      // A keyboard can only be open if something is focused to receive it, so
      // that is what we test now, with the ratio kept as a secondary condition.
      // isTypingInto is reused rather than reimplemented so there is one
      // definition of "is this a text field" in the client.
      const vv = window.visualViewport;
      if (isTypingInto({ target: document.activeElement })
          && vv && vv.height < window.innerHeight * 0.75) return;

      const { w, h } = viewportSize();
      this._app.renderer.resize(w, h);
      this._cameraCtl.onViewportResize(w, h);
      this._input.invalidateCanvasRect();
    };
    const queueResize = () => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(applyResize);
    };

    window.addEventListener('resize', queueResize);
    window.visualViewport?.addEventListener('resize', queueResize);
    // Entering or leaving fullscreen changes the drawable area. A plain resize
    // event does fire for it, but not reliably after the new dimensions are
    // readable — this is a second, later chance. queueResize already coalesces
    // into one rAF so the duplicate costs nothing.
    document.addEventListener('fullscreenchange', queueResize);
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
      console.info(`[basewar] you are ${msg.youAre} (seat ${msg.seat + 1}) in a ${msg.mode} match`);
    });

    // Sent whenever anyone joins or leaves, so a new player's name appears at
    // once rather than at the next keyframe up to two seconds later.
    conn.onRoster((roster) => this._world.setNames(roster?.names));

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

    // Build panel — soldiers (left-click queues, right-click removes one)
    document.querySelectorAll('#build-panel .unit-btn').forEach(btn => {
      const unit = btn.dataset.unit;
      btn.addEventListener('click', () => this._send({ t: 'queue', unit, n: 1 }));
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        this._send({ t: 'queue', unit, n: -1 });
      });

      // The ✕ cancels the WHOLE queued run in one command.
      //
      // Right-click removes one at a time, which is fine with a mouse and
      // useless on a phone — there is no right-click, and undoing a mis-tap
      // that queued twenty soldiers one tap at a time is not a real option.
      // stopPropagation matters: without it the tap would bubble to the parent
      // button and queue one straight back.
      btn.querySelector('.u-cancel')?.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const queued = Number(btn.querySelector('.u-badge')?.textContent) || 0;
        if (queued > 0) this._send({ t: 'queue', unit, n: -queued });
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

    // Squad commands. Buttons mirror the keyboard rather than replacing it —
    // on a phone they are the ONLY way to reach these, and on desktop they are
    // how a new player discovers the shortcut exists.
    //
    // Split / Merge / Even / Ping / Clear were removed. Deselecting still has
    // two routes (Escape, and a two-finger tap on touch); the other four are
    // gone from the client entirely.
    this._wireBtn('cmd-defend',  () => this._input.doDefend());
    this._wireBtn('cmd-base',    () => this._input.focusBase());
    this._wireBtn('cmd-release', () => this._send({ t: 'release' }));

    // Minimap close. Opening is handled by the shared .collapsible handler in
    // main.js; this is the ✕ inside the panel body.
    document.getElementById('minimap-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('minimap-wrap')?.classList.add('collapsed');
    });

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
      if (isTypingInto(e)) return;   // R must not release the garrison mid-name
      if (!this._running || this._gameOver) return;
      // Escape is CONTEXTUAL, and this is the only place it is handled.
      //
      // It previously fired here AND in InputSystem's own switch, so one press
      // both dropped your selection and opened the pause menu. Now it does the
      // less destructive thing first: back out of the selection if there is
      // one, and only pause when there is nothing to back out of. That matches
      // what Escape means everywhere else — "undo the current mode".
      if (e.code === 'Escape') {
        const specOpen = document.getElementById('spec-modal').classList.contains('vis');
        if (specOpen) return;                      // the spec modal owns Escape
        if (this._input?.hasSelection()) this._input.unselect();
        else this.togglePause();
      }
      if (e.code === 'KeyR') this._send({ t: 'release' });
    });
  }

  _wireBtn(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  // ── Attract mode ───────────────────────────────────────────────────────────

  /**
   * Run a real match behind the menu.
   *
   * Not a video and not a mock-up — it is the actual simulation, in the same
   * Web Worker practice mode uses, with eight bots playing properly. It costs
   * nothing (it never touches the server) and it shows a new player what the
   * game is in about three seconds, which no amount of menu copy can.
   *
   * The camera drifts between whatever is currently interesting rather than
   * sitting still, so there is always something moving on screen.
   */
  async startAttract() {
    this._attract = true;
    this._conn = new WorkerConnection();
    this._bindConnection();
    await this._conn.start('ffa');

    const cam = this._camera;
    cam.focusType = 'free';
    cam.focusId = null;
    cam.x = WORLD_SIZE / 2;
    cam.y = WORLD_SIZE / 2;
    // Closer than the in-game view: the point is to see soldiers moving and
    // fighting, not to read the whole map at once.
    this._cameraCtl.fit(FIT_ATTRACT);

    this._attractTarget = { x: cam.x, y: cam.y };
    this._attractUntil = 0;

    this._input.setEnabled(false);
    this._startTicker();
  }

  /** Add the render loop exactly once, however many matches get played. */
  _startTicker() {
    if (this._tickerAdded) return;
    this._tickerAdded = true;
    this._running = true;
    this._app.ticker.add(() => this._frame());
  }

  /**
   * Drift the camera between points of interest.
   *
   * Prefers a base that is currently being fought over, then the largest squad
   * on the move, and falls back to the middle of the map. Re-picks every few
   * seconds so the shot keeps changing.
   */
  _updateAttractCamera(dt) {
    const cam = this._camera;
    const world = this._world;
    const now = performance.now();

    if (now > this._attractUntil) {
      this._attractUntil = now + 6500 + Math.random() * 2500;
      this._attractTarget = this._findAction(world) ?? { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    }

    // Slow ease so it feels like a drifting camera, not a cut.
    const k = Math.min(1, dt * 0.6);
    cam.x += (this._attractTarget.x - cam.x) * k;
    cam.y += (this._attractTarget.y - cam.y) * k;
  }

  /** Somewhere worth pointing a camera: a contested base, else a big squad. */
  _findAction(world) {
    let bestBase = null, bestPressure = 0;
    for (const [, p] of world.players) {
      if (!p.alive) continue;
      let pressure = 0;
      for (const [, s] of world.soldiers) {
        if (s.ownerId === p.id) continue;
        const dx = s.position.x - p.base.position.x;
        const dy = s.position.y - p.base.position.y;
        if (dx * dx + dy * dy < 320 * 320) pressure++;
      }
      if (pressure > bestPressure) { bestPressure = pressure; bestBase = p.base; }
    }
    if (bestBase && bestPressure >= 3) {
      return { x: bestBase.position.x, y: bestBase.position.y };
    }

    // Nothing burning — follow the biggest squad that is actually going somewhere.
    let bestSquad = null, bestSize = 0;
    for (const [, g] of world.groups) {
      if (g.status !== 'moving' && g.status !== 'attacking') continue;
      if (g.memberIds.length > bestSize) { bestSize = g.memberIds.length; bestSquad = g; }
    }
    if (bestSquad) return { x: bestSquad.anchor.x, y: bestSquad.anchor.y };

    // Otherwise pick a living base at random so the view keeps changing.
    const alive = [...world.players.values()].filter(p => p.alive);
    if (alive.length) {
      const p = alive[Math.floor(Math.random() * alive.length)];
      return { x: p.base.position.x, y: p.base.position.y };
    }
    return null;
  }

  /** Leave attract mode and hand the screen over to a real match. */
  _endAttract() {
    if (!this._attract) return;
    this._attract = false;
    this._conn?.close();
    this._conn = null;
    this._world = new WorldView();
    this._selection = new Selection();
    this._pings = [];
    this._input.rebind(this._world, this._selection);
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
    this._endAttract();   // stop the demo match running behind the menu

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
      // Put the demo match back, so the menu keeps moving instead of sitting
      // frozen on whatever frame it happened to stop at.
      this.startAttract().catch(() => {});
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
    this._cameraCtl.fit(FIT_PLAY);

    // Reveals the HUD, which is hidden by CSS until this class is present.
    document.body.classList.add('playing');
    this._input.setEnabled(true);

    // Arm the teaching surfaces for this match.
    //
    // These MUST be here and not only in _requeue(). The previous version was
    // wired solely into _requeue — the Play Again path — which startMatch never
    // calls, so on a first visit the tutorial was never armed and never
    // appeared at all. Incognito reproduced it every time.
    this._firstRun?.reset();
    this._tips?.reset();

    this._startTicker();
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

    if (this._attract) {
      // Demo behind the menu: cinematic camera, no input, no HUD, no win check.
      this._updateAttractCamera(dt);
      this._renderer.render(world, this._camera, this._selection, [], []);
      return;
    }

    this._input.update(dt);
    this._updateCamera();

    // Drop pings that have finished animating.
    if (this._pings.length) {
      const now = performance.now();
      this._pings = this._pings.filter(p => now - p.at < 2000);
    }

    this._renderer.render(world, this._camera, this._selection, this._input.pendingOrders, this._pings);
    // Teach in context, but never while spectating or in the menu demo.
    if (this._running && !this._attract && !this._spectating) {
      this._firstRun?.update(world, this._camera);
      // The walkthrough owns match one; contextual tips take over once it is
      // finished, so a new player is never handed two things to read at once.
      if (!this._firstRun?.active) this._tips?.update(world, performance.now());
    }

    this._hud.update(world, this._selection, {
      online: this._online,
      ping: this._conn?.ping ?? 0,
      camera: this._camera,
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


  /**
   * Show a transient message in the bottom-left stack.
   *
   * The #notifs element has existed since the first HUD and nothing ever wrote
   * to it — GameState.notify() was a silent stub, so every message the
   * simulation tried to send went nowhere.
   *
   * Capped and self-expiring: an unbounded notification list on a long match
   * grows without limit and quietly eats memory and layout time.
   */
  showNotice(msg, kind = 'info') {
    // The tutorial owns the message area while it is running.
    //
    // One gate, here, rather than a check at each caller: contextual tips and
    // simulation notifications both land in #notifs, they look identical to the
    // walkthrough, and two of them stacked in the same corner read as one
    // contradictory thing. Gating at the source means the next thing that
    // learns to post a message is covered without knowing this rule exists.
    //
    // Nothing is lost by dropping them: tips re-evaluate every frame, so one
    // still true when the tutorial ends simply fires then.
    if (this._firstRun?.active) return;
    if (!msg) return;
    const host = document.getElementById('notifs');
    if (!host) return;

    const el = document.createElement('div');
    el.className = `notif ${kind}`;
    el.textContent = msg;
    host.appendChild(el);

    // Oldest first — the container is column-reverse, so this trims the top.
    while (host.children.length > 4) host.removeChild(host.firstChild);

    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    }, kind === 'warn' ? 6000 : 4500);
  }
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

        case 'playerEliminated':
          // Eight players share one stream, so only my own death is mine to
          // report. Recorded here rather than derived later because the
          // killer is knowable only at the moment of the kill — a minute on,
          // whoever did it may themselves be dead.
          if (ev.data.ownerId === this._world.playerId) {
            this._killedBy = this._nameOf(ev.data.killerId);
            this._showEliminatedBy();
          }
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
        case 'notify':
          // One event stream, eight players — so only show what is addressed
          // to me. 'player' is the sim's generic "whoever is local" target.
          if (ev.data.targetId === 'player' || ev.data.targetId === this._world.playerId) {
            this.showNotice(ev.data.msg, ev.data.type);
          }
          break;

        case 'simError':
          console.error('[sim] tick error at', ev.data.tick, '—', ev.data.message);
          break;
      }
    }
  }

  /**
   * Resolve an owner id to something worth showing a player.
   *
   * `killerId` is genuinely nullable — CombatSystem emits `killer?.id ?? null`,
   * which is what arrives when a base falls with no surviving attacker to
   * credit. Returning null rather than a placeholder keeps that case
   * distinguishable, so the copy can say "your base fell" instead of naming
   * nobody in particular.
   */
  _nameOf(id) {
    if (!id) return null;
    const p = this._world.players.get(id);
    // Bots carry no display name, only an id like `bot_2`. Format it exactly
    // as the simulation formats it in its own notifications, so a player never
    // sees the same opponent called two different things.
    return p?.name || id.replace('bot_', 'Bot ');
  }

  /**
   * Say who killed you, in the banner that appears the moment you die.
   *
   * Safe to call before or after the banner is shown: the elimination event and
   * the state change that triggers spectating arrive in the same tick with no
   * guaranteed order, so both paths call this and whichever runs second simply
   * rewrites the same text.
   */
  _showEliminatedBy() {
    const el = document.querySelector('#spectate-banner .sp-sub');
    if (!el) return;
    el.textContent = this._killedBy
      ? `Killed by ${this._killedBy} — the match continues`
      : 'Your base fell — the match continues';
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
        console.debug('[basewar] feedback not sent:', err);
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
    this._killedBy     = null;

    // Re-arm both teaching surfaces for the new match. Tips was never reset
    // here, so in a second match within one session it stayed silent.
    this._firstRun?.reset();
    this._tips?.reset();

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
      console.error('[basewar] connection', state, detail ?? '');
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
      console.info('[basewar] connection', state);
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
    this._showEliminatedBy();   // the event may have landed before or after this
    // Dying mid-walkthrough ends it: the remaining steps assume a live base.
    this._firstRun?.finish();
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
      goSub.textContent = this._killedBy
        ? `${this._killedBy} destroyed your mother base. Better luck next time.`
        : 'Your mother base was destroyed. Better luck next time.';
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
