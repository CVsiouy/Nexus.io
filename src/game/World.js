import { poissonDisc }   from '../utils/PoissonDisc.js';
import { weightedRandom } from '../utils/helpers.js';
import { Base, GraphNode, Eatable } from './entities.js';
import {
  WORLD_SIZE, MIN_NODE_DIST, EATABLE_DEFS,
  EATABLE_TARGET, BOT_COUNT, BOT_COLORS, PLAYER_COLOR,
  LINK_RANGE,
} from './constants.js';

const MARGIN = 300;
// Bases are placed in an outer ring — 35–48% from centre radius
const OUTER_BAND_MIN = 0.35;
const OUTER_BAND_MAX = 0.48;

/**
 * Builds the initial world state and populates a GameState.
 *
 * Key design decisions:
 *  - Nodes are generated globally via Poisson-disc, ensuring even coverage
 *  - Each base gets a guaranteed cluster of nodes within link range so players
 *    can immediately start claiming without hunting across the map
 */
export function buildWorld(state) {
  const W = WORLD_SIZE;

  // ── 1. Generate global node sites ────────────────────────────────────────
  const pts = poissonDisc(W, W, MIN_NODE_DIST);
  for (const p of pts) {
    const node = new GraphNode(p.x, p.y);
    state.nodeSites.set(node.id, node);
  }

  // ── 2. Place player base ──────────────────────────────────────────────────
  const playerBase = _spawnBase(state, 'player', PLAYER_COLOR, [], W);
  _ensureLocalNodes(state, playerBase.position, W);

  state.notify('⚡ Select a soldier → click a nearby node to claim it!', 'info', 'player');
  state.notify('✂️ Sever enemy trunk links to orphan their network!', 'info', 'player');

  // ── 3. Place bot bases ───────────────────────────────────────────────────
  const placedBases = [playerBase];
  for (let i = 0; i < BOT_COUNT; i++) {
    const color = BOT_COLORS[i % BOT_COLORS.length];
    const tiers = ['passive', 'passive', 'standard', 'standard', 'standard', 'aggressive'];
    const tier  = tiers[i % tiers.length];
    const botBase = _spawnBase(state, `bot_${i}`, color, placedBases, W, tier);
    placedBases.push(botBase);
    _ensureLocalNodes(state, botBase.position, W);
  }

  // ── 4. Spawn eatables ─────────────────────────────────────────────────────
  for (let i = 0; i < EATABLE_TARGET; i++) {
    _spawnEatable(state, W);
  }
}

/**
 * Guarantee at least 6 node sites within LINK_RANGE of a base position.
 * If Poisson-disc didn't produce enough nearby nodes, generate extra ones.
 */
function _ensureLocalNodes(state, basePos, W) {
  const NEEDED = 8;
  const range  = LINK_RANGE * 0.85; // place within 85% of link range for comfort

  // Count existing nodes within range
  let count = 0;
  for (const [, node] of state.nodeSites) {
    const dx = node.position.x - basePos.x;
    const dy = node.position.y - basePos.y;
    if (dx * dx + dy * dy < range * range) count++;
  }

  // Add guaranteed nodes
  const minDist = 80; // min spacing for guaranteed nodes
  const attempts = 60;
  while (count < NEEDED) {
    for (let a = 0; a < attempts; a++) {
      const angle = Math.random() * Math.PI * 2;
      const r     = 100 + Math.random() * (range - 100);
      const nx    = Math.max(MARGIN, Math.min(W - MARGIN, basePos.x + Math.cos(angle) * r));
      const ny    = Math.max(MARGIN, Math.min(W - MARGIN, basePos.y + Math.sin(angle) * r));

      // Check min spacing from existing nodes
      let tooClose = false;
      for (const [, nd] of state.nodeSites) {
        const dx = nd.position.x - nx, dy = nd.position.y - ny;
        if (dx * dx + dy * dy < minDist * minDist) { tooClose = true; break; }
      }
      if (!tooClose) {
        const node = new GraphNode(nx, ny);
        state.nodeSites.set(node.id, node);
        count++;
        break;
      }
    }
    if (count >= NEEDED) break;
    // Safety: avoid infinite loop if map too dense
    count = NEEDED;
  }
}

function _spawnBase(state, id, color, existing, W, botTier = null) {
  const isBot    = id !== 'player';
  const attempts = 300;
  let pos;

  for (let a = 0; a < attempts; a++) {
    const angle = Math.random() * Math.PI * 2;
    const r     = (OUTER_BAND_MIN + Math.random() * (OUTER_BAND_MAX - OUTER_BAND_MIN)) * W / 2;
    const cx    = Math.max(MARGIN, Math.min(W - MARGIN, W / 2 + Math.cos(angle) * r));
    const cy    = Math.max(MARGIN, Math.min(W - MARGIN, W / 2 + Math.sin(angle) * r));

    // Must be far enough from existing bases
    const tooClose = existing.some(b => {
      const dx = b.position.x - cx, dy = b.position.y - cy;
      return dx * dx + dy * dy < 750 * 750;
    });
    if (!tooClose) { pos = { x: cx, y: cy }; break; }
  }
  if (!pos) {
    pos = { x: MARGIN + Math.random() * (W - MARGIN * 2), y: MARGIN + Math.random() * (W - MARGIN * 2) };
  }

  const base = new Base(id, pos.x, pos.y);
  state.bases.set(base.id, base);

  const player = {
    id,
    isBot,
    botTier,
    base,
    color,
    alive:       true,
    pendingXP:   0,
    // Skill-point buffs (points spent per stat → multipliers applied live)
    buffs:       { atk: 0, def: 0, spd: 0 },
    _brain:      isBot ? _makeBrain() : null,
    _thinkTimer: 0,
  };
  state.players.set(id, player);

  return base;
}

function _makeBrain() {
  return {
    phase:         'expand',
    attackTarget:  null,
    stagingNode:   null,
    thinkCooldown: 0,
  };
}

export function spawnEatable(state) {
  _spawnEatable(state, WORLD_SIZE);
}

function _spawnEatable(state, W) {
  const x = MARGIN + Math.random() * (W - MARGIN * 2);
  const y = MARGIN + Math.random() * (W - MARGIN * 2);

  const cx = W / 2, cy = W / 2;
  const normDist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (W / 2);
  let weights;
  if (normDist < 0.25)       weights = { 1: 20, 2: 30, 3: 30, 4: 20 };
  else if (normDist < 0.45)  weights = { 1: 35, 2: 35, 3: 22, 4: 8  };
  else                       weights = { 1: 55, 2: 30, 3: 12, 4: 3  };

  const type = parseInt(weightedRandom(weights));
  const eat  = new Eatable(type, x, y);
  state.eatables.set(eat.id, eat);
}
