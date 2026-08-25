import { GameState } from './GameState.js';
import { buildWorld } from './World.js';
import { CombatSystem } from './systems/CombatSystem.js';
import { ProductionSystem } from './systems/ProductionSystem.js';
import { GroupSystem, releaseGarrison, moveGroup, attackWithGroup, setDefending, setDefendNode, splitGroup, mergeGroup, balanceGroups } from './systems/GroupSystem.js';
import { AISystem } from './systems/AISystem.js';
import { CenterSystem } from './systems/CenterSystem.js';
import { MiningSystem } from './systems/MiningSystem.js';
import { BossSystem } from './systems/BossSystem.js';
import { ProgressionSystem, buyMineUpgrade } from './systems/ProgressionSystem.js';
import { canAddWall } from './walls.js';
import { dist2 } from './utils/helpers.js';
import {
  SOLDIER_DEFS, TURRET_DEFS, MAX_TURRETS_PER_BASE, WORLD_SIZE,
  LATE_JOIN_PROTECT_BASE_MS, LATE_JOIN_PROTECT_PER_MIN_MS, LATE_JOIN_PROTECT_MAX_MS,
  LATE_JOIN_GOLD_PER_MIN, LATE_JOIN_GOLD_MAX,
} from './constants.js';

/** How much game time one tick advances. 50ms = 20 ticks per second. */
export const TICK_MS = 50;

/**
 * Simulation — the rules engine, and the ONLY doorway into it.
 * ───────────────────────────────────────────────────────────
 *
 * Both the browser (single-player practice, running this inside a Web Worker)
 * and the game server (Phase 1) create one of these and talk to it through the
 * same four methods. Same code, same rules, so practice mode and online play
 * can never drift apart.
 *
 * The rule that makes multiplayer possible:
 *
 *     NOTHING changes the game except applyCommand() and step().
 *
 * Previously the browser reached straight into the game state — clicking "buy
 * upgrade" called buyMineUpgrade() and decremented gold on the spot. That works
 * alone and is impossible online, because anyone can edit browser JavaScript.
 * Now the browser can only *ask*, and this class decides.
 */
export class Simulation {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.mode]    'ffa' | 'team' | 'mining'
   * @param {object}  [opts.logger]  Anything with .error/.warn. Defaults to console.
   */
  constructor({ mode = 'ffa', logger = console } = {}) {
    this.logger = logger;
    this.tick = 0;
    this.errorCount = 0;

    // No "local player" here any more. A simulation has eight equal seats and
    // does not know or care which of them a given viewer is looking through —
    // that is a per-connection fact, and on a server there are eight of them.
    this.state = new GameState(null);

    this._systems = {
      prog:   new ProgressionSystem(),
      prod:   new ProductionSystem(),
      ai:     new AISystem(),
      center: new CenterSystem(),
      mining: new MiningSystem(),
      boss:   new BossSystem(),
      group:  new GroupSystem(),
      combat: new CombatSystem(),
    };

    // The specialization prompt used to open a DOM modal directly from inside
    // the progression system. The rules engine can't touch the DOM, so it now
    // raises an event naming the player, and their client decides what to show.
    this._systems.prog.onSpecReady = (player) => {
      this.state.event('specReady', { ownerId: player.id });
    };

    buildWorld(this.state, mode);
  }

  // ── Seats ──────────────────────────────────────────────────────────────────
  //
  // Every match is built with all eight seats AI-driven. A human joining takes
  // one over; a human leaving hands it straight back. This one idea solves four
  // problems at once: matches are never empty, joining never involves waiting,
  // a disconnected player's allies aren't abandoned, and their enemies don't
  // get a free kill.

  /**
   * Hand a free seat to a connecting player.
   * @returns the claimed player object, or null if the match is full.
   */
  claimSeat(sessionId, name) {
    const free = [...this.state.players.values()].filter(p => p.alive && p.isBot && !p.sessionId);
    if (!free.length) return null;

    // Seat them as far as possible from whoever is currently strongest. Landing
    // next to a runaway leader is close to an instant loss, and that is a
    // miserable first impression for someone who just clicked Play.
    //
    // BUT ONLY ONCE THERE IS A REAL LEADER.
    //
    // At the start of a match every base has zero XP, so "strongest" was just
    // whichever seat the Map happened to yield first — always p0 — and the
    // farthest seat from p0 is always p4. Every single match therefore put the
    // player on the same base at the bottom-centre of the map. The heuristic
    // was not wrong, it simply had no signal to work with and quietly
    // degenerated into a constant.
    //
    // Below this threshold nobody is meaningfully ahead, so seat at random and
    // let the map feel different each time.
    const LEADER_XP_MIN = 1;

    const strongest = [...this.state.players.values()]
      .filter(p => p.alive)
      .sort((a, b) => b.base.xpEarned - a.base.xpEarned)[0];

    let pick = free[Math.floor(Math.random() * free.length)];
    if (strongest && strongest.base.xpEarned >= LEADER_XP_MIN) {
      let bestD = -Infinity;
      for (const p of free) {
        const d = dist2(p.base.position, strongest.base.position);
        if (d > bestD) { bestD = d; pick = p; }
      }
    }

    pick.isBot = false;
    pick.sessionId = sessionId;
    pick.name = (name || '').trim().slice(0, 16) || `Player ${pick.seat + 1}`;

    this._compensateLateJoin(pick);

    this.state.event('seatClaimed', { ownerId: pick.id, name: pick.name });
    return pick;
  }

  /**
   * Someone joining a match already in progress is at a real disadvantage: the
   * bases around them have had minutes to level up and build walls. Give them
   * breathing room proportional to how late they are.
   *
   * Without this, joining at minute 12 is close to an instant loss — which is a
   * miserable first impression for someone who just clicked Play.
   */
  _compensateLateJoin(player) {
    const elapsedMs = this.state.time;
    if (elapsedMs < 5000) return;   // joined at the start; normal rules apply

    const minutes = elapsedMs / 60000;

    player.base.spawnProtected = true;
    player.base.protectTimer = Math.min(
      LATE_JOIN_PROTECT_MAX_MS,
      LATE_JOIN_PROTECT_BASE_MS + minutes * LATE_JOIN_PROTECT_PER_MIN_MS,
    );

    // Enough gold to field a first squad rather than standing helpless.
    player.base.gold += Math.min(LATE_JOIN_GOLD_MAX, minutes * LATE_JOIN_GOLD_PER_MIN);
  }

  /** Give a seat back to the AI (disconnect, or going idle). */
  releaseSeat(sessionId) {
    const p = this.playerBySession(sessionId);
    if (!p) return null;
    p.isBot = true;
    p.sessionId = null;
    p.name = `Bot ${p.seat + 1}`;
    p._thinkTimer = 0;
    this.state.event('seatReleased', { ownerId: p.id });
    return p;
  }

  playerBySession(sessionId) {
    if (!sessionId) return null;
    for (const [, p] of this.state.players) if (p.sessionId === sessionId) return p;
    return null;
  }

  /** Display names by owner id, for the HUD and leaderboard. */
  names() {
    const out = {};
    for (const [, p] of this.state.players) out[p.id] = p.name;
    return out;
  }

  /** Owner ids currently driven by the AI. */
  botIds() {
    return [...this.state.players.values()].filter(p => p.isBot).map(p => p.id);
  }

  /** Seats a human could still take. */
  get freeSeats() {
    return [...this.state.players.values()].filter(p => p.alive && p.isBot && !p.sessionId).length;
  }

  // ── The clock ──────────────────────────────────────────────────────────────

  /**
   * Advance the game by exactly `dtMs` (always TICK_MS in practice).
   *
   * WHY A FIXED STEP: the old loop advanced by however long the last drawn
   * frame took, so a player on a slow machine ran the game in slightly bigger
   * jumps than one on a fast machine. Alone that's invisible. Shared between
   * eight people it isn't — combat outcomes would depend on whose computer was
   * busiest, and a server under load would silently speed the game up.
   */
  step(dtMs = TICK_MS) {
    this.tick++;
    const dt = dtMs / 1000;
    const s = this.state;

    try {
      s.time += dtMs;

      // Index every living soldier by map square. Costs one cheap pass over
      // the soldiers; saves the systems below from scanning all of them for
      // every proximity question they ask.
      s.grid.rebuild(s.soldiers.values());

      this._systems.prog.update(s, dtMs);
      this._systems.prod.update(s, dt, dtMs);
      this._systems.ai.update(s, dtMs);
      this._systems.center.update(s, dt, dtMs);
      this._systems.mining.update(s, dt, dtMs);
      this._systems.boss.update(s, dt, dtMs);
      this._systems.group.update(s, dt, dtMs);

      // Soldiers just moved, so the index is stale — rebuild before combat,
      // which is by far the heaviest user of it.
      s.grid.rebuild(s.soldiers.values());

      this._systems.combat.update(s, dt, dtMs);

      this._spinBases(dt);
    } catch (err) {
      // The old code swallowed this silently so a single-player game could limp
      // on. On a server that's dangerous: a match could break in minute 2 and
      // keep running wrong for eighteen more, for eight people, unnoticed. So
      // we count it and surface it — the room owner decides whether to end the
      // match (see Phase 1).
      this.errorCount++;
      this.logger.error(
        `[sim] tick ${this.tick} threw (error #${this.errorCount}): ${err?.stack || err}`
      );
      this.state.event('simError', { tick: this.tick, message: String(err?.message ?? err) });
    }
  }

  _spinBases(dt) {
    for (const [, player] of this.state.players) {
      if (!player.alive) continue;
      player.base.rotation += 0.3 * dt;
    }
  }

  // NOTE: the boss used to walk toward whichever base was nearest. It is now a
  // fortified position that never moves — see systems/BossSystem.js.

  // ── Commands ───────────────────────────────────────────────────────────────

  /**
   * Apply one player action. Returns { ok: boolean, reason?: string }.
   *
   * Every branch re-checks ownership and affordability here rather than
   * trusting the caller, because on the server the caller is a stranger's
   * browser. The production systems already checked gold and population before
   * spawning anything — those checks now become authoritative rather than
   * advisory.
   */
  applyCommand(playerId, cmd) {
    if (!cmd || typeof cmd.t !== 'string') return fail('malformed command');

    const player = this.state.players.get(playerId);
    if (!player) return fail('unknown player');
    if (!player.alive) return fail('eliminated');
    const base = player.base;

    switch (cmd.t) {
      case 'queue':      return this._cmdQueue(base, cmd);
      case 'turret':     return this._cmdTurret(base, cmd);
      case 'mine':       return buyMineUpgrade(this.state, base) ? ok() : fail('cannot afford or maxed');
      case 'skill':      return this._cmdSkill(player, base, cmd);
      case 'spec':       return this._cmdSpec(player, base, cmd);
      case 'release':    return releaseGarrison(this.state, base) ? ok() : fail('garrison empty');
      case 'move':       return this._cmdGroups(playerId, cmd, g => moveGroup(g, clampToMap(cmd.x), clampToMap(cmd.y)));
      case 'attack':     return this._cmdAttack(playerId, cmd);
      case 'defend':     return this._cmdGroups(playerId, cmd, g => setDefending(g, base));
      case 'defendNode': return this._cmdDefendNode(playerId, cmd);
      case 'split':      return this._cmdOneGroup(playerId, cmd, g => !!splitGroup(this.state, g));
      case 'merge':      return this._cmdOneGroup(playerId, cmd, g => !!mergeGroup(this.state, g));
      case 'balance':    return balanceGroups(this.state, playerId) ? ok() : fail('need two free squads');
      case 'donate':     return this._cmdDonate(playerId, cmd);
      case 'ping':       return this._cmdPing(playerId, cmd);
      default:           return fail(`unknown command '${cmd.t}'`);
    }
  }

  _cmdQueue(base, cmd) {
    const def = SOLDIER_DEFS[cmd.unit];
    if (!def) return fail('unknown unit');
    if (!base.unlocked.has(cmd.unit)) return fail('not unlocked');

    // The Defender ('sentinel') builds walls, which have their own queue so
    // soldiers and walls build in parallel rather than blocking each other.
    const q = cmd.unit === 'sentinel' ? base.wallQueue : base.soldierQueue;

    if (cmd.n === -1) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].type === cmd.unit) {
          q[i].count--;
          if (q[i].count <= 0) q.splice(i, 1);
          return ok();
        }
      }
      return fail('nothing queued');
    }

    if (cmd.unit === 'sentinel' && !canAddWall(base) && base.wallQueue.length === 0)
      return fail('walls maxed');

    const tail = q[q.length - 1];
    if (tail && tail.type === cmd.unit) tail.count++;
    else q.push({ type: cmd.unit, count: 1 });
    return ok();
  }

  _cmdTurret(base, cmd) {
    const def = TURRET_DEFS[cmd.kind];
    if (!def) return fail('unknown turret');
    if (base.level < def.unlockLv) return fail(`unlocks at level ${def.unlockLv}`);
    if (this.state.turretCount(base.id) + base.turretQueue.length >= MAX_TURRETS_PER_BASE)
      return fail('all turret mounts full');
    base.turretQueue.push({ type: cmd.kind });
    return ok();
  }

  _cmdSkill(player, base, cmd) {
    if (!['atk', 'def', 'spd'].includes(cmd.stat)) return fail('unknown stat');
    if (base.skillPoints <= 0) return fail('no skill points');
    player.buffs[cmd.stat] += 1;
    base.skillPoints -= 1;
    return ok();
  }

  _cmdSpec(player, base, cmd) {
    if (base.specialization) return fail('already specialized');
    if (!['bastion', 'warmonger', 'prospector'].includes(cmd.choice)) return fail('unknown specialization');
    this._systems.prog.applySpecialization(this.state, player, cmd.choice);
    return ok();
  }

  _cmdAttack(playerId, cmd) {
    const target = this.state.resolve(cmd.target);
    if (!target || target.hp <= 0) return fail('no such target');
    // You may not order an attack on your own things, or on an ally's in team mode.
    const targetOwner = this.state.bases.has(target.id) ? target.ownerId : target.ownerId;
    if (targetOwner && targetOwner !== 'neutral' && !this.state.areEnemies(playerId, targetOwner))
      return fail('not an enemy');
    return this._cmdGroups(playerId, cmd, g => attackWithGroup(g, cmd.target));
  }

  _cmdDefendNode(playerId, cmd) {
    const node = this.state.mineNodes.get(cmd.node);
    if (!node) return fail('no such node');
    return this._cmdGroups(playerId, cmd, g => setDefendNode(g, node));
  }

  _cmdDonate(playerId, cmd) {
    if (this.state.mode !== 'team') return fail('team mode only');
    const mate = this.state.players.get(cmd.to);
    if (!mate?.alive) return fail('no such teammate');
    if (this.state.areEnemies(playerId, cmd.to)) return fail('not a teammate');
    if (cmd.to === playerId) return fail('cannot donate to yourself');

    const g = this.state.groups.get(cmd.g);
    if (!g || g.ownerId !== playerId) return fail('not your squad');
    if (g.locked) return fail('squad is committed to an attack');
    if (!g.memberIds.length) return fail('squad is empty');

    const id = g.memberIds.pop();
    const s = this.state.soldiers.get(id);
    if (!s) return fail('soldier gone');
    s.groupId = null;
    s.donateTo = cmd.to;   // GroupSystem walks it over and transfers ownership
    return ok();
  }

  /**
   * A map ping — "attack here", "help", "defend", "retreat".
   *
   * Pings rather than text chat is a deliberate choice: free chat at scale
   * means profanity filtering, reporting, moderators and legal exposure around
   * minors. A fixed vocabulary gives most of the coordination value for almost
   * none of that cost.
   */
  _cmdPing(playerId, cmd) {
    this.state.event('ping', {
      ownerId: playerId,
      x: clampToMap(cmd.x),
      y: clampToMap(cmd.y),
      kind: cmd.kind,
      team: this.state.players.get(playerId)?.team ?? null,
    });
    return ok();
  }

  /** Run `fn` over every squad in cmd.g that this player actually owns. */
  _cmdGroups(playerId, cmd, fn) {
    const ids = Array.isArray(cmd.g) ? cmd.g : [cmd.g];
    if (!ids.length) return fail('no squads given');
    let any = false;
    for (const id of ids) {
      const g = this.state.groups.get(id);
      if (!g || g.ownerId !== playerId) continue;   // silently skip — not yours
      if (fn(g)) any = true;
    }
    return any ? ok() : fail('no squad could carry out that order');
  }

  _cmdOneGroup(playerId, cmd, fn) {
    const g = this.state.groups.get(cmd.g);
    if (!g || g.ownerId !== playerId) return fail('not your squad');
    return fn(g) ? ok() : fail('not allowed (locked or too small)');
  }

  // ── Output ─────────────────────────────────────────────────────────────────

  /** Events raised since the last call: kills, level-ups, eliminations, explosions. */
  drainEvents() {
    return this.state.flushEvents();
  }

  /**
   * A plain-data copy of the world, safe to hand across a Web Worker boundary
   * (or, in Phase 1, to a binary encoder).
   *
   * Everything here is plain objects and arrays — no class instances, no Maps,
   * no functions — because those cannot survive being sent between threads.
   *
   * PHASE 1 NOTE: this is deliberately simple and sends everything every tick.
   * That's fine inside one machine. Over a real network it's replaced by the
   * binary snapshot encoder with the formation trick described in the plan.
   */
  getSnapshot() {
    const s = this.state;
    return {
      tick: this.tick,
      time: s.time,
      mode: s.mode,
      players: [...s.players.values()].map(snapshotPlayer),
      soldiers: [...s.soldiers.values()].map(sol => ({
        id: sol.id, ownerId: sol.ownerId, type: sol.type,
        x: sol.position.x, y: sol.position.y,
        hp: sol.hp, maxHp: sol.maxHp, facing: sol.facing, groupId: sol.groupId,
      })),
      groups: [...s.groups.values()].map(g => ({
        id: g.id, ownerId: g.ownerId, memberIds: g.memberIds.slice(),
        status: g.status, targetId: g.targetId,
        anchorX: g.anchor.x, anchorY: g.anchor.y, facing: g.facing,
        locked: g.locked, formed: g.formed, defendNodeId: g.defendNodeId,
      })),
      turrets: [...s.turrets.values()].map(t => ({
        id: t.id, ownerId: t.ownerId, type: t.type, baseId: t.baseId,
        x: t.position.x, y: t.position.y, angle: t.angle, aimFacing: t.aimFacing,
      })),
      projectiles: [...s.projectiles.values()].map(p => ({
        id: p.id, ownerId: p.ownerId, x: p.position.x, y: p.position.y,
        splash: p.splash, color: p.color,
      })),
      eatables: [...s.eatables.values()].map(e => ({
        id: e.id, type: e.type, x: e.position.x, y: e.position.y,
        hp: e.hp, maxHp: e.maxHp, pulse: e.pulse, rot: e.rot,
      })),
      wildlings: [...s.wildlings.values()].map(w => ({
        id: w.id, x: w.position.x, y: w.position.y, hp: w.hp, maxHp: w.maxHp,
      })),
      mineNodes: [...s.mineNodes.values()].map(n => ({
        id: n.id, x: n.position.x, y: n.position.y, ownerId: n.ownerId,
        capturingBy: n.capturingBy, captureProg: n.captureProg,
        goldRate: n.goldRate, rot: n.rot,
      })),
      bosses: [...s.bosses.values()].map(b => ({
        id: b.id, index: b.index,
        x: b.position.x, y: b.position.y,
        hp: b.hp, maxHp: b.maxHp, rotation: b.rotation,
        walls: b.walls.map(l => ({
          ring: l.ring, radius: l.radius, maxCells: l.maxCells,
          cells: l.cells.map(c => ({ slot: c.slot, hp: c.hp, maxHp: c.maxHp })),
        })),
      })),
    };
  }

  /**
   * Has the match been decided? Returns null while it is still live.
   * The server also enforces a wall-clock time limit on top of this, because
   * eight cautious humans can otherwise turtle indefinitely.
   */
  matchResult() {
    const alive = [...this.state.players.values()].filter(p => p.alive);

    if (this.state.mode === 'team') {
      const teams = new Set(alive.map(p => p.team));
      if (teams.size > 1) return null;
      return { winnerTeam: [...teams][0] ?? null, winner: null, reason: 'lastStanding' };
    }

    if (alive.length > 1) return null;
    return { winner: alive[0]?.id ?? null, winnerTeam: null, reason: 'lastStanding' };
  }

  /** Final scoreboard, best first. Also decides the winner if time runs out. */
  standings() {
    return [...this.state.players.values()]
      .map(p => ({ id: p.id, name: p.name, xp: Math.floor(p.base.xpEarned), alive: p.alive }))
      .sort((a, b) => b.xp - a.xp);
  }

  /** Diagnostics — used by tests and, later, by server monitoring. */
  stats() {
    return {
      tick: this.tick,
      errorCount: this.errorCount,
      liveIds: this.state.ids.liveCount,
      highWaterId: this.state.ids.highWater,
      soldiers: this.state.soldiers.size,
      groups: this.state.groups.size,
    };
  }
}

function snapshotPlayer(p) {
  const b = p.base;
  return {
    id: p.id, seat: p.seat, isBot: p.isBot, name: p.name,
    team: p.team, color: p.color,
    alive: p.alive, buffs: { ...p.buffs },
    base: {
      id: b.id, x: b.position.x, y: b.position.y,
      hp: b.hp, maxHp: b.maxHp, level: b.level, gold: b.gold,
      xpEarned: b.xpEarned, rotation: b.rotation,
      mineLevel: b.mineLevel, miningBonus: b.miningBonus,
      bossBonus: b.bossBonus, goldMult: b.goldMult,
      garrison: b.garrison, skillPoints: b.skillPoints,
      specialization: b.specialization, spawnProtected: b.spawnProtected,
      lastAttackedAt: b.lastAttackedAt,
      unlocked: [...b.unlocked],                    // Set → array (Sets don't clone cleanly)
      walls: b.walls.map(l => ({
        ring: l.ring, radius: l.radius, maxCells: l.maxCells,
        cells: l.cells.map(c => ({ slot: c.slot, hp: c.hp, maxHp: c.maxHp })),
      })),
      soldierQueue: b.soldierQueue.map(e => ({ ...e })),
      wallQueue: b.wallQueue.map(e => ({ ...e })),
      turretQueue: b.turretQueue.map(e => ({ ...e })),
    },
  };
}

const clampToMap = (v) => Math.max(0, Math.min(WORLD_SIZE, Number(v) || 0));
const ok = () => ({ ok: true });
const fail = (reason) => ({ ok: false, reason });
