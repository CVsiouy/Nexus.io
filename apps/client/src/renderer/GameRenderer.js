import * as PIXI from 'pixi.js';
import {
  WORLD_SIZE, TURRET_DEFS, WALL_CELL_SIZE, EATABLE_DEFS,
  MINE_NODE_RADIUS, BASE_DEFENSE_RADIUS, cellPositions,
} from '@basewar/sim';

const GEAR_TEETH = 8;
const GRID_SIZE  = 50;

// ── Light palette (diep.io style) ────────────────────────────────────────────
const BG_COLOR   = 0xf4f4f4;
const GRID_COLOR = 0xd8d8d8;

/** Boss guards: neutral gold, matching the boss and its wall. */
const BOSS_GUARD_COLOR = 0xd4a017;

/**
 * GameRenderer — draws the world under a tight, non-roaming camera.
 * Layers: grid → bases → turrets → boss → soldiers → projectiles → fx.
 * There is no fog overlay; reduced visibility comes purely from the zoomed-in,
 * focus-locked camera (see Game loop + InputSystem).
 */
export class GameRenderer {
  constructor(app) {
    this._app = app;
    this.worldContainer = new PIXI.Container();
    app.stage.addChild(this.worldContainer);

    this._bg     = this._layer(); // static grid
    this._ranges = this._layer(); // defend rings
    this._center = this._layer(); // centre eatables + wildlings
    this._bases  = this._layer();
    this._walls  = this._layer(); // defensive wall cells
    this._turr   = this._layer();
    this._boss   = this._layer();
    this._units  = this._layer();
    this._proj   = this._layer();
    this._fx     = this._layer();

    // Names live in their own layer, on top of everything. PIXI.Graphics can
    // only draw shapes, so text needs real Text objects — and those are
    // expensive to create, so we make one per player and reuse it rather than
    // rebuilding them 60 times a second.
    this._labelLayer = new PIXI.Container();
    this.worldContainer.addChild(this._labelLayer);
    this._labels = new Map();

    this._drawBackground();
    this._particles = [];
  }

  /**
   * @param {object} state          WorldView — the interpolated picture of the game
   * @param {object} camera
   * @param {object} selection      Selection — this player's highlighted squads
   * @param {Array}  [pendingOrders] optimistic markers for orders not yet confirmed
   */
  render(state, camera, selection, pendingOrders = [], pings = []) {
    this._applyCamera(camera);
    const t = state.time / 1000;
    this._selection = selection;
    this._pendingOrders = pendingOrders;
    this._pings = pings;

    this._ranges.clear();
    this._center.clear();
    this._bases.clear();
    this._walls.clear();
    this._turr.clear();
    this._boss.clear();
    this._units.clear();
    this._proj.clear();
    this._fx.clear();

    this._drawDefendRings(state);
    this._drawEatables(state, t);
    this._drawWildlings(state, t);
    this._drawMineNodes(state, t);
    this._drawBases(state, t);
    this._drawWalls(state);
    this._drawTurrets(state);
    this._drawBoss(state, t);
    this._drawSoldiers(state);
    this._drawProjectiles(state);
    this._drawGroupMarkers(state);
    this._drawPings();
    this._updateParticles();
    this._drawNames(state, camera);
  }

  /**
   * Player names above each mother base.
   *
   * With eight real people in a match, "who is that red base?" is a question
   * players ask constantly, and a colour alone doesn't answer it.
   */
  _drawNames(state, cam) {
    const seen = new Set();

    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const isMe = player.id === state.playerId;

      let label = this._labels.get(player.id);
      if (!label) {
        label = new PIXI.Text('', {
          fontFamily: 'Rajdhani, Segoe UI, sans-serif',
          fontSize: 15,
          fontWeight: '700',
          fill: 0x334155,
          stroke: 0xffffff,
          strokeThickness: 3,
        });
        label.anchor.set(0.5, 1);
        this._labelLayer.addChild(label);
        this._labels.set(player.id, label);
      }

      const text = isMe ? `${player.name ?? 'You'} (you)` : (player.name ?? player.id);
      if (label.text !== text) label.text = text;
      label.style.fill = isMe ? 0x0077cc : 0x334155;

      // The world is drawn zoomed out, so a label scaled with it would be
      // unreadable. Cancel out the camera zoom to keep a constant size on
      // screen no matter how far out the view is.
      label.scale.set(1 / cam.zoom);
      label.position.set(player.base.position.x, player.base.position.y - 66);
      label.visible = true;
      seen.add(player.id);
    }

    // Hide labels for anyone eliminated, rather than destroying and rebuilding.
    for (const [id, label] of this._labels) if (!seen.has(id)) label.visible = false;
  }

  /**
   * Map pings — "attack here", "help", and so on. They pulse outward and fade
   * over about two seconds, which is long enough to notice and short enough
   * that a spammer can't clutter the map permanently.
   */
  _drawPings() {
    const g = this._fx;
    const now = performance.now();
    const COLORS = { attack: 0xef4444, defend: 0x16a34a, help: 0xf59e0b, retreat: 0x8b5cf6 };

    for (const p of this._pings ?? []) {
      const age = (now - p.at) / 2000;
      if (age >= 1) continue;
      const col = COLORS[p.kind] ?? 0x3399ff;
      const alpha = 1 - age;

      // Three staggered rings so it reads as a pulse, not a static circle.
      for (let i = 0; i < 3; i++) {
        const phase = (age * 2 + i * 0.33) % 1;
        g.lineStyle(2.5, col, alpha * (1 - phase) * 0.9);
        g.drawCircle(p.x, p.y, 6 + phase * 34);
      }
      g.lineStyle(0);
      g.beginFill(col, alpha);
      g.drawCircle(p.x, p.y, 5);
      g.endFill();
    }
  }

  addParticle(x, y, color, count = 6) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 80;
      this._particles.push({
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        color, life: 1, size: 4 + Math.random() * 4,
      });
    }
  }

  // ── Camera ────────────────────────────────────────────────────────────────
  _applyCamera(cam) {
    this.worldContainer.position.set(
      cam.width  / 2 - cam.x * cam.zoom,
      cam.height / 2 - cam.y * cam.zoom,
    );
    this.worldContainer.scale.set(cam.zoom);
    // Keep the grid at a constant SCREEN width. Cheap: no-ops unless zoom
    // actually changed, which without a pinch gesture is rare.
    this._drawBackground(cam.zoom);
  }

  // ── Background ──────────────────────────────────────────────────────────────
  /**
   * The world grid.
   *
   * WHY THE LINE WIDTH IS DIVIDED BY ZOOM
   *
   * This Graphics lives inside `worldContainer`, which is scaled by `cam.zoom`
   * every frame. So a line declared as 1 WORLD unit wide is only 1 screen pixel
   * when zoom happens to be 1 — at a phone's play zoom of ~0.54 it is half a
   * pixel, and at the pre-fix 0.3 it was under a third of one.
   *
   * Sub-pixel lines are a coin toss. With multisampling they render as a faint
   * but CONTINUOUS line; without it, coverage is a binary test against the pixel
   * centre, so some grid lines land on a centre and draw at full strength while
   * their neighbours miss and vanish entirely. Worse, `worldContainer.position`
   * moves in fractional pixels as the camera pans, so WHICH lines survive
   * changes every frame — the grid visibly shimmers and pops.
   *
   * Dividing by zoom pins the line to ~1 screen pixel at any zoom, which is both
   * what it always looked like on desktop and immune to the rasteriser's
   * settings. Same trick the name labels already use (`label.scale.set(1/zoom)`
   * in _drawSoldiers).
   *
   * Cost is nil: there is no pinch gesture, so zoom only changes on fit() and
   * orientation change. `_gridZoom` skips the redraw otherwise.
   */
  _drawBackground(zoom = 1) {
    if (this._gridZoom === zoom) return;
    this._gridZoom = zoom;

    const g = this._bg;
    const W = WORLD_SIZE;
    g.clear();
    g.beginFill(BG_COLOR, 1);
    g.drawRect(0, 0, W, W);
    g.endFill();

    const px = 1 / zoom;                 // one screen pixel, in world units
    g.lineStyle(px, GRID_COLOR, 1);
    for (let y = 0; y <= W; y += GRID_SIZE) { g.moveTo(0, y); g.lineTo(W, y); }
    for (let x = 0; x <= W; x += GRID_SIZE) { g.moveTo(x, 0); g.lineTo(x, W); }

    g.lineStyle(px * 4, 0xaaaaaa, 1);    // world border, 4 screen px
    g.drawRect(0, 0, W, W);
  }

  // ── Defend ring for the player's defending squads ───────────────────────────
  // (Turret range rings intentionally not drawn.)
  _drawDefendRings(state) {
    const g = this._ranges;
    for (const grp of state.groupsOf(state.playerId)) {
      if (grp.status !== 'defending') continue;
      g.lineStyle(1.5, 0x16a34a, 0.22);
      g.drawCircle(grp.anchor.x, grp.anchor.y, 84);
    }
  }

  // ── Bases ──────────────────────────────────────────────────────────────────
  _drawBases(state, t) {
    const g = this._bases;
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const base = player.base;
      const color = player.color;
      const border = _darken(color, 0.5);
      const { x, y } = base.position;
      const hpR = base.hp / base.maxHp;

      g.lineStyle(8, color, 0.12);
      g.drawCircle(x, y, 52);

      // Muster/defense ring — soldiers stationed inside shield the base.
      g.lineStyle(1.5, color, 0.18);
      g.drawCircle(x, y, BASE_DEFENSE_RADIUS);

      if (base.spawnProtected) {
        const pulse = Math.sin(t * 3.5) * 0.3 + 0.7;
        g.lineStyle(2.5, 0xffffff, 0.55 * pulse);
        g.drawCircle(x, y, 60);
        g.lineStyle(0);
      }

      this._drawGear(g, x, y, base.rotation, color, border, base.level);

      const hpCol = hpR > 0.55 ? 0x3bce6e : hpR > 0.28 ? 0xf5a623 : 0xf03030;
      g.lineStyle(3.5, hpCol, 0.95);
      g.arc(x, y, 48, -Math.PI / 2, -Math.PI / 2 + hpR * Math.PI * 2);
      g.lineStyle(0);

      if (player.id === state.playerId) {
        const bob = Math.sin(t * 2.4) * 4;
        g.beginFill(0xffffff, 0.95);
        g.lineStyle(2, 0x555555, 0.7);
        g.drawPolygon([x, y - 64 + bob, x - 6, y - 73 + bob, x + 6, y - 73 + bob]);
        g.lineStyle(0);
        g.endFill();
      }
    }
  }

  _drawGear(g, cx, cy, rot, color, border, level) {
    const teeth = GEAR_TEETH;
    const innerR = 22;
    const outerR = 32 + Math.min(level - 1, 9) * 1.5;
    const pts = [];
    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2 + rot;
      const r = i % 2 === 0 ? outerR : innerR;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.lineStyle(3, border, 1);
    g.beginFill(color, 1);
    g.drawPolygon(pts);
    g.endFill();
    g.lineStyle(2.5, border, 1);
    g.beginFill(_lighten(color, 0.35), 1);
    g.drawCircle(cx, cy, innerR * 0.55);
    g.endFill();
    g.lineStyle(0);
  }

  // ── Defensive walls ──────────────────────────────────────────────────────────
  // Hex cells joined by thick connector bars (no gaps) + a small hex accent on
  // each join. A destroyed cell leaves a real gap. Each cell shows its own HP arc.
  _drawWalls(state) {
    const g = this._walls;
    const R = WALL_CELL_SIZE;
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const base = player.base;
      const color = player.color;
      const border = _darken(color, 0.55);
      for (const layer of base.walls) {
        if (!layer.cells.length) continue;
        const cells = cellPositions(base, layer);   // [{x,y,angle,cell}]
        const bySlot = new Map();
        for (const cp of cells) bySlot.set(cp.cell.slot, cp);

        // 1. Connector bars between ADJACENT present slots → joined, but slimmer pipes.
        g.lineStyle(R * 0.8, border, 1);
        for (const cp of cells) {
          const nb = bySlot.get((cp.cell.slot + 1) % layer.maxCells);
          if (!nb) continue;                        // missing neighbour = a real gap
          g.moveTo(cp.x, cp.y); g.lineTo(nb.x, nb.y);
        }
        g.lineStyle(0);

        // 2. Hex cells + per-cell HP arc.
        for (const cp of cells) {
          const hpR = cp.cell.hp / cp.cell.maxHp;
          g.lineStyle(2.5, border, 1);
          g.beginFill(color, 0.55 + 0.45 * hpR);
          this._poly(g, cp.x, cp.y, 6, R, cp.angle);
          g.endFill();
          g.lineStyle(0);
          if (hpR < 0.99) {
            g.lineStyle(2.5, hpR > 0.5 ? 0x3bce6e : 0xf03030, 0.95);
            g.arc(cp.x, cp.y, R + 3, -Math.PI / 2, -Math.PI / 2 + hpR * Math.PI * 2);
            g.lineStyle(0);
          }
        }

        // 3. Small hex accent centred on each connector.
        for (const cp of cells) {
          const nb = bySlot.get((cp.cell.slot + 1) % layer.maxCells);
          if (!nb) continue;
          const mx = (cp.x + nb.x) / 2, my = (cp.y + nb.y) / 2;
          g.lineStyle(2, border, 1);
          g.beginFill(_lighten(color, 0.15), 1);
          this._poly(g, mx, my, 6, R * 0.55, cp.angle);
          g.endFill();
          g.lineStyle(0);
        }
      }
    }
  }

  // ── Centre eatables (destructible XP shapes) ─────────────────────────────────
  _drawEatables(state, t) {
    const g = this._center;
    for (const [, ea] of state.eatables) {
      const def = EATABLE_DEFS[ea.type];
      if (!def) continue;
      const { x, y } = ea.position;
      const pulse = Math.sin(t * 1.8 + ea.pulse) * 0.06 + 1;
      const sz = def.sz * pulse;
      const hpR = ea.hp / ea.maxHp;
      g.lineStyle(2.5, _darken(def.color, 0.45), 1);
      g.beginFill(def.color, 0.5 + 0.5 * hpR);
      const sides = def.shape === 'triangle' ? 3 : def.shape === 'pentagon' ? 5 : 4;
      this._poly(g, x, y, sides, sz, ea.rot);
      g.endFill();
      g.lineStyle(0);
    }
  }

  // ── Centre wildlings (neutral roaming units) ─────────────────────────────────
  _drawWildlings(state, t) {
    const g = this._center;
    for (const [, w] of state.wildlings) {
      const { x, y } = w.position;
      const hpR = w.hp / w.maxHp;
      g.lineStyle(3, 0x2e1065, 1);
      g.beginFill(0x7c3aed, 1);
      this._drawStar(g, x, y, 20, 9);
      g.endFill();
      g.lineStyle(0);
      g.beginFill(0x1e1b4b, 0.9);
      g.drawCircle(x, y, 6);
      g.endFill();
      if (hpR < 1) {
        const bw = 40;
        g.beginFill(0xcccccc, 0.85);
        g.drawRoundedRect(x - bw / 2, y - 28, bw, 4, 2);
        g.endFill();
        g.beginFill(0x8b5cf6, 1);
        g.drawRoundedRect(x - bw / 2, y - 28, bw * hpR, 4, 2);
        g.endFill();
      }
    }
  }

  // ── Mining nodes (Mining mode) ───────────────────────────────────────────────
  _drawMineNodes(state, t) {
    const g = this._center;
    for (const [, node] of state.mineNodes) {
      const { x, y } = node.position;
      const owner = node.ownerId ? state.players.get(node.ownerId) : null;
      const color = owner ? owner.color : 0x9aa5b1; // neutral grey
      const border = _darken(color, 0.5);
      const rot = node.rot + t * 0.25;

      g.lineStyle(3, border, 1);
      g.beginFill(color, owner ? 0.9 : 0.5);
      this._poly(g, x, y, 6, MINE_NODE_RADIUS, rot);       // hex "cog" body
      g.endFill();
      g.lineStyle(0);
      g.beginFill(0xf5c518, 0.95);                          // gold core
      g.drawCircle(x, y, MINE_NODE_RADIUS * 0.34);
      g.endFill();

      if (node.captureProg > 0 && node.capturingBy) {       // capture progress ring
        const cp = state.players.get(node.capturingBy);
        g.lineStyle(3, cp ? cp.color : 0xffffff, 0.95);
        g.arc(x, y, MINE_NODE_RADIUS + 5, -Math.PI / 2, -Math.PI / 2 + node.captureProg * Math.PI * 2);
        g.lineStyle(0);
      }
    }
  }

  /** Draw a regular n-gon (flat helper used by walls + eatables). */
  _poly(g, cx, cy, n, r, rot = 0) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = rot + i * (Math.PI * 2 / n);
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.drawPolygon(pts);
  }

  // ── Turrets ──────────────────────────────────────────────────────────────────
  _drawTurrets(state) {
    const g = this._turr;
    for (const [, tr] of state.turrets) {
      const def = TURRET_DEFS[tr.type];
      const { x, y } = tr.position;
      // Barrel
      const bl = tr.type === 'missile' ? 20 : 16;
      g.lineStyle(tr.type === 'missile' ? 6 : 4, _darken(def.color, 0.2), 1);
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(tr.aimFacing) * bl, y + Math.sin(tr.aimFacing) * bl);
      // Housing
      g.lineStyle(2, 0x1a2a40, 1);
      g.beginFill(def.color, 1);
      g.drawCircle(x, y, tr.type === 'missile' ? 9 : 7);
      g.endFill();
      g.lineStyle(0);
    }
  }

  // ── Boss ───────────────────────────────────────────────────────────────────
  _drawBoss(state, t) {
    for (const [, boss] of state.bosses) this._drawOneBoss(state, boss, t);
  }

  _drawOneBoss(state, b, t) {
    const g = this._boss;
    const { x, y } = b.position;

    // Its wall ring. Drawn in a neutral gold so it reads as "not anyone's",
    // and cells that have been destroyed simply are not drawn — that gap is a
    // real doorway, and it needs to be obvious where it is.
    for (const layer of b.walls ?? []) {
      const R = 11;
      const bySlot = new Map();
      for (const c of layer.cells) {
        const a = (c.slot / layer.maxCells) * Math.PI * 2 - Math.PI / 2;
        bySlot.set(c.slot, {
          x: x + Math.cos(a) * layer.radius,
          y: y + Math.sin(a) * layer.radius,
          angle: a, cell: c,
        });
      }
      // Connect neighbours that are both still standing.
      g.lineStyle(R * 0.8, 0x8a6d1f, 1);
      for (const [slot, cp] of bySlot) {
        const nb = bySlot.get((slot + 1) % layer.maxCells);
        if (!nb) continue;
        g.moveTo(cp.x, cp.y); g.lineTo(nb.x, nb.y);
      }
      g.lineStyle(0);
      for (const [, cp] of bySlot) {
        const hpR = cp.cell.maxHp ? cp.cell.hp / cp.cell.maxHp : 1;
        g.lineStyle(2.5, 0x6b530f, 1);
        g.beginFill(0xd4a017, 0.45 + 0.55 * hpR);
        this._poly(g, cp.x, cp.y, 6, R, cp.angle);
        g.endFill();
        g.lineStyle(0);
      }
    }
    const sz = 30;
    const hpR = b.hp / b.maxHp;
    const pulse = Math.sin(t * 3.5) * 0.15 + 1;

    g.lineStyle(3, 0xcc8800, 0.6);
    g.drawCircle(x, y, sz * 2.2 * pulse);
    g.lineStyle(4, 0x886600, 1);
    g.beginFill(0xd4a017, 1);
    this._drawStar(g, x, y, sz * 1.5, sz * 0.7);
    g.endFill();
    g.lineStyle(0);

    const bw = 70;
    g.beginFill(0xcccccc, 1);
    g.drawRoundedRect(x - bw / 2, y - sz - 22, bw, 8, 4);
    g.endFill();
    g.beginFill(0xd4a017, 1);
    g.drawRoundedRect(x - bw / 2, y - sz - 22, bw * hpR, 8, 4);
    g.endFill();
  }

  _drawStar(g, cx, cy, outerR, innerR) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? outerR : innerR;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.drawPolygon(pts);
  }

  // ── Soldiers ───────────────────────────────────────────────────────────────
  // Owner colour identifies the network; each type has a distinct silhouette.
  // The Saboteur is the one exception — a black body with an owner-coloured outline.
  _drawSoldiers(state) {
    const g = this._units;
    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0) continue;
      // Boss guards have no player entry — they belong to the objective, not to
      // anyone. Without this they were skipped entirely and fought invisibly.
      const isBossGuard = sol.ownerId === 'boss';
      const player = isBossGuard ? null : state.players.get(sol.ownerId);
      if (!player && !isBossGuard) continue;

      const ownerColor = isBossGuard ? BOSS_GUARD_COLOR : player.color;

      const { x, y } = sol.position;
      const facing = sol.facing;
      const sizes = { grunt: 7, sentinel: 10, saboteur: 5, vanguard: 11 };
      // Guards are drawn a touch larger — they really are tougher than a grunt.
      const sz = (sizes[sol.type] ?? 7) + (isBossGuard ? 2 : 0);
      const fill   = sol.type === 'saboteur' ? 0x1a1a1a : ownerColor;
      const border = sol.type === 'saboteur' ? ownerColor : _darken(ownerColor, 0.5);

      // Selection ring if this soldier's group is selected (player only).
      // Selection now lives on the client — it is not part of the shared game
      // state, so it can never leak onto another player's screen.
      if (sol.ownerId === state.playerId && this._selection?.has(sol.groupId)) {
        g.lineStyle(2, 0x3399ff, 0.8);
        g.drawCircle(x, y, sz + 6);
        g.lineStyle(0);
      }

      g.lineStyle(2.5, border, 1);
      g.beginFill(fill, 1);
      switch (sol.type) {
        case 'sentinel': {
          const s = sz;
          g.drawRoundedRect(x - s, y - s, s * 2, s * 2, 3);
          break;
        }
        case 'saboteur':
          g.drawPolygon([x, y - sz, x + sz, y, x, y + sz, x - sz, y]);
          break;
        case 'vanguard': {
          const pts = [];
          for (let i = 0; i < 6; i++) {
            const a = facing + i * Math.PI / 3;
            pts.push(x + Math.cos(a) * sz, y + Math.sin(a) * sz);
          }
          g.drawPolygon(pts);
          break;
        }
        default: {
          // Grunt = triangle (barrel-tank) pointing where it faces.
          const a1 = facing, a2 = facing + 2.5, a3 = facing - 2.5;
          const back = sz * 0.75;
          g.drawPolygon([
            x + Math.cos(a1) * sz,   y + Math.sin(a1) * sz,
            x + Math.cos(a2) * back, y + Math.sin(a2) * back,
            x + Math.cos(a3) * back, y + Math.sin(a3) * back,
          ]);
        }
      }
      g.endFill();
      g.lineStyle(0);

      // Inner highlight (skip on the dark saboteur so it stays clearly black).
      if (sol.type !== 'saboteur') {
        g.beginFill(0xffffff, 0.18);
        g.drawCircle(x, y, sz * 0.35);
        g.endFill();
      }

      const hpR = sol.hp / sol.maxHp;
      if (hpR < 0.95) {
        const bw = sz * 2.2;
        g.beginFill(0xcccccc, 0.85);
        g.drawRoundedRect(x - bw / 2, y + sz + 3, bw, 4, 2);
        g.endFill();
        const hpCol = hpR > 0.5 ? 0x3bce6e : 0xf03030;
        g.beginFill(hpCol, 1);
        g.drawRoundedRect(x - bw / 2, y + sz + 3, bw * hpR, 4, 2);
        g.endFill();
      }
    }
  }

  // ── Projectiles ──────────────────────────────────────────────────────────────
  _drawProjectiles(state) {
    const g = this._proj;
    for (const [, p] of state.projectiles) {
      const r = p.splash > 0 ? 5 : 3;
      g.beginFill(p.color, 1);
      g.drawCircle(p.position.x, p.position.y, r);
      g.endFill();
    }
  }

  // ── Group markers (attack target line for the selected squad) ────────────────
  _drawGroupMarkers(state) {
    const g = this._fx;

    // Optimistic order markers: drawn the instant the player clicks, before the
    // simulation has confirmed anything. They fade out over ~600ms, by which
    // time the squad's real anchor has moved and taken over visually. This is
    // what makes a click feel instant despite the simulation living elsewhere.
    const now = performance.now();
    for (const o of this._pendingOrders ?? []) {
      const age = (now - o.at) / 600;
      if (age >= 1) continue;
      g.lineStyle(1.5, 0x3399ff, 0.5 * (1 - age));
      g.drawCircle(o.x, o.y, 8 + age * 14);
      g.lineStyle(0);
    }

    const sel = this._selection?.resolve(state) ?? [];
    for (const grp of sel) {
      // A small crosshair at the squad's anchor/target.
      const { x, y } = grp.anchor;
      const col = grp.status === 'attacking' ? 0xef4444
                : grp.status === 'defending' ? 0x16a34a
                : 0x3399ff;
      g.lineStyle(1.5, col, 0.7);
      g.drawCircle(x, y, 10);
      g.moveTo(x - 14, y); g.lineTo(x + 14, y);
      g.moveTo(x, y - 14); g.lineTo(x, y + 14);
      g.lineStyle(0);
    }
  }

  // ── Particles ────────────────────────────────────────────────────────────────
  _updateParticles() {
    const alive = [];
    for (const p of this._particles) {
      p.x += p.vx * 0.016;
      p.y += p.vy * 0.016;
      p.vy += 30 * 0.016;
      p.life -= 0.03;
      if (p.life > 0) alive.push(p);
    }
    this._particles = alive;
    for (const p of this._particles) {
      this._fx.beginFill(p.color, p.life * 0.85);
      this._fx.drawCircle(p.x, p.y, p.size * p.life);
      this._fx.endFill();
    }
  }

  _layer() {
    const g = new PIXI.Graphics();
    this.worldContainer.addChild(g);
    return g;
  }
}

// ── Color utilities ──────────────────────────────────────────────────────────
function _darken(hex, t) {
  const r = ((hex >> 16) & 0xff) * (1 - t) | 0;
  const g = ((hex >> 8)  & 0xff) * (1 - t) | 0;
  const b = (hex         & 0xff) * (1 - t) | 0;
  return (r << 16) | (g << 8) | b;
}
function _lighten(hex, t) {
  const r = ((hex >> 16) & 0xff) + (0xff - ((hex >> 16) & 0xff)) * t | 0;
  const g = ((hex >> 8)  & 0xff) + (0xff - ((hex >> 8)  & 0xff)) * t | 0;
  const b = (hex         & 0xff) + (0xff - (hex         & 0xff)) * t | 0;
  return (r << 16) | (g << 8) | b;
}
