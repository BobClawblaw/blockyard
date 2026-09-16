// SCORCHED YARD'S EXPLOSIONS, PAINTED (operator, 2026-09-16: "We have fucking firework and nebula
// effects and you're doing shitty block and sprite explosions?").
//
// The blast used to be tiles -- first spheres, which the engine gives a rim and a glint so a cloud
// of them read as bubbles, then cubes, which are honest but are not an explosion. Meanwhile the
// renderer already knows how to draw a firework: a white core, a shockwave, sparks that curve and
// trail and twinkle, and a nebula of smoke built from flat discs that add up to a soft cloud
// (softStops, because gradients band on this rasteriser). That machinery is what a shell landing
// deserves, so this module draws with it.
//
// Everything here is painted through the BOARD'S OWN PROJECTION: `P(gx, gy, gz)` is the renderer's
// projector, handed to the overlay hook in details3d, so a crater at cell 40,12 and the fire over
// it are the same place on the screen. `U` is how many pixels a cell is, across and up, which is
// how a radius in cells becomes a radius in pixels.
//
// Nothing in here reads the DOM or the clock: the caller passes `now`, so a test can hold any
// moment of any blast and a replay is exact.

/** A line of the spark's recent path, fading from its head. */
function trail(ctx, pts, colour, w) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = 1 - i / pts.length;
    ctx.strokeStyle = colour(a);
    ctx.lineWidth = Math.max(0.6, w * a);
    ctx.beginPath();
    ctx.moveTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
    ctx.stroke();
  }
}

// HOW MANY NESTED DISCS A SOFT FILL GETS (operator, 2026-09-16: "performance freezing and jittering
// when the cubes are being blown up"). softStops picks about one ring a pixel of radius when it is not
// told, up to 220 -- right for a still sky, ruinous for a nuke, whose smoke is fifty-odd large puffs
// every frame: thousands of big translucent fills, measured at 50 ms frames. Smoke that is moving,
// thinning and overlapping its neighbours shows no steps at a dozen rings; a fireball's core, which
// is brighter and briefer, gets a few more.
export const RINGS = Object.freeze({ core: 36, glow: 18, smoke: 12 });
const disc = (ctx, x, y, r, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(x, y, Math.max(0.4, r), 0, Math.PI * 2); ctx.fill(); };
const h01 = (n) => { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };

/**
 * THE FIREBALL, THE SHOCKWAVE, THE SPARKS AND THE SMOKE.
 *
 *   0.00-0.25  the core: white, then gold, then orange, growing
 *   0.00-0.50  the shockwave, an ellipse racing out and thinning (a circle on the ground is an
 *              ellipse on an oblique board, so it is drawn from the two cell sizes)
 *   0.00-1.00  sparks on ballistic paths, each a curved trail of its last positions, twinkling
 *   0.05-1.00  the smoke: a nebula of soft lumps leaving the burst, rising, drifting downwind,
 *              growing and thinning -- the fireworks' own dissipation, in dirt colours
 */
export function paintBlasts(ctx, P, U, blasts, now, { wind = 0, softStops, ms = 650, smokeMs = 2400 } = {}) {
  const lw = ctx.lineWidth;
  for (const b of blasts) {
    const age = now - b.t0;
    const t = Math.min(1, Math.max(0, age / ms));
    const R = Math.max(2, b.r * U.x);
    const c = P(b.x, b.y, 1.2);
    const riot = !!b.riot;

    if (t < 1) {
      // --- the core
      const fade = t < 0.22 ? 1 : Math.max(0, 1 - (t - 0.22) / 0.78);
      const fr = R * (0.5 + 0.9 * t);
      const core = riot
        ? [[0, `rgba(240,252,255,${(0.95 * fade).toFixed(3)})`], [0.2, `rgba(160,220,255,${(0.85 * fade).toFixed(3)})`], [0.5, `rgba(80,160,230,${(0.45 * fade).toFixed(3)})`], [1, 'rgba(40,90,150,0)']]
        : [[0, `rgba(255,255,240,${(0.98 * fade).toFixed(3)})`], [0.14, `rgba(255,236,170,${(0.92 * fade).toFixed(3)})`], [0.36, `rgba(255,158,64,${(0.66 * fade).toFixed(3)})`], [0.66, `rgba(196,66,26,${(0.3 * fade).toFixed(3)})`], [1, 'rgba(120,30,12,0)']];
      softStops(ctx, c.x, c.y, fr * 1.9, core, RINGS.core);

      // --- the shockwave
      // it belongs to the crater, not to the panel: a ring that races three radii out crosses the
      // whole field and reads as a stray circle drawn over the picture
      if (t < 0.38) {
        const k = t / 0.38;
        const rr = b.r * (0.5 + 1.3 * k);
        const gone = (1 - k) * (1 - k);
        ctx.strokeStyle = riot ? `rgba(200,240,255,${(0.7 * gone).toFixed(3)})` : `rgba(255,236,196,${(0.75 * gone).toFixed(3)})`;
        ctx.lineWidth = Math.max(lw, U.x * 0.3 * (1 - k));
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, rr * U.x, Math.max(1, rr * U.y), 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // --- the sparks: ballistic in cells, drawn as curved trails
      // NOT A STARBURST OF RAYS: every spark leaving the centre at the same speed down the same
      // straight line draws a sun, not an explosion. Each one gets its own speed, its own weight
      // and a curl across its flight, and the slow ones stay near the crater where the fire is.
      const n = Math.min(80, Math.round(16 + b.r * 5));
      for (let i = 0; i < n; i++) {
        const H = (k) => h01(b.id * 97 + i * 13 + k);
        const a = (i / n) * Math.PI * 2 + H(1) * 0.9;
        const slow = H(5) * H(5);                                   // most are slow, a few fly
        const sp = b.r * (0.7 + 2.2 * slow);
        const curl = (H(6) - 0.5) * 1.6;
        const drop = 5 + H(3) * 9;
        const at = (u) => {
          const aa = a + curl * u;
          const x = b.x + Math.cos(aa) * sp * u;
          const y = b.y + Math.sin(aa) * sp * u * 0.85 - drop * u * u;
          return P(x, y, 1.2);
        };
        const fadeS = Math.max(0, 1 - t * (0.7 + H(7) * 0.6));
        if (fadeS <= 0.02) continue;
        const twinkle = 0.55 + 0.45 * Math.sin(now / 42 + i * 2.1);
        const pts = [];
        const step = 0.02 + H(2) * 0.03;
        for (let k = 0; k <= 5; k++) pts.push(at(Math.max(0, t - k * step)));
        const warm = H(4) > 0.55;
        trail(ctx, pts, (al) => (riot
          ? `rgba(170,225,255,${(0.55 * al * fadeS).toFixed(3)})`
          : warm ? `rgba(255,190,90,${(0.6 * al * fadeS).toFixed(3)})` : `rgba(255,120,50,${(0.5 * al * fadeS).toFixed(3)})`), U.x * 0.2);
        const head = pts[0];
        disc(ctx, head.x, head.y, U.x * 0.075 * (0.6 + 0.6 * twinkle) * fadeS, riot ? `rgba(235,250,255,${(0.9 * fadeS).toFixed(3)})` : `rgba(255,246,214,${(0.9 * fadeS * twinkle).toFixed(3)})`);
      }
    }

    // --- the smoke, a nebula in dirt colours
    if (!riot && b.r >= 1.2 && age > 60 && age < smokeMs) {
      const u = age / smokeMs;
      const lumps = Math.min(26, 8 + Math.round(b.r * 2.2));
      for (let i = 0; i < lumps; i++) {
        const H = (k) => h01(b.id * 31 + i * 7 + k);
        const life = 0.72 + H(5) * 0.28;
        if (u > life) continue;
        const uu = u / life;
        const ang = Math.PI * (0.1 + 0.8 * H(1));
        const out = b.r * (0.5 + 1.4 * H(2)) * Math.sqrt(uu);
        const x = b.x + Math.cos(ang) * out * 0.8 + wind * 0.3 * (age / 1000);
        const y = b.y + Math.sin(ang) * out + 0.4 + uu * b.r * 0.5;
        const p = P(x, y, 1.2);
        const rr = U.x * b.r * (0.22 + 0.5 * uu) * (0.6 + H(3) * 0.8);
        const dark = 1 - 0.45 * uu;
        const al = 0.42 * (1 - uu) * (0.7 + H(4) * 0.5);
        const g0 = Math.round(126 * dark), g1 = Math.round(96 * dark);
        // two offset discs per lump, so a cloud is not a row of circles
        softStops(ctx, p.x, p.y, rr, [[0, `rgba(${g0 + 24},${g0 + 18},${g0 + 12},${al.toFixed(3)})`], [0.55, `rgba(${g1},${g1 - 4},${g1 - 10},${(al * 0.55).toFixed(3)})`], [1, `rgba(${g1},${g1},${g1},0)`]], RINGS.smoke);
        softStops(ctx, p.x + rr * 0.45, p.y - rr * 0.3, rr * 0.7, [[0, `rgba(${g0 + 12},${g0 + 8},${g0},${(al * 0.7).toFixed(3)})`], [1, `rgba(${g1},${g1},${g1},0)`]], RINGS.smoke);
      }
    }
  }
  ctx.lineWidth = lw;
}

/** A tank going up: a white flash, a burst of sparks in its own colour, and a puff of smoke. */
export function paintDeaths(ctx, P, U, deaths, now, { softStops, ms = 1100 } = {}) {
  const lw = ctx.lineWidth;
  for (const d of deaths) {
    const t = Math.min(1, Math.max(0, (now - d.t0) / ms));
    if (t >= 1) continue;
    const c = P(d.x, d.y, 1.2);
    const fade = 1 - t;
    const col = String(d.colour || '#ffd27a').replace('#', '');
    const rgb = [0, 2, 4].map((i) => parseInt(col.slice(i, i + 2), 16) || 200).join(',');
    softStops(ctx, c.x, c.y, U.x * 4.5 * (0.5 + t), [[0, `rgba(255,255,245,${(0.9 * fade * fade).toFixed(3)})`], [0.25, `rgba(${rgb},${(0.6 * fade).toFixed(3)})`], [1, `rgba(${rgb},0)`]], RINGS.core);
    for (let i = 0; i < 34; i++) {
      const H = (k) => h01(d.id * 53 + i * 11 + k);
      const a = (i / 34) * Math.PI * 2 + H(1);
      const sp = 3 + H(2) * 7;
      const at = (u) => P(d.x + Math.cos(a) * sp * u, d.y + Math.sin(a) * sp * u * 0.9 - 9 * u * u, 1.2);
      const pts = [];
      for (let k = 0; k <= 4; k++) pts.push(at(Math.max(0, t - k * 0.04)));
      trail(ctx, pts, (al) => `rgba(${rgb},${(0.7 * al * fade).toFixed(3)})`, U.x * 0.18);
      const head = pts[0];
      disc(ctx, head.x, head.y, U.x * 0.11 * fade, `rgba(255,250,230,${(0.85 * fade).toFixed(3)})`);
    }
  }
  ctx.lineWidth = lw;
}

/** Where fallen dirt lands: a low puff that spreads and settles. */
export function paintDust(ctx, P, U, dusts, now, { softStops, ms = 700 } = {}) {
  for (const d of dusts) {
    const t = Math.min(1, Math.max(0, (now - d.t0) / ms));
    if (t >= 1) continue;
    for (let i = 0; i < 4; i++) {
      const H = (k) => h01(d.id * 17 + i * 5 + k);
      const p = P(d.x + (H(1) - 0.5) * 2.2, d.y + 0.4 + t * 1.2 + H(2) * 0.6, 1.2);
      const r = U.x * (0.5 + 1.5 * t) * (0.6 + H(3) * 0.7);
      const al = 0.34 * (1 - t);
      softStops(ctx, p.x, p.y, r, [[0, `rgba(196,172,132,${al.toFixed(3)})`], [0.6, `rgba(150,130,100,${(al * 0.5).toFixed(3)})`], [1, 'rgba(140,122,94,0)']], RINGS.smoke);
    }
  }
}

/**
 * THE AIM GAUGE (operator, 2026-09-16: "seeing the turret moving on the tank is still not clear
 * and intuitive ... a simple way of visualizing the current angle").
 *
 * A protractor over the tank whose turn it is: a half-circle of ticks every 15 degrees with 0, 45,
 * 90, 135 and 180 written in, a bright needle along the current angle whose LENGTH is the power,
 * and the two numbers at the needle's tip. It is the whole of the aim in one picture: where the
 * barrel points, how hard, and how far from the round numbers you are.
 */
export function paintAim(ctx, P, U, { x, y, angle, power, colour = '#ffb347', show = true, dim = false } = {}) {
  if (!show) return;
  const lw = ctx.lineWidth;
  const o = P(x, y + 0.9, 1.2);
  const rad = U.x * 4.2;
  const a = (angle * Math.PI) / 180;
  const on = dim ? 0.35 : 1;
  // the arc
  ctx.strokeStyle = `rgba(226,232,240,${(0.3 * on).toFixed(3)})`;
  ctx.lineWidth = Math.max(lw, U.x * 0.05);
  ctx.beginPath();
  ctx.ellipse(o.x, o.y, rad, rad * (U.y / U.x), 0, Math.PI, 2 * Math.PI);
  ctx.stroke();
  // the ticks
  for (let deg = 0; deg <= 180; deg += 15) {
    const ar = (deg * Math.PI) / 180;
    const big = deg % 45 === 0;
    const r0 = rad * (big ? 0.86 : 0.93), r1 = rad * 1.04;
    const sx = Math.cos(ar), sy = Math.sin(ar) * (U.y / U.x);
    ctx.strokeStyle = `rgba(226,232,240,${((big ? 0.55 : 0.3) * on).toFixed(3)})`;
    ctx.lineWidth = Math.max(lw, U.x * (big ? 0.07 : 0.04));
    ctx.beginPath();
    ctx.moveTo(o.x + sx * r0, o.y - sy * r0);
    ctx.lineTo(o.x + sx * r1, o.y - sy * r1);
    ctx.stroke();
  }
  // the needle: its length is the power
  const len = rad * (0.45 + 0.75 * Math.min(1, Math.max(0, power / 1000)));
  const tipX = o.x + Math.cos(a) * len, tipY = o.y - Math.sin(a) * len * (U.y / U.x);
  ctx.strokeStyle = `rgba(20,24,32,${(0.55 * on).toFixed(3)})`;
  ctx.lineWidth = Math.max(lw, U.x * 0.3);
  ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(tipX, tipY); ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(lw, U.x * 0.16);
  ctx.beginPath(); ctx.moveTo(o.x, o.y); ctx.lineTo(tipX, tipY); ctx.stroke();
  disc(ctx, tipX, tipY, U.x * 0.22, 'rgba(255,250,235,0.95)');
  disc(ctx, o.x, o.y, U.x * 0.16, colour);
  // the numbers, at the tip, on the side the needle leans away from
  const label = `${Math.round(angle)}°  ${Math.round(power)}`;
  ctx.font = `${Math.max(8, Math.round(U.x * 0.7))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = angle > 90 ? 'right' : 'left';
  ctx.textBaseline = 'bottom';
  const off = (angle > 90 ? -1 : 1) * U.x * 0.35;
  ctx.fillStyle = 'rgba(12,16,22,0.72)';
  ctx.fillText(label, tipX + off + 1, tipY - U.x * 0.35 + 1);
  ctx.fillStyle = 'rgba(245,249,255,0.96)';
  ctx.fillText(label, tipX + off, tipY - U.x * 0.35);
  ctx.textAlign = 'left';
  ctx.lineWidth = lw;
}

/**
 * CHEAT MODE (operator, 2026-09-16: "a 'Cheat Mode' enable/disable where it plots the firing
 * solution accounting for wind and power in realtime, so the player can see the arcs adjusting as
 * the target location shifts").
 *
 * The shell's own path, under the round's wind and the game's gravity, recomputed every time the
 * aim moves and clipped where it would meet the dirt: dim beads along the flight, brighter toward
 * the end, and a ring on the ground where it lands. It is the rules' own arithmetic, not an
 * approximation of it, so what it draws is what the shot does.
 */
export function paintSolution(ctx, P, U, pts, { colour = '255,216,120', impact = null } = {}) {
  if (!pts || pts.length < 2) return;
  const step = Math.max(1, Math.round(pts.length / 90));
  for (let i = 0; i < pts.length; i += step) {
    const k = i / pts.length;
    const p = P(pts[i].x, pts[i].y, 1.2);
    const r = U.x * (0.07 + 0.06 * k);
    disc(ctx, p.x, p.y, r, `rgba(${colour},${(0.2 + 0.5 * k).toFixed(3)})`);
  }
  if (!impact) return;
  const c = P(impact.x, impact.y, 1.2);
  const lw = ctx.lineWidth;
  ctx.strokeStyle = `rgba(${colour},0.85)`;
  ctx.lineWidth = Math.max(1.2, U.x * 0.1);
  ctx.beginPath();
  ctx.ellipse(c.x, c.y, U.x * 0.75, Math.max(1, U.y * 0.75), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(c.x - U.x * 0.42, c.y);
  ctx.lineTo(c.x + U.x * 0.42, c.y);
  ctx.moveTo(c.x, c.y - U.y * 0.42);
  ctx.lineTo(c.x, c.y + U.y * 0.42);
  ctx.stroke();
  ctx.lineWidth = lw;
}

/**
 * THE SHELLS IN FLIGHT (operator, 2026-09-16: "Everything is the same white dot effect for the
 * shot", then "I said I wanted variance across all shot types"). Over each shell's ball: a glow in
 * the weapon's colour, a trail in the weapon's manner -- at the weapon's own length, count, width
 * and colour (scorched.js SHELL_LOOKS, one entry per weapon) -- and a ring for the heavy ones.
 * The trail is the last stretch of the shell's own path, which the rules keep for the trace.
 *
 *   flame    exhaust: hot beads, `len` of them, in `col`
 *   radio    a nuke: a pulsing glow (`width` scales it) and `count` falling sparks
 *   comet    a tapering tail, `len` long and `width` wide, in the glow colour
 *   rainbow  the hue runs round the wheel along the trail, `spin` times as fast for a bomblet
 *   dash     a thin dotted line, `len` long, and no glow -- the point of a tracer
 *   smoke    grey puffs shed along the path
 *   sparks   `count` sparks thrown behind, for the rollers
 *   wisp     pale soft wisps, `len` of them
 *   clods    `count` lumps of earth shed behind
 *   drip     droplets falling from a shell of liquid dirt
 *   fire     a flickering flame tail `len` long in `col`, and dripping embers
 *   drill    `count` spinning arms of glint, at `spin`
 */
const hsl = (h, sat, l, a) => `hsla(${Math.round(h)},${sat}%,${l}%,${a.toFixed(3)})`;
const rgbaOf = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
export function paintShells(ctx, P, U, shells, now, { softStops, looks } = {}) {
  const lw = ctx.lineWidth;
  shells.forEach((s, idx) => {
    const look = looks(s.weapon);
    const c = P(s.x, s.y, 1.2);
    const tail = (s.path ?? []).slice(-Math.max(2, look.len));
    const pts = tail.map((q) => P(q.x, q.y, 1.2));
    const n = pts.length;
    const g = look.glow;
    if (g) {
      const pulse = look.trail === 'radio' ? 0.75 + 0.25 * Math.sin(now / 90 + idx) : 1;
      const reach = U.x * look.size * (2.6 + (look.trail === 'radio' ? 1.4 * look.width : 0)) * pulse;
      softStops(ctx, c.x, c.y, reach, [[0, rgbaOf(g, 0.55)], [0.35, rgbaOf(g, 0.22)], [1, rgbaOf(g, 0)]], RINGS.glow);
    }
    // the ring of the heavy ones: a thin bright hoop round the ball, turning with the flight
    if (look.ring) {
      ctx.strokeStyle = rgbaOf(look.ring, 0.85);
      ctx.lineWidth = Math.max(1, U.x * 0.09);
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, U.x * look.size * 0.95, U.y * look.size * (0.55 + 0.4 * Math.abs(Math.sin(now / 240 + idx))), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (n < 2) return;
    ctx.lineCap = 'round';
    const col = look.col ?? g ?? [255, 255, 255];
    switch (look.trail) {
      case 'flame':
        for (let i = 0; i < n; i++) { const k = (i + 1) / n; disc(ctx, pts[i].x, pts[i].y, U.x * 0.16 * (0.4 + k) * (0.8 + look.size * 0.4), `rgba(${col[0]},${Math.round(col[1] * (0.7 + 0.3 * k))},${col[2]},${(0.2 + 0.55 * k).toFixed(3)})`); }
        break;
      case 'radio':
        for (let i = 0; i < look.count; i++) { const h = h01(idx * 31 + i * 7 + Math.floor(now / 120)); const q = pts[Math.max(0, n - 1 - Math.floor(h * (n - 1)))]; disc(ctx, q.x + (h01(i * 13 + idx) - 0.5) * U.x * 1.8 * look.size, q.y + h * U.y * 1.6, U.x * 0.11 * (0.8 + look.size * 0.5), rgbaOf(g, 0.4 + 0.5 * h)); }
        break;
      case 'comet':
        for (let i = 0; i < n - 1; i++) { const k = (i + 1) / n; ctx.strokeStyle = rgbaOf(g, 0.08 + 0.55 * k * k); ctx.lineWidth = Math.max(0.6, U.x * look.width * 1.2 * k); ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[i + 1].x, pts[i + 1].y); ctx.stroke(); }
        break;
      case 'rainbow': {
        const rate = now / 4 * look.spin;
        for (let i = 0; i < n - 1; i++) { const k = (i + 1) / n; ctx.strokeStyle = hsl((rate + i * (360 / n)) % 360, 100, 60, 0.15 + 0.6 * k); ctx.lineWidth = Math.max(0.6, U.x * look.width * k); ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[i + 1].x, pts[i + 1].y); ctx.stroke(); }
        softStops(ctx, c.x, c.y, U.x * look.size * 2.4, [[0, hsl(rate % 360, 100, 70, 0.5)], [1, hsl(rate % 360, 100, 70, 0)]], RINGS.glow);
        break;
      }
      case 'dash':
        for (let i = 0; i < n; i += 2) disc(ctx, pts[i].x, pts[i].y, U.x * 0.07, 'rgba(200,206,216,0.55)');
        break;
      case 'smoke':
        for (let i = 0; i < n; i += 2) { const k = (i + 1) / n; softStops(ctx, pts[i].x + (h01(i + idx) - 0.5) * U.x * 0.4, pts[i].y - (1 - k) * U.y * 0.6, U.x * (0.25 + 0.45 * (1 - k)), [[0, `rgba(170,176,186,${(0.12 + 0.2 * k).toFixed(3)})`], [1, 'rgba(170,176,186,0)']], 6); }
        break;
      case 'sparks':
        for (let i = 0; i < look.count; i++) { const h = h01(idx * 17 + i * 5 + Math.floor(now / 60)); const q = pts[n - 1]; disc(ctx, q.x - (h * U.x * 2 * look.size) * Math.sign(s.vx || 1), q.y - h01(i + idx) * U.y * 0.9, U.x * 0.07, `rgba(255,${Math.round(180 + 60 * h)},120,${(0.9 - h * 0.6).toFixed(3)})`); }
        break;
      case 'wisp':
        for (let i = 0; i < n; i++) { const k = (i + 1) / n; softStops(ctx, pts[i].x, pts[i].y, U.x * 0.5 * look.size * 1.4 * (1 - k * 0.5), [[0, rgbaOf(g, 0.3 * k)], [1, rgbaOf(g, 0)]], 6); }
        break;
      case 'clods':
        for (let i = 0; i < look.count; i++) { const h = h01(idx * 23 + i * 9 + Math.floor(now / 150)); const q = pts[Math.max(0, n - 1 - i)]; ctx.fillStyle = `rgba(${140 + Math.round(40 * h)},${95 + Math.round(30 * h)},50,${(0.5 + 0.4 * h).toFixed(3)})`; const sz = U.x * (0.12 + 0.1 * look.size); ctx.fillRect(q.x + (h - 0.5) * U.x * look.size * 1.4, q.y + h * U.y * 0.7, sz, sz); }
        break;
      case 'drip':
        for (let i = 0; i < look.count; i++) { const h = h01(idx * 19 + i * 11 + Math.floor(now / 90)); const q = pts[Math.max(0, n - 1 - i)]; disc(ctx, q.x + (h - 0.5) * U.x * 0.6, q.y + h * U.y * 1.8, U.x * (0.06 + 0.05 * (1 - h)), `rgba(120,85,45,${(0.9 - 0.6 * h).toFixed(3)})`); }
        break;
      case 'fire':
        for (let i = 0; i < n; i++) { const k = (i + 1) / n; const fl = 0.7 + 0.3 * Math.sin(now / 35 + i); disc(ctx, pts[i].x + (h01(i + Math.floor(now / 50)) - 0.5) * U.x * 0.4, pts[i].y, U.x * 0.2 * (0.3 + k) * fl * (0.8 + look.size * 0.5), `rgba(${col[0]},${Math.round(col[1] * (0.6 + 0.4 * k))},${col[2]},${(0.3 + 0.6 * k).toFixed(3)})`); }
        for (let i = 0; i < 3; i++) { const h = h01(idx * 7 + i * 3 + Math.floor(now / 100)); disc(ctx, c.x + (h - 0.5) * U.x * 1.2, c.y + h * U.y * 1.6, U.x * 0.08, rgbaOf(col, 0.8 - h * 0.5)); }
        break;
      case 'drill': {
        const a = now / 60 * look.spin + idx;
        ctx.strokeStyle = rgbaOf(g ?? [255, 220, 170], 0.85); ctx.lineWidth = Math.max(1, U.x * 0.1);
        for (let i = 0; i < look.count; i++) { const ang = a + i * Math.PI / look.count; const r = U.x * look.size * 1.1; ctx.beginPath(); ctx.moveTo(c.x - Math.cos(ang) * r, c.y - Math.sin(ang) * r); ctx.lineTo(c.x + Math.cos(ang) * r, c.y + Math.sin(ang) * r); ctx.stroke(); }
        break;
      }
      default: break;
    }
  });
  ctx.lineWidth = lw;
}
