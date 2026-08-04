import { Simulation, TICK_MS } from '@nexus/sim';

/**
 * The single-player game server — running inside the player's own browser.
 * ────────────────────────────────────────────────────────────────────────
 *
 * A Web Worker is a background thread. Code here runs alongside the page
 * instead of inside it, so a heavy simulation tick can never stutter the
 * rendering, and it CANNOT touch the DOM — which is exactly the discipline we
 * want, because this same Simulation has to run on a Node server where there
 * is no DOM at all.
 *
 * The messages below are deliberately the same shape the real server will use
 * in Phase 1: the page sends commands, the worker sends back snapshots. Swapping
 * this worker for a WebSocket then changes nothing above the Connection layer.
 */

let sim = null;
let paused = false;
let timer = null;

/** Stand-in for a network session id — there is only ever one local player. */
const LOCAL_SESSION = 'local';

// Fixed-timestep bookkeeping.
let accumulator = 0;
let lastRealMs = 0;

/**
 * Never try to catch up more than this much real time at once. If the browser
 * tab is backgrounded for a minute, we do NOT want to run 1,200 ticks the
 * instant it wakes — that would freeze the thread and fast-forward the match.
 */
const MAX_CATCHUP_MS = 250;

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg?.t) {
    case 'start':  start(msg.mode); break;
    case 'cmd':    handleCommand(msg); break;
    case 'pause':  paused = !!msg.value; break;
    case 'stop':   stop(); break;
  }
};

function start(mode) {
  stop();
  sim = new Simulation({ mode });

  // Claim a seat exactly as an online player would. Practice mode is now the
  // same flow as a real match, just with a very short wire — which is the whole
  // point: the two can't drift apart if they run the same code path.
  const me = sim.claimSeat(LOCAL_SESSION, 'You');

  self.postMessage({
    t: 'welcome',
    youAre: me.id,
    seat: me.seat,
    mode,
    names: sim.names(),
  });

  accumulator = 0;
  lastRealMs = performance.now();

  // Send an immediate first snapshot so the client has something to draw
  // before the first tick has even run.
  post();

  timer = setInterval(loop, TICK_MS);
}

function stop() {
  if (timer !== null) { clearInterval(timer); timer = null; }
  sim = null;
}

function handleCommand(msg) {
  if (!sim) return;
  const me = sim.playerBySession(LOCAL_SESSION);
  if (!me) return;
  const result = sim.applyCommand(me.id, msg.cmd);
  // Tell the page whether the order was accepted. Single-player never really
  // needs this, but the online client does (to explain "not enough gold"),
  // so we exercise the same path here.
  if (!result.ok) {
    self.postMessage({ t: 'rejected', seq: msg.seq, cmd: msg.cmd, reason: result.reason });
  }
}

function loop() {
  if (!sim) return;

  const now = performance.now();
  let elapsed = now - lastRealMs;
  lastRealMs = now;
  if (elapsed > MAX_CATCHUP_MS) elapsed = MAX_CATCHUP_MS;

  if (paused) { accumulator = 0; return; }

  accumulator += elapsed;

  // Advance in exact TICK_MS increments — never by "however long the last frame
  // took". That is what makes the simulation independent of the machine it
  // runs on, which matters the moment more than one person shares a match.
  let steps = 0;
  while (accumulator >= TICK_MS) {
    sim.step(TICK_MS);
    accumulator -= TICK_MS;
    if (++steps >= 8) { accumulator = 0; break; }   // hard stall guard
  }

  if (steps > 0) post();
}

function post() {
  self.postMessage({
    t: 'snapshot',
    snapshot: sim.getSnapshot(),
    events: sim.drainEvents(),
    sentAt: performance.now(),
  });
}
