// DOOM, the tab (operator, 2026-09-15: "I've added doom_dos to the project directory. Get DOOM
// working as a diversion inside blockyard with zero dependancies").
//
// The shareware DOOM.EXE v1.9 from games/doom_dos/, unmodified, on the emulated PC (dosgame.js has
// the tab, dosworker.js the machine). What is DOOM's own is here: its keys, and the WASD switch,
// which rebinds the running game in place ("have to refresh for settings to take effect").
import { createDosGame } from './dosgame.js';
import { DEFAULT_CONTROLS } from './dosio.js';

const CONTROLS_KEY = 'blockyard.doom.controls';

export const renderDoom = createDosGame({
  game: 'doom',
  page: 'doom',
  prefix: 'doom',
  title: 'DOOM',
  idleText: 'The shareware episode, Knee-Deep in the Dead: the real DOOM.EXE v1.9 running on a 486 this monitor emulates. Click the screen to use the mouse.',
  loadingText: 'loading the shareware episode…',
  saveName: /\.DSG$/i,
  keysText: (p) => (p[CONTROLS_KEY] === 'wasd'
    ? 'W S walk · A D strafe · ← → turn · E open · Ctrl or left click fire · Shift run · 1–7 weapons · Tab map · Esc menu · F2 save · F3 load'
    : '↑ ↓ walk · ← → turn · Alt+arrows strafe · Space open · Ctrl or left click fire · Shift run · 1–7 weapons · Tab map · Esc menu · F2 save · F3 load'),
  switches: [{
    id: 'Wasd', pref: CONTROLS_KEY, fallback: DEFAULT_CONTROLS,
    on: (v) => v === 'wasd',
    flip: (v) => (v === 'wasd' ? 'classic' : 'wasd'),
    // straight into the running game: no restart, no refresh
    apply: (v, G) => G.worker?.postMessage({ type: 'controls', scheme: v }),
  }],
  bootMessage: (p) => ({ controls: p[CONTROLS_KEY] }),
});
