// BLOCKMAN'S MAZE (docs/PLAN-BLOCKMAN.md §3). One layout, ours, for every level.
//
// THE GEOMETRY IS NOT THE 1980 GAME'S, DELIBERATELY. That maze is the most recognisable picture in
// the genre and it belongs to its publisher; what is free to reuse is the SHAPE OF THE PROBLEM it
// poses. So this layout is drawn from scratch to the rules the game needs (test/blockman-maze.test.js
// holds every one of them):
//
//   * one connected corridor network: every dot reachable from the start;
//   * no 2x2 open square anywhere -- an open square reads as a room, and lets a pursuer be shaken
//     off by circling, which takes the tension out of a chase;
//   * a pen in the middle with one gate, and a start below it;
//   * one wrap tunnel each side at the pen's height, so a chase can be escaped off-screen;
//   * four pellets out in the quarters, each a short run from a junction, so taking one is a choice;
//   * NO DEAD ENDS. Every open tile has at least two ways out, so a wrong turn is never fatal on its
//     own -- the first draft had twenty of them and played badly for it (operator, 2026-09-17:
//     "that maze sucks. Dead ends? a block that prevents passage?"). The layout is drawn on a
//     lattice of corridors three tiles apart and then has passages CLOSED, one at a time, each
//     closure kept only if the result still has no dead end, no 2x2 room and nothing cut off --
//     which is what gives the varied block sizes without the pockets;
//   * a long outer loop that can be run forever, and enough junctions that it cannot be run safely;
//   * left-to-right symmetry, so the maze reads as a picture and neither side is the good side;
//   * two "no upward turn" tiles above the pen: the cheapest way to make a pursuer commit to a route.
//
// WRITTEN AS ITS LEFT HALF. Fourteen columns a row, mirrored into twenty-eight, which is what makes
// the symmetry a property of the format rather than of my typing. The rows are the playfield only;
// the three HUD rows above and two below are the screen's, not the maze's.
//
//   #  wall        .  dot          o  pellet      (space) open, no dot
//   -  pen gate    G  pen inside   T  tunnel mouth (open, no dot)
//   S  where BlockMan starts (open, no dot)
//   ^  a dot, and a tile a pursuer may not turn upward on
//   E  the pen's exit shaft (open, no dot): the one place two open columns run side by side, because
//      the pursuers rise out of the pen along the seam -- the 2x2 rule exempts exactly these tiles
const HALF = Object.freeze([
  '##############',
  '#.............',
  '#.############',
  '#.############',
  '#o.........###',
  '#.##.#####.###',
  '#.##.#####.###',
  '#.##....##....',
  '#.#####.######',
  '#.#####.######',
  '#.##....##..^E',
  '#.##.##.##.##E',
  '#.##.##.##.##-',
  '#.##.##.##.GGG',
  'TTTTTT.....GGG',
  '#.##.##.##.GGG',
  '#.##.##.##.###',
  '#.##....##...S',
  '#.#####.####.#',
  '#.#####.####.#',
  '#....##.##....',
  '#.##.##.##.###',
  '#.##.##.##.###',
  '#o##.......###',
  '#.############',
  '#.############',
  '#.............',
  '##############',
]);

/** The playfield as 28-wide rows: the left half, then its mirror. */
export function mazeRows(half = HALF) {
  return half.map((row) => {
    if (row.length !== 14) throw new Error(`a maze row is 14 characters, not ${row.length}: ${row}`);
    const right = [...row].reverse().join('');
    return row + right;
  });
}

export const WALL = 1, OPEN = 0;

/**
 * The maze, parsed once: what is wall, where the dots are, the pen and its gate, the tunnels, the
 * tiles a pursuer may not turn upward on, and where everyone starts. Tiles are (x, y) with y down.
 */
export function parseMaze(half = HALF) {
  const rows = mazeRows(half);
  const h = rows.length, w = rows[0].length;
  const grid = new Uint8Array(w * h);
  // THE PEN AND ITS GATE ARE SOLID TO BLOCKMAN AND OPEN TO THE PURSUERS (2026-09-17, M3): they come
  // out through the gate and an eaten one goes back in, and he can do neither. So the maze carries
  // two grids -- his, and theirs -- rather than one with a special case at every call site.
  const gridG = new Uint8Array(w * h);
  const dots = [], pellets = [], tunnels = [], pen = [], noUp = [], exit = [];
  const starts = [];
  let gate = null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      const solid = c === '#' || c === 'G' || c === '-';
      grid[y * w + x] = solid ? WALL : OPEN;
      gridG[y * w + x] = (solid && c !== 'G' && c !== '-') ? WALL : OPEN;
      if (c === '.') dots.push({ x, y });
      else if (c === 'o') pellets.push({ x, y });
      else if (c === 'T') tunnels.push({ x, y });
      else if (c === 'G') pen.push({ x, y });
      else if (c === '-') gate = { x, y };
      else if (c === 'S') starts.push({ x, y });
      else if (c === '^') { dots.push({ x, y }); noUp.push({ x, y }); }
      else if (c === 'E') exit.push({ x, y });
    }
  }
  // The gate is written on the right of the pen in the half-row and mirrored, so the pen has one
  // opening in the middle of its top edge: that is where the pursuers come out and where an eaten
  // one goes back in.
  const penTop = pen.length ? Math.min(...pen.map((p) => p.y)) : null;
  const penXs = pen.length ? pen.map((p) => p.x) : [];
  const door = pen.length ? { x: (Math.min(...penXs) + Math.max(...penXs) + 1) / 2, y: penTop } : null;
  return {
    w, h, grid, gridG, rows, dots, pellets, tunnels, pen, gate, door, noUp, exit,
    // the mirror writes S twice, one either side of the seam: the start is between them
    start: starts.length ? { x: starts.reduce((a, s2) => a + s2.x, 0) / starts.length + 0.5, y: starts[0].y } : (door ? { x: door.x, y: door.y + 6 } : { x: 1, y: 1 }),
    at: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? WALL : grid[y * w + x]),
    /** The same question for a pursuer, which may cross the pen and its gate. */
    atG: (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? WALL : gridG[y * w + x]),
  };
}

/** The tiles a pursuer may not turn upward on: marked `^` in the layout, above and below the pen. */
export function noUpTurn(m) { return m.noUp; }

/** Every open tile reachable from `from`, by flood fill through open tiles (tunnels wrap). */
export function reachable(m, from) {
  const seen = new Set();
  const key = (x, y) => `${x},${y}`;
  const q = [{ x: Math.floor(from.x), y: Math.floor(from.y) }];   // a start may sit between two tiles
  seen.add(key(q[0].x, q[0].y));
  while (q.length) {
    const { x, y } = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let nx = x + dx, ny = y + dy;
      if (nx < 0) nx = m.w - 1; else if (nx >= m.w) nx = 0;      // the tunnel wraps
      if (ny < 0 || ny >= m.h) continue;
      if (m.at(nx, ny) === WALL || seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      q.push({ x: nx, y: ny });
    }
  }
  return seen;
}

/**
 * Every 2x2 of open tiles, which is the one shape this maze must not contain -- except the pen's
 * exit shaft, where two columns run side by side on purpose so the pursuers can rise out.
 */
export function openSquares(m) {
  // the shaft, and the corridor tiles at its mouth: the pursuers rise through two open columns
  const exempt = new Set([...m.exit, ...m.noUp].map((t) => `${t.x},${t.y}`));
  const out = [];
  for (let y = 0; y < m.h - 1; y++) {
    for (let x = 0; x < m.w - 1; x++) {
      const four = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]];
      if (!four.every(([ax, ay]) => m.at(ax, ay) === OPEN)) continue;
      if (four.every(([ax, ay]) => exempt.has(`${ax},${ay}`))) continue;
      out.push({ x, y });
    }
  }
  return out;
}

export { HALF };
