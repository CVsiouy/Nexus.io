import { dist2, WORLD_SIZE, MINE_NODE_RADIUS, BASE_DEFENSE_RADIUS } from '@nexus/sim';
import { isTypingInto } from '../dom.js';

/**
 * InputSystem
 * ───────────
 * Turns mouse and keyboard into COMMANDS. It no longer changes the game itself.
 *
 * Before, clicking "attack" called attackWithGroup() and the squad turned on the
 * spot. Now it sends { t:'attack', … } and the simulation decides. The visible
 * difference is one 50ms tick in practice mode — and over a network, up to
 * ~150ms, which for a squad that then walks for eight seconds is imperceptible.
 *
 * To make a click feel acknowledged instantly regardless, we drop an optimistic
 * marker at the destination straight away (faded), and it fades out once the
 * simulation confirms. That is about twenty lines, and it removes the entire
 * need for client-side prediction in this game.
 *
 *   Left-click own soldier  → select its squad (camera follows)
 *   Left-drag               → box-select several squads
 *   Left-click enemy/base   → selected squads attack
 *   Left-click ground       → selected squads move
 *   Right-click             → deselect (camera stays put)
 *   Space                   → focus mother base · Tab → cycle · F → defend
 *   WASD / arrows           → pan
 */
export class InputSystem {
  /**
   * @param {object} app        PixiJS application (for the canvas element)
   * @param {object} camera     shared camera object
   * @param {object} world      WorldView — read-only picture of the game
   * @param {object} selection  Selection — client-only highlighted squads
   * @param {(cmd:object)=>void} send  sends a command to the simulation
   */
  constructor(app, camera, world, selection, send) {
    this._app = app;
    this._cam = camera;
    this._world = world;
    this._sel = selection;
    this._send = send;

    this._keys = {};
    this._drag = null;
    this._boxing = false;
    this._enabled = true;

    /**
     * Optimistic order markers: { x, y, at } drawn immediately on click so the
     * player sees their input registered before the simulation replies.
     */
    this.pendingOrders = [];

    this._selBox = document.createElement('div');
    this._selBox.style.cssText =
      'position:fixed;border:1.5px solid #3399ff;background:rgba(51,153,255,0.12);' +
      'pointer-events:none;display:none;z-index:50;';
    document.body.appendChild(this._selBox);

    this._bindEvents();
  }

  /** Ignore input while a modal is open, or after you've been eliminated. */
  setEnabled(v) { this._enabled = v; }

  /**
   * Point at a new match's world and selection.
   *
   * Used by "Play Again": we build a fresh WorldView rather than reloading the
   * page, and this system must follow it. Rebuilding InputSystem instead would
   * attach a second set of window event listeners every time — every click
   * would fire twice, then three times.
   */
  rebind(world, selection) {
    this._world = world;
    this._sel = selection;
    this.pendingOrders = [];
    this._drag = null;
    this._boxing = false;
    this._selBox.style.display = 'none';
  }

  /** Send a map ping at the current mouse position. */
  pingAt(kind) {
    if (!this._enabled || !this._mouse) return;
    const wp = this._screenToWorld(this._mouse.x, this._mouse.y);
    this._send({ t: 'ping', x: wp.x, y: wp.y, kind });
  }

  update(dt) {
    // Expire optimistic markers.
    const now = performance.now();
    if (this.pendingOrders.length)
      this.pendingOrders = this.pendingOrders.filter(o => now - o.at < 600);

    const cam = this._cam;
    let mx = 0, my = 0;
    const k = this._keys;
    if (k['KeyW'] || k['ArrowUp'])    my -= 1;
    if (k['KeyS'] || k['ArrowDown'])  my += 1;
    if (k['KeyA'] || k['ArrowLeft'])  mx -= 1;
    if (k['KeyD'] || k['ArrowRight']) mx += 1;
    if (mx === 0 && my === 0) return;
    if (mx && my) { const inv = 1 / Math.sqrt(2); mx *= inv; my *= inv; }
    const pan = 600 * dt;
    cam.focusType = 'free';
    cam.focusId = null;
    cam.x = Math.max(0, Math.min(WORLD_SIZE, cam.x + mx * pan));
    cam.y = Math.max(0, Math.min(WORLD_SIZE, cam.y + my * pan));
  }

  // ── Focus ──────────────────────────────────────────────────────────────────
  focusBase() {
    this._cam.focusType = 'base';
    this._cam.focusId = null;
    this._sel.clear();
  }

  focusGroup(g) {
    if (!g) return;
    this._sel.only(g.id);
    this._cam.focusType = 'group';
    this._cam.focusId = g.id;
  }

  _unselect() {
    this._sel.clear();
    this._cam.focusType = 'free';
    this._cam.focusId = null;
    // Deliberately does NOT recentre — the view stays where it is.
  }

  focusFree() {
    this._sel.clear();
    const cam = this._cam;
    cam.focusType = 'free';
    cam.focusId = null;
    cam.x = WORLD_SIZE / 2;
    cam.y = WORLD_SIZE / 2;
    cam.zoom = (cam.width / WORLD_SIZE) * 0.98;
  }

  cycleFocus() {
    const groups = this._world.groupsOf(this._world.playerId);
    if (this._cam.focusType === 'free') { this.focusBase(); return; }
    if (this._cam.focusType === 'base') {
      if (groups[0]) this.focusGroup(groups[0]); else this.focusFree();
      return;
    }
    const idx = groups.findIndex(g => g.id === this._cam.focusId);
    const next = groups[idx + 1];
    if (next) this.focusGroup(next); else this.focusFree();
  }

  selectedGroups() { return this._sel.resolve(this._world); }
  selectedGroup() { return this.selectedGroups()[0] || null; }

  // ── Events ─────────────────────────────────────────────────────────────────
  _bindEvents() {
    const canvas = this._app.view;
    canvas.addEventListener('mousedown',   e => this._onMouseDown(e));
    canvas.addEventListener('mousemove',   e => this._onMouseMove(e));
    canvas.addEventListener('wheel',       e => e.preventDefault(), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('mouseup',     e => this._onMouseUp(e));

    window.addEventListener('keydown', e => {
      // Never react while the player is typing — otherwise entering a name
      // pans the camera with WASD, pings the map with 1-4, and space snaps to
      // base instead of producing a space.
      if (isTypingInto(e)) return;
      this._keys[e.code] = true;
      if (!this._enabled) return;
      switch (e.code) {
        case 'Space':  e.preventDefault(); this.focusBase(); break;
        case 'Tab':    e.preventDefault(); this.cycleFocus(); break;
        case 'KeyF':   this.doDefend(); break;
        case 'Escape': this._sel.clear(); break;

        // Squad management. These were advertised in the controls list but
        // never actually bound — the commands existed, nothing called them.
        case 'KeyX':   this.doSplit(); break;
        case 'KeyC':   this.doMerge(); break;
        case 'KeyV':   this.doBalance(); break;

        // Map pings — a small fixed vocabulary instead of text chat. Gives most
        // of the coordination value without needing moderation, reporting and
        // profanity filtering at scale.
        case 'Digit1': this.pingAt('attack');  break;
        case 'Digit2': this.pingAt('defend');  break;
        case 'Digit3': this.pingAt('help');    break;
        case 'Digit4': this.pingAt('retreat'); break;
      }
    });
    window.addEventListener('keyup', e => { this._keys[e.code] = false; });
  }

  _onMouseDown(e) {
    if (!this._enabled) return;
    if (e.button === 2) { this._unselect(); return; }
    if (e.button !== 0) return;
    this._drag = { x: e.clientX, y: e.clientY };
    this._boxing = false;
  }

  _onMouseMove(e) {
    // Tracked so map pings land where the cursor is, not where you last clicked.
    this._mouse = { x: e.clientX, y: e.clientY };
    if (!this._drag) return;
    const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
    if (!this._boxing && dx * dx + dy * dy > 36) this._boxing = true;
    if (this._boxing) {
      const x = Math.min(this._drag.x, e.clientX), y = Math.min(this._drag.y, e.clientY);
      const s = this._selBox.style;
      s.display = 'block';
      s.left = x + 'px'; s.top = y + 'px';
      s.width = Math.abs(dx) + 'px'; s.height = Math.abs(dy) + 'px';
    }
  }

  _onMouseUp(e) {
    if (e.button !== 0 || !this._drag) return;
    const start = this._drag;
    this._drag = null;
    this._selBox.style.display = 'none';
    if (!this._enabled) { this._boxing = false; return; }
    if (this._boxing) {
      this._boxing = false;
      this._boxSelect(start.x, start.y, e.clientX, e.clientY);
      return;
    }
    this._handleClick(e.clientX, e.clientY);
  }

  _boxSelect(sx1, sy1, sx2, sy2) {
    const a = this._screenToWorld(Math.min(sx1, sx2), Math.min(sy1, sy2));
    const b = this._screenToWorld(Math.max(sx1, sx2), Math.max(sy1, sy2));
    const w = this._world;
    const picked = [];
    for (const g of w.groupsOf(w.playerId)) {
      for (const id of g.memberIds) {
        const s = w.soldiers.get(id);
        if (s && s.position.x >= a.x && s.position.x <= b.x &&
                 s.position.y >= a.y && s.position.y <= b.y) { picked.push(g.id); break; }
      }
    }
    this._sel.set(picked);
    this._cam.focusType = 'free';
    this._cam.focusId = null;
  }

  _handleClick(sx, sy) {
    const w = this._world;
    const wp = this._screenToWorld(sx, sy);

    // Clicking one of your own soldiers selects its squad.
    const ownSol = this._hitOwnSoldier(wp);
    if (ownSol) {
      const g = w.groups.get(ownSol.groupId);
      if (g) { this.focusGroup(g); return; }
    }

    const sel = this.selectedGroups();
    if (!sel.length) return;
    const ids = sel.map(g => g.id);

    // Team mode: clicking a teammate's base donates a soldier to them.
    if (w.mode === 'team') {
      const mate = this._hitTeammateBase(wp);
      if (mate) {
        const src = sel.find(g => !g.locked && g.memberIds.length > 0);
        if (src) this._send({ t: 'donate', g: src.id, to: mate.ownerId });
        return;
      }
    }

    // Clicking an enemy commits every selected squad to attacking it.
    const enemy = this._hitEnemy(wp);
    if (enemy) { this._send({ t: 'attack', g: ids, target: enemy.id }); return; }

    // Mining mode: clicking a node garrisons it.
    if (w.mode === 'mining') {
      const node = this._hitMineNode(wp);
      if (node) { this._send({ t: 'defendNode', g: ids, node: node.id }); return; }
    }

    // Empty ground: move there.
    this._send({ t: 'move', g: ids, x: wp.x, y: wp.y });
    this._markOrder(wp.x, wp.y);
  }

  /** Show the destination immediately, before the simulation has confirmed it. */
  _markOrder(x, y) {
    this.pendingOrders.push({ x, y, at: performance.now() });
  }

  // ── Actions the HUD buttons also trigger ───────────────────────────────────
  doDefend()  { const ids = this._sel.ids; if (ids.length) this._send({ t: 'defend', g: ids }); }
  doSplit()   { const g = this.selectedGroup(); if (g) this._send({ t: 'split', g: g.id }); }
  doMerge()   { const g = this.selectedGroup(); if (g) this._send({ t: 'merge', g: g.id }); }
  doBalance() { this._send({ t: 'balance' }); }

  // ── Hit testing ────────────────────────────────────────────────────────────
  _screenToWorld(sx, sy) {
    const cam = this._cam;
    return {
      x: (sx - cam.width / 2) / cam.zoom + cam.x,
      y: (sy - cam.height / 2) / cam.zoom + cam.y,
    };
  }

  _hitOwnSoldier(wp) {
    const w = this._world;
    let best = null, bestD2 = 20 * 20;
    for (const [, s] of w.soldiers) {
      if (s.ownerId !== w.playerId || s.hp <= 0) continue;
      const d2 = dist2(s.position, wp);
      if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
  }

  _hitTeammateBase(wp) {
    const w = this._world;
    const me = w.playerId, myTeam = w.teamOf(me);
    if (!myTeam) return null;
    const ring2 = BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS;
    for (const [, p] of w.players) {
      if (!p.alive || p.id === me || p.team !== myTeam) continue;
      if (dist2(p.base.position, wp) < ring2) return p.base;
    }
    return null;
  }

  _hitEnemy(wp) {
    const w = this._world;
    const me = w.playerId;
    // An enemy base first: clicking anywhere inside its defence ring targets the
    // base, so soldiers milling around it never steal the click.
    const ring2 = BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS;
    for (const [, p] of w.players) {
      if (!p.alive || !w.areEnemies(me, p.id)) continue;
      if (dist2(p.base.position, wp) < ring2) return p.base;
    }
    for (const [, s] of w.soldiers) {
      if (s.hp <= 0 || !w.areEnemies(me, s.ownerId)) continue;
      if (dist2(s.position, wp) < 16 * 16) return s;
    }
    if (w.boss && dist2(w.boss.position, wp) < 45 * 45) return w.boss;
    return null;
  }

  _hitMineNode(wp) {
    let best = null, bestD2 = (MINE_NODE_RADIUS + 20) ** 2;
    for (const [, n] of this._world.mineNodes) {
      const d2 = dist2(n.position, wp);
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    }
    return best;
  }
}
