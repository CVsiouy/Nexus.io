import { dist2 } from '../../utils/helpers.js';
import { MIN_ZOOM, MAX_ZOOM, MINE_NODE_RADIUS } from '../constants.js';
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
    this._bindEvents();
  }

  update(dt) { /* camera follow handled in Game loop */ }

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

  /** Whole-map overview from the centre (the default view). */
  focusFree() {
    this._deselectAll();
    const cam = this._cam;
    cam.focusType = 'free';
    cam.focusId   = null;
    cam.x = WORLD_SIZE / 2;
    cam.y = WORLD_SIZE / 2;
    cam.zoom = Math.max(MIN_ZOOM, Math.min(cam.width / WORLD_SIZE, cam.height / WORLD_SIZE) * 0.95);
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
      switch (e.code) {
        case 'Space': e.preventDefault(); this.focusBase(); break;   // snap to mother base
        case 'Tab':   e.preventDefault(); this.cycleFocus(); break;  // cycles … → squads → overview
        case 'KeyF':  this._doDefend(); break;
        case 'Escape': this._deselectAll(); break;
      }
    });
  }

  _onMouseDown(e) {
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
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.11;
    this._cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._cam.zoom * factor));
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
    // Enemy soldier (not a teammate)
    for (const [, s] of state.soldiers) {
      if (s.hp <= 0 || !state.areEnemies(me, s.ownerId)) continue;
      if (dist2(s.position, wp) < 16 * 16) return s;
    }
    // Enemy base (not a teammate)
    for (const [, p] of state.players) {
      if (!p.alive || !state.areEnemies(me, p.id)) continue;
      if (dist2(p.base.position, wp) < 46 * 46) return p.base;
    }
    // Boss
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
