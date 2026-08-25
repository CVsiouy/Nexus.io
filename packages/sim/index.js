/**
 * @basewar/sim — the rules engine.
 *
 * Pure game logic. No PixiJS, no DOM, no browser APIs of any kind, so the exact
 * same code runs in a browser Web Worker (single-player practice) and on the
 * Node game server (online play).
 *
 * The client imports everything from this one file rather than reaching into
 * individual modules, which keeps the public surface of the package obvious and
 * makes it hard to accidentally depend on an internal detail.
 */

// The doorway — almost everything you need is here.
export { Simulation, TICK_MS } from './Simulation.js';

// Tuning numbers (SOLDIER_DEFS, WORLD_SIZE, colours, level table, …).
// The renderer and HUD read these directly; they are pure data.
export * from './constants.js';

// Wall geometry — the renderer needs cellPositions() to draw wall rings.
export { cellPositions, cellPos, layerComplete, outerBlockingLayer, canAddWall } from './walls.js';

// Economy helpers the HUD displays (gold per second, next upgrade cost).
export { goldRate, mineUpgradeCost } from './systems/ProgressionSystem.js';

// Small maths utilities shared with the client (hit-testing, colour conversion).
export { dist, dist2, clamp, lerp, hexToCSS } from './utils/helpers.js';

// Lower-level pieces — exported for tests and for the Phase 1 server.
export { GameState } from './GameState.js';
export { IdAllocator } from './IdAllocator.js';
export { buildWorld } from './World.js';
