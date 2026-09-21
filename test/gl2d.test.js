// THE WEBGL RENDERER (public/js/gl2d.js), under node.
//
// Two things can be held here without a GPU. The geometry is pure, so it is tested as numbers.
// The context is tested against a RECORDING STUB of WebGL2: what it asks the GPU for, in what
// order, and -- the part that matters for speed -- how rarely. What the pixels look like is
// scripts/gl-compare.mjs's job, in a real browser, against the software renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STAR_BEAT, beatFrequency, bakeRamp, earClip, parseColour, packColour, arcSegments, arcSweep, isConvex, isSpeck, strokeGeometry, stripGeometry, settleStops, createGl2d, gl2dSupported } from '../public/js/gl2d.js';
import { rendererOf, rendererIn, RENDERERS, render3d, softStops, fpsTick, fpsWanted, GALAXY_SPIN, GALAXY_SPIN_MAX } from '../public/js/details3d.js';
import { skyFor } from '../public/js/settings.js';
import { DEFAULTS, PANEL, normalise } from '../public/js/settings.js';

const TAU = Math.PI * 2;
const area = (tris) => tris.reduce((s, t) => s + Math.abs((t[2] - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (t[3] - t[1])) / 2, 0);
const collect = () => { const tris = []; return { tris, tri: (...t) => tris.push(t) }; };

// ---- a WebGL2 that records
function stubGl() {
  const calls = [];
  const handler = {
    get(target, name) {
      if (name in target) return target[name];
      if (typeof name !== 'string') return undefined;
      if (/^[A-Z_0-9]+$/.test(name)) return name;                       // every constant is its own name
      return (...args) => { calls.push([name, ...args]); return target.__ret?.[name]?.(...args) ?? {}; };
    },
  };
  const gl = new Proxy({ calls, __ret: { getShaderParameter: () => true, getProgramParameter: () => true, getUniformLocation: (_p, n) => n, getExtension: () => null } }, handler);
  return gl;
}
const fakeCanvas = (w = 200, h = 100) => ({ width: w, height: h, addEventListener() {}, removeEventListener() {} });
const draws = (gl) => gl.calls.filter((c) => c[0] === 'drawArrays');
const vertsDrawn = (gl) => draws(gl).reduce((s, c) => s + c[3], 0);

test('colours: every form the viewer writes, and none it does not', () => {
  assert.deepEqual(parseColour('rgba(40,255,140,0.05)'), [40, 255, 140, 0.05]);
  assert.deepEqual(parseColour('rgb(2, 9, 6)'), [2, 9, 6, 1]);
  assert.deepEqual(parseColour('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColour('#0b0d10'), [11, 13, 16, 1]);
  assert.deepEqual(parseColour('#ff000080').map((v) => Math.round(v * 100) / 100), [255, 0, 0, 0.5]);
  assert.deepEqual(parseColour('hsl(120, 100%, 50%)').map(Math.round), [0, 255, 0, 1]);
  assert.deepEqual(parseColour('rgb(255 0 0 / 50%)'), [255, 0, 0, 0.5]);
  assert.deepEqual(parseColour('white'), [255, 255, 255, 1]);
  assert.equal(parseColour('not-a-colour'), null);
  assert.equal(parseColour(undefined), null);
  // premultiplied and packed r | g<<8 | b<<16 | a<<24
  assert.equal(packColour([255, 0, 0, 1]), 0xff0000ff);
  assert.equal(packColour([255, 255, 255, 0.5]), 0x80808080);
  assert.equal(packColour([255, 0, 0, 1], 0.5), 0x80000080, 'the thin-line fade multiplies in');
});

test('arcs: the sweep is the 2D context\'s, and the chord count follows the DEVICE radius', () => {
  assert.equal(arcSweep(0, TAU, false), TAU);
  assert.equal(arcSweep(0, 7, false), TAU, 'past a whole turn is a whole turn');
  assert.ok(Math.abs(arcSweep(0, -Math.PI / 2, false) - 1.5 * Math.PI) < 1e-12, 'clockwise to -90 deg is the long way');
  assert.ok(Math.abs(arcSweep(0, -Math.PI / 2, true) + Math.PI / 2) < 1e-12);
  assert.equal(arcSweep(0, -TAU, true), -TAU);
  assert.ok(arcSegments(0.4) <= 4, 'a sub-pixel dot is a few chords');
  assert.ok(arcSegments(300) > arcSegments(30) && arcSegments(30) > arcSegments(3));
  // the chord's sagitta stays under a quarter of a pixel
  for (const r of [3, 30, 300]) { const n = arcSegments(r); assert.ok(r * (1 - Math.cos(Math.PI / n)) < 0.25, `r=${r}`); }
  assert.ok(arcSegments(1e6) <= 256, 'capped');
});

test('convexity decides who may skip the stencil', () => {
  assert.equal(isConvex([0, 0, 10, 0, 10, 10, 0, 10]), true);
  assert.equal(isConvex([0, 0, 0, 10, 10, 10, 10, 0]), true, 'either winding');
  assert.equal(isConvex([0, 0, 10, 0, 10, 10, 5, 3, 0, 10]), false, 'a notch');
  const circle = []; for (let i = 0; i <= 32; i++) circle.push(Math.cos((i / 32) * TAU) * 5, Math.sin((i / 32) * TAU) * 5);
  assert.equal(isConvex(circle), true, 'a closed arc repeats its first point; the zero-length edge is ignored');
  const star = []; for (let i = 0; i < 5; i++) star.push(Math.cos((i * 2 / 5) * TAU) * 5, Math.sin((i * 2 / 5) * TAU) * 5);
  assert.equal(isConvex(star), false, 'a pentagram turns the same way at every corner and is not convex');
  assert.equal(isConvex([0, 0, 1, 1]), false);
  assert.equal(isSpeck([0, 0, 2, 0, 2, 2, 0, 2]), true);
  assert.equal(isSpeck([0, 0, 20, 0, 20, 2, 0, 2]), false);
});

test('a simple concave outline is triangulated, exactly; one that crosses itself is refused', () => {
  const triArea = (p, e) => { let a = 0; for (let i = 0; i < e.length; i += 3) a += Math.abs((p[2 * e[i + 1]] - p[2 * e[i]]) * (p[2 * e[i + 2] + 1] - p[2 * e[i] + 1]) - (p[2 * e[i + 2]] - p[2 * e[i]]) * (p[2 * e[i + 1] + 1] - p[2 * e[i] + 1])) / 2; return a; };
  const notch = [0, 0, 50, 0, 50, 50, 25, 10, 0, 50];
  let e = earClip(notch);
  assert.equal(e.length, 9, 'five points, three triangles');
  assert.ok(Math.abs(triArea(notch, e) - (2500 - 0.5 * 50 * 40)) < 1e-9);
  // the black hole's strip: an outer arc out, an inner arc back -- a ring sector, either winding
  const ring = []; for (let i = 0; i <= 72; i++) { const a = (i / 72) * 5; ring.push(Math.cos(a) * 100, Math.sin(a) * 60); } for (let i = 72; i >= 0; i--) { const a = (i / 72) * 5; ring.push(Math.cos(a) * 90, Math.sin(a) * 54); }
  e = earClip(ring);
  assert.ok(e && e.length === (146 - 2) * 3);
  const shoelace = (p) => { let a = 0; for (let i = 0, n = p.length >> 1; i < n; i++) { const j = (i + 1) % n; a += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1]; } return Math.abs(a) / 2; };
  assert.ok(Math.abs(triArea(ring, e) - shoelace(ring)) < 1e-6);
  const back = []; for (let i = (ring.length >> 1) - 1; i >= 0; i--) back.push(ring[2 * i], ring[2 * i + 1]);
  assert.ok(earClip(back));
  // a ring that CLOSES (the real strip): its two ends coincide, a seam of no width
  const full = []; for (let i = 0; i <= 72; i++) { const a = (i / 72) * Math.PI * 2; full.push(Math.cos(a) * 100, Math.sin(a) * 60); } for (let i = 72; i >= 0; i--) { const a = (i / 72) * Math.PI * 2; full.push(Math.cos(a) * 90, Math.sin(a) * 54); }
  e = earClip(full);
  assert.ok(e, 'a ribbon');
  assert.ok(Math.abs(triArea(full, e) - shoelace(full)) < 1e-6);
  assert.equal(earClip([0, 0, 10, 10, 10, 0, 0, 10]), null, 'a bow tie: the stencil\'s job');
  assert.equal(earClip([0, 0, 5, 0, 10, 0]), null, 'no area');
  // and the context uses it: a concave fill is no longer a stencil pass
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  ctx.fillStyle = 'rgba(255,120,40,0.5)';
  ctx.beginPath(); for (let i = 0; i < ring.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, ring[i] + 100, ring[i + 1] + 50); ctx.closePath(); ctx.fill(); ctx.flush();
  assert.equal(ctx.stats.stencils, 0);
  assert.equal(vertsDrawn(gl), 144 * 3);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(10, 10); ctx.lineTo(10, 0); ctx.lineTo(0, 10); ctx.closePath(); ctx.fill();
  assert.equal(ctx.stats.stencils, 1, 'the bow tie still goes through it');
});

test('a stroke\'s geometry: areas are the pen\'s, caps and joins included', () => {
  // one butt segment: exactly length x width, and it reports that it cannot overlap itself
  let c = collect();
  assert.equal(strokeGeometry([0, 0, 10, 0], false, 2, 'butt', 'miter', 10, c.tri), true);
  assert.ok(Math.abs(area(c.tris) - 20) < 1e-9);
  // square caps add a half-width at each end
  c = collect(); strokeGeometry([0, 0, 10, 0], false, 2, 'square', 'miter', 10, c.tri);
  assert.ok(Math.abs(area(c.tris) - 24) < 1e-9);
  // round caps add a disc between them (as two half-discs that do not cover the segment)
  c = collect(); strokeGeometry([0, 0, 10, 0], false, 2, 'round', 'miter', 10, c.tri, 40);
  assert.ok(Math.abs(area(c.tris) - (20 + Math.PI)) < 0.05, `got ${area(c.tris)}`);   // chords sit just inside the circle
  for (const t of c.tris.slice(2)) for (let i = 0; i < 6; i += 2) assert.ok(t[i] <= 1e-9 || t[i] >= 10 - 1e-9, 'a cap stays beyond its end');
  // a dot: a zero-length segment with a round cap is a disc, with a square cap a square, with butt nothing
  c = collect(); strokeGeometry([5, 5, 5, 5], false, 4, 'round', 'round', 10, c.tri, 40);
  assert.ok(Math.abs(area(c.tris) - Math.PI * 4) < 0.05);
  c = collect(); strokeGeometry([5, 5, 5, 5], false, 4, 'butt', 'round', 10, c.tri);
  assert.equal(c.tris.length, 0);
  // a corner reports that it overlaps; a mitre reaches the true corner, a bevel does not
  c = collect();
  assert.equal(strokeGeometry([0, 0, 10, 0, 10, 10], false, 2, 'butt', 'miter', 10, c.tri), false);
  const reach = (tris) => Math.max(...tris.flatMap((t) => [t[0] - t[1], t[2] - t[3], t[4] - t[5]]));
  assert.ok(Math.abs(reach(c.tris) - 12) < 1e-9, 'the mitre tip is at (11,-1)');
  c = collect(); strokeGeometry([0, 0, 10, 0, 10, 10], false, 2, 'butt', 'bevel', 10, c.tri);
  assert.ok(reach(c.tris) < 11.01);
  // past the limit a mitre is a bevel
  c = collect(); strokeGeometry([0, 0, 10, 0, 0, 0.5], false, 2, 'butt', 'miter', 2, c.tri);
  assert.ok(Math.max(...c.tris.flatMap((t) => [t[0], t[2], t[4]])) < 11.5);
});

test('the thin strip never overlaps itself: a closed square\'s seam is exactly its ring', () => {
  const c = collect();
  stripGeometry([0, 0, 10, 0, 10, 10, 0, 10], true, 1, 'butt', c.tri);
  assert.equal(c.tris.length, 8);
  assert.ok(Math.abs(area(c.tris) - (11 * 11 - 9 * 9)) < 1e-9, 'outer 11x11 less inner 9x9: every pixel once');
  const open = collect();
  stripGeometry([0, 0, 10, 0], false, 1, 'round', open.tri);
  assert.ok(Math.abs(area(open.tris) - 11) < 1e-9, 'a cap on a hairline is half a width of length at each end');
});

test('gradient stops are sorted, clamped and held to what the shader can take', () => {
  const s = settleStops([[1, [0, 0, 0, 1]], [0, [255, 255, 255, 1]], [0.5, [10, 10, 10, 1]]]);
  assert.deepEqual(s.map((v) => v[0]), [0, 0.5, 1]);
  const many = []; for (let i = 0; i <= 100; i++) many.push([i / 100, [i, i, i, 1]]);
  const r = settleStops(many);
  assert.equal(r.length, 32);
  assert.equal(r[0][0], 0); assert.equal(r[31][0], 1);
  assert.ok(Math.abs(r[16][1][0] - (16 / 31) * 100) < 1e-9, 'resampled along the ramp');
});

test('a ramp row is the stops, straight alpha, hard edges kept', () => {
  const px = new Uint8Array(256 * 4);
  bakeRamp([[0, [255, 0, 0, 1]], [0.5, [0, 0, 255, 0]], [0.5, [0, 255, 0, 1]], [1, [0, 255, 0, 1]]], px, 0);
  assert.deepEqual([...px.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...px.slice(64 * 4, 64 * 4 + 4)].map((v, i) => Math.abs(v - [127, 0, 128, 127][i]) <= 1), [true, true, true, true], 'a quarter of the way: half red, half blue, half clear');
  assert.deepEqual([...px.slice(140 * 4, 140 * 4 + 4)], [0, 255, 0, 255], 'past two stops at one offset the later colour stands');
  assert.deepEqual([...px.slice(255 * 4)], [0, 255, 0, 255]);
});

test('the context never throws and answers null where there is no WebGL2', () => {
  assert.equal(gl2dSupported(), false, 'node has no document');
  assert.equal(createGl2d(null), null);
  assert.equal(createGl2d({ getContext: () => null }), null);
  assert.equal(createGl2d({ getContext: () => { throw new Error('blocklisted'); } }), null);
  // a shader that will not compile: null, and the log reaches the hook
  const gl = stubGl(); gl.__ret.getShaderParameter = () => false; gl.__ret.getShaderInfoLog = () => 'ERROR: 0:1';
  let log = null;
  assert.equal(createGl2d(fakeCanvas(), { gl, onCompileError: (l) => { log = l; } }), null);
  assert.match(log, /ERROR/);
});

test('a board\'s worth of opaque faces and hairline seams is ONE draw call', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  assert.ok(ctx && ctx.gl2d);
  ctx.setTransform(2, 0, 0, 2, 0, 0); ctx.lineWidth = 0.3; ctx.lineJoin = 'round';
  for (let i = 0; i < 500; i++) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + 1, 0); ctx.lineTo(i + 1, 1); ctx.lineTo(i, 1); ctx.closePath();
    ctx.fillStyle = `rgba(${i % 255},80,60,1)`; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.38)'; ctx.stroke();                   // the see-through seam round a stone
  }
  assert.equal(draws(gl).length, 0, 'nothing reaches the GPU until the frame is flushed');
  ctx.flush();
  assert.equal(draws(gl).length, 1);
  assert.equal(vertsDrawn(gl), 500 * (6 + 24), 'two triangles a face, a four-quad strip a seam');
  assert.ok(gl.calls.some((c) => c[0] === 'vertexAttribPointer' && c[1] === 3 && c[5] === 36), 'nine words a vertex: position, colour, the atlas gradient, the analytic disc');
  assert.equal(ctx.stats.stencils, 0);
  assert.ok(!gl.calls.some((c) => c[0] === 'enable' && c[1] === 'STENCIL_TEST'));
});

test('what could double up goes through the stencil; what could not does not', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  const passes = () => ctx.stats.stencils;
  // a fill that crosses itself (a simple concave one is triangulated: earClip)
  ctx.fillStyle = 'rgba(255,0,0,1)';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(50, 50); ctx.lineTo(50, 0); ctx.lineTo(0, 50); ctx.closePath(); ctx.fill();
  assert.equal(passes(), 1);
  // a wide see-through polyline (the price line's halo): its joins overlap its segments
  ctx.strokeStyle = 'rgba(255,255,0,0.2)'; ctx.lineWidth = 12; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(40, 30); ctx.lineTo(80, 0); ctx.stroke();
  assert.equal(passes(), 2);
  // the same line OPAQUE: overlap cannot show
  ctx.strokeStyle = 'rgba(255,255,0,1)';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(40, 30); ctx.lineTo(80, 0); ctx.stroke();
  assert.equal(passes(), 2);
  // fifteen thousand see-through dots in one stroke (the pulsar's gas), and a star field's rects in one fill
  ctx.strokeStyle = 'rgba(180,200,255,0.4)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
  ctx.beginPath(); for (let i = 0; i < 15000; i++) { const x = (i * 37) % 200, y = (i * 91) % 100; ctx.moveTo(x, y); ctx.lineTo(x, y); } ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath(); for (let i = 0; i < 4000; i++) ctx.rect((i * 37) % 200, (i * 91) % 100, 1.5, 1.5); ctx.fill();
  assert.equal(passes(), 2, 'specks batch directly');
  // a see-through fill of two LARGE outlines may overlap: stencilled, and even-odd is honoured
  ctx.beginPath(); ctx.rect(0, 0, 60, 60); ctx.rect(30, 30, 60, 60); ctx.fill('evenodd');
  assert.equal(passes(), 3);
  assert.ok(gl.calls.some((c) => c[0] === 'stencilOp' && c[3] === 'INVERT'));
  // the stencil pass paints nothing itself and cleans up after itself
  const i0 = gl.calls.findIndex((c) => c[0] === 'colorMask' && c[1] === false);
  assert.ok(i0 >= 0 && gl.calls.slice(i0).some((c) => c[0] === 'stencilOp' && c[3] === 'ZERO'));
  ctx.flush();
  assert.equal(gl.calls.filter((c) => c[0] === 'enable' && c[1] === 'STENCIL_TEST').length, gl.calls.filter((c) => c[0] === 'disable' && c[1] === 'STENCIL_TEST').length - 1, 'every pass switches the test off again (prepare() disables once more)');
});

test('a circle is ONE QUAD: fills, ellipses under any transform, and the round dots of a particle field', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  ctx.fillStyle = 'rgba(255,200,90,0.4)';
  ctx.beginPath(); ctx.arc(100, 50, 300, 0, TAU); ctx.fill(); ctx.flush();
  assert.equal(vertsDrawn(gl), 6, 'a 300 px disc was ~280 triangles as a fan');
  ctx.save(); ctx.translate(50, 50); ctx.rotate(0.4); ctx.scale(2, 0.5);
  ctx.beginPath(); ctx.ellipse(0, 0, 20, 10, 0.3, 0, TAU); ctx.fill(); ctx.restore(); ctx.flush();
  assert.equal(vertsDrawn(gl), 12);
  // fifteen thousand dots in one stroke: six vertices each, one draw, no stencil
  ctx.strokeStyle = 'rgba(180,200,255,0.4)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); for (let i = 0; i < 15000; i++) { const x = (i * 37) % 200, y = (i * 91) % 100; ctx.moveTo(x, y); ctx.lineTo(x, y); } ctx.stroke(); ctx.flush();
  assert.equal(vertsDrawn(gl), 12 + 15000 * 6);
  assert.equal(ctx.stats.stencils, 0);
  // an arc that is not a whole turn, or has a line added to it, is a path like any other
  ctx.beginPath(); ctx.arc(50, 50, 20, 0, Math.PI); ctx.fill();
  ctx.beginPath(); ctx.arc(50, 50, 20, 0, TAU); ctx.lineTo(90, 90); ctx.fill(); ctx.flush();
  assert.ok(vertsDrawn(gl) > 12 + 15000 * 6 + 12);
});

test('a one-point subpath draws nothing: closePath() leaves one behind every outline', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  ctx.lineCap = 'round'; ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.beginPath(); ctx.moveTo(10, 10); ctx.stroke(); ctx.flush();
  assert.equal(vertsDrawn(gl), 0);
});

test('gradients, images and the transform stack', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  const g = ctx.createRadialGradient(50, 50, 0, 50, 50, 40);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)'); g.addColorStop(2, 'red'); g.addColorStop(0.5, 'nonsense');
  assert.equal(g.stops.length, 2, 'a stop outside 0..1 or with no colour is refused, as the 2D context refuses it');
  ctx.fillStyle = g;
  assert.equal(ctx.fillStyle, g);
  // A GRADIENT RIDES THE BATCH: four hundred puffs of a supernova, each its own gradient, between
  // plain fills, are ONE draw call -- their ramps rows of one atlas texture, uploaded once
  ctx.beginPath(); ctx.arc(50, 50, 40, 0, TAU); ctx.fill();
  for (let i = 0; i < 400; i++) {
    const p = ctx.createRadialGradient(i % 200, 50, 0, i % 200, 50, 20);
    p.addColorStop(0, `rgba(255,${i % 256},90,0.5)`); p.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = p; ctx.beginPath(); ctx.arc(i % 200, 50, 20, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(9,9,9,1)'; ctx.fillRect(0, 0, 2, 2);
  }
  ctx.flush();
  assert.equal(draws(gl).length, 1);
  assert.equal(gl.calls.filter((c) => c[0] === 'texSubImage2D').length, 1, 'one upload for every new ramp');
  assert.ok(!gl.calls.some((c) => c[0] === 'uniform1fv'), 'no per-gradient uniforms');
  // the same colours next frame: the rows are still there, nothing is uploaded
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(50, 50, 40, 0, TAU); ctx.fill(); ctx.flush();
  assert.equal(gl.calls.filter((c) => c[0] === 'texSubImage2D').length, 1);
  // more gradients than the atlas has rows: it starts over, and still draws
  for (let i = 0; i < 600; i++) { const p = ctx.createRadialGradient(5, 5, 0, 5, 5, 5); p.addColorStop(0, `rgba(${i % 256},${(i >> 8) % 256},7,1)`); p.addColorStop(1, '#000'); ctx.fillStyle = p; ctx.beginPath(); ctx.arc(5, 5, 5, 0, TAU); ctx.fill(); }
  ctx.flush();
  assert.ok(draws(gl).length >= 3);
  // the general two-circle gradient (none in the project today) keeps its own program
  const two = ctx.createRadialGradient(40, 50, 5, 60, 50, 40); two.addColorStop(0, '#fff'); two.addColorStop(1, '#000');
  ctx.fillStyle = two; ctx.beginPath(); ctx.arc(50, 50, 40, 0, TAU); ctx.fill(); ctx.flush();
  assert.ok(gl.calls.some((c) => c[0] === 'uniform1i' && c[1] === 'uMode' && c[2] === 2), 'the radial program');
  assert.ok(gl.calls.some((c) => c[0] === 'uniform1i' && c[1] === 'uN' && c[2] === 2));
  const lin = ctx.createLinearGradient(0, 0, 100, 0); lin.addColorStop(0, '#000'); lin.addColorStop(1, '#fff');
  const before = draws(gl).length;
  ctx.strokeStyle = lin; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(100, 0); ctx.stroke(); ctx.flush();
  assert.equal(draws(gl).length, before + 2, 'a gradient may be a stroke\'s paint (the energy pulse): stencil, then the cover from the atlas');
  // a bad style is ignored, as the 2D context ignores it
  ctx.fillStyle = 'rgba(1,2,3,1)'; ctx.fillStyle = null; ctx.fillStyle = {};
  assert.equal(ctx.fillStyle, 'rgba(1,2,3,1)');
  // save / restore carries the styles and the matrix; the matrix composes as the 2D context's does
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.save(); ctx.translate(10, 20); ctx.scale(2, 3); ctx.rotate(Math.PI / 2); ctx.lineWidth = 9;
  const m = ctx.getTransform();
  assert.deepEqual([m.a, m.b, m.c, m.d, m.e, m.f].map((v) => Math.round(v * 1e9) / 1e9), [0, 3, -2, 0, 10, 20]);
  ctx.restore();
  assert.deepEqual(ctx.getTransform(), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  assert.equal(ctx.lineWidth, 4);
  // an image is uploaded once per stamp
  const img = { width: 8, height: 8, __v: 1 };
  ctx.drawImage(img, 0, 0); ctx.drawImage(img, 5, 5); ctx.flush();
  const uploads = () => gl.calls.filter((c) => c[0] === 'texImage2D' && c.at(-1) === img).length;   // (the ramp atlas allocates with one too)
  assert.equal(uploads(), 1);
  img.__v = 2; ctx.drawImage(img, 0, 0);
  assert.equal(uploads(), 2);
});

test('a recorded path is flattened once per transform (the ground and the price line cache theirs)', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  const p = ctx.createPath();
  p.moveTo(0, 0); p.lineTo(10, 0); p.lineTo(10, 10); p.closePath();
  ctx.setTransform(3, 0, 0, 3, 5, 5); ctx.fillStyle = 'rgba(9,9,9,1)';
  ctx.fill(p); const flat = p.flat; ctx.fill(p);
  assert.equal(p.flat, flat, 'the same transform: the same flattening');
  assert.deepEqual(flat[0].pts, [5, 5, 35, 5, 35, 35]);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fill(p);
  assert.notEqual(p.flat, flat);
  // a native Path2D cannot be read back: refused rather than drawn wrong
  ctx.flush(); const before = vertsDrawn(gl);
  ctx.fill({ some: 'Path2D' }); ctx.flush();
  assert.equal(vertsDrawn(gl), before);
});

test('a recorded path keeps its strokes: the price line is walked once a pen, not six times a frame', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  const line = ctx.createPath();
  line.moveTo(0, 50); for (let i = 1; i <= 200; i++) line.lineTo(i, 50 + 30 * Math.sin(i / 9));
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const frame = (tint) => { for (const [w, a] of [[30, 0.05], [10, 0.22], [3, 1]]) { ctx.strokeStyle = `rgba(255,${tint},40,${a})`; ctx.lineWidth = w; ctx.stroke(line); } ctx.flush(); };
  frame(225);
  assert.equal(line.strokes.size, 3, 'a pen each');
  const kept = [...line.strokes.values()], v1 = vertsDrawn(gl);
  frame(120);                                              // another colour: the same triangles
  assert.deepEqual([...line.strokes.values()], kept);
  assert.equal(vertsDrawn(gl), v1 * 2, 'and exactly the same picture is sent');
  // the curve changes, or the transform does: walked again
  line.lineTo(210, 50); frame(225);
  assert.notEqual([...line.strokes.values()][0], kept[0]);
  const again = [...line.strokes.values()][0];
  ctx.setTransform(2, 0, 0, 2, 0, 0); frame(225);
  assert.notEqual([...line.strokes.values()][0], again);
  // a pen a frame (the line breathing) cannot grow it without bound
  for (let i = 0; i < 100; i++) { ctx.lineWidth = 3 + i * 0.01; ctx.strokeStyle = '#fff'; ctx.stroke(line); }
  assert.ok(line.strokes.size <= 16);
});

test('softStops is one gradient fill on the GL renderer, and the nested discs on the 2D one', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  softStops(ctx, 100, 50, 300, [[0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
  ctx.flush();
  assert.equal(draws(gl).length, 1);
  let fills = 0;
  const flat = { beginPath() {}, arc() {}, fill() { fills++; }, set fillStyle(_v) {} };
  softStops(flat, 100, 50, 300, [[0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
  assert.ok(fills > 100, 'the software renderer keeps its banding cure');
});

test('a retained segment: built once, replayed from a static buffer while its inputs are the same', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  let runs = 0;
  const board = () => {
    runs++;
    for (let i = 0; i < 100; i++) { ctx.fillStyle = `rgba(${i},80,60,1)`; ctx.fillRect(i, 0, 1, 1); }
    // a see-through crossing fill goes through the stencil, and is kept with its state
    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.rect(0, 0, 60, 60); ctx.rect(30, 30, 60, 60); ctx.fill();
  };
  const frame = (same) => { ctx.clearRect(0, 0, 200, 100); ctx.fillStyle = '#123'; ctx.fillRect(0, 0, 5, 5); ctx.retained('board', same, board); ctx.fillRect(9, 9, 5, 5); ctx.flush(); };
  frame(false);
  assert.equal(runs, 1);
  const liveVerts = vertsDrawn(gl), n0 = gl.calls.length;
  frame(true);
  assert.equal(runs, 1, 'the same inputs: the drawing function is not called at all');
  assert.equal(ctx.stats.replayed, 100 * 6 + 12 + 6, 'faces, the two stencilled rects, their cover');
  assert.equal(vertsDrawn(gl) - liveVerts, liveVerts, 'and the GPU is sent the same picture');
  const after = gl.calls.slice(n0);
  assert.equal(after.filter((c) => c[0] === 'bufferData' && c[3] === 'STATIC_DRAW').length, 1, 'uploaded once, on the first reuse');
  const iWrite = after.findIndex((c) => c[0] === 'colorMask' && c[1] === false), iCover = after.findIndex((c) => c[0] === 'stencilFunc' && c[1] === 'NOTEQUAL');
  assert.ok(iWrite >= 0 && iCover > iWrite, 'the stencil pass is replayed in order, with its state');
  frame(true); frame(true);
  assert.equal(after.length > 0 && gl.calls.filter((c) => c[0] === 'bufferData' && c[3] === 'STATIC_DRAW').length, 1);
  // a change: it runs again and the old buffer is given back
  frame(false);
  assert.equal(runs, 2);
  assert.ok(gl.calls.some((c) => c[0] === 'deleteBuffer'));
  // a size change, or drawing that cannot be replayed from vertices (a texture), is simply live
  ctx.canvas.width = 300; frame(true);
  assert.equal(runs, 3, 'another panel size is another picture, whatever the caller says');
  let tex = 0;
  const withImage = () => { tex++; ctx.drawImage({ width: 4, height: 4, __v: 1 }, 0, 0); };
  ctx.retained('sky', false, withImage); ctx.retained('sky', true, withImage); ctx.flush();
  assert.equal(tex, 2);
});

test('the star field is sent to the card once and drawn in ONE instanced call', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  const stars = []; for (let i = 0; i < 40000; i++) stars.push({ gr: i % 300, ga: i * 0.01, x: i % 200, y: i % 100, r: 0.6, c: [255, 240, 220], b: 0.8, f: 0.002 + (i % 7) * 1e-4, p: i, big: i % 500 === 0 });
  const field = { key: {}, stars, galaxy: true, cx: 20, cy: 80, flatten: 0.8, colourOf: (st) => st.c };
  ctx.fillStyle = '#010'; ctx.fillRect(0, 0, 200, 100);
  assert.equal(ctx.starField(field, 0.3, 123456, 1), true);
  assert.equal(ctx.starField(field, 0.31, 123490, 1), true);
  ctx.flush();
  const inst = gl.calls.filter((c) => c[0] === 'drawArraysInstanced');
  assert.equal(inst.length, 2);
  assert.deepEqual(inst[0].slice(1), ['TRIANGLES', 0, 6, 40000]);
  assert.equal(gl.calls.filter((c) => c[0] === 'bufferData' && c[3] === 'STATIC_DRAW' && c[2]?.length === 40000 * 11).length, 1, 'eleven floats a star, uploaded once');
  // the batch before it was drawn first (paint order), and the batch's own program is back after
  const iStars = gl.calls.findIndex((c) => c[0] === 'drawArraysInstanced'), iRect = gl.calls.findIndex((c) => c[0] === 'drawArrays');
  assert.ok(iRect >= 0 && iRect < iStars);
  ctx.fillRect(0, 0, 5, 5); ctx.flush();
  assert.ok(gl.calls.slice(iStars).some((c) => c[0] === 'drawArrays'));
  // other stars (another key) are another buffer
  ctx.starField({ ...field, key: {} }, 0, 0, 1);
  assert.equal(gl.calls.filter((c) => c[0] === 'bufferData' && c[2]?.length === 40000 * 11).length, 2);
  // THE CLOCK WRAPS SEAMLESSLY: every frequency is a whole number of turns in STAR_BEAT, so the
  // card is never handed a clock bigger than ten minutes (a float32 would stutter after days)
  for (const f of [0.0007, 0.002, 0.00493]) {
    const q = beatFrequency(f);
    assert.ok(Math.abs(q - f) <= Math.PI / STAR_BEAT + 1e-12, 'moved by under half a step');
    const turns = (q * STAR_BEAT) / (Math.PI * 2);
    assert.ok(Math.abs(turns - Math.round(turns)) < 1e-6);
  }
  const clock = gl.calls.filter((c) => c[0] === 'uniform2f' && c[1] === 'uClock');
  assert.ok(clock.every((c) => c[2] >= 0 && c[2] < STAR_BEAT));
});

test('particles live on the card: stepped by transform feedback, drawn instanced, nothing uploaded a frame', () => {
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  const glsl = 'void simulate(inout vec4 a, inout vec4 b, float id, float dt, bool init) {} vec4 look(vec4 a, vec4 b, int pass, out vec2 c, out float r) { c = a.xy; r = 1.0; return vec4(1.0); }';
  const key = {};
  const frame = (dt, draw) => ctx.particles({ key, count: 27000, glsl, passes: 2, dt, draw, uniforms: { uR0: 3, uAxis: [1, 0, 0, 1], uCentre: [5, 5] } });
  assert.equal(frame(16, true), true);
  const n0 = gl.calls.length;
  assert.equal(frame(16, true), true);
  const f2 = gl.calls.slice(n0);
  assert.deepEqual(f2.filter((c) => c[0] === 'beginTransformFeedback').map((c) => c[1]), ['POINTS']);
  assert.ok(f2.findIndex((c) => c[0] === 'enable' && c[1] === 'RASTERIZER_DISCARD') < f2.findIndex((c) => c[0] === 'beginTransformFeedback'));
  assert.ok(f2.some((c) => c[0] === 'disable' && c[1] === 'RASTERIZER_DISCARD'));
  assert.equal(f2.filter((c) => c[0] === 'drawArraysInstanced' && c[4] === 27000).length, 2, 'a draw a pass');
  assert.ok(!f2.some((c) => c[0] === 'bufferData' || c[0] === 'bufferSubData'), 'the second frame sends no vertex data at all');
  assert.ok(f2.some((c) => c[0] === 'uniform1i' && c[1] === 'uInit' && c[2] === 0), 'born on the first frame only');
  assert.ok(gl.calls.slice(0, n0).some((c) => c[0] === 'uniform1i' && c[1] === 'uInit' && c[2] === 1));
  // it ping-pongs: the buffer written this frame is the one read next
  const bases = gl.calls.filter((c) => c[0] === 'bindBufferBase' && c[3] !== null).map((c) => c[3]);
  assert.notEqual(bases[0], bases[1]);
  // simulated on but not drawn (the pulsar outside its stream)
  const n1 = gl.calls.length; frame(16, false);
  assert.equal(gl.calls.slice(n1).filter((c) => c[0] === 'drawArraysInstanced').length, 0);
  assert.equal(gl.calls.slice(n1).filter((c) => c[0] === 'beginTransformFeedback').length, 1);
  // a shader that will not compile: false, once and for all, and the caller draws it the old way
  const bad = stubGl(); let compiled = 0; bad.__ret.getShaderParameter = () => ++compiled <= 2;   // the context's own two pass
  const ctx2 = createGl2d(fakeCanvas(), { gl: bad });
  assert.equal(ctx2.particles({ key: {}, count: 10, glsl, dt: 1 }), false);
  assert.equal(ctx2.particles({ key: {}, count: 10, glsl, dt: 1 }), false);
  ctx2.fillStyle = '#fff'; ctx2.fillRect(0, 0, 4, 4); ctx2.flush();
  assert.ok(draws(bad).length >= 1, 'and the context still draws');
});

test('the glow: only what is MARKED throws light, and a crowd of lamps keeps its colours', () => {
  const src = readFileSync(new URL('../public/js/gl2d.js', import.meta.url), 'utf8');
  // no brightness rule: a cloud of the Earth sky is near-white and is not a lamp (it blew out)
  assert.match(src, /oE = vec4\(o\.rgb \* e, o\.a\);/);
  assert.ok(!/smoothstep\(0\.80, 0\.95, min\(o\.r/.test(src), 'the near-white rule is gone');
  // bounded on its brightest channel, then screened on: a neon board summed past white when it was added
  assert.match(src, /glow \/= \(1\.0 \+ 1\.6 \* max\(glow\.r, max\(glow\.g, glow\.b\)\)\);/);
  assert.match(src, /c\.rgb \+ glow \* \(1\.0 - clamp\(c\.rgb, 0\.0, 1\.0\)\)/);
  // and the ground's fills are surfaces, its lines lamps (details3d drawGround)
  const d3 = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(d3, /ctx\.emissive = !l\.fill;/);
  // the flag reaches the vertex: 2 in the disc word when on, 0 when off
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  const flags = () => { const c = gl.calls.filter((x) => x[0] === 'bufferSubData').at(-1); return [c[3][8], c[3][9 * 6 + 8]]; };
  ctx.fillStyle = '#fff'; ctx.emissive = false; ctx.fillRect(0, 0, 4, 4); ctx.emissive = true; ctx.fillRect(5, 5, 4, 4); ctx.flush();
  assert.deepEqual(flags(), [0, 2]);
});

test('a lost context stops drawing and tells its owner once', () => {
  const gl = stubGl(); let listener = null, told = 0;
  const canvas = { ...fakeCanvas(), addEventListener: (n, fn) => { if (n === 'webglcontextlost') listener = fn; } };
  const ctx = createGl2d(canvas, { gl, onLost: () => told++ });
  listener({ preventDefault() {} });
  assert.equal(ctx.lost, true); assert.equal(told, 1);
  const n = gl.calls.length;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 10, 10); ctx.clearRect(0, 0, 200, 100); ctx.flush();
  assert.equal(gl.calls.length, n, 'not one more GL call');
});

test('the choice: a setting, an override, Software by default and wherever WebGL cannot be had', () => {
  assert.deepEqual([...RENDERERS], ['software', 'webgl']);
  assert.equal(DEFAULTS.appearance.renderer, 'software', 'the shipped renderer is the one every browser has');
  const row = PANEL.find((g) => g.group === 'appearance').rows.find((r) => r.key === 'renderer');
  assert.deepEqual(row.options.map((o) => o[0]), [...RENDERERS], 'the panel offers exactly what the viewer knows');
  assert.equal(normalise({ appearance: { renderer: 'webgl' } }).appearance.renderer, 'webgl');
  assert.equal(normalise({ appearance: { renderer: 'vulkan' } }).appearance.renderer, 'software');
  assert.equal(rendererOf({ renderer: 'webgl' }), 'webgl');
  assert.equal(rendererOf({ renderer: 'software' }), 'software');
  assert.equal(rendererOf({}), 'software', 'no override: the setting, which here is the default');
  // asked for WebGL where there is none (node: no document), a board still draws, on the 2D context
  let fills = 0;
  const c2 = new Proxy({}, { get: (_t, k) => (k === 'canvas' ? canvas : k === 'fill' ? () => { fills++; } : k === 'measureText' ? () => ({ width: 10 }) : typeof k === 'string' && /^(create|get)/.test(k) ? () => null : () => {}), set: () => true });
  const canvas = { width: 300, height: 200, clientWidth: 300, clientHeight: 200, getContext: () => c2, addEventListener() {}, style: {} };
  render3d(canvas, [{ txid: 'a'.repeat(64), vbytes: 5000, rate: 10 }], { renderer: 'webgl', stars: false, idleFx: false });
  assert.ok(fills > 0);
  assert.equal(rendererIn(canvas), 'software');
});

test('the frame rate: frames actually painted in the last second, shown twice a second, on either renderer', () => {
  assert.equal(DEFAULTS.appearance.showFps, false, 'off as shipped');
  assert.ok(PANEL.find((g) => g.group === 'appearance').rows.some((r) => r.key === 'showFps' && r.kind === 'toggle'));
  assert.equal(fpsWanted({ showFps: true }), true);
  assert.equal(fpsWanted({ showFps: false }), false);
  assert.equal(fpsWanted({}), false, 'no override: the setting, which here is the default');
  const st = {};
  let text = '';
  for (let i = 0; i < 90; i++) text = fpsTick(st, 1000 + i * (1000 / 30), 2.5);   // three seconds at thirty a second
  assert.match(text, /^(29|30|31) fps {2}2\.5 ms$/);
  const shown = st.fps.text;
  fpsTick(st, st.fps.at + 100, 2.5);
  assert.equal(st.fps.text, shown, 'the figure does not flicker every frame');
  // a board that stopped painting for a while: old frames are not counted
  assert.match(fpsTick(st, st.fps.at + 60_000, 2.5), /^1 fps/);
  // it is drawn through the board's own context, top right, whichever renderer that is
  let label = null, box = null;
  const c2 = new Proxy({}, { get: (_t, k) => (k === 'createPath' || k === 'gl2d' || k === 'flush' ? undefined : k === 'canvas' ? canvas
    : k === 'fillText' ? (t, x, y) => { label = [t, x, y]; } : k === 'fillRect' ? (x, y, w, h) => { box = [x, y, w, h]; }
    : k === 'measureText' ? () => ({ width: 100 }) : typeof k === 'string' && /^(create|get)/.test(k) ? () => null : () => {}), set: () => true });
  const canvas = { width: 300, height: 200, clientWidth: 300, clientHeight: 200, getContext: () => c2, addEventListener() {}, style: {} };
  render3d(canvas, [{ txid: 'b'.repeat(64), vbytes: 5000, rate: 10 }], { showFps: true, stars: false, idleFx: false });
  assert.match(label[0], /fps .* ms {2}Software$/);
  assert.ok(label[1] > 250 && label[2] < 30, 'top right');
  assert.ok(box[0] + box[2] <= 300 && box[1] >= 0);
  label = null;
  render3d(canvas, [{ txid: 'c'.repeat(64), vbytes: 5000, rate: 10 }], { showFps: false, stars: false, idleFx: false });
  assert.equal(label, null);
});

test('the Galaxy sky on WebGL: its gas is baked by a shader, once, and drawn as the bitmap was', () => {
  // (operator, 2026-09-21: "Can we fix up the nebulas at least so they are not overlapping circles, and make
  // them proper gas clouds?")
  const gl = stubGl(); gl.__ret.checkFramebufferStatus = () => 'FRAMEBUFFER_COMPLETE';
  const ctx = createGl2d(fakeCanvas(), { gl });
  const glsl = 'uniform vec4 uA[3]; uniform vec4 uGeo; vec4 bake(vec2 px) { return vec4(px / uGeo.xy, 0.0, 1.0); }';
  const img = ctx.bake({ width: 512, height: 256, glsl, uniforms: { uGeo: [512, 256, 1, 0], 'uA[0]': new Float32Array(12) } });
  assert.ok(img && img.width === 512 && img.height === 256);
  assert.ok(gl.calls.some((c) => c[0] === 'viewport' && c[3] === 512 && c[4] === 256), 'rendered at its own size, into its own target');
  assert.ok(gl.calls.some((c) => c[0] === 'uniform4fv' && c[1] === 'uA[0]' && c[2].length === 12), 'an array of vec4 reaches the shader');
  assert.ok(gl.calls.some((c) => c[0] === 'drawArrays' && c[3] === 3), 'one full-screen triangle');
  // and then it is an image like any other: drawn with no upload, the frame's own target restored first
  const n = gl.calls.length;
  ctx.drawImage(img, 0, 0); ctx.drawImage(img, 5, 5); ctx.flush();
  const after = gl.calls.slice(n);
  assert.equal(after.filter((c) => c[0] === 'texImage2D' || c[0] === 'texSubImage2D').length, 0);
  assert.ok(after.some((c) => c[0] === 'useProgram') && after.some((c) => c[0] === 'bindFramebuffer'), 'the frame is set up again after the bake');
  assert.equal(after.filter((c) => c[0] === 'drawArrays').length, 2);
  img.free();
  assert.ok(gl.calls.some((c) => c[0] === 'deleteTexture'));
  // a card that cannot: null, once and for all, and the bitmap of ellipses is baked the old way
  const bad = stubGl(); let n2 = 0; bad.__ret.getShaderParameter = () => ++n2 <= 2;
  const ctx2 = createGl2d(fakeCanvas(), { gl: bad });
  assert.equal(ctx2.bake({ width: 8, height: 8, glsl }), null);
  assert.equal(ctx2.bake({ width: 8, height: 8, glsl }), null);
  // the shader itself: nine clouds and fourteen lanes from the SAME seeded lists, laid along their arms, torn by noise
  const d3 = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const g = d3.slice(d3.indexOf('const GAS_GLSL = `'), d3.indexOf('function gasLayerGl('));
  assert.match(g, /uniform vec4 uNeb\[9\];/); assert.match(g, /uniform vec4 uDust\[14\];/);
  assert.match(g, /vec2 lw = l \+ [\d.]+ \* warp;/, 'the envelope is warped: a cloud has no oval outline');
  assert.match(g, /rgb \*= 1\.0 - a;/, 'dust ABSORBS what is under it');
  assert.equal((g.slice(18).match(/`/g) || []).length, 1, 'no backtick inside the template but its end');
});

test('the GL renderer\'s own sky: light between the stars, stars as points of light, far galaxies as smudges', () => {
  // (operator, 2026-09-21: "do all 3")
  const d3 = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  const g2 = readFileSync(new URL('../public/js/gl2d.js', import.meta.url), 'utf8');
  // ONE switch, and the parity check turns it off so the two renderers are compared on the same picture
  assert.match(d3, /const glSky = ctx\.gl2d === true && opts\.glSky !== false;/);
  assert.match(readFileSync(new URL('../scripts/gl-compare.mjs', import.meta.url), 'utf8'), /glSky: \$\{LOOK\}/);
  // the arms' haze is the SAME log spiral the stars, clouds and lanes are laid on, and the bulge is held down
  const gas = d3.slice(d3.indexOf('const GAS_GLSL = `'), d3.indexOf('function gasLayerGl('));
  assert.match(gas, /float phase = uArm\.z \* \(th - log\(max\(r, 1e-3\) \/ uArm\.x\) \/ uArm\.w\);/);
  assert.match(d3, /uArm: \[geo\.inner, geo\.maxR, GALAXY_ARMS, GALAXY_TWIST\]/);
  const bulge = Number(gas.match(/float ab = clamp\(bulge \* ([\d.]+) \* uOpt\.x/)[1]);
  assert.ok(bulge <= 0.4, 'the bulge is a glow behind a chart, not a lamp');
  assert.ok(!/\bfloat (patch|sample|filter|input|output|common|partition|active)\b/.test(gas), 'no GLSL reserved word as a name (patch broke the bake, silently)');
  // a failed shader is LOGGED, not only fallen back from
  assert.match(d3, /onCompileError: \(log\) =>/);
  // stars: a soft point keeps the LIGHT of the square it replaces, and a sub-pixel star is widened and dimmed
  assert.match(g2, /float rTrue = aPos\.w \* uSoft\.y, rDraw = max\(rTrue, 0\.75\);/);
  assert.match(g2, /if \(uSoft\.x > 0\.5\) a \*= \(rTrue \* rTrue\) \/ \(rDraw \* rDraw\);/);
  assert.ok(Math.abs(2 * Math.PI * 0.8 * 0.8 - 4) < 0.05, 'a gaussian of sigma 0.8 r holds what a square of side 2 r did');
  assert.match(g2, /k = exp\(-d \* d \/ 1\.28\);/);
  // the context is told, and draws the field in one call either way; soft giants are not given 2D glints as well
  const gl = stubGl(), ctx = createGl2d(fakeCanvas(), { gl });
  const stars = []; for (let i = 0; i < 100; i++) stars.push({ x: i, y: i, r: 0.6, c: [255, 240, 220], b: 0.8, f: 0.002, p: i, big: i % 10 === 0 });
  ctx.starField({ key: {}, stars, soft: true, galaxy: false, colourOf: (st) => st.c }, 0, 0, 1);
  ctx.starField({ key: {}, stars, soft: false, galaxy: false, colourOf: (st) => st.c }, 0, 0, 1);
  assert.deepEqual(gl.calls.filter((c) => c[0] === 'uniform2f' && c[1] === 'uSoft').map((c) => c[2]), [1, 0]);
  assert.match(d3, /if \(!glints \|\| soft\) return;/);
  // far galaxies: gradient fills (one quad each on this renderer), not four flat ellipses
  assert.match(d3, /if \(f\.far && opts\.galaxies !== false && glSky\) \{/);
});

test('the Galaxy sky\'s rotation speed: a setting, and a pace -- not a jump', () => {
  // (operator, 2026-09-21: "we should add a rotation slider speed for that too")
  assert.equal(DEFAULTS.sky.galaxySpin, 1, 'the shipped turn in fifteen minutes');
  const row = PANEL.find((gr) => gr.group === 'sky').rows.find((r) => r.key === 'galaxySpin');
  assert.ok(row.kind === 'range' && row.min === 0 && row.max === GALAXY_SPIN_MAX);
  assert.equal(skyFor(normalise({ sky: { galaxySpin: 6 } }), 'space').galaxySpin, 6);
  assert.ok(Math.abs((Math.PI * 2) / Math.abs(GALAXY_SPIN) - 900_000) < 1, 'rate 1 is a turn in 900 s');
  const d3 = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(d3, /else f\.spinAngle \+= \(now - f\.spinAt\) \* GALAXY_SPIN \* rate;/, 'integrated on the field');
  assert.ok(!/const spin = galaxy \? now \* GALAXY_SPIN/.test(d3), 'never now x rate: a drag would swing the whole disc');
});

test('the pixels\' owners keep Software: Scorched Yard reads its land and its sky back', () => {
  const src = readFileSync(new URL('../public/js/scorchedyard.js', import.meta.url), 'utf8');
  assert.equal((src.match(/renderer: 'software'/g) || []).length, 2);
  assert.match(src, /getImageData/);
});

test('the current price is READ: its tag throws no light, and its figures take the ink that reads on it', async () => {
  const { tagIsLight } = await import('../public/js/details3d.js');
  assert.equal(tagIsLight('#1fc98a'), true, 'white on the rising green is 2.2:1; near-black is 9:1');
  assert.equal(tagIsLight('#ef4d5e'), true);
  assert.equal(tagIsLight('rgba(40,60,50,1)'), false, 'the uncoloured tag is dark: white figures');
  assert.equal(tagIsLight(undefined), false);
  const src = readFileSync(new URL('../public/js/details3d.js', import.meta.url), 'utf8');
  assert.match(src, /ctx\.emissive = false; axisLabels\(/, 'with the glow on, a lit tag bloomed over its own figures');
});
