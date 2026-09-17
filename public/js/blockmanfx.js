// BLOCKMAN'S PAINTED LAYER (docs/PLAN-BLOCKMAN.md §2). Everything that moves.
//
// WHY PAINTED AND NOT BUILT. Measured 2026-09-17 through the renderer's own scene builder: 1,008
// blocks (one per maze tile) redraw at 15 frames a second, and 64,512 (one per arcade pixel) at 1.4.
// A game screen changes every frame, so the scene builder is the wrong tool for the things that
// move: the maze is built once as blocks, and the dots, the pellets, BlockMan, the pursuers and the
// fruit are painted over it through the renderer's `overlay` hook, in the same projection and the
// same light. That is the split Scorched Yard uses for its shells and blasts, and it costs a few
// hundred small fills a frame instead of a thousand rebuilt cubes.
//
// The canvas rules this repository lives by hold here: no `clip`, no `globalAlpha`, no composite
// modes; rgba fills only, and soft edges through the renderer's nested-disc helper (`softStops`).

/** A cube painted by hand: the front face, the top and one side, from one colour. */
export function cube(ctx, P, U, { x, y, colour, size = 1, lift = 0 }) {
  const s = Math.max(0.15, size);
  const half = s / 2;
  const cx = x, cy = y - lift;
  const a = P(cx - half, cy - half), b = P(cx + half, cy - half), c = P(cx + half, cy + half), d = P(cx - half, cy + half);
  const top = shade(colour, 1.18), side = shade(colour, 0.62);
  // front
  ctx.fillStyle = colour;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill();
  // top and side, a couple of pixels each: enough to read as a block, cheap enough for 300 a frame
  const h = Math.max(1, U.y * s * 0.22), w = Math.max(1, U.x * s * 0.18);
  ctx.fillStyle = top;
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x - w, b.y - h); ctx.lineTo(a.x + w, a.y - h); ctx.closePath(); ctx.fill();
  ctx.fillStyle = side;
  ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(c.x - w, c.y - h); ctx.lineTo(b.x - w, b.y - h); ctx.closePath(); ctx.fill();
}

/** `#rrggbb` toward white (k > 1) or black (k < 1), as the renderer's own lamp does it. */
export function shade(hex, k) {
  const s = String(hex).replace('#', '');
  const n = parseInt(s.length === 3 ? [...s].map((c) => c + c).join('') : s, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (k >= 1
    ? Math.round(v + (255 - v) * Math.min(1, k - 1))
    : Math.round(v * k)));
  return `rgb(${ch[0]},${ch[1]},${ch[2]})`;
}

/**
 * The dots and the pellets. A dot is one small disc; a pellet is a bigger one that breathes, drawn
 * as three nested discs so its edge is soft without a gradient or a composite mode.
 */
export function paintDots(ctx, P, U, { dots, pellets, now = 0, colour = '#ffe9a8' }) {
  const r = Math.max(1, Math.min(U.x, U.y) * 0.14);
  ctx.fillStyle = colour;
  ctx.beginPath();
  for (const d of dots) {
    const p = P(d.x + 0.5, d.y + 0.5);
    ctx.moveTo(p.x + r, p.y);
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  }
  ctx.fill();                                   // one path for every dot: one fill a frame
  const beat = 0.75 + 0.25 * Math.sin(now / 260);
  for (const p0 of pellets) {
    const p = P(p0.x + 0.5, p0.y + 0.5);
    const R = Math.min(U.x, U.y) * 0.42 * beat;
    for (const [k, a] of [[1, 0.28], [0.7, 0.5], [0.45, 1]]) {
      ctx.fillStyle = `rgba(255,236,170,${a})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, R * k), 0, Math.PI * 2); ctx.fill();
    }
  }
}

/** BlockMan: a cube in his own colour, with a mouth that opens along the way he is going. */
export function paintBlockMan(ctx, P, U, man, { now = 0, colour = '#ffd23f' } = {}) {
  if (!man) return;
  cube(ctx, P, U, { x: man.x, y: man.y, colour, size: 1.5 });
  // the mouth: a wedge of the board's own dark, cut by drawing over the front face (no composite)
  const open = 0.22 + 0.22 * Math.abs(Math.sin(now / 90));
  const dir = man.dir ?? { x: 1, y: 0 };
  const c = P(man.x, man.y);
  const rx = U.x * 0.75, ry = U.y * 0.75;
  const base = Math.atan2(dir.y * ry, dir.x * rx);
  ctx.fillStyle = 'rgba(10,12,18,0.92)';
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(c.x + Math.cos(base - open) * rx, c.y + Math.sin(base - open) * ry);
  ctx.lineTo(c.x + Math.cos(base + open) * rx, c.y + Math.sin(base + open) * ry);
  ctx.closePath(); ctx.fill();
}

/**
 * The four pursuers. Each is a cube in its own colour with two eyes looking the way it moves;
 * frightened it is drawn dim and blue-white, and in its last second it flashes.
 */
export function paintPursuers(ctx, P, U, list, { now = 0 } = {}) {
  for (const g of list) {
    const frightened = g.state === 'frightened';
    const flashing = frightened && (g.frightenedLeftMs ?? 9999) < 2000 && Math.floor(now / 220) % 2 === 0;
    const colour = frightened ? (flashing ? '#f2f6ff' : '#5566cc') : g.colour;
    // EATEN IS EYES ONLY: it is crossing the maze to the pen and it is not a threat, so it has no
    // body at all -- the clearest way to say "that one is out of the game for a few seconds".
    if (g.state !== 'eaten') cube(ctx, P, U, { x: g.x, y: g.y, colour, size: 1.5 });
    const dir = g.dir ?? { x: 0, y: -1 };
    const eye = Math.min(U.x, U.y) * 0.16;
    for (const side of [-1, 1]) {
      const c = P(g.x + side * 0.28 + dir.x * 0.12, g.y - 0.12 + dir.y * 0.12);
      ctx.fillStyle = '#f4f7ff';
      ctx.beginPath(); ctx.arc(c.x, c.y, eye, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = frightened ? '#334' : '#1b2340';
      ctx.beginPath(); ctx.arc(c.x + dir.x * eye * 0.5, c.y + dir.y * eye * 0.5, eye * 0.55, 0, Math.PI * 2); ctx.fill();
    }
  }
}

/** The fruit: a small cube on its side, in its level's colour. */
export function paintFruit(ctx, P, U, fruit) {
  if (!fruit) return;
  cube(ctx, P, U, { x: fruit.x, y: fruit.y, colour: fruit.colour ?? '#ff5c7a', size: 1.1 });
}

/** A score that pops where a pursuer was eaten, rising and fading. */
export function paintPops(ctx, P, U, pops, now) {
  for (const p of pops) {
    const t = (now - p.t0) / 900;
    if (t < 0 || t > 1) continue;
    const c = P(p.x, p.y - t * 1.2);
    ctx.fillStyle = `rgba(160,230,255,${(1 - t).toFixed(3)})`;
    ctx.font = `${Math.max(8, Math.round(U.y * 0.9))}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(String(p.text), c.x, c.y);
  }
}

/**
 * CHEAT MODE: where each pursuer is headed (docs/PLAN-BLOCKMAN.md §6). A ring on its target tile in
 * its own colour and a thin line to it, which is the only way to SEE that the four rules differ --
 * Ambusher's ring runs ahead of BlockMan, Flanker's swings round the far side, Wanderer's flicks to
 * its corner the moment you get close. It doubled as the way the rules were debugged.
 */
export function paintTargets(ctx, P, U, pursuers) {
  for (const p of pursuers) {
    if (!p.target || p.state === 'pen' || p.state === 'frightened') continue;
    const a = P(p.x, p.y), b = P(p.target.x + 0.5, p.target.y + 0.5);
    ctx.strokeStyle = `rgba(${rgbOf(p.colour)},0.55)`;
    ctx.lineWidth = Math.max(1, U.x * 0.08);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = `rgba(${rgbOf(p.colour)},0.95)`;
    ctx.beginPath(); ctx.arc(b.x, b.y, Math.max(2, Math.min(U.x, U.y) * 0.42), 0, Math.PI * 2); ctx.stroke();
  }
}

/** `#rrggbb` as "r,g,b", for an rgba() fill (no globalAlpha on these canvases). */
export function rgbOf(hex) {
  const s = String(hex).replace('#', '');
  const n = parseInt(s.length === 3 ? [...s].map((c) => c + c).join('') : s, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
