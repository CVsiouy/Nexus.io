import { dist2, WORLD_SIZE, MINE_NODE_RADIUS, BASE_DEFENSE_RADIUS } from '@basewar/sim';
import { clampCamera } from './CameraController.js';
import { pickTarget, MOUSE_CONFIG, TOUCH_CONFIG } from './hitTest.js';
import { GestureRecognizer } from './GestureRecognizer.js';
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
    // A half-finished gesture must not survive into the next match.
    this._gest?.reset();
  }

  update(dt) {
    // Expire optimistic markers.
    const now = performance.now();
    // Watchdog for a pointer the OS dropped without an up or cancel.
    this._gest?.tick(now);
    if (this.pendingOrders.length)
      this.pendingOrders = this.pendingOrders.filter(o => now - o.at < 600);

    const cam = this._cam;
    let mx = 0, my = 0;
    const k = this._keys;
    if (k['KeyW'] || k['ArrowUp'])    my -= 1;
    if (k['KeyS'] || k['ArrowDown'])  my += 1;
    if (k['KeyA'] || k['ArrowLeft'])  mx -= 1;
    if (k['KeyD'] || k['ArrowRight']) mx += 1;

    // The on-screen joystick feeds the SAME path as WASD rather than getting a
    // mover of its own, so the two can never drift apart in speed or in the
    // focusType bookkeeping below. Note this must be folded in ABOVE the
    // early-return: putting it after would mean the joystick silently did
    // nothing whenever no key was also held, which is always.
    const stick = this._stick;
    if (stick && (stick.x || stick.y)) { mx += stick.x; my += stick.y; }

    if (mx === 0 && my === 0) return;

    // Normalise so diagonal panning isn't ~1.41x faster. The joystick already
    // delivers a vector of magnitude <= 1, so only clamp if the combination
    // overshoots rather than forcing it to unit length (which would make a
    // gently-held stick pan at full speed).
    const mag = Math.hypot(mx, my);
    if (mag > 1) { mx /= mag; my /= mag; }

    const pan = 600 * dt;
    cam.focusType = 'free';
    cam.focusId = null;
    cam.x += mx * pan;
    cam.y += my * pan;

    // Clamp the VISIBLE RECT, not the centre point. The old bound was
    // [0, WORLD_SIZE] on cam.x/y, which let you pan until the world was almost
    // entirely off screen and you were staring at empty background.
    clampCamera(cam);
  }

  /** Called by the on-screen joystick. `x`/`y` are each in [-1, 1]. */
  setStick(x, y) { this._stick = (x || y) ? { x, y } : null; }

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

  /**
   * Drop the selection and stop following whatever it was following.
   *
   * Public because Game.js owns the Escape key now — see the note on the
   * keydown switch below. Deliberately does NOT recentre: the view stays where
   * it is, so deselecting never costs you your place on the map.
   */
  unselect() {
    this._sel.clear();
    this._cam.focusType = 'free';
    this._cam.focusId = null;
  }

  /** @deprecated internal alias kept so existing call sites keep working. */
  _unselect() { this.unselect(); }

  /** Does the player currently have anything selected? */
  hasSelection() { return this._sel.size > 0; }

  /** Injected by Game after construction — owns zoom and camera bounds. */
  setCameraController(ctl) { this._camCtl = ctl; }

  /**
   * The canvas rect is cached because reading it forces layout, and
   * _screenToWorld runs on every pointer move. Invalidated on resize.
   *
   * It is needed at all because raw clientX/Y only equals canvas-relative
   * coordinates while the canvas sits at viewport (0,0) and fills it. That held
   * before viewport-fit=cover; with safe-area insets in play it no longer does,
   * and taps would land tens of pixels off on a notched phone.
   */
  invalidateCanvasRect() { this._canvasRect = null; }

  _rect() {
    if (!this._canvasRect) {
      this._canvasRect = this._app.view.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    }
    return this._canvasRect;
  }

  focusFree() {
    this._sel.clear();
    const cam = this._cam;
    cam.focusType = 'free';
    cam.focusId = null;
    cam.x = WORLD_SIZE / 2;
    cam.y = WORLD_SIZE / 2;
    this._camCtl?.fit();
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

    /*
     * POINTER events, not mouse + touch.
     *
     * Adding touchstart alongside mousedown would have fired every tap TWICE,
     * because browsers synthesise compatibility mouse events from taps.
     * Suppressing those needs preventDefault() on touchstart, which in turn
     * breaks legitimate scrolling on the HUD panels. Pointer events remove the
     * whole problem structurally: one stream, with e.pointerType telling us
     * which device it came from.
     *
     * And the branch is on the EVENT, never on the device — which is what makes
     * a hybrid laptop behave correctly with no special-casing. Trackpad gives
     * mouse behaviour, finger gives touch behaviour, in the same session.
     */
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse') this._onMouseDown(e);
      else this._onTouchDown(e);
    });
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') this._onMouseMove(e);
      else this._onTouchMove(e);
    });
    window.addEventListener('pointerup', e => {
      if (e.pointerType === 'mouse') this._onMouseUp(e);
      else this._onTouchUp(e);
    });
    // Fired when a system gesture steals the touch — an edge swipe, a
    // notification banner, an incoming call. Must never be treated as a lift.
    window.addEventListener('pointercancel', e => {
      if (e.pointerType !== 'mouse') this._onTouchCancel(e);
    });

    canvas.addEventListener('wheel',       e => e.preventDefault(), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

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

        // NO Escape case here — deliberately.
        //
        // It used to clear the selection from this switch while Game.js ALSO
        // toggled the pause menu from its own keydown listener. Both fired on
        // one press: you lost your selection AND the pause modal opened. Worse,
        // this path called the bare _sel.clear(), which left cam.focusType
        // pointing at the squad you had just deselected, so the camera kept
        // following it — while right-click's unselect() reset it properly.
        // Two routes to "deselect", two different outcomes.
        //
        // Game.js now owns Escape and makes it contextual: deselect if anything
        // is selected, otherwise pause. One key, one effect, and both deselect
        // routes go through unselect().

        // Split (X), Merge (C), Even (V) and the 1-4 map pings were removed.
        // They were rarely-used verbs competing for space with the three that
        // matter, and on a phone they turned the action bar into a menu.
        // The server still understands the commands; nothing here sends them.
      }
    });
    window.addEventListener('keyup', e => { this._keys[e.code] = false; });
  }

  // ── Touch ──────────────────────────────────────────────────────────────────

  /** Built lazily so a desktop session never allocates it. */
  _recognizer() {
    if (this._gest) return this._gest;
    this._gest = new GestureRecognizer({
      onTap:       (x, y) => this._handleClick(x, y, true),
      onBoxMove:   (x0, y0, x, y) => this._drawSelBox(x0, y0, x, y),
      onBoxEnd:    (x0, y0, x, y) => { this._hideSelBox(); this._boxSelect(x0, y0, x, y); },
      onBoxCancel: () => this._hideSelBox(),
      // No modifier key exists on a touchscreen, so deselect-all needs a
      // gesture of its own. The dock also carries a visible ✕, because a
      // two-finger tap is not something a player discovers unprompted.
      onTwoFingerTap: () => this.unselect(),
    });
    return this._gest;
  }

  _onTouchDown(e) {
    if (!this._enabled) return;
    // Capture so a drag that leaves the canvas still delivers its moves and up.
    try { this._app.view.setPointerCapture?.(e.pointerId); } catch { /* not fatal */ }
    this._recognizer().down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  }
  _onTouchMove(e) {
    if (!this._gest) return;
    this._gest.move(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  }
  _onTouchUp(e) {
    if (!this._gest) return;
    if (!this._enabled) { this._gest.reset(); this._hideSelBox(); return; }
    this._gest.up(e.pointerId, e.clientX, e.clientY, e.timeStamp);
  }
  _onTouchCancel(e) {
    if (!this._gest) return;
    this._gest.cancel(e.pointerId, e.timeStamp);
  }

  _drawSelBox(x0, y0, x, y) {
    const s = this._selBox.style;
    s.display = 'block';
    s.left   = Math.min(x0, x) + 'px';
    s.top    = Math.min(y0, y) + 'px';
    s.width  = Math.abs(x - x0) + 'px';
    s.height = Math.abs(y - y0) + 'px';
  }
  _hideSelBox() { this._selBox.style.display = 'none'; }

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

  /**
   * A click or tap landed. `touch` selects the finger-friendly hit config and
   * the additive-selection rules.
   */
  _handleClick(sx, sy, touch = false) {
    const w = this._world;
    const wp = this._screenToWorld(sx, sy);
    const cfg = touch ? TOUCH_CONFIG : MOUSE_CONFIG;

    // One resolution step for every kind of target, so the "what did they mean"
    // decision lives in exactly one place — see hitTest.js for why touch
    // resolves nearest-wins while the mouse keeps the historical fixed order.
    const hit = pickTarget(w, wp, this._cam.zoom, cfg);

    // Tapping your own soldier selects its squad.
    if (hit?.kind === 'ownSoldier') {
      const g = w.groups.get(hit.entity.groupId);
      if (!g) return;

      if (!touch) { this.focusGroup(g); return; }

      // Touch selection is ADDITIVE, because there is no modifier key to hold.
      //   nothing selected  → select it and follow it
      //   already selected  → toggle it off (drop one squad without clearing)
      //   something else    → add to the selection, and stop following, since
      //                       following one of several squads is meaningless
      if (this._sel.has(g.id)) {
        this._sel.delete?.(g.id);
        if (!this._sel.size) this.unselect();
        return;
      }
      if (!this._sel.size) { this.focusGroup(g); return; }
      this._sel.add(g.id);
      this._cam.focusType = 'free';
      this._cam.focusId = null;
      return;
    }

    const sel = this.selectedGroups();
    if (!sel.length) return;
    const ids = sel.map(g => g.id);

    // Team mode: tapping a teammate's base donates a soldier to them.
    if (hit?.kind === 'teammateBase') {
      const src = sel.find(g => !g.locked && g.memberIds.length > 0);
      if (src) this._send({ t: 'donate', g: src.id, to: hit.entity.ownerId });
      return;
    }

    // Tapping an enemy commits every selected squad to attacking it.
    if (hit?.kind === 'enemy') {
      this._send({ t: 'attack', g: ids, target: hit.entity.id });
      // Attack and defendNode used to return with no optimistic marker at all,
      // so on touch — where you have no cursor and no hover — a correct order
      // read as "my tap did nothing" until the squad visibly turned.
      this._markOrder(hit.entity.position.x, hit.entity.position.y, 'attack');
      return;
    }

    // Mining mode: tapping a node sends the squad to hold it.
    if (hit?.kind === 'mineNode') {
      this._send({ t: 'defendNode', g: ids, node: hit.entity.id });
      this._markOrder(hit.entity.position.x, hit.entity.position.y, 'node');
      return;
    }

    // Empty ground: move there.
    this._send({ t: 'move', g: ids, x: wp.x, y: wp.y });
    this._markOrder(wp.x, wp.y, 'move');
  }

  /** Show the destination immediately, before the simulation has confirmed it. */
  _markOrder(x, y, kind = 'move') {
    this.pendingOrders.push({ x, y, kind, at: performance.now() });
  }

  // ── Actions the HUD buttons also trigger ───────────────────────────────────
  doDefend()  { const ids = this._sel.ids; if (ids.length) this._send({ t: 'defend', g: ids }); }

  // ── Hit testing ────────────────────────────────────────────────────────────
  /**
   * Viewport (clientX/Y) coordinates → world coordinates.
   *
   * The rect subtraction is not decoration. Raw clientX/Y only equals
   * canvas-relative coordinates while the canvas sits at viewport (0,0) and
   * fills it — an invariant that held before `viewport-fit=cover`, and does not
   * once safe-area insets can offset the canvas. Without this, taps on a
   * notched phone land tens of pixels away from where the finger actually was.
   */
  _screenToWorld(sx, sy) {
    const cam = this._cam;
    const r = this._rect();
    const cx = sx - (r.left || 0);
    const cy = sy - (r.top || 0);
    return {
      x: (cx - cam.width / 2) / cam.zoom + cam.x,
      y: (cy - cam.height / 2) / cam.zoom + cam.y,
    };
  }

}
