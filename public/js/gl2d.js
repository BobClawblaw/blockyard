// THE SECOND RENDERER (2026-09-21; operator: "adding a second rendering option to blockyard for
// WebGL rendering, and port all existing effects over to the new system. Supporting either WebGL
// or Software rendering").
//
// Every board, sky and effect in this project draws through ONE seam: the 2D context that
// render3d hands to paintFrame (details3d.js). So the port is not thirty-five effects rewritten
// as thirty-five shaders -- which would be two renderers to keep in step for ever -- it is that
// seam implemented twice. This file is the second implementation: the subset of the Canvas 2D
// API the viewer uses (counted 2026-09-21 across details3d, agents, livingsky, galform,
// galflight and the games' overlay hooks), on WebGL2. An effect written once runs on either
// renderer, and the settings switch (appearance.renderer) picks which.
//
// What is here, and how:
//   paths      moveTo / lineTo / arc / ellipse / rect / quadraticCurveTo / bezierCurveTo /
//              closePath, flattened in DEVICE space as the 2D context does (the transform is
//              applied as the path is built; the pen's width is applied as it is stroked)
//   fills      a convex outline is a triangle fan straight into the batch; anything else --
//              concave, holed, or several translucent outlines that may overlap -- goes through
//              the stencil buffer (winding counted per sample, then one covering quad), which
//              is exact for any path under either fill rule
//   strokes    quads, joins and caps built in user space. An opaque stroke batches directly; a
//              translucent one is stencilled first, because a 2D stroke paints every pixel
//              ONCE however its segments overlap and a see-through join must not double up
//   gradients  evaluated per pixel in the fragment shader. A linear gradient, or a radial one from
//              its own centre (every one in this project), is a row of a ramp ATLAS texture and
//              batches with everything else; the general two-circle form has its own draw
//   images     drawImage of a canvas (the cached gas, dome and plume layers) as a texture
//   text       rasterised once per (font, colour, string) on a scratch 2D canvas, then a texture
//
// Antialiasing is the framebuffer's multisampling; the stencil is per sample, so stencilled
// edges are as smooth as direct ones. Blending is premultiplied source-over and nothing else:
// the viewer's rules (no clip, no globalAlpha, no composite modes) are why this subset is small
// enough to be exact.
//
// The geometry is pure and exported, so it is tested under node with no GL at all; the context
// itself is tested against a recording stub of WebGL2 (test/gl2d.test.js), and the pixels against
// the software renderer in a real browser (scripts/gl-compare.mjs).

const TAU = Math.PI * 2;

// ------------------------------------------------------------------- colours
const NAMED = {
  transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1], red: [255, 0, 0, 1],
  green: [0, 128, 0, 1], blue: [0, 0, 255, 1], yellow: [255, 255, 0, 1], cyan: [0, 255, 255, 1],
  magenta: [255, 0, 255, 1], orange: [255, 165, 0, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1],
  silver: [192, 192, 192, 1], gold: [255, 215, 0, 1], lime: [0, 255, 0, 1],
};
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
/** A CSS colour as [r, g, b, a] (0-255, 0-1, NOT premultiplied), or null when it is not one. Pure. */
export function parseColour(str) {
  if (typeof str !== 'string') return null;
  // THE HOT FORM FIRST: effects mint `rgba(r,g,b,a)` per particle per frame, thousands of strings no
  // cache can hold on to, and a regex plus a split per string was 4% of a supernova's frame. Plain
  // digits, commas and dots are read by character code; anything else falls through to the full parser.
  if (str.charCodeAt(0) === 114 && str.charCodeAt(3) === 97 && str.charCodeAt(4) === 40) {
    const out = [0, 0, 0, 1]; let k = 0, v = 0, scale = 0, ok = true, any = false;
    const n = str.length;
    for (let i = 5; i < n; i++) {
      const ch = str.charCodeAt(i);
      if (ch >= 48 && ch <= 57) { any = true; if (scale) { v += (ch - 48) * scale; scale /= 10; } else v = v * 10 + (ch - 48); }
      else if (ch === 46 && !scale) scale = 0.1;
      else if ((ch === 44 || ch === 41) && any && k < 4) { out[k++] = v; v = 0; scale = 0; any = false; if (ch === 41) { ok = i === n - 1 && k === 4; break; } }
      else { ok = false; break; }
    }
    if (ok && k === 4) { if (out[0] > 255) out[0] = 255; if (out[1] > 255) out[1] = 255; if (out[2] > 255) out[2] = 255; if (out[3] > 1) out[3] = 1; return out; }
  }
  const s = str.trim().toLowerCase();
  if (s[0] === '#') {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const v = [...h].map((ch) => parseInt(ch + ch, 16));
      return [v[0], v[1], v[2], h.length === 4 ? v[3] / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16));
      return [v[0], v[1], v[2], h.length === 8 ? v[3] / 255 : 1];
    }
    return null;
  }
  const m = s.match(/^(rgba?|hsla?)\(([^)]*)\)$/);
  if (m) {
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p, scale) => (p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p));
    const a = parts.length > 3 ? num(parts[3], 1) : 1;
    let rgb;
    if (m[1][0] === 'r') rgb = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255)];
    else rgb = hslToRgb(parseFloat(parts[0]), num(parts[1], 1), num(parts[2], 1));
    if (rgb.some((v) => !Number.isFinite(v)) || !Number.isFinite(a)) return null;
    return [Math.max(0, Math.min(255, rgb[0])), Math.max(0, Math.min(255, rgb[1])), Math.max(0, Math.min(255, rgb[2])), Math.max(0, Math.min(1, a))];
  }
  return NAMED[s] ? [...NAMED[s]] : null;
}
/** Premultiplied and packed little-endian for the colour attribute: r | g<<8 | b<<16 | a<<24. Pure. */
export function packColour(c, alphaMul = 1) {
  const a = Math.max(0, Math.min(1, c[3] * alphaMul));
  return ((Math.round(c[0] * a) & 255) | ((Math.round(c[1] * a) & 255) << 8) | ((Math.round(c[2] * a) & 255) << 16) | ((Math.round(a * 255) & 255) << 24)) >>> 0;
}

// ------------------------------------------------------------------- geometry (pure)
/** How many chords a circle of `rDev` device pixels needs to stay within a fifth of a pixel. Pure. */
export function arcSegments(rDev, sweep = TAU) {
  const r = Math.abs(rDev);
  if (!(r > 0.6)) return Math.max(3, Math.ceil(4 * Math.abs(sweep) / TAU));
  const step = 2 * Math.acos(Math.max(-1, 1 - 0.2 / r));
  return Math.max(2, Math.min(256, Math.ceil(Math.abs(sweep) / step)));
}
/** The sweep a 2D context's arc() makes from a0 to a1. Pure. */
export function arcSweep(a0, a1, ccw) {
  let d = a1 - a0;
  if (!ccw) { if (d >= TAU) return TAU; d %= TAU; if (d < 0) d += TAU; return d; }
  if (d <= -TAU) return -TAU;
  d %= TAU; if (d > 0) d -= TAU;
  return d;
}
/** Is this flat [x0,y0,x1,y1,...] outline convex (either winding)? Degenerate turns are allowed. Pure. */
export function isConvex(p) {
  const n = p.length >> 1;
  if (n < 3) return false;
  // (no arrays: this runs for every face of a moving board.) The edges that have a direction are
  // walked in order, each against the last one that had one -- a closed arc ends on its own first
  // point, and that edge of no length is stepped over. Start from the LAST such edge.
  let px = 0, py = 0, edges = 0;
  for (let i = n - 1; i >= 0 && !edges; i--) {
    const j = (i + 1) % n, dx = p[2 * j] - p[2 * i], dy = p[2 * j + 1] - p[2 * i + 1];
    if (dx * dx + dy * dy > 1e-18) { px = dx; py = dy; edges = 1; }
  }
  if (!edges) return false;
  let sign = 0, turn = 0; edges = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, dx = p[2 * j] - p[2 * i], dy = p[2 * j + 1] - p[2 * i + 1];
    if (dx * dx + dy * dy <= 1e-18) continue;
    edges++;
    const cr = px * dy - py * dx;
    if (Math.abs(cr) > 1e-12) {
      const sg = cr > 0 ? 1 : -1;
      if (sign && sg !== sign) return false;
      sign = sg;
    }
    turn += Math.atan2(cr, px * dx + py * dy);
    px = dx; py = dy;
  }
  if (edges < 3) return false;
  // a star polygon turns the same way at every corner too; a convex outline goes round ONCE
  return Math.abs(Math.abs(turn) - TAU) < 1e-3;
}

/**
 * A SIMPLE concave outline as triangles, by ear clipping: indices into the points, three a
 * triangle, or null when it cannot be trusted -- too long to be worth it, or the ears' areas do
 * not add up to the outline's own (it crosses itself, and only the stencil gets the winding
 * right). The black hole's disk is forty ring-shaped strips a frame; each was a stencil pass. Pure.
 */
export function earClip(p, maxPoints = 400) {
  // A RIBBON FIRST: out along one edge and back along the other, point for point (the black hole's
  // strips, a trail, an arch). A ring that closes on itself has a zero-width seam no ear clipper
  // accepts, but as quads between the two edges it is exact -- and this is one pass, not n squared.
  const rn = p.length >> 1;
  if (rn >= 4 && rn % 2 === 0 && rn <= 4096) {
    let sh = 0;
    for (let i = 0; i < rn; i++) { const j = (i + 1) % rn; sh += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]; }
    const want = Math.abs(sh), sg = sh > 0 ? 1 : -1;
    if (want > 1e-9) {
      const out = []; let got = 0, ok = true;
      for (let i = 0; i + 1 < rn / 2 && ok; i++) {
        const a = i, b = i + 1, c = rn - 2 - i, d = rn - 1 - i;
        for (const [u, v, w] of [[a, b, c], [a, c, d]]) {
          const cr = ((p[2 * v] - p[2 * u]) * (p[2 * w + 1] - p[2 * u + 1]) - (p[2 * v + 1] - p[2 * u + 1]) * (p[2 * w] - p[2 * u])) * sg;
          if (cr < -1e-9 * want) { ok = false; break; }   // a quad folded back on itself: not a ribbon
          if (cr > 0) { out.push(u, v, w); got += cr; }
        }
      }
      if (ok && Math.abs(got - want) <= 1e-6 * want) return out;
    }
  }
  // the points that matter: no repeats (a closed arc ends where it began)
  const idx = [];
  const n0 = p.length >> 1;
  for (let i = 0; i < n0; i++) {
    const j = idx.length ? idx[idx.length - 1] : -1;
    if (j >= 0 && Math.abs(p[2 * i] - p[2 * j]) < 1e-9 && Math.abs(p[2 * i + 1] - p[2 * j + 1]) < 1e-9) continue;
    idx.push(i);
  }
  if (idx.length > 1 && Math.abs(p[2 * idx[0]] - p[2 * idx[idx.length - 1]]) < 1e-9 && Math.abs(p[2 * idx[0] + 1] - p[2 * idx[idx.length - 1] + 1]) < 1e-9) idx.pop();
  let n = idx.length;
  if (n < 3 || n > maxPoints) return null;
  let area2 = 0;
  for (let i = 0; i < n; i++) { const a = idx[i], b = idx[(i + 1) % n]; area2 += p[2 * a] * p[2 * b + 1] - p[2 * b] * p[2 * a + 1]; }
  if (Math.abs(area2) < 1e-9) return null;
  const sign = area2 > 0 ? 1 : -1;
  const out = []; let got2 = 0, guard = 0;
  const cross = (a, b, c) => (p[2 * b] - p[2 * a]) * (p[2 * c + 1] - p[2 * a + 1]) - (p[2 * b + 1] - p[2 * a + 1]) * (p[2 * c] - p[2 * a]);
  let i = 0;
  while (n > 3) {
    if (guard++ > n) return null;                          // a whole turn with no ear: not a simple outline
    const ia = idx[(i + n - 1) % n], ib = idx[i % n], ic = idx[(i + 1) % n];
    const cr = cross(ia, ib, ic) * sign;
    let ear = cr > 1e-12;
    if (ear) {
      for (let k = 0; k < n && ear; k++) {
        const iv = idx[k];
        if (iv === ia || iv === ib || iv === ic) continue;
        // strictly inside or on an edge of the candidate: it is no ear
        if (cross(ia, ib, iv) * sign >= 0 && cross(ib, ic, iv) * sign >= 0 && cross(ic, ia, iv) * sign >= 0) ear = false;
      }
    }
    if (ear || Math.abs(cr) <= 1e-12) {                    // (a straight-through point is simply dropped)
      if (ear) { out.push(ia, ib, ic); got2 += cr; }
      idx.splice(i % n, 1); n--; guard = 0;
      if (i >= n) i = 0;
    } else i = (i + 1) % n;
  }
  const last = cross(idx[0], idx[1], idx[2]) * sign;
  if (last < -1e-9) return null;
  if (last > 0) { out.push(idx[0], idx[1], idx[2]); got2 += last; }
  return Math.abs(got2 - Math.abs(area2)) <= 1e-6 * Math.abs(area2) + 1e-9 ? out : null;
}

/** Is this outline a speck: a few device pixels across at most? Pure. */
export function isSpeck(p, max = 6) {
  let x0 = p[0], x1 = p[0], y0 = p[1], y1 = p[1];
  for (let i = 2; i < p.length; i += 2) {
    if (p[i] < x0) x0 = p[i]; else if (p[i] > x1) x1 = p[i];
    if (p[i + 1] < y0) y0 = p[i + 1]; else if (p[i + 1] > y1) y1 = p[i + 1];
    if (x1 - x0 > max || y1 - y0 > max) return false;
  }
  return true;
}

/**
 * A stroked polyline as triangles, in the space the points are in. `tri(x0,y0,x1,y1,x2,y2)` takes
 * each one. The triangles may overlap (a join over its segments); whoever paints a see-through
 * stroke must therefore paint through a stencil. Returns true when what was emitted cannot overlap
 * itself (one segment with its caps, or one dot). Pure.
 */
export function strokeGeometry(pts, closed, width, cap, join, miterLimit, tri, scale = 1) {
  const hw = width / 2;
  if (!(hw > 0)) return true;
  // drop repeated points: a zero-length segment has no direction to offset along
  const q = [];
  for (let i = 0; i < pts.length; i += 2) {
    const n = q.length;
    if (n && Math.abs(q[n - 2] - pts[i]) < 1e-9 && Math.abs(q[n - 1] - pts[i + 1]) < 1e-9) continue;
    q.push(pts[i], pts[i + 1]);
  }
  if (closed && q.length > 2 && Math.abs(q[0] - q[q.length - 2]) < 1e-9 && Math.abs(q[1] - q[q.length - 1]) < 1e-9) q.length -= 2;
  const n = q.length >> 1;
  const disc = (cx, cy, from = 0, sweep = TAU) => {
    const k = arcSegments(hw * scale, sweep);
    let ax = cx + Math.cos(from) * hw, ay = cy + Math.sin(from) * hw;
    for (let i = 1; i <= k; i++) {
      const t = from + (sweep * i) / k, bx = cx + Math.cos(t) * hw, by = cy + Math.sin(t) * hw;
      tri(cx, cy, ax, ay, bx, by); ax = bx; ay = by;
    }
  };
  if (n === 0) return true;
  if (n === 1) {
    // the pulsar's gas, the stars of a storm: "a dot being a zero-length segment with a round cap"
    if (cap === 'round') {
      if (hw * scale < 1.3) { const x = q[0], y = q[1]; tri(x - hw, y - hw, x + hw, y - hw, x + hw, y + hw); tri(x - hw, y - hw, x + hw, y + hw, x - hw, y + hw); }
      else disc(q[0], q[1]);
    } else if (cap === 'square') { const x = q[0], y = q[1]; tri(x - hw, y - hw, x + hw, y - hw, x + hw, y + hw); tri(x - hw, y - hw, x + hw, y + hw, x - hw, y + hw); }
    return true;
  }
  const segs = closed ? n : n - 1;
  const dirs = new Float64Array(segs * 2);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const dx = q[2 * j] - q[2 * i], dy = q[2 * j + 1] - q[2 * i + 1], l = Math.hypot(dx, dy) || 1;
    dirs[2 * i] = dx / l; dirs[2 * i + 1] = dy / l;
    const nx = -dirs[2 * i + 1] * hw, ny = dirs[2 * i] * hw;
    const ax = q[2 * i], ay = q[2 * i + 1], bx = q[2 * j], by = q[2 * j + 1];
    tri(ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny);
    tri(ax + nx, ay + ny, bx - nx, by - ny, ax - nx, ay - ny);
  }
  const joinAt = (v, s0, s1) => {
    const x = q[2 * v], y = q[2 * v + 1];
    if (join === 'round') {
      if (hw * scale < 0.75) return;                    // under a pixel and a half a join is nothing
      // ONLY THE WEDGE THE TURN OPENS, on its outer side -- not a whole disc. A flattened curve (the
      // price line under six glow strokes) turns a degree or two at each of its hundreds of points:
      // a whole disc there is thirty triangles buried inside the stroke, a wedge is one. Profiled
      // 2026-09-21: the discs were the largest single item of the renderer's own JS in a frame.
      const e0x = dirs[2 * s0], e0y = dirs[2 * s0 + 1], e1x = dirs[2 * s1], e1y = dirs[2 * s1 + 1];
      const cr = e0x * e1y - e0y * e1x, dt = e0x * e1x + e0y * e1y;
      if (Math.abs(cr) < 1e-9) { if (dt < 0) disc(x, y); return; }   // straight on: nothing; doubled back: the whole cap
      if (dt > 0 && Math.abs(cr) * hw * scale < 0.25) return;        // a gap under a quarter of a pixel: nothing to fill
      const side = cr > 0 ? -1 : 1;
      const from = Math.atan2(e0x * side, -e0y * side);
      disc(x, y, from, Math.atan2(cr, dt));              // the normal turns by exactly what the path turns
      return;
    }
    const d0x = dirs[2 * s0], d0y = dirs[2 * s0 + 1], d1x = dirs[2 * s1], d1y = dirs[2 * s1 + 1];
    const cross = d0x * d1y - d0y * d1x;
    if (Math.abs(cross) < 1e-9) return;
    const o = cross > 0 ? -1 : 1;                       // the outer side of the turn
    const ax = x - d0y * hw * o, ay = y + d0x * hw * o, bx = x - d1y * hw * o, by = y + d1x * hw * o;
    tri(x, y, ax, ay, bx, by);                          // the bevel
    if (join === 'bevel') return;
    const ux = -d0y * o - d1y * o, uy = d0x * o + d1x * o, u2 = ux * ux + uy * uy;
    if (u2 < 1e-12) return;
    if (2 / Math.sqrt(u2) > (miterLimit || 10)) return;   // 1 / cos(half the turn), past the limit: bevel
    const k = (2 * hw) / u2;
    tri(ax, ay, x + ux * k, y + uy * k, bx, by);
  };
  for (let v = 1; v < n - 1; v++) joinAt(v, v - 1, v);
  if (closed) { joinAt(0, segs - 1, 0); if (n > 2) joinAt(n - 1, n - 2, n - 1); }
  else if (cap !== 'butt') {
    const ends = [[0, 0, -1], [n - 1, segs - 1, 1]];
    for (const [v, s, out] of ends) {
      const x = q[2 * v], y = q[2 * v + 1], dx = dirs[2 * s] * out, dy = dirs[2 * s + 1] * out;
      if (cap === 'round') disc(x, y, Math.atan2(dy, dx) - Math.PI / 2, Math.PI);   // the half beyond the end only
      else {
        const nx = -dy * hw, ny = dx * hw, ex = dx * hw, ey = dy * hw;
        tri(x + nx, y + ny, x + nx + ex, y + ny + ey, x - nx + ex, y - ny + ey);
        tri(x + nx, y + ny, x - nx + ex, y - ny + ey, x - nx, y - ny);
      }
    }
  }
  return !closed && n === 2;
}

/**
 * A THIN stroke as one strip: each vertex offset along its mitre (held to twice the half-width), a
 * quad between each pair. Unlike strokeGeometry nothing here overlaps, so a see-through seam round
 * a cube's face -- thousands a frame -- can go straight into the batch instead of through the
 * stencil. Under about three device pixels a mitre and a round join are the same pixels. Pure.
 */
export function stripGeometry(pts, closed, width, cap, tri) {
  const hw = width / 2;
  if (!(hw > 0)) return;
  // (typed scratch, grown as needed, and no array per corner: the black hole's disk is a few hundred
  // eleven-point streaks a frame through here, and the little arrays were 9% of that frame)
  const need = pts.length >> 1;
  if (STRIP.x.length < need) { const n2 = need * 2; STRIP.x = new Float64Array(n2); STRIP.y = new Float64Array(n2); STRIP.ox = new Float64Array(n2); STRIP.oy = new Float64Array(n2); }
  const X = STRIP.x, Y = STRIP.y, ox = STRIP.ox, oy = STRIP.oy;
  let n = 0;
  for (let i = 0; i < pts.length; i += 2) {
    if (n && Math.abs(X[n - 1] - pts[i]) < 1e-9 && Math.abs(Y[n - 1] - pts[i + 1]) < 1e-9) continue;
    X[n] = pts[i]; Y[n] = pts[i + 1]; n++;
  }
  if (closed && n > 1 && Math.abs(X[0] - X[n - 1]) < 1e-9 && Math.abs(Y[0] - Y[n - 1]) < 1e-9) n--;
  if (n < 2) return;
  for (let v = 0; v < n; v++) {
    const has0 = closed || v > 0, has1 = closed || v < n - 1;
    let d0x = 0, d0y = 0, d1x = 0, d1y = 0;
    if (has0) { const a = (v + n - 1) % n; d0x = X[v] - X[a]; d0y = Y[v] - Y[a]; const l = Math.hypot(d0x, d0y) || 1; d0x /= l; d0y /= l; }
    if (has1) { const b = (v + 1) % n; d1x = X[b] - X[v]; d1y = Y[b] - Y[v]; const l = Math.hypot(d1x, d1y) || 1; d1x /= l; d1y /= l; }
    if (!has0) { d0x = d1x; d0y = d1y; } else if (!has1) { d1x = d0x; d1y = d0y; }
    let mx = -d0y - d1y, my = d0x + d1x;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { mx = -d0y; my = d0x; } else { mx /= ml; my /= ml; }
    const cos = Math.max(0.5, Math.abs(mx * -d0y + my * d0x));
    ox[v] = (mx * hw) / cos; oy[v] = (my * hw) / cos;
  }
  // a cap on a thin line is half a pixel of length: the ends simply reach that much further
  if (!closed && cap !== 'butt') {
    let dx = X[1] - X[0], dy = Y[1] - Y[0], l = Math.hypot(dx, dy) || 1;
    X[0] -= (dx / l) * hw; Y[0] -= (dy / l) * hw;
    dx = X[n - 1] - X[n - 2]; dy = Y[n - 1] - Y[n - 2]; l = Math.hypot(dx, dy) || 1;
    X[n - 1] += (dx / l) * hw; Y[n - 1] += (dy / l) * hw;
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const ax = X[i], ay = Y[i], bx = X[j], by = Y[j];
    tri(ax + ox[i], ay + oy[i], bx + ox[j], by + oy[j], bx - ox[j], by - oy[j]);
    tri(ax + ox[i], ay + oy[i], bx - ox[j], by - oy[j], ax - ox[i], ay - oy[i]);
  }
}
const STRIP = { x: new Float64Array(64), y: new Float64Array(64), ox: new Float64Array(64), oy: new Float64Array(64) };

/** At most `max` stops, sorted, offsets clamped: what the shader's uniform arrays can hold. Pure. */
export function settleStops(stops, max = 32) {
  let s = stops.map(([o, c]) => [Math.max(0, Math.min(1, Number(o) || 0)), c]);
  s = s.map((v, i) => [v, i]).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).map(([v]) => v);
  if (s.length <= max) return s;
  // too many: resample evenly. The callers that make this many stops are tracing a smooth ramp
  const at = (t) => {
    let a = s[0], b = s[s.length - 1];
    for (let i = 0; i < s.length - 1; i++) if (t >= s[i][0] && t <= s[i + 1][0]) { a = s[i]; b = s[i + 1]; break; }
    const span = b[0] - a[0], k = span > 1e-9 ? (t - a[0]) / span : 0;
    return [0, 1, 2, 3].map((i) => a[1][i] + (b[1][i] - a[1][i]) * k);
  };
  const out = [];
  for (let i = 0; i < max; i++) { const t = i / (max - 1); out.push([t, at(t)]); }
  return out;
}

/**
 * Settled stops as `n` straight-alpha RGBA texels into `out` at `at`: the row of the ramp atlas a
 * gradient samples. Interpolated straight (not premultiplied), as the 2D context does it. Pure.
 */
export function bakeRamp(stops, out, at, n = 256) {
  // span by span, stepping each channel by a constant: no search and no divide inside the loop
  const last = stops.length - 1, top = n - 1;
  const put = (i, c) => { const o = at + i * 4; out[o] = c[0] + 0.5; out[o + 1] = c[1] + 0.5; out[o + 2] = c[2] + 0.5; out[o + 3] = c[3] * 255 + 0.5; };
  let i = 0;
  for (; i <= top && i / top <= stops[0][0]; i++) put(i, stops[0][1]);
  for (let k = 0; k < last && i <= top; k++) {
    const a = stops[k], b = stops[k + 1], span = b[0] - a[0];
    if (span <= 1e-9) continue;                            // two stops at one offset: a hard edge, the later colour stands
    for (; i <= top && i / top < b[0]; i++) {
      const u = (i / top - a[0]) / span, o = at + i * 4;
      out[o] = a[1][0] + (b[1][0] - a[1][0]) * u + 0.5; out[o + 1] = a[1][1] + (b[1][1] - a[1][1]) * u + 0.5;
      out[o + 2] = a[1][2] + (b[1][2] - a[1][2]) * u + 0.5; out[o + 3] = (a[1][3] + (b[1][3] - a[1][3]) * u) * 255 + 0.5;
    }
  }
  for (; i <= top; i++) put(i, stops[last][1]);
}

// ------------------------------------------------------------------- recorded paths
// The viewer caches two shapes as Path2D objects (the ground's layers and the price line). A
// native Path2D is opaque -- nothing can read its points back -- so on this renderer the same
// call sites ask the context for one of these instead (ctx.createPath), which remembers the
// commands in user space and flattens them under whatever transform it is drawn with, cached
// per transform because the board's transform is a constant.
class GlPath {
  constructor() { this.cmds = []; this.flatKey = null; this.flat = null; }
  moveTo(x, y) { this.cmds.push(0, x, y); this.flatKey = null; }
  lineTo(x, y) { this.cmds.push(1, x, y); this.flatKey = null; }
  closePath() { this.cmds.push(2); this.flatKey = null; }
  quadraticCurveTo(cx, cy, x, y) { this.cmds.push(3, cx, cy, x, y); this.flatKey = null; }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { this.cmds.push(4, c1x, c1y, c2x, c2y, x, y); this.flatKey = null; }
  arc(x, y, r, a0, a1, ccw) { this.cmds.push(5, x, y, r, r, 0, a0, a1, ccw ? 1 : 0); this.flatKey = null; }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw) { this.cmds.push(5, x, y, rx, ry, rot, a0, a1, ccw ? 1 : 0); this.flatKey = null; }
  rect(x, y, w, h) { this.cmds.push(6, x, y, w, h); this.flatKey = null; }
}
const CMD_LEN = [3, 3, 1, 5, 7, 9, 5];
function replay(cmds, t) {
  for (let i = 0; i < cmds.length; i += CMD_LEN[cmds[i]]) {
    switch (cmds[i]) {
      case 0: t.moveTo(cmds[i + 1], cmds[i + 2]); break;
      case 1: t.lineTo(cmds[i + 1], cmds[i + 2]); break;
      case 2: t.closePath(); break;
      case 3: t.quadraticCurveTo(cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4]); break;
      case 4: t.bezierCurveTo(cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4], cmds[i + 5], cmds[i + 6]); break;
      case 5: t.ellipse(cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4], cmds[i + 5], cmds[i + 6], cmds[i + 7], cmds[i + 8] === 1); break;
      default: t.rect(cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4]);
    }
  }
}

/** A subpath that is one whole circle or ellipse: its points are made only if somebody reads them. */
class WholeTurn {
  constructor(make, disc) { this._make = make; this._pts = null; this.closed = false; this.convex = true; this.disc = disc; }
  get pts() { return (this._pts ??= this._make()); }
}

/** Builds device-space subpaths the way a 2D context does: the transform applies as points arrive. */
class PathBuilder {
  constructor() { this.subs = []; this.cur = null; this.m = [1, 0, 0, 1, 0, 0]; this.sx = 0; this.sy = 0; this.ux = 0; this.uy = 0; }
  reset() { this.subs = []; this.cur = null; }
  scale() { const m = this.m; return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1; }
  _pt(x, y) { const m = this.m; this.cur.pts.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]); this.ux = x; this.uy = y; }
  moveTo(x, y) { this.cur = { pts: [], closed: false }; this.subs.push(this.cur); this._pt(x, y); this.sx = x; this.sy = y; }
  lineTo(x, y) { if (!this.cur) this.moveTo(x, y); else { this.cur.convex = false; this.cur.disc = null; this._pt(x, y); } }
  closePath() {
    if (!this.cur) return;
    this.cur.closed = true;
    const x = this.sx, y = this.sy;
    this.cur = { pts: [], closed: false }; this.subs.push(this.cur); this._pt(x, y);
  }
  rect(x, y, w, h) { this.moveTo(x, y); const sub = this.cur; this._pt(x + w, y); this._pt(x + w, y + h); this._pt(x, y + h); sub.convex = true; this.closePath(); }
  quadraticCurveTo(cx, cy, x, y) {
    if (!this.cur) this.moveTo(cx, cy);
    const x0 = this.ux, y0 = this.uy;
    const n = Math.max(4, Math.min(48, Math.ceil(((Math.hypot(cx - x0, cy - y0) + Math.hypot(x - cx, y - cy)) * this.scale()) / 5)));
    for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; this._pt(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y); }
  }
  bezierCurveTo(ax, ay, bx, by, x, y) {
    if (!this.cur) this.moveTo(ax, ay);
    const x0 = this.ux, y0 = this.uy;
    const n = Math.max(4, Math.min(64, Math.ceil(((Math.hypot(ax - x0, ay - y0) + Math.hypot(bx - ax, by - ay) + Math.hypot(x - bx, y - by)) * this.scale()) / 5)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t, c0 = u * u * u, c1 = 3 * u * u * t, c2 = 3 * u * t * t, c3 = t * t * t;
      this._pt(c0 * x0 + c1 * ax + c2 * bx + c3 * x, c0 * y0 + c1 * ay + c2 * by + c3 * y);
    }
  }
  arc(x, y, r, a0, a1, ccw) { this.ellipse(x, y, r, r, 0, a0, a1, ccw); }
  ellipse(x, y, rx, ry, rot, a0, a1, ccw) {
    if (!(rx >= 0) || !(ry >= 0) || !Number.isFinite(a0 + a1 + x + y + rot)) return;
    const sweep = arcSweep(a0, a1, !!ccw);
    const n = arcSegments(Math.max(rx, ry) * this.scale(), sweep);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    // A WHOLE TURN ON A FRESH PATH IS A DISC, and the GL context draws a disc as one quad -- so its
    // outline is not worked out unless something asks for it (a stroke, a second outline beside
    // it). A supernova is a thousand puffs a frame, each a circle of up to a hundred points that
    // nothing ever read: that was 8% of its frame.
    if (Math.abs(sweep) >= TAU - 1e-9 && !this.cur) {
      const m = this.m.slice(), ax = rx * cr, ay = rx * sr, bx = -ry * sr, by = ry * cr;
      const sub = new WholeTurn(() => {
        const pts = [];
        for (let i = 0; i <= n; i++) {
          const t = a0 + (sweep * i) / n, ex = Math.cos(t) * rx, ey = Math.sin(t) * ry;
          const px = x + ex * cr - ey * sr, py = y + ex * sr + ey * cr;
          pts.push(m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]);
        }
        return pts;
      }, [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5], m[0] * ax + m[2] * ay, m[1] * ax + m[3] * ay, m[0] * bx + m[2] * by, m[1] * bx + m[3] * by]);
      this.cur = sub; this.subs.push(sub);
      const ex = Math.cos(a0) * rx, ey = Math.sin(a0) * ry;
      this.sx = this.ux = x + ex * cr - ey * sr; this.sy = this.uy = y + ex * sr + ey * cr;
      return;
    }
    for (let i = 0; i <= n; i++) {
      const t = a0 + (sweep * i) / n, ex = Math.cos(t) * rx, ey = Math.sin(t) * ry;
      const px = x + ex * cr - ey * sr, py = y + ex * sr + ey * cr;
      if (i === 0) this.lineTo(px, py); else this._pt(px, py);
    }
  }
}

// ------------------------------------------------------------------- gradients
class GlGradient {
  constructor(kind, g) { this.kind = kind; this.g = g; this.stops = []; this.settled = null; }
  addColorStop(o, colour) {
    // (an [r, g, b, a] array is taken as it is: an effect that mints a colour per puff per frame need
    // not print it as a string for this to read back -- details3d gasCloud)
    const c = Array.isArray(colour) ? colour : parseColour(colour);
    if (!c || !(o >= 0 && o <= 1)) return;
    this.stops.push([o, c]); this.settled = null; this.key = null;
  }
}

// ------------------------------------------------------------------- the programs
const VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec4 aCol;
layout(location=2) in vec3 aGrad;        // an atlas gradient: its coordinate, and its row (< 0: none)
layout(location=3) in vec3 aDisc;        // an analytic disc: the unit-circle coordinate, and 1 (0: none)
uniform vec2 uView;
uniform mat3 uInv;
out vec4 vCol;
out vec2 vP;
out vec2 vG;
flat out float vRow;
out vec3 vD;
void main() {
  vCol = aCol;
  vG = aGrad.xy; vRow = aGrad.z;
  vD = aDisc;
  vP = (uInv * vec3(aPos, 1.0)).xy;
  gl_Position = vec4(aPos.x * 2.0 / uView.x - 1.0, 1.0 - aPos.y * 2.0 / uView.y, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec4 vCol;
in vec2 vP;
in vec2 vG;
flat in float vRow;
in vec3 vD;
uniform sampler2D uRamp;
uniform int uMode;          // 0 the vertex colour, 1 linear, 2 radial, 3 texture
uniform vec4 uG0;           // x0 y0 r0
uniform vec4 uG1;           // x1 y1 r1
uniform int uN;
uniform float uOff[32];
uniform vec4 uCol[32];
uniform float uAlpha;
uniform sampler2D uTex;
layout(location=0) out vec4 o;
// WHAT THROWS LIGHT, for the finish's bloom: the colour again where the drawing was marked
// emissive (ctx.emissive: the neon, the stars, every effect), BLACK but just as opaque where it was
// not -- so a cube in front of a neon line hides the line's light as it hides the line. A cube's
// colour is DATA (the feerate) and must not bloom; the first cut bloomed by brightness alone and
// turned every yellow cube into a lamp.
layout(location=1) out vec4 oE;
void emit(float e) {
  // near-white is light whoever drew it: a cube flashing white in an effect may glow
  float white = o.a > 0.0 ? smoothstep(0.80, 0.95, min(o.r, min(o.g, o.b)) / o.a) : 0.0;
  oE = vec4(o.rgb * max(e, white), o.a);
}
vec4 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec4 c = uCol[0];
  for (int i = 1; i < 32; i++) {
    if (i >= uN) break;
    float span = uOff[i] - uOff[i - 1];
    // stops at one offset are a hard edge: at or past it the later colour stands
    if (t >= uOff[i]) { c = uCol[i]; continue; }
    if (t > uOff[i - 1] && span > 1e-6) c = mix(uCol[i - 1], uCol[i], (t - uOff[i - 1]) / span);
    break;
  }
  return vec4(c.rgb * c.a, c.a);      // interpolated straight, as the 2D context does; out premultiplied
}
void main() {
  if (uMode == 0) {
    // AN ANALYTIC DISC: the quad carries the unit circle's coordinate, and the edge is the distance
    // to it measured in pixels (fwidth), so a circle is two triangles at any size and its rim is
    // smoother than any polygon's -- under any transform, an ellipse included
    float cover = 1.0;
    float e = vD.z > 1.5 ? 1.0 : 0.0;
    if (mod(vD.z, 2.0) > 0.5) {
      float d = length(vD.xy), w = max(fwidth(d), 1e-6);
      cover = clamp(0.5 + (1.0 - d) / w, 0.0, 1.0);
      if (cover <= 0.0) discard;
    }
    if (vRow < 0.0) { o = vCol * cover; emit(e); return; }
    // A GRADIENT FROM THE ATLAS: row = which ramp, its fraction = which kind (.5 is linear, the
    // coordinate's x IS t; else radial about the coordinate's origin, t its length). Two texels
    // fetched and mixed by hand, so neighbouring rows can never bleed into each other.
    int row = int(floor(vRow));
    float t = clamp(fract(vRow) > 0.25 ? vG.x : length(vG), 0.0, 1.0) * 63.0;
    int i0 = int(floor(t)), i1 = min(i0 + 1, 63);
    vec4 c = mix(texelFetch(uRamp, ivec2(i0, row), 0), texelFetch(uRamp, ivec2(i1, row), 0), t - float(i0));
    o = vec4(c.rgb * c.a, c.a) * (vCol.a * cover);
    emit(e);
    return;
  }
  if (uMode == 3) { o = texture(uTex, vP) * uAlpha; emit(0.0); return; }   // a cached bitmap (a day sky, the gas) is never a lamp
  float t;
  if (uMode == 1) {
    vec2 d = uG1.xy - uG0.xy;
    float l = dot(d, d);
    if (l < 1e-12) { o = vec4(0.0); oE = o; return; }
    t = dot(vP - uG0.xy, d) / l;
  } else {
    // the two-circle gradient: the largest t whose circle passes through this point
    vec2 cd = uG1.xy - uG0.xy, pd = vP - uG0.xy;
    float dr = uG1.z - uG0.z;
    float a = dot(cd, cd) - dr * dr, b = dot(pd, cd) + uG0.z * dr, c = dot(pd, pd) - uG0.z * uG0.z;
    if (abs(a) < 1e-9) {
      if (abs(b) < 1e-9) { o = vec4(0.0); oE = o; return; }
      t = c / (2.0 * b);
      if (uG0.z + t * dr < 0.0) { o = vec4(0.0); oE = o; return; }
    } else {
      float disc = b * b - a * c;
      if (disc < 0.0) { o = vec4(0.0); oE = o; return; }
      float s = sqrt(disc), t1 = (b + s) / a, t2 = (b - s) / a;
      t = max(t1, t2);
      if (uG0.z + t * dr < 0.0) t = min(t1, t2);
      if (uG0.z + t * dr < 0.0) { o = vec4(0.0); oE = o; return; }
    }
  }
  o = ramp(t) * uAlpha;
  emit(1.0);
}`;

// ---- THE FINISH (2026-09-21; operator: "The WebGL should look much better than the software
// renderer"). What a 2D canvas cannot do at all, and a GPU does for nothing: the frame is drawn
// into a multisampled texture instead of the screen, the bright part of it is blurred at three
// sizes, and the blur is ADDED back -- bloom, so a neon line, a spark or a white-hot core throws
// light the way the effects have always pretended to with stacked translucent strokes -- and the
// result is dithered by under one 8-bit step, which is what finally removes the banding from the
// wide faint glows. One program, four kinds of pass, a full-screen triangle from gl_VertexID.
const POST_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
const POST_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform int uPass;          // 0 bright pass, 1 blur, 2 composite
uniform sampler2D uSrc, uB0, uB1, uB2;
uniform vec2 uDir;          // the blur's step, in uv
uniform float uStrength, uThreshold;
out vec4 o;
void main() {
  if (uPass == 0) {
    // what is bright enough to throw light: a soft knee, so nothing pops as it crosses the line
    vec4 c = texture(uSrc, vUv);
    float m = max(c.r, max(c.g, c.b));
    float k = smoothstep(uThreshold, uThreshold + 0.35, m);
    o = vec4(c.rgb * k, 1.0);
    return;
  }
  if (uPass == 1) {
    vec3 c = texture(uSrc, vUv).rgb * 0.2270270270;
    c += (texture(uSrc, vUv + uDir * 1.3846153846).rgb + texture(uSrc, vUv - uDir * 1.3846153846).rgb) * 0.3162162162;
    c += (texture(uSrc, vUv + uDir * 3.2307692308).rgb + texture(uSrc, vUv - uDir * 3.2307692308).rgb) * 0.0702702703;
    o = vec4(c, 1.0);
    return;
  }
  vec4 c = texture(uSrc, vUv);
  vec3 glow = (texture(uB0, vUv).rgb * 0.45 + texture(uB1, vUv).rgb * 0.75 + texture(uB2, vUv).rgb) * uStrength;
  // under one 8-bit step of noise, different every pixel: the eye averages it and the bands go
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  vec3 rgb = c.rgb + glow + n / 255.0;
  // a clear canvas (a game's well over its sky) takes the glow's light as coverage, so it shows
  float a = clamp(c.a + max(glow.r, max(glow.g, glow.b)), 0.0, 1.0);
  o = vec4(min(rgb, vec3(1.0)) * step(0.0005, a), a);
}`;

// ---- THE STAR FIELD ON THE GRAPHICS CARD (2026-09-21; operator: "do the star field next"). Forty
// thousand stars were a JavaScript loop a frame -- turn each with the galaxy, twinkle it, sort it
// into a shade, build a rect -- and about fifty thousand vertices rebuilt, and that was what was
// left of a resting frame once the board was kept. Every one of those steps is a function of the
// star's own constants and two numbers (the clock, the galaxy's turn), so the constants go to the
// card ONCE, as one instance each, and the vertex shader does the rest: one draw call, nothing
// per star on the processor.
const STAR_VS = `#version 300 es
layout(location=0) in vec4 aPos;        // galaxy: radius, cos(angle), sin(angle), half-side   |  flat: x, y, -, half-side
layout(location=1) in vec4 aLook;       // r, g, b (0..1), brightness
layout(location=2) in vec3 aBeat;       // twinkle: frequency (rad/ms), phase, the floor it fades to
uniform vec2 uView;
uniform mat3 uM;                         // the context's transform
uniform vec4 uGalaxy;                    // centre x, y, flatten, 1 if the field turns (else 0)
uniform vec2 uSpin;                      // cos, sin of the galaxy's turn
uniform vec2 uClock;                     // now (ms, wrapped to the beat period), overall brightness
out vec4 vCol;
void main() {
  int v = gl_VertexID;
  vec2 q = vec2((v == 1 || v == 2 || v == 4) ? 1.0 : -1.0, (v == 2 || v == 4 || v == 5) ? 1.0 : -1.0);
  vec2 c = uGalaxy.w > 0.5
    ? uGalaxy.xy + aPos.x * vec2(aPos.y * uSpin.x - aPos.z * uSpin.y, uGalaxy.z * (aPos.z * uSpin.x + aPos.y * uSpin.y))
    : aPos.xy;
  vec2 p = (uM * vec3(c + q * aPos.w, 1.0)).xy;
  float w = 0.5 + 0.5 * sin(uClock.x * aBeat.x + aBeat.y);
  float a = min(1.0, aLook.a * (aBeat.z + (1.0 - aBeat.z) * w * w) * uClock.y);
  vCol = vec4(aLook.rgb * a, a);
  gl_Position = vec4(p.x * 2.0 / uView.x - 1.0, 1.0 - p.y * 2.0 / uView.y, 0.0, 1.0);
}`;
const STAR_FS = `#version 300 es
precision mediump float;
in vec4 vCol;
layout(location=0) out vec4 o;
layout(location=1) out vec4 oE;          // a star throws light (the finish's bloom)
void main() { o = vCol; oE = vCol; }`;
/** The twinkle's clock wraps every STAR_BEAT ms, and every star's frequency is a whole number of
 * turns in that time -- so the wrap is seamless, and a float32 on the card never sees a big clock
 * (after eleven days of uptime now * f is two million radians, and the twinkle would stutter). */
export const STAR_BEAT = 600000;
/** A star's twinkle frequency (rad/ms) moved to the nearest that fits STAR_BEAT a whole number of times. Pure. */
export function beatFrequency(f) { const f0 = (Math.PI * 2) / STAR_BEAT; return Math.max(1, Math.round(f / f0)) * f0; }

let SUPPORT = null;
/** Can this page make a WebGL2 context at all? Asked once. */
export function gl2dSupported() {
  if (SUPPORT != null) return SUPPORT;
  try {
    const c = globalThis.document?.createElement?.('canvas');
    const gl = c?.getContext?.('webgl2', { stencil: true });
    SUPPORT = !!gl;
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
  } catch { SUPPORT = false; }
  return SUPPORT;
}

const MAX_VERTS = 1 << 19;
const TEXT_CACHE_MAX = 256;
const COLOUR_CACHE_MAX = 8192;

/**
 * A 2D-context look-alike drawing on `canvas` with WebGL2. Null when the context or the program
 * cannot be made (the caller falls back to the software renderer); never throws.
 *   hooks.onLost()            the context died; the caller goes back to software
 *   hooks.onCompileError(log) the shader log, for a headless bring-up
 *   hooks.gl                  a context to use instead of asking the canvas (the unit tests' stub)
 */
export function createGl2d(canvas, hooks = {}) {
  let gl = null;
  try {
    gl = hooks.gl ?? canvas?.getContext?.('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true, stencil: true, depth: false, preserveDrawingBuffer: hooks.preserve === true });
  } catch { gl = null; }
  if (!gl) return null;

  let prog = null; const U = {};
  try {
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    for (const n of ['uView', 'uInv', 'uMode', 'uG0', 'uG1', 'uN', 'uOff', 'uCol', 'uAlpha', 'uTex', 'uRamp']) U[n] = gl.getUniformLocation(prog, n);
  } catch (e) {
    try { hooks.onCompileError?.(String(e?.message ?? e)); } catch { /* a hook must not break the fallback */ }
    return null;
  }

  // one interleaved buffer, nine words a vertex: x, y, the packed colour, the atlas gradient's
  // coordinate and row (row < 0: a plain colour), and the analytic disc's coordinate and flag
  let cap = 1 << 15;
  let buf = new ArrayBuffer(cap * 36), f32 = new Float32Array(buf), u32 = new Uint32Array(buf);
  let nv = 0;
  const vbo = gl.createBuffer(), vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 36, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 36, 8);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 12);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 36, 24);
  // the stream (see drawBatch): vertices the buffer holds, where the next batch goes, and how
  // often it was orphaned this frame
  const STREAM_MAX = 1 << 20;
  let streamCap = cap, streamAt = 0, orphans = 0;

  const stats = { draws: 0, verts: 0, stencils: 0, frames: 0, replayed: 0 };
  let lost = false;
  const onLost = (e) => { e?.preventDefault?.(); lost = true; try { hooks.onLost?.(); } catch { /* as above */ } };
  canvas?.addEventListener?.('webglcontextlost', onLost);

  // ---- the finish: bloom and dither (see POST_FS). Off (strength 0) the frame goes straight to
  // the screen as before; any failure to build it is "off", never a blank board.
  let bloom = 0, postBroken = false, post = null, postProg = null; const PU = {};
  const buildPost = (w, h) => {
    try {
      if (!postProg) {
        const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) || 'post shader'); return x; };
        postProg = gl.createProgram();
        gl.attachShader(postProg, sh(gl.VERTEX_SHADER, POST_VS)); gl.attachShader(postProg, sh(gl.FRAGMENT_SHADER, POST_FS));
        gl.linkProgram(postProg);
        if (!gl.getProgramParameter(postProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(postProg) || 'post link');
        for (const n of ['uPass', 'uSrc', 'uB0', 'uB1', 'uB2', 'uDir', 'uStrength', 'uThreshold']) PU[n] = gl.getUniformLocation(postProg, n);
      }
      const target = (tw, th) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('target incomplete');
        return { tex, fbo, w: tw, h: th };
      };
      const samples = Math.min(4, Number(gl.getParameter(gl.MAX_SAMPLES)) || 0);
      const ms = gl.createFramebuffer(), rbC = gl.createRenderbuffer(), rbE = gl.createRenderbuffer(), rbS = gl.createRenderbuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, ms);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbC); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbC);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbE); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, rbE);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbS); gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rbS);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('multisample target incomplete');
      const scene = target(w, h), light = target(w, h), levels = [];
      for (let i = 1; i <= 3; i++) { const lw = Math.max(1, w >> i), lh = Math.max(1, h >> i); levels.push({ a: target(lw, lh), b: target(lw, lh) }); }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { w, h, ms, rbC, rbE, rbS, scene, light, levels };
    } catch (e) {
      postBroken = true;
      try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); hooks.onCompileError?.(`post: ${String(e?.message ?? e)}`); } catch { /* as above */ }
      return null;
    }
  };
  const freePost = () => {
    if (!post) return;
    try {
      for (const t of [post.scene, post.light, ...post.levels.flatMap((l) => [l.a, l.b])]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
      gl.deleteFramebuffer(post.ms); gl.deleteRenderbuffer(post.rbC); gl.deleteRenderbuffer(post.rbE); gl.deleteRenderbuffer(post.rbS);
    } catch { /* a dead context has nothing to free */ }
    post = null;
  };
  let postLive = false;                                     // this frame is being drawn into post.ms
  const finish = () => {
    const w = post.w, h = post.h;
    gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, post.ms); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, post.scene.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);      // the multisample resolve: the picture...
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, post.light.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);      // ...and what in it throws light
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.useProgram(postProg);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    const pass = (dst, src, kind, dx, dy) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
      gl.viewport(0, 0, dst ? dst.w : w, dst ? dst.h : h);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(PU.uPass, kind); gl.uniform1i(PU.uSrc, 0); gl.uniform2f(PU.uDir, dx, dy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      stats.draws++;
    };
    gl.uniform1f(PU.uThreshold, 0.18); gl.uniform1f(PU.uStrength, bloom);
    let src = post.light, kind = 0;
    for (const l of post.levels) {
      pass(l.a, src, kind, 0, 0);                            // the bright pass, then each level from the last (a linear downsample)
      pass(l.b, l.a, 1, 1 / l.a.w, 0); pass(l.a, l.b, 1, 0, 1 / l.a.h);
      src = l.a; kind = 1;
    }
    for (let i = 0; i < 3; i++) { gl.activeTexture(gl.TEXTURE1 + i); gl.bindTexture(gl.TEXTURE_2D, post.levels[i].a.tex); gl.uniform1i(PU[`uB${i}`], 1 + i); }
    gl.activeTexture(gl.TEXTURE0);
    pass(null, post.scene, 2, 0, 0);
  };

  // ---- state
  const P = new PathBuilder();
  let S = { fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic' };
  const stack = [];
  let mode = -1;                                            // what the program's uniforms are set for
  let prepared = false;

  const colours = new Map();
  const colourOf = (style) => {
    let c = colours.get(style);
    if (c === undefined) {
      c = parseColour(style) ?? cssColour(style);
      if (colours.size >= COLOUR_CACHE_MAX) colours.clear();   // effects mint a colour per particle per frame
      colours.set(style, c);
    }
    return c;
  };
  // anything the parser does not know, the browser does: a scratch 2D context normalises it
  let scratch = null;
  const scratchCtx = () => {
    if (scratch) return scratch;
    try { scratch = globalThis.document?.createElement?.('canvas')?.getContext?.('2d') ?? null; } catch { scratch = null; }
    return scratch;
  };
  function cssColour(style) {
    const c2 = scratchCtx();
    if (!c2) return null;
    c2.fillStyle = '#000'; c2.fillStyle = style;
    return parseColour(String(c2.fillStyle));
  }

  const prepare = () => {
    if (prepared) return;
    prepared = true;
    // where this frame goes: the finish's multisampled target, or the screen
    postLive = false;
    if (bloom > 0 && !postBroken && canvas.width > 0 && canvas.height > 0) {
      if (!post || post.w !== canvas.width || post.h !== canvas.height) { freePost(); post = buildPost(canvas.width, canvas.height); }
      postLive = !!post;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, postLive ? post.ms : null);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(U.uView, canvas.width, canvas.height);
    gl.uniform1i(U.uTex, 0); gl.uniform1i(U.uRamp, 1);
    if (rampTex) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rampTex); gl.activeTexture(gl.TEXTURE0); }
    mode = -1;
  };
  const drawBatch = () => {
    if (!nv) return;
    if (rampDirty0 <= rampDirty1) uploadRamps();
    // THE VERTEX BUFFER IS A STREAM, NEVER OVERWRITTEN IN PLACE (operator, 2026-09-21: "The pulsar
    // winds effect is very slow on webgl"). Every batch used to go to offset 0 of one buffer. The
    // draw before it is still READING that buffer, so the upload has to wait for it: an implicit
    // GPU sync per draw call, fifty a frame in an effect that stencils. Profiled (Chrome's CPU
    // profiler, the pulsar mid-run on a 2560x1300 panel): 267 of 308 ms a frame inside
    // bufferSubData, all the geometry in JS together about 35. So each batch is APPENDED after
    // the last, and when the buffer is full it is orphaned -- bufferData hands back fresh storage
    // and lets the old one drain -- rather than written over.
    if (streamAt + nv > streamCap) {
      while (streamCap < nv) streamCap *= 2;
      if (orphans >= 1 && streamCap < STREAM_MAX) streamCap *= 2;   // twice in one frame: it was too small
      gl.bufferData(gl.ARRAY_BUFFER, streamCap * 36, gl.DYNAMIC_DRAW);
      streamAt = 0; orphans++;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, streamAt * 36, f32, 0, nv * 9);
    gl.drawArrays(gl.TRIANGLES, streamAt, nv);
    streamAt += nv;
    stats.draws++; stats.verts += nv;
    if (rec) { if (mode !== 0) rec.bad = true; else { rec.chunks.push({ kind: drawKind, count: nv, data: f32.slice(0, nv * 9) }); rec.verts += nv; } }
    nv = 0;
  };
  // the stencil's three states, shared by the live path (stencilled) and a retained segment's replay
  const stencilWrite = (rule) => {
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    if (rule === 'union') gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    else if (rule === 'evenodd') gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    else { gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP); gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP); }
  };
  const stencilCover = () => {
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);                // the cover also wipes what it used
  };

  // ---- RETAINED SEGMENTS (2026-09-21; operator: "continue with the black hole and the board
  // cache"). A board at rest is the same three thousand faces and seams every frame, and building
  // them again -- paths, colours, 110k vertices -- was the floor under every WebGL frame. The caller
  // wraps a stretch of drawing in retained(id, same, fn) and says whether its INPUTS are the same
  // as last frame's (paintFrame compares the ops themselves; nothing is assumed). Not the same:
  // fn runs and what it sent to the GPU is kept, chunk by chunk with its stencil state. The same:
  // fn does not run at all, and the kept vertices are drawn from a static buffer. Anything that
  // cannot be replayed from vertices alone (a texture, a two-circle gradient) marks the recording
  // bad, and that segment simply draws live for ever -- correct, only not faster.
  let rec = null, drawKind = 'plain', atlasEpoch = 0;
  const segments = new Map();
  const freeSegment = (seg) => { try { if (seg.vbo) gl.deleteBuffer(seg.vbo); if (seg.vao) gl.deleteVertexArray(seg.vao); } catch { /* a dead context */ } seg.vbo = seg.vao = null; };
  const replaySegment = (seg) => {
    if (!seg.vbo) {
      // the first frame it is reused: only now is it worth a buffer of its own
      const all = new Float32Array(seg.verts * 9); let at = 0;
      for (const c of seg.chunks) { all.set(c.data, at * 9); c.first = at; at += c.count; c.data = null; }
      seg.vao = gl.createVertexArray(); seg.vbo = gl.createBuffer();
      gl.bindVertexArray(seg.vao); gl.bindBuffer(gl.ARRAY_BUFFER, seg.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, all, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 36, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 36, 8);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 12);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 36, 24);
    } else gl.bindVertexArray(seg.vao);
    if (mode !== 0) { gl.uniform1i(U.uMode, 0); mode = 0; }
    for (const c of seg.chunks) {
      if (c.kind === 'plain') { gl.drawArrays(gl.TRIANGLES, c.first, c.count); }
      else if (c.kind === 'cover') { stencilCover(); gl.drawArrays(gl.TRIANGLES, c.first, c.count); gl.disable(gl.STENCIL_TEST); }
      else { stencilWrite(c.kind); gl.drawArrays(gl.TRIANGLES, c.first, c.count); }
      stats.draws++;
    }
    stats.replayed += seg.verts;
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  };
  function retained(id, same, fn) {
    if (lost || rec) { fn(); return; }                      // (no nesting: the inner one just draws)
    prepare();
    let seg = segments.get(id);
    const usable = seg && !seg.bad && seg.epoch === atlasEpoch && seg.w === canvas.width && seg.h === canvas.height && seg.target === postLive;
    if (same && usable) { drawBatch(); replaySegment(seg); stats.live = null; return; }
    stats.live = !same ? 'changed' : !seg ? 'first' : seg.bad ? 'not replayable' : 'rebuilt';   // why this frame drew it live (a bring-up aid)
    if (seg) freeSegment(seg);
    drawBatch();
    rec = { chunks: [], verts: 0, bad: false };
    try { fn(); drawBatch(); } finally {
      seg = { chunks: rec.chunks, verts: rec.verts, bad: rec.bad || rec.verts === 0, epoch: atlasEpoch, w: canvas.width, h: canvas.height, target: postLive, vbo: null, vao: null };
      if (seg.bad) seg.chunks = [];
      segments.set(id, seg);
      rec = null;
    }
  }
  const setSolid = () => { if (mode !== 0) { drawBatch(); gl.uniform1i(U.uMode, 0); mode = 0; } };
  const room = (verts) => {
    if (nv + verts <= cap) return;
    if (nv + verts > MAX_VERTS && nv) drawBatch();
    if (nv + verts > cap) {
      while (cap < nv + verts) cap *= 2;
      const nb = new ArrayBuffer(cap * 36), nf = new Float32Array(nb);
      nf.set(f32.subarray(0, nv * 9));
      buf = nb; f32 = nf; u32 = new Uint32Array(nb);
    }
  };
  // the atlas gradient the next vertices carry (G.row < 0: none): device -> gradient coordinate is affine
  let emissive = 2;                                         // 2 or 0: rides in the disc word (see the shader)
  const G = { row: -1, a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 };
  const vert = (x, y, col) => {
    const i = nv * 9; f32[i] = x; f32[i + 1] = y; u32[i + 2] = col;
    if (G.row < 0) f32[i + 5] = -1;
    else { f32[i + 3] = G.a * x + G.c * y + G.e; f32[i + 4] = G.b * x + G.d * y + G.f; f32[i + 5] = G.row; }
    f32[i + 8] = emissive;
    nv++;
  };
  // A DISC AS ONE QUAD: centre and the two half-axes in DEVICE space (so any transform, and an
  // ellipse, are already in them); the quad reaches a pixel past the rim for the soft edge
  const discQuad = (cx, cy, ax, ay, bx, by, col) => {
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (!(la > 0) || !(lb > 0)) return;
    const ka = 1 + 1.5 / la, kb = 1 + 1.5 / lb;              // in unit-circle coordinates
    room(6);
    for (let q = 0; q < 6; q++) {
      const u = (q === 0 || q === 3 || q === 5) ? -ka : ka, v = (q === 0 || q === 1 || q === 3) ? -kb : kb;
      //      corners: 0(-,-) 1(+,-) 2(+,+)   3(-,-) 4(+,+) 5(-,+)
      const i = nv * 9;
      vert(cx + ax * u + bx * v, cy + ay * u + by * v, col);
      f32[i + 6] = u; f32[i + 7] = v; f32[i + 8] = 1 + emissive;
    }
  };

  // ---- THE RAMP ATLAS (2026-09-21; operator: "The supernova effect has major performance issues on
  // the GL path"). A gradient fill used to be its own draw call with thirty-two stops uploaded as
  // uniforms, and the supernova makes four hundred a frame. Now a gradient's ramp is a ROW of this
  // texture, its coordinate rides on the vertex, and the fill joins the same batch as everything
  // else. Rows are keyed on the stops, so a gradient made again next frame with the same colours
  // costs nothing; when the rows run out the batch is drawn and the atlas starts over.
  // 64 texels a ramp: the shader mixes between texels, so a smooth ramp is exact at any width and a
  // hard edge is a 64th of the radius soft. 256 was four times the baking for nothing (13% of a frame).
  const RAMP_W = 64, RAMP_ROWS = 1024;
  const rampPx = new Uint8Array(RAMP_W * RAMP_ROWS * 4);
  const rampRows = new Map();
  let rampNext = 0, rampDirty0 = Infinity, rampDirty1 = -1, rampTex = null;
  const uploadRamps = () => {
    gl.activeTexture(gl.TEXTURE1);
    if (!rampTex) {
      rampTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, rampTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, RAMP_W, RAMP_ROWS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    } else gl.bindTexture(gl.TEXTURE_2D, rampTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    const rows = rampDirty1 - rampDirty0 + 1;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rampDirty0, RAMP_W, rows, gl.RGBA, gl.UNSIGNED_BYTE, rampPx, rampDirty0 * RAMP_W * 4);
    gl.activeTexture(gl.TEXTURE0);
    rampDirty0 = Infinity; rampDirty1 = -1;
  };
  const rampRow = (grad, stops) => {
    // the key is a number hashed from the stops (two FNV streams folded into one double): building a
    // string per gradient per frame was half of what the baking cost
    let key = grad.key;
    if (key == null) {
      let h1 = 0x811c9dc5 | 0, h2 = 0x1b873593 | 0;
      for (let i = 0; i < stops.length; i++) {
        const st = stops[i], c = st[1];
        const w0 = (st[0] * 65535) | 0, w1 = (c[0] << 16) | (c[1] << 8) | c[2], w2 = (c[3] * 1e6) | 0;
        h1 = Math.imul(h1 ^ w0, 16777619); h1 = Math.imul(h1 ^ w1, 16777619); h1 = Math.imul(h1 ^ w2, 16777619);
        h2 = Math.imul(h2 ^ w2, 0x85ebca6b) ^ (h2 >>> 13); h2 = Math.imul(h2 ^ w1, 0xc2b2ae35) ^ (h2 >>> 16); h2 = Math.imul(h2 ^ w0, 0x27d4eb2f);
      }
      key = grad.key = (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
    }
    let row = rampRows.get(key);
    if (row !== undefined) return row;
    if (rampNext >= RAMP_ROWS) { drawBatch(); rampRows.clear(); rampNext = 0; atlasEpoch++; if (rec) rec.bad = true; }   // (a kept segment's rows are gone with it)   // what is batched still points at the old rows: draw it first
    row = rampNext++;
    bakeRamp(stops, rampPx, row * RAMP_W * 4, RAMP_W);
    rampRows.set(key, row);
    if (row < rampDirty0) rampDirty0 = row;
    if (row > rampDirty1) rampDirty1 = row;
    return row;
  };
  // aim the vertices that follow at an atlas gradient; false when this gradient cannot ride the atlas
  const aimGradient = (paint) => {
    const g = paint.grad.g, inv = inverse();
    if (!inv) return false;
    let a, b, c, d, e, f, kind;
    if (paint.grad.kind === 'linear') {
      const dx = g[2] - g[0], dy = g[3] - g[1], l = dx * dx + dy * dy;
      if (l < 1e-18) return false;
      // t = dot(p - p0, d) / |d|^2, with p = inv * device
      a = (inv[0] * dx + inv[1] * dy) / l; c = (inv[2] * dx + inv[3] * dy) / l; e = ((inv[4] - g[0]) * dx + (inv[5] - g[1]) * dy) / l;
      b = 0; d = 0; f = 0; kind = 0.5;
    } else {
      // every radial gradient in this project is a disc from its own centre; the general two-circle
      // form keeps the uniform path (setGradient)
      if (g[2] !== 0 || g[0] !== g[3] || g[1] !== g[4] || !(g[5] > 0)) return false;
      const r = g[5];
      a = inv[0] / r; b = inv[1] / r; c = inv[2] / r; d = inv[3] / r; e = (inv[4] - g[0]) / r; f = (inv[5] - g[1]) / r; kind = 0;
    }
    G.row = rampRow(paint.grad, paint.stops) + kind;          // (after rampRow: it may draw the batch)
    G.a = a; G.b = b; G.c = c; G.d = d; G.e = e; G.f = f;
    return true;
  };

  // ---- paints
  const inverse = () => {
    const m = P.m, det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(det) < 1e-12) return null;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  };
  const paintOf = (style) => {
    if (style instanceof GlGradient) {
      if (!style.stops.length) return null;
      const stops = (style.settled ??= settleStops(style.stops));
      return { grad: style, stops, opaque: false };
    }
    const c = colourOf(style);
    if (!c || c[3] <= 0) return null;
    return { colour: c, opaque: c[3] >= 0.999 };
  };
  const offs = new Float32Array(32), cols = new Float32Array(32 * 4);
  // make the program paint with a gradient: the uniforms, and the map from device back to the
  // user space the gradient's circles were given in (the transform at the moment of painting)
  const setGradient = (paint, alpha) => {
    drawBatch();
    const inv = inverse();
    if (!inv) return false;
    const g = paint.grad.g, stops = paint.stops;
    gl.uniform1i(U.uMode, paint.grad.kind === 'linear' ? 1 : 2); mode = 9;
    gl.uniformMatrix3fv(U.uInv, false, new Float32Array([inv[0], inv[1], 0, inv[2], inv[3], 0, inv[4], inv[5], 1]));
    if (paint.grad.kind === 'linear') { gl.uniform4f(U.uG0, g[0], g[1], 0, 0); gl.uniform4f(U.uG1, g[2], g[3], 0, 0); }
    else { gl.uniform4f(U.uG0, g[0], g[1], g[2], 0); gl.uniform4f(U.uG1, g[3], g[4], g[5], 0); }
    for (let i = 0; i < stops.length; i++) {
      offs[i] = stops[i][0];
      const c = stops[i][1];
      cols[4 * i] = c[0] / 255; cols[4 * i + 1] = c[1] / 255; cols[4 * i + 2] = c[2] / 255; cols[4 * i + 3] = c[3];
    }
    gl.uniform1i(U.uN, stops.length);
    gl.uniform1fv(U.uOff, offs); gl.uniform4fv(U.uCol, cols);
    gl.uniform1f(U.uAlpha, alpha);
    return true;
  };

  // ---- the two ways to put triangles on the screen
  // (1) straight into the batch, the paint's colour on every vertex (or the gradient program)
  // (2) into the stencil, then one quad over their bounding box painted where the stencil is set
  let bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
  const bboxReset = () => { bx0 = by0 = Infinity; bx1 = by1 = -Infinity; };
  const bboxAdd = (x, y) => { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; };
  const cover = (paint, alpha) => {
    if (!(bx1 >= bx0)) return;
    const x0 = Math.max(0, bx0 - 1), y0 = Math.max(0, by0 - 1), x1 = Math.min(canvas.width, bx1 + 1), y1 = Math.min(canvas.height, by1 + 1);
    if (!(x1 > x0 && y1 > y0)) return;
    const col = paint.colour ? packColour(paint.colour, alpha) : 0xffffffff;
    room(6);
    vert(x0, y0, col); vert(x1, y0, col); vert(x1, y1, col);
    vert(x0, y0, col); vert(x1, y1, col); vert(x0, y1, col);
  };
  // PAINTED ONCE, IN ONE PASS: a see-through stroke is the UNION of its pieces, and the classic way
  // to get that (stencilled, below) marks the pieces and then paints one quad over their whole
  // bounding box -- which for the pulsar's gas, scattered over the panel in ten shades and two
  // widths, is twenty full-panel passes a frame at every sample of the multisampled buffer. Here
  // the pieces paint THEMSELVES, each pixel only if the stencil has not seen it yet, and mark it
  // as they go: one draw, no covering quad, the same union. The stencil is wiped afterwards by a
  // scissored clear, which costs nothing. Solid paints only, and never while a segment is being
  // recorded for replay (its chunks know the two classic states and no third).
  const paintedOnce = (emit, paint, alpha) => {
    if (globalThis.__gl2dTrace) { const k = 'once: ' + new Error().stack.split('\n').slice(3, 5).join(' < ').replace(/https?:\/\/[^/]+/g, ''); globalThis.__gl2dTrace.set(k, (globalThis.__gl2dTrace.get(k) || 0) + 1); }
    drawBatch();
    room(3);
    bboxReset();
    emit(packColour(paint.colour, alpha));
    if (!nv) return;
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.NOTEQUAL, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    if (mode !== 0) { gl.uniform1i(U.uMode, 0); mode = 0; }
    drawBatch();
    const x0 = Math.max(0, Math.floor(bx0) - 2), y0 = Math.max(0, Math.floor(by0) - 2);
    const x1 = Math.min(canvas.width, Math.ceil(bx1) + 2), y1 = Math.min(canvas.height, Math.ceil(by1) + 2);
    if (x1 > x0 && y1 > y0) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(x0, canvas.height - y1, x1 - x0, y1 - y0);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
    }
    gl.disable(gl.STENCIL_TEST);
    stats.stencils++;
  };
  const stencilled = (emit, paint, alpha, evenodd, once = false) => {
    if (once && evenodd === 'union' && !paint.grad && !rec) { paintedOnce(emit, paint, alpha); return; }
    // opt-in bring-up aid (scripts/gl-compare.mjs --trace): which call sites reach the stencil. A
    // stencil pass is two draws and a state change, so the count per site is what to look at first
    if (globalThis.__gl2dTrace) { const k = new Error().stack.split('\n').slice(3, 5).join(' < ').replace(/https?:\/\/[^/]+/g, ''); globalThis.__gl2dTrace.set(k, (globalThis.__gl2dTrace.get(k) || 0) + 1); }
    drawBatch();
    room(3);
    bboxReset();
    emit(0);
    if (!nv) return;
    const rule = evenodd === 'union' ? 'union' : evenodd ? 'evenodd' : 'nonzero';
    stencilWrite(rule);
    if (mode !== 0) { gl.uniform1i(U.uMode, 0); mode = 0; }
    drawKind = rule; drawBatch();
    stencilCover();
    drawKind = 'cover';
    if (paint.grad && aimGradient(paint)) { cover({ colour: [255, 255, 255, 1] }, alpha); G.row = -1; drawBatch(); }
    else if (paint.grad) { if (rec) rec.bad = true; if (setGradient(paint, alpha)) { cover(paint, alpha); drawBatch(); } else { gl.clear(gl.STENCIL_BUFFER_BIT); } }
    else { cover(paint, alpha); drawBatch(); }
    drawKind = 'plain';
    gl.disable(gl.STENCIL_TEST);
    stats.stencils++;
  };

  const subsOf = (path) => {
    if (!(path instanceof GlPath)) return path == null || typeof path === 'string' ? P.subs : null;
    const key = P.m.join(',');
    if (path.flatKey !== key) {
      const b = new PathBuilder(); b.m = P.m.slice();
      replay(path.cmds, b);
      path.flat = b.subs; path.flatKey = key; path.strokes = null;
    }
    return path.flat;
  };

  function fill(a, b) {
    if (lost) return;
    const subs = subsOf(a);
    const rule = typeof a === 'string' ? a : b;
    const paint = subs && paintOf(S.fillStyle);
    if (!paint) return;
    prepare();
    let convex = true, count = 0, verts = 0, specks = true, discs = true;
    for (const s of subs) {
      if (s.disc) {                                           // (its points are lazy: WholeTurn)
        count++;
        if (specks && Math.max(Math.abs(s.disc[2]) + Math.abs(s.disc[4]), Math.abs(s.disc[3]) + Math.abs(s.disc[5])) > 3) specks = false;
        continue;
      }
      if (s.pts.length < 6) continue;
      count++; discs = false;
      if (convex && s.convex !== true && !isConvex(s.pts)) convex = false;
      if (specks && !isSpeck(s.pts)) specks = false;
    }
    if (!count) return;
    const fans = (col) => {
      for (const s of subs) {
        const p = s.pts, n = p.length >> 1;
        if (n < 3) continue;
        room((n - 2) * 3);
        for (let i = 1; i < n - 1; i++) { vert(p[0], p[1], col); vert(p[2 * i], p[2 * i + 1], col); vert(p[2 * i + 2], p[2 * i + 3], col); }
        if (col === 0) for (let i = 0; i < n; i++) bboxAdd(p[2 * i], p[2 * i + 1]);
      }
    };
    // WHAT MAY SKIP THE STENCIL: one convex outline, any number of opaque ones (overlap cannot
    // show), and SPECKS -- a star field is forty thousand rects in a few hundred see-through
    // fills, and stencilling each fill is a full-panel covering pass per shade (measured
    // 2026-09-21 on SwiftShader: 247 stencil passes and 146 ms a frame for a resting board).
    // Two specks of one shade overlapping is a pixel or two a touch brighter; nobody can see it.
    if (convex && (count === 1 || paint.opaque || specks)) {
      if (discs) {
        // every outline is a whole circle or ellipse: one quad each, the rim computed per pixel
        setSolid();
        if (paint.grad && !aimGradient(paint)) { /* the two-circle form: the fan below, its own program */ } else {
          const col = paint.grad ? 0xffffffff : packColour(paint.colour);
          for (const s of subs) if (s.disc) discQuad(s.disc[0], s.disc[1], s.disc[2], s.disc[3], s.disc[4], s.disc[5], col);
          G.row = -1;
          return;
        }
      }
      if (paint.grad) {
        setSolid();
        if (aimGradient(paint)) { fans(0xffffffff); G.row = -1; }
        else if (setGradient(paint, 1)) { fans(0xffffffff); drawBatch(); }
      }
      else { setSolid(); fans(packColour(paint.colour)); }
      return;
    }
    // ONE concave outline that does not cross itself is triangles too (earClip); nonzero and
    // even-odd agree on it, so the rule does not matter. Anything else: the stencil.
    if (count === 1) {
      const one = subs.find((s) => s.pts.length >= 6), ears = earClip(one.pts);
      if (ears) {
        const p = one.pts;
        setSolid();
        const aimed = paint.grad ? aimGradient(paint) : true;
        if (aimed) {
          const col = paint.grad ? 0xffffffff : packColour(paint.colour);
          room(ears.length);
          for (let i = 0; i < ears.length; i++) vert(p[2 * ears[i]], p[2 * ears[i] + 1], col);
          G.row = -1;
          return;
        }
      }
    }
    stencilled(fans, paint, 1, rule === 'evenodd');
  }

  // scratch for seam(): a closed outline of up to eight corners
  const seamX = new Float64Array(8), seamY = new Float64Array(8), seamOx = new Float64Array(8), seamOy = new Float64Array(8);
  const seam = (p, hw, col) => {
    let n = 0;
    for (let i = 0; i < p.length; i += 2) {
      if (n && Math.abs(seamX[n - 1] - p[i]) < 1e-9 && Math.abs(seamY[n - 1] - p[i + 1]) < 1e-9) continue;
      seamX[n] = p[i]; seamY[n] = p[i + 1]; n++;
    }
    if (n > 1 && Math.abs(seamX[0] - seamX[n - 1]) < 1e-9 && Math.abs(seamY[0] - seamY[n - 1]) < 1e-9) n--;
    if (n < 3) return false;
    for (let v = 0; v < n; v++) {
      const a = (v + n - 1) % n, b = (v + 1) % n;
      let d0x = seamX[v] - seamX[a], d0y = seamY[v] - seamY[a], d1x = seamX[b] - seamX[v], d1y = seamY[b] - seamY[v];
      const l0 = Math.hypot(d0x, d0y) || 1, l1 = Math.hypot(d1x, d1y) || 1;
      d0x /= l0; d0y /= l0; d1x /= l1; d1y /= l1;
      let mx = -d0y - d1y, my = d0x + d1x;
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) { mx = -d0y; my = d0x; } else { mx /= ml; my /= ml; }
      const cos = Math.max(0.5, Math.abs(mx * -d0y + my * d0x));
      seamOx[v] = (mx * hw) / cos; seamOy[v] = (my * hw) / cos;
    }
    room(n * 6);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = seamX[i], ay = seamY[i], bx = seamX[j], by = seamY[j];
      vert(ax + seamOx[i], ay + seamOy[i], col); vert(bx + seamOx[j], by + seamOy[j], col); vert(bx - seamOx[j], by - seamOy[j], col);
      vert(ax + seamOx[i], ay + seamOy[i], col); vert(bx - seamOx[j], by - seamOy[j], col); vert(ax - seamOx[i], ay - seamOy[i], col);
    }
    return true;
  };
  function stroke(path) {
    if (lost) return;
    const subs = subsOf(path);
    const paint = subs && paintOf(S.strokeStyle);
    if (!paint || !(S.lineWidth > 0)) return;
    const inv = inverse();
    if (!inv) return;
    prepare();
    const m = P.m, k = P.scale();
    // a line thinner than a device pixel: the 2D context fades it; multisampling would break it up
    let w = S.lineWidth, alpha = 1;
    if (w * k < 1) { alpha = Math.max(0.04, w * k); w = 1 / k; }
    let direct = false, col = 0;
    const tri = (x0, y0, x1, y1, x2, y2) => {
      room(3);
      const ax = m[0] * x0 + m[2] * y0 + m[4], ay = m[1] * x0 + m[3] * y0 + m[5];
      const bx = m[0] * x1 + m[2] * y1 + m[4], by = m[1] * x1 + m[3] * y1 + m[5];
      const cx = m[0] * x2 + m[2] * y2 + m[4], cy = m[1] * x2 + m[3] * y2 + m[5];
      vert(ax, ay, col); vert(bx, by, col); vert(cx, cy, col);
      if (!direct) { bboxAdd(ax, ay); bboxAdd(bx, by); bboxAdd(cx, cy); }
    };
    const user = (s) => {
      const p = s.pts, out = new Array(p.length);
      for (let i = 0; i < p.length; i += 2) { out[i] = inv[0] * p[i] + inv[2] * p[i + 1] + inv[4]; out[i + 1] = inv[1] * p[i] + inv[3] * p[i + 1] + inv[5]; }
      return out;
    };
    // a subpath of one point has no line in it and draws nothing (the 2D context drops it too):
    // closePath() leaves one behind every outline. A DOT is moveTo + lineTo to the same place.
    const live = subs.filter((s) => s.pts.length >= 4);
    if (!live.length) return;
    // A RECORDED PATH KEEPS ITS STROKES (operator, 2026-09-21: "then the markets price line cache").
    // The price line is one curve stroked six times a frame -- three glows, three cores -- and the
    // stroker walked its few thousand points, joins and caps again for each, every frame, though
    // the curve only changes when the candles do. The triangles depend on the path, the transform
    // and the pen -- not on the colour -- so they are kept on the path per pen (the glow may change
    // colour every frame and still cost a copy), and dropped when the path is flattened again.
    const kept = (kind, build) => {
      if (!(path instanceof GlPath)) return false;
      const cache = (path.strokes ??= new Map()), key = `${kind}|${w}|${S.lineCap}|${S.lineJoin}|${S.miterLimit}`;
      let geo = cache.get(key);
      if (!geo) {
        const out = [];
        build((x0, y0, x1, y1, x2, y2) => out.push(m[0] * x0 + m[2] * y0 + m[4], m[1] * x0 + m[3] * y0 + m[5], m[0] * x1 + m[2] * y1 + m[4], m[1] * x1 + m[3] * y1 + m[5], m[0] * x2 + m[2] * y2 + m[4], m[1] * x2 + m[3] * y2 + m[5]));
        geo = { xy: new Float32Array(out), x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        for (let i = 0; i < geo.xy.length; i += 2) { const x = geo.xy[i], y = geo.xy[i + 1]; if (x < geo.x0) geo.x0 = x; if (x > geo.x1) geo.x1 = x; if (y < geo.y0) geo.y0 = y; if (y > geo.y1) geo.y1 = y; }
        if (cache.size >= 16) cache.clear();               // an effect that swells the line mints a pen a frame
        cache.set(key, geo);
      }
      const xy = geo.xy, n = xy.length >> 1;
      room(n);
      for (let i = 0; i < n; i++) vert(xy[2 * i], xy[2 * i + 1], col);
      if (!direct && n) { bboxAdd(geo.x0, geo.y0); bboxAdd(geo.x1, geo.y1); }
      return true;
    };
    const full = () => {
      if (kept('full', (t) => { for (const s of live) strokeGeometry(user(s), s.closed, w, S.lineCap, S.lineJoin, S.miterLimit, t, k); })) return;
      for (const s of live) strokeGeometry(user(s), s.closed, w, S.lineCap, S.lineJoin, S.miterLimit, tri, k);
    };
    if (!paint.grad) {
      const one = live.length === 1 ? live[0] : null;
      // WHAT MAY SKIP THE STENCIL: an opaque stroke (overlap cannot show), one segment or one dot
      // (nothing to overlap), and one thin outline drawn as a strip (stripGeometry)
      if (paint.opaque || (one && !one.closed && one.pts.length <= 4)) {
        direct = true; col = packColour(paint.colour, alpha); setSolid(); full();
        return;
      }
      // dots, however many: the pulsar's gas is fifteen thousand zero-length round-capped
      // segments in ten strokes, and a speck overlapping a speck of its own shade does not show
      // ROUND DOTS ARE DISCS: a zero-length round-capped segment is one quad (discQuad), whatever its size
      // (the pulsar's gas draws each dot as a segment a hundredth of a unit long: under a quarter of
      // a pixel it is a dot to any eye, and it is drawn as one)
      const dots = S.lineCap === 'round' && live.every((s) => s.pts.length === 4 && Math.abs(s.pts[0] - s.pts[2]) + Math.abs(s.pts[1] - s.pts[3]) < 0.25);
      if (dots && (paint.opaque || one || w * k <= 6)) {
        const hw = w / 2, c = packColour(paint.colour, alpha);
        setSolid();
        for (const s of live) discQuad((s.pts[0] + s.pts[2]) / 2, (s.pts[1] + s.pts[3]) / 2, m[0] * hw, m[1] * hw, m[2] * hw, m[3] * hw, c);
        return;
      }
      // ...AND WIDE SEE-THROUGH DOTS ARE STILL DISCS (operator, 2026-09-21: "The pulsar winds effect
      // is very slow on webgl"). Past six pixels the dots of one stroke must union, so they go
      // through the stencil -- but they fell into the GENERAL stroker on the way: fifteen thousand
      // discs tessellated chord by chord with half a dozen allocations each, ten buckets a frame.
      // Measured on a 2560x1300 panel: 196 ms of JS a frame against Software's 13. The halo pass of
      // the gas is exactly this case, and only on a large or high-DPI panel, which is why a small
      // test panel never showed it. The shader discards outside the rim, so the same one-quad disc
      // marks the stencil.
      if (dots) {
        const hw = w / 2, r = hw * k + 3;
        // (in one pass while the paint is faint: a disc's soft rim, painted first, keeps the next
        // disc off those pixels, which under a strong paint would draw a faint arc through a blob)
        stencilled((c) => {
          for (const s of live) {
            const cx = (s.pts[0] + s.pts[2]) / 2, cy = (s.pts[1] + s.pts[3]) / 2;
            discQuad(cx, cy, m[0] * hw, m[1] * hw, m[2] * hw, m[3] * hw, c);
            bboxAdd(cx - r, cy - r); bboxAdd(cx + r, cy + r);
          }
        }, paint, alpha, 'union', paint.colour[3] * alpha < 0.35);
        return;
      }
      if (w * k <= 6 && live.every((s) => (s.pts.length === 4 && Math.abs(s.pts[0] - s.pts[2]) + Math.abs(s.pts[1] - s.pts[3]) < 1e-6))) {
        direct = true; col = packColour(paint.colour, alpha); setSolid(); full();
        return;
      }
      // one thin outline as a strip; and HAIRLINES however many (a star's glint is two crossing
      // half-pixel lines, a few hundred stars a frame): where two cross, one pixel doubles up
      if ((one && w * k <= 3) || w * k <= 1.5) {
        direct = true; col = packColour(paint.colour, alpha); setSolid();
        // THE SEAM ROUND A FACE, thousands a frame whenever the board is moving (the black hole has
        // every candle in orbit): a short closed outline under a plain scale. Its strip is built
        // here in device space with no array made and no inverse taken -- stripGeometry's general
        // route (points mapped back to user space, a direction array per corner) was 11% of that
        // frame. Same mitres, same clamp, same triangles.
        if (one && one.closed && one.pts.length <= 16 && !(path instanceof GlPath) && m[1] === 0 && m[2] === 0 && Math.abs(Math.abs(m[0]) - Math.abs(m[3])) < 1e-9 && seam(one.pts, (w * k) / 2, col)) return;
        if (!kept('strip', (t) => { for (const s of live) stripGeometry(user(s), s.closed, w, S.lineCap, t); })) for (const s of live) stripGeometry(user(s), s.closed, w, S.lineCap, tri);
        return;
      }
    }
    // polygons under a per-sample stencil: the one-pass union is exact (paintedOnce)
    stencilled((c) => { col = c; full(); }, paint, alpha, 'union', true);
  }

  // ---- the star field (STAR_VS): instances built once per field, one draw a frame
  let starProg = null; const SU = {}; let starBroken = false;
  const starSets = new Map();                                // the caller's key -> { vao, vbo, n }
  /**
   * field: { key (an object that changes when the stars do), stars: [{ x, y | gr, ga, r, c:[r,g,b], b, f, p, big }],
   *          galaxy, cx, cy, flatten, colourOf(star) }, then the frame's numbers. False when it could not
   *          be drawn here (the caller draws the stars the ordinary way).
   */
  function starField(field, spin, now, bright) {
    if (lost || starBroken) return false;
    try {
      if (!starProg) {
        const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) || 'star shader'); return x; };
        starProg = gl.createProgram();
        gl.attachShader(starProg, sh(gl.VERTEX_SHADER, STAR_VS)); gl.attachShader(starProg, sh(gl.FRAGMENT_SHADER, STAR_FS));
        gl.linkProgram(starProg);
        if (!gl.getProgramParameter(starProg, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(starProg) || 'star link');
        for (const n of ['uView', 'uM', 'uGalaxy', 'uSpin', 'uClock']) SU[n] = gl.getUniformLocation(starProg, n);
      }
      prepare(); drawBatch();
      if (rec) rec.bad = true;
      let set = starSets.get(field.key);
      if (!set) {
        const stars = field.stars, n = stars.length, data = new Float32Array(n * 11);
        for (let i = 0; i < n; i++) {
          const st = stars[i], c = field.colourOf(st), o = i * 11;
          if (field.galaxy) { data[o] = st.gr; data[o + 1] = Math.cos(st.ga); data[o + 2] = Math.sin(st.ga); } else { data[o] = st.x; data[o + 1] = st.y; }
          data[o + 3] = st.r;
          data[o + 4] = c[0] / 255; data[o + 5] = c[1] / 255; data[o + 6] = c[2] / 255; data[o + 7] = st.b;
          data[o + 8] = beatFrequency(st.f); data[o + 9] = st.p; data[o + 10] = st.big ? 0.55 : 0.3;
        }
        set = { vao: gl.createVertexArray(), vbo: gl.createBuffer(), n };
        gl.bindVertexArray(set.vao); gl.bindBuffer(gl.ARRAY_BUFFER, set.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 44, 0); gl.vertexAttribDivisor(0, 1);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 44, 16); gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 44, 32); gl.vertexAttribDivisor(2, 1);
        // a few fields at most are alive (one a board, rebuilt on a resize): the oldest goes
        if (starSets.size >= 4) { const old = starSets.keys().next().value, o = starSets.get(old); gl.deleteBuffer(o.vbo); gl.deleteVertexArray(o.vao); starSets.delete(old); }
        starSets.set(field.key, set);
      } else gl.bindVertexArray(set.vao);
      gl.useProgram(starProg);
      const m = P.m;
      gl.uniform2f(SU.uView, canvas.width, canvas.height);
      gl.uniformMatrix3fv(SU.uM, false, new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]));
      gl.uniform4f(SU.uGalaxy, field.cx || 0, field.cy || 0, field.flatten || 1, field.galaxy ? 1 : 0);
      gl.uniform2f(SU.uSpin, Math.cos(spin), Math.sin(spin));
      gl.uniform2f(SU.uClock, now % STAR_BEAT, bright);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, set.n);
      stats.draws++; stats.stars = set.n;
      // back to the batch's own program and buffers
      gl.useProgram(prog); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      return true;
    } catch (e) {
      starBroken = true;
      try { gl.useProgram(prog); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); hooks.onCompileError?.(`stars: ${String(e?.message ?? e)}`); } catch { /* as above */ }
      return false;
    }
  }

  // ---- PARTICLES THAT LIVE ON THE CARD (2026-09-21; operator: "then the pulsar gpu particles"). The
  // pulsar's wind is 27,000 particles: integrated in JavaScript, turned into 54,000 little paths,
  // and sent up as twelve megabytes of vertices, every frame -- the profile had the GPU waiting on
  // the upload as long as the processor spent making it. Here the STATE stays in two buffers on the
  // card (eight floats a particle), a vertex shader with transform feedback steps it from one into
  // the other, and the same buffer is then drawn as instanced discs. Per frame the processor sends
  // a handful of uniforms. The effect supplies the physics and the look as GLSL:
  //     void simulate(inout vec4 s0, inout vec4 s1, float id, float dt, bool init);
  //     vec4 look(vec4 s0, vec4 s1, int pass, out vec2 centre, out float radius);   // colour NOT premultiplied; radius <= 0: not drawn
  // with whatever uniforms it declares, set each frame from `uniforms` (a number, or 2-4 numbers).
  const particleSystems = new Map(); let particlesBroken = false;
  const PARTICLE_HEAD = `#version 300 es
precision highp float;
// an INTEGER hash (PCG): fract(sin(n) * big) on a float32 has a few bits left by the time n is a
// particle id in the tens of thousands, and the first cut's gas came out in clumps -- thousands of
// particles sharing a handful of lanes and places
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float hash3(float a, float b, float c) { return float(pcg(uint(a) ^ pcg(uint(b) * 31u + uint(c) * 7919u))) / 4294967296.0; }
`;
  function particles(spec) {
    if (lost || particlesBroken) return false;
    try {
      let ps = particleSystems.get(spec.key);
      if (!ps || ps.count !== spec.count || ps.glsl !== spec.glsl) {
        if (ps) freeParticles(ps);
        const compile = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) || 'particle shader'); return x; };
        const link = (vs, fs, varyings) => {
          const pr = gl.createProgram();
          gl.attachShader(pr, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, compile(gl.FRAGMENT_SHADER, fs));
          if (varyings) gl.transformFeedbackVaryings(pr, varyings, gl.INTERLEAVED_ATTRIBS);
          gl.linkProgram(pr);
          if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr) || 'particle link');
          return pr;
        };
        const step = link(`${PARTICLE_HEAD}${spec.glsl}
layout(location=0) in vec4 aS0; layout(location=1) in vec4 aS1;
uniform float uDt; uniform int uInit;
out vec4 vS0; out vec4 vS1;
void main() { vec4 a = aS0, b = aS1; simulate(a, b, float(gl_VertexID), uDt, uInit == 1); vS0 = a; vS1 = b; gl_Position = vec4(0.0); }`,
          '#version 300 es\nprecision lowp float; out vec4 o; void main() { o = vec4(0.0); }', ['vS0', 'vS1']);
        const draw = link(`${PARTICLE_HEAD}${spec.glsl}
layout(location=0) in vec4 aS0; layout(location=1) in vec4 aS1;
uniform vec2 uView; uniform mat3 uM; uniform int uPass; uniform float uScale;
out vec4 vCol; out vec3 vD;
void main() {
  int v = gl_VertexID;
  vec2 q = vec2((v == 1 || v == 2 || v == 4) ? 1.0 : -1.0, (v == 2 || v == 4 || v == 5) ? 1.0 : -1.0);
  vec2 centre; float radius;
  vec4 c = look(aS0, aS1, uPass, centre, radius);
  if (radius <= 0.0 || c.a <= 0.0) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vCol = vec4(0.0); vD = vec3(0.0); return; }
  float rTrue = radius * uScale, rDev = max(rTrue, 0.35);
  c.a *= (rTrue * rTrue) / (rDev * rDev);                  // a dot under a pixel keeps its LIGHT, spread over the pixel
  float k = 1.0 + 1.5 / rDev;
  vec2 p = (uM * vec3(centre, 1.0)).xy + q * k * rDev;
  vCol = vec4(c.rgb * c.a, c.a);
  vD = vec3(q * k, rDev);
  gl_Position = vec4(p.x * 2.0 / uView.x - 1.0, 1.0 - p.y * 2.0 / uView.y, 0.0, 1.0);
}`, `#version 300 es
precision highp float;
in vec4 vCol; in vec3 vD;
layout(location=0) out vec4 o; layout(location=1) out vec4 oE;
void main() {
  float cover = clamp(0.5 + (1.0 - length(vD.xy)) * vD.z, 0.0, 1.0);
  if (cover <= 0.0) discard;
  o = vCol * cover; oE = o;
}`, null);
        const bufs = [0, 1].map(() => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, spec.count * 32, gl.DYNAMIC_COPY); return b; });
        const vaos = bufs.map((b) => {
          const va = gl.createVertexArray(); gl.bindVertexArray(va); gl.bindBuffer(gl.ARRAY_BUFFER, b);
          gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
          gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
          return va;
        });
        const drawVaos = bufs.map((b) => {
          const va = gl.createVertexArray(); gl.bindVertexArray(va); gl.bindBuffer(gl.ARRAY_BUFFER, b);
          gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(0, 1);
          gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(1, 1);
          return va;
        });
        ps = { count: spec.count, glsl: spec.glsl, step, draw, bufs, vaos, drawVaos, at: 0, born: false, locs: new Map(), tf: gl.createTransformFeedback() };
        if (particleSystems.size >= 2) { const old = particleSystems.keys().next().value; freeParticles(particleSystems.get(old)); particleSystems.delete(old); }
        particleSystems.set(spec.key, ps);
      }
      prepare(); drawBatch();
      if (rec) rec.bad = true;
      const setUniforms = (pr) => {
        for (const [name, v] of Object.entries(spec.uniforms || {})) {
          const id = `${pr === ps.step ? 's' : 'd'}:${name}`;
          let loc = ps.locs.get(id);
          if (loc === undefined) { loc = gl.getUniformLocation(pr, name); ps.locs.set(id, loc); }
          if (loc == null) continue;
          if (typeof v === 'number') gl.uniform1f(loc, v); else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]); else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]); else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
        }
      };
      const loc = (pr, name) => { const id = `${pr === ps.step ? 's' : 'd'}:${name}`; let l = ps.locs.get(id); if (l === undefined) { l = gl.getUniformLocation(pr, name); ps.locs.set(id, l); } return l; };
      // step: from bufs[at] into bufs[1 - at]
      const dst = 1 - ps.at;
      gl.useProgram(ps.step); setUniforms(ps.step);
      gl.uniform1f(loc(ps.step, 'uDt'), spec.dt); gl.uniform1i(loc(ps.step, 'uInit'), ps.born ? 0 : 1);
      gl.bindVertexArray(ps.vaos[ps.at]);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, ps.tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, ps.bufs[dst]);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, ps.count); gl.endTransformFeedback();
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      ps.at = dst; ps.born = true;
      // draw: what was just written, one instance a particle, once a pass
      if (spec.draw !== false) {
        const m = P.m;
        gl.useProgram(ps.draw); setUniforms(ps.draw);
        gl.uniform2f(loc(ps.draw, 'uView'), canvas.width, canvas.height);
        gl.uniformMatrix3fv(loc(ps.draw, 'uM'), false, new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]));
        gl.uniform1f(loc(ps.draw, 'uScale'), P.scale());
        gl.bindVertexArray(ps.drawVaos[ps.at]);
        for (let pass = 0; pass < (spec.passes || 1); pass++) { gl.uniform1i(loc(ps.draw, 'uPass'), pass); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, ps.count); stats.draws++; }
      }
      stats.particles = ps.count;
      gl.useProgram(prog); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      return true;
    } catch (e) {
      particlesBroken = true;
      try {
        gl.disable(gl.RASTERIZER_DISCARD); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
        gl.useProgram(prog); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        hooks.onCompileError?.(`particles: ${String(e?.message ?? e)}`);
      } catch { /* as above */ }
      return false;
    }
  }
  function freeParticles(ps) {
    try { for (const b of ps.bufs) gl.deleteBuffer(b); for (const v of [...ps.vaos, ...ps.drawVaos]) gl.deleteVertexArray(v); gl.deleteProgram(ps.step); gl.deleteProgram(ps.draw); gl.deleteTransformFeedback(ps.tf); } catch { /* a dead context */ }
  }

  // ---- images and text
  const textures = new WeakMap();
  const textureOf = (src) => {
    let t = textures.get(src);
    const v = src.__v;
    if (t && v !== undefined && t.v === v && t.w === src.width && t.h === src.height) { gl.bindTexture(gl.TEXTURE_2D, t.tex); return t; }
    if (!t) {
      t = { tex: gl.createTexture(), v: undefined, w: 0, h: 0 };
      textures.set(src, t);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else gl.bindTexture(gl.TEXTURE_2D, t.tex);
    // a source that does not say when it changed (no __v stamp) is uploaded every time it is drawn
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    t.v = v; t.w = src.width; t.h = src.height;
    return t;
  };
  // the quad (x, y, w, h) in user space, textured edge to edge
  const texturedQuad = (x, y, w, h) => {
    const inv = inverse();
    if (!inv || !(w !== 0) || !(h !== 0)) return;
    // device -> user -> the image's own unit square
    const a = inv[0] / w, b = inv[1] / h, c = inv[2] / w, d = inv[3] / h, e = (inv[4] - x) / w, f = (inv[5] - y) / h;
    gl.uniform1i(U.uMode, 3); mode = 9;
    gl.uniformMatrix3fv(U.uInv, false, new Float32Array([a, b, 0, c, d, 0, e, f, 1]));
    gl.uniform1f(U.uAlpha, 1);
    const m = P.m, q = [x, y, x + w, y, x + w, y + h, x, y, x + w, y + h, x, y + h];
    room(6);
    for (let i = 0; i < 12; i += 2) vert(m[0] * q[i] + m[2] * q[i + 1] + m[4], m[1] * q[i] + m[3] * q[i + 1] + m[5], 0xffffffff);
    drawBatch();
  };
  function drawImage(src, x, y, w, h) {
    if (lost || !src || !src.width || !src.height) return;
    if (rec) rec.bad = true;
    prepare(); drawBatch();
    try { textureOf(src); } catch { return; }
    texturedQuad(x, y, w ?? src.width, h ?? src.height);
  }

  const texts = new Map();
  const textSprite = (text, k) => {
    const key = `${S.font}|${k.toFixed(3)}|${S.fillStyle}|${text}`;
    let t = texts.get(key);
    if (t) return t;
    const c2 = scratchCtx();
    if (!c2 || typeof document === 'undefined') return null;
    const font = S.font.replace(/(\d+(?:\.\d+)?)px/, (_, n) => `${(Number(n) * k).toFixed(2)}px`);
    c2.font = font;
    const mt = c2.measureText(text);
    const asc = Math.ceil(mt.actualBoundingBoxAscent ?? 12 * k) + 2, desc = Math.ceil(mt.actualBoundingBoxDescent ?? 4 * k) + 2;
    const left = Math.ceil(mt.actualBoundingBoxLeft ?? 0) + 2, right = Math.ceil(mt.actualBoundingBoxRight ?? mt.width) + 2;
    const cv = document.createElement('canvas'); cv.width = Math.max(1, left + right); cv.height = Math.max(1, asc + desc);
    const c3 = cv.getContext('2d');
    if (!c3) return null;
    c3.font = font; c3.fillStyle = S.fillStyle; c3.textBaseline = 'alphabetic'; c3.textAlign = 'left';
    c3.fillText(text, left, asc);
    cv.__v = 1;
    if (texts.size >= TEXT_CACHE_MAX) { for (const old of texts.values()) { const tx = textures.get(old.cv); if (tx) gl.deleteTexture(tx.tex); } texts.clear(); }
    t = { cv, left, asc, width: mt.width, fasc: mt.fontBoundingBoxAscent ?? asc, fdesc: mt.fontBoundingBoxDescent ?? desc };
    texts.set(key, t);
    return t;
  };
  function fillText(text, x, y) {
    if (lost || typeof S.fillStyle !== 'string') return;
    const k = P.scale(), t = textSprite(String(text), k);
    if (!t) return;
    const align = S.textAlign, base = S.textBaseline;
    let ox = 0, oy = 0;                                       // in raster pixels, from the pen to the text's origin
    if (align === 'center') ox = -t.width / 2; else if (align === 'right' || align === 'end') ox = -t.width;
    if (base === 'middle') oy = (t.fasc - t.fdesc) / 2; else if (base === 'top' || base === 'hanging') oy = t.fasc; else if (base === 'bottom' || base === 'ideographic') oy = -t.fdesc;
    drawImage(t.cv, x + (ox - t.left) / k, y + (oy - t.asc) / k, t.cv.width / k, t.cv.height / k);
  }

  function clearRect(x, y, w, h) {
    if (lost) return;
    prepare(); drawBatch();
    const m = P.m;
    const xs = [x, x + w, x, x + w], ys = [y, y, y + h, y + h];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 4; i++) { const X = m[0] * xs[i] + m[2] * ys[i] + m[4], Y = m[1] * xs[i] + m[3] * ys[i] + m[5]; x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y); }
    gl.clearColor(0, 0, 0, 0);
    if (x0 <= 0 && y0 <= 0 && x1 >= canvas.width && y1 >= canvas.height) { gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT); stats.frames++; return; }
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.floor(x0), Math.floor(canvas.height - y1), Math.ceil(x1 - x0), Math.ceil(y1 - y0));
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
  }

  const ctx = {
    gl2d: true,
    canvas,
    stats,
    get lost() { return lost; },
    // styles
    get fillStyle() { return S.fillStyle; }, set fillStyle(v) { if (typeof v === 'string' || v instanceof GlGradient) S.fillStyle = v; },
    get strokeStyle() { return S.strokeStyle; }, set strokeStyle(v) { if (typeof v === 'string' || v instanceof GlGradient) S.strokeStyle = v; },
    get lineWidth() { return S.lineWidth; }, set lineWidth(v) { if (v > 0 && Number.isFinite(v)) S.lineWidth = v; },
    get lineCap() { return S.lineCap; }, set lineCap(v) { if (v === 'butt' || v === 'round' || v === 'square') S.lineCap = v; },
    get lineJoin() { return S.lineJoin; }, set lineJoin(v) { if (v === 'miter' || v === 'round' || v === 'bevel') S.lineJoin = v; },
    get miterLimit() { return S.miterLimit; }, set miterLimit(v) { if (v > 0 && Number.isFinite(v)) S.miterLimit = v; },
    get font() { return S.font; }, set font(v) { if (typeof v === 'string') S.font = v; },
    get textAlign() { return S.textAlign; }, set textAlign(v) { S.textAlign = v; },
    get textBaseline() { return S.textBaseline; }, set textBaseline(v) { S.textBaseline = v; },
    // transform
    setTransform(a, b, c, d, e, f) { if (typeof a === 'object' && a) P.m = [a.a, a.b, a.c, a.d, a.e, a.f]; else P.m = [a, b, c, d, e, f]; },
    getTransform() { const m = P.m; return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }; },
    resetTransform() { P.m = [1, 0, 0, 1, 0, 0]; },
    transform(a, b, c, d, e, f) { const m = P.m; P.m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]]; },
    translate(x, y) { ctx.transform(1, 0, 0, 1, x, y); },
    scale(x, y) { ctx.transform(x, 0, 0, y, 0, 0); },
    rotate(r) { const c = Math.cos(r), s = Math.sin(r); ctx.transform(c, s, -s, c, 0, 0); },
    save() { stack.push({ S: { ...S }, m: P.m.slice() }); },
    restore() { const t = stack.pop(); if (t) { S = t.S; P.m = t.m; } },
    // paths
    beginPath() { P.reset(); },
    moveTo(x, y) { P.moveTo(x, y); }, lineTo(x, y) { P.lineTo(x, y); }, closePath() { P.closePath(); },
    rect(x, y, w, h) { P.rect(x, y, w, h); },
    arc(x, y, r, a0, a1, ccw) { P.arc(x, y, r, a0, a1, ccw); },
    ellipse(x, y, rx, ry, rot, a0, a1, ccw) { P.ellipse(x, y, rx, ry, rot, a0, a1, ccw); },
    quadraticCurveTo(cx, cy, x, y) { P.quadraticCurveTo(cx, cy, x, y); },
    bezierCurveTo(ax, ay, bx, by, x, y) { P.bezierCurveTo(ax, ay, bx, by, x, y); },
    createPath() { return new GlPath(); },
    fill, stroke, retained, starField, particles,
    fillRect(x, y, w, h) { const keep = P.subs, cur = P.cur; P.subs = []; P.cur = null; P.rect(x, y, w, h); fill(); P.subs = keep; P.cur = cur; },
    clearRect,
    createLinearGradient(x0, y0, x1, y1) { return new GlGradient('linear', [x0, y0, x1, y1]); },
    createRadialGradient(x0, y0, r0, x1, y1, r1) { return new GlGradient('radial', [x0, y0, r0, x1, y1, r1]); },
    drawImage,
    fillText,
    measureText(text) { const c2 = scratchCtx(); if (!c2) return { width: String(text).length * 6 }; c2.font = S.font; return c2.measureText(text); },
    /** Everything batched reaches the GPU. The frame's last call (paintFrame makes it). */
    flush() { if (!lost && prepared) { drawBatch(); if (postLive) finish(); prepared = false; orphans = 0; } },
    /** The finish's strength, 0..1 (0: off, the frame goes straight to the screen). GL only. */
    /** Does what is drawn from here on throw light (the finish's bloom)? True by default; paintFrame
     * switches it off round the cubes, whose colours are data. */
    get emissive() { return emissive === 2; }, set emissive(v) { emissive = v ? 2 : 0; },
    get bloom() { return bloom; }, set bloom(v) { const n = Number(v); bloom = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; },
    /** Give the context back: buffers, textures, the listener. The canvas is the caller's. */
    dispose() {
      canvas?.removeEventListener?.('webglcontextlost', onLost);
      try {
        for (const t of texts.values()) { const tx = textures.get(t.cv); if (tx) gl.deleteTexture(tx.tex); }
        texts.clear();
        for (const ps of particleSystems.values()) freeParticles(ps);
        for (const o of starSets.values()) { gl.deleteBuffer(o.vbo); gl.deleteVertexArray(o.vao); }
        if (starProg) gl.deleteProgram(starProg);
        for (const seg of segments.values()) freeSegment(seg);
        freePost(); if (postProg) gl.deleteProgram(postProg);
        if (rampTex) gl.deleteTexture(rampTex);
        gl.deleteBuffer(vbo); gl.deleteVertexArray(vao); gl.deleteProgram(prog);
        gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
      } catch { /* a dead context has nothing to free */ }
      lost = true;
    },
  };
  return ctx;
}
