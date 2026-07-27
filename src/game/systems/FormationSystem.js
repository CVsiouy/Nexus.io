import { dist2, dist, uid } from '../../utils/helpers.js';
import {
  FORMATION_RADIUS, FORMATION_SPEED, MERGE_DIST,
  FORMATION_CLAIM_RANGE, CLAIM_RANGE,
} from '../constants.js';

/**
 * FormationSystem  (PLAYER ONLY)
 * ──────────────────────────────
 * The player no longer micromanages individual grunts — they live in
 * **formations**. A formation is a group of the player's grunts that moves,
 * fights, defends, and claims as one unit. Bots keep their own per-soldier AI.
 *
 * A formation:
 *   { id, ownerId, center:{x,y}, order:{kind,targetId,position}, memberIds:Set }
 *   order.kind ∈ 'idle' | 'move' | 'attack' | 'defend' | 'claim'
 *
 * Responsibilities:
 *   • Auto-enroll freshly spawned player grunts into the "home" formation.
 *   • Advance each formation's center toward its order target.
 *   • Steer member grunts to flock around the center and set their per-soldier
 *     order (so CombatSystem's existing attack/defend logic still applies).
 *   • Auto-merge formations that get close.
 *   • Prune dead/empty formations.
 */
export class FormationSystem {
  update(state, dt, dtMs) {
    this._ensureContainer(state);
    this._enrollNewGrunts(state);
    this._advance(state, dt, dtMs);
    this._merge(state);
    this._prune(state);
  }

  _ensureContainer(state) {
    if (!state.formations) state.formations = new Map(); // id → formation
  }

  /** New player grunts with no formation join the home formation (at base). */
  _enrollNewGrunts(state) {
    const pid = state.playerId;
    // Which grunts are already in a formation?
    const claimed = new Set();
    for (const [, f] of state.formations)
      for (const id of f.memberIds) claimed.add(id);

    let home = this._homeFormation(state);
    for (const [, sol] of state.soldiers) {
      if (sol.ownerId !== pid || sol.hp <= 0) continue;
      if (claimed.has(sol.id)) continue;
      if (!home) home = this._createFormation(state, pid, { ...state.getPlayerBase(pid).position });
      home.memberIds.add(sol.id);
    }
  }

  /** The formation nearest the base, treated as the rally/home group. */
  _homeFormation(state) {
    const base = state.getPlayerBase(state.playerId);
    let best = null, bestD = Infinity;
    for (const [, f] of state.formations) {
      if (f.ownerId !== state.playerId) continue;
      const d = dist2(f.center, base.position);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best;
  }

  _createFormation(state, ownerId, center) {
    const f = {
      id: 'f' + uid(),
      ownerId,
      center: { ...center },
      order: { kind: 'idle', targetId: null, position: null },
      memberIds: new Set(),
    };
    state.formations.set(f.id, f);
    return f;
  }

  /** Move each formation center toward its target and steer its grunts. */
  _advance(state, dt, dtMs) {
    for (const [, f] of state.formations) {
      // Recompute a live center from surviving members so it tracks reality.
      this._recenter(state, f);

      const { kind, targetId, position } = f.order;
      let target = null;

      if (kind === 'move' || kind === 'defend') {
        target = position;
      } else if (kind === 'attack') {
        const t = state.resolve(targetId);
        if (!t || t.hp <= 0) { f.order = { kind: 'idle', targetId: null, position: null }; }
        else target = t.position ?? this._linkMid(state, t);
      } else if (kind === 'claim') {
        const node = state.nodeSites.get(targetId);
        if (!node || node.status === 'claimed' && node.ownerId === f.ownerId) {
          f.order = { kind: 'idle', targetId: null, position: null };
        } else target = node.position;
      }

      // Move the center toward the target.
      if (target) {
        const dx = target.x - f.center.x, dy = target.y - f.center.y;
        const d  = Math.hypot(dx, dy);
        const stop = (kind === 'attack') ? 26 : (kind === 'claim' ? FORMATION_CLAIM_RANGE * 0.5 : 10);
        if (d > stop) {
          const step = FORMATION_SPEED * dt;
          f.center.x += (dx / d) * step;
          f.center.y += (dy / d) * step;
        }
      }

      // Steer members and hand each a per-soldier order the CombatSystem honours.
      this._steerMembers(state, f);
    }
  }

  _recenter(state, f) {
    // Prune dead members. When idle (no move/attack/claim target) gently snap the
    // command center to the live centroid so it doesn't drift; while moving, let
    // the commanded center LEAD (advanced in _advance) — only nudge slightly so a
    // straggler doesn't drag the whole group backward.
    let sx = 0, sy = 0, n = 0;
    for (const id of f.memberIds) {
      const s = state.soldiers.get(id);
      if (!s || s.hp <= 0) { f.memberIds.delete(id); continue; }
      sx += s.position.x; sy += s.position.y; n++;
    }
    if (n === 0) return;
    const cx = sx / n, cy = sy / n;
    const moving = f.order.kind === 'move' || f.order.kind === 'attack' || f.order.kind === 'claim';
    const k = moving ? 0.06 : 0.4; // lead when moving, settle when idle
    f.center.x += (cx - f.center.x) * k;
    f.center.y += (cy - f.center.y) * k;
  }

  _steerMembers(state, f) {
    const members = [];
    for (const id of f.memberIds) {
      const s = state.soldiers.get(id);
      if (s && s.hp > 0) members.push(s);
    }
    if (members.length === 0) return;

    const kind = f.order.kind;

    // For attack/claim, pass the formation's target straight to each grunt so
    // CombatSystem/ProductionSystem resolve it per-soldier. For move/defend/idle,
    // grunts get a 'move' order toward a slot around the formation center.
    members.forEach((s, i) => {
      if (kind === 'attack') {
        s.order = { kind: 'attack', targetId: f.order.targetId, position: null };
        s.stationed = false;
        return;
      }
      if (kind === 'claim') {
        s.order = { kind: 'claim', targetId: f.order.targetId, position: null };
        s.stationed = false;
        return;
      }
      // idle / move / defend → sit in a ring slot around the center.
      // BUT don't yank a grunt that's mid auto-defense (CombatSystem gave it a
      // live 'attack' order against a nearby enemy) — let it finish the fight,
      // then it returns to formation on its own once the target is gone.
      if (s.order.kind === 'attack') {
        const tgt = state.resolve(s.order.targetId);
        if (tgt && tgt.hp > 0) { s.stationed = (kind === 'defend'); return; }
      }

      const ang  = (i / members.length) * Math.PI * 2;
      const ring = members.length > 1 ? FORMATION_RADIUS : 0;
      const slot = {
        x: f.center.x + Math.cos(ang) * ring,
        y: f.center.y + Math.sin(ang) * ring,
      };
      if (dist2(s.position, slot) > 14 * 14) {
        s.order = { kind: 'move', targetId: null, position: slot };
      } else {
        // Close enough — go idle so CombatSystem auto-defense can trigger.
        s.order = { kind: 'idle', targetId: null, position: null };
      }
      s.stationed = (kind === 'defend'); // defenders hold; movers don't
    });
  }

  /** Auto-merge two friendly formations whose centers are close. */
  _merge(state) {
    const list = [...state.formations.values()].filter(f => f.ownerId === state.playerId);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (!state.formations.has(a.id) || !state.formations.has(b.id)) continue;
        if (a.memberIds.size === 0 || b.memberIds.size === 0) continue;
        if (dist(a.center, b.center) < MERGE_DIST) {
          // Merge b into a
          for (const id of b.memberIds) a.memberIds.add(id);
          // Keep a's order (the one the player is likely watching stays in charge)
          state.formations.delete(b.id);
          if (state.activeFormationId === b.id) state.activeFormationId = a.id;
        }
      }
    }
  }

  _prune(state) {
    for (const [id, f] of state.formations) {
      // Drop dead members
      for (const mid of f.memberIds) {
        const s = state.soldiers.get(mid);
        if (!s || s.hp <= 0) f.memberIds.delete(mid);
      }
      if (f.memberIds.size === 0) {
        state.formations.delete(id);
        if (state.activeFormationId === id) state.activeFormationId = null;
      }
    }
  }

  _linkMid(state, link) {
    const a = state.resolve(link.fromId), b = state.resolve(link.toId);
    if (!a || !b) return null;
    return { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 };
  }

  // ── Commands (called by InputSystem) ─────────────────────────────────────

  /** Split the active formation into two halves. Returns the new formation. */
  static split(state, formationId) {
    const f = state.formations.get(formationId);
    if (!f || f.memberIds.size < 2) return null;
    const ids = [...f.memberIds];
    const half = ids.slice(0, Math.floor(ids.length / 2));
    const nf = {
      id: 'f' + uid(),
      ownerId: f.ownerId,
      // Offset the new formation slightly so they don't instantly re-merge.
      center: { x: f.center.x + MERGE_DIST + 30, y: f.center.y },
      order: { kind: 'idle', targetId: null, position: null },
      memberIds: new Set(half),
    };
    for (const id of half) f.memberIds.delete(id);
    state.formations.set(nf.id, nf);
    return nf;
  }
}
