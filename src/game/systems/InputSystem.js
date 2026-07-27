import { pointSegDist2, dist2 } from '../../utils/helpers.js';
import { FormationSystem } from './FormationSystem.js';

const LINK_CLICK_DIST = 16;

/**
 * InputSystem  (formation model)
 * ──────────────────────────────
 * The camera is LOCKED to the active view (base or a formation) — there is no
 * free pan/zoom/edge-scroll any more. The player commands the ACTIVE formation:
 *
 *   Left-click empty ground      → active formation moves there
 *   Left-click enemy unit/base   → active formation attacks it
 *   Left-click enemy/neutral node→ (if reachable) formation attacks/claims
 *   Left-click unclaimed node    → active formation goes to claim it
 *   Left-click own formation     → make THAT formation the active view
 *   Right-click                  → set active formation to DEFEND that spot
 *
 * Hotkeys:  Space = view base · Tab = cycle view · F = split active formation
 */
export class InputSystem {
  constructor(app, worldContainer, camera, state) {
    this._app   = app;
    this._wc    = worldContainer;
    this._cam   = camera;
    this._state = state;
    this.keys   = {};
    this.game   = null;   // set by Game after construction (for view switching)
    this._bindEvents();
  }

  // Camera is fully driven by Game._updateLockedCamera now — nothing to do here,
  // but keep the method so the game loop call is harmless.
  update(/* dt */) {}

  // Box-select removed in the formation model.
  getBoxRect() { return null; }
  get isBoxing() { return false; }

  _bindEvents() {
    const canvas = this._app.view;
    canvas.addEventListener('mousedown',   e => this._onMouseDown(e));
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel',       e => e.preventDefault(), { passive: false }); // zoom locked

    window.addEventListener('keydown', e => {
      this.keys[e.code] = true;
      if (e.code === 'Space') { e.preventDefault(); this._viewBase(); }
      if (e.code === 'Tab')   { e.preventDefault(); this.game?.cycleView(); }
      if (e.code === 'KeyF')  { e.preventDefault(); this._splitActive(); }
    });
    window.addEventListener('keyup', e => { this.keys[e.code] = false; });
  }

  _onMouseDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    const state = this._state;
    const wp    = this._screenToWorld(e.clientX, e.clientY);

    // Right-click → DEFEND that spot with the active formation.
    if (e.button === 2) {
      const f = this._activeFormation();
      if (f) {
        f.order = { kind: 'defend', targetId: null, position: { ...wp } };
        state.notify('🛡️ Formation holding position', 'info', 'player');
      }
      return;
    }

    // Left-click priority:
    // 1) Click one of YOUR formations → make it the active view.
    const ownF = this._hitOwnFormation(state, wp);
    if (ownF) { this._viewFormation(ownF.id); return; }

    // 2) Click your BASE → view base.
    const base = this._hitBase(state, wp);
    if (base && base.ownerId === state.playerId) { this._viewBase(); return; }

    const f = this._activeFormation();
    if (!f) {
      state.notify('No formation to command — spawn grunts first', 'info', 'player');
      return;
    }

    // 3) Click an enemy soldier / enemy base → attack.
    const enemySol = this._hitEnemySoldier(state, wp);
    if (enemySol) { f.order = { kind: 'attack', targetId: enemySol.id, position: null }; return; }
    if (base && base.ownerId !== state.playerId) { f.order = { kind: 'attack', targetId: base.id, position: null }; return; }

    // 4) Click a node.
    const node = this._hitNode(state, wp, true);
    if (node) {
      if (node.ownerId && node.ownerId !== state.playerId && node.status === 'claimed') {
        // Enemy node → attack it.
        f.order = { kind: 'attack', targetId: node.id, position: null };
        return;
      }
      // Unclaimed / neutral / own-orphaned → claim it (territory rule enforced at completion).
      if (node.status !== 'claimed') {
        if (!state.canClaim(node, state.playerId)) {
          state.notify('❌ Too close to an enemy node to claim there', 'warning', 'player');
          return;
        }
        f.order = { kind: 'claim', targetId: node.id, position: null };
        state.notify('⛏️ Formation moving to claim', 'info', 'player');
        return;
      }
    }

    // 5) Click an enemy link → attack.
    const link = this._hitLink(state, wp);
    if (link && link.ownerId !== state.playerId) {
      f.order = { kind: 'attack', targetId: link.id, position: null };
      return;
    }

    // 6) Empty ground → move the active formation there.
    f.order = { kind: 'move', targetId: null, position: { ...wp } };
  }

  // ── View switching ─────────────────────────────────────────────────────
  _viewBase()            { this.game?.setView('base'); }
  _viewFormation(id)     { this.game?.setView('formation', id); }
  _splitActive() {
    const f = this._activeFormation();
    if (!f) return;
    const nf = FormationSystem.split(this._state, f.id);
    if (nf) this._state.notify('✂️ Formation split', 'success', 'player');
    else    this._state.notify('Need at least 2 grunts to split', 'info', 'player');
  }

  _activeFormation() {
    const state = this._state;
    if (state.activeFormationId) return state.formations.get(state.activeFormationId) || null;
    // Default to the home formation if none active.
    for (const [, f] of state.formations) if (f.ownerId === state.playerId) return f;
    return null;
  }

  // ── Hit tests ─────────────────────────────────────────────────────────
  _screenToWorld(sx, sy) {
    const cam = this._cam;
    return {
      x: (sx - cam.width  / 2) / cam.zoom + cam.x,
      y: (sy - cam.height / 2) / cam.zoom + cam.y,
    };
  }

  _hitOwnFormation(state, wp) {
    let best = null, bestD2 = 60 * 60; // generous click radius around a formation
    for (const [, f] of state.formations) {
      if (f.ownerId !== state.playerId || f.memberIds.size === 0) continue;
      const d2 = dist2(f.center, wp);
      if (d2 < bestD2) { bestD2 = d2; best = f; }
    }
    return best;
  }

  _hitEnemySoldier(state, wp) {
    for (const [, sol] of state.soldiers) {
      if (sol.ownerId === state.playerId || sol.hp <= 0) continue;
      if (dist2(sol.position, wp) < 16 * 16) return sol;
    }
    return null;
  }

  _hitBase(state, wp) {
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      if (dist2(player.base.position, wp) < 40 * 40) return player.base;
    }
    return null;
  }

  _hitNode(state, wp, includeUnclaimed = false) {
    let best = null, bestD2 = 24 * 24;
    for (const [, node] of state.nodeSites) {
      if (!includeUnclaimed && node.status === 'unclaimed') continue;
      const d2 = dist2(node.position, wp);
      if (d2 < bestD2) { bestD2 = d2; best = node; }
    }
    return best;
  }

  _hitLink(state, wp) {
    for (const [, link] of state.links) {
      const from = state.resolve(link.fromId);
      const to   = state.resolve(link.toId);
      if (!from || !to) continue;
      const d2 = pointSegDist2(wp.x, wp.y, from.position.x, from.position.y, to.position.x, to.position.y);
      if (d2 < LINK_CLICK_DIST * LINK_CLICK_DIST) return link;
    }
    return null;
  }
}
