import { Soldier, Turret } from '../entities.js';
import {
  SOLDIER_DEFS, TURRET_DEFS, MAX_TURRETS_PER_BASE, GARRISON_MAX,
} from '../constants.js';
import { addSoldierToNearestGroup } from './GroupSystem.js';
import { addWallCell, canAddWall } from '../walls.js';

/**
 * ProductionSystem
 * ────────────────
 * • Spends the shared gold pool to build soldiers (into the nearest group) and
 *   turrets (mounted on the base ring), working through each base's queues.
 * • Bots auto-queue via the AISystem; here we just drain the queues.
 * • Runs spawn-protection countdown.
 */
export class ProductionSystem {
  update(state, dt, dtMs) {
    for (const [, player] of state.players) {
      if (!player.alive) continue;
      this._buildSoldiers(state, player, dtMs); // soldier queue …
      this._buildWalls(state, player, dtMs);    // … and wall queue run in PARALLEL
    }
    this._updateSpawnProtect(state, dtMs);
  }

  // ── Soldier production (own queue + timer) ──────────────────────────────────
  _buildSoldiers(state, player, dtMs) {
    const base = player.base;
    const q    = base.soldierQueue;
    if (!q.length) { base.soldierBuildTimer = 0; return; }

    const head = q[0];
    const def  = SOLDIER_DEFS[head.type];
    if (!def || !base.unlocked.has(head.type)) { q.shift(); return; }

    const speedMul = base.specialization === 'warmonger' ? 0.7 : 1;
    base.soldierBuildTimer += dtMs;
    if (base.soldierBuildTimer < def.spawnMs * speedMul) return;

    if (base.gold < def.cost) return;                                                   // can't afford
    if (state.soldierPop(player.id) + base.garrison + def.pop > state.popCap(player)) return; // no pop room (garrison counts)

    base.soldierBuildTimer = 0;
    base.gold -= def.cost;

    // Hold new soldiers in the garrison first (safe inside the base). Once it's
    // full they spawn to the field and join the home defending squad.
    if (head.type === 'grunt' && base.garrison < GARRISON_MAX) {
      base.garrison++;
    } else {
      const sol = this._emitSoldier(state, player, head.type);
      addSoldierToNearestGroup(state, sol);
    }

    head.count--;
    if (head.count <= 0) q.shift();
  }

  // ── Wall production (own queue + timer; runs alongside soldiers) ─────────────
  _buildWalls(state, player, dtMs) {
    const base = player.base;
    const q    = base.wallQueue;
    if (!q.length) { base.wallBuildTimer = 0; return; }
    if (!canAddWall(base)) { base.wallQueue = []; return; } // walls maxed (3 rings)

    const def = SOLDIER_DEFS.sentinel; // the Defender's cost/time
    const speedMul = base.specialization === 'warmonger' ? 0.7 : 1;
    base.wallBuildTimer += dtMs;
    if (base.wallBuildTimer < def.spawnMs * speedMul) return;

    if (base.gold < def.cost) return; // hold until affordable (no pop for walls)

    base.wallBuildTimer = 0;
    base.gold -= def.cost;
    addWallCell(base);

    const head = q[0];
    head.count--;
    if (head.count <= 0) q.shift();
  }

  _emitSoldier(state, player, type) {
    const base  = player.base;
    const angle = Math.random() * Math.PI * 2;
    const r     = 55 + Math.random() * 20;
    const x     = base.position.x + Math.cos(angle) * r;
    const y     = base.position.y + Math.sin(angle) * r;
    const sol   = new Soldier(state.newId(), player.id, type, x, y);
    state.soldiers.set(sol.id, sol);
    return sol;
  }

  // ── Turret production ──────────────────────────────────────────────────────
  _buildTurret(state, player) {
    const base = player.base;
    const q    = base.turretQueue;
    if (!q.length) return;

    const head = q[0];
    const def  = TURRET_DEFS[head.type];
    if (!def || base.level < def.unlockLv) { q.shift(); return; }

    if (state.turretCount(base.id) >= MAX_TURRETS_PER_BASE) { q.shift(); return; }
    if (base.gold < def.cost) return; // hold until affordable

    base.gold -= def.cost;
    this._mountTurret(state, player, head.type);
    q.shift();
  }

  _mountTurret(state, player, type) {
    const base  = player.base;
    // Distribute mounts evenly around the base ring.
    const slot  = state.turretCount(base.id);
    const angle = (slot / MAX_TURRETS_PER_BASE) * Math.PI * 2 - Math.PI / 2;
    const R     = 46;
    const x     = base.position.x + Math.cos(angle) * R;
    const y     = base.position.y + Math.sin(angle) * R;
    const turret = new Turret(state.newId(), player.id, type, base.id, x, y, angle);
    state.turrets.set(turret.id, turret);
    state.notify(`🔧 ${type.toUpperCase()} turret mounted`, 'success', player.id);
  }

  // ── Spawn Protection ─────────────────────────────────────────────────────
  _updateSpawnProtect(state, dtMs) {
    for (const [, player] of state.players) {
      if (!player.alive || !player.base.spawnProtected) continue;
      player.base.protectTimer -= dtMs;
      if (player.base.protectTimer <= 0) player.base.spawnProtected = false;
    }
  }
}
