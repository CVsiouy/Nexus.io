import { dist2 } from '../../utils/helpers.js';
import { MIN_ZOOM, MAX_ZOOM, WORLD_SIZE, CENTER_RADIUS, MINE_NODE_RADIUS, BASE_DEFENSE_RADIUS } from '../constants.js';
import {
  moveGroup, attackWithGroup, setDefending, setDefendNode,
  splitGroup, mergeGroup, balanceGroups,
} from './GroupSystem.js';

/**
 * InputSystem
 * ───────────
 * Group-based control. The player commands one squad at a time and the camera
 * only ever shows the mother base OR one formation (no free roaming):
 *
 *   Left-click own squad  → select it (camera focuses it)
 *   Left-click enemy/base  → selected squad attacks (locks until target dies)
 *   Left-click ground      → selected squad moves there
 *   Space                  → focus the mother base
 *   Tab                    → cycle focus through base + your squads
 *   X split · C merge · V balance · F defend
 */
export class InputSystem {
  constructor(app, worldContainer, camera, state) {
    this._app   = app;
    this._wc    = worldContainer;
    this._cam   = camera;
    this._state = state;
    this._keys  = {}; // held keys for WASD/arrow panning
    this._drag  = null; // { x, y } screen pos of the current left-drag start
    this._boxing = false;

    // Drag-selection rectangle (screen-space overlay).
    this._selBox = document.createElement('div');
    this._selBox.style.cssText = 'position:fixed;border:1.5px solid #3399ff;background:rgba(51,153,255,0.12);pointer-events:none;display:none;z-index:50;';
    document.body.appendChild(this._selBox);

    this._bindEvents();
  }

  // WASD / arrow keys pan the map (switches to free look so it doesn't snap back).
  update(dt) {
    const cam = this._cam;
    let mx = 0, my = 0;
    const k = this._keys;
    if (k['KeyW'] || k['ArrowUp'])    my -= 1;
    if (k['KeyS'] || k['ArrowDown'])  my += 1;
    if (k['KeyA'] || k['ArrowLeft'])  mx -= 1;
    if (k['KeyD'] || k['ArrowRight']) mx += 1;
    if (mx === 0 && my === 0) return;
    if (mx && my) { const inv = 1 / Math.sqrt(2); mx *= inv; my *= inv; }
    const pan = 600 * dt; // world px/sec (gentle, fixed — zoom is fixed too)
    cam.focusType = 'free';
    cam.focusId   = null;
    cam.x = Math.max(0, Math.min(WORLD_SIZE, cam.x + mx * pan));
    cam.y = Math.max(0, Math.min(WORLD_SIZE, cam.y + my * pan));
  }

  // ── Focus control ────────────────────────────────────────────────────────
  focusBase() {
    this._cam.focusType = 'base';
    this._cam.focusId   = null;
    this._deselectAll();
  }

  focusGroup(g) {
    this._deselectAll();
    g.selected = true;
    this._cam.focusType = 'group';
    this._cam.focusId   = g.id;
  }

  /** Deselect the current squad and stop the camera following it — but stay put. */
  _unselect() {
    this._deselectAll();
    this._cam.focusType = 'free';
    this._cam.focusId   = null;
    // NOTE: deliberately does NOT recentre — the view stays where it is.
  }

  /** Whole-map overview from the centre (the default view). */
  focusFree() {
    this._deselectAll();
    const cam = this._cam;
    cam.focusType = 'free';
    cam.focusId   = null;
    cam.x = WORLD_SIZE / 2;
    cam.y = WORLD_SIZE / 2;
    cam.zoom = (cam.width / WORLD_SIZE) * 0.98; // fixed wide view — whole map width
  }

  cycleFocus() {
    const groups = this._state.groupsOf(this._state.playerId);
    // Order: overview → base → g0 → g1 → … → overview
    if (this._cam.focusType === 'free') { this.focusBase(); return; }
    if (this._cam.focusType === 'base') {
      if (groups[0]) this.focusGroup(groups[0]); else this.focusFree();
      return;
    }
    const idx = groups.findIndex(g => g.id === this._cam.focusId);
    const next = groups[idx + 1];
    if (next) this.focusGroup(next);
    else this.focusFree();
  }

  selectedGroup() { return this.selectedGroups()[0] || null; }

  /** All currently-selected player squads (box-select supports many at once). */
  selectedGroups() {
    return this._state.groupsOf(this._state.playerId).filter(g => g.selected);
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  _bindEvents() {
    const canvas = this._app.view;
    canvas.addEventListener('mousedown',   e => this._onMouseDown(e));
    canvas.addEventListener('mousemove',   e => this._onMouseMove(e));
    canvas.addEventListener('wheel',       e => this._onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('mouseup',     e => this._onMouseUp(e));

    window.addEventListener('keydown', e => {
      this._keys[e.code] = true;
      switch (e.code) {
        case 'Space': e.preventDefault(); this.focusBase(); break;   // snap to mother base
        case 'Tab':   e.preventDefault(); this.cycleFocus(); break;  // cycles … → squads → overview
        case 'KeyF':  this._doDefend(); break;
        case 'Escape': this._deselectAll(); break;
      }
    });
    window.addEventListener('keyup', e => { this._keys[e.code] = false; });
  }

  _onMouseDown(e) {
    if (e.button === 2) { this._unselect(); return; } // right-click = just unselect (camera stays)
    if (e.button !== 0) return;
    this._drag = { x: e.clientX, y: e.clientY };       // begin click-or-drag
    this._boxing = false;
  }

  _onMouseMove(e) {
    if (!this._drag) return;
    const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
    if (!this._boxing && dx * dx + dy * dy > 36) this._boxing = true; // moved enough → a box drag
    if (this._boxing) {
      const x = Math.min(this._drag.x, e.clientX), y = Math.min(this._drag.y, e.clientY);
      const w = Math.abs(dx), h = Math.abs(dy);
      const s = this._selBox.style;
      s.display = 'block'; s.left = x + 'px'; s.top = y + 'px'; s.width = w + 'px'; s.height = h + 'px';
    }
  }

  _onMouseUp(e) {
    if (e.button !== 0 || !this._drag) return;
    const start = this._drag; this._drag = null;
    this._selBox.style.display = 'none';
    if (this._boxing) { this._boxing = false; this._boxSelect(start.x, start.y, e.clientX, e.clientY); return; }
    this._handleClick(e.clientX, e.clientY); // it was a click, not a drag
  }

  /** Select every player squad with a soldier inside the drag box. */
  _boxSelect(sx1, sy1, sx2, sy2) {
    const a = this._screenToWorld(Math.min(sx1, sx2), Math.min(sy1, sy2));
    const b = this._screenToWorld(Math.max(sx1, sx2), Math.max(sy1, sy2));
    const state = this._state;
    for (const g of state.groupsOf(state.playerId)) {
      let inside = false;
      for (const id of g.memberIds) {
        const s = state.soldiers.get(id);
        if (s && s.position.x >= a.x && s.position.x <= b.x && s.position.y >= a.y && s.position.y <= b.y) { inside = true; break; }
      }
      g.selected = inside;
    }
    this._cam.focusType = 'free'; this._cam.focusId = null; // don't follow a single squad
  }

  /** A plain left-click: select a squad, or command all selected squads. */
  _handleClick(sx, sy) {
    const state = this._state;
    const wp    = this._screenToWorld(sx, sy);

    // Click one of your own soldiers → single-select its squad + focus it.
    const ownSol = this._hitOwnSoldier(state, wp);
    if (ownSol) {
      const g = state.groups.get(ownSol.groupId);
      if (g) { this.focusGroup(g); return; }
    }

    const sel = this.selectedGroups();
    if (!sel.length) return;

    // Team mode: click a TEAMMATE base → donate one soldier (it walks over).
    if (state.mode === 'team') {
      const mate = this._hitTeammateBase(state, wp);
      if (mate) { this._donateAt(mate, sel); return; }
    }

    // Click an enemy (base/soldier/boss) → ALL selected squads attack it.
    const enemy = this._hitEnemy(state, wp);
    if (enemy) { for (const g of sel) attackWithGroup(g, enemy.id); return; }

    // Mining mode: click a node → all selected squads garrison it.
    if (state.mode === 'mining') {
      const node = this._hitMineNode(state, wp);
      if (node) { for (const g of sel) setDefendNode(g, node); return; }
    }

    // Empty ground → all selected squads move there.
    for (const g of sel) moveGroup(g, wp.x, wp.y);
  }

  // ── Team donations ──────────────────────────────────────────────────────────
  _hitTeammateBase(state, wp) {
    const me = state.playerId, myTeam = state.teamOf(me);
    if (!myTeam) return null;
    const ring2 = BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS;
    for (const [, p] of state.players) {
      if (!p.alive || p.id === me || p.team !== myTeam) continue;
      if (dist2(p.base.position, wp) < ring2) return p.base;
    }
    return null;
  }

  /** Peel one soldier off a selected squad and send it walking to the teammate. */
  _donateAt(mateBase, sel) {
    const state = this._state;
    let src = sel.find(g => !g.locked && g.memberIds.length > 0);
    if (!src) src = state.groupsOf(state.playerId).filter(g => !g.locked)
                          .sort((a, b) => b.memberIds.length - a.memberIds.length)[0];
    if (!src || !src.memberIds.length) return;
    const id = src.memberIds.pop();
    const s = state.soldiers.get(id);
    if (!s) return;
    s.groupId  = null;
    s.donateTo = mateBase.ownerId; // GroupSystem walks it over and transfers it
  }

  _onWheel(e) {
    e.preventDefault(); // zoom disabled — the view is a fixed wide overview
  }

  // ── Group operations ─────────────────────────────────────────────────────
  _doSplit() {
    const g = this.selectedGroup();
    if (!g) return;
    const ng = splitGroup(this._state, g);
    if (ng) this._state.notify('✂️ Squad split in two', 'success', 'player');
    else    this._state.notify('❌ Can\'t split (locked or too small)', 'warning', 'player');
  }

  _doMerge() {
    const g = this.selectedGroup();
    if (!g) return;
    const merged = mergeGroup(this._state, g);
    if (merged) { this.focusGroup(merged); this._state.notify('🔗 Squads merged', 'success', 'player'); }
    else this._state.notify('❌ No friendly squad close enough to merge', 'warning', 'player');
  }

  _doBalance() {
    if (balanceGroups(this._state, this._state.playerId))
      this._state.notify('⚖️ Squads balanced', 'success', 'player');
    else this._state.notify('❌ Need two free squads to balance', 'warning', 'player');
  }

  _doDefend() {
    const base = this._state.getPlayerBase(this._state.playerId);
    for (const g of this.selectedGroups()) setDefending(g, base);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  _screenToWorld(sx, sy) {
    const cam = this._cam;
    return {
      x: (sx - cam.width  / 2) / cam.zoom + cam.x,
      y: (sy - cam.height / 2) / cam.zoom + cam.y,
    };
  }

  _deselectAll() {
    for (const [, g] of this._state.groups)
      if (g.ownerId === this._state.playerId) g.selected = false;
  }

  _hitOwnSoldier(state, wp) {
    let best = null, bestD2 = 20 * 20;
    for (const [, s] of state.soldiers) {
      if (s.ownerId !== state.playerId || s.hp <= 0) continue;
      const d2 = dist2(s.position, wp);
      if (d2 < bestD2) { bestD2 = d2; best = s; }
    }
    return best;
  }

  _hitEnemy(state, wp) {
    const me = state.playerId;
    // 1. Enemy base FIRST — clicking anywhere inside a base's defense ring targets
    //    the base itself; soldiers milling around it never steal the click.
    const ring2 = BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS;
    for (const [, p] of state.players) {
      if (!p.alive || !state.areEnemies(me, p.id)) continue;
      if (dist2(p.base.position, wp) < ring2) return p.base;
    }
    // 2. Otherwise an enemy soldier out in the open.
    for (const [, s] of state.soldiers) {
      if (s.hp <= 0 || !state.areEnemies(me, s.ownerId)) continue;
      if (dist2(s.position, wp) < 16 * 16) return s;
    }
    // 3. Boss.
    if (state.boss && dist2(state.boss.position, wp) < 45 * 45) return state.boss;
    return null;
  }

  _hitMineNode(state, wp) {
    let best = null, bestD2 = (MINE_NODE_RADIUS + 20) ** 2;
    for (const [, n] of state.mineNodes) {
      const d2 = dist2(n.position, wp);
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    }
    return best;
  }
}
