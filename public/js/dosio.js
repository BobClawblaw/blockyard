// DOS I/O: the pure pieces between a browser and the emulated PC, for the DOOM and Quake Diversions
// (operator, 2026-09-15: "Get DOOM working as a diversion inside blockyard with zero dependancies",
// then "get Quake working as a diversion"). No DOM, no worker, no clock, so every mapping here runs
// under node:test.
//
//   GAMES            each game's files, arguments and where its saves are kept (Wolfenstein 3D, DOOM, Quake)
//   scancodes()      a KeyboardEvent.code as the bytes a PC/AT keyboard puts on port 60h
//   withControls()   DOOM's config with the page's control scheme laid over it
//   rebindKeys()     the same, into a running DOOM
//   quakeAutoexec()  Quake's first-run WASD and mouse look
//   CP437 / CGA      how text mode's bytes and attributes become characters and colours
//   paletteLut()     the VGA DAC's 6-bit palette as 32-bit pixels for an ImageData

// ------------------------------------------------------------------ the games
/**
 * What the worker fetches for each game, from /games/<name>/: the executable, the files it cannot
 * start without, the ones it can, the command line, and the IndexedDB database its saves live in.
 * Paths are DOS paths under the game's directory, upper case.
 */
export const GAMES = Object.freeze({
  // a real-mode program: the data files are the .WL1s, CONFIG.WL1 its settings and high scores
  wolf3d: Object.freeze({ exe: 'WOLF3D.EXE', required: ['AUDIOHED.WL1', 'AUDIOT.WL1', 'GAMEMAPS.WL1', 'MAPHEAD.WL1', 'VGADICT.WL1', 'VGAGRAPH.WL1', 'VGAHEAD.WL1', 'VSWAP.WL1'], optional: ['CONFIG.WL1'], config: 'CONFIG.WL1', args: '', db: 'blockyard-wolf3d', label: 'WOLF3D.EXE and its data files', dir: 'games/wolf3d_dos' }),
  doom: Object.freeze({ exe: 'DOOM.EXE', required: ['DOOM1.WAD'], optional: ['DEFAULT.CFG'], config: 'DEFAULT.CFG', args: '', db: 'blockyard-doom', label: 'DOOM.EXE and DOOM1.WAD', dir: 'games/doom_dos' }),
  // -nocdaudio: there is no CD in the drive, and without it Quake stops at a "press a key" warning
  quake: Object.freeze({ exe: 'QUAKE.EXE', required: ['ID1/PAK0.PAK'], optional: ['ID1/CONFIG.CFG'], config: 'ID1/CONFIG.CFG', args: '-nocdaudio', db: 'blockyard-quake', label: 'QUAKE.EXE and ID1/PAK0.PAK', dir: 'games/quake_dos' }),
});

/**
 * QUAKE'S AUTOEXEC.CFG, which it runs after its config on every start. Mouse look always -- Quake 1
 * did not save it, and a browser game without it is a fight with the mouse -- and, the first time
 * only (no config the game wrote itself yet), W A S D to move and Space to jump. After that the
 * game's own saved bindings are the player's, and this does not overwrite them.
 */
export function quakeAutoexec({ firstRun }) {
  const lines = ['+mlook'];
  if (firstRun) lines.push('bind "w" "+forward"', 'bind "s" "+back"', 'bind "a" "+moveleft"', 'bind "d" "+moveright"', 'bind "SPACE" "+jump"', 'bind "MOUSE2" "+jump"');
  // A SMALLER VIEW, the first time (operator, 2026-09-15: "we need to render it in a smaller window,
  // so it runs faster"): Quake draws 3D only inside its view, and measured on this PC's emulator
  // timedemo demo1 went 29.7 fps at viewsize 100, 32.5 at 80, 40.5 at 60. 80 keeps the status bar
  // and a border; - and = change it in the game, and Quake saves the choice with its config.
  if (firstRun) lines.push('viewsize 80');
  const text = `${lines.join('\n')}\n`;
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

// ------------------------------------------------------------------ the keyboard
// Scancode set 1: the make code; the break code is the same with bit 7 set. Keys that arrived with
// the AT's extra cluster are sent after an 0xE0 prefix, the way the hardware does -- DOOM's own
// keyboard handler skips the prefix and reads the arrows as the keypad's 8, 4, 6 and 2.
const SET1 = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08,
  Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51,
  Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
};
const EXTENDED = {
  NumpadEnter: 0x1c, ControlRight: 0x1d, NumpadDivide: 0x35, AltRight: 0x38, Home: 0x47, ArrowUp: 0x48, PageUp: 0x49,
  ArrowLeft: 0x4b, ArrowRight: 0x4d, End: 0x4f, ArrowDown: 0x50, PageDown: 0x51, Insert: 0x52, Delete: 0x53,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
};

/** The bytes for a key going down (`down`) or up, or null for a key the PC keyboard does not have. */
export function scancodes(code, down) {
  if (code === 'Pause') return down ? [0xe1, 0x1d, 0x45, 0xe1, 0x9d, 0xc5] : [];
  if (code in SET1) return [down ? SET1[code] : SET1[code] | 0x80];
  if (code in EXTENDED) return [0xe0, down ? EXTENDED[code] : EXTENDED[code] | 0x80];
  return null;
}

// ------------------------------------------------------------------ the config
/** Scancodes the two control schemes bind, by DOOM's config key. WASD is the default. */
export const CONTROLS = {
  classic: { key_up: 72, key_down: 80, key_left: 75, key_right: 77, key_strafeleft: 51, key_straferight: 52, key_use: 57 },
  wasd: { key_up: 17, key_down: 31, key_left: 75, key_right: 77, key_strafeleft: 30, key_straferight: 32, key_use: 18 },
};
export const DEFAULT_CONTROLS = 'wasd';

// DOOM's own key codes for those scancodes (its scantokey table): letters and punctuation are their
// lowercase ASCII, the arrows are 0xac-0xaf
const DOOM_KEY = { 17: 119, 31: 115, 30: 97, 32: 100, 18: 101, 72: 0xad, 80: 0xaf, 75: 0xac, 77: 0xae, 51: 44, 52: 46, 57: 32 };

/**
 * REBIND A RUNNING DOOM (operator, 2026-09-15: "have to refresh for settings to take effect").
 * DOOM reads its keys from default.cfg once, at start-up, into its defaults table: one 20-byte
 * entry a setting -- the name's address, the address of the live int, the default, whether the
 * value is a scancode, and the scancode as read (which is what the game writes back on quit). This
 * finds each key's entry by its name in the program's memory and writes both the live key code and
 * the scancode, so the change applies to the next key press and survives the config DOOM saves.
 * Returns how many settings it rewrote (0 before the program is loaded, or for an unknown build).
 */
export function rebindKeys(mem, controls, cache = {}) {
  const scheme = CONTROLS[controls];
  if (!scheme) return 0;
  const dv = new DataView(mem.buffer, mem.byteOffset, mem.length);
  const lo = 0x100000, hi = Math.min(mem.length - 32, 0x400000);   // where the loader puts the program
  let n = 0;
  for (const [key, scan] of Object.entries(scheme)) {
    let entry = cache[key];
    if (entry === undefined) {
      entry = null;
      const name = [...key].map((c) => c.charCodeAt(0)).concat(0);
      for (let i = lo; i < hi && entry === null; i++) {
        if (mem[i] !== name[0]) continue;
        let j = 1;
        while (j < name.length && mem[i + j] === name[j]) j++;
        if (j < name.length) continue;
        // a name alone is not proof (the linker packs strings, so no terminator need precede one):
        // the entry is the 4-aligned pointer to it whose scantranslate field says it is a key
        for (let p = lo & ~3; p < hi; p += 4) {
          if (dv.getUint32(p, true) === i && dv.getUint32(p + 12, true) === 1) { entry = p; break; }
        }
      }
      cache[key] = entry;
    }
    if (entry === null) continue;
    const live = dv.getUint32(entry + 4, true);
    if (live < lo || live >= hi) continue;
    dv.setInt32(live, DOOM_KEY[scan], true);
    dv.setInt32(entry + 16, scan, true);
    n++;
  }
  return n;
}

/**
 * DOOM's config (its `default.cfg`, bytes) with a control scheme laid over it. Every scheme turns
 * the mouse on: the shipped file has `use_mouse 0`, and a browser always has one. A key missing
 * from the file is appended rather than dropped, so a config the game wrote itself survives.
 */
export function withControls(bytes, controls = DEFAULT_CONTROLS) {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  const set = (key, value) => {
    const re = new RegExp(`^(${key}[ \\t]+)\\S+`, 'm');
    text = re.test(text) ? text.replace(re, `$1${value}`) : `${text.replace(/\s*$/, '')}\n${key}\t\t${value}\n`;
  };
  set('use_mouse', 1);
  for (const [k, v] of Object.entries(CONTROLS[controls] ?? {})) set(k, v);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

// ------------------------------------------------------------------ text mode
/** Code page 437 as Unicode, so text mode's box drawing and ENDOOM's blocks draw as they did. */
export const CP437 = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂'
  + 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀'
  + 'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** The sixteen text-mode colours, as CSS. */
export const CGA = ['#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
  '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff'];

/** An 80x25 text screen's cells as rows of runs: [{ x, y, text, fg, bg }], same colours merged. */
export function textRuns(cells) {
  const runs = [];
  for (let y = 0; y < 25; y++) {
    let cur = null;
    for (let x = 0; x < 80; x++) {
      const i = (y * 80 + x) * 2;
      const ch = CP437[cells[i]] ?? ' ', attr = cells[i + 1];
      const fg = CGA[attr & 15], bg = CGA[(attr >> 4) & 7];
      if (cur && cur.fg === fg && cur.bg === bg) cur.text += ch;
      else { cur = { x, y, text: ch, fg, bg }; runs.push(cur); }
    }
  }
  return runs;
}

// ------------------------------------------------------------------ the palette
/** The DAC's 768 six-bit components as little-endian ABGR pixels (what an ImageData's Uint32 view holds). */
export function paletteLut(pal, out = new Uint32Array(256)) {
  for (let i = 0; i < 256; i++) {
    const r = Math.round((pal[i * 3] & 63) * 255 / 63), g = Math.round((pal[i * 3 + 1] & 63) * 255 / 63), b = Math.round((pal[i * 3 + 2] & 63) * 255 / 63);
    out[i] = (0xff << 24 | (b << 16) | (g << 8) | r) >>> 0;
  }
  return out;
}
