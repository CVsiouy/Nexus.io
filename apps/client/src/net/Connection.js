import { Client } from 'colyseus.js';
import { MSG, PROTOCOL_VERSION, LATENCY_PROBE_MS, decodeSnapshot } from '@basewar/protocol';

/**
 * Connection — how the client talks to whatever is running the game.
 * ─────────────────────────────────────────────────────────────────
 *
 * Two implementations, one interface:
 *
 *   WorkerConnection     a Simulation in a background thread   (practice mode)
 *   WebSocketConnection  a Simulation on the real server       (online mode)
 *
 * Everything above this layer — renderer, HUD, input — uses only these methods
 * and genuinely cannot tell which one it has. That is the whole point: practice
 * and online run the same code through the same door, so a balance change or a
 * bug fix applies to both and they can never quietly diverge.
 *
 *   start(mode)      begin a match
 *   send(cmd)        ask the game to do something
 *   onWelcome(fn)    "you are p3, seat 2" — which base is yours
 *   onSnapshot(fn)   the state of the world
 *   onEvents(fn)     things that just happened (kills, level-ups)
 *   onRejected(fn)   an order was refused, and why
 *   onRoundEnd(fn)   the match is over
 *   onStatus(fn)     connection state, for the UI
 */

class BaseConnection {
  constructor() {
    this._handlers = {
      welcome: null, snapshot: null, events: null,
      rejected: null, roundEnd: null, roster: null, status: null,
    };
    /** Round-trip time in ms. Always 0 for a local worker. */
    this.ping = 0;
  }
  onWelcome(fn)  { this._handlers.welcome = fn; }
  onSnapshot(fn) { this._handlers.snapshot = fn; }
  onEvents(fn)   { this._handlers.events = fn; }
  onRejected(fn) { this._handlers.rejected = fn; }
  onRoundEnd(fn) { this._handlers.roundEnd = fn; }
  onRoster(fn)   { this._handlers.roster = fn; }
  onStatus(fn)   { this._handlers.status = fn; }

  _emit(name, ...args) { this._handlers[name]?.(...args); }
}

// ── Practice: the simulation runs in this browser ────────────────────────────

export class WorkerConnection extends BaseConnection {
  constructor() {
    super();
    // Vite understands this exact `new URL(...)` form and bundles the worker
    // as a separate file for production.
    this._worker = new Worker(new URL('../sim.worker.js', import.meta.url), { type: 'module' });
    this._seq = 0;

    this._worker.onmessage = (e) => {
      const msg = e.data;
      switch (msg.t) {
        case 'welcome':
          this._emit('welcome', msg);
          break;
        case 'snapshot':
          // performance.now() is shared between a page and its workers, so
          // `sentAt` is directly comparable with our own clock.
          this._emit('snapshot', msg.snapshot, msg.sentAt);
          if (msg.events?.length) this._emit('events', msg.events);
          break;
        case 'rejected':
          this._emit('rejected', msg.reason, msg.cmd);
          break;
      }
    };

    this._worker.onerror = (err) => {
      console.error('[sim worker] crashed:', err.message, err);
      this._emit('status', 'error', err.message);
    };
  }

  get isOnline() { return false; }

  /** @returns {Promise<boolean>} true once the match is running. */
  async start(mode) {
    this._emit('status', 'connected');
    this._worker.postMessage({ t: 'start', mode });
    return true;   // a local worker cannot fail to "connect"
  }

  send(cmd) { this._worker.postMessage({ t: 'cmd', cmd, seq: ++this._seq }); }

  /**
   * Pause. Practice mode only — you cannot pause a match seven other people
   * are also playing, so WebSocketConnection deliberately ignores this.
   */
  setPaused(value) { this._worker.postMessage({ t: 'pause', value }); }

  close() {
    this._worker.postMessage({ t: 'stop' });
    this._worker.terminate();
  }
}

// ── Online: the simulation runs on the server ────────────────────────────────

export class WebSocketConnection extends BaseConnection {
  /**
   * @param {string} url   e.g. "ws://localhost:2567"
   * @param {string} name  display name shown to other players
   */
  constructor(url, name) {
    super();
    this._client = new Client(url);
    this._name = name || 'Player';
    this._room = null;
    /** Last decoded snapshot — supplies the fields only keyframes carry. */
    this._lastSnapshot = null;
    /** Running total, so the client can show its own bandwidth use. */
    this.bytesReceived = 0;
  }

  get isOnline() { return true; }

  /** @returns {Promise<boolean>} true if we got into a match. */
  async start(mode) {
    this._emit('status', 'connecting');
    try {
      // joinOrCreate finds a match with a free seat, or starts a new one — so
      // a player never sits in a lobby waiting for strangers to show up. The
      // seats they'd be waiting for are already filled by bots.
      this._room = await this._client.joinOrCreate('arena', {
        mode,
        name: this._name,
        protocol: PROTOCOL_VERSION,
      });
    } catch (err) {
      this._emit('status', 'error', err?.message ?? String(err));
      return false;
    }

    this._emit('status', 'connected');

    this._room.onMessage(MSG.WELCOME,   (m) => this._emit('welcome', m));

    // Snapshots arrive as raw bytes. Decoding them here means WorldView and
    // every renderer still see exactly the object shape they always did — the
    // switch from JSON to binary stops at this line.
    this._room.onMessage(MSG.SNAPSHOT, (bytes) => {
      try {
        const snap = decodeSnapshot(bytes, this._lastSnapshot);
        // Only a keyframe is a complete picture, so only keyframes may become
        // the baseline that later frames carry their static fields forward from.
        if (snap.keyframe) this._lastSnapshot = snap;
        else if (this._lastSnapshot) this._lastSnapshot = snap;
        this.bytesReceived += bytes?.byteLength ?? bytes?.length ?? 0;
        this._emit('snapshot', snap, performance.now());
      } catch (err) {
        console.error('[basewar] could not decode a snapshot:', err);
        this._emit('status', 'error', err?.message ?? 'bad snapshot');
      }
    });
    this._room.onMessage(MSG.EVENTS,    (e) => this._emit('events', e));
    this._room.onMessage(MSG.REJECTED,  (r) => this._emit('rejected', r.reason, { t: r.cmd }));
    this._room.onMessage(MSG.ROUND_END, (r) => this._emit('roundEnd', r));
    this._room.onMessage(MSG.ROSTER,    (r) => this._emit('roster', r));

    this._room.onLeave((code) => {
      // 1000 is a normal close; anything else means we dropped unexpectedly.
      this._emit('status', code === 1000 ? 'left' : 'disconnected', `code ${code}`);
    });

    this._room.onError((code, message) => {
      this._emit('status', 'error', `${code}: ${message}`);
    });

    // Round-trip time. We send our own clock reading and the server bounces it
    // back untouched, so we only ever compare our clock with itself — no clock
    // synchronisation needed, and no assumption that the two machines agree
    // about what time it is.
    this._room.onMessage(MSG.LATENCY, (sentAt) => {
      const rtt = performance.now() - sentAt;
      // Smooth it, or the display flickers on every jittery packet.
      this.ping = this.ping ? this.ping * 0.7 + rtt * 0.3 : rtt;
    });
    this._probe = setInterval(() => {
      this._room?.send(MSG.LATENCY, performance.now());
    }, LATENCY_PROBE_MS);
    this._room.send(MSG.LATENCY, performance.now());

    return true;
  }

  send(cmd) { this._room?.send(MSG.COMMAND, cmd); }

  /** No-op online: you cannot pause a match other people are playing. */
  setPaused() {}

  close() {
    if (this._probe) { clearInterval(this._probe); this._probe = null; }
    this._room?.leave();
    this._room = null;
  }
}
