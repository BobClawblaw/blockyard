// TETRUST, the rules under test (operator, 2026-09-12: "a playable tetris game using our 3d
// Engine ... Add score. Add a high score table"). tetris.js knows nothing of the screen, so
// every rule here is asserted on a plain board object with a seeded piece order.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLS, ROWS, KINDS, PIECES, LINE_SCORE, newGame, cellsOf, collides, spawn, move, rotate, ghostY,
  tick, softDrop, hardDrop, tiles, previewTiles, peekNext, gravityMs, kindAt, GHOST_WIRE,
} from '../public/js/tetris.js';
import { loadScores, recordScore, rankOf, driftTiles } from '../public/js/tetrust.js';
import { THEME, SFX, play, setSfx, setMusic, holdMusic, unlock, state as soundState } from '../public/js/tetsound.js';

const empty = () => Array.from({ length: ROWS }, () => new Array(COLS).fill(null));

test('every piece has four cells in each of four orientations, inside a 4x4 box', () => {
  for (const k of KINDS) {
    for (const r of PIECES[k].rot) {
      assert.equal(r.length, 4, `${k} has four cells`);
      assert.ok(r.every(([x, y]) => x >= 0 && x < 4 && y >= 0 && y < 4), `${k} fits the box`);
      assert.equal(new Set(r.map(([x, y]) => `${x},${y}`)).size, 4, `${k} cells are distinct`);
    }
  }
});

test('the seven-bag: every piece once before any repeats, and a seed makes the order reproducible', () => {
  const g = newGame(42);
  const seen = [g.cur.kind, ...g.queue.slice(0, 6)];
  assert.deepEqual([...seen].sort(), [...KINDS].sort(), 'the first seven are the seven kinds');
  const h = newGame(42);
  assert.equal(h.cur.kind, g.cur.kind);
  assert.deepEqual(h.queue, g.queue, 'same seed, same order');
  assert.notEqual(newGame(7).queue.join(''), newGame(8).queue.join(''), 'different seeds differ');
});

test('a piece spawns near the top, slides, and stops at the walls', () => {
  const g = newGame(1);
  assert.ok(g.cur.y >= ROWS - 4, 'spawned at the top');
  let steps = 0;
  while (move(g, -1)) steps++;
  assert.ok(steps > 0 && steps <= 4, 'slid to the left wall');
  assert.ok(cellsOf(g.cur.kind, g.cur.rot, g.cur.x, g.cur.y).every(([x]) => x >= 0), 'and not through it');
  assert.equal(move(g, -1), false, 'a blocked slide does not happen');
  while (move(g, 1)) { /* to the right wall */ }
  assert.ok(cellsOf(g.cur.kind, g.cur.rot, g.cur.x, g.cur.y).every(([x]) => x < COLS));
});

test('rotation kicks off a wall instead of refusing', () => {
  const g = newGame(3);
  g.cur = { kind: 'I', rot: 1, x: -2, y: 10 };            // vertical I hard against the left wall
  // x=-2 with the vertical column at box-x 2 puts the column at x=0: legal
  assert.equal(collides(g, cellsOf('I', 1, -2, 10)), false);
  assert.equal(rotate(g, 1), true, 'turning flat would poke through the wall; a kick finds room');
  assert.ok(cellsOf(g.cur.kind, g.cur.rot, g.cur.x, g.cur.y).every(([x]) => x >= 0 && x < COLS), 'and lands inside');
});

test('gravity brings a piece to the floor, locks it, and the next one appears', () => {
  const g = newGame(5);
  const first = g.cur.kind;
  let locked = false, guard = 0;
  while (!locked && guard++ < ROWS + 2) locked = tick(g);
  assert.ok(locked, 'it locked');
  assert.ok(g.board.some((row) => row.some(Boolean)), 'the stack has a block in it');
  assert.ok(g.board[0].some(Boolean) || g.board[1].some(Boolean), 'on the floor');
  assert.equal(g.pieces, 2, 'and the next piece spawned');
  assert.ok(KINDS.includes(g.cur.kind));
  void first;
});

test('a hard drop lands where the ghost said it would, and pays two a row', () => {
  const g = newGame(9);
  const gy = ghostY(g);
  const fell = g.cur.y - gy;
  const before = g.score;
  assert.equal(hardDrop(g), fell);
  assert.equal(g.score, before + 2 * fell);
  assert.equal(g.pieces, 2, 'locked and moved on');
});

test('a full row clears, everything above comes down, and the score follows the table times the level', () => {
  const g = newGame(11);
  // hand-build: rows 0 full except column 4, a marker block on row 1 above column 0
  g.board = empty();
  for (let x = 0; x < COLS; x++) if (x !== 4) g.board[0][x] = { k: 'O', id: 900 + x };
  g.board[1][0] = { k: 'T', id: 999 };
  // drop a vertical I into column 4: it fills the gap in row 0 and stands in rows 1..3
  g.cur = { kind: 'I', rot: 1, x: 2, y: 0 };            // column at x = 4
  assert.equal(collides(g, cellsOf('I', 1, 2, 0)), false);
  const level = g.level;
  hardDrop(g);
  assert.deepEqual(g.cleared, [0], 'row 0 was the line');
  assert.equal(g.clearedCells.length, COLS, 'the cells of the line are kept for the screen to fly away');
  assert.ok(g.clearedCells.every((c) => c.y === 0 && c.k && c.id), 'with their place, kind and id');
  assert.equal(g.lines, 1);
  assert.equal(g.score, LINE_SCORE[1] * level, 'a single, times the level');
  assert.equal(kindAt(g, 0, 0), 'T', 'the marker came down from row 1 to row 0');
  assert.equal(g.board[0][0].id, 999, 'and kept its id on the way: the renderer sees a move, not a vanish-and-appear');
  assert.equal(kindAt(g, 4, 0), 'I', 'and the I piece dropped a row with it');
  assert.equal(g.board[ROWS - 1].every((c) => c === null), true, 'a fresh empty row arrived at the top');
});

test('four at once is a tetris, and ten lines is a level', () => {
  const g = newGame(13);
  g.board = empty();
  for (let y = 0; y < 4; y++) for (let x = 0; x < COLS; x++) if (x !== 9) g.board[y][x] = { k: 'O', id: 100 + y * COLS + x };
  g.cur = { kind: 'I', rot: 1, x: 7, y: 0 };            // column at x = 9
  g.lines = 8;
  hardDrop(g);
  assert.deepEqual(g.cleared, [0, 1, 2, 3]);
  assert.equal(g.lines, 12);
  assert.equal(g.level, 2, 'past ten lines: level two');
  assert.ok(g.score >= LINE_SCORE[4], 'a tetris pays like one');
  assert.ok(gravityMs(2) < gravityMs(1), 'and the game gets faster');
  assert.equal(gravityMs(99), 80, 'but never absurdly so');
  assert.ok(gravityMs(1) <= 700, 'and brisk from the first level');
});

test('the game is over when a piece cannot appear', () => {
  const g = newGame(17);
  g.board = empty();
  for (let y = 0; y < ROWS; y++) for (let x = 3; x < 7; x++) g.board[y][x] = { k: 'O', id: 1 };   // a tower under the spawn
  spawn(g);
  assert.equal(g.over, true);
  assert.equal(g.cur, null);
  assert.equal(tick(g), false, 'nothing moves after the end');
  assert.equal(hardDrop(g), 0);
});

test('the tiles for the engine: the stack in its colours, the piece standing taller, the ghost a wireframe where it lands', () => {
  const g = newGame(21);
  g.board = empty();
  g.board[0][0] = { k: 'Z', id: 7 };
  g.cur = { kind: 'O', rot: 0, x: 4, y: 12 };
  const t = tiles(g);
  const stack = t.filter((x) => !x.piece && !x.wire);
  const piece = t.filter((x) => x.piece);
  const ghost = t.filter((x) => x.txid.startsWith('g'));
  assert.equal(stack.length, 1); assert.equal(stack[0].color, PIECES.Z.color); assert.equal(stack[0].tall, 1);
  assert.equal(stack[0].txid, 'c7', 'a locked cell is named by its id, not its place');
  assert.equal(piece.length, 4); assert.ok(piece.every((x) => x.tall > 1), 'the falling piece stands taller');
  assert.deepEqual(piece.map((x) => x.txid), ['c1', 'c2', 'c3', 'c4'], 'and already carries the ids it locks with');
  hardDrop(g);
  const after = tiles(g).filter((x) => ['c1', 'c2', 'c3', 'c4'].includes(x.txid));
  assert.equal(after.length, 4); assert.ok(after.every((x) => x.tall === 1 && !x.piece), 'locked: the same four ids, settled');
  assert.equal(ghost.length, 4); assert.ok(ghost.every((x) => x.wire === GHOST_WIRE), 'the ghost is a neon wireframe, not a dark plate');
  assert.ok(ghost.every((x) => x.y < 12), 'below the piece, where it will land');
  assert.equal(previewTiles(peekNext(g)).length, 4);
  assert.ok(t.every((x) => x.x >= 0 && x.x < COLS && x.y >= 0 && x.y < ROWS), 'nothing outside the well');
});

test('the high-score table keeps ten, ranks a new score, and survives a corrupt store', () => {
  const map = new Map();
  const store = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  assert.deepEqual(loadScores(store), []);
  for (let i = 1; i <= 12; i++) recordScore({ score: i * 100, lines: i, level: 1, at: i }, store);
  const list = loadScores(store);
  assert.equal(list.length, 10, 'ten kept');
  assert.equal(list[0].score, 1200, 'best first');
  assert.equal(list[9].score, 300, 'the two worst fell off');
  assert.equal(rankOf(1250, list), 1, 'a new best is #1');
  assert.equal(rankOf(350, list), 10, 'just above the tenth is #10');
  assert.equal(rankOf(50, list), null, 'below the table does not make it');
  map.set('bmc.tetrust.scores', '{not json');
  assert.deepEqual(loadScores(store), [], 'a corrupt store is an empty table, not a crash');
});

test('a cleared line drifts up and away: rising on its floor, sliding outward, fading to the black behind it', () => {
  // (operator, 2026-09-12: "have the block pieces drift up and away and completing lines")
  const drift = [{ id: 1, x: 0, y: 4, color: '#ef5a5a', dx: -0.5, t0: 1000 }, { id: 2, x: 9, y: 4, color: '#ef5a5a', dx: 0.5, t0: 1000 }];
  const at = (now) => driftTiles(drift, now, 700);
  const start = at(1000), mid = at(1350), late = at(1650);
  assert.equal(start.length, 2); assert.equal(start[0].floor, 0); assert.equal(start[0].color, '#ef5a5a', 'just lifted: on the board, full colour');
  assert.ok(mid[0].floor > 2 && mid[0].floor < 9, 'halfway: well off the board');
  assert.ok(mid[0].x < 0 && mid[1].x > 9, 'and sliding to its own side');
  assert.ok(late[0].floor > mid[0].floor, 'still rising');
  assert.ok(parseInt(late[0].color.slice(1, 3), 16) < parseInt(mid[0].color.slice(1, 3), 16), 'and darker: fading to the black');
  assert.deepEqual(at(1700), [], 'gone at the end');
  assert.ok(start.every((t) => t.txid.startsWith('d') && t.tall === 1 && t.s === 1), 'ordinary cubes with their own ids');
});

test('the sound: the tune is only notes the table knows, and everything is a no-op without an AudioContext', () => {
  // (operator, 2026-09-12: "add Tetris music and sound effects to teh gameplay. Toggle for each")
  assert.ok(THEME.length > 30 && THEME.every(([n, b]) => typeof n === 'string' && b > 0));
  assert.ok(Object.keys(SFX).length >= 8, 'move, rotate, soft, drop, lock, clear, tetris, over, level');
  assert.ok(Object.values(SFX).every(([f0, f1, secs, wave, gain]) => f0 > 0 && f1 > 0 && secs > 0 && secs < 1 && typeof wave === 'string' && gain > 0 && gain <= 0.12), 'short, shaped, quiet');
  assert.equal(globalThis.AudioContext, undefined, 'node has no audio');
  assert.doesNotThrow(() => { setSfx(true); play('drop'); play('nope'); setMusic(true); holdMusic(true); holdMusic(false); setMusic(false); unlock(); });
  assert.equal(soundState().live, false, 'and no context was made');
});
