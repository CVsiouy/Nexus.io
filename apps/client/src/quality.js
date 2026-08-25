/**
 * Graphics quality preference.
 *
 * Its own module rather than living in main.js, because Game.js needs it at
 * construction time and main.js already imports Game — putting it there would
 * be a circular import.
 *
 * Phones commonly report devicePixelRatio 3, so the old fixed
 * `min(devicePixelRatio, 2)` plus antialias meant rendering roughly twice the
 * pixels WITH multisampling on a mobile GPU. That is a large slice of the frame
 * budget spent on edge smoothing, and a stuttering RTS is harder to play
 * accurately than a slightly soft one.
 */

export const QUALITY_KEY = 'basewar.quality';

/** Stored preference, else reduced on touch devices and full elsewhere. */
export function readQuality() {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    if (v === 'full' || v === 'reduced') return v;
  } catch { /* private browsing — fall through to the default */ }
  return window.matchMedia?.('(pointer: coarse)').matches ? 'reduced' : 'full';
}

export function writeQuality(v) {
  try { localStorage.setItem(QUALITY_KEY, v); } catch { /* ignore */ }
}

/**
 * Renderer options for a level.
 *
 * `antialias` is a WebGL CONTEXT-CREATION flag: it cannot be changed on a live
 * renderer without tearing down the context and every texture with it. So it
 * is honoured at construction only, and a mid-session change takes effect on
 * the next load. The menu says so rather than silently doing nothing.
 */
export function qualityOpts(q) {
  const dpr = window.devicePixelRatio || 1;
  return q === 'reduced'
    ? { antialias: false, resolution: Math.min(dpr, 1.5) }
    : { antialias: true,  resolution: Math.min(dpr, 2) };
}
