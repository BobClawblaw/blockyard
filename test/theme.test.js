// APPEARANCE (operator, 2026-09-16: "add an appearance section in preferences to change the colors
// of our layout. Our current scheme should be the default appearance ... custom schemes by allowing
// users to pick colors and save to settings so it sticks"). What is held here: the default is the
// shipped look value for value; every preset has a complete light and dark face; the mode picks the
// face and System follows the OS; Custom is the nine pickers with the rest derived and its scheme
// read off its background; applying a theme writes the page's custom properties through the CSSOM
// and refills the canvases' ink; and the choice persists through the settings store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PRESETS, PRESET_IDS, BASE_KEYS, derive, resolveScheme, resolveTheme, presetFace, applyTheme, followTheme, INK, COL, mix, luminance,
} from '../public/js/theme.js';
import { DEFAULTS, PANEL, normalise, saveSettings, loadSettings, setSetting } from '../public/js/settings.js';

const HEX = /^#[0-9a-f]{6}$/;
const FACE_KEYS = ['bg', 'panel', 'bg2', 'bg3', 'bg0', 'line', 'lineSoft', 'text', 'muted', 'faint', 'accent', 'accentDim', 'accentInk', 'ok', 'warn', 'bad', 'info', 'purple', 'cyan', 'pink'];
const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const fakeRoot = () => {
  const props = new Map(), attrs = new Map();
  return { props, attrs, style: { setProperty: (k, v) => props.set(k, v) }, setAttribute: (k, v) => attrs.set(k, v) };
};
const fakeWin = (light) => ({ matchMedia: (q) => ({ matches: light && q.includes('light'), addEventListener() {}, removeEventListener() {} }) });

test('the default appearance is the shipped look, value for value', () => {
  const s = normalise(null);
  assert.equal(s.appearance.mode, 'dark');
  assert.equal(s.appearance.theme, 'blockyard');
  const face = resolveTheme(s);
  assert.equal(face.id, 'blockyard');
  // the :root block of app.css, which is what the page drew before the tab existed
  const css = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const cssVar = (name) => root.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`))?.[1];
  for (const [k, v] of [['bg', '--bg'], ['panel', '--bg-1'], ['bg2', '--bg-2'], ['bg3', '--bg-3'], ['bg0', '--bg-0'], ['line', '--line'], ['lineSoft', '--line-soft'], ['text', '--fg'], ['muted', '--fg-dim'], ['faint', '--fg-faint'], ['accent', '--accent'], ['accentDim', '--accent-dim'], ['accentInk', '--accent-ink'], ['ok', '--ok'], ['warn', '--warn'], ['bad', '--bad'], ['info', '--info']]) {
    assert.equal(face[k], cssVar(v), `${k} is the stylesheet's ${v}`);
  }
  // and Custom's pickers start from the same values, so "customise" from nothing is the shipped look too
  for (const k of BASE_KEYS) assert.equal(s.appearance[`custom${k[0].toUpperCase()}${k.slice(1)}`], face[k], `custom ${k} starts as the default`);
  // the chart ink before any theme is applied is the dark look as well
  assert.equal(INK.scheme, 'dark');
  assert.equal(COL.accent, '#f7931a');
});

test('every preset has a whole light face and a whole dark face, and the panel offers each of them', () => {
  assert.deepEqual(PRESET_IDS, ['blockyard', 'mono', 'nous', 'github', 'catppuccin']);
  for (const id of PRESET_IDS) {
    assert.ok(PRESETS[id].label && PRESETS[id].blurb, `${id} has a name and a line about it`);
    for (const scheme of ['dark', 'light']) {
      const f = presetFace(id, scheme);
      assert.equal(f.scheme, scheme, `${id}'s ${scheme} face reads as ${scheme} from its background`);
      for (const k of FACE_KEYS) assert.match(f[k] ?? '', HEX, `${id} ${scheme} has ${k}`);
      // text must stand off the page: the lightness gap between them is the least a page can have
      const gap = Math.abs(luminance(f.text) - luminance(f.bg));
      assert.ok(gap > 0.5, `${id} ${scheme}: text (${f.text}) stands off the page (${f.bg}), gap ${gap.toFixed(2)}`);
    }
  }
  const row = PANEL.find((g) => g.group === 'appearance').rows.find((r) => r.key === 'theme');
  assert.equal(row.kind, 'cards');
  assert.deepEqual(row.options.map(([v]) => v), [...PRESET_IDS, 'custom']);
  const mode = PANEL.find((g) => g.group === 'appearance').rows.find((r) => r.key === 'mode');
  assert.equal(mode.kind, 'segment');
  assert.deepEqual(mode.options.map(([v]) => v), ['light', 'dark', 'system']);
  assert.equal(PANEL[0].group, 'appearance', 'the tab comes first');
});

test('the mode picks the face; System follows the operating system', () => {
  assert.equal(resolveScheme({ mode: 'dark' }), 'dark');
  assert.equal(resolveScheme({ mode: 'light' }), 'light');
  assert.equal(resolveScheme({ mode: 'system' }, fakeWin(true)), 'light');
  assert.equal(resolveScheme({ mode: 'system' }, fakeWin(false)), 'dark');
  assert.equal(resolveScheme({ mode: 'system' }, undefined), 'dark', 'no window (a server, a test): dark');
  const light = resolveTheme(normalise({ appearance: { mode: 'light', theme: 'github' } }));
  assert.equal(light.bg, '#f6f8fa', 'GitHub Light Default');
  const dark = resolveTheme(normalise({ appearance: { mode: 'dark', theme: 'github' } }));
  assert.equal(dark.bg, '#0d1117', 'GitHub Dark Default');
  assert.equal(resolveTheme(normalise({ appearance: { mode: 'dark', theme: 'catppuccin' } })).panel, '#1e1e2e', 'Mocha base');
  assert.equal(resolveTheme(normalise({ appearance: { mode: 'light', theme: 'catppuccin' } })).panel, '#eff1f5', 'Latte base');
  assert.equal(resolveTheme(normalise({ appearance: { theme: 'no-such' } })).id, 'blockyard', 'an unknown theme is the default (normalise refuses it too)');
});

test('Custom is the nine pickers with the rest derived, and its scheme is read off its background', () => {
  const nine = { customBg: '#fafafa', customPanel: '#ffffff', customText: '#101418', customMuted: '#556070', customAccent: '#0055ff', customLine: '#d0d4da', customOk: '#118844', customWarn: '#aa7700', customBad: '#cc2233' };
  const s = normalise({ appearance: { mode: 'dark', theme: 'custom', ...nine } });
  const f = resolveTheme(s);
  assert.equal(f.id, 'custom');
  assert.equal(f.scheme, 'light', 'a light background makes a light theme, whatever the mode says');
  assert.equal(f.bg, '#fafafa'); assert.equal(f.accent, '#0055ff'); assert.equal(f.bad, '#cc2233');
  for (const k of FACE_KEYS) assert.match(f[k] ?? '', HEX, `custom derives ${k}`);
  assert.equal(f.accentInk, '#ffffff', 'white text on a dark accent');
  assert.equal(f.bg2, mix('#ffffff', '#101418', 0.03), 'the raised panel is the panel nudged toward the text');
  assert.equal(f.lineSoft, mix('#d0d4da', '#fafafa', 0.4), 'the soft line is the line nudged toward the page');
  assert.equal(f.faint, mix('#556070', '#fafafa', 0.3), 'faint text sits between muted text and the page');
  assert.ok(luminance(f.bg0) > luminance(f.bg), 'on a light page the well is lighter still');
  const d = derive({ bg: '#101010', panel: '#181818', text: '#eeeeee', muted: '#999999', accent: '#ffcc00', line: '#333333', ok: '#0f0', warn: '#ff0', bad: '#f00' });
  assert.equal(d.scheme, 'dark');
  assert.equal(d.accentInk, '#17110a', 'dark text on a bright accent');
  assert.ok(luminance(d.bg0) < luminance(d.bg), 'on a dark page the well is darker still');
  // a picker refuses anything but a hex, and a bad one falls back to the shipped colour
  assert.equal(normalise({ appearance: { customBg: 'red' } }).appearance.customBg, '#0b0d10');
  assert.equal(normalise({ appearance: { customAccent: '#ABCDEF' } }).appearance.customAccent, '#abcdef', 'lower-cased');
});

test('applying a theme writes the custom properties through the CSSOM and refills the canvases’ ink', () => {
  const root = fakeRoot();
  const f = applyTheme(normalise({ appearance: { mode: 'light', theme: 'catppuccin' } }), { root, win: fakeWin(false) });
  assert.equal(root.props.get('--bg'), '#e6e9ef');
  assert.equal(root.props.get('--bg-1'), '#eff1f5');
  assert.equal(root.props.get('--fg'), '#4c4f69');
  assert.equal(root.props.get('--accent'), '#fe640b');
  assert.equal(root.props.get('--accent-ink'), '#ffffff');
  assert.equal(root.props.get('color-scheme'), 'light', 'the browser’s own controls follow');
  assert.equal(root.attrs.get('data-theme'), 'light');
  assert.equal(root.attrs.get('data-palette'), 'catppuccin');
  // no style attribute is written: setProperty only (the CSP refuses a style attribute in markup)
  assert.ok(!root.attrs.has('style'));
  // the canvases
  assert.equal(INK.scheme, 'light');
  assert.equal(INK.bright, f.text);
  assert.equal(INK.grid, f.lineSoft);
  assert.equal(COL.accent, '#fe640b');
  assert.equal(COL.ok, '#40a02b');
  // and back to the default puts every value back, ink included
  applyTheme(normalise(null), { root, win: fakeWin(false) });
  assert.equal(root.props.get('--bg'), '#0b0d10');
  assert.equal(root.props.get('color-scheme'), 'dark');
  assert.equal(INK.scheme, 'dark');
  assert.equal(COL.accent, '#f7931a');
  assert.equal(INK.tip, 'rgba(12,14,17,0.92)', 'a translucent tooltip of the theme’s well');
});

test('the choice persists through the settings store, and the page follows a change', () => {
  const st = store();
  saveSettings({ appearance: { mode: 'light', theme: 'mono' } }, st);
  const back = loadSettings(st);
  assert.equal(back.appearance.mode, 'light');
  assert.equal(back.appearance.theme, 'mono');
  assert.equal(JSON.parse(st.getItem('blockyard.settings')).appearance.theme, 'mono', 'written to the store (the server hears it through the push)');
  // followTheme: applied now, again on a change, stopped after
  const root = fakeRoot();
  const stop = followTheme({ root, win: fakeWin(false) });
  const before = root.props.get('--bg');
  saveSettings({ appearance: { mode: 'dark', theme: 'github' } }, st);
  assert.equal(root.props.get('--bg'), '#0d1117', 'a save re-applies');
  assert.notEqual(root.props.get('--bg'), before);
  stop();
  setSetting(loadSettings(st), 'appearance.theme', 'catppuccin', st);
  assert.equal(root.props.get('--bg'), '#0d1117', 'after stop, no longer followed');
  // leave the module ink on the default for any test after this one
  applyTheme(normalise(null), { root, win: fakeWin(false) });
});

test('the stylesheet draws its chrome from the tokens the theme sets, not from literals of the dark look', () => {
  const css = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const body = css.slice(css.indexOf('}', css.indexOf(':root {')));   // after the token block
  // the well, the primary button's ink, the tinted boxes: each was a literal until the themes
  for (const lit of ['#0c0e11', '#17110a', '#1c1214', '#1b1a12', '#ffffff06', 'rgba(247, 147, 26, 0.1)']) {
    assert.ok(!body.includes(lit), `${lit} is a token now`);
  }
  for (const tok of ['--bg-0', '--accent-ink', '--hover', '--scrim', 'color-scheme']) assert.ok(css.includes(tok), `${tok} is declared`);
  // the cards and the segment have their styles
  for (const cls of ['.thcard', '.thsw', '.cfgseg', '.cfgsegbtn.on', '.cfgrow.idle']) assert.ok(css.includes(cls), `${cls} is styled`);
});

test('every chart draws its axis text, grid and tooltips from the theme’s ink', () => {
  for (const f of ['charts', 'pricechart', 'depthchart']) {
    const src = fs.readFileSync(new URL(`../public/js/${f}.js`, import.meta.url), 'utf8');
    assert.ok(src.includes("from './theme.js'"), `${f}.js reads the theme`);
    // no literal grey for text or grid lines left in the chrome (series colours are their own)
    for (const lit of ["'#6a7484'", "'#7d8898'", "'#1a2029'", "'#2a323d'", "'#e8edf5'", "'#dfe6ee'", "'#ffffff'"]) {
      assert.ok(!src.includes(lit), `${f}.js no longer draws with ${lit}`);
    }
  }
});
