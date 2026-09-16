// THE DIVERSIONS MENU (operator, 2026-09-12: "Move Tetrust and Blockout to the very end of the menu
// options under a pop-down menu called 'Diversions'").
//
// Measured before this was pinned: at a 1600px window the nav ended at "Eve(nts)" and neither the
// menu nor its open panel was on screen at all. Two separate traps, both invisible to a green
// suite and both worth a guard:
//
//   1. `nav.pages` is a scroll container (overflow-x:auto, scrollbar hidden), so the LAST thing in
//      the nav is the first to scroll out of reach. The menu is sticky to the right edge.
//   2. A box with overflow-x:auto clips the other axis too, and `header.top` is overflow:hidden
//      besides -- so a panel positioned inside either is simply not drawn. The panel is fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const html = read('index.html'), css = read('css/app.css'), app = read('js/app.js');
const rule = (sel) => css.match(new RegExp(`\\${sel} \\{([^}]*)\\}`))?.[1] ?? '';

test('the games live in the menu, at the end of the nav, and nowhere else', () => {
  const pop = html.match(/<div class="navmenu-pop[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.ok(pop, 'the panel exists');
  const inPop = [...pop.matchAll(/data-page="([a-z0-9]+)"/g)].map((m) => m[1]);
  assert.deepEqual(inPop, ['tetrust', 'blockout', 'blockanoid', 'scorched', 'wolf3d', 'doom', 'quake'], 'every game is in it');
  // exactly once in the whole page: they were moved, not copied
  for (const page of inPop) {
    assert.equal(html.match(new RegExp(`<button data-page="${page}"`, 'g')).length, 1, `${page} has one nav button`);
  }
  // the nav's own buttons no longer include them, and the menu sits after the last of them
  const navRow = html.slice(html.indexOf('<nav'), html.indexOf('navmenu'));
  assert.ok(!navRow.includes('data-page="tetrust"'), 'not among the working tabs any more');
  assert.ok(html.indexOf('id="navAdmin"') < html.indexOf('id="navDivBtn"'), 'the menu comes last');
});

test('the toggle carries no data-page: a nav button with one must have a section behind it', () => {
  // web-contract.test.js holds every `<button data-page>` in the nav to a matching page section.
  const toggle = html.match(/<button type="button" class="navmenu-btn"[^>]*>/)?.[0] ?? '';
  assert.ok(toggle, 'the toggle exists');
  assert.ok(!toggle.includes('data-page'), 'and names no page');
  assert.match(toggle, /aria-haspopup="true"/);
  assert.match(toggle, /aria-expanded=/);
});

test('the menu is outside the scrolling nav, and its panel escapes the clipping', () => {
  const menu = rule('.navmenu'), pop = rule('.navmenu-pop');
  // NOT STICKY, AND NOT IN THE SCROLL CONTAINER. It was both, and on Safari for macOS the button
  // was visible and unclickable: WebKit paints a sticky element in its stuck position but
  // hit-tests it at its original layout position. Every check here passed while the menu was
  // dead in that browser, so the guard is now structural -- the menu must sit outside <nav>.
  assert.ok(!/position: sticky/.test(menu), 'sticky is what broke it in WebKit');
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  assert.ok(!nav.includes('id="navDiv"'), 'the menu must not live inside the scrolling nav');
  assert.match(app, /divPop\?\.addEventListener\('click'[\s\S]{0,200}?setPage\(b\.dataset\.page\)/,
    'outside <nav> the delegated handler cannot route the games: the panel must route them itself');
  assert.match(pop, /position: fixed/, 'the nav and the header both clip; an absolute panel is invisible');
  assert.match(pop, /left: var\(--x/); assert.match(pop, /top: var\(--y/);
  // ...and the page positions it from the button's rect, through the CSSOM
  assert.match(app, /divPop\.style\.setProperty\('--x'/);
  assert.match(app, /getBoundingClientRect\(\)/);
  // FIXED IS NOT ENOUGH IN WEBKIT. `header.top` is overflow:hidden and 46px tall; the panel opens
  // below that and stands ~88px, and Safari clipped it to the header -- "only showing half the
  // drop-down contents" -- while Chrome and Firefox let the fixed panel escape. So the panel must
  // be a child of <body>, like .cfgwrap, which is the fixed overlay that always rendered correctly.
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.ok(!header.includes('id="navDivPop"'), 'the panel must not live inside the clipped header');
  // ...and the element it DOES sit in must not clip or contain it either. `.app` is a plain grid;
  // if it ever grows an overflow, a transform or a filter, this panel gets clipped again in WebKit
  // and nothing else here would notice.
  const appRule = css.match(/^\.app \{([^}]*)\}/m)?.[1] ?? '';
  assert.ok(appRule, '.app must exist: it is what holds the panel');
  for (const bad of ['overflow', 'transform', 'filter', 'perspective', 'contain']) {
    assert.ok(!new RegExp(`(^|;)\\s*${bad}\\s*:`).test(appRule),
      `.app must not set ${bad}: it would clip or contain the fixed panel, which is the Safari bug`);
  }
  assert.ok(!/\.navmenu-pop \{[^}]*transform:/.test(css),
    'no transform either: the left edge is measured and set, not pulled back by translateX');
  assert.ok(!/navmenu-pop[^>]*style="/.test(html), 'no style attribute: the CSP forbids them');
});
