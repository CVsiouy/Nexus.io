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

  selectedGroup() {
    for (const g of this._state.groupsOf(this._state.playerId))
      if (g.selected) return g;
    return null;
  }

  // ── Events ─────────────────────────────────────────────────────────────────
  _bindEvents() {
    const canvas = this._app.view;
    canvas.addEventListener('mousedown',   e => this._onMouseDown(e));
    canvas.addEventListener('wheel',       e => this._onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

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
    if (e.button !== 0) return; // only left-click issues orders
    const state = this._state;
    const wp    = this._screenToWorld(e.clientX, e.clientY);

    // 1. Click one of your own soldiers → select its squad + focus it.
    const ownSol = this._hitOwnSoldier(state, wp);
    if (ownSol) {
      const g = state.groups.get(ownSol.groupId);
      if (g) { this.focusGroup(g); return; }
    }

    const sel = this.selectedGroup();
    if (!sel) return;

    if (sel.locked) {
      state.notify('🔒 This squad is committed — it can\'t be recalled', 'warning', 'player');
      return;
    }

    // 2. Click an enemy (soldier / base / boss) → attack (locks the squad).
    const enemy = this._hitEnemy(state, wp);
    if (enemy) {
      attackWithGroup(sel, enemy.id);
      state.notify('⚔️ Squad committed to the attack!', 'info', 'player');
      return;
    }

    // 3. Mining mode: click a node → garrison & orbit it (captures by presence,
    //    then defends it like the mother base).
    if (state.mode === 'mining') {
      const node = this._hitMineNode(state, wp);
      if (node) { setDefendNode(sel, node); return; }
    }

    // 4. Click empty ground → move there.
    moveGroup(sel, wp.x, wp.y);
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
    const g = this.selectedGroup();
    if (!g) return;
    const base = this._state.getPlayerBase(this._state.playerId);
    if (setDefending(g, base)) this._state.notify('🛡️ Squad heading back to defend the mother base', 'success', 'player');
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
