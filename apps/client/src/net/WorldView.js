import { POP_BASE, POP_PER_LEVEL, SOLDIER_DEFS } from '@nexus/sim';

/**
 * WorldView — the client's picture of the world.
 * ─────────────────────────────────────────────
 *
 * The simulation now lives somewhere else (a Web Worker today, a server in
 * Phase 1) and reports in 20 times a second. The screen redraws 60 times a
 * second. This class bridges that gap, and does two jobs:
 *
 * 1. INTERPOLATION — smoothing.
 *
 *    If we simply drew the newest snapshot, everything would visibly jump
 *    every 50ms. Instead we deliberately draw the world slightly IN THE PAST
 *    (see INTERP_DELAY_MS) and slide smoothly between the two snapshots on
 *    either side of that moment. Because we are drawing a moment that has
 *    already fully arrived, motion is perfectly smooth — we are never guessing.
 *
 *    Nobody notices the delay, because there is nothing on screen to compare it
 *    against. This is standard practice, and it's why this game needs no
 *    client-side prediction: the player never controls anything directly, so
 *    rendering 100ms behind costs nothing.
 *
 * 2. ADAPTING — snapshots are flat plain data (`x`, `y`) because that is what
 *    survives being sent between threads and what packs efficiently into bytes
 *    later. The renderers were written against the old GameState shape
 *    (`position.x`). This class exposes that familiar shape, so the renderer
 *    and HUD barely changed.
 */

/**
 * How far behind "now" we draw. One and a bit snapshot intervals, so there is
 * almost always a newer snapshot to interpolate toward even if one is late.
 * Raise it if motion ever looks stuttery on a bad connection.
 */
export const INTERP_DELAY_MS = 100;

/** Discard buffered snapshots older than this. */
const BUFFER_MS = 1000;

export class WorldView {
  constructor() {
    this.playerId = 'player';
    this.mode = 'ffa';
    this.time = 0;
    this.tick = 0;

    // Live entity maps, shaped like the old GameState so the renderers and
    // input code read them unchanged.
    this.players = new Map();
    this.bases = new Map();
    this.soldiers = new Map();
    this.groups = new Map();
    this.turrets = new Map();
    this.projectiles = new Map();
    this.eatables = new Map();
    this.wildlings = new Map();
    this.mineNodes = new Map();
    this.boss = null;

    this.ready = false;

    /** Names that arrived before the player they belong to existed here. */
    this._pendingNames = new Map();

    /** @type {{t:number, snap:object, idx:object}[]} */
    this._buffer = [];
  }

  // ── Receiving ──────────────────────────────────────────────────────────────

  /** Told once, on joining: which of the eight bases is mine. */
  setLocalId(ownerId) { this.playerId = ownerId; }

  /**
   * Apply a roster update ({ [ownerId]: name }).
   *
   * Names otherwise only travel on keyframes, so somebody joining mid-match
   * would show as their seat id for up to two seconds. The server sends a
   * roster the moment anyone joins or leaves, which closes that gap.
   */
  setNames(names) {
    if (!names) return;
    for (const [id, name] of Object.entries(names)) {
      const p = this.players.get(id);
      if (p && name) p.name = name;
      else if (name) this._pendingNames.set(id, name);
    }
  }

  /** Take a snapshot from the connection. `sentAt` is on our own clock. */
  ingest(snapshot, sentAt) {
    this._buffer.push({ t: sentAt, snap: snapshot, idx: indexSnapshot(snapshot) });

    // Drop anything too old to still be needed for interpolation.
    const cutoff = sentAt - BUFFER_MS;
    while (this._buffer.length > 2 && this._buffer[0].t < cutoff) this._buffer.shift();

    this.ready = true;
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  /**
   * Rebuild the live entity maps for the moment `nowMs - INTERP_DELAY_MS`.
   * Call once per rendered frame, before drawing.
   */
  sample(nowMs) {
    if (!this._buffer.length) return;

    const target = nowMs - INTERP_DELAY_MS;

    // Find the pair of snapshots straddling `target`.
    let a = this._buffer[0], b = this._buffer[0], alpha = 0;
    if (target >= this._buffer[this._buffer.length - 1].t) {
      // We've caught up to (or overrun) the newest snapshot — hold on it rather
      // than extrapolating. If updates stop, the world freezes instead of
      // sliding off into a guess that will have to be yanked back.
      a = b = this._buffer[this._buffer.length - 1];
      alpha = 0;
    } else {
      for (let i = 0; i < this._buffer.length - 1; i++) {
        if (this._buffer[i].t <= target && target < this._buffer[i + 1].t) {
          a = this._buffer[i];
          b = this._buffer[i + 1];
          const span = b.t - a.t;
          alpha = span > 0 ? (target - a.t) / span : 0;
          break;
        }
      }
    }

    this._apply(a, b, clamp01(alpha));
  }

  _apply(a, b, k) {
    const snap = b.snap;

    // NOTE: playerId is NOT read from the snapshot. The server sends one
    // identical snapshot to all eight players, so it cannot contain "who you
    // are" — that arrives once, in the welcome message (see setLocalId).
    this.mode = snap.mode;
    this.tick = snap.tick;
    this.time = lerp(a.snap.time, snap.time, k);

    this._syncPlayers(a, b, k);
    this._syncSoldiers(a, b, k);
    this._syncGroups(a, b, k);
    this._syncSimple(a, b, k);
    this._syncBoss(a, b, k);
  }

  _syncPlayers(a, b, k) {
    const seen = new Set();
    for (const p of b.snap.players) {
      const prev = a.idx.players.get(p.id);
      let view = this.players.get(p.id);
      if (!view) {
        view = { base: { position: { x: 0, y: 0 }, unlocked: new Set() } };
        this.players.set(p.id, view);
      }

      view.id = p.id;
      view.seat = p.seat;
      // The display name. Without this the HUD and the labels above each base
      // fall back to the raw seat id and every human shows up as "p3".
      // Names only travel on keyframes, so keep the last one we saw rather
      // than blanking it between them.
      if (p.name) view.name = p.name;
      const pending = this._pendingNames.get(p.id);
      if (pending) { view.name = pending; this._pendingNames.delete(p.id); }
      view.isBot = p.isBot;
      view.team = p.team;
      view.color = p.color;
      view.alive = p.alive;
      view.buffs = p.buffs;

      const nb = p.base, ob = prev?.base;
      const vb = view.base;
      vb.id = nb.id;
      vb.ownerId = p.id;
      vb.position.x = ob ? lerp(ob.x, nb.x, k) : nb.x;
      vb.position.y = ob ? lerp(ob.y, nb.y, k) : nb.y;
      vb.hp = ob ? lerp(ob.hp, nb.hp, k) : nb.hp;
      vb.gold = ob ? lerp(ob.gold, nb.gold, k) : nb.gold;
      vb.rotation = ob ? lerp(ob.rotation, nb.rotation, k) : nb.rotation;
      vb.xpEarned = ob ? lerp(ob.xpEarned, nb.xpEarned, k) : nb.xpEarned;

      vb.maxHp = nb.maxHp;
      vb.level = nb.level;
      vb.mineLevel = nb.mineLevel;
      vb.miningBonus = nb.miningBonus;
      vb.goldMult = nb.goldMult;
      vb.garrison = nb.garrison;
      vb.skillPoints = nb.skillPoints;
      vb.specialization = nb.specialization;
      vb.spawnProtected = nb.spawnProtected;
      vb.lastAttackedAt = nb.lastAttackedAt;
      vb.walls = nb.walls;
      vb.soldierQueue = nb.soldierQueue;
      vb.wallQueue = nb.wallQueue;
      vb.turretQueue = nb.turretQueue;

      // The snapshot carries an array (Sets don't survive being sent between
      // threads). The HUD calls .has(), so rebuild the Set — but only when the
      // contents actually changed, since unlocks happen a handful of times a match.
      if (vb.unlocked.size !== nb.unlocked.length) vb.unlocked = new Set(nb.unlocked);

      this.bases.set(nb.id, vb);
      seen.add(p.id);
    }
    for (const id of this.players.keys()) if (!seen.has(id)) this.players.delete(id);
  }

  _syncSoldiers(a, b, k) {
    const seen = new Set();
    for (const s of b.snap.soldiers) {
      const prev = a.idx.soldiers.get(s.id);
      let v = this.soldiers.get(s.id);
      if (!v) { v = { position: { x: s.x, y: s.y } }; this.soldiers.set(s.id, v); }

      v.id = s.id;
      v.ownerId = s.ownerId;
      v.type = s.type;
      v.groupId = s.groupId;
      v.maxHp = s.maxHp;
      v.position.x = prev ? lerp(prev.x, s.x, k) : s.x;
      v.position.y = prev ? lerp(prev.y, s.y, k) : s.y;
      v.hp = prev ? lerp(prev.hp, s.hp, k) : s.hp;
      v.facing = prev ? lerpAngle(prev.facing, s.facing, k) : s.facing;
      seen.add(s.id);
    }
    for (const id of this.soldiers.keys()) if (!seen.has(id)) this.soldiers.delete(id);
  }

  _syncGroups(a, b, k) {
    const seen = new Set();
    for (const g of b.snap.groups) {
      const prev = a.idx.groups.get(g.id);
      let v = this.groups.get(g.id);
      if (!v) { v = { anchor: { x: g.anchorX, y: g.anchorY } }; this.groups.set(g.id, v); }

      v.id = g.id;
      v.ownerId = g.ownerId;
      v.memberIds = g.memberIds;
      v.status = g.status;
      v.targetId = g.targetId;
      v.locked = g.locked;
      v.formed = g.formed;
      v.defendNodeId = g.defendNodeId;
      v.facing = g.facing;
      v.anchor.x = prev ? lerp(prev.anchorX, g.anchorX, k) : g.anchorX;
      v.anchor.y = prev ? lerp(prev.anchorY, g.anchorY, k) : g.anchorY;
      seen.add(g.id);
    }
    for (const id of this.groups.keys()) if (!seen.has(id)) this.groups.delete(id);
  }

  /** Turrets, projectiles, eatables, wildlings and mine nodes. */
  _syncSimple(a, b, k) {
    syncInto(this.turrets, b.snap.turrets, a.idx.turrets, k, (v, n, p) => {
      v.ownerId = n.ownerId; v.type = n.type; v.angle = n.angle;
      v.aimFacing = p ? lerpAngle(p.aimFacing, n.aimFacing, k) : n.aimFacing;
      v.position.x = n.x; v.position.y = n.y;             // turrets don't move
    });

    syncInto(this.projectiles, b.snap.projectiles, a.idx.projectiles, k, (v, n, p) => {
      v.ownerId = n.ownerId; v.splash = n.splash; v.color = n.color;
      v.position.x = p ? lerp(p.x, n.x, k) : n.x;
      v.position.y = p ? lerp(p.y, n.y, k) : n.y;
    });

    syncInto(this.eatables, b.snap.eatables, a.idx.eatables, k, (v, n) => {
      v.type = n.type; v.hp = n.hp; v.maxHp = n.maxHp; v.pulse = n.pulse; v.rot = n.rot;
      v.position.x = n.x; v.position.y = n.y;
    });

    syncInto(this.wildlings, b.snap.wildlings, a.idx.wildlings, k, (v, n, p) => {
      v.hp = n.hp; v.maxHp = n.maxHp;
      v.position.x = p ? lerp(p.x, n.x, k) : n.x;
      v.position.y = p ? lerp(p.y, n.y, k) : n.y;
    });

    syncInto(this.mineNodes, b.snap.mineNodes, a.idx.mineNodes, k, (v, n, p) => {
      v.ownerId = n.ownerId; v.capturingBy = n.capturingBy; v.goldRate = n.goldRate;
      v.captureProg = p ? lerp(p.captureProg, n.captureProg, k) : n.captureProg;
      v.rot = n.rot;
      v.position.x = n.x; v.position.y = n.y;
    });
  }

  _syncBoss(a, b, k) {
    const n = b.snap.boss;
    if (!n) { this.boss = null; return; }
    const p = a.snap.boss && a.snap.boss.id === n.id ? a.snap.boss : null;
    if (!this.boss) this.boss = { position: { x: n.x, y: n.y } };
    const v = this.boss;
    v.id = n.id;
    v.maxHp = n.maxHp;
    v.hp = p ? lerp(p.hp, n.hp, k) : n.hp;
    v.rotation = p ? lerp(p.rotation, n.rotation, k) : n.rotation;
    v.position.x = p ? lerp(p.x, n.x, k) : n.x;
    v.position.y = p ? lerp(p.y, n.y, k) : n.y;
  }

  // ── Read API (mirrors the old GameState so renderers/input barely changed) ──

  getPlayer(id) { return this.players.get(id); }
  getPlayerBase(id) { return this.players.get(id)?.base; }
  teamOf(id) { return this.players.get(id)?.team ?? null; }

  groupsOf(ownerId) {
    const out = [];
    for (const [, g] of this.groups) if (g.ownerId === ownerId) out.push(g);
    return out;
  }

  areEnemies(a, b) {
    if (!a || !b || a === b) return false;
    const pa = this.players.get(a), pb = this.players.get(b);
    if (pa && pb && pa.team && pb.team && pa.team === pb.team) return false;
    return true;
  }

  soldierPop(ownerId) {
    let n = 0;
    for (const [, s] of this.soldiers) if (s.ownerId === ownerId) n += SOLDIER_DEFS[s.type]?.pop ?? 1;
    return n;
  }

  popCap(player) { return POP_BASE + player.base.level * POP_PER_LEVEL; }

  turretCount(baseId) {
    let n = 0;
    for (const [, t] of this.turrets) if (t.baseId === baseId) n++;
    return n;
  }

  aliveTeams() {
    const s = new Set();
    for (const [, p] of this.players) if (p.alive && p.team) s.add(p.team);
    return [...s];
  }

  /** Resolve an id to whatever entity it names — used for attack-target lookups. */
  resolve(id) {
    if (id == null) return null;
    return this.soldiers.get(id) ?? this.bases.get(id) ?? this.eatables.get(id)
        ?? this.wildlings.get(id) ?? (this.boss?.id === id ? this.boss : null);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function indexSnapshot(snap) {
  return {
    players:     byId(snap.players),
    soldiers:    byId(snap.soldiers),
    groups:      byId(snap.groups),
    turrets:     byId(snap.turrets),
    projectiles: byId(snap.projectiles),
    eatables:    byId(snap.eatables),
    wildlings:   byId(snap.wildlings),
    mineNodes:   byId(snap.mineNodes),
  };
}

function byId(arr) {
  const m = new Map();
  for (const e of arr) m.set(e.id, e);
  return m;
}

/**
 * Update `target` in place from a snapshot array, creating and removing view
 * objects as needed. Mutating in place rather than rebuilding avoids allocating
 * hundreds of objects every frame, which would keep the garbage collector busy
 * and cause periodic stutter.
 */
function syncInto(target, list, prevIdx, k, assign) {
  const seen = new Set();
  for (const n of list) {
    let v = target.get(n.id);
    if (!v) { v = { id: n.id, position: { x: n.x, y: n.y } }; target.set(n.id, v); }
    assign(v, n, prevIdx.get(n.id), k);
    v.id = n.id;
    seen.add(n.id);
  }
  for (const id of target.keys()) if (!seen.has(id)) target.delete(id);
}

const lerp = (a, b, k) => a + (b - a) * k;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Angle interpolation that takes the short way round instead of spinning back. */
function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
