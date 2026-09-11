// THE WINDOW IS NOT ALWAYS WIDE (operator, 2026-09-11: "Kiosk doesn't look proper on a smaller
// window. Also, we need scrolling to see menu/tabs that are being cut off and not displayed").
// Measured at 1150 px before the fix: nav.pages held 868 px of tabs in a 650 px box (218 px of them
// unreachable, scrollbar hidden), and the kiosk was still two 555 px columns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');

test('below 1400 px the tabs take a row of their own, and can still be scrolled', () => {
  const at = css.slice(css.indexOf('@media (max-width: 1400px) {'));
  assert.match(at, /header\.top \{ flex-wrap: wrap; height: auto;/, 'the bar may wrap');
  assert.match(at, /nav\.pages \{ order: 10; flex: 1 0 100%;/, 'the nav takes the full row');
  assert.match(at, /nav\.pages::-webkit-scrollbar \{ display: block;/, 'and shows its scrollbar where it still overflows');
  assert.match(css, /nav\.pages \{[^}]*overflow-x: auto/, 'the nav scrolls sideways at every width');
});

test('the kiosk stacks into one column below 1400 px, at its own height, and main scrolls', () => {
  const at = css.slice(css.indexOf('/* ONE COLUMN SOONER'));
  assert.match(at, /@media \(max-width: 1400px\) \{/);
  assert.match(at, /\.kiosk \{ grid-template-columns: minmax\(0, 1fr\)[^}]*height: auto/, 'one column, its own height');
  assert.match(at, /\.kcol > \.kmk \.kboard, \.kcol > \.ksp \.kboard \{ height: 58vh/, 'each board keeps a readable height');
  assert.match(css, /^main \{ overflow: auto;/m, 'so the page can scroll to the rest of it');
});
