/**
 * Poisson-disc sampling — generates well-distributed random points
 * with a guaranteed minimum separation distance.
 * Returns: Array of { x, y }
 */
export function poissonDisc(width, height, minDist, maxAttempts = 30) {
  const cell   = minDist / Math.SQRT2;
  const cols   = Math.ceil(width  / cell);
  const rows   = Math.ceil(height / cell);
  const grid   = new Array(cols * rows).fill(null);
  const pts    = [];
  const active = [];

  const idx = (x, y) => Math.floor(y / cell) * cols + Math.floor(x / cell);

  const add = (x, y) => {
    const p = { x, y };
    pts.push(p);
    active.push(p);
    grid[idx(x, y)] = p;
  };

  // Start near centre
  add(width / 2 + (Math.random() - 0.5) * 400,
      height / 2 + (Math.random() - 0.5) * 400);

  while (active.length > 0) {
    const ri  = Math.floor(Math.random() * active.length);
    const src = active[ri];
    let placed = false;

    for (let a = 0; a < maxAttempts; a++) {
      const angle = Math.random() * Math.PI * 2;
      const r     = minDist + Math.random() * minDist;
      const nx    = src.x + Math.cos(angle) * r;
      const ny    = src.y + Math.sin(angle) * r;
      if (nx < 5 || nx > width - 5 || ny < 5 || ny > height - 5) continue;

      const gc = Math.floor(nx / cell);
      const gr = Math.floor(ny / cell);
      let ok = true;

      for (let dr = -2; dr <= 2 && ok; dr++) {
        for (let dc = -2; dc <= 2 && ok; dc++) {
          const nc = gc + dc, nr = gr + dr;
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
          const nb = grid[nr * cols + nc];
          if (nb) {
            const dx = nb.x - nx, dy = nb.y - ny;
            if (dx * dx + dy * dy < minDist * minDist) ok = false;
          }
        }
      }

      if (ok) { add(nx, ny); placed = true; break; }
    }

    if (!placed) active.splice(ri, 1);
  }

  return pts;
}
