import { dist2 } from '../utils/helpers.js';
import {
  BOT_THINK_RATE, SOLDIER_DEFS, GROUP_MAX_SIZE, GARRISON_MAX,
  DEFENDER_EDGE, BOT_THREAT_RADIUS, BOT_THREAT_FLOOR, BOT_THREAT_FRACTION,
  BOT_DEFENCE_SAFETY, BOT_CAUTION,
  BOT_MIN_HOME, BOT_ATTACK_EDGE, BOT_PATIENCE,
  BOT_RESTLESS_AFTER, BOT_RESTLESS_DECAY, BOT_RESTLESS_FLOOR,
  BASE_DEFENSE_RADIUS, MAX_WALL_LAYERS,
} from '../constants.js';
import { attackWithGroup, setDefending, moveGroup, releaseGarrison } from './GroupSystem.js';
import { buyMineUpgrade, mineUpgradeCost } from './ProgressionSystem.js';
import { outerBlockingLayer } from '../walls.js';

/**
 * AISystem — the bot brains.
 * ─────────────────────────
 *
 * THE IDEA: A FORCE BUDGET
 *
 * Every think tick a bot answers one question before anything else:
 *
 *     "How much of my army must stay home, and how much is genuinely spare?"
 *
 * Only the spare part is allowed to attack. That single rule produces all the
 * behaviour we want, without a pile of special cases:
 *
 *   • A bot with one squad facing an enemy with three keeps it home, because
 *     the budget says nothing is spare.
 *   • A bot under attack does not march its defenders away, because the
 *     attackers themselves consume the whole budget.
 *   • A bot with a big army and quiet neighbours attacks, because it has real
 *     surplus.
 *
 * WHY THE BUDGET IS THE RIGHT SHAPE
 *
 * Committing a squad to an attack is IRREVERSIBLE here — once attacking, it is
 * locked until its target falls or it dies. A bot that guesses wrong cannot
 * take it back. So the decision deserves actual arithmetic rather than "do I
 * have a full squad? then charge".
 *
 * THE DEFENDER'S EDGE
 *
 * Defending soldiers hit harder and take less (DEFENDER_ATK_MULT /
 * DEFENDER_DMG_TAKEN), so they are worth about 1.34 attackers each. The bot
 * uses that both ways: it needs FEWER soldiers to hold than to take, and it
 * demands a real advantage before attacking into someone else's defence. It
 * also keeps its defenders concentrated at the base rather than spread out,
 * because a base ringed by its own soldiers cannot be damaged at all until they
 * are cleared — so massing is strictly better than scattering.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO
 *
 *   1. It never reads enemy garrisons. Soldiers held inside a base are
 *      invisible to human players, and a bot that could see them would be
 *      cheating. It counts only what is on the map, exactly like you can.
 *   2. It cannot be frozen by a lone scout. Threat is measured as force, not
 *      presence, so one grunt parked outside barely moves the budget — and
 *      BOT_RESTLESS_* guarantees a bot that has been stalled for a long time
 *      gradually lowers its bar rather than turtling until the match times out.
 */
export class AISystem {
  update(state, dtMs) {
    // One pass over the soldiers, shared by every bot this tick. Doing it per
    // bot would be eight scans of the whole map every couple of seconds.
    let census = null;

    for (const [, player] of state.players) {
      if (!player.isBot || !player.alive) continue;
      player._thinkTimer -= dtMs;
      if (player._thinkTimer > 0) continue;
      // Jitter so eight bots don't all think on the same tick.
      player._thinkTimer = BOT_THINK_RATE + Math.random() * 800;

      if (!census) census = this._census(state);
      this._think(state, player, census);
    }
  }

  /** Living soldiers per owner, counted once per tick for all bots. */
  _census(state) {
    const byOwner = new Map();
    for (const [, s] of state.soldiers) {
      if (s.hp <= 0) continue;
      byOwner.set(s.ownerId, (byOwner.get(s.ownerId) ?? 0) + 1);
    }
    return byOwner;
  }

  _think(state, player, census) {
    const tier = player.botTier ?? 'standard';
    const base = player.base;

    // Scratch state persists between thinks; initialise on first use.
    if (player._calm == null) player._calm = 0;
    if (player._idleTicks == null) player._idleTicks = 0;

    this._economy(state, player, tier);

    const view = this._assess(state, player, tier, census);

    this._holdHome(state, player, view);
    this._spendSurplus(state, player, tier, view, census);
  }

  // ── Assessment ─────────────────────────────────────────────────────────────

  /**
   * Work out the force budget. Everything downstream reads from this.
   *
   * Counts are in soldiers. `homeNeed` is how many must stay; `surplus` is what
   * is genuinely free to attack with.
   */
  _assess(state, player, tier, census) {
    const base = player.base;
    const bx = base.position.x, by = base.position.y;

    // 1. Who is actually pressing my base right now? Force, not presence — a
    //    single scout must not be able to pin a bot down indefinitely.
    let pressing = 0;
    state.grid.forEachNear(bx, by, BOT_THREAT_RADIUS, (s) => {
      if (s.hp <= 0 || !state.areEnemies(player.id, s.ownerId)) return;
      const dx = s.position.x - bx, dy = s.position.y - by;
      if (dx * dx + dy * dy <= BOT_THREAT_RADIUS * BOT_THREAT_RADIUS) pressing++;
    });

    // 2. Squads already committed to attacking me. They are locked onto this
    //    base, so they WILL arrive even if they are still crossing the map —
    //    seeing them early is the difference between preparing and reacting.
    let inbound = 0;
    for (const [, g] of state.groups) {
      if (g.status !== 'attacking' || g.targetId !== base.id) continue;
      if (!state.areEnemies(player.id, g.ownerId)) continue;
      inbound += g.memberIds.length;
    }

    // Don't double-count: attackers already at the door are in both numbers.
    const actualThreat = Math.max(pressing, inbound);

    // 3. The biggest enemy army in the match, wherever it is. This is the term
    //    that answers "they have three squads and I have one" — a threat that
    //    has not materialised, weighted well below one that has.
    let strongestEnemy = 0;
    for (const [, other] of state.players) {
      if (!other.alive || !state.areEnemies(player.id, other.id)) continue;
      strongestEnemy = Math.max(strongestEnemy, census.get(other.id) ?? 0);
    }

    // 4. How many defenders that demands. Defenders are worth ~1.34 attackers
    //    each, so we need proportionally fewer of them than the enemy has.
    const safety = BOT_DEFENCE_SAFETY[tier] ?? BOT_DEFENCE_SAFETY.standard;
    const caution = BOT_CAUTION[tier] ?? BOT_CAUTION.standard;
    const floor = BOT_MIN_HOME[tier] ?? BOT_MIN_HOME.standard;

    const homeNeed = Math.max(
      floor,
      (actualThreat * safety) / DEFENDER_EDGE,
      (strongestEnemy * caution) / DEFENDER_EDGE,
    );

    // 5. What I actually have. Garrisoned soldiers count — they are one command
    //    away from being defenders, and they are the safest troops I own.
    const myTotal = census.get(player.id) ?? 0;
    const available = myTotal + base.garrison;

    const underAttack = (state.time - (base.lastAttackedAt ?? -Infinity)) < 4000;

    // 6. Does the threat actually warrant staying home?
    //
    // Presence is not enough. If ANY enemy nearby froze the bot, a human could
    // park one cheap grunt outside and suppress it for the whole match — which
    // would make these bots worse than the ones they replaced. The threat has
    // to be large in absolute terms AND relative to the army it faces.
    //
    // Taking real damage always counts, however small the force: if the base
    // is being hit, the defence has already failed to shield it.
    const meaningful = Math.max(BOT_THREAT_FLOOR, available * BOT_THREAT_FRACTION);
    const threatened = underAttack || actualThreat >= meaningful;

    return {
      pressing,
      inbound,
      actualThreat,
      strongestEnemy,
      homeNeed,
      available,
      surplus: available - homeNeed,
      underAttack,
      threatened,
    };
  }

  // ── Defence ────────────────────────────────────────────────────────────────

  /**
   * Make sure home is actually held.
   *
   * Note this only ever re-tasks UNLOCKED squads. A squad already committed to
   * an attack cannot be recalled — that is a game rule, and pretending
   * otherwise would silently do nothing.
   */
  _holdHome(state, player, view) {
    const base = player.base;
    const free = state.groupsOf(player.id).filter(g => !g.locked);

    if (view.threatened) {
      player._calm = 0;

      // Everything not committed comes home and masses at the base. Massing
      // matters: a base ringed by its own soldiers cannot be damaged until they
      // are cleared, so concentration is strictly better than spreading out.
      for (const g of free) setDefending(g, base);

      this._releaseGarrisonForDefence(state, player, view);
      return;
    }

    player._calm++;

    // Calm: still keep a home guard, but let the garrison build toward a
    // deployable squad rather than trickling soldiers onto the map where they
    // get picked off one at a time.
    if (base.garrison >= GARRISON_MAX) releaseGarrison(state, base);

    // Any squad with no orders defends by default. Idle squads are wasted.
    for (const g of free) {
      if (g.status === 'idle') setDefending(g, base);
    }
  }

  /**
   * Decide whether to commit the garrison to the fight.
   *
   * The tension: soldiers released one at a time get killed one at a time,
   * but soldiers held while the base burns are worthless. So the release
   * threshold scales with how much danger the base is actually in.
   */
  _releaseGarrisonForDefence(state, player, view) {
    const base = player.base;
    if (base.garrison <= 0) return;

    const hpFrac = base.hp / base.maxHp;
    const onField = Math.max(0, view.available - base.garrison);
    const shortfall = Math.max(0, view.homeNeed - onField);

    let need;
    if (hpFrac < 0.25) {
      need = 1;                                   // emergency: everything, now
    } else if (hpFrac < 0.55) {
      need = Math.min(GARRISON_MAX, Math.max(4, Math.ceil(shortfall * 0.6)));
    } else {
      need = Math.min(GARRISON_MAX, Math.max(6, Math.ceil(shortfall * 0.85)));
    }

    if (base.garrison >= need || base.garrison >= GARRISON_MAX) {
      releaseGarrison(state, base);
    }
  }

  // ── Offence ────────────────────────────────────────────────────────────────

  /**
   * Spend genuine surplus, and only genuine surplus.
   *
   * Four gates, all of which must pass. Any one of them failing means the bot
   * stays home — which is the correct answer far more often than the old code
   * assumed.
   */
  _spendSurplus(state, player, tier, view, census) {
    const base = player.base;

    // Gate 1: never leave while the fight is at your door.
    if (view.threatened) { player._idleTicks++; return; }

    // Gate 2: wait out a possible feint. A human stepping back for two seconds
    // should not instantly get a counter-attack in the face.
    const patience = BOT_PATIENCE[tier] ?? BOT_PATIENCE.standard;
    if (player._calm < patience) { player._idleTicks++; return; }

    // Gate 3: the surplus must cover a real squad. Sending less than a full
    // formation is feeding, and squads cannot deploy below 15 anyway.
    const deployable = state.groupsOf(player.id)
      .filter(g => !g.locked && (g.memberIds.length >= GROUP_MAX_SIZE || g.formed))
      .sort((a, b) => b.memberIds.length - a.memberIds.length);

    if (!deployable.length || view.surplus < GROUP_MAX_SIZE) {
      player._idleTicks++;
      // Team mode: with nothing to spare offensively, help a pressed ally.
      this._helpAlly(state, player, view);
      return;
    }

    // How many squads can leave without breaking the home budget.
    const canSend = Math.max(0, Math.floor(view.surplus / GROUP_MAX_SIZE));
    if (canSend <= 0) { player._idleTicks++; return; }

    // Mining mode: an uncontested node is cheaper than a base assault.
    if (state.mode === 'mining') {
      const node = this._nearestFreeNode(state, player);
      if (node && Math.random() < 0.6) {
        moveGroup(deployable[0], node.position.x, node.position.y);
        player._idleTicks = 0;
        return;
      }
    }

    // Gate 4: is any target actually worth taking with what I can spare?
    const force = Math.min(canSend, deployable.length) * GROUP_MAX_SIZE;
    const target = this._pickTarget(state, player, tier, force, census);
    if (!target) { player._idleTicks++; return; }

    for (let i = 0; i < Math.min(canSend, deployable.length); i++) {
      attackWithGroup(deployable[i], target.base.id);
    }
    player._idleTicks = 0;
    player._calm = 0;
  }

  /**
   * Choose a base worth attacking, or null to stay home.
   *
   * Scores every living enemy on how takeable they are with the force we can
   * actually spare, then rejects the best one anyway if the numbers do not
   * justify a locked commitment.
   */
  _pickTarget(state, player, tier, force, census) {
    const base = player.base;

    // Impatience: a bot stalled for a long time lowers its bar rather than
    // turtling until the match times out. Eight cautious bots must not stare
    // at each other for twenty minutes.
    let edge = BOT_ATTACK_EDGE[tier] ?? BOT_ATTACK_EDGE.standard;
    if (player._idleTicks > BOT_RESTLESS_AFTER) {
      const impatience = (player._idleTicks - BOT_RESTLESS_AFTER) * BOT_RESTLESS_DECAY;
      edge = Math.max(BOT_RESTLESS_FLOOR, edge - impatience);
    }

    let best = null, bestScore = -Infinity;

    for (const [, other] of state.players) {
      if (!other.alive || !state.areEnemies(player.id, other.id)) continue;

      // What is visibly defending them. Garrisons are NOT counted — they are
      // invisible to human players, and reading them would be cheating.
      const defenders = this._visibleDefenders(state, other);

      // Defenders are worth ~1.34 attackers each, and walls demand more still.
      const walls = outerBlockingLayer(other.base) ? 1 + (other.base.walls.length / MAX_WALL_LAYERS) : 1;
      const required = Math.max(1, defenders * DEFENDER_EDGE * walls * edge);
      if (force < required) continue;   // cannot take it — do not commit

      // Prefer the weakest and the nearest. Distance matters because the
      // journey is time spent with a thinner defence at home.
      const d = Math.sqrt(dist2(base.position, other.base.position)) || 1;
      const hpFrac = other.base.hp / other.base.maxHp;
      const score = (force / required) * 2 - hpFrac - (d / 2000);

      if (score > bestScore) { bestScore = score; best = other; }
    }

    return best;
  }

  /** Enemy soldiers visibly stationed around a base. Excludes hidden garrisons. */
  _visibleDefenders(state, other) {
    let n = 0;
    const px = other.base.position.x, py = other.base.position.y;
    const r2 = BASE_DEFENSE_RADIUS * BASE_DEFENSE_RADIUS;
    state.grid.forEachNear(px, py, BASE_DEFENSE_RADIUS, (s) => {
      if (s.hp <= 0 || s.ownerId !== other.id) return;
      const dx = s.position.x - px, dy = s.position.y - py;
      if (dx * dx + dy * dy <= r2) n++;
    });
    return n;
  }

  /** Team mode: send a spare squad to a teammate who is being pressed. */
  _helpAlly(state, player, view) {
    if (state.mode !== 'team') return;
    if (view.surplus < GROUP_MAX_SIZE * 0.5) return;

    const free = state.groupsOf(player.id)
      .filter(g => !g.locked && (g.memberIds.length >= GROUP_MAX_SIZE || g.formed));
    if (free.length < 2) return;   // never send the last one

    for (const [, ally] of state.players) {
      if (!ally.alive || ally.id === player.id) continue;
      if (state.areEnemies(player.id, ally.id)) continue;

      const pressed = state.grid.any(
        ally.base.position.x, ally.base.position.y, BOT_THREAT_RADIUS,
        (s) => s.hp > 0 && state.areEnemies(ally.id, s.ownerId),
      );
      if (pressed) { setDefending(free[0], ally.base); return; }
    }
  }

  _nearestFreeNode(state, player) {
    let best = null, bestD2 = Infinity;
    for (const [, node] of state.mineNodes) {
      if (node.ownerId === player.id) continue;
      const d2 = dist2(player.base.position, node.position);
      if (d2 < bestD2) { bestD2 = d2; best = node; }
    }
    return best;
  }

  // ── Economy ────────────────────────────────────────────────────────────────

  _economy(state, player, tier) {
    const base = player.base;

    // Reinvest in mining — turtles reinvest most, since they fight least.
    const mineChance = tier === 'passive' ? 0.35 : tier === 'standard' ? 0.2 : 0.12;
    const mc = mineUpgradeCost(base);
    if (mc != null && base.gold >= mc * 2 && Math.random() < mineChance) buyMineUpgrade(state, base);

    // Walls, on their own queue so they build in parallel with soldiers.
    // Under real pressure a wall is worth more than another grunt: it buys the
    // time for the garrison to become a formation.
    const threatened = (state.time - (base.lastAttackedAt ?? -Infinity)) < 8000;
    const wallChance = threatened
      ? 0.5
      : tier === 'passive' ? 0.4 : tier === 'standard' ? 0.25 : 0.12;
    if (base.wallQueue.length === 0 && Math.random() < wallChance && base.gold >= SOLDIER_DEFS.sentinel.cost) {
      base.wallQueue.push({ type: 'sentinel', count: 1 });
    }

    // Always keep a soldier queued if there is population room.
    if (base.soldierQueue.length === 0) {
      const def = SOLDIER_DEFS.grunt;
      if (state.soldierPop(player.id) + def.pop <= state.popCap(player)) {
        base.soldierQueue.push({ type: 'grunt', count: 1 });
      }
    }
  }
}
