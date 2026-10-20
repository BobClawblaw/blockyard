// THE RIBBON READS AT A DISTANCE (operator, 2026-10-20: "we need a better day theme for the water strip ... The light
// background makes it too difficult to see at a distance", then the same day, second pass: "still too bright during the
// day on some displays"). Every .wx-sky-* background in public/css/app.css must keep the ribbon's text legible wherever
// text actually sits: on the bare sky (temperature, conditions, facts, hours) and on the day tiles (weekday, icon,
// chance of rain, high and low), including the "today" tile and a wet tile.
//
// This file parses the sheet -- the sky's linear gradient and its radial sun/moon glows, the .wx-glow overlay on top of
// them, and the tiles' own fills -- and measures the WCAG contrast of the text colours against the composited result
// across the whole strip. Pure maths, no browser: it runs under `npm test` like any other test file.
//
// Two rules learned the hard way and encoded here:
//   1. Measure what is painted under the text, not just the sky. The white .wx-glow radial sat exactly under the
//      temperature, and the tiles' white fills sat under the smallest figures; both made the strip brighter than the
//      sky the old test measured.
//   2. Keep real headroom. A kiosk panel runs bright, and cheap panels wash dark detail; 4.5:1 (WCAG AA) is the floor
//      for body text on a good screen, so the ribbon holds 5:1 for anything it draws text on, and 4.5:1 for the tinted
//      high/low colours.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const css = fs.readFileSync(new URL('public/css/app.css', root), 'utf8');

// The ribbon's own colours and overlays, read back from the CSS so the test cannot drift from the sheet it checks.
const TEXT = css.match(/\.wx \{[^}]*color: (#[0-9a-f]{6})/i)[1];
const GLOW = css.match(/\.wx-glow \{([^}]*)\}/s)[1];
const TILE = css.match(/\.wx-day \{([^}]*)\}/s)[1];
const TODAY = css.match(/\.wx-day\.today \{([^}]*)\}/s)[1];
const WET = css.match(/\.wx-slim \.wx-day\.wet \{([^}]*)\}/s)[1];
const HI = css.match(/\.wx-day \.wx-hl b \{ color: (#[0-9a-f]{6})/)[1];
const LO = css.match(/\.wx-day \.wx-hl i \{ color: (#[0-9a-f]{6})/)[1];

const hex = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const rgba = (s) => { const v = s.match(/-?[\d.]+/g).map(Number); return { c: v.slice(0, 3), a: v[3] ?? 1 }; };
const lum = ([r, g, b]) => [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
  .reduce((a, v, i) => a + [0.2126, 0.7152, 0.0722][i] * v, 0);
const contrast = (c1, c2) => { const l1 = lum(c1), l2 = lum(c2); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
const over = (base, c, a) => base.map((v, i) => Math.round(v * (1 - a) + c[i] * a));

/** Split a CSS value on top-level commas (rgba(...) and gradient() keep their own commas). */
function splitTop(s) {
  const out = []; let d = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Parse one linear-gradient layer's stops into a function of x in [0,1] (unspecified stops space out evenly).
 *  Stops may be hex, rgba(...) or `transparent`; alpha interpolates alongside the colour, as CSS paints it. */
function linearSampler(layer) {
  const parts = splitTop(layer.slice(layer.indexOf('(') + 1, layer.lastIndexOf(')'))).slice(1); // drop the angle
  const stops = parts.map((p) => {
    const bare = p.replace(/\s+in\s+oklab\([^)]*\)/, ''); // "in oklab" interpolation does not move legibility
    const m = /([\d.]+)%$/.exec(bare);
    const col = (m ? bare.slice(0, m.index) : bare).trim();
    let c, a = 1;
    if (/^rgba?\(/i.test(col)) ({ c, a } = rgba(col));
    else if (/^transparent$/i.test(col)) { c = [0, 0, 0]; a = 0; }
    else c = hex(col);
    return { t: m ? Number(m[1]) / 100 : null, c, a };
  });
  stops.forEach((s, i) => {
    if (s.t != null) return;
    const prev = stops.slice(0, i).map((q, j) => [j, q.t]).filter(([, t]) => t != null).pop();
    const next = stops.slice(i + 1).map((q, j) => [j + i + 1, q.t]).filter(([, t]) => t != null)[0];
    s.t = prev ? prev[1] + (next ? (next[1] - prev[1]) * (i - prev[0]) / (next[0] - prev[0]) : 0) : 0;
  });
  return (x) => {
    const lerp = (a, b, f) => ({ c: a.c.map((v, k) => Math.round(v + (b.c[k] - v) * f)), a: a.a + (b.a - a.a) * f });
    if (x <= stops[0].t) return stops[0];
    for (let i = 0; i < stops.length - 1; i++) {
      if (x <= stops[i + 1].t) {
        const f = stops[i + 1].t > stops[i].t ? (x - stops[i].t) / (stops[i + 1].t - stops[i].t) : 0;
        return lerp(stops[i], stops[i + 1], f);
      }
    }
    return stops[stops.length - 1];
  };
}

/** One background layer sampled at x in [0,1] (across) and y in [0,1] (down): a colour and its alpha. */
function layerAt(layer, x, y) {
  if (layer.startsWith('linear-gradient')) {
    const head = layer.slice(0, layer.indexOf(','));
    return linearSampler(layer)(/180deg/.test(head) ? y : x);
  }
  const m = /radial-gradient\(\s*([\d.]+)px ([\d.]+)px at (-?[\d.]+)% (-?[\d.]+)%, rgba\(([^)]+)\), transparent ([\d.]+)%\s*\)/.exec(layer);
  if (!m) return null;
  const [, w, h, ax, ay, colv, endv] = m;
  const { c: rc, a: ra } = rgba(`rgba(${colv})`);
  const end = Number(endv) / 100;
  const d = Math.hypot((x - Number(ax) / 100) * 1200 / Number(w), (y - Number(ay) / 100) * 86 / Number(h));
  const t = 1 - d / (end * 2); // fades linearly to nothing at twice the named end (an upper bound on where the layer is still strong)
  return { c: rc, a: Math.min(1, ra) * Math.min(1, Math.max(0, t)) };
}

/** Composite a background value in CSS paint order (the FIRST listed layer is on top), starting from `base`. */
function composite(value, x, y, base = [0, 0, 0]) {
  const layers = splitTop(value);
  let c = base;
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layerAt(layers[i], x, y);
    if (!L) continue;
    c = L.a >= 1 ? L.c : over(c, L.c, L.a);
  }
  return c;
}

/** Sample a .wx-sky-* rule composited with .wx-glow, at x in [0,1] (across) and y in [0,1] (down) of the ribbon. */
export function skyAt(rule, x, y) {
  return composite(GLOW, x, y, composite(rule, x, y));
}

/** The fill a day tile paints over the sky at the top of the tile, where its first line of text sits. */
function tileAt(base, rule) {
  const m = /rgba\(([^)]+)\)/.exec(rule); // the first (top) stop of the tile's gradient is the brightest it gets
  const { c, a } = rgba(`rgba(${m[1]})`);
  return over(base, c, a);
}
/** The worst contrast of `textColor` against a sky rule, sampled across the whole strip. */
export function worstContrast(rule, textColor = TEXT) {
  let worst = Infinity;
  for (let iy = 0; iy <= 16; iy++) for (let ix = 0; ix <= 100; ix++)
    worst = Math.min(worst, contrast(skyAt(rule, ix / 100, iy / 16), hex(textColor)));
  return worst;
}

/** The worst contrast of `textColor` on a day tile (normal, today, or wet) over a sky rule. */
function worstTile(rule, tileRule, textColor) {
  let worst = Infinity;
  for (let iy = 0; iy <= 16; iy++) for (let ix = 0; ix <= 100; ix++) {
    const c = tileAt(skyAt(rule, ix / 100, iy / 16), tileRule); // a tile's own background replaces the sky under it
    worst = Math.min(worst, contrast(c, hex(textColor)));
  }
  return worst;
}

const SKIES = Object.fromEntries([...css.matchAll(/\.wx-sky-([a-z]+) \{([^}]*)\}/g)]
  .map((m) => [m[1], m[2].replace(/^\s*background:\s*/, '').replace(/;\s*$/, '').replace(/\n\s*/g, ' ')]));

test('every ribbon sky keeps its text readable at a distance (2026-10-20)', () => {
  const names = Object.keys(SKIES);
  assert.ok(names.length >= 12, 'all the skies are found: ' + names.join(','));
  for (const [sky, rule] of Object.entries(SKIES)) {
    const w = worstContrast(rule);
    assert.ok(w >= 5, `wx-sky-${sky} drops to ${w.toFixed(2)}:1 somewhere -- the ribbon must read across the room`);
  }
});

test('the day tiles do not lift the sky out from under their own text (2026-10-20)', () => {
  for (const [sky, rule] of Object.entries(SKIES)) {
    for (const [name, tile] of [['day', TILE], ['today', TODAY], ['wet', WET]]) {
      const w = worstTile(rule, tile, TEXT);
      assert.ok(w >= 5, `wx-sky-${sky} ${name} tile: text drops to ${w.toFixed(2)}:1 -- the tile fill must only deepen the sky`);
    }
    // the tinted high/low colours are drawn on the tiles too
    for (const [name, col] of [['high', HI], ['low', LO]]) {
      const w = worstTile(rule, TODAY, col);
      assert.ok(w >= 4.5, `wx-sky-${sky} today tile ${name} ${col}: ${w.toFixed(2)}:1`);
    }
  }
});

test('the ribbon shade darkens the sky under the text, never lightens it (2026-10-20)', () => {
  // .wx-glow sits over every sky, at the top-left where the temperature is drawn. A white overlay there (the old
  // design) lifted the sky toward its pale end; the shade must be black or transparent, and must actually be present.
  const stops = [...GLOW.matchAll(/rgba\(([^)]+)\)/g)].map((m) => rgba(`rgba(${m[1]})`));
  assert.ok(stops.length >= 2, 'the shade has a radial and a vertical layer');
  for (const s of stops) assert.ok(s.a === 0 || (s.c[0] === s.c[1] && s.c[1] === s.c[2]), 'every shade layer is neutral grey/black');
});
