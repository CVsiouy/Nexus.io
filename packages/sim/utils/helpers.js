// NOTE: the old module-global `uid()` lived here. Entity IDs are now issued
// per-simulation by IdAllocator (see ../IdAllocator.js for why).

export const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export const dist  = (a, b) => Math.sqrt(dist2(a, b));

export const lerp  = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const randRange = (lo, hi) => lo + Math.random() * (hi - lo);
export const randInt   = (lo, hi) => Math.floor(randRange(lo, hi + 1));
export const randPick  = (arr) => arr[Math.floor(Math.random() * arr.length)];

export const normalize = (v) => {
  const len = Math.sqrt(v.x * v.x + v.y * v.y);
  return len < 1e-5 ? { x: 0, y: 0 } : { x: v.x / len, y: v.y / len };
};

export const hexToCSS = (hex) => `#${hex.toString(16).padStart(6, '0')}`;

/** Point-to-segment distance (squared) */
export function pointSegDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return (px - x1) ** 2 + (py - y1) ** 2;
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
  return (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
}

/** Weighted random pick from object { key: weight } */
export function weightedRandom(weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [k, w] of Object.entries(weights)) {
    r -= w;
    if (r <= 0) return k;
  }
  return Object.keys(weights)[0];
}
