// BLOCKMAN'S MAZE, HELD TO ITS RULES (docs/PLAN-BLOCKMAN.md §3, M1).
//
// The layout is ours, drawn from scratch, and the point of this file is that it can be TUNED by
// play without anyone having to hold thirty rows of ASCII in their head: every rule the maze has to
// satisfy is an assertion here, so a change that breaks the game breaks the suite instead.
//
// It also holds the one legal line that matters for the maze (§1): the geometry is not the 1980
// game's. Nothing here can prove that, but the symmetry rule, the dot budget and the shape rules
// together are what a maze drawn to the genre's REQUIREMENTS looks like -- as opposed to a copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMaze, mazeRows, openSquares, reachable, noUpTurn, HALF, WALL, OPEN } from '../public/js/blockmanmaze.js';

const m = parseMaze();
const key = (t) => `${t.x},${t.y}`;

test('the layout is written as a half and mirrored, so the maze is symmetrical by construction', () => {
  for (const row of HALF) assert.equal(row.length, 14, `"${row}" is ${row.length} characters, not 14`);
  const rows = mazeRows();
  assert.equal(rows.length, HALF.length);
  for (const row of rows) {
    assert.equal(row.length, 28);
    assert.equal(row, [...row].reverse().join(''), `not symmetrical: ${row}`);
  }
  assert.equal(m.w, 28);
  assert.ok(m.h >= 26 && m.h <= 33, `the playfield is the genre's shape, not a square (${m.h} rows)`);
});

test('the maze is one connected network: every dot, pellet and pen door is reachable from the start', () => {
  const reach = reachable(m, m.start);
  const missed = [...m.dots, ...m.pellets].filter((d) => !reach.has(key(d)));
  assert.deepEqual(missed, [], 'a dot nobody can eat is a level that cannot be finished');
  // the pursuers rise out of the pen through the shaft and into the maze
  assert.ok(m.exit.length >= 2, 'the pen has an exit shaft');
  for (const t of m.exit) assert.equal(m.at(t.x, t.y), OPEN, 'the shaft is open');
  assert.ok(reach.has(key({ x: m.exit[0].x, y: m.exit[0].y })), 'and it joins the maze');
  // and the tunnel wraps: the flood fill crossed the edge
  assert.ok(m.tunnels.length >= 4, 'a tunnel each side');
  for (const t of m.tunnels) assert.equal(m.at(t.x, t.y), OPEN);
  assert.ok(reach.has('0,' + m.tunnels[0].y) && reach.has(`${m.w - 1},${m.tunnels[0].y}`), 'both mouths are on the network');
});

test('no 2x2 of open tiles, except the pen shaft where the pursuers rise', () => {
  assert.deepEqual(openSquares(m), [], 'an open square is a room: a pursuer can be shaken off by circling it');
  // the exemption is exactly the shaft and the corridor at its mouth, and nothing else
  const exempt = new Set([...m.exit, ...m.noUp].map(key));
  assert.ok(exempt.size >= 4 && exempt.size <= 10, `the exemption stays small (${exempt.size} tiles)`);
});

test('the pen sits in the middle with one gate, the start below it, and the tunnels at its height', () => {
  assert.equal(m.pen.length, 18, 'a six-wide, three-deep pen');
  const xs = m.pen.map((p) => p.x), ys = m.pen.map((p) => p.y);
  assert.equal(Math.min(...xs) + Math.max(...xs), m.w - 1, 'centred left to right');
  assert.ok(Math.min(...ys) > m.h * 0.35 && Math.max(...ys) < m.h * 0.65, 'and vertically');
  assert.ok(m.gate, 'it has a gate');
  assert.equal(m.door.x, m.w / 2, 'whose mouth is on the seam');
  assert.equal(m.door.y, Math.min(...ys), 'at the top of the pen');
  assert.equal(m.start.x, m.w / 2, 'BlockMan starts on the seam');
  assert.ok(m.start.y > Math.max(...ys), 'below the pen');
  for (const t of m.tunnels) assert.ok(Math.abs(t.y - m.door.y) <= 2, 'the tunnels are at the pen’s height');
});

test('four pellets, out in the quarters, each a short run from a junction', () => {
  assert.equal(m.pellets.length, 4);
  const junctions = (t) => {
    let n = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (m.at(t.x + dx, t.y + dy) === OPEN) n += 1;
    return n;
  };
  for (const p of m.pellets) {
    assert.ok(p.x < m.w * 0.25 || p.x > m.w * 0.75, 'in an outer quarter across');
    assert.ok(p.y < m.h * 0.35 || p.y > m.h * 0.65, 'and an outer quarter down');
    assert.ok(junctions(p) >= 2, 'a pellet is never in a pocket: every tile has two ways out');
  }
  // two up, two down, two left, two right: the four quarters, one each
  assert.equal(new Set(m.pellets.map((p) => `${p.x < m.w / 2},${p.y < m.h / 2}`)).size, 4);
});

test('the dot budget lands where the tables expect, and the walls are the rest', () => {
  assert.ok(m.dots.length >= 240 && m.dots.length <= 260, `${m.dots.length} dots: the genre's ballpark, so fruit and speed steps fire where the tables say`);
  const open = m.grid.reduce((a, v) => a + (v === OPEN ? 1 : 0), 0);
  assert.ok(open > m.w * m.h * 0.25 && open < m.w * m.h * 0.5, `a maze, not a field or a wall (${open} open of ${m.w * m.h})`);
  // every open tile is a dot, a pellet, a tunnel, the shaft, the start, or a deliberately dotless
  // corridor: the pen's surround and the run to the tunnel, where the original leaves the floor bare
  const named = new Set([...m.dots, ...m.pellets, ...m.tunnels, ...m.exit].map(key));
  let bare = 0;
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.at(x, y) === OPEN && !named.has(`${x},${y}`)) bare += 1;
  assert.equal(named.size + bare, open, 'nothing unclassified');
  assert.ok(bare >= 2 && bare <= 40, `${bare} bare tiles: the tunnel run, the shaft and the start`);
  for (const t of m.pen) assert.equal(m.at(t.x, t.y), WALL, 'the pen itself is solid to BlockMan');
});

test('a mirrored pair of no-upward-turn tiles above the pen', () => {
  const up = noUpTurn(m);
  assert.equal(up.length, 2);
  for (const t of up) assert.equal(m.at(t.x, t.y), OPEN, 'they are corridor tiles');
  for (const t of up) assert.ok(t.y < m.door.y, 'above the pen, where a pursuer has to commit');
  assert.equal(up[0].x + up[1].x, m.w - 1, 'a mirrored pair');
});

test('NO DEAD ENDS: every open tile has at least two ways out', () => {
  // THE RULE THE FIRST MAZE BROKE. It had twenty tiles with one way out -- pockets three tiles deep
  // off the top corridor, stubs under the pen -- and it played badly: a wrong turn was death with no
  // read on it (operator, 2026-09-17). The layout is generated by closing passages on a lattice and
  // keeping only the closures that leave this true, so the rule is the design, not a tidy-up.
  const ways = (x, y) => {
    let n = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = dx ? (x + dx + m.w) % m.w : x;                 // the tunnel wraps
      if (m.at(nx, y + dy) === OPEN) n += 1;
    }
    return n;
  };
  const dead = [];
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.at(x, y) === OPEN && ways(x, y) < 2) dead.push(`${x},${y}`);
  assert.deepEqual(dead, [], 'a tile with one way out is a trap with no read on it');
});

test('the outer loop can be run forever', () => {
  const ring = [];
  for (let x = 0; x < m.w; x++) if (m.at(x, 1) === OPEN) ring.push({ x, y: 1 });
  assert.equal(ring.length, m.w - 2, 'the top corridor runs the full width');
  const bottom = [...Array(m.w).keys()].filter((x) => m.at(x, m.h - 2) === OPEN);
  assert.equal(bottom.length, m.w - 2, 'so does the bottom');
  // and the two are joined down both sides, so the ring is a ring
  for (const x of [1, m.w - 2]) {
    let run = 0;
    for (let y = 1; y < m.h - 1; y++) if (m.at(x, y) === OPEN) run += 1;
    assert.equal(run, m.h - 2, `column ${x} runs the full height`);
  }
});
