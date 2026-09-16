// SCORCHED YARD'S AIR, SEEN THROUGH (the sky's ripple). The air itself is simulated in
// scorchedair.js and shown by the flow lines it carries; this module keeps the two small pieces
// that sit beside it: the faint refraction of the sky behind the moving air, and a reading of how
// bright that sky is, which the flow lines use to hold their contrast by day.
//
// (Four earlier wind pictures lived here -- marching particles, dashed currents, a plasma wash and
// bowing bands -- each told where to be at a moment rather than carried by anything. They are gone:
// docs/PLAN-SCORCHED-YARD.md and the changelog keep what was learned from each.)

/**
 * AIR YOU SEE BY WHAT IT DOES (operator, 2026-09-16, with a night capture: "Looks too much like
 * shooting stars instead of air movement. Is there some sort of more impressive ripple or bowing
 * effect we might be able to simulate air as fluid dynamics?").
 *
 * Every streak we drew had a bright head and a fading tail, which is precisely what a meteor looks
 * like, so on a starry sky each one read as a meteor. Air itself is invisible: what you see is the
 * world behind it bending. So the wind now REFRACTS the sky. The sky canvas is copied onto the wind
 * plane in narrow columns, each lifted or lowered by a travelling wave, so the stars, the moon and
 * the clouds bow gently in a ripple that rolls downwind at the wind's speed. It sits under the land,
 * so only the air ripples, never the hills. Nothing is drawn at all in still air.
 *
 * The phase is a SIGNED distance the air has travelled, integrated by the caller from the eased
 * wind, so the ripple only ever moves the way the wind blows and a change of wind bends it round
 * without a jump.
 */
export function rippleOffset(x, travel, wind, h) {
  const strength = Math.min(1, Math.abs(wind ?? 0) / 10);
  if (strength < 0.03) return 0;
  const A = h * (0.0015 + 0.005 * strength);            // a sway, not a bob: about four pixels in a gale
  const u = x - travel;
  const gust = 0.65 + 0.35 * Math.sin(u * 0.0021 + 0.7);  // a slow swell in the swell
  return A * gust * (Math.sin(u * 0.0118) * 0.7 + Math.sin(u * 0.0263 + 1.9) * 0.3);
}

/**
 * Copy the sky across the wind plane, column by column, each shifted by the ripple. `src` is the
 * sky canvas and `map` how the wind plane lies over it: { sx, sy, scale } in the sky's pixels.
 * Columns overlap by a pixel so no seam shows; the source is overscanned top and bottom so a lifted
 * column never uncovers an edge.
 */
export function paintRipple(ctx, src, map, w, h, travel, wind, col = 6) {
  const strength = Math.min(1, Math.abs(wind ?? 0) / 10);
  if (!src || strength < 0.03 || typeof ctx.drawImage !== 'function') return 0;
  const pad = Math.ceil(h * 0.012) + 2;
  let n = 0;
  for (let x = 0; x < w; x += col) {
    const dy = rippleOffset(x + col / 2, travel, wind, h);
    const sx = map.sx + x * map.scale, sy = map.sy + (-pad) * map.scale;
    const sw = (col + 1) * map.scale, sh = (h + pad * 2) * map.scale;
    ctx.drawImage(src, sx, sy, sw, sh, x, -pad + dy, col + 1, h + pad * 2);
    n += 1;
  }
  return n;
}

/**
 * How light a sky canvas is, 0 to 1, from a coarse sample of its upper half. Cheap enough to take
 * every second or two: the sky changes its light over minutes, not frames.
 */
export function skyBrightness(sky) {
  try {
    const cx = sky?.getContext?.('2d', { willReadFrequently: true });
    if (!cx || !sky.width || !sky.height) return 0;
    const d = cx.getImageData(0, 0, sky.width, Math.max(1, Math.round(sky.height * 0.5))).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 97) { sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n += 1; }
    return n ? Math.max(0, Math.min(1, (sum / n - 0.12) / 0.45)) : 0;
  } catch { return 0; }
}
