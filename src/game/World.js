import { Base, Soldier, MineNode } from './entities.js';
import { createGroup, setDefending } from './systems/GroupSystem.js';
import { spawnEatable } from './systems/CenterSystem.js';
import {
  WORLD_SIZE, BOT_COUNT, BOT_COLORS, PLAYER_COLOR, EATABLE_TARGET, TEAM_TINTS,
  CENTER_RADIUS, MINE_NODE_COUNT, MINE_NODE_MIN_SEP,
} from './constants.js';

// Bases sit evenly around a ring so the 8 mother bases are spread across the
// map, well outside the neutral centre. The tight camera means you never see
// more than one or two at once.
const RING_RADIUS_FRAC = 0.42;   // ring radius as fraction of world size
const RING_JITTER      = 70;     // px of random wobble so it isn't a perfect circle

/**
 * Builds the initial world: 8 mother bases in a ring, the player's with one
 * black starting grunt. No nodes, links, or resources — the map is otherwise
 * empty grid. Bots and groups are wired up in later systems.
 */
export function buildWorld(state, mode = 'ffa') {
  state.mode = mode;
  const W  = WORLD_SIZE;
  const cx = W / 2, cy = W / 2;
  const R  = W * RING_RADIUS_FRAC;

  const total = BOT_COUNT + 1;                 // player + bots
  const slots = _ringSlots(total, cx, cy, R);
  const tiers = ['passive', 'passive', 'standard', 'standard', 'standard', 'aggressive', 'aggressive'];

  // Team mode: first half of the ring is BLUE, second half RED (grouped spatially).
  // The player takes a blue slot. FFA: random colours, player at a random slot.
  const teams = mode === 'team'
    ? slots.map((_, i) => (i < Math.ceil(total / 2) ? 'blue' : 'red'))
    : null;
  const playerIx = mode === 'team' ? 0 : Math.floor(Math.random() * total);

  let botN = 0;
  const tintIdx = { blue: 0, red: 0 };

  for (let i = 0; i < total; i++) {
    const p    = slots[i];
    const team = teams ? teams[i] : null;
    const color = team
      ? TEAM_TINTS[team][tintIdx[team]++ % TEAM_TINTS[team].length]
      : (i === playerIx ? PLAYER_COLOR : BOT_COLORS[botN % BOT_COLORS.length]);

    if (i === playerIx) {
      const base = _spawnBase(state, 'player', color, p.x, p.y, null, team);
      _spawnStartingGrunt(state, 'player', base);
    } else {
      const id   = `bot_${botN}`;
      const tier = tiers[botN % tiers.length];
      _spawnBase(state, id, color, p.x, p.y, tier, team);
      botN++;
    }
  }

  if (mode === 'mining') {
    _placeMineNodes(state, cx, cy);
  } else {
    // Seed the neutral centre with XP eatables (FFA / Team).
    for (let i = 0; i < EATABLE_TARGET; i++) spawnEatable(state);
  }
}

/** Scatter neutral mining nodes across the map — outside the centre, spaced apart. */
function _placeMineNodes(state, cx, cy) {
  const W = WORLD_SIZE, margin = 200;
  const bases = [...state.bases.values()].map(b => b.position);
  const placed = [];
  let guard = 0;
  while (placed.length < MINE_NODE_COUNT && guard++ < 2000) {
    const x = margin + Math.random() * (W - margin * 2);
    const y = margin + Math.random() * (W - margin * 2);
    const p = { x, y };
    const dc = Math.hypot(x - cx, y - cy);
    if (dc < CENTER_RADIUS + 60) continue;                          // keep out of the centre
    const clash = [...placed, ...bases].some(q => Math.hypot(q.x - x, q.y - y) < MINE_NODE_MIN_SEP);
    if (clash) continue;
    placed.push(p);
    const node = new MineNode(x, y);
    state.mineNodes.set(node.id, node);
  }
}

/** Evenly spaced points around a ring, with a little jitter. */
function _ringSlots(n, cx, cy, R) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a  = (i / n) * Math.PI * 2 - Math.PI / 2;
    const jx = (Math.random() * 2 - 1) * RING_JITTER;
    const jy = (Math.random() * 2 - 1) * RING_JITTER;
    out.push({ x: cx + Math.cos(a) * R + jx, y: cy + Math.sin(a) * R + jy });
  }
  return out;
}

function _spawnBase(state, id, color, x, y, botTier, team = null) {
  const isBot = id !== 'player';
  const base  = new Base(id, x, y);
  state.bases.set(base.id, base);

  const player = {
    id,
    isBot,
    botTier,
    team,          // 'blue' | 'red' | null (FFA)
    base,
    color,
    alive:       true,
    pendingXP:   0,
    buffs:       { atk: 0, def: 0, spd: 0 },
    _brain:      isBot ? { thinkCooldown: 0 } : null,
    _thinkTimer: 0,
  };
  state.players.set(id, player);
  return base;
}

function _spawnStartingGrunt(state, ownerId, base) {
  const angle = Math.random() * Math.PI * 2;
  const r     = 60;
  const x     = base.position.x + Math.cos(angle) * r;
  const y     = base.position.y + Math.sin(angle) * r;
  const sol   = new Soldier(ownerId, 'grunt', x, y);
  state.soldiers.set(sol.id, sol);
  // Put the starting grunt in its own squad, defending (circling) the base.
  const grp = createGroup(state, sol);
  setDefending(grp, base);
  return sol;
}
