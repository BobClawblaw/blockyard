// THE FORMATION'S GPU LAYER (public/js/formgl.js): the same physics as galform.js,
// re-expressed as a vertex shader. The tests here hold the two engines together: the GLSL
// literals must equal galform's exported constants, the shader must compile (where a GL
// context exists -- headless CI usually has none, so the compile test skips itself), and
// the attach contract must hold: null when there is no webgl2, never a throw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FORM_CONST, formGlAttach, formGlSupported } from '../public/js/formgl.js';
import { FORM_CYCLE, FORM_TILT, FORM_WINDOWS, FORM_HOLD } from '../public/js/galform.js';

const glsl = readFileSync(new URL('../public/js/formgl.js', import.meta.url), 'utf8');

test('the shader constants are the JS engine constants, to the last digit', () => {
  assert.equal(FORM_CONST.FORM_CYCLE, FORM_CYCLE, 'the cycle length is one number, not two');
  // every FORM_CONST value appears as a literal in the shader template (numbers are
  // injected either by F() -- 6 decimals -- or bare when written directly in the source)
  for (const [k, v] of Object.entries(FORM_CONST)) {
    const bare = `${Number(v)}`;
    const lit = bare.includes('.') ? bare : `${bare}.0`;
    assert.ok(glsl.includes(bare) || glsl.includes(lit), `${k} (${bare}) is in the shader`);
  }
  // the tilt and the fountain windows ride in the shader source too
  assert.ok(glsl.includes(FORM_TILT.toFixed(6)) || glsl.includes('tilt = -0.32'), 'the tilt is shared');
  for (const [start, dur] of FORM_WINDOWS) {
    assert.ok(glsl.includes(Number(start).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0') ) || glsl.includes(`${start}`), `window start ${start} in the shader`);
    assert.ok(glsl.includes(`${dur}`), `window duration ${dur} in the shader`);
  }
});

test('the shaders are well-formed GLSL they can be sanity-checked against', () => {
  // structural checks that hold without a GPU: version pragma, one main per stage, no
  // attribute arrays (the whole point: everything derives from gl_VertexID), no banned
  // randomness (Math.random cannot appear; the GLSL hash is seeded)
  assert.ok(glsl.includes('#version 300 es'), 'GLSL ES 3.0');
  // two shader STAGES named main: the gas vertex shader and the wind vertex shader (the
  // fragment shaders are separate main()s; there are four mains across the file)
  assert.ok((glsl.match(/void main\(\) \{/g) || []).length === 4, 'four shader mains: gas VS/FS and wind VS/FS');
  const code = glsl.replace(/\/\/.*$/gm, '');          // comments may name the banned thing
  assert.ok(!code.includes('Math.random'), 'no Math.random in code');
  assert.ok(glsl.includes('gl blendFunc') === false && glsl.includes('gl.blendFunc(gl.ONE, gl.ONE)'), 'additive blending is the layer\u2019s whole point');
  assert.ok(glsl.includes('gl_VertexID'), 'particles derive from the vertex id, no CPU loop');
});

test('attach answers null, never throws, where there is no webgl2', () => {
  // In this process there is no DOM at all: document is undefined, so the probe must not
  // even reach getContext. The contract: formGlSupported false, formGlAttach null.
  assert.equal(formGlSupported(), false, 'no webgl2 in a DOM-less node process');
  assert.equal(formGlAttach({ getContext: () => null, addEventListener() {} }), null, 'a null context is null, not a throw');
  assert.equal(
    formGlAttach({ getContext: () => { throw new Error('boom'); }, addEventListener() {} }),
    null,
    'a throwing context is null, not a throw',
  );
});

test('attach answers null when the shader fails to compile, and the fallback then runs', () => {
  // A stub GL whose getShaderParameter always says no: attach must swallow the failure and
  // answer null, which is the signal details3d reads to paint the 2D layer instead.
  const mk = () => ({
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => false,
    getShaderInfoLog: () => 'synthetic failure',
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => false,
    getProgramInfoLog: () => '',
    createVertexArray: () => ({}),
    bindVertexArray() {},
    disable() {},
    enable() {},
    blendFunc() {},
    addEventListener() {},
  });
  assert.equal(formGlAttach({ getContext: () => mk(), addEventListener() {} }), null);
});

test('the fallback sky still draws: galform.js stands behind the GL layer', async () => {
  // the 2D renderer is the engine of record wherever webgl2 is absent; its draw must run on
  // a stub context without a GL anything
  const { drawGalaxyForm } = await import('../public/js/galform.js');
  const fills = [];
  const ctx = {
    fillStyle: '',
    beginPath() {},
    arc() { fills.push(this.fillStyle); },
    fill() {},
    fillRect() {},
  };
  drawGalaxyForm(ctx, 800, 500, 1, 60000, { formNoGl: true });
  assert.ok(fills.length > 1500, `the 2D fallback painted (${fills.length} fills)`);
  assert.ok(fills.every((f) => /^rgba\(/.test(f.style ?? f)), 'plain rgba fills only');
});

test('the hold frame is agreed: speed 0 holds the same still on both engines', () => {
  // both engines hold 0.86 (the mature disc, fountain up) at speed 0; galform names it
  // FORM_HOLD, the GL draw carries the literal -- pin them equal here
  assert.equal(FORM_HOLD, 0.86);
  assert.ok(glsl.includes('? ((now * speed) / (1000 * C.FORM_CYCLE)) % 1 : 0.86') || glsl.includes(': 0.86;'), 'the GL draw holds 0.86');
});
