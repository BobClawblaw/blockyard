// BLOCKMAN'S SCREEN (docs/PLAN-BLOCKMAN.md, M1): the two layers, the page wiring, and the canvas
// rules this repository lives by. The rules of the GAME are M2's; what is held here is that the
// maze is built once and everything that moves is painted, which is the whole reason the design
// looks like this (§2: a cube per moving thing measured 15 fps, a cube per arcade pixel 1.4 fps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wallTiles, mazeOrder, currentPlay, currentGame, frameStats, setTargets } from '../public/js/blockmanview.js';
import * as fx from '../public/js/blockmanfx.js';
import { parseMaze, OPEN } from '../public/js/blockmanmaze.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const m = parseMaze();

test('the maze layer is every wall as a cube, and nothing else', () => {
  const tiles = wallTiles(m);
  const open = m.grid.reduce((a, v) => a + (v === OPEN ? 1 : 0), 0);
  assert.equal(tiles.length, m.w * m.h - open, 'one cube per solid tile');
  assert.ok(tiles.length < 600, `${tiles.length} cubes: the layer the renderer builds once, not a thousand a frame`);
  assert.equal(new Set(tiles.map((t) => t.txid)).size, tiles.length, 'stable ids, so a rebuild is not a re-animation');
  for (const t of tiles) {
    assert.ok(t.x >= 0 && t.x < m.w && t.y >= 0 && t.y < m.h);
    assert.match(t.color, /^#[0-9a-f]{6}$/i);
  }
  // the pen's box is lower than the walls, so the pursuers inside it can be seen
  const pen = new Set(m.pen.map((p) => `${p.x},${p.y}`));
  const inside = tiles.filter((t) => pen.has(`${t.x},${t.y}`));
  assert.equal(inside.length, m.pen.length);
  for (const t of inside) assert.ok(t.tall < 1, 'the pen floor is not a wall');
});

test('the maze draws in a known order: back rows first, columns outside in', () => {
  const tiles = wallTiles(m).sort(mazeOrder);
  for (let i = 1; i < tiles.length; i++) {
    const a = tiles[i - 1], b = tiles[i];
    assert.ok(a.y <= b.y, 'rows from the back');
    if (a.y === b.y) {
      const c = m.w / 2;
      assert.ok(Math.abs(a.x + 0.5 - c) >= Math.abs(b.x + 0.5 - c), 'and within a row, outside in');
    }
  }
});

test('the painted layer obeys the canvas rules', () => {
  // the code, not its comments: both files explain WHY these calls are banned
  const strip = (t) => t.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  const src = strip(read('public/js/blockmanfx.js')) + strip(read('public/js/blockmanview.js'));
  for (const banned of ['ctx.clip(', 'globalAlpha', 'globalCompositeOperation', 'createLinearGradient', 'createRadialGradient', 'filter =']) {
    assert.equal(src.includes(banned), false, `${banned} is not allowed on these canvases`);
  }
  assert.ok(src.includes('rgba('), 'soft edges come from rgba fills');
});

test('the painters draw without a DOM, and every fill is a colour the renderer would accept', () => {
  const ops = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '',
    beginPath: () => ops.push(['beginPath']), closePath: () => {}, moveTo: () => {}, lineTo: () => {},
    arc: () => ops.push(['arc']), fill: () => ops.push(['fill', ctx.fillStyle]), stroke: () => {}, fillText: () => ops.push(['text']),
  };
  const P = (x, y) => ({ x: x * 10, y: y * 10 });
  const U = { x: 10, y: 10 };
  fx.paintDots(ctx, P, U, { dots: m.dots, pellets: m.pellets, now: 0 });
  fx.paintBlockMan(ctx, P, U, { x: 14, y: 20, dir: { x: 1, y: 0 } }, { now: 0 });
  fx.paintPursuers(ctx, P, U, [{ x: 14, y: 13, dir: { x: 0, y: -1 }, colour: '#ef4b4b', state: 'chase' }, { x: 3, y: 3, colour: '#46d7e4', state: 'frightened', frightenedLeftMs: 800 }], { now: 0 });
  fx.paintFruit(ctx, P, U, { x: 14, y: 17, colour: '#ff5c7a' });
  fx.paintPops(ctx, P, U, [{ x: 4, y: 4, text: 200, t0: -100 }], 0);
  const fills = ops.filter((o) => o[0] === 'fill').map((o) => o[1]);
  assert.ok(fills.length > 5, 'it painted');
  for (const f of fills) assert.match(String(f), /^(#[0-9a-f]{3,6}|rgb\(|rgba\()/i, `a plain colour, not ${f}`);
  // one path for all the dots: the cost of the layer is a handful of fills, not one per dot
  assert.ok(ops.filter((o) => o[0] === 'fill').length < 60, `${ops.filter((o) => o[0] === 'fill').length} fills for 250 dots, 5 actors and a fruit`);
});

test('a cube is drawn as three faces from one colour', () => {
  const seen = [];
  const ctx = { fillStyle: '', beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {}, arc: () => {}, fill: () => seen.push(ctx.fillStyle) };
  fx.cube(ctx, (x, y) => ({ x: x * 10, y: y * 10 }), { x: 10, y: 10 }, { x: 5, y: 5, colour: '#3050c0' });
  assert.equal(seen.length, 3, 'front, top, side');
  assert.equal(seen[0], '#3050c0');
  assert.notEqual(seen[1], seen[2], 'the top is lit and the side is not');
  assert.equal(fx.shade('#000000', 1.5), 'rgb(128,128,128)', 'halfway to white');
  assert.equal(fx.shade('#ffffff', 0.5), 'rgb(128,128,128)', 'and halfway to black');
});

test('the page carries the two canvases, the panel and the menu entry, and the game loads lazily', () => {
  const html = read('public/index.html');
  assert.match(html, /<section class="page" data-page="blockman">/);
  for (const id of ['bmMaze', 'bmPlay', 'bmWrap', 'bmStats']) assert.match(html, new RegExp(`id="${id}"`), `${id} is on the page`);
  assert.match(html, /<button data-page="blockman" role="menuitem"/, 'in the Diversions menu');
  const app = read('public/js/app.js');
  assert.match(app, /blockman: \(\) => import\('\.\/blockmanview\.js'\)/, 'loaded the first time its page is opened');
  assert.match(app, /case 'blockman':/, 'and routed');
  assert.match(app, /DIVERSION_PAGES = \[[^\]]*'blockman'/, 'and counted as a diversion');
  assert.equal(/import .*blockman/.test(app.split('\n').filter((l) => l.startsWith('import ')).join('\n')), false, 'never a static import');
  assert.match(read('public/css/app.css'), /\.bmwell/, 'the well has an aspect ratio');
});

test('the panel says what the keys do, and the screen has its overlay', () => {
  const html = read('public/index.html');
  for (const id of ['bmOver', 'bmMsg', 'bmSub', 'bmResume', 'bmWho']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /← → ↑ ↓ or WASD/, 'the move keys');
  assert.match(html, /P pause · F2 restart · Enter plays/, 'and the game keys');
  assert.equal(/\(M2\)/.test(html), false, 'nothing on the panel is still promised');
  // the four pursuers are named on the panel, and named the same in the rules
  for (const name of ['Chaser', 'Ambusher', 'Flanker', 'Wanderer']) assert.match(html, new RegExp(`<th>${name}</th>`));
});

test('cheat mode draws each pursuer\u2019s target, in its own colour', () => {
  const ops = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {}, arc: () => {},
    fill: () => {}, stroke: () => ops.push(ctx.strokeStyle),
  };
  const four = [
    { id: 'chaser', colour: '#ef4b4b', state: 'chase', x: 5, y: 5, target: { x: 14, y: 19 } },
    { id: 'ambusher', colour: '#ff8ccf', state: 'chase', x: 6, y: 5, target: { x: 10, y: 19 } },
    { id: 'penned', colour: '#46d7e4', state: 'pen', x: 14, y: 14, target: null },
    { id: 'scared', colour: '#ffa63d', state: 'frightened', x: 3, y: 3, target: { x: 1, y: 1 } },
  ];
  fx.paintTargets(ctx, (x, y) => ({ x: x * 10, y: y * 10 }), { x: 10, y: 10 }, four);
  assert.equal(ops.length, 4, 'a line and a ring for each of the two that are chasing, and none for the pen or the frightened');
  assert.ok(ops.every((c) => /^rgba\(\d+,\d+,\d+,/.test(c)), `plain rgba strokes: ${ops.join(' ')}`);
  assert.equal(fx.rgbOf('#ef4b4b'), '239,75,75');
  // the switch and the T key are the same thing, and the page carries the button
  assert.match(read('public/index.html'), /id="bmTargets"/);
  assert.match(read('public/index.html'), /T shows what they are chasing/);
  assert.doesNotThrow(() => setTargets(true));
  assert.doesNotThrow(() => setTargets(false));
});

test('the play state and the frame times are readable, for the tests and the measurement', () => {
  assert.equal(currentGame(), null, 'no game until the page opens one');
  const play = currentPlay();
  assert.ok(play && 'maze' in play && 'man' in play && 'pursuers' in play);
  const st = frameStats();
  assert.equal(st.frames, 0, 'nothing has been drawn in a test process');
  assert.equal(st.medianMs, null);
});
