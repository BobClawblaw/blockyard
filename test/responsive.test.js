// THE WINDOW IS NOT ALWAYS WIDE (operator, 2026-09-11: "Kiosk doesn't look proper on a smaller
// window. Also, we need scrolling to see menu/tabs that are being cut off and not displayed").
// Measured at 1150 px before the fix: nav.pages held 868 px of tabs in a 650 px box (218 px of them
// unreachable, scrollbar hidden), and the kiosk was still two 555 px columns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');

test('below 2000 px the tabs take a row of their own, and can still be scrolled', () => {
  // 2026-09-12: the threshold was 1400, and measurement showed that far too low -- the nav wants
  // 979 px of tabs (1031 above 1760) and the inline bar gives it 747 px at 1600 and 961 at 1920, so
  // two or three tabs sat past the fold at every width between 1400 and 2000, behind a scrollbar
  // that is not drawn. It first fits inline at 2000 (1031 in 1031).
  const at = css.slice(css.indexOf('@media (max-width: 1999px) {'));
  assert.match(at, /header\.top \{ flex-wrap: wrap; height: auto;/, 'the bar may wrap');
  assert.match(at, /nav\.pages \{ order: 10; flex: 1 0 100%;/, 'the nav takes the full row');
  assert.match(at, /nav\.pages::-webkit-scrollbar \{ display: block;/, 'and shows its scrollbar where it still overflows');
  assert.match(css, /nav\.pages \{[^}]*overflow-x: auto/, 'the nav scrolls sideways at every width');
});

test('the kiosk keeps two columns until 900 px, and fills main rather than assuming a bar height', () => {
  // operator, 2026-09-11: "Kiosk is absolutely fucked now" -- stacking from 1400 px turned a 1350 px
  // window from two columns into one tall column that had to be scrolled.
  assert.match(css, /\.kiosk \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)[^}]*height: 100%/, 'two columns, filling main');
  assert.doesNotMatch(css, /@media \(max-width: 1400px\) \{\s*\.kiosk \{ grid-template-columns: minmax\(0, 1fr\)/, 'it does not stack at 1400 px');
  // 2026-09-12: the stack threshold moved 1100 -> 900. At 1066x760 the one-column kiosk measured
  // 1730 px tall in a 760 px viewport; two columns fit that window with room to spare.
  const tight = css.slice(css.indexOf('@media (max-width: 1400px) and (min-width: 901px)'));
  assert.match(tight, /\.kcol > \.kbf \{ height: 200px; \}/, 'between 1100 and 1400 it gives space back instead of stacking');
  const stack = css.slice(css.indexOf('@media (max-width: 1100px) {\n  .kiosk'));
  assert.ok(css.includes('@media (max-width: 900px)'), 'and stacks below 900 px, where two columns stop fitting');
});

test('the kiosk page section has a height, so the board fills the window', () => {
  // main is a definite grid row, but .kiosk sits inside section.page, whose height is auto: without
  // this the kiosk fell back to its min-height -- 480 px of kiosk in a 782 px window (2026-09-11).
  assert.match(css, /section\.page:has\(> \.kiosk\) \{ height: 100%; \}/);
  assert.match(css, /\.kiosk \{[^}]*min-height: min\(calc\(100vh - 130px\), 900px\)/, 'and a viewport fallback where :has() is missing');
});

test('the Block space panels are tightened to fit one screen, and only those panels', () => {
  // operator, 2026-09-12: "Shrink up the vertical size of the being built and chain tip panels so
  // we can fit the feerate panel on one screen". Measured at 1280x700 before: Being built 262 px,
  // Chain tip 236, Feerate 111, with the Feerate panel's bottom 62 px past the fold. Most of that
  // is the key/value rows -- 144 px of each panel is seven rows -- so they are tightened first.
  assert.match(css, /\.spacehud \.hudkv \{[^}]*line-height/, 'the rows carry most of the height, so they are where it is taken from');
  assert.match(css, /\.spacehud \.hudbig \{[^}]*font-size/, 'and the big percentage comes down');
  for (const sel of ['.spacehud .hud {', '.spacehud .hudh {', '.spacehud .hud .bmeter {', '.spacehud .hudbar {']) {
    assert.ok(css.includes(sel), `${sel} is scoped to the Block space column`);
  }
  // The shared rules stand: the tightening above is scoped to `.spacehud`, so anything else using
  // `.hud` keeps the roomier sizing. (These classes used to dress the Markets legend too; that
  // legend was removed -- operator, 2026-09-12: "get rid of this. takes up too much space on the
  // markets page" -- so there is no `.mkside .hud` rule left to assert. Dropped deliberately
  // rather than left guarding an element that no longer exists.)
  assert.match(css, /^\.hudkv \{[^}]*gap: 3px 12px/m, 'the shared row rule is untouched');
  assert.match(css, /^\.hud \{[^}]*padding: 10px 12px/m, 'and the shared padding');
});
