// BLOCKMAN'S SOUND: A THREE-VOICE WAVETABLE GENERATOR (docs/PLAN-BLOCKMAN.md §6).
//
// WHAT IS TAKEN, AND WHAT IS NOT. The 1980 arcade board made its sound with a three-voice wavetable
// generator: three channels, each stepping through a short table of levels at a rate set by a
// frequency register. That TECHNIQUE is engineering, not expression, and it is what gives the era
// its character -- so BlockMan's sound is built the same way, three voices over 32-entry tables,
// and it belongs in a zero-dependency project because it is a hundred lines of Web Audio.
//
// What is NOT taken is the expression: their waveform ROM's contents, their melodies, their siren,
// their eat, their jingle. Every table here is computed from a formula in this file (square, pulse,
// a folded triangle, a soft bass, a rasp), and every patch below is our own choice of pitches and
// shapes. A transcription of their audio would be a copy however it was synthesised, which is the
// whole reason this file exists rather than a sampler.
//
// Zero dependencies, and no AudioContext until a sound is actually asked for: a page that never
// opens BlockMan never opens an audio device (operator's rule for every board here).

/** One cycle of each voice's timbre, 32 levels, computed -- never a table lifted from anywhere. */
export const TABLE_LEN = 32;
export const WAVES = Object.freeze({
  // a hard square: the lead's voice, bright and cheap, the sound of a 4-bit level flipping
  square: table((i) => (i < TABLE_LEN / 2 ? 1 : -1)),
  // a narrow pulse (25%): thinner and reedier, for the eat blips
  pulse: table((i) => (i < TABLE_LEN / 4 ? 1 : -1)),
  // a folded triangle: rounder, for the warble a pellet makes
  tri: table((i) => 1 - 4 * Math.abs(Math.round(i / TABLE_LEN) - i / TABLE_LEN)),
  // a soft bass: a sine with its third harmonic, for the pulse under everything
  bass: table((i) => Math.sin((i / TABLE_LEN) * Math.PI * 2) * 0.8 + Math.sin((i / TABLE_LEN) * Math.PI * 6) * 0.2),
  // a rasp: a sawtooth quantised to sixteen levels, for the death
  saw: table((i) => Math.round(((i / TABLE_LEN) * 2 - 1) * 8) / 8),
});
function table(f) {
  // a plain array, not a typed one: a Float32Array cannot be frozen, and these tables are constants
  const out = [];
  for (let i = 0; i < TABLE_LEN; i++) out.push(Math.max(-1, Math.min(1, f(i))));
  return Object.freeze(out);
}

/**
 * THE PATCHES: our own sounds, in the shape the hardware's registers took -- a voice, a pitch (or a
 * slide between two), a length, and a level. Two or three of them at once is a chord, which is all
 * the polyphony three voices allows and exactly the constraint that makes this era's sound.
 *
 * The notes are ours. The eat is a fifth apart (A5 to E5) so a corridor alternates a bright interval
 * rather than one note; the pellet warbles up a minor third; eating a pursuer runs up an arpeggio;
 * the fruit is a major sixth; the death slides two octaves down through the rasp; and the pulse is a
 * bass fifth whose TEMPO carries how much is left (blockmanfx.pulseMs), which is the one idea from
 * the genre worth keeping and is a mechanic rather than a melody.
 */
export const PATCHES = Object.freeze({
  dotA: [{ wave: 'pulse', from: 880, to: 830, ms: 40, gain: 0.05 }],
  dotB: [{ wave: 'pulse', from: 659, to: 622, ms: 40, gain: 0.05 }],
  pellet: [
    { wave: 'tri', from: 330, to: 392, ms: 90, gain: 0.07 },
    { wave: 'tri', from: 392, to: 330, ms: 90, at: 90, gain: 0.07 },
  ],
  ate: [
    { wave: 'square', from: 440, to: 440, ms: 70, gain: 0.07 },
    { wave: 'square', from: 587, to: 587, ms: 70, at: 70, gain: 0.07 },
    { wave: 'square', from: 880, to: 1320, ms: 140, at: 140, gain: 0.07 },
  ],
  fruit: [
    { wave: 'tri', from: 784, to: 784, ms: 80, gain: 0.08 },
    { wave: 'tri', from: 1319, to: 1319, ms: 120, at: 80, gain: 0.08 },
  ],
  death: [
    { wave: 'saw', from: 660, to: 82, ms: 800, gain: 0.08 },
    { wave: 'bass', from: 165, to: 41, ms: 800, gain: 0.05 },
  ],
  level: [
    { wave: 'square', from: 523, to: 523, ms: 90, gain: 0.07 },
    { wave: 'square', from: 659, to: 659, ms: 90, at: 90, gain: 0.07 },
    { wave: 'square', from: 784, to: 1046, ms: 220, at: 180, gain: 0.07 },
  ],
  life: [
    { wave: 'tri', from: 659, to: 659, ms: 100, gain: 0.07 },
    { wave: 'tri', from: 988, to: 1319, ms: 220, at: 100, gain: 0.07 },
  ],
  // the pulse: two bass voices a fifth apart, short, under everything
  pulse: [
    { wave: 'bass', from: 98, to: 92, ms: 70, gain: 0.055 },
    { wave: 'bass', from: 147, to: 138, ms: 60, gain: 0.03 },
  ],
  start: [
    { wave: 'square', from: 392, to: 392, ms: 110, gain: 0.07 },
    { wave: 'square', from: 523, to: 523, ms: 110, at: 110, gain: 0.07 },
    { wave: 'square', from: 659, to: 659, ms: 110, at: 220, gain: 0.07 },
    { wave: 'bass', from: 98, to: 98, ms: 330, gain: 0.05 },
  ],
});

const S = { ctx: null, on: true, buffers: new Map(), voices: [], out: null };

/** At most three voices sound at once, as the hardware had: a fourth steals the oldest. */
export const VOICES = 3;

function context() {
  if (S.ctx) return S.ctx;
  const C = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!C) return null;
  try {
    S.ctx = new C();
    S.out = S.ctx.createGain();
    S.out.gain.value = 1;
    S.out.connect(S.ctx.destination);
  } catch { S.ctx = null; }
  return S.ctx;
}

/** One cycle of a table as an AudioBuffer: the wavetable itself, looped at the pitch we want. */
function cycle(ctx, name) {
  const have = S.buffers.get(name);
  if (have) return have;
  const t = WAVES[name] ?? WAVES.square;
  const buf = ctx.createBuffer(1, t.length, ctx.sampleRate);
  buf.copyToChannel ? buf.copyToChannel(Float32Array.from(t), 0) : buf.getChannelData(0).set(t);
  S.buffers.set(name, buf);
  return buf;
}

/** Sound one step of a patch: a looping wavetable at `from`, sliding to `to`, with a short decay. */
function step(ctx, s, when) {
  const buf = cycle(ctx, s.wave);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  // A WAVETABLE'S PITCH IS ITS READ RATE: one cycle of 32 samples played `freq` times a second.
  const rate = (f) => (f * TABLE_LEN) / ctx.sampleRate;
  src.playbackRate.setValueAtTime(rate(s.from), when);
  if (s.to && s.to !== s.from) src.playbackRate.exponentialRampToValueAtTime(Math.max(0.0001, rate(s.to)), when + s.ms / 1000);
  const g = ctx.createGain();
  const peak = Math.max(0.0001, s.gain ?? 0.06);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, when + s.ms / 1000);
  src.connect(g).connect(S.out);
  src.start(when);
  src.stop(when + s.ms / 1000 + 0.02);
  keep(src, when + s.ms / 1000);
  return src;
}

function keep(src, until) {
  S.voices = S.voices.filter((v) => v.until > (S.ctx?.currentTime ?? 0));
  if (S.voices.length >= VOICES) {
    const oldest = S.voices.shift();
    try { oldest.src.stop(); } catch { /* already done */ }
  }
  S.voices.push({ src, until });
}

/** Play a patch by name. Silent, and free, when the sound switch is off or there is no audio. */
export function play(name) {
  if (!S.on) return false;
  const patch = PATCHES[name];
  if (!patch) return false;
  const ctx = context();
  if (!ctx) return false;
  if (ctx.state === 'suspended') ctx.resume?.();
  const t0 = ctx.currentTime + 0.001;
  for (const s of patch) step(ctx, s, t0 + (s.at ?? 0) / 1000);
  return true;
}

export function setSound(on) { S.on = !!on; if (!on) stopAll(); }
export function stopAll() {
  for (const v of S.voices) { try { v.src.stop(); } catch { /* already done */ } }
  S.voices = [];
}
/** A user gesture: browsers will not start an audio device without one. */
export function unlock() { const c = context(); if (c?.state === 'suspended') c.resume?.(); return !!c; }
export function state() { return { on: S.on, live: !!S.ctx, voices: S.voices.length }; }

/** For the tests: play into a stand-in context and report what each patch asked the hardware for. */
export function renderPatch(name, ctx) {
  const patch = PATCHES[name];
  if (!patch) return [];
  return patch.map((s) => ({
    wave: s.wave,
    rate: (s.from * TABLE_LEN) / (ctx?.sampleRate ?? 48_000),
    from: s.from, to: s.to ?? s.from, ms: s.ms, at: s.at ?? 0, gain: s.gain ?? 0.06,
  }));
}
