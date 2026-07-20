import * as PIXI from 'pixi.js';
import { WORLD_SIZE, EATABLE_DEFS, SOLDIER_DEFS, ORPHAN_GRACE } from '../constants.js';
import { hexToCSS } from '../../utils/helpers.js';

const GEAR_TEETH  = 8;
const DOT_SPACING = 80;

/**
 * GameRenderer
 * ─────────────
 * Manages all PixiJS drawing. Uses separate Graphics layers for each category.
 * Cleared and redrawn each frame (simple approach, works fine for this scale).
 */
export class GameRenderer {
  constructor(app) {
    this._app = app;

    // World container — everything in world space goes here
    this.worldContainer = new PIXI.Container();
    app.stage.addChild(this.worldContainer);

    // Layers (in draw order — lower = drawn first = behind)
    this._bg      = this._layer(); // static dot background
    this._sites   = this._layer(); // unclaimed node sites
    this._links   = this._layer(); // links (glow)
    this._nodes   = this._layer(); // claimed nodes
    this._bases   = this._layer(); // bases
    this._eat     = this._layer(); // eatables
    this._boss    = this._layer(); // boss
    this._units   = this._layer(); // soldiers
    this._fx      = this._layer(); // effects: selection, claiming progress, orphan ring
    this._box     = this._layer(); // selection box (in screen space)

    // Box selection is in SCREEN space
    app.stage.addChild(this._box);

    // Draw static bg once
    this._drawBackground();

    // Particle effects pool
    this._particles = [];
  }

  // ── Main render call ──────────────────────────────────────────────────────

  render(state, camera, inputSys) {
    this._applyCamera(camera);

    const t = state.time / 1000; // seconds for animations

    this._sites.clear();
    this._links.clear();
    this._nodes.clear();
    this._bases.clear();
    this._eat.clear();
    this._boss.clear();
    this._units.clear();
    this._fx.clear();
    this._box.clear();

    this._drawNodeSites(state, t);
    this._drawLinks(state, camera);
    this._drawNodes(state, t);
    this._drawBases(state, t);
    this._drawEatables(state, t);
    this._drawBoss(state, t);
    this._drawSoldiers(state, t);
    this._drawEffects(state, t, inputSys);
    this._drawBoxSelect(inputSys);

    // Particles
    this._updateParticles(t);
  }

  addParticle(x, y, color, count = 6) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 30 + Math.random() * 60;
      this._particles.push({
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        color, life: 1, size: 3 + Math.random() * 4,
      });
    }
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  _applyCamera(camera) {
    const wc = this.worldContainer;
    wc.position.set(
      camera.width  / 2 - camera.x * camera.zoom,
      camera.height / 2 - camera.y * camera.zoom
    );
    wc.scale.set(camera.zoom);
  }

  // ── Dot background (drawn once) ────────────────────────────────────────────

  _drawBackground() {
    const g = this._bg;
    const W = WORLD_SIZE;
    g.beginFill(0x06060f, 1);
    g.drawRect(0, 0, W, W);
    g.endFill();

    // Subtle dot grid
    for (let x = DOT_SPACING; x < W; x += DOT_SPACING) {
      for (let y = DOT_SPACING; y < W; y += DOT_SPACING) {
        g.beginFill(0x1a1a35, 0.6);
        g.drawCircle(x, y, 1);
        g.endFill();
      }
    }
  }

  // ── Node Sites ────────────────────────────────────────────────────────────

  _drawNodeSites(state, t) {
    const g = this._sites;
    const now = state.time;

    for (const [, node] of state.nodeSites) {
      if (node.status === 'claimed') continue; // drawn in _drawNodes

      const { x, y } = node.position;

      if (node.status === 'orphaned') {
        // Pulsing warning ring
        const elapsed = now - (node.orphanedAt || now);
        const urgency = elapsed / ORPHAN_GRACE;
        const pulse   = Math.sin(t * 6 + urgency * 10) * 0.5 + 0.5;
        const player  = state.players.get(node.ownerId);
        const color   = player?.color ?? 0xffffff;

        g.lineStyle(1.5, 0xff4444, 0.8 * pulse);
        g.drawCircle(x, y, 10 + pulse * 4);
        g.lineStyle(0);
        g.beginFill(color, 0.4 + pulse * 0.3);
        g.drawCircle(x, y, 5);
        g.endFill();
        continue;
      }

      if (node.status === 'neutral') {
        // Neutral — slightly more visible than unclaimed
        g.beginFill(0xaaaacc, 0.25);
        g.drawCircle(x, y, 4);
        g.endFill();
        continue;
      }

      // Unclaimed — pale gray dots (Obsidian reference)
      g.beginFill(0x666688, 0.18);
      g.drawCircle(x, y, 3);
      g.endFill();
    }
  }

  // ── Links ──────────────────────────────────────────────────────────────────

  _drawLinks(state, camera) {
    const g = this._links;

    for (const [, link] of state.links) {
      if (link.hp <= 0) continue;

      const from = state.resolve(link.fromId);
      const to   = state.resolve(link.toId);
      if (!from || !to) continue;

      const player = state.players.get(link.ownerId);
      const color  = player?.color ?? 0xffffff;
      const hpRatio = link.hp / link.maxHp;

      const x1 = from.position.x, y1 = from.position.y;
      const x2 = to.position.x,   y2 = to.position.y;

      // Three-pass glow
      g.lineStyle(10, color, 0.06);
      g.moveTo(x1, y1); g.lineTo(x2, y2);

      g.lineStyle(4, color, 0.2 * hpRatio);
      g.moveTo(x1, y1); g.lineTo(x2, y2);

      g.lineStyle(1.5, color, 0.9 * hpRatio);
      g.moveTo(x1, y1); g.lineTo(x2, y2);
    }
  }

  // ── Claimed Nodes ──────────────────────────────────────────────────────────

  _drawNodes(state, t) {
    const g  = this._nodes;

    for (const [, node] of state.nodeSites) {
      if (node.status !== 'claimed') continue;
      const player = state.players.get(node.ownerId);
      if (!player) continue;
      const color  = player.color;
      const { x, y } = node.position;

      const hpRatio  = node.hp / node.maxHp;

      // Glow ring
      g.lineStyle(6, color, 0.12);
      g.drawCircle(x, y, 14);
      g.lineStyle(2, color, 0.5);
      g.drawCircle(x, y, 10);
      g.lineStyle(0);

      // Fill
      g.beginFill(color, 0.85);
      g.drawCircle(x, y, 7);
      g.endFill();

      // HP indicator (thin arc) - simplified as opacity
      if (hpRatio < 0.8) {
        g.lineStyle(2, 0xff4444, 0.8);
        g.drawCircle(x, y, 10);
        g.lineStyle(0);
      }

      // Reinforced indicator
      if (node.reinforced) {
        g.lineStyle(2, color, 1);
        g.drawCircle(x, y, 13);
        g.lineStyle(0);
      }
    }
  }

  // ── Bases ──────────────────────────────────────────────────────────────────

  _drawBases(state, t) {
    const g = this._bases;

    for (const [, player] of state.players) {
      if (!player.alive) continue;
      const base  = player.base;
      const color = player.color;
      const { x, y } = base.position;
      const rot   = base.rotation;
      const hpR   = base.hp / base.maxHp;

      // Big outer glow
      g.lineStyle(20, color, 0.06);
      g.drawCircle(x, y, 50);
      g.lineStyle(8, color, 0.12);
      g.drawCircle(x, y, 42);

      // Spawn protection ring
      if (base.spawnProtected) {
        const pulse = Math.sin(t * 4) * 0.3 + 0.7;
        g.lineStyle(2, 0xffffff, 0.4 * pulse);
        g.drawCircle(x, y, 55);
        g.lineStyle(0);
      }

      // Gear shape (rotating)
      this._drawGear(g, x, y, rot, color, base.level);

      // HP ring
      g.lineStyle(3, hpR > 0.5 ? 0x4ade80 : hpR > 0.25 ? 0xfbbf24 : 0xf87171, 0.9);
      g.arc(x, y, 44, -Math.PI / 2, -Math.PI / 2 + hpR * Math.PI * 2);
      g.lineStyle(0);

      // Player indicator (dot above)
      if (player.id === state.playerId) {
        const bob = Math.sin(t * 2) * 3;
        g.beginFill(0xffffff, 0.9);
        g.drawPolygon([x, y - 56 + bob, x - 5, y - 62 + bob, x + 5, y - 62 + bob]);
        g.endFill();
      }
    }
  }

  _drawGear(g, cx, cy, rot, color, level) {
    const teeth   = GEAR_TEETH;
    const innerR  = 20;
    const outerR  = 30 + Math.min(level - 1, 9) * 1.5;
    const pts     = [];

    for (let i = 0; i < teeth * 2; i++) {
      const a = (i / (teeth * 2)) * Math.PI * 2 + rot;
      const r = i % 2 === 0 ? outerR : innerR;
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }

    g.lineStyle(2, color, 0.9);
    g.beginFill(color, 0.25);
    g.drawPolygon(pts);
    g.endFill();

    // Inner circle
    g.beginFill(color, 0.6);
    g.drawCircle(cx, cy, innerR * 0.5);
    g.endFill();
  }

  // ── Eatables ───────────────────────────────────────────────────────────────

  _drawEatables(state, t) {
    const g = this._eat;

    for (const [, eat] of state.eatables) {
      const def   = EATABLE_DEFS[eat.type];
      const { x, y } = eat.position;
      const pulse = Math.sin(t * 1.5 + eat.pulse) * 0.15 + 1;
      const sz    = def.sz * pulse;
      const color = def.color;

      g.beginFill(color, 0.9);
      g.lineStyle(1.5, color, 0.5);

      switch (def.shape) {
        case 'square':
          g.drawRect(x - sz, y - sz, sz * 2, sz * 2);
          break;
        case 'triangle':
          g.drawPolygon([x, y - sz * 1.2, x - sz, y + sz * 0.7, x + sz, y + sz * 0.7]);
          break;
        case 'star':
          this._drawStar(g, x, y, sz * 1.5, sz * 0.65);
          break;
      }
      g.endFill();
      g.lineStyle(0);

      // Glow
      g.lineStyle(4, color, 0.1);
      g.drawCircle(x, y, sz + 4);
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
    const rot = b.rotation;
    const sz  = 28;
    const hpR = b.hp / b.maxHp;

    // Pulsing glow
    const pulse = Math.sin(t * 3) * 0.4 + 0.6;
    g.lineStyle(16, 0xffd700, 0.15 * pulse);
    g.drawCircle(x, y, sz + 14);
    g.lineStyle(6, 0xffd700, 0.3);
    g.drawCircle(x, y, sz + 4);
    g.lineStyle(0);

    // Spiked cube
    this._drawStar(g, x, y, sz * 1.6, sz * 0.8);
    g.beginFill(0xffd700, 0.9);
    g.drawRect(x - sz * 0.7, y - sz * 0.7, sz * 1.4, sz * 1.4);
    g.endFill();

    // HP bar
    const bw = 60;
    g.beginFill(0x333333, 0.8);
    g.drawRect(x - bw / 2, y - sz - 18, bw, 6);
    g.endFill();
    g.beginFill(0xffd700, 0.9);
    g.drawRect(x - bw / 2, y - sz - 18, bw * hpR, 6);
    g.endFill();
  }

  // ── Soldiers ───────────────────────────────────────────────────────────────

  _drawSoldiers(state, t) {
    const g = this._units;

    for (const [, sol] of state.soldiers) {
      if (sol.hp <= 0) continue;
      const def    = SOLDIER_DEFS[sol.type];
      const player = state.players.get(sol.ownerId);
      if (!player) continue;
      const color  = player.color;
      const { x, y } = sol.position;
      const facing = sol.facing;

      // Type-specific size
      const sizes = { grunt: 6, harvester: 5, sentinel: 8, saboteur: 5, vanguard: 9 };
      const sz    = sizes[sol.type] ?? 6;

      // Glow for selected
      if (sol.selected) {
        g.lineStyle(3, 0xffffff, 0.6);
        g.drawCircle(x, y, sz + 6);
        g.lineStyle(0);
      }

      // Triangle body (pointing in facing direction)
      const a1 = facing;
      const a2 = facing + 2.4;
      const a3 = facing - 2.4;
      const back = sz * 0.7;
      g.lineStyle(1, color, 0.8);
      g.beginFill(def.color ?? color, 0.9);
      g.drawPolygon([
        x + Math.cos(a1) * sz,   y + Math.sin(a1) * sz,
        x + Math.cos(a2) * back, y + Math.sin(a2) * back,
        x + Math.cos(a3) * back, y + Math.sin(a3) * back,
      ]);
      g.endFill();
      g.lineStyle(0);

      // HP dot (only if damaged)
      const hpR = sol.hp / sol.maxHp;
      if (hpR < 0.9) {
        g.beginFill(hpR > 0.5 ? 0x4ade80 : 0xf87171, 1);
        g.drawCircle(x, y - sz - 3, 2.5);
        g.endFill();
      }
    }
  }

  // ── Effects (selection ring, claim progress, orphan timers) ────────────────

  _drawEffects(state, t, inputSys) {
    const g = this._fx;

    // Claim progress arcs
    for (const [, node] of state.nodeSites) {
      if (!node.claimerSoldierId || node.claimProgress <= 0) continue;
      const player = state.players.get(state.soldiers.get(node.claimerSoldierId)?.ownerId);
      const color  = player?.color ?? 0xffffff;
      const { x, y } = node.position;
      const angle  = node.claimProgress * Math.PI * 2;

      g.lineStyle(3, color, 0.9);
      g.arc(x, y, 15, -Math.PI / 2, -Math.PI / 2 + angle);
      g.lineStyle(0);

      // Channeling pulse ring
      const pulse = Math.sin(t * 6) * 0.4 + 0.6;
      g.lineStyle(1.5, color, 0.4 * pulse);
      g.drawCircle(x, y, 18 + pulse * 3);
      g.lineStyle(0);
    }

    // Orphan timer rings
    for (const [, node] of state.nodeSites) {
      if (node.status !== 'orphaned' || node.ownerId !== state.playerId) continue;
      const elapsed = state.time - (node.orphanedAt || 0);
      const ratio   = 1 - elapsed / 12000;
      const { x, y } = node.position;
      g.lineStyle(2.5, 0xff4444, 0.9);
      g.arc(x, y, 18, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2);
      g.lineStyle(0);
    }
  }

  // ── Box Selection ──────────────────────────────────────────────────────────

  _drawBoxSelect(inputSys) {
    if (!inputSys?.isBoxing) return;
    const rect = inputSys.getBoxRect();
    if (!rect) return;
    const g = this._box;
    g.lineStyle(1.5, 0x00bfff, 0.8);
    g.beginFill(0x00bfff, 0.06);
    g.drawRect(rect.x, rect.y, rect.w, rect.h);
    g.endFill();
  }

  // ── Particles ─────────────────────────────────────────────────────────────

  _updateParticles(t) {
    // Handled via PixiJS Graphics in fx layer — lightweight
    const alive = [];
    for (const p of this._particles) {
      p.x  += p.vx * 0.016;
      p.y  += p.vy * 0.016;
      p.vy += 20 * 0.016;
      p.life -= 0.035;
      if (p.life > 0) alive.push(p);
    }
    this._particles = alive;
    // Draw in fx layer
    for (const p of this._particles) {
      this._fx.beginFill(p.color, p.life * 0.8);
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
