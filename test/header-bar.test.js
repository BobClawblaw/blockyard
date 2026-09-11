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

test('the nav is the one part that gives way, by scrolling', () => {
  const nav = rule('nav.pages');
  assert.match(nav, /flex:\s*0 1 auto/, 'it may shrink');
  assert.match(nav, /min-width:\s*0/, 'below its content width');
  assert.match(nav, /overflow-x:\s*auto/, 'and scrolls instead of wrapping or overlapping');
});

test('readouts that change reserve their widest value', () => {
  // "connecting" -> "live" and "41ms" -> "1041ms" must not shove the neighbours
  assert.match(rule('#sseState'), /min-width:\s*10ch/);
  for (const sel of ['#rpcLat', '#appUp']) {
    assert.match(rule(sel), /min-width:\s*\d+ch/, `${sel} has a fixed footprint`);
    assert.match(rule(sel), /tabular-nums/, `${sel} uses tabular digits`);
  }
  assert.match(rule('#nodePick > span'), /text-overflow:\s*ellipsis/, 'a long node label truncates instead of wrapping');
});

test('narrow windows drop whole items at fixed breakpoints, in a stated order', () => {
  const bps = [...css.matchAll(/@media \(max-width:\s*(\d+)px\)\s*\{([^@]*?)\}\s*\}/g)]
    .map((m) => ({ px: Number(m[1]), body: m[2] }))
    .filter((b) => /#whoami|Monitor uptime|Node RPC round trip/.test(b.body));
  const at = (what) => bps.find((b) => b.body.includes(what))?.px;
  assert.ok(at('#whoami') > at('Monitor uptime'), 'the access note goes first');
  assert.ok(at('Monitor uptime') > at('Node RPC round trip'), 'then uptime, then rpc latency');
});

test('the page is never wider than the window, whatever the bar needs', () => {
  // (operator, 2026-09-11: "it's rendering off the screen to the right. We need to
  // make sure the panel fits entirely into the viewspace"). The grid column took the
  // bar's min-content (~1164 px) and pushed every page off the right edge below it.
  assert.match(rule('.app'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'the column is held to the window');
  assert.match(rule('header.top'), /min-width:\s*0/, 'the bar may be narrower than its content');
  assert.match(rule('header.top'), /overflow:\s*hidden/, 'and clips rather than widening the page');
});
