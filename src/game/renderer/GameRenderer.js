import * as PIXI from 'pixi.js';
import { WORLD_SIZE, EATABLE_DEFS, SOLDIER_DEFS, ORPHAN_GRACE, LINK_RANGE } from '../constants.js';
import { hexToCSS } from '../../utils/helpers.js';

const GEAR_TEETH  = 8;
const GRID_SIZE   = 50;   // grid cell size (pixels in world space)

// ── Light palette (diep.io style) ────────────────────────────────────────────
const BG_COLOR     = 0xf4f4f4;  // very light gray
const GRID_COLOR   = 0xd8d8d8;  // subtle grid lines
const SITE_COLOR   = 0xb0b8c8;  // unclaimed node dot
const NEUTRAL_COL  = 0x8895aa;  // neutral node

/**
 * GameRenderer
 * ─────────────
 * Diep.io visual style:
 *  - Light gray background with square grid (like the reference image)
 *  - Crisp, bold shapes with strong outlines
 *  - Only the PLAYER'S own links are rendered (bot links hidden)
 *  - Nodes shown in player color with clean borders
 */
export class GameRenderer {
  constructor(app) {
    this._app = app;

    this.worldContainer = new PIXI.Container();
    app.stage.addChild(this.worldContainer);

    // Draw order layers (lower index = drawn first = behind)
    this._bg      = this._layer(); // grid background (drawn once, static)
    this._range   = this._layer(); // player link-range indicator (faint circle)
    this._sites   = this._layer(); // unclaimed node sites
    this._links   = this._layer(); // PLAYER ONLY links
    this._nodes   = this._layer(); // claimed nodes
    this._bases   = this._layer(); // bases
    this._eat     = this._layer(); // eatables
    this._boss    = this._layer(); // boss
    this._units   = this._layer(); // soldiers
    this._fx      = this._layer(); // effects (claim progress, orphan ring)
    this._box     = this._layer(); // selection box (screen space — added to stage)

    app.stage.addChild(this._box);

    // Static background — drawn once
    this._drawBackground();

    this._particles = [];
  }

  // ── Main render ────────────────────────────────────────────────────────────

  render(state, camera, inputSys) {
    this._applyCamera(camera);

    const t = state.time / 1000;

    this._range.clear();
    this._sites.clear();
    this._links.clear();
    this._nodes.clear();
    this._bases.clear();
    this._eat.clear();
    this._boss.clear();
    this._units.clear();
    this._fx.clear();
    this._box.clear();

    this._drawLinkRange(state);
    this._drawNodeSites(state, t);
    this._drawLinks(state);         // ← player-only
    this._drawNodes(state, t);
    this._drawBases(state, t);
    this._drawEatables(state, t);
    this._drawBoss(state, t);
    this._drawSoldiers(state, t);
    this._drawFormations(state, t);
    this._drawEffects(state, t, inputSys);
    this._drawBoxSelect(inputSys);

    this._updateParticles(t);
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
  }

  // ── Background (drawn once, static) ──────────────────────────────────────

  _drawBackground() {
    const g = this._bg;
    const W = WORLD_SIZE;

    // Base fill
    g.beginFill(BG_COLOR, 1);
    g.drawRect(0, 0, W, W);
    g.endFill();

    // Grid lines — horizontal
    g.lineStyle(1, GRID_COLOR, 1);
    for (let y = 0; y <= W; y += GRID_SIZE) {
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    // Grid lines — vertical
    for (let x = 0; x <= W; x += GRID_SIZE) {
      g.moveTo(x, 0);
      g.lineTo(x, W);
    }

    // World border
    g.lineStyle(4, 0xaaaaaa, 1);
    g.drawRect(0, 0, W, W);
  }

  // ── Player link-range indicator ───────────────────────────────────────────

  _drawLinkRange(state) {
    const g      = this._range;
    const player = state.players.get(state.playerId);
    if (!player?.alive) return;

    const { x, y } = player.base.position;
    const lrange   = player.base.linkRange;

    // Faint dashed-style ring showing where new nodes can be linked
    g.lineStyle(1.5, _cssToHex(hexToCSS(PLAYER_COLOR)), 0.18);
    g.drawCircle(x, y, lrange);

    // Also draw rings from owned nodes
    for (const [, node] of state.nodeSites) {
      if (node.ownerId !== state.playerId || node.status !== 'claimed') continue;
      g.lineStyle(1, _cssToHex(hexToCSS(PLAYER_COLOR)), 0.12);
      g.drawCircle(node.position.x, node.position.y, lrange);
    }
  }

  // ── Node Sites ────────────────────────────────────────────────────────────

  _drawNodeSites(state, t) {
    const g   = this._sites;
    const now = state.time;

    for (const [, node] of state.nodeSites) {
      if (node.status === 'claimed') continue;

      const { x, y } = node.position;

      if (node.status === 'orphaned') {
        const elapsed = now - (node.orphanedAt || now);
        const pulse   = Math.sin(t * 7) * 0.5 + 0.5;
        const player  = state.players.get(node.ownerId);
        const color   = player?.color ?? 0xdd4444;

        // Pulsing red danger ring
        g.lineStyle(2, 0xdd3333, 0.85 * pulse);
        g.drawCircle(x, y, 12 + pulse * 4);
        g.lineStyle(2, color, 0.6);
        g.drawCircle(x, y, 8);
        g.lineStyle(0);
        g.beginFill(color, 0.7);
        g.drawCircle(x, y, 7);
        g.endFill();
        continue;
      }

      if (node.status === 'neutral') {
        // Soft gray — available for reclaiming
        g.lineStyle(2, NEUTRAL_COL, 0.7);
        g.beginFill(0xdde2ea, 0.9);
        g.drawCircle(x, y, 8);
        g.endFill();
        g.lineStyle(0);
        continue;
      }

      // Unclaimed — subtle clickable dots with clear outline
      g.lineStyle(1.5, SITE_COLOR, 0.6);
      g.beginFill(0xeaecf2, 0.85);
      g.drawCircle(x, y, 7);
      g.endFill();
      g.lineStyle(0);
    }
  }

  // ── Links — PLAYER ONLY ───────────────────────────────────────────────────

  _drawLinks(state) {
    const g        = this._links;
    const playerId = state.playerId;
    const player   = state.players.get(playerId);
    if (!player) return;

    const color = player.color;

    for (const [, link] of state.links) {
      // ✅ Only render the human player's own links
      if (link.ownerId !== playerId) continue;
      if (link.hp <= 0) continue;

      const from = state.resolve(link.fromId);
      const to   = state.resolve(link.toId);
      if (!from || !to) continue;

      const hpRatio = link.hp / link.maxHp;

      const x1 = from.position.x, y1 = from.position.y;
      const x2 = to.position.x,   y2 = to.position.y;

      // Wide soft shadow
      g.lineStyle(8, color, 0.15);
      g.moveTo(x1, y1); g.lineTo(x2, y2);

      // Mid glow
      g.lineStyle(4, color, 0.35 * hpRatio);
      g.moveTo(x1, y1); g.lineTo(x2, y2);

      // Sharp core line
      g.lineStyle(2.5, color, 0.95 * hpRatio);
      g.moveTo(x1, y1); g.lineTo(x2, y2);
    }
  }

  // ── Claimed Nodes ──────────────────────────────────────────────────────────

  _drawNodes(state, t) {
    const g        = this._nodes;
    const playerId = state.playerId;

    for (const [, node] of state.nodeSites) {
      if (node.status !== 'claimed') continue;
      const player = state.players.get(node.ownerId);
      if (!player) continue;

      const isMe   = node.ownerId === playerId;
      const color  = player.color;
      const { x, y } = node.position;
      const hpRatio  = node.hp / node.maxHp;
      const r        = 10;

      // Outline (thick border — diep.io style)
      const borderColor = _darken(color, 0.55);
      g.lineStyle(3, borderColor, 1);
      g.beginFill(color, 1);
      g.drawCircle(x, y, r);
      g.endFill();

      // Inner highlight circle
      g.lineStyle(0);
      g.beginFill(0xffffff, 0.22);
      g.drawCircle(x - 2, y - 2, r * 0.45);
      g.endFill();

      // HP ring (only if damaged)
      if (hpRatio < 0.9) {
        const hpCol = hpRatio > 0.5 ? 0x3bce6e : 0xf03030;
        g.lineStyle(2.5, hpCol, 0.9);
        g.arc(x, y, r + 5, -Math.PI / 2, -Math.PI / 2 + hpRatio * Math.PI * 2);
        g.lineStyle(0);
      }

      // Extra glow ring for player's own nodes
      if (isMe) {
        g.lineStyle(1.5, color, 0.3);
        g.drawCircle(x, y, r + 7);
        g.lineStyle(0);
      }

      // Reinforced indicator
      if (node.reinforced) {
        g.lineStyle(2, borderColor, 1);
        g.drawCircle(x, y, r + 4);
        g.lineStyle(0);
      }
    }
  }

  // ── Bases ──────────────────────────────────────────────────────────────────

  _drawBases(state, t) {
    const g = this._bases;

    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const base   = player.base;
      const color  = player.color;
      const border = _darken(color, 0.5);
      const { x, y } = base.position;
      const hpR    = base.hp / base.maxHp;

      // Outer glow ring (subtle)
      g.lineStyle(8, color, 0.12);
      g.drawCircle(x, y, 52);

      // Spawn protection ring
      if (base.spawnProtected) {
        const pulse = Math.sin(t * 3.5) * 0.3 + 0.7;
        g.lineStyle(2.5, 0xffffff, 0.55 * pulse);
        g.drawCircle(x, y, 60);
        g.lineStyle(0);
      }

      // Gear shape
      this._drawGear(g, x, y, base.rotation, color, border, base.level);

      // HP arc
      const hpCol = hpR > 0.55 ? 0x3bce6e : hpR > 0.28 ? 0xf5a623 : 0xf03030;
      g.lineStyle(3.5, hpCol, 0.95);
      g.arc(x, y, 48, -Math.PI / 2, -Math.PI / 2 + hpR * Math.PI * 2);
      g.lineStyle(0);

      // Player arrow indicator
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
    const teeth  = GEAR_TEETH;
    const innerR = 22;
    const outerR = 32 + Math.min(level - 1, 9) * 1.5;
    const pts    = [];

    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2 + rot;
      const r = i % 2 === 0 ? outerR : innerR;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }

    g.lineStyle(3, border, 1);
    g.beginFill(color, 1);
    g.drawPolygon(pts);
    g.endFill();

    // Inner core
    g.lineStyle(2.5, border, 1);
    g.beginFill(_lighten(color, 0.35), 1);
    g.drawCircle(cx, cy, innerR * 0.55);
    g.endFill();
  }

  // ── Eatables ───────────────────────────────────────────────────────────────

  _drawEatables(state, t) {
    const g = this._eat;

    for (const [, eat] of state.eatables) {
      const def   = EATABLE_DEFS[eat.type];
      const { x, y } = eat.position;
      const pulse = Math.sin(t * 1.8 + eat.pulse) * 0.08 + 1;
      const sz    = def.sz * pulse;
      const color = def.color;
      const bord  = _darken(color, 0.5);

      g.lineStyle(2.5, bord, 1);
      g.beginFill(color, 1);

      switch (def.shape) {
        case 'square':
          // Rotated slightly for diep.io aesthetic
          g.drawRect(x - sz, y - sz, sz * 2, sz * 2);
          break;
        case 'triangle':
          g.drawPolygon([x, y - sz * 1.3, x - sz, y + sz * 0.75, x + sz, y + sz * 0.75]);
          break;
        case 'star':
          this._drawStar(g, x, y, sz * 1.6, sz * 0.7);
          break;
      }
      g.endFill();
      g.lineStyle(0);
    }
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

  // ── Boss ───────────────────────────────────────────────────────────────────

  _drawBoss(state, t) {
    if (!state.boss) return;
    const g  = this._boss;
    const b  = state.boss;
    const { x, y } = b.position;
    const sz  = 30;
    const hpR = b.hp / b.maxHp;
    const rot = b.rotation;

    const pulse = Math.sin(t * 3.5) * 0.15 + 1;

    // Outer danger ring
    g.lineStyle(3, 0xcc8800, 0.6);
    g.drawCircle(x, y, sz * 2.2 * pulse);
    g.lineStyle(0);

    // Spiked pentagon shape
    g.lineStyle(4, 0x886600, 1);
    g.beginFill(0xd4a017, 1);
    this._drawStar(g, x, y, sz * 1.5, sz * 0.7);
    g.endFill();
    g.lineStyle(0);

    // HP bar above
    const bw = 70;
    g.beginFill(0xcccccc, 1);
    g.lineStyle(2, 0x888888, 1);
    g.drawRoundedRect(x - bw / 2, y - sz - 22, bw, 8, 4);
    g.endFill();
    g.lineStyle(0);
    g.beginFill(0xd4a017, 1);
    g.drawRoundedRect(x - bw / 2, y - sz - 22, bw * hpR, 8, 4);
    g.endFill();
  }

  // ── Soldiers ───────────────────────────────────────────────────────────────

  _drawSoldiers(state, t) {
    const g = this._units;
    const playerId = state.playerId;

    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0) continue;
      const player = state.players.get(sol.ownerId);
      if (!player) continue;

      const { x, y } = sol.position;
      const facing = sol.facing;

      // Each unit type gets a distinct silhouette so roles read at a glance.
      // Owner colour still identifies the network; only the Saboteur overrides
      // the fill (black) while keeping an owner-coloured outline.
      const sizes = { grunt: 7, harvester: 7, sentinel: 10, saboteur: 5, vanguard: 11 };
      const sz    = sizes[sol.type] ?? 7;
      const fill   = sol.type === 'saboteur' ? 0x1a1a1a : player.color;
      const border = sol.type === 'saboteur' ? player.color : _darken(player.color, 0.5);

      // Selection ring
      if (sol.selected) {
        g.lineStyle(2.5, 0x3399ff, 0.9);
        g.drawCircle(x, y, sz + 7);
        g.lineStyle(0);
      }

      // Stationed marker: a faint dashed-style ring on the guard post (player only)
      if (sol.stationed && sol.ownerId === playerId) {
        g.lineStyle(1.5, _darken(player.color, 0.3), 0.5);
        g.drawCircle(x, y, sz + 4);
        g.lineStyle(0);
      }

      g.lineStyle(2.5, border, 1);
      g.beginFill(fill, 1);

      switch (sol.type) {
        case 'sentinel': {
          // Square = defender / most defensive
          const s = sz;
          g.drawRoundedRect(x - s, y - s, s * 2, s * 2, 3);
          break;
        }
        case 'harvester': {
          // Diamond = worker / gatherer
          g.drawPolygon([x, y - sz, x + sz, y, x, y + sz, x - sz, y]);
          break;
        }
        case 'saboteur': {
          // Small black diamond = stealthy breaker
          g.drawPolygon([x, y - sz, x + sz, y, x, y + sz, x - sz, y]);
          break;
        }
        case 'vanguard': {
          // Hexagon = elite heavy
          const pts = [];
          for (let i = 0; i < 6; i++) {
            const a = facing + i * Math.PI / 3;
            pts.push(x + Math.cos(a) * sz, y + Math.sin(a) * sz);
          }
          g.drawPolygon(pts);
          break;
        }
        default: {
          // Grunt = triangle (barrel-tank) pointing where it faces
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

      // Inner highlight (skip on the dark saboteur so it stays clearly black)
      if (sol.type !== 'saboteur') {
        g.beginFill(0xffffff, 0.18);
        g.drawCircle(x, y, sz * 0.35);
        g.endFill();
      }

      // HP bar (only if damaged, at bottom of unit)
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

  // ── Effects ────────────────────────────────────────────────────────────────

  _drawEffects(state, t, inputSys) {
    const g        = this._fx;
    const playerId = state.playerId;

    // Claim progress arcs (only when the player is the one claiming this node)
    for (const [, node] of state.nodeSites) {
      if (!node.claimerSoldierId || node.claimProgress <= 0) continue;
      // claimerSoldierId now stores the owner id currently claiming the node
      if (node.claimerSoldierId !== playerId) continue;

      const player = state.players.get(playerId);
      const color  = player?.color ?? 0x00bfff;
      const { x, y } = node.position;

      // Progress arc
      g.lineStyle(3.5, color, 0.95);
      g.arc(x, y, 18, -Math.PI / 2, -Math.PI / 2 + node.claimProgress * Math.PI * 2);
      g.lineStyle(0);

      // Pulsing outer ring
      const pulse = Math.sin(t * 7) * 0.3 + 0.7;
      g.lineStyle(1.5, color, 0.35 * pulse);
      g.drawCircle(x, y, 22 + pulse * 3);
      g.lineStyle(0);
    }

    // Orphan timer rings (player's orphaned nodes)
    for (const [, node] of state.nodeSites) {
      if (node.status !== 'orphaned' || node.ownerId !== playerId) continue;
      const elapsed = state.time - (node.orphanedAt || 0);
      const ratio   = Math.max(0, 1 - elapsed / ORPHAN_GRACE);
      const { x, y } = node.position;

      g.lineStyle(3, 0xdd3333, 0.9);
      g.arc(x, y, 20, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
      g.lineStyle(0);
    }
  }

  // ── Formations (player) ─────────────────────────────────────────────────

  _drawFormations(state, t) {
    const g = this._fx;
    const playerId = state.playerId;
    const player   = state.players.get(playerId);
    if (!player || !state.formations) return;
    const color = player.color;

    for (const [, f] of state.formations) {
      if (f.ownerId !== playerId || f.memberIds.size === 0) continue;
      const { x, y } = f.center;
      const active = f.id === state.activeFormationId;

      // Boundary ring around the formation cluster.
      const r = 40;
      g.lineStyle(active ? 3 : 1.5, color, active ? 0.9 : 0.4);
      g.drawCircle(x, y, r);
      g.lineStyle(0);

      // Order tint: attack=red arc, defend=shield ring, claim=amber.
      if (f.order.kind === 'attack') {
        g.lineStyle(2.5, 0xdd3333, 0.8);
        g.drawCircle(x, y, r + 5);
        g.lineStyle(0);
      } else if (f.order.kind === 'defend') {
        const pulse = Math.sin(t * 5) * 0.3 + 0.7;
        g.lineStyle(2, 0x22aa66, 0.7 * pulse);
        g.drawCircle(x, y, r + 5);
        g.lineStyle(0);
      } else if (f.order.kind === 'claim') {
        g.lineStyle(2, 0xf59e0b, 0.8);
        g.drawCircle(x, y, r + 5);
        g.lineStyle(0);
      }

      // Member count label dot.
      g.beginFill(color, active ? 0.95 : 0.6);
      g.drawCircle(x, y - r - 8, 3);
      g.endFill();
    }
  }

  // ── Box select ────────────────────────────────────────────────────────────

  _drawBoxSelect(inputSys) {
    if (!inputSys?.isBoxing) return;
    const rect = inputSys.getBoxRect();
    if (!rect) return;
    const g = this._box;
    g.lineStyle(2, 0x3399ff, 0.9);
    g.beginFill(0x3399ff, 0.08);
    g.drawRect(rect.x, rect.y, rect.w, rect.h);
    g.endFill();
  }

  // ── Particles ─────────────────────────────────────────────────────────────

  _updateParticles(t) {
    const alive = [];
    for (const p of this._particles) {
      p.x  += p.vx * 0.016;
      p.y  += p.vy * 0.016;
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

  // ── Helpers ───────────────────────────────────────────────────────────────

  _layer() {
    const g = new PIXI.Graphics();
    this.worldContainer.addChild(g);
    return g;
  }
}

// ── Color utilities ──────────────────────────────────────────────────────────

/** Darken a hex color by mixing with black at ratio t (0..1) */
function _darken(hex, t) {
  const r = ((hex >> 16) & 0xff) * (1 - t) | 0;
  const g = ((hex >> 8)  & 0xff) * (1 - t) | 0;
  const b = (hex         & 0xff) * (1 - t) | 0;
  return (r << 16) | (g << 8) | b;
}

/** Lighten a hex color by mixing with white at ratio t (0..1) */
function _lighten(hex, t) {
  const r = ((hex >> 16) & 0xff) + (0xff - ((hex >> 16) & 0xff)) * t | 0;
  const g = ((hex >> 8)  & 0xff) + (0xff - ((hex >> 8)  & 0xff)) * t | 0;
  const b = (hex         & 0xff) + (0xff - (hex         & 0xff)) * t | 0;
  return (r << 16) | (g << 8) | b;
}

const PLAYER_COLOR = 0x00bfff;

function _cssToHex(css) {
  return parseInt(css.replace('#', ''), 16);
}
