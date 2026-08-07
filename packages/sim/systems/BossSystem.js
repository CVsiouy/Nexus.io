import { Boss, Soldier, Group } from '../entities.js';
import {
  WORLD_SIZE, BOSS_COUNT, BOSS_FIRST_MS, BOSS_STAGGER_MS, BOSS_SPREAD,
  BOSS_WALL_CELLS, BOSS_WALL_RADIUS, BOSS_WALL_CELL_HP,
  BOSS_SQUAD_SIZE, BOSS_SQUAD_INTERVAL_MS, BOSS_MAX_SQUADS,
} from '../constants.js';

/**
 * BossSystem — the fortified objective in the middle of the map.
 * ────────────────────────────────────────────────────────────
 *
 * WHAT CHANGED AND WHY
 *
 * The boss used to be a star that drifted toward whichever base was nearest and
 * swiped at anything it touched. That was bad in two ways: it had no presence
 * (you could not plan around something that wanders), and it was unkillable in
 * practice because it walked away from whoever was fighting it while bots had
 * no idea what to do about it.
 *
 * Now it is a place rather than a creature. It sits still in the centre behind
 * a ring of wall, grows a small garrison on a slow timer, and waits. That makes
 * the middle of the map a thing worth contesting — and because killing one
 * grants permanent income, contesting it EARLY compounds.
 *
 * Deliberately absent: no economy, no healing, no wall repair, no rebuilding a
 * broken ring. Everything it has, it starts with. Damage you do to a boss is
 * permanent, so several players can wear one down across a match, and a failed
 * assault still leaves it weaker for whoever comes next.
 */
export class BossSystem {
  update(state, dt, dtMs) {
    this._spawnOnSchedule(state);

    for (const [, boss] of state.bosses) {
      boss.rotation += 0.6 * dt;          // purely cosmetic
      if (boss.atkCd > 0) boss.atkCd -= dtMs;
      this._growGarrison(state, boss, dtMs);
    }
  }

  /** Bosses appear on a fixed schedule, not on a repeating timer. */
  _spawnOnSchedule(state) {
    for (let i = 0; i < BOSS_COUNT; i++) {
      if (state.bossesSpawned > i) continue;
      const due = BOSS_FIRST_MS + i * BOSS_STAGGER_MS;
      if (state.time < due) break;        // they are ordered, so stop at the first not-yet-due

      this._spawn(state, i);
      state.bossesSpawned = i + 1;
    }
  }

  _spawn(state, index) {
    // Spread them around the exact centre so two bosses do not overlap, while
    // both still sit in the contested middle of the map.
    const c = WORLD_SIZE / 2;
    const angle = (index / Math.max(1, BOSS_COUNT)) * Math.PI * 2 - Math.PI / 2;
    const x = BOSS_COUNT === 1 ? c : c + Math.cos(angle) * BOSS_SPREAD;
    const y = BOSS_COUNT === 1 ? c : c + Math.sin(angle) * BOSS_SPREAD;

    const boss = new Boss(state.newId(), x, y, index);

    // One complete ring, built once. Nothing ever repairs or replaces it, so
    // every cell an attacker destroys stays destroyed for the rest of the match.
    boss.walls = [{
      ring: 0,
      radius: BOSS_WALL_RADIUS,
      maxCells: BOSS_WALL_CELLS,
      cells: Array.from({ length: BOSS_WALL_CELLS }, (_, slot) => ({
        slot, hp: BOSS_WALL_CELL_HP, maxHp: BOSS_WALL_CELL_HP,
        lastHit: -Infinity,
      })),
    }];

    state.bosses.set(boss.id, boss);
    state.event('bossSpawned', { id: boss.id, index, x, y });
  }

  /**
   * Grow the garrison on a slow timer, up to a hard cap.
   *
   * Capped rather than endless on purpose: a boss that kept producing would
   * eventually be untakeable, and an objective nobody can take is just scenery.
   */
  _growGarrison(state, boss, dtMs) {
    if (boss.squadsMade >= BOSS_MAX_SQUADS) return;

    boss.spawnTimer += dtMs;
    if (boss.spawnTimer < BOSS_SQUAD_INTERVAL_MS) return;
    boss.spawnTimer = 0;
    boss.squadsMade++;

    const g = new Group(state.newId(), 'boss', boss.position.x, boss.position.y);
    // Guard the boss itself. Boss squads have no mother base, so they hold this
    // point instead — see Group.guardPos.
    g.guardPos = { x: boss.position.x, y: boss.position.y };
    g.status = 'defending';
    g.formed = false;          // never deployable; these are defenders only

    for (let i = 0; i < BOSS_SQUAD_SIZE; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 26 + Math.random() * 18;
      const s = new Soldier(
        state.newId(), 'boss', 'grunt',
        boss.position.x + Math.cos(a) * r,
        boss.position.y + Math.sin(a) * r,
      );
      state.soldiers.set(s.id, s);
      s.groupId = g.id;
      g.memberIds.push(s.id);
    }

    state.groups.set(g.id, g);
  }
}
