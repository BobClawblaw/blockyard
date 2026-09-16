// APPEARANCE (operator, 2026-09-16: "We need to add an appearance section in preferences to change
// the colors of our layout. Our current scheme should be the default appearance, but add these
// options in Preferences, as well as options for configure custom schemes by allowing users to
// pick colors and save to settings so it sticks").
//
// The page is drawn from the CSS custom properties in app.css's :root -- background, panels, text,
// lines, the accent and the three semantic colours -- so a theme is a set of values for those, and
// applying one is writing them onto <html> through the CSSOM (element.style.setProperty). That is
// the one way to colour the page that the CSP allows: style-src 'self' refuses a style attribute
// in markup and a <style> element, and refuses neither a stylesheet nor a script setting a
// property (test/csp.test.js).
//
// The canvases do not read CSS. Every chart draws its axis text, grid lines and tooltips from
// literals of the shipped dark look, so a light theme would have put grey-on-grey text on a white
// card. They now read INK, the live object below, which applyTheme() refills: one object, mutated
// in place, so a chart mid-paint sees one theme and no chart reads getComputedStyle per frame.
//
// A theme has a dark and a light face (GitHub Dark Default and Light Default, Catppuccin Mocha and
// Latte, and so on) and the mode picks which: Dark, Light, or System (the OS's prefers-color-scheme,
// followed live). BlockYard's own dark face is the shipped look, value for value, so a monitor that
// never opens this tab draws exactly what it drew before. Custom takes nine colours from the
// pickers and derives the rest (a panel a shade lighter, a soft line, a faint text) from them.
import { loadSettings, onSettingsChange } from './settings.js';

/**
 * The charts' series and chrome colours (charts.js re-exports it): the shipped dark values until
 * applyTheme() refills them. One live object, so every module that imported it sees the theme.
 */
export const COL = {
  grid: '#20252d', axis: '#2c323c', text: '#6a7484', textDim: '#4d5665',
  accent: '#f7931a', ok: '#2ecc8f', warn: '#f0b429', bad: '#ef5a5a',
  info: '#58a6ff', purple: '#a78bfa', cyan: '#4dd0e1', pink: '#f06ba7',
};

// ------------------------------------------------------------------- colour arithmetic, tiny
const rgbOf = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexOf = ([r, g, b]) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
/** `t` of the way from `a` to `b`, as a hex. */
export const mix = (a, b, t) => {
  const x = rgbOf(a), y = rgbOf(b);
  if (!x || !y) return a;
  return hexOf(x.map((v, i) => v + (y[i] - v) * t));
};
/** Relative luminance, 0 (black) to 1 (white). */
export const luminance = (hex) => {
  const c = rgbOf(hex);
  if (!c) return 0;
  const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
};
/** A colour with an alpha, as rgba(): the canvases want translucent tooltips of the theme's panel. */
export const alpha = (hex, a) => {
  const c = rgbOf(hex);
  return c ? `rgba(${c[0]},${c[1]},${c[2]},${a})` : hex;
};

// ------------------------------------------------------------------- the faces
// The nine a custom theme is built from, in the order the pickers show them. Everything else in a
// face derives from these unless the preset says otherwise.
export const BASE_KEYS = Object.freeze(['bg', 'panel', 'text', 'muted', 'accent', 'line', 'ok', 'warn', 'bad']);

// The fixed colours of the two schemes: chart series, badges, a few labels. Not worth nine more
// pickers; they follow the scheme, not the theme.
const SCHEME = Object.freeze({
  dark: Object.freeze({ info: '#58a6ff', purple: '#a78bfa', cyan: '#4dd0e1', pink: '#f06ba7' }),
  light: Object.freeze({ info: '#2f6fd6', purple: '#7c5cd6', cyan: '#1a8a99', pink: '#c9407f' }),
});

/**
 * A whole face from nine (or more) colours. Every derived value is a mix toward a colour already
 * in the face, so a custom theme hangs together whatever the nine are: the raised panel is the
 * panel nudged toward the text, the soft line is the line nudged toward the background, the faint
 * text sits between the muted text and the background.
 */
export function derive(base) {
  const f = { ...base };
  const dark = luminance(f.bg) < 0.4;
  f.scheme = dark ? 'dark' : 'light';
  f.bg0 ??= mix(f.bg, dark ? '#000000' : '#ffffff', 0.25);           // the well: inputs, bars, code
  f.bg2 ??= mix(f.panel, f.text, dark ? 0.04 : 0.03);                // a raised panel
  f.bg3 ??= mix(f.panel, f.text, dark ? 0.09 : 0.07);                // a hover, a selected tab
  f.lineSoft ??= mix(f.line, f.bg, 0.4);
  f.faint ??= mix(f.muted, f.bg, 0.3);
  f.accentDim ??= mix(f.accent, f.bg, 0.35);
  f.accentInk ??= luminance(f.accent) > 0.45 ? '#17110a' : '#ffffff'; // text on an accent button
  f.hover ??= dark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.035)';
  f.scrim ??= dark ? 'rgba(2,5,9,0.62)' : 'rgba(20,24,30,0.42)';
  f.shadow ??= dark ? '0 1px 2px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.28)' : '0 1px 2px rgba(20,24,30,.08), 0 8px 24px rgba(20,24,30,.10)';
  for (const [k, v] of Object.entries(SCHEME[f.scheme])) f[k] ??= v;
  return f;
}

// Each preset: two faces of nine base colours, with the values the palette itself names given
// outright where it has them (GitHub and Catppuccin publish their scales; a derived shade would be
// near but not theirs).
export const PRESETS = Object.freeze({
  blockyard: {
    label: 'BlockYard', blurb: 'The shipped look — charcoal and bitcoin orange',
    // THE SHIPPED LOOK, value for value from app.css (2026-09-16): the default must draw what the
    // monitor drew before this tab existed, so nothing here is derived
    dark: { bg: '#0b0d10', panel: '#12151a', bg2: '#171b21', bg3: '#1e232b', bg0: '#0c0e11', line: '#262c36', lineSoft: '#1d222a', text: '#dfe5ee', muted: '#96a0b0', faint: '#6a7484', accent: '#f7931a', accentDim: '#b06c10', accentInk: '#17110a', ok: '#2ecc8f', warn: '#f0b429', bad: '#ef5a5a' },
    light: { bg: '#f3f1ec', panel: '#ffffff', bg2: '#f8f6f2', bg3: '#eeeae3', bg0: '#ebe7e0', line: '#d8d2c8', lineSoft: '#e6e1d8', text: '#1c1f26', muted: '#5b6470', faint: '#8a929e', accent: '#e8850f', accentDim: '#b8690a', accentInk: '#1a1206', ok: '#1f9d63', warn: '#c48a08', bad: '#d63f3f' },
  },
  mono: {
    label: 'Mono', blurb: 'Clean grayscale — minimal and focused',
    dark: { bg: '#0f0f0f', panel: '#161616', bg2: '#1b1b1b', bg3: '#232323', line: '#2c2c2c', text: '#e8e8e8', muted: '#9a9a9a', faint: '#6b6b6b', accent: '#f2f2f2', accentDim: '#9a9a9a', ok: '#9ccfae', warn: '#d9c48a', bad: '#d99090', info: '#a9b9c9', purple: '#b8aed6', cyan: '#9fcad0', pink: '#d3a4bc' },
    light: { bg: '#f4f4f4', panel: '#ffffff', bg2: '#f8f8f8', bg3: '#ececec', line: '#d5d5d5', text: '#151515', muted: '#5a5a5a', faint: '#8c8c8c', accent: '#111111', accentDim: '#555555', ok: '#2f8f5b', warn: '#a37a12', bad: '#c04747', info: '#3a5f8a', purple: '#5d4f8a', cyan: '#2a6f78', pink: '#8a4468' },
  },
  nous: {
    label: 'Nous', blurb: 'GitHub chrome, Nous blue accent',
    dark: { bg: '#0d1117', panel: '#161b22', bg2: '#1c2128', bg3: '#21262d', bg0: '#010409', line: '#30363d', lineSoft: '#262c34', text: '#e6edf3', muted: '#8b949e', faint: '#6e7681', accent: '#4d9fff', accentDim: '#2b6fd6', ok: '#3fb950', warn: '#d29922', bad: '#f85149', info: '#79c0ff', purple: '#a371f7', cyan: '#39c5cf', pink: '#db61a2' },
    light: { bg: '#f6f8fa', panel: '#ffffff', bg2: '#f6f8fa', bg3: '#eaeef2', bg0: '#eff2f5', line: '#d0d7de', lineSoft: '#e1e6eb', text: '#1f2328', muted: '#656d76', faint: '#8c959f', accent: '#1f6fe0', accentDim: '#0a4fb5', ok: '#1a7f37', warn: '#9a6700', bad: '#cf222e', info: '#0969da', purple: '#8250df', cyan: '#1b7c83', pink: '#bf3989' },
  },
  github: {
    label: 'GitHub', blurb: 'GitHub Light Default and Dark Default',
    dark: { bg: '#0d1117', panel: '#161b22', bg2: '#1c2128', bg3: '#21262d', bg0: '#010409', line: '#30363d', lineSoft: '#262c34', text: '#e6edf3', muted: '#8b949e', faint: '#6e7681', accent: '#3fb950', accentDim: '#238636', accentInk: '#ffffff', ok: '#3fb950', warn: '#d29922', bad: '#f85149', info: '#58a6ff', purple: '#a371f7', cyan: '#39c5cf', pink: '#db61a2' },
    light: { bg: '#f6f8fa', panel: '#ffffff', bg2: '#f6f8fa', bg3: '#eaeef2', bg0: '#eff2f5', line: '#d0d7de', lineSoft: '#e1e6eb', text: '#1f2328', muted: '#656d76', faint: '#8c959f', accent: '#1f883d', accentDim: '#1a7f37', accentInk: '#ffffff', ok: '#1a7f37', warn: '#9a6700', bad: '#cf222e', info: '#0969da', purple: '#8250df', cyan: '#1b7c83', pink: '#bf3989' },
  },
  catppuccin: {
    label: 'Catppuccin', blurb: 'Soothing pastels — Latte and Mocha',
    dark: { bg: '#181825', panel: '#1e1e2e', bg2: '#242438', bg3: '#313244', bg0: '#11111b', line: '#45475a', lineSoft: '#313244', text: '#cdd6f4', muted: '#a6adc8', faint: '#6c7086', accent: '#fab387', accentDim: '#c98a62', accentInk: '#1e1e2e', ok: '#a6e3a1', warn: '#f9e2af', bad: '#f38ba8', info: '#89b4fa', purple: '#cba6f7', cyan: '#94e2d5', pink: '#f5c2e7' },
    light: { bg: '#e6e9ef', panel: '#eff1f5', bg2: '#e9ecf2', bg3: '#dce0e8', bg0: '#dce0e8', line: '#bcc0cc', lineSoft: '#ccd0da', text: '#4c4f69', muted: '#6c6f85', faint: '#9ca0b0', accent: '#fe640b', accentDim: '#d1520a', accentInk: '#ffffff', ok: '#40a02b', warn: '#df8e1d', bad: '#d20f39', info: '#1e66f5', purple: '#8839ef', cyan: '#179299', pink: '#ea76cb' },
  },
});
export const PRESET_IDS = Object.freeze(Object.keys(PRESETS));

// ------------------------------------------------------------------- choosing
/** Whether the OS asks for light. Stubbed in tests; absent on a server. */
const systemLight = (win = globalThis.window) => {
  try { return !!win?.matchMedia?.('(prefers-color-scheme: light)')?.matches; } catch { return false; }
};

/** The scheme the settings resolve to: 'dark' or 'light'. */
export function resolveScheme(appearance, win = globalThis.window) {
  const mode = appearance?.mode ?? 'dark';
  if (mode === 'system') return systemLight(win) ? 'light' : 'dark';
  return mode === 'light' ? 'light' : 'dark';
}

/** The nine custom colours from the settings, as a base for derive(). */
export function customBase(a) {
  return { bg: a.customBg, panel: a.customPanel, text: a.customText, muted: a.customMuted, accent: a.customAccent, line: a.customLine, ok: a.customOk, warn: a.customWarn, bad: a.customBad };
}

/**
 * The face a settings object asks for, whole. A preset's face is derived from its own values (so
 * a preset that names bg2 keeps it and one that does not gets the mix); Custom is derived from the
 * nine pickers, and its scheme is whatever its background says it is, whatever the mode.
 */
export function resolveTheme(settings, win = globalThis.window) {
  const a = (settings ?? loadSettings()).appearance ?? {};
  const scheme = resolveScheme(a, win);
  if (a.theme === 'custom') return { id: 'custom', scheme: null, ...derive(customBase(a)) };
  const preset = PRESETS[a.theme] ?? PRESETS.blockyard;
  return { id: PRESETS[a.theme] ? a.theme : 'blockyard', ...derive(preset[scheme]) };
}

/** The face of a preset in a scheme, for the cards' swatches. */
export function presetFace(id, scheme) { return derive(PRESETS[id][scheme === 'light' ? 'light' : 'dark']); }

// ------------------------------------------------------------------- applying
/** face key -> CSS custom property */
const VARS = Object.freeze({
  bg: '--bg', panel: '--bg-1', bg2: '--bg-2', bg3: '--bg-3', bg0: '--bg-0', line: '--line', lineSoft: '--line-soft',
  text: '--fg', muted: '--fg-dim', faint: '--fg-faint', accent: '--accent', accentDim: '--accent-dim', accentInk: '--accent-ink',
  ok: '--ok', warn: '--warn', bad: '--bad', info: '--info', purple: '--purple', cyan: '--cyan', pink: '--pink',
  hover: '--hover', scrim: '--scrim', shadow: '--shadow',
});

/**
 * What the canvases draw their chrome with. Filled by applyTheme(); the shipped dark values until
 * then, so a chart painted before any theme is applied (there is none: app.js applies at import)
 * still looks as it always did.
 */
export const INK = {
  grid: '#20252d', axis: '#2c323c', text: '#6a7484', textDim: '#4d5665', axisText: '#7d8898', bright: '#e8edf5', label: '#b9c3d1',
  panel: '#12151a', panelLine: '#3d4552', tip: 'rgba(12,14,17,0.91)', tipLine: '#2c323c', tipText: '#c7cfdb',
  bg: '#0b0d10', faintLine: 'rgba(255,255,255,0.19)', dash: 'rgba(200,215,230,0.45)', cursorFill: '#3a4452', cursorText: '#ffffff',
  // the order book's two sides: neon on a dark ground, the theme's own good and bad on a light one
  bid: '#3dff7a', ask: '#ff4545', bidT: 'rgba(61,255,122,0.32)', askT: 'rgba(255,69,69,0.32)', bidThen: 'rgba(61,255,122,0.55)', askThen: 'rgba(255,69,69,0.55)', bidHalf: 'rgba(61,255,122,0.5)', askHalf: 'rgba(255,69,69,0.5)',
  scheme: 'dark',
};

const inkOf = (f) => {
  const dark = f.scheme === 'dark';
  return {
    grid: f.lineSoft, axis: f.line, text: f.faint, textDim: mix(f.faint, f.bg, 0.3), axisText: mix(f.faint, f.muted, 0.5), bright: f.text, label: mix(f.text, f.muted, 0.3),
    panel: f.panel, panelLine: mix(f.line, f.text, 0.15), tip: alpha(f.bg0, 0.92), tipLine: f.line, tipText: mix(f.text, f.muted, 0.15),
    bg: f.bg, faintLine: dark ? 'rgba(255,255,255,0.19)' : 'rgba(0,0,0,0.16)', dash: dark ? 'rgba(200,215,230,0.45)' : 'rgba(40,50,60,0.45)',
    cursorFill: f.bg3, cursorText: f.text,
    bid: dark ? '#3dff7a' : f.ok, ask: dark ? '#ff4545' : f.bad,
    bidT: alpha(dark ? '#3dff7a' : f.ok, 0.32), askT: alpha(dark ? '#ff4545' : f.bad, 0.32),
    bidThen: alpha(dark ? '#3dff7a' : f.ok, 0.55), askThen: alpha(dark ? '#ff4545' : f.bad, 0.55),
    bidHalf: alpha(dark ? '#3dff7a' : f.ok, 0.5), askHalf: alpha(dark ? '#ff4545' : f.bad, 0.5),
    scheme: f.scheme,
  };
};

/**
 * Put a face on the page: the custom properties on <html>, `data-theme` and `color-scheme` for the
 * stylesheet and the browser's own controls, and INK and the charts' COL for the canvases.
 * Returns the face. Safe without a document (tests pass a stub root).
 */
export function applyTheme(settings, { root = globalThis.document?.documentElement, win = globalThis.window } = {}) {
  const f = resolveTheme(settings, win);
  if (root?.style?.setProperty) {
    for (const [k, v] of Object.entries(VARS)) if (f[k]) root.style.setProperty(v, f[k]);
    root.style.setProperty('color-scheme', f.scheme);
    root.setAttribute?.('data-theme', f.scheme);
    root.setAttribute?.('data-palette', f.id);
  }
  Object.assign(INK, inkOf(f));
  Object.assign(COL, { grid: f.lineSoft, axis: f.line, text: f.faint, textDim: INK.textDim, accent: f.accent, ok: f.ok, warn: f.warn, bad: f.bad, info: f.info, purple: f.purple, cyan: f.cyan, pink: f.pink });
  try { const meta = globalThis.document?.querySelector?.('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', f.bg); } catch { /* fine */ }
  return f;
}

/**
 * Keep the page on the settings: apply now, again on every settings change, and again when the
 * OS switches scheme while the mode is System. Returns a stop function.
 */
export function followTheme(opts = {}) {
  applyTheme(loadSettings(), opts);
  const off = onSettingsChange((s) => applyTheme(s, opts));
  const win = opts.win ?? globalThis.window;
  let mq = null;
  const onChange = () => { if ((loadSettings().appearance?.mode ?? 'dark') === 'system') applyTheme(loadSettings(), opts); };
  try { mq = win?.matchMedia?.('(prefers-color-scheme: light)'); mq?.addEventListener?.('change', onChange); } catch { mq = null; }
  return () => { off(); try { mq?.removeEventListener?.('change', onChange); } catch { /* fine */ } };
}
