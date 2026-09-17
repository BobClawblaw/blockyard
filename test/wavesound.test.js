// THE THREE-VOICE WAVETABLE SYNTH (public/js/wavesound.js).
//
// It was written for a maze game that was dropped from the app on 2026-09-17; the operator kept the
// engine ("keep the updated sound engine tho"), so these are the tests that hold it on its own,
// without the game. What they check is the thing that makes it worth keeping: the tables are
// COMPUTED HERE from formulas in the file, three voices sound at once and no more, and pitch is a
// read rate over one cycle -- the era's technique, none of anyone's expression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PATCHES, WAVES, TABLE_LEN, VOICES, renderPatch, play, setSound, stopAll, unlock, state } from '../public/js/wavesound.js';

test('the wavetables are computed here, one cycle of 32 levels, and frozen', () => {
  assert.equal(TABLE_LEN, 32);
  assert.ok(Object.keys(WAVES).length >= 4, 'a handful of timbres');
  for (const [name, t] of Object.entries(WAVES)) {
    assert.equal(t.length, TABLE_LEN, `${name} is one cycle of ${TABLE_LEN}`);
    assert.ok(t.every((v) => Number.isFinite(v) && v >= -1 && v <= 1), `${name} stays in range`);
    assert.ok(Math.max(...t) > 0.2 && Math.min(...t) < -0.2, `${name} actually swings`);
    assert.equal(Object.isFrozen(t), true, 'and it is a constant');
  }
});

test('every patch is audible, short, quiet, and fits the three voices', () => {
  assert.equal(VOICES, 3, 'three voices, as the hardware of the era had');
  for (const [name, patch] of Object.entries(PATCHES)) {
    assert.ok(Array.isArray(patch) && patch.length, `${name} has steps`);
    assert.ok(patch.length <= VOICES + 1, `${name} does not ask for a fourth voice at one instant`);
    for (const step of patch) {
      assert.ok(WAVES[step.wave], `${name} names a table we computed (${step.wave})`);
      assert.ok(step.from > 20 && step.from < 8000, `${name} is audible`);
      assert.ok(step.ms > 0 && step.ms <= 900, `${name} is short`);
      assert.ok((step.gain ?? 0.06) <= 0.09, `${name} is no louder than the rest of the app`);
    }
  }
  assert.notEqual(PATCHES.dotA[0].from, PATCHES.dotB[0].from, 'the two blips are an interval apart, not one note twice');
});

test('a wavetable’s pitch is its read rate: one cycle per period', () => {
  const steps = renderPatch('start', { sampleRate: 48_000 });
  assert.equal(steps.length, PATCHES.start.length);
  assert.ok(Math.abs(steps[0].rate - (PATCHES.start[0].from * TABLE_LEN) / 48_000) < 1e-9, 'rate = freq x table length / sample rate');
  // twice the sample rate, half the read rate: the same cycle stretched over more samples
  const slow = renderPatch('start', { sampleRate: 96_000 });
  assert.ok(Math.abs(slow[0].rate * 2 - steps[0].rate) < 1e-9);
  assert.deepEqual(renderPatch('nothing-like-this'), []);
});

test('with no audio device it is a silent no-op rather than a throw', () => {
  // node:test has no AudioContext, which is exactly the shape of a browser that refused one
  setSound(true);
  assert.equal(play('dotA'), false, 'no AudioContext here');
  assert.equal(state().live, false);
  assert.equal(unlock(), false);
  setSound(false);
  assert.equal(play('dotA'), false, 'and nothing plays with the switch off');
  assert.doesNotThrow(() => stopAll());
  assert.equal(state().voices, 0);
});

test('it says plainly what it took from the era and what it did not', () => {
  const src = readFileSync(new URL('../public/js/wavesound.js', import.meta.url), 'utf8');
  assert.match(src, /TECHNIQUE is engineering, not expression/);
  assert.match(src, /What is NOT taken/);
  // no recorded audio anywhere near it: no file, no data URI, no base64 blob
  assert.doesNotMatch(src, /\.(?:wav|mp3|ogg|flac|m4a)\b/i, 'no audio file');
  assert.doesNotMatch(src, /base64|data:audio/i, 'and nothing embedded');
  assert.match(src, /computed from a formula in this file/, 'it says where the tables come from');
});
