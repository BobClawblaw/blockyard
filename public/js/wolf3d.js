// WOLFENSTEIN 3D, the tab (operator, 2026-09-15: "I added wolf3d_dos - Add that one next, but add it
// before DOOM and Quake in the Diversions list").
//
// The shareware WOLF3D.EXE v1.4 and its .WL1 data from games/wolf3d_dos/, unmodified, on the emulated
// PC (dosgame.js has the tab, dosworker.js the machine). Where DOOM and Quake were 32-bit programs
// under DOS extenders, Wolfenstein 3D is a 16-bit real-mode Borland program, so this is the one that
// runs the CPU in real mode: segment:offset addresses, the interrupt vector table at 0:0, DOS's own
// EXEC and memory allocator (dospc.js bootMZ). It sounds through the same Sound Blaster: AdLib music
// on the OPL, digitised effects on the DSP.
import { createDosGame } from './dosgame.js';

export const renderWolf3d = createDosGame({
  game: 'wolf3d',
  page: 'wolf3d',
  prefix: 'wolf',
  title: 'Wolfenstein 3D',
  idleText: 'The shareware episode, Escape from Wolfenstein: the real WOLF3D.EXE v1.4 running on a PC this monitor emulates. Click the screen to use the mouse.',
  loadingText: 'loading the shareware episode…',
  saveName: /^SAVEGAM\d\.WL1$/i,
  keysText: () => '↑ ↓ walk · ← → turn · Alt strafe · Ctrl or left click fire · Space open · Shift run · 1–4 weapons · Esc menu · F8 quick save · F9 quick load · rebind them under Control in the game’s own menu',
  switches: [],
});
