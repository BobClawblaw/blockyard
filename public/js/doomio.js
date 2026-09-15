// DOOM I/O: the pure pieces between a browser and the emulated PC (operator, 2026-09-15: "Get DOOM
// working as a diversion inside blockyard with zero dependancies"). No DOM, no worker, no clock, so
// every mapping here runs under node:test.
//
//   scancodes()      a KeyboardEvent.code as the bytes a PC/AT keyboard puts on port 60h
//   withControls()   the game's config with the page's control scheme laid over it
//   CP437 / CGA      how text mode's bytes and attributes become characters and colours
//   paletteLut()     the VGA DAC's 6-bit palette as 32-bit pixels for an ImageData

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
/** Scancodes the two control schemes bind, by DOOM's config key. */
export const CONTROLS = {
  classic: { key_up: 72, key_down: 80, key_left: 75, key_right: 77, key_strafeleft: 51, key_straferight: 52, key_use: 57 },
  wasd: { key_up: 17, key_down: 31, key_left: 75, key_right: 77, key_strafeleft: 30, key_straferight: 32, key_use: 18 },
};

/**
 * DOOM's config (its `default.cfg`, bytes) with a control scheme laid over it. Every scheme turns
 * the mouse on: the shipped file has `use_mouse 0`, and a browser always has one. A key missing
 * from the file is appended rather than dropped, so a config the game wrote itself survives.
 */
export function withControls(bytes, controls = 'classic') {
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
