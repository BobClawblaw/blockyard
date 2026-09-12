// TETRUST SOUND (operator, 2026-09-12: "We need to add Tetris music and sound effects to teh
// gameplay. Toggle for each in the game display").
//
// No files and no dependencies, so everything here is SYNTHESISED with the Web Audio API: the
// music is a note table played on oscillators, the effects are short shaped tones. The tune is
// Korobeiniki, the Russian folk song everyone knows as the Tetris theme -- public domain, older
// than any game. A browser lets audio start only on a gesture, so the context is made lazily on
// the first play or key press, and nothing here throws where there is no AudioContext at all
// (tests, or a browser with audio blocked): every call is a no-op then.

const HZ = { A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880, GS4: 415.3, E4: 329.63, R: 0 };

// Korobeiniki, A minor, one verse: [note, beats]
export const THEME = Object.freeze([
  ['E5', 1], ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['C5', 0.5], ['B4', 0.5],
  ['A4', 1], ['A4', 0.5], ['C5', 0.5], ['E5', 1], ['D5', 0.5], ['C5', 0.5],
  ['B4', 1.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
  ['C5', 1], ['A4', 1], ['A4', 1], ['R', 1],
  ['D5', 1.5], ['F5', 0.5], ['A5', 1], ['G5', 0.5], ['F5', 0.5],
  ['E5', 1.5], ['C5', 0.5], ['E5', 1], ['D5', 0.5], ['C5', 0.5],
  ['B4', 1], ['B4', 0.5], ['C5', 0.5], ['D5', 1], ['E5', 1],
  ['C5', 1], ['A4', 1], ['A4', 1], ['R', 1],
]);
export const BPM = 148;

// the effects: [frequency from, frequency to, seconds, wave, gain]
export const SFX = Object.freeze({
  move: [520, 520, 0.045, 'square', 0.05],
  rotate: [780, 980, 0.06, 'square', 0.05],
  soft: [300, 300, 0.03, 'triangle', 0.04],
  drop: [160, 70, 0.11, 'sawtooth', 0.09],
  lock: [220, 180, 0.07, 'triangle', 0.06],
  clear: [420, 1320, 0.28, 'square', 0.08],
  tetris: [330, 1760, 0.45, 'square', 0.1],
  over: [440, 90, 0.7, 'sawtooth', 0.09],
  level: [660, 1320, 0.22, 'triangle', 0.07],
});

const S = { ctx: null, music: false, sfx: false, timer: null, at: 0, i: 0, gain: null, live: new Set() };

function context() {
  if (S.ctx) return S.ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try {
    S.ctx = new AC();
    S.gain = S.ctx.createGain();
    S.gain.gain.value = 0.9;
    S.gain.connect(S.ctx.destination);
  } catch { S.ctx = null; }
  return S.ctx;
}

/** Call on a user gesture: a suspended context (autoplay policy) is resumed here. */
export function unlock() {
  const c = context();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

function tone(freqFrom, freqTo, secs, wave, gain, at = null) {
  const c = context();
  if (!c) return;
  const t0 = at ?? c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = wave;
  o.frequency.setValueAtTime(freqFrom, t0);
  if (freqTo !== freqFrom) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo), t0 + secs);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + secs);
  o.connect(g); g.connect(S.gain);
  o.start(t0); o.stop(t0 + secs + 0.02);
  // remembered until it has played, so a stop (pause, switch off) can cut what was scheduled
  // ahead rather than letting a second and a half of tune run on
  S.live.add(o);
  o.onended = () => S.live.delete(o);
}
function hush() {
  for (const o of S.live) { try { o.stop(); } catch { /* already stopped */ } }
  S.live.clear();
}

/** One sound effect, if effects are on. */
export function play(name) {
  if (!S.sfx) return;
  const d = SFX[name];
  if (!d) return;
  tone(d[0], d[1], d[2], d[3], d[4]);
}

export function setSfx(on) { S.sfx = !!on; }

// THE MUSIC: a lookahead scheduler. Every 200 ms it schedules whatever notes fall in the next
// 1.5 s, on the AUDIO clock (absolute times), so the tune keeps its tempo however late the page's
// timers run -- and they run late: a galaxy repaint or a well repaint can hold the main thread
// well past a timer. The first cut looked 250 ms ahead on a 90 ms timer and stuttered whenever a
// frame took longer than that ("the music is glitching out and not playing at a steady state").
// A stop takes at most the lookahead to fall silent, which a pause can afford. Melody on a square
// wave, the same note an octave down on a soft triangle underneath.
const LOOKAHEAD_S = 1.5;
const TIMER_MS = 200;
function schedule() {
  const c = S.ctx;
  if (!c || !S.music) return;
  const beat = 60 / BPM;
  // fallen behind (the tab was hidden, the thread was held): pick the tune up from now rather
  // than cramming the missed notes into an instant
  if (S.at < c.currentTime - 0.05) S.at = c.currentTime + 0.02;
  while (S.at < c.currentTime + LOOKAHEAD_S) {
    const [name, beats] = THEME[S.i % THEME.length];
    const dur = beats * beat;
    const hz = HZ[name] ?? 0;
    if (hz > 0) {
      tone(hz, hz, dur * 0.88, 'square', 0.045, S.at);
      tone(hz / 2, hz / 2, dur * 0.88, 'triangle', 0.03, S.at);
    }
    S.at += dur;
    S.i++;
  }
  S.timer = setTimeout(schedule, TIMER_MS);
}

export function setMusic(on) {
  S.music = !!on;
  if (S.timer) { clearTimeout(S.timer); S.timer = null; }
  if (!S.music) { hush(); return; }
  const c = context();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  S.at = c.currentTime + 0.05;
  schedule();
}

/** Hold the tune (a pause): the scheduler stops, the place in the tune is kept. */
export function holdMusic(hold) {
  if (hold) { if (S.timer) { clearTimeout(S.timer); S.timer = null; } hush(); return; }
  if (S.music && !S.timer && S.ctx) { S.at = S.ctx.currentTime + 0.05; schedule(); }
}

export function state() { return { music: S.music, sfx: S.sfx, live: !!S.ctx }; }
