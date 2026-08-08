/**
 * Binary snapshot codec.
 * ─────────────────────
 *
 * WHY THIS EXISTS
 *
 * Phase 1 sent snapshots as JSON and we measured the result: 141 KB/s per
 * player, about ten times more than the plan budgeted. The cause is that JSON
 * writes out every key name, for every entity, every time:
 *
 *   {"id":412,"ownerId":"p3","type":"grunt","x":1234.5678901234,
 *    "y":987.65432109,"hp":20,"maxHp":20,"facing":-1.5707963267948966,...}
 *
 * That is ~150 bytes to say something that fits in 7. Full-precision floats are
 * the worst offenders: `1234.5678901234` costs 14 characters to express a
 * position that only needs to be accurate to about half a pixel on screen.
 *
 * WHAT WE DO INSTEAD
 *
 * 1. Raw bytes, no field names. Both sides know the layout, so it is implied.
 *
 * 2. QUANTIZATION — deliberately throwing away precision nobody can see. The
 *    map is 2,800px wide and drawn zoomed out to fit the screen, so one world
 *    pixel is smaller than one screen pixel. We store each coordinate in 12
 *    bits (4,096 steps ≈ 0.68px), packing x and y together into 3 bytes
 *    instead of 8. The difference is invisible; the saving is 60%.
 *
 * 3. DROPPING what the client can work out for itself:
 *      • base rotation — a cosmetic spin; the client can animate it locally
 *      • soldier facing — squads hold a fixed heading, carried on the squad
 *      • soldier→squad links — squads already list their members, so the
 *        client builds the reverse mapping itself
 *
 * The decoder returns exactly the same object shape the JSON path produced, so
 * nothing downstream of it had to change.
 */

/**
 * Bump this whenever the byte layout changes.
 *
 * The format is POSITIONAL — there are no field names on the wire — so a client
 * decoding a newer frame with an older layout does not fail loudly, it reads
 * every subsequent field from the wrong offset. The version check in
 * decodeSnapshot is the only thing that turns that into a clear "reload the
 * page" instead of a subtly corrupted world.
 *
 * v2: removed the per-base conquestGoldBonus (permanent stacking income was
 *     replaced by a one-time flat bounty).
 * v3: the single roaming boss became a list of fortified bosses, each with its
 *     own wall ring; bases gained bossBonus (permanent income from boss kills).
 */
export const SNAPSHOT_VERSION = 3;

/** Map size. Must match WORLD_SIZE in packages/sim/constants.js. */
const WORLD = 2800;
const Q_MAX = 4095;             // 12 bits per axis
const Q_SCALE = Q_MAX / WORLD;

const UNIT_TYPES = ['grunt', 'sentinel', 'saboteur', 'vanguard'] as const;
const STATUSES   = ['idle', 'moving', 'attacking', 'defending', 'farming'] as const;
const SPECS      = [null, 'bastion', 'warmonger', 'prospector'] as const;
const MODES      = ['ffa', 'team', 'mining'] as const;

const idx = <T,>(arr: readonly T[], v: T) => { const i = arr.indexOf(v); return i < 0 ? 0 : i; };

// ── Writer ───────────────────────────────────────────────────────────────────

class Writer {
  buf: DataView;
  bytes: Uint8Array;
  o = 0;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.buf = new DataView(this.bytes.buffer);
  }
  u8(v: number)  { this.buf.setUint8(this.o, v & 0xff); this.o += 1; }
  u16(v: number) { this.buf.setUint16(this.o, v & 0xffff); this.o += 2; }
  u32(v: number) { this.buf.setUint32(this.o, v >>> 0); this.o += 4; }
  /** x and y packed into 24 bits total. */
  xy(x: number, y: number) {
    const qx = Math.max(0, Math.min(Q_MAX, Math.round(x * Q_SCALE)));
    const qy = Math.max(0, Math.min(Q_MAX, Math.round(y * Q_SCALE)));
    const packed = (qx << 12) | qy;
    this.u8(packed >> 16); this.u8((packed >> 8) & 0xff); this.u8(packed & 0xff);
  }
  str(s: string) {
    const b = new TextEncoder().encode((s ?? '').slice(0, 16));
    this.u8(b.length);
    this.bytes.set(b, this.o);
    this.o += b.length;
  }
  done() { return this.bytes.buffer.slice(0, this.o); }
}

class Reader {
  buf: DataView;
  bytes: Uint8Array;
  o = 0;
  constructor(ab: ArrayBuffer | Uint8Array) {
    this.bytes = ab instanceof Uint8Array ? ab : new Uint8Array(ab);
    this.buf = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }
  u8()  { const v = this.buf.getUint8(this.o); this.o += 1; return v; }
  u16() { const v = this.buf.getUint16(this.o); this.o += 2; return v; }
  u32() { const v = this.buf.getUint32(this.o); this.o += 4; return v; }
  xy() {
    const packed = (this.u8() << 16) | (this.u8() << 8) | this.u8();
    return { x: (packed >> 12) / Q_SCALE, y: (packed & 0xfff) / Q_SCALE };
  }
  str() {
    const n = this.u8();
    const s = new TextDecoder().decode(this.bytes.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
  get eof() { return this.o >= this.bytes.byteLength; }
}

// ── Encode ───────────────────────────────────────────────────────────────────

/**
 * @param snap      a snapshot object from Simulation.getSnapshot()
 * @param keyframe  include the slow-changing fields (names, colours, teams,
 *                  maxHp, unlocked list). Sent periodically and to anyone who
 *                  just joined, so a new client can build a complete picture.
 */
export function encodeSnapshot(snap: any, keyframe = false): ArrayBuffer {
  // Generous upper bound; the buffer is sliced to the real length at the end.
  const size = 256
    + snap.players.length * 400
    + snap.soldiers.length * 8
    + snap.groups.length * 64
    + snap.mineNodes.length * 12
    + 64;
  const w = new Writer(size);

  w.u8(SNAPSHOT_VERSION);
  w.u8(keyframe ? 1 : 0);
  w.u32(snap.tick);
  w.u32(Math.round(snap.time));
  w.u8(idx(MODES, snap.mode));

  // ── Players ───────────────────────────────────────────────────────────────
  w.u8(snap.players.length);
  for (const p of snap.players) {
    const b = p.base;
    w.u8(p.seat);
    w.u8(
      (p.alive ? 1 : 0) |
      (p.isBot ? 2 : 0) |
      (b.spawnProtected ? 4 : 0) |
      (idx(SPECS, b.specialization) << 3) |     // 2 bits
      (p.team === 'blue' ? 32 : p.team === 'red' ? 64 : 0),
    );
    w.u16(Math.max(0, Math.min(65535, Math.round(b.hp))));
    w.u32(Math.max(0, Math.round(b.gold)));
    w.u32(Math.max(0, Math.round(b.xpEarned)));
    w.u8(b.level);
    w.u8(b.garrison);
    w.u8(b.skillPoints);
    w.u8(b.mineLevel);
    w.u8(p.buffs.atk); w.u8(p.buffs.def); w.u8(p.buffs.spd);
    // lastAttackedAt drives the "base under attack" blink; only its recency
    // matters, so send how long ago in tenths of a second, capped.
    const since = snap.time - (b.lastAttackedAt ?? -Infinity);
    w.u16(Number.isFinite(since) ? Math.min(65535, Math.round(since / 10)) : 65535);

    // Build queues (small, and they change often enough to matter to the HUD).
    writeQueue(w, b.soldierQueue);
    writeQueue(w, b.wallQueue);
    writeQueue(w, b.turretQueue);

    // Walls: 2 bytes per cell.
    w.u8(b.walls.length);
    for (const layer of b.walls) {
      w.u8(layer.ring);
      w.u8(layer.maxCells);
      w.u8(layer.cells.length);
      for (const c of layer.cells) {
        w.u8(c.slot);
        w.u8(Math.max(0, Math.min(255, Math.round((c.hp / c.maxHp) * 255))));
      }
    }

    if (keyframe) {
      // Static for the whole match — a base never moves and never changes id,
      // so paying for them ten times a second would be pure waste.
      w.u16(b.id);
      w.xy(b.x, b.y);
      w.str(p.name ?? '');
      w.u32(p.color >>> 0);
      w.u32(Math.round(b.maxHp));
      let unlocked = 0;
      for (const u of b.unlocked) unlocked |= 1 << idx(UNIT_TYPES, u as any);
      w.u8(unlocked);
      w.u16(Math.round((b.miningBonus ?? 0) * 100));
      w.u16(Math.round((b.bossBonus ?? 0) * 100));
      w.u16(Math.round((b.goldMult ?? 1) * 100));
    }
  }

  // ── Squads ────────────────────────────────────────────────────────────────
  w.u16(snap.groups.length);
  for (const g of snap.groups) {
    w.u16(g.id);
    w.u8(seatOf(snap, g.ownerId));
    w.xy(g.anchorX, g.anchorY);
    w.u8(idx(STATUSES, g.status) | (g.locked ? 16 : 0) | (g.formed ? 32 : 0));
    w.u8(Math.min(255, g.memberIds.length));
    for (const id of g.memberIds) w.u16(id);
  }

  // ── Soldiers ──────────────────────────────────────────────────────────────
  // 7 bytes each. `facing` is dropped (squads hold a fixed heading) and the
  // squad link is dropped (squads already list their members above).
  w.u16(snap.soldiers.length);
  for (const s of snap.soldiers) {
    w.u16(s.id);
    w.u8((idx(UNIT_TYPES, s.type) << 4) | (seatOf(snap, s.ownerId) & 0x0f));
    w.xy(s.x, s.y);
    w.u8(Math.max(0, Math.min(255, Math.round((s.hp / s.maxHp) * 255))));
  }

  // ── Turrets and projectiles ───────────────────────────────────────────────
  // Both are disabled today (ProductionSystem never drains the turret queue),
  // so these counts are zero and cost one byte each. Encoded anyway so that
  // re-enabling turrets doesn't make them silently invisible to every client.
  w.u8(Math.min(255, snap.turrets.length));
  for (const t of snap.turrets.slice(0, 255)) {
    w.u16(t.id);
    w.u8(seatOf(snap, t.ownerId));
    w.u8(t.type === 'missile' ? 1 : 0);
    w.xy(t.x, t.y);
    w.u16(Math.round(((t.aimFacing + Math.PI) / (Math.PI * 2)) * 65535));
  }

  w.u16(Math.min(65535, snap.projectiles.length));
  for (const p of snap.projectiles.slice(0, 65535)) {
    w.u16(p.id);
    w.u8(seatOf(snap, p.ownerId));
    w.xy(p.x, p.y);
    w.u8(p.splash > 0 ? 1 : 0);
  }

  // ── Mine nodes (mining mode only; usually zero) ────────────────────────────
  w.u8(snap.mineNodes.length);
  for (const n of snap.mineNodes) {
    w.u16(n.id);
    w.xy(n.x, n.y);
    w.u8(n.ownerId ? seatOf(snap, n.ownerId) + 1 : 0);      // 0 = neutral
    w.u8(n.capturingBy ? seatOf(snap, n.capturingBy) + 1 : 0);
    w.u8(Math.round(n.captureProg * 255));
    w.u8(Math.min(255, Math.round((n.goldRate ?? 0) * 10)));
  }

  // ── Bosses ────────────────────────────────────────────────────────────────
  // Fortified positions in the middle of the map. They never move, so their
  // coordinates could in principle be keyframe-only — but there are at most a
  // couple of them and the whole block is tiny, so it stays simple.
  w.u8(Math.min(255, snap.bosses.length));
  for (const b of snap.bosses.slice(0, 255)) {
    w.u16(b.id);
    w.u8(b.index);
    w.xy(b.x, b.y);
    w.u16(Math.round(b.hp));
    w.u16(Math.round(b.maxHp));
    w.u8(b.walls.length);
    for (const layer of b.walls) {
      w.u8(layer.maxCells);
      w.u8(layer.cells.length);
      w.u16(Math.round(layer.radius));
      for (const c of layer.cells) {
        w.u8(c.slot);
        w.u8(Math.max(0, Math.min(255, Math.round((c.hp / c.maxHp) * 255))));
      }
    }
  }

  return w.done();
}

function writeQueue(w: Writer, q: any[]) {
  w.u8(Math.min(255, q.length));
  for (let i = 0; i < Math.min(255, q.length); i++) {
    w.u8(idx(UNIT_TYPES, q[i].type));
    w.u8(Math.min(255, q[i].count ?? 1));
  }
}

/**
 * Seat index for an owner, packed into 4 bits.
 *
 * BOSS_SEAT is a reserved value for the boss's guards. Without it they fell
 * through to `?? 0` and arrived on the client as seat 0's soldiers — so a
 * boss's garrison appeared to belong to whoever happened to be player one.
 */
export const BOSS_SEAT = 15;

const seatOf = (snap: any, ownerId: string) => {
  if (ownerId === 'boss') return BOSS_SEAT;
  return snap.players.find((p: any) => p.id === ownerId)?.seat ?? 0;
};

// ── Decode ───────────────────────────────────────────────────────────────────

/**
 * Rebuild a snapshot object with the SAME shape the JSON path produced, so
 * WorldView and the renderers need no knowledge that any of this happened.
 *
 * `prev` supplies the slow-changing fields (names, colours, maxHp, …) that only
 * travel on keyframes. Pass the last decoded snapshot.
 */
export function decodeSnapshot(buffer: ArrayBuffer | Uint8Array, prev?: any): any {
  const r = new Reader(buffer);

  const version = r.u8();
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(`Snapshot version ${version}, expected ${SNAPSHOT_VERSION}. Reload the page.`);
  }
  const keyframe = r.u8() === 1;
  const tick = r.u32();
  const time = r.u32();
  const mode = MODES[r.u8()] ?? 'ffa';

  const prevPlayers = new Map<number, any>();
  if (prev) for (const p of prev.players) prevPlayers.set(p.seat, p);

  const players: any[] = [];
  const seatToId = new Map<number, string>();

  const playerCount = r.u8();
  for (let i = 0; i < playerCount; i++) {
    const seat = r.u8();
    const flags = r.u8();
    const old = prevPlayers.get(seat);

    const hp = r.u16();
    const gold = r.u32();
    const xpEarned = r.u32();
    const level = r.u8();
    const garrison = r.u8();
    const skillPoints = r.u8();
    const mineLevel = r.u8();
    const buffs = { atk: r.u8(), def: r.u8(), spd: r.u8() };
    const sinceHit = r.u16() * 10;

    const soldierQueue = readQueue(r);
    const wallQueue = readQueue(r);
    const turretQueue = readQueue(r);

    const walls: any[] = [];
    const layerCount = r.u8();
    for (let l = 0; l < layerCount; l++) {
      const ring = r.u8();
      const maxCells = r.u8();
      const cellCount = r.u8();
      const cells: any[] = [];
      for (let c = 0; c < cellCount; c++) {
        const slot = r.u8();
        const hpPct = r.u8() / 255;
        cells.push({ slot, hp: hpPct * 8000, maxHp: 8000 });
      }
      // radius is derived the same way walls.js derives it
      walls.push({ ring, radius: 44 + 34 + ring * 30, maxCells, cells });
    }

    let name: string, color: number, maxHp: number, unlockedMask: number;
    let miningBonus: number, bossBonus: number, goldMult: number;
    let baseId: number, baseX: number, baseY: number;
    if (keyframe) {
      baseId = r.u16();
      const pos = r.xy();
      baseX = pos.x; baseY = pos.y;
      name = r.str();
      color = r.u32();
      maxHp = r.u32();
      unlockedMask = r.u8();
      miningBonus = r.u16() / 100;
      bossBonus = r.u16() / 100;
      goldMult = r.u16() / 100;
    } else {
      // Carried over from the last keyframe — these change rarely, so sending
      // them ten times a second would be pure waste.
      baseId = old?.base?.id ?? -(seat + 1);
      baseX = old?.base?.x ?? 0;
      baseY = old?.base?.y ?? 0;
      name = old?.name ?? `Seat ${seat + 1}`;
      color = old?.color ?? 0x888888;
      maxHp = old?.base?.maxHp ?? 10000;
      unlockedMask = old?.__unlockedMask ?? 0b11;
      miningBonus = old?.base?.miningBonus ?? 0;
      bossBonus = old?.base?.bossBonus ?? 0;
      goldMult = old?.base?.goldMult ?? 1;
    }

    const unlocked: string[] = [];
    for (let b = 0; b < UNIT_TYPES.length; b++) if (unlockedMask & (1 << b)) unlocked.push(UNIT_TYPES[b]);

    const id = old?.id ?? `p${seat}`;
    seatToId.set(seat, id);

    players.push({
      id, seat, name, color,
      isBot: !!(flags & 2),
      alive: !!(flags & 1),
      team: (flags & 32) ? 'blue' : (flags & 64) ? 'red' : null,
      buffs,
      __unlockedMask: unlockedMask,
      base: {
        id: baseId, x: baseX, y: baseY,
        hp, maxHp, level, gold, xpEarned,
        rotation: 0,          // cosmetic; the client animates this itself
        mineLevel, miningBonus, bossBonus, goldMult,
        garrison, skillPoints,
        specialization: SPECS[(flags >> 3) & 3] ?? null,
        spawnProtected: !!(flags & 4),
        lastAttackedAt: time - sinceHit,
        unlocked, walls,
        soldierQueue, wallQueue, turretQueue,
      },
    });
  }

  const groups: any[] = [];
  const groupCount = r.u16();
  for (let i = 0; i < groupCount; i++) {
    const gid = r.u16();
    const seat = r.u8();
    const { x, y } = r.xy();
    const st = r.u8();
    const memberCount = r.u8();
    const memberIds: number[] = [];
    for (let m = 0; m < memberCount; m++) memberIds.push(r.u16());
    groups.push({
      id: gid,
      ownerId: seat === BOSS_SEAT ? 'boss' : (seatToId.get(seat) ?? `p${seat}`),
      memberIds,
      status: STATUSES[st & 0x0f] ?? 'idle',
      locked: !!(st & 16),
      formed: !!(st & 32),
      targetId: null,
      anchorX: x, anchorY: y,
      facing: -Math.PI / 2,     // squads always hold a fixed heading
      defendNodeId: null,
    });
  }

  const soldiers: any[] = [];
  const soldierCount = r.u16();
  for (let i = 0; i < soldierCount; i++) {
    const sid = r.u16();
    const packed = r.u8();
    const { x, y } = r.xy();
    const hpPct = r.u8() / 255;
    const type = UNIT_TYPES[(packed >> 4) & 0x0f] ?? 'grunt';
    const seat = packed & 0x0f;
    soldiers.push({
      id: sid, type,
      ownerId: seat === BOSS_SEAT ? 'boss' : (seatToId.get(seat) ?? `p${seat}`),
      x, y,
      hp: hpPct, maxHp: 1,      // stored as a fraction; the renderer only uses the ratio
      facing: -Math.PI / 2,
      groupId: null,            // filled in from squad membership below
    });
  }

  // Rebuild each soldier's squad link from the squads' member lists, rather
  // than paying 2 bytes per soldier to send something we already know.
  const byId = new Map(soldiers.map(s => [s.id, s]));
  for (const g of groups) for (const mid of g.memberIds) {
    const s = byId.get(mid);
    if (s) s.groupId = g.id;
  }

  const turrets: any[] = [];
  const turretCount = r.u8();
  for (let i = 0; i < turretCount; i++) {
    const tid = r.u16();
    const seat = r.u8();
    const type = r.u8() === 1 ? 'missile' : 'gun';
    const { x, y } = r.xy();
    const aimFacing = (r.u16() / 65535) * Math.PI * 2 - Math.PI;
    turrets.push({ id: tid, ownerId: seatToId.get(seat) ?? `p${seat}`, type, baseId: null, x, y, angle: aimFacing, aimFacing });
  }

  const projectiles: any[] = [];
  const projCount = r.u16();
  for (let i = 0; i < projCount; i++) {
    const pid = r.u16();
    const seat = r.u8();
    const { x, y } = r.xy();
    const splash = r.u8();
    projectiles.push({
      id: pid, ownerId: seatToId.get(seat) ?? `p${seat}`,
      x, y, splash: splash ? 55 : 0, color: splash ? 0xef4444 : 0x334155,
    });
  }

  const mineNodes: any[] = [];
  const nodeCount = r.u8();
  for (let i = 0; i < nodeCount; i++) {
    const nid = r.u16();
    const { x, y } = r.xy();
    const owner = r.u8(), capturing = r.u8();
    mineNodes.push({
      id: nid, x, y,
      ownerId: owner ? (seatToId.get(owner - 1) ?? `p${owner - 1}`) : null,
      capturingBy: capturing ? (seatToId.get(capturing - 1) ?? `p${capturing - 1}`) : null,
      captureProg: r.u8() / 255,
      goldRate: r.u8() / 10,
      rot: 0,
    });
  }

  const bosses: any[] = [];
  const bossCount = r.u8();
  for (let i = 0; i < bossCount; i++) {
    const bid = r.u16();
    const index = r.u8();
    const { x, y } = r.xy();
    const hp = r.u16();
    const maxHp = r.u16();
    const walls: any[] = [];
    const layerCount = r.u8();
    for (let l = 0; l < layerCount; l++) {
      const maxCells = r.u8();
      const cellCount = r.u8();
      const radius = r.u16();
      const cells: any[] = [];
      for (let c = 0; c < cellCount; c++) {
        const slot = r.u8();
        const hpPct = r.u8() / 255;
        cells.push({ slot, hp: hpPct, maxHp: 1 });
      }
      walls.push({ ring: l, radius, maxCells, cells });
    }
    bosses.push({ id: bid, index, x, y, hp, maxHp, rotation: 0, walls });
  }

  return {
    tick, time, mode, keyframe,
    players, groups, soldiers, mineNodes, bosses, turrets, projectiles,
    eatables: [], wildlings: [],   // disabled in every mode; see CenterSystem
  };
}

function readQueue(r: Reader) {
  const n = r.u8();
  const out: any[] = [];
  for (let i = 0; i < n; i++) out.push({ type: UNIT_TYPES[r.u8()] ?? 'grunt', count: r.u8() });
  return out;
}
