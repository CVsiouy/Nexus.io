import { Base, Soldier, MineNode } from './entities.js';
import { createGroup, setDefending } from './systems/GroupSystem.js';
import {
  WORLD_SIZE, SEAT_COUNT, SEAT_COLORS, TEAM_TINTS,
  CENTER_RADIUS, MINE_NODE_COUNT, MINE_NODE_MIN_SEP,
} from './constants.js';

// Bases sit evenly around a ring so the 8 mother bases are spread across the
// map, well outside the neutral centre. The tight camera means you never see
// more than one or two at once.
const RING_RADIUS_FRAC = 0.42;   // ring radius as fraction of world size
const RING_JITTER      = 70;     // px of random wobble so it isn't a perfect circle

/**
 * Builds the initial world: SEAT_COUNT mother bases in a ring, each with one
 * starting grunt.
 *
 * MULTIPLAYER CHANGE: every seat is now created identical and AI-driven, with
 * an id of "p0".."p7". A joining human claims one via Simulation.claimSeat().
 *
 * Previously one seat was hardcoded as "the player" and got a free starting
 * grunt the others didn't. That was fine alone and unfair with eight humans —
 * whoever landed on that seat would start ahead. Now everyone gets one.
 */
export function buildWorld(state, mode = 'ffa') {
  state.mode = mode;
  const W  = WORLD_SIZE;
  const cx = W / 2, cy = W / 2;
  const R  = W * RING_RADIUS_FRAC;

  const total = SEAT_COUNT;
  const slots = _ringSlots(total, cx, cy, R);
  const tiers = ['passive', 'passive', 'standard', 'standard',
                 'standard', 'aggressive', 'aggressive', 'standard'];

  // Team mode: first half of the ring is BLUE, second half RED (grouped spatially).
  const teams = mode === 'team'
    ? slots.map((_, i) => (i < Math.ceil(total / 2) ? 'blue' : 'red'))
    : null;
  const tintIdx = { blue: 0, red: 0 };

  for (let i = 0; i < total; i++) {
    const p    = slots[i];
    const team = teams ? teams[i] : null;
    const color = team
      ? TEAM_TINTS[team][tintIdx[team]++ % TEAM_TINTS[team].length]
      : SEAT_COLORS[i % SEAT_COLORS.length];

    const id = `p${i}`;
    _spawnBase(state, id, i, color, p.x, p.y, tiers[i % tiers.length], team);
    // No starting soldier. Everyone begins with just their base; the first
    // troops come out of the garrison as a proper formation, so nobody starts
    // with a lone grunt loitering outside that can only be picked off.
  }

  // Mining mode scatters capturable gold nodes. No centre eatables/wildlings in
  // any mode anymore.
  if (mode === 'mining') _placeMineNodes(state, cx, cy);
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
    const node = new MineNode(state.newId(), x, y);
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

function _spawnBase(state, id, seat, color, x, y, botTier, team = null) {
  const base = new Base(state.newId(), id, x, y);
  state.bases.set(base.id, base);

  const player = {
    id,
    seat,          // 0..7 — a compact index for the network protocol
    isBot:       true,   // every seat starts AI-driven; a human claims it later
    sessionId:   null,   // which connected client controls this seat (null = AI)
    name:        `Bot ${seat + 1}`,
    botTier,
    team,          // 'blue' | 'red' | null (FFA)
    base,
    color,
    alive:       true,
    pendingXP:   0,
    buffs:       { atk: 0, def: 0, spd: 0 },
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
  const sol   = new Soldier(state.newId(), ownerId, 'grunt', x, y);
  state.soldiers.set(sol.id, sol);
  // Put the starting grunt in its own squad, defending (circling) the base.
  const grp = createGroup(state, sol);
  setDefending(grp, base);
  return sol;
}
