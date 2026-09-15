// QUAKE, the tab (operator, 2026-09-15: "yes, get Quake working as a diversion").
//
// The shareware QUAKE.EXE v1.06 and its PAK0.PAK from games/quake_dos/, unmodified, on the emulated
// PC (dosgame.js has the tab, dosworker.js the machine). Quake is a DJGPP program where DOOM was a
// DOS/4GW one, so the same machine plays the go32 stub and CWSDPMI for it (dospc.js bootCoff), and it
// asks far more of the FPU. Its keys are its own: W A S D and mouse look on the first run
// (dosio.js quakeAutoexec), and after that whatever the player binds in Quake's own menu.
import { createDosGame } from './dosgame.js';

export const renderQuake = createDosGame({
  game: 'quake',
  page: 'quake',
  prefix: 'quake',
  title: 'Quake',
  idleText: 'The shareware episode, Dimension of the Doomed: the real QUAKE.EXE v1.06 running on a PC this monitor emulates. Click the screen to use the mouse.',
  loadingText: 'loading the shareware episode (18 MB)…',
  saveName: /\.SAV$/i,
  keysText: () => 'W S walk · A D strafe · mouse to look · left click fire · Space or right click jump · Shift run · 1–8 weapons · Esc menu · ~ console · F6 quicksave · F9 quickload',
  switches: [],
});
