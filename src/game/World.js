import { poissonDisc }   from '../utils/PoissonDisc.js';
import { weightedRandom, randRange, randInt } from '../utils/helpers.js';
import { Base, GraphNode, Eatable } from './entities.js';
import {
  WORLD_SIZE, MIN_NODE_DIST, EATABLE_DEFS,
  EATABLE_TARGET, BOT_COUNT, BOT_COLORS, PLAYER_COLOR,
} from './constants.js';

const MARGIN = 400;
const OUTER_BAND_MIN = 0.28; // 28-42% radius from centre for base placement
const OUTER_BAND_MAX = 0.42;

/**
 * Builds the initial world state and populates a GameState.
 */
export function buildWorld(state) {
  const W = WORLD_SIZE;

  // ── 1. Generate node sites ────────────────────────────────────────────────
  const pts = poissonDisc(W, W, MIN_NODE_DIST);
  for (const p of pts) {
    const node = new GraphNode(p.x, p.y);
    // Increase rarity of high-value eatables toward centre
    state.nodeSites.set(node.id, node);
  }

  // ── 2. Place player base ──────────────────────────────────────────────────
  const playerBase = _spawnBase(state, 'player', PLAYER_COLOR, [], W);
  state.notify('⚡ Claim node sites to expand your network!', 'info', 'player');
  state.notify('✂️ Sever enemy links to orphan their nodes!', 'info', 'player');

  // ── 3. Place bot bases ───────────────────────────────────────────────────
  const placedBases = [playerBase];
  for (let i = 0; i < BOT_COUNT; i++) {
    const color = BOT_COLORS[i % BOT_COLORS.length];
    const tiers = ['passive', 'passive', 'standard', 'standard', 'standard', 'aggressive'];
    const tier  = tiers[i % tiers.length];
    const botBase = _spawnBase(state, `bot_${i}`, color, placedBases, W, tier);
    placedBases.push(botBase);
  }

  // ── 4. Spawn eatables ─────────────────────────────────────────────────────
  for (let i = 0; i < EATABLE_TARGET; i++) {
    _spawnEatable(state, W);
  }
}

function _spawnBase(state, id, color, existing, W, botTier = null) {
  const isBot    = id !== 'player';
  const attempts = 200;
  let pos;

  for (let a = 0; a < attempts; a++) {
    const angle = Math.random() * Math.PI * 2;
    const r     = (OUTER_BAND_MIN + Math.random() * (OUTER_BAND_MAX - OUTER_BAND_MIN)) * W / 2;
    const cx    = W / 2 + Math.cos(angle) * r;
    const cy    = W / 2 + Math.sin(angle) * r;

    // Must be far enough from existing bases
    const tooClose = existing.some(b => {
      const dx = b.position.x - cx, dy = b.position.y - cy;
      return dx * dx + dy * dy < 700 * 700;
    });
    if (!tooClose) { pos = { x: cx, y: cy }; break; }
  }
  if (!pos) {
    // Fallback: random position
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
    alive:      true,
    pendingXP:  0,
    _brain:     isBot ? _makeBrain() : null,
    _thinkTimer: 0,
  };
  state.players.set(id, player);

  return base;
}

function _makeBrain() {
  return {
    phase:         'expand', // expand | harvest | attack | defend
    attackTarget:  null,     // { type: 'link'|'node'|'base', id }
    stagingNode:   null,
    thinkCooldown: 0,
  };
}

export function spawnEatable(state) {
  _spawnEatable(state, WORLD_SIZE);
}

function _spawnEatable(state, W) {
  // Weighted type based on distance to centre (inner = rarer types)
  const x = MARGIN + Math.random() * (W - MARGIN * 2);
  const y = MARGIN + Math.random() * (W - MARGIN * 2);

  const cx = W / 2, cy = W / 2;
  const normDist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (W / 2);
  // Closer to centre → more type 3 & 4
  let weights;
  if (normDist < 0.25)       weights = { 1: 20, 2: 30, 3: 30, 4: 20 };
  else if (normDist < 0.45)  weights = { 1: 35, 2: 35, 3: 22, 4: 8  };
  else                       weights = { 1: 55, 2: 30, 3: 12, 4: 3  };

  const type  = parseInt(weightedRandom(weights));
  const eat   = new Eatable(type, x, y);
  state.eatables.set(eat.id, eat);
}
