// The top bar is one line whose items do not move.
//
// Operator, 2026-09-11: "Look at how text in upper right is being jammed up on
// resizing. We need to lock shit down better on that line. Too much dynamic
// shifting shit on a bar that should have the elements locked in place." The
// right-hand group was a plain flex row with nothing pinned: at ~1570 px the node
// name broke onto two lines, "sign-in · read-only" onto four, and the pause
// button was pushed off the edge.
//
// A stub cannot lay the bar out, so this holds the CSS contract that makes the
// layout deterministic; the browser screenshot is the check that it looks right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `a rule for ${sel} exists`);
  return m[2];
};

test('the bar cannot wrap, and the right-hand side cannot be squeezed', () => {
  assert.match(rule('header.top'), /flex-wrap:\s*nowrap/);
  assert.match(rule('header.top'), /white-space:\s*nowrap/);
  for (const sel of ['.top .meta', '.top .meta > span', '.userchip']) {
    assert.match(rule(sel), /white-space:\s*nowrap/, `${sel} never wraps`);
    assert.match(rule(sel), /flex:\s*0 0 auto/, `${sel} neither grows nor shrinks`);
  }
  assert.match(rule('.brand'), /flex:\s*0 0 auto/, 'the brand holds its width');
});

test('the nav is five menu titles, not a row of tabs, so it never needs to give way (2026-10-13)', () => {
  // operator: "a complete rework. Perhaps based on MacOS Finder menus ... what we have is just eating too much
  // valuable information space". The bar is one 28 px line at every width.
  const nav = rule('nav.pages');
  assert.match(nav, /flex:\s*0 0 auto/, 'it holds its width: five words');
  assert.match(nav, /height:\s*28px/);
  assert.match(rule('header.top'), /height:\s*28px/, 'the bar is 28 px');
  assert.match(rule('.menu'), /position:\s*relative/, 'each menu anchors its list');
  assert.match(rule('.menu-pop'), /position:\s*absolute/);
  assert.match(rule('.menu-pop'), /top:\s*100%/, 'the list hangs under its title');
  assert.doesNotMatch(css, /header\.top \{[^}]*flex-wrap:\s*wrap/, 'and nothing ever wraps the bar');
});

test('readouts that change reserve their widest value', () => {
  // "41ms" -> "1041ms" must not shove the neighbours; the stream's state is a dot of fixed size (2026-10-13)
  assert.match(rule('#sseState'), /min-width:\s*8px/);
  assert.match(rule('#sseState'), /border-radius:\s*50%/);
  for (const sel of ['#rpcLat', '#appUp']) {
    assert.match(rule(sel), /min-width:\s*\d+ch/, `${sel} has a fixed footprint`);
    assert.match(rule(sel), /tabular-nums/, `${sel} uses tabular digits`);
  }
  assert.match(rule('#nodePick > span'), /text-overflow:\s*ellipsis/, 'a long node label truncates instead of wrapping');
});

test('narrow windows drop whole items at fixed breakpoints, in a stated order', () => {
  const bps = [...css.matchAll(/@media \(max-width:\s*(\d+)px\)\s*\{([^@]*?)\}\s*\}/g)]
    .map((m) => ({ px: Number(m[1]), body: m[2] }))
    .filter((b) => /#whoami|\.brand small|\.pagename/.test(b.body));
  const at = (what) => bps.find((b) => b.body.includes(what))?.px;
  assert.ok(at('#whoami') > at('.brand small'), 'the access note goes first');
  assert.ok(at('.brand small') > at('.pagename'), 'then the version and the badge narrows, and the page name only on a phone');
});

test('the page is never wider than the window, whatever the bar needs', () => {
  // (operator, 2026-09-11: "it's rendering off the screen to the right. We need to
  // make sure the panel fits entirely into the viewspace"). The grid column took the
  // bar's min-content (~1164 px) and pushed every page off the right edge below it.
  assert.match(rule('.app'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'the column is held to the window');
  assert.match(rule('header.top'), /min-width:\s*0/, 'the bar may be narrower than its content');
  assert.match(rule('header.top'), /overflow:\s*clip visible/, 'and clips sideways rather than widening the page -- visible below, so the menus can hang out of it');
});
