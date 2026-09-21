// HOW BADLY DOES EACH FORMATION PALETTE FIGHT THE CHART? In numbers, because "clash" is otherwise taste.
//
// The chart is the most important thing on the board (operator, 2026-09-21), and it is three colours: the
// candles' green and red and the yellow price line. A background fights them when its GAS comes close to one
// of them in colour at a similar lightness, or is simply bright. For every palette in formgl.js this prints:
//   nearest   the smallest CIELAB distance (dE76) from anywhere in the gas range (thin gas up to the densest,
//             0.14..0.85 of the ramp -- the pale end is only ever the galaxy's core) to each chart colour.
//             Under ~25 is a colour you could mistake for it; over ~45 is plainly something else.
//   gas L*    how light the densest gas is (0 black, 100 white). The chart's own colours sit at 60-90.
//   line      the WCAG contrast of the yellow line against the densest gas (4.5 is the floor for text).
// and ranks them, worst clash first.   node scripts/form-palettes.mjs
import { FORM_PALETTES, formRamp } from '../public/js/formgl.js';

const CHART = { green: [0x1f, 0xc9, 0x8a], red: [0xef, 0x4d, 0x5e], line: [255, 236, 70] };
const lin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lab = ([r, g, b]) => {
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), Y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), Z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
};
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

export function scorePalette(name, brightness = 0.8) {
  const near = { green: Infinity, red: Infinity, line: Infinity };
  let top = [0, 0, 0];
  for (let i = 0; i <= 71; i++) {
    const t = 0.14 + (0.71 * i) / 71, c = formRamp(t, name).map((v) => v * brightness);
    for (const k of Object.keys(CHART)) near[k] = Math.min(near[k], dE(lab(c), lab(CHART[k])));
    if (i === 71) top = c;
  }
  return { name, ...near, worst: Math.min(near.green, near.red, near.line), gasL: lab(top)[0], lineContrast: contrast(CHART.line, top) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = Object.keys(FORM_PALETTES).map((n) => scorePalette(n)).sort((a, b) => a.worst - b.worst);
  console.log('palette        nearest to:  green    red   line    gas L*   line contrast');
  for (const r of rows) console.log(`${r.name.padEnd(14)}            ${r.green.toFixed(0).padStart(6)} ${r.red.toFixed(0).padStart(6)} ${r.line.toFixed(0).padStart(6)}   ${r.gasL.toFixed(0).padStart(6)}   ${r.lineContrast.toFixed(1).padStart(6)}${r.worst < 25 ? '   <- close to a chart colour' : ''}`);
}
