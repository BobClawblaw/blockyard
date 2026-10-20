// THE RIBBON READS AT A DISTANCE (operator, 2026-10-20: "we need a better day theme for the water strip ...
// The light background makes it too difficult to see at a distance"): every .wx-sky-* background in
// public/css/app.css must keep the ribbon's text colour legible wherever it sits. This file parses the CSS
// rule (the linear sky gradient plus its radial sun-glow, then the .wx-glow overlay on top of both) and
// measures the WCAG contrast of the text colour against the composited background across the whole strip.
// Pure maths, no browser: it runs under `npm test` like any other test file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const css = fs.readFileSync(new URL('public/css/app.css', root), 'utf8');

// The ribbon's own text colour and the .wx-glow overlay, read back from the CSS so the test cannot drift
// from the sheet it checks.
const TEXT = css.match(/\.wx \{[^}]*color: (#[0-9a-f]{6})/i)[1];
const GLOW = css.match(/\.wx-glow \{([^}]*)\}/s)[1];

const hex = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const rgba = (s) => { const v = s.match(/-?[\d.]+/g).map(Number); return { c: v.slice(0, 3), a: v[3] ?? 1 }; };
const lum = ([r, g, b]) => [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
  .reduce((a, v, i) => a + a * 0 + [0.2126, 0.7152, 0.0722][i] * v, 0);
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

/** Parse one linear-gradient layer's stops into a function of x in [0,1] (unspecified stops space out evenly). */
function linearSampler(layer) {
  const parts = splitTop(layer.slice(layer.indexOf('(') + 1, layer.lastIndexOf(')'))).slice(1); // drop the angle
  const stops = parts.map((p) => {
    const bare = p.replace(/\s+in\s+oklab\([^)]*\)/, ''); // "in oklab" interpolation does not move legibility
    const m = /([\d.]+)%$/.exec(bare);
    return { t: m ? Number(m[1]) / 100 : null, c: hex((m ? bare.slice(0, m.index) : bare).trim()) };
  });
  stops.forEach((s, i) => {
    if (s.t != null) return;
    const prev = stops.slice(0, i).map((q, j) => [j, q.t]).filter(([, t]) => t != null).pop();
    const next = stops.slice(i + 1).map((q, j) => [j + i + 1, q.t]).filter(([, t]) => t != null)[0];
    s.t = prev ? prev[1] + (next ? (next[1] - prev[1]) * (i - prev[0]) / (next[0] - prev[0]) : 0) : 0;
  });
  return (x) => {
    if (x <= stops[0].t) return stops[0].c;
    for (let i = 0; i < stops.length - 1; i++) {
      if (x <= stops[i + 1].t) {
        const f = stops[i + 1].t > stops[i].t ? (x - stops[i].t) / (stops[i + 1].t - stops[i].t) : 0;
        return stops[i].c.map((v, k) => Math.round(v + (stops[i + 1].c[k] - v) * f));
      }
    }
    return stops[stops.length - 1].c;
  };
}

/** Sample a .wx-sky-* rule (one linear gradient, any number of `Wpx Hpx at X% Y%, colour, transparent E%`
 *  radials) composited with .wx-glow, at x in [0,1] (across) and y in [0,1] (down) of the ribbon. */
export function skyAt(rule, x, y) {
  const layers = splitTop(rule);
  const lin = layers.find((L) => L.startsWith('linear-gradient'));
  let c = lin ? linearSampler(lin)(x) : [0, 0, 0]; // a star field alone sits over transparent (measured worst case: black)
  for (const layer of layers) {
    if (layer.startsWith('radial-gradient')) {
      const m = /radial-gradient\(\s*([\d.]+)px ([\d.]+)px at (-?[\d.]+)% (-?[\d.]+)%, rgba\(([^)]+)\), transparent ([\d.]+)%\s*\)/.exec(layer);
      if (!m) continue;
      const [, w, h, ax, ay, colv, endv] = m;
      const { c: rc, a: ra } = rgba(`rgba(${colv})`);
      const end = Number(endv) / 100;
      const d = Math.hypot((x - Number(ax) / 100) * 1200 / Number(w), (y - Number(ay) / 100) * 86 / Number(h));
      const t = 1 - d / (end * 2); // fades linearly to nothing at twice the named end (an upper bound on where the layer is still strong)
      if (t > 0) c = over(c, rc, Math.min(1, ra) * Math.min(1, t));
    }
  }
  // .wx-glow: a white radial at the top-left (120% x 140% of the box, gone by 55%) and a vertical wash
  const rg = /radial-gradient\(120% 140% at 0% 0%, rgba\(([^)]+)\), transparent 55%\)/.exec(GLOW);
  if (rg) {
    const { c: wc, a: wa } = rgba(`rgba(${rg[1]})`);
    const d = Math.hypot(x / 0.55, y / 0.55);
    if (d < 1) c = over(c, wc, wa * (1 - d));
  }
  const lg = /linear-gradient\(180deg, rgba\(([^)]+)\), transparent ([\d.]+)%, rgba\(([^)]+)\)\)/.exec(GLOW);
  if (lg) {
    const top = rgba(`rgba(${lg[1]})`), bot = rgba(`rgba(${lg[3]})`), mid = Number(lg[2]) / 100;
    c = y < mid ? over(c, top.c, top.a * (1 - y / mid)) : over(c, bot.c, bot.a * ((y - mid) / (1 - mid)));
  }
  return c;
}

/** The worst contrast of the ribbon's text against a sky rule, sampled across the whole strip. */
export function worstContrast(rule, textColor = TEXT) {
  let worst = Infinity;
  for (let iy = 0; iy <= 8; iy++) for (let ix = 0; ix <= 100; ix++)
    worst = Math.min(worst, contrast(skyAt(rule, ix / 100, iy / 8), hex(textColor)));
  return worst;
}

const SKIES = Object.fromEntries([...css.matchAll(/\.wx-sky-([a-z]+) \{([^}]*)\}/g)]
  .map((m) => [m[1], m[2].replace(/^\s*background:\s*/, '').replace(/;\s*$/, '').replace(/\n\s*/g, ' ')]));

test('every ribbon sky keeps its text readable at a distance (2026-10-20)', () => {
  const names = Object.keys(SKIES);
  assert.ok(names.length >= 12, 'all the skies are found: ' + names.join(','));
  for (const [sky, rule] of Object.entries(SKIES)) {
    const w = worstContrast(rule);
    assert.ok(w >= 3, `wx-sky-${sky} drops to ${w.toFixed(2)}:1 somewhere -- the ribbon must read across the room`);
  }
});
