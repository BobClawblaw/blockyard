// THE MENU BAR (operator, 2026-10-13: "we need to find a way of drastically improving the top menu. I suggest a
// complete rework. Perhaps based on MacOS Finder menus"). Every page in exactly one menu, each with a shortcut; the
// Diversions (2026-09-12, "under a pop-down menu called 'Diversions'") and Node (2026-10-13) menus among them, and
// Kiosk a direct item. The stub cannot open a menu, so this holds the markup and the code's shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const html = read('index.html'), css = read('css/app.css'), app = read('js/app.js');
const header = html.match(/<header class="top">[\s\S]*?<\/header>/)[0];
const nav = header.match(/<nav class="pages" id="nav"[\s\S]*?<\/nav>/)[0];
const menu = (id) => nav.match(new RegExp(`<div class="menu" id="${id}">[\\s\\S]*?<\\/div>\\s*<\\/div>`))?.[0] ?? '';
const pagesIn = (block) => [...block.matchAll(/data-page="([a-z0-9]+)"/g)].map((m) => m[1]);

test('five menus, every page in exactly one of them, Kiosk a direct item, the games last', () => {
  assert.deepEqual(pagesIn(menu('menuMonitor')), ['overview', 'space', 'chain', 'mempool', 'mining']);
  assert.deepEqual(pagesIn(menu('menuExplore')), ['explorer', 'markets', 'weather']);
  assert.deepEqual(pagesIn(menu('navNode')), ['peers', 'network', 'logs', 'node', 'admin']);
  assert.deepEqual(pagesIn(menu('navDiv')), ['tetrust', 'blockout', 'blockanoid', 'scorched', 'wolf3d', 'doom', 'quake'], 'every game is in Diversions');
  assert.match(nav, /<button data-page="kiosk" class="menu-title direct"/, 'Kiosk is one click, for a wall');
  const all = pagesIn(nav);
  assert.equal(new Set(all).size, all.length, 'no page is in two menus');
  const titles = [...nav.matchAll(/<div class="menu" id="([A-Za-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(titles, ['menuMonitor', 'menuExplore', 'navNode', 'navDiv'], 'in this order, Diversions last');
  assert.ok(nav.indexOf('data-page="kiosk"') < nav.indexOf('id="navDiv"'), 'Kiosk before Diversions');
  for (const t of [...nav.matchAll(/<button type="button" class="menu-title"[^>]*>/g)].map((m) => m[0])) {
    assert.ok(!t.includes('data-page'), 'a menu title names no page: a button with one must have a section behind it');
    assert.match(t, /aria-haspopup="true"/); assert.match(t, /aria-expanded=/);
  }
});

test('the shortcuts: 1-9 on the nine working pages, shown Finder-style on the items, each once', () => {
  const keys = [...nav.matchAll(/data-page="([a-z0-9]+)"[^>]*>[^<]*<kbd>(\d)<\/kbd>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(keys, [['overview', '1'], ['space', '2'], ['chain', '3'], ['mempool', '4'], ['mining', '5'], ['explorer', '6'], ['markets', '7'], ['weather', '8'], ['kiosk', '9']]);
  assert.match(app, /\/\^\[1-9\]\$\/\.test\(e\.key\)/, 'the digits route');
  assert.match(app, /e\.target\.closest\?\.\('input, select, textarea, \[contenteditable\]'\)/, 'never while typing');
  assert.match(css, /\.menu-pop button kbd \{ margin-left: auto;/, 'at the item\u2019s right');
});

test('the bar behaves like a menu bar: hover switches an open menu, Esc and a click elsewhere close, arrows move', () => {
  assert.match(app, /bar\.addEventListener\('pointerover'/, 'hovering a title with a menu open');
  assert.match(app, /if \(openOne\(\) && m && m !== openOne\(\)\) openMenu\(m, true\)/, 'moves the open menu');
  assert.match(app, /if \(e\.key === 'Escape'\) \{ closeAll\(\); return; \}/);
  assert.match(app, /document\.addEventListener\('click', \(e\) => \{ if \(!bar\.contains\(e\.target\)\) closeAll\(\); \}\)/);
  assert.match(app, /e\.key === 'ArrowDown'/); assert.match(app, /e\.key === 'ArrowRight' \|\| e\.key === 'ArrowLeft'/);
  assert.match(app, /setPage\(item\.dataset\.page\); closeAll\(\)/, 'an item routes and closes');
  assert.match(app, /pageName\.textContent = /, 'the bar names the page');
  assert.ok(header.includes('id="pageName"'));
  // the lists live INSIDE the bar now (no scrolling nav to clip them), under their titles
  assert.ok(nav.includes('id="navDivPop"') && nav.includes('id="navNodePop"'), 'the panels are in the nav');
  assert.ok(!/position: fixed/.test(css.match(/\.menu-pop \{[^}]*\}/)[0]), 'absolute under the title, not fixed');
  assert.ok(!html.includes('navmenu-pop'), 'the old out-of-header panels are gone');
  assert.ok(!/style="/.test(header), 'no style attributes (CSP)');
});

test('the right of the bar: the stream dot, the node badge, three icon buttons', () => {
  const meta = header.match(/<div class="meta">[\s\S]*?<\/div>/)[0];
  assert.ok(meta.indexOf('id="sseState"') < meta.indexOf('id="nodePick"'), 'the dot beside the badge');
  assert.match(meta, /<b id="rpcLat" hidden>/); assert.match(meta, /<b id="appUp" hidden>/, 'rpc and uptime kept for render(), hidden: they are the badge\u2019s tooltip');
  assert.match(app, /badge\.title = `\$\{badge\.dataset\.node/, 'and the tooltip is written every frame');
  for (const id of ['btnSettings', 'btnPause', 'btnLogout']) assert.ok(header.includes(`id="${id}"`), id);
  assert.match(header, /id="btnPause"[^>]*aria-label="Pause live updates"/);
  assert.match(app, /b\.classList\.toggle\('paused', state\.paused\)/, 'pause flips its icon, not its text');
  assert.match(app, /pick\.addEventListener\('click', \(\) => setPage\('chain'\)\)/, 'the badge opens Chain & Sync');
  assert.match(app, /chPick\.hidden = list\.length < 2/, 'the picker there shows only with more than one node');
});
