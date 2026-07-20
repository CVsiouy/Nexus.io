import { pointSegDist2, dist2 } from '../../utils/helpers.js';
import { MIN_ZOOM, MAX_ZOOM, WORLD_SIZE } from '../constants.js';

const LINK_CLICK_DIST = 14; // pixels in world space

/**
 * InputSystem
 * ───────────
 * Handles all player mouse/keyboard input.
 * Converts screen → world coordinates and dispatches orders to soldiers.
 */
export class InputSystem {
  constructor(app, worldContainer, camera, state) {
    this._app   = app;
    this._wc    = worldContainer;
    this._cam   = camera;
    this._state = state;

    this.boxStart    = null; // { x, y } in screen space
    this.boxCurrent  = null;
    this.isBoxing    = false;
    this.isDragging  = false; // camera drag (middle-click or space+drag)
    this.dragStart   = null;
    this.keys        = {};

    this.onSpecialization = null; // callback

    this._bindEvents();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /** Call from game loop to handle held keys */
  update(dt) {
    const cam = this._cam;
    const pan = 400 * dt / cam.zoom;
    if (this.keys['KeyW'] || this.keys['ArrowUp'])    { cam.y -= pan; cam.follow = false; }
    if (this.keys['KeyS'] || this.keys['ArrowDown'])  { cam.y += pan; cam.follow = false; }
    if (this.keys['KeyA'] || this.keys['ArrowLeft'])  { cam.x -= pan; cam.follow = false; }
    if (this.keys['KeyD'] || this.keys['ArrowRight']) { cam.x += pan; cam.follow = false; }

    // Clamp
    cam.x = Math.max(0, Math.min(WORLD_SIZE, cam.x));
    cam.y = Math.max(0, Math.min(WORLD_SIZE, cam.y));
  }

  getBoxRect() {
    if (!this.isBoxing || !this.boxStart || !this.boxCurrent) return null;
    return {
      x:  Math.min(this.boxStart.x, this.boxCurrent.x),
      y:  Math.min(this.boxStart.y, this.boxCurrent.y),
      w:  Math.abs(this.boxCurrent.x - this.boxStart.x),
      h:  Math.abs(this.boxCurrent.y - this.boxStart.y),
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _bindEvents() {
    const canvas = this._app.view;

    canvas.addEventListener('mousedown', e => this._onMouseDown(e));
    canvas.addEventListener('mousemove', e => this._onMouseMove(e));
    canvas.addEventListener('mouseup',   e => this._onMouseUp(e));
    canvas.addEventListener('wheel',     e => this._onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('keydown', e => {
      this.keys[e.code] = true;
      if (e.code === 'Space') {
        e.preventDefault();
        this._cam.follow = true;
      }
      if (e.code === 'Escape') {
        this._deselectAll();
      }
    });
    window.addEventListener('keyup',   e => { this.keys[e.code] = false; });
  }

  _onMouseDown(e) {
    const state = this._state;
    const wp    = this._screenToWorld(e.clientX, e.clientY);

    if (e.button === 1) {
      // Middle click drag
      this.isDragging = true;
      this.dragStart  = { x: e.clientX, y: e.clientY, cx: this._cam.x, cy: this._cam.y };
      this._cam.follow = false;
      return;
    }

    if (e.button === 2) {
      // Right-click = attack-move to position
      const selected = this._getSelected(state);
      if (selected.length > 0) {
        for (const sol of selected) {
          sol.order = { kind: 'attackMove', targetId: null, position: { ...wp } };
        }
      }
      return;
    }

    if (e.button === 0) {
      // Left click — could be box-select start or click-to-select/order
      this.boxStart   = { x: e.clientX, y: e.clientY };
      this.boxCurrent = { x: e.clientX, y: e.clientY };
      this.isBoxing   = false; // will become true if mouse moves enough
    }
  }

  _onMouseMove(e) {
    if (this.isDragging && this.dragStart) {
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      this._cam.x = this.dragStart.cx - dx / this._cam.zoom;
      this._cam.y = this.dragStart.cy - dy / this._cam.zoom;
      this._cam.follow = false;
      return;
    }
    if (this.boxStart) {
      const dx = e.clientX - this.boxStart.x;
      const dy = e.clientY - this.boxStart.y;
      if (dx * dx + dy * dy > 100) this.isBoxing = true;
      this.boxCurrent = { x: e.clientX, y: e.clientY };
    }
  }

  _onMouseUp(e) {
    if (e.button === 1) { this.isDragging = false; this.dragStart = null; return; }

    if (e.button === 0) {
      const state = this._state;
      const wp    = this._screenToWorld(e.clientX, e.clientY);

      if (this.isBoxing) {
        // Box-select friendly soldiers
        const rect = this.getBoxRect();
        if (rect) {
          const wTL = this._screenToWorld(rect.x, rect.y);
          const wBR = this._screenToWorld(rect.x + rect.w, rect.y + rect.h);
          this._deselectAll();
          for (const [, sol] of state.soldiers) {
            if (sol.ownerId !== state.playerId) continue;
            if (sol.position.x >= wTL.x && sol.position.x <= wBR.x &&
                sol.position.y >= wTL.y && sol.position.y <= wBR.y) {
              sol.selected = true;
            }
          }
        }
      } else {
        // Single click
        this._handleClick(state, wp, e);
      }

      this.boxStart   = null;
      this.boxCurrent = null;
      this.isBoxing   = false;
    }
  }

  _handleClick(state, wp, e) {
    const selected = this._getSelected(state);
    const player   = state.players.get(state.playerId);
    if (!player?.alive) return;

    // Priority 1: click on a friendly soldier → select it
    const clickedFriend = this._hitSoldier(state, wp, state.playerId);
    if (clickedFriend) {
      if (!e.shiftKey) this._deselectAll();
      clickedFriend.selected = !clickedFriend.selected;
      return;
    }

    // Priority 2 (if soldiers selected): click on a target to issue orders
    if (selected.length > 0) {
      // Enemy soldier?
      const enemySol = this._hitEnemySoldier(state, wp);
      if (enemySol) { this._issueAttack(selected, enemySol.id); return; }

      // Enemy/neutral base?
      const base = this._hitBase(state, wp);
      if (base && base.ownerId !== state.playerId) {
        if (!player.base.spawnProtected || base.ownerId !== null) {
          this._issueAttack(selected, base.id); return;
        }
      }

      // Enemy node?
      const node = this._hitNode(state, wp);
      if (node && node.ownerId !== state.playerId && node.ownerId !== null) {
        this._issueAttack(selected, node.id); return;
      }

      // Enemy link?
      const link = this._hitLink(state, wp);
      if (link && link.ownerId !== state.playerId) {
        this._issueAttack(selected, link.id); return;
      }

      // Unclaimed/neutral node site → claim order
      const unclaimedNode = this._hitNode(state, wp, true);
      if (unclaimedNode && (unclaimedNode.ownerId === null || unclaimedNode.status === 'neutral')) {
        // Check if in range of a player anchor
        if (this._inLinkRange(state, player, unclaimedNode)) {
          for (const sol of selected) {
            sol.order = { kind: 'claim', targetId: unclaimedNode.id, position: null };
          }
          return;
        }
      }

      // Orphaned friendly node → reclaim
      if (unclaimedNode && unclaimedNode.ownerId === state.playerId && unclaimedNode.status === 'orphaned') {
        for (const sol of selected) {
          sol.order = { kind: 'claim', targetId: unclaimedNode.id, position: null };
        }
        return;
      }

      // Click eatable → harvest
      const eat = this._hitEatable(state, wp);
      if (eat) {
        for (const sol of selected) {
          sol.order = { kind: 'harvest', targetId: eat.id, position: null };
        }
        return;
      }

      // Click empty ground → move
      for (const sol of selected) {
        sol.order = { kind: 'move', targetId: null, position: { ...wp } };
      }
    } else {
      // No soldiers selected — deselect on empty click
      this._deselectAll();
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.88 : 1.14;
    this._cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._cam.zoom * factor));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _screenToWorld(sx, sy) {
    const cam = this._cam;
    return {
      x: (sx - cam.width  / 2) / cam.zoom + cam.x,
      y: (sy - cam.height / 2) / cam.zoom + cam.y,
    };
  }

  _getSelected(state) {
    const out = [];
    for (const [, sol] of state.soldiers) {
      if (sol.ownerId === state.playerId && sol.selected) out.push(sol);
    }
    return out;
  }

  _deselectAll() {
    for (const [, sol] of this._state.soldiers) sol.selected = false;
  }

  _issueAttack(soldiers, targetId) {
    for (const sol of soldiers) {
      sol.order = { kind: 'attack', targetId, position: null };
    }
  }

  _hitSoldier(state, wp, ownerId) {
    for (const [, sol] of state.soldiers) {
      if (sol.ownerId !== ownerId) continue;
      if (dist2(sol.position, wp) < 14 * 14) return sol;
    }
    return null;
  }

  _hitEnemySoldier(state, wp) {
    for (const [, sol] of state.soldiers) {
      if (sol.ownerId === state.playerId || sol.hp <= 0) continue;
      if (dist2(sol.position, wp) < 14 * 14) return sol;
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
    let best = null, bestD2 = 22 * 22;
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
      const d2 = pointSegDist2(
        wp.x, wp.y,
        from.position.x, from.position.y,
        to.position.x,   to.position.y
      );
      if (d2 < LINK_CLICK_DIST * LINK_CLICK_DIST) return link;
    }
    return null;
  }

  _hitEatable(state, wp) {
    for (const [, eat] of state.eatables) {
      if (dist2(eat.position, wp) < 18 * 18) return eat;
    }
    return null;
  }

  _inLinkRange(state, player, node) {
    const lrange = player.base.linkRange;
    // Check base range
    if (dist2(player.base.position, node.position) < lrange * lrange) return true;
    // Check owned nodes range
    for (const [, n] of state.nodeSites) {
      if (n.ownerId !== player.id || n.status !== 'claimed') continue;
      if (dist2(n.position, node.position) < lrange * lrange) return true;
    }
    return false;
  }
}
