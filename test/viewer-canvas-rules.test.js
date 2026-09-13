// The canvas rules the 3D block-space viewer lives under, checked on the
// source itself.
//
// The software-rasteriser incident (test/never-clip.test.js): fills drawn
// through a clip were silently dropped and the whole map went blank; globalAlpha
// is honoured inconsistently on the same rasterisers. shadowBlur joins the list
// for the same reason -- a rasteriser may skip it, and the viewer's phosphor
// glow and cast shadows are built from plain rgba strokes and polygons instead.
// details3d.test.js drives the draw path and checks what reaches the context;
// this checks what is written, so a branch that test does not reach is covered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// comments name the forbidden calls in order to forbid them, so strip them first
const codeOnly = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('the 3D viewer never uses clip, globalAlpha, composite modes or shadowBlur', () => {
  // agents.js joined them on 2026-09-13: it draws on the SAME canvas under the same software
  // rasteriser, so a clip or a globalAlpha there fails exactly the way it fails in the renderer.
  for (const f of ['details3d.js', 'blockscene3d.js', 'agents.js']) {
    const src = codeOnly(f);
    assert.ok(src.length > 2000, `${f}: the source was actually read`);
    assert.ok(!/\.clip\(/.test(src), `${f}: no clip()`);
    assert.ok(!/globalAlpha/.test(src), `${f}: no globalAlpha`);
    assert.ok(!/globalCompositeOperation/.test(src), `${f}: no composite modes`);
    assert.ok(!/shadowBlur/.test(src), `${f}: no shadowBlur`);
  }
});
