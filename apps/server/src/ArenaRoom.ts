import { Room, Client } from '@colyseus/core';
// @ts-expect-error — the simulation is plain JavaScript by design (see the plan).
import { Simulation } from '@nexus/sim';
import {
  validateCommand, encodeSnapshot, PROTOCOL_VERSION, TICK_MS, SNAPSHOT_EVERY_TICKS,
  COMMAND_RATE_LIMIT, SEATS, MATCH_LIMIT_MS, RECONNECT_GRACE_MS, MSG,
  type Command,
} from '@nexus/protocol';

/**
 * How often a full keyframe goes out. Between keyframes we omit the fields that
 * barely ever change (names, colours, base positions, maxHp), and the client
 * carries them forward. Every 20 snapshots is once every two seconds.
 *
 * Anyone joining gets a keyframe immediately, so they never have to wait for
 * one to be able to draw the world.
 */
const KEYFRAME_EVERY = 20;

/**
 * ArenaRoom — one match.
 * ─────────────────────
 *
 * A "room" is Colyseus's word for a single game: its own world, its own eight
 * players, completely independent of every other match on the server. One
 * server process runs many rooms side by side, and they never interact — which
 * is what makes scaling to more players a matter of renting more machines
 * rather than writing more code.
 *
 * This class is deliberately thin. All the game rules live in the shared
 * `Simulation`, exactly the same code the browser runs for practice mode. This
 * file only handles: who is connected, whose commands are whose, when to send
 * the world out, and when the match is over.
 */
export class ArenaRoom extends Room {
  maxClients = SEATS;

  private sim!: any;
  private tickCount = 0;
  private snapshotCount = 0;
  private startedAt = 0;
  private phase: 'live' | 'ended' = 'live';

  /** Command budget per client, refilled every second (flood protection). */
  private budgets = new Map<string, number>();

  /** Which owner id ("p3") each connected client controls. */
  private seatOf = new Map<string, string>();

  onCreate(options: { mode?: 'ffa' | 'team' | 'mining' }) {
    const mode = options?.mode ?? 'ffa';

    this.sim = new Simulation({ mode, logger: console });
    this.startedAt = Date.now();
    this.setMetadata({ mode, players: 0 });

    this.onMessage(MSG.COMMAND, (client, raw) => this.handleCommand(client, raw));

    // Latency probe: the client sends its own clock reading, we bounce it
    // straight back untouched. The client subtracts it from "now" to get the
    // round trip. Doing it this way means no clock synchronisation is needed —
    // only the client's own clock is ever compared with itself.
    this.onMessage(MSG.LATENCY, (client, sentAt) => {
      client.send(MSG.LATENCY, sentAt);
    });

    // The authoritative clock. Colyseus calls this every TICK_MS, and it is the
    // ONLY thing that advances the game — no client can make time pass.
    this.setSimulationInterval(() => this.tick(), TICK_MS);

    // Refill everyone's command budget once a second.
    this.clock.setInterval(() => {
      for (const key of this.budgets.keys()) this.budgets.set(key, COMMAND_RATE_LIMIT);
    }, 1000);

    console.log(`[room ${this.roomId}] created (${mode})`);
  }

  // ── Joining and leaving ────────────────────────────────────────────────────

  onJoin(client: Client, options: { name?: string; protocol?: number }) {
    if (options?.protocol !== PROTOCOL_VERSION) {
      // Better to refuse clearly at the door than to connect and then misbehave
      // in confusing ways once the message shapes turn out not to match.
      throw new Error(
        `Protocol mismatch: server speaks v${PROTOCOL_VERSION}, client sent v${options?.protocol}. ` +
        `Reload the page to get the current version.`
      );
    }

    const player = this.sim.claimSeat(client.sessionId, options?.name);
    if (!player) throw new Error('This match is full.');

    this.seatOf.set(client.sessionId, player.id);
    this.budgets.set(client.sessionId, COMMAND_RATE_LIMIT);

    client.send(MSG.WELCOME, {
      protocol: PROTOCOL_VERSION,
      youAre: player.id,
      seat: player.seat,
      mode: this.sim.state.mode,
      names: this.sim.names(),
      startedAt: this.startedAt,
      phase: this.phase,
    });

    // A keyframe straight away, so they can draw the world on the next frame
    // instead of waiting up to two seconds for the next scheduled one.
    client.send(MSG.SNAPSHOT, new Uint8Array(encodeSnapshot(this.sim.getSnapshot(), true)));

    this.broadcastRoster();
    this.setMetadata({ players: this.seatOf.size });
    console.log(`[room ${this.roomId}] ${player.name} joined as ${player.id} (${this.seatOf.size}/${SEATS})`);
  }

  async onLeave(client: Client, consented: boolean) {
    const ownerId = this.seatOf.get(client.sessionId);

    // Hand the base straight to the AI so the player's allies aren't abandoned
    // and their enemies don't get a free kill while they reconnect.
    this.sim.releaseSeat(client.sessionId);
    this.broadcastRoster();
    console.log(`[room ${this.roomId}] ${ownerId} left (consented=${consented}) — AI took over`);

    if (consented) { this.forget(client); return; }

    // Unexpected drop: hold the seat open for a while in case they come back.
    try {
      await this.allowReconnection(client, RECONNECT_GRACE_MS / 1000);
      const player = this.reclaim(client.sessionId, ownerId);
      if (player) {
        this.seatOf.set(client.sessionId, player.id);
        this.budgets.set(client.sessionId, COMMAND_RATE_LIMIT);
        client.send(MSG.WELCOME, {
          protocol: PROTOCOL_VERSION,
          youAre: player.id,
          seat: player.seat,
          mode: this.sim.state.mode,
          names: this.sim.names(),
          startedAt: this.startedAt,
          phase: this.phase,
        });
        client.send(MSG.SNAPSHOT, new Uint8Array(encodeSnapshot(this.sim.getSnapshot(), true)));
        this.broadcastRoster();
        console.log(`[room ${this.roomId}] ${ownerId} reconnected`);
      }
    } catch {
      this.forget(client);
      console.log(`[room ${this.roomId}] ${ownerId} did not return — seat freed`);
    }
  }

  /** Put a returning player back on the exact base they left, if it still lives. */
  private reclaim(sessionId: string, ownerId: string | undefined) {
    if (!ownerId) return null;
    const p = this.sim.state.players.get(ownerId);
    if (!p || !p.alive || !p.isBot) return null;
    p.isBot = false;
    p.sessionId = sessionId;
    return p;
  }

  private forget(client: Client) {
    this.seatOf.delete(client.sessionId);
    this.budgets.delete(client.sessionId);
    this.setMetadata({ players: this.seatOf.size });
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  private handleCommand(client: Client, raw: unknown) {
    if (this.phase !== 'live') return;

    // 1. Flood protection, before we do any work at all.
    const budget = this.budgets.get(client.sessionId) ?? 0;
    if (budget <= 0) return;
    this.budgets.set(client.sessionId, budget - 1);

    // 2. Shape validation. This is untrusted input from a stranger's browser,
    //    so anything not explicitly allowed is dropped.
    const cmd: Command | null = validateCommand(raw);
    if (!cmd) {
      client.send(MSG.REJECTED, { cmd: String((raw as any)?.t ?? '?'), reason: 'malformed command' });
      return;
    }

    // 3. Which seat is this? A client can only ever command its own.
    const ownerId = this.seatOf.get(client.sessionId);
    if (!ownerId) return;

    // 4. The simulation decides whether it's actually allowed — it is the only
    //    thing that knows the gold, the ownership and the game state.
    const result = this.sim.applyCommand(ownerId, cmd);
    if (!result.ok) client.send(MSG.REJECTED, { cmd: cmd.t, reason: result.reason });
  }

  // ── The clock ──────────────────────────────────────────────────────────────

  private tick() {
    if (this.phase !== 'live') return;

    this.tickCount++;
    this.sim.step(TICK_MS);

    const events = this.sim.drainEvents();

    // Send the world 10 times a second, not 20. The client interpolates between
    // snapshots, so a higher rate costs bandwidth without looking any better.
    if (this.tickCount % SNAPSHOT_EVERY_TICKS === 0) {
      this.snapshotCount++;
      const keyframe = this.snapshotCount % KEYFRAME_EVERY === 0;

      // Encoded ONCE and broadcast to everyone. All eight players see the whole
      // map, so unlike most .io games there is no per-client filtering to do —
      // which means one encode serves the entire room.
      //
      // Binary rather than JSON: measured at 18x smaller, because JSON repeats
      // every key name on every entity and prints floats at full precision.
      const bytes = new Uint8Array(encodeSnapshot(this.sim.getSnapshot(), keyframe));
      this.broadcast(MSG.SNAPSHOT, bytes);
      if (events.length) this.broadcast(MSG.EVENTS, events);
    } else if (events.length) {
      this.broadcast(MSG.EVENTS, events);
    }

    this.checkMatchOver();
  }

  private checkMatchOver() {
    const decided = this.sim.matchResult();

    // Measured in SIMULATION time, not wall-clock. The two can drift apart if
    // the server ever stalls, and the client shows a countdown derived from
    // simulation time — using anything else would let the displayed clock and
    // the actual deadline disagree.
    const timedUp = this.sim.state.time >= MATCH_LIMIT_MS;
    if (!decided && !timedUp) return;

    this.phase = 'ended';
    const standings = this.sim.standings();

    this.broadcast(MSG.ROUND_END, {
      winner: decided?.winner ?? standings.find((s: any) => s.alive)?.id ?? standings[0]?.id ?? null,
      reason: decided ? 'lastStanding' : 'timeLimit',
      standings,
    });

    console.log(`[room ${this.roomId}] match over (${decided ? 'last standing' : 'time limit'})`);

    // Give clients time to show the scoreboard, then close the room. Players
    // requeue into a fresh match rather than this one resetting.
    this.clock.setTimeout(() => this.disconnect(), 15000);
  }

  private broadcastRoster() {
    this.broadcast(MSG.ROSTER, { names: this.sim.names(), bots: this.sim.botIds() });
  }

  onDispose() {
    console.log(`[room ${this.roomId}] disposed after ${this.tickCount} ticks`);
  }
}
