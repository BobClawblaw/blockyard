# Plan: BlockMan — a maze chase on the block engine

Operator, 2026-09-17: "Scope out a game called BlockMan that is a faithful legal recreation of the
pacman game, using our block engine."

Faithful to the **behaviour**, which is nobody's property, and none of the **expression**, which is
Bandai Namco's. This document says exactly where that line runs, then designs the game against the
block engine's measured limits.

## 1. What "faithful and legal" means here

The 1980 arcade game is a set of rules and a set of pictures and sounds. The rules can be
reimplemented; the pictures, sounds, characters, maze and name cannot.

**Taken, freely: the mechanics.** A single-screen maze cleared of dots; four pursuers that leave a
central pen on their own schedule; power-ups that reverse the chase for a few seconds; a wrap-around
side tunnel that slows pursuers; a chase/scatter rhythm that gets harsher by level; per-pursuer
targeting rules; fruit bonuses at fixed dot counts; an extra life at a score; dots that slow the
player for a frame as they are eaten (the reason a full corridor is slower than an empty one);
cornering, where a turn taken early cuts the corner; and the speed tables that make level 1 gentle
and level 21 relentless. All of that is documented publicly from disassembly, and re-deriving it in
our own code is the ordinary work of writing a game in the same genre.

**Not taken: the expression.**
- **The maze.** Our own layouts on our own grid. The 1980 wall geometry, dot placement, tunnel
  positions and the pen's shape are the game's most recognisable image, and courts have compared
  mazes directly (*Atari v. North American Philips*, 1982) and protected a game's look where its
  rules were free (*Tetris Holding v. Xio*, 2012).
- **The characters.** No yellow circle with a wedge mouth; no four ghosts with eyes and a scalloped
  hem; no cherry, no strawberry. BlockMan is a cube. Its pursuers are cubes.
- **The sounds.** No opening jingle, no siren, no wakka. Our own short pieces on the tone generator
  BlockYard already has.
- **The names.** "BlockMan", and four pursuers named for what they do (§4). Not Pac-Man, not Blinky,
  Pinky, Inky or Clyde.
- **No ROM.** Nothing in this game reads, ships or links to a ROM image, and nothing in the
  repository is derived from one. The ROM copies on the build machine are unrelated to it.

Apache 2.0 then covers the whole thing, like the rest of BlockYard, because every asset in it is
ours.

## 2. What the block engine can actually draw (measured 2026-09-17)

Measured in the headless browser (no GPU, so a real browser is faster), through the same `board3d()`
call Scorched Yard uses, with about 2% of the blocks changing colour on every frame:

| grid | blocks | frame rate | median frame |
|---|---|---|---|
| 28 × 36 (one block per maze tile) | 1,008 | 15 fps | 67 ms |
| 56 × 72 | 4,032 | 8.5 fps | 117 ms |
| 96 × 48 (Scorched Yard's field) | 4,608 | 6.4 fps | 150 ms |
| 112 × 144 | 16,128 | 4.6 fps | 217 ms |
| 224 × 288 (one block per arcade pixel) | 64,512 | 1.4 fps | 733 ms |

Shrinking the canvas does not help: 224 × 288 blocks ran at 1.4 fps into a 224-pixel canvas and
0.5 fps into a 672-pixel one, and turning the choreography off changed nothing material. The cost is
per block, not per pixel. **So a block per arcade pixel is out**, and even a block per maze tile
cannot be rebuilt every frame.

**The answer is the split Scorched Yard already uses**: layers, each redrawn only when it changes.

| layer | canvas | contents | redraw |
|---|---|---|---|
| sky | `bmSky` | the Galaxy or Earth sky, as any board | its own, slow |
| maze | `bmMaze` | the walls, as 1 block per wall tile (about 230 of the 1,008) | once a level, and on a level's wall change |
| play | `bmPlay` | dots, pellets, BlockMan, the four pursuers, fruit, scores | every frame, painted |
| hud | panel | score, lives, level, the keys table | on change |

The maze is a block layer and never moves. Everything that moves is **painted** on the play layer
through the engine's own `overlay(ctx, view, { project, softStops, lw })` hook, the way Scorched Yard
paints shells, blasts and its aim gauge over the cubes: same projection, same lamp, same look, and
its cost is a few hundred small fills a frame rather than a thousand rebuilt blocks. Dots are
projected discs; BlockMan and the pursuers are projected cubes drawn by hand (a face, a top and a
side, from the same shading the engine uses), so they sit in the board's perspective without going
through the scene builder.

Budget at 60 fps: 240 dots, 4 pellets, 5 actors, and the fruit. Measured cost of painted fills of
that order in this engine (Scorched Yard's tracers: 5,500 segments a frame before the audit, 320
tapered polylines after) says the play layer is a fraction of a millisecond. **A prototype of the
play layer at 60 fps is the first milestone (M1), because the whole design rests on that number.**

## 3. The board

- **Grid:** 28 × 36 tiles, the genre's shape: 28 wide, 3 rows of HUD at the top, 2 at the bottom.
  Our own layouts; the grid size is arithmetic, not expression.
- **Coordinates:** tiles of 8 × 8 game units, actors positioned in units, so cornering and the
  half-tile offsets of a centre line come out naturally. Speeds in units per second.
- **One maze, ours, for every level** (operator, 2026-09-17: "keep it one beautiful maze, like the
  original"). The 1980 game had one layout and it is remembered tile by tile; a game that reshuffles
  its maze every level is a different kind of game, because nobody ever learns it. So BlockMan gets a
  single hand-drawn layout, and the levels get harder through the speed and wave tables (§5), not
  through new geometry.

  It is drawn to the rules the genre needs and then tuned by play: one connected corridor network;
  no 2 × 2 open square anywhere (open squares let a pursuer be shaken off, and they read as a room
  rather than a corridor); a pen in the middle with one gate; one wrap tunnel on each side at the
  pen's height, so a chase can be escaped by leaving the screen; four pellets in the outer quarters,
  each a short run from a junction so a pellet is a decision and not a reflex; a long outer loop that
  can be run indefinitely, and enough dead ends that it cannot be run safely; symmetry left to right,
  because a maze that reads as a picture is remembered, and asymmetry would make one side the good
  side; and two "no upward turn" tiles above the pen, which is how the original made pursuers commit
  to a route without extra AI. Between 240 and 264 dots, so the dot-count events (fruit, Chaser's
  speed steps) land where the tables expect.

  The layout is a text block in the source, 28 characters a row, and `test/blockman-maze.test.js`
  holds every rule above, so tuning it is an edit and a test run rather than a leap of faith. The
  format allows a second layout later; the game ships one.
- **Look:** walls are cubes in the board's own palette (the Blockout/Tetrust neon family), one colour
  a level; dots are pale discs, pellets are bigger and pulse; the tunnel mouths are dimmer walls.

## 4. The pursuers

Four, each with one rule, all reimplemented from the genre's published behaviour and named for what
it does:

| name | colour | how it chases | scatter corner |
|---|---|---|---|
| **Chaser** | red | straight at BlockMan's tile | top right |
| **Ambusher** | pink | four tiles ahead of BlockMan | top left |
| **Flanker** | cyan | the point twice as far as Chaser's line through two tiles ahead of BlockMan | bottom right |
| **Wanderer** | orange | at BlockMan while more than eight tiles away, to its own corner when closer | bottom left |

Shared rules: they move on a tile grid, never reverse except when the wave changes; at each junction
they pick the exit whose centre is nearest their target, breaking ties up, left, down; they are
slower in the tunnel; frightened they wander at random and are drawn dim; eaten, they return to the
pen as a pair of eyes' worth of cubes and rejoin. Chaser speeds up in two steps as the level's dots
run out ("cruise elroy" in the genre's own terms), which is what makes late levels frantic.

Release from the pen follows the original's shape: a per-pursuer dot counter, plus a timer that
releases one if BlockMan stops eating.

## 5. The rhythm

- **Waves:** scatter/chase alternating, the scatter periods shortening by level, chase eventually
  permanent. Our own table, in the same shape as the genre's, tuned by playtest.
- **Speeds:** BlockMan at about 80% of a tile-per-frame reference at level 1, rising to 100% by
  level 5; pursuers slightly below him except in the tunnel; frightened pursuers much slower;
  BlockMan eats at a small speed penalty, so a fresh corridor is slower than a cleared one.
- **Frightened time:** falls by level, to zero by level 19, where pellets only score.
- **Scoring:** dot 10, pellet 50, pursuers 200/400/800/1600 within one pellet, fruit rising by level,
  an extra life at 10,000. High scores in the same local table Scorched Yard uses.
- **Lives:** three, and a level ends when the last dot goes.
- **Level 21 and beyond** stays playable: we are not reproducing the arcade's 256th-level overflow.

## 6. Controls, settings, sound

- **Keys:** arrows or WASD to turn (queued, so a turn pressed early is taken at the junction),
  **P** pause, **N** next level (cheat), **F2** restart, **M** music, **S** sound. A keys table on
  the panel, as Scorched Yard has.
- **Touch:** swipe on the board, and the arrows on screen under it at phone width.
- **Settings** (Display settings → Diversions → BlockMan): Sky (Galaxy/Earth/none, through the same
  `skyFor` table as every board), lives, starting level, difficulty (the speed table's scale),
  sound, music, attract mode, and a cheat switch that shows each pursuer's current target tile — the
  best way to *see* that the four rules differ, and a debugging tool while building them.
- **Sound:** our own, on the existing tone generator (`tetsound.js`'s scheduler and `SFX` table):
  a four-note opening, a two-tone eat that alternates, a rising arpeggio for a pursuer eaten, a
  falling one for a life lost, and a bass pulse whose tempo follows how many dots are left.

## 7. Where the code goes

Mirroring Scorched Yard's split, which the audit and the performance work both vindicated:

| file | contents |
|---|---|
| `public/js/blockman.js` | the rules: the maze, actors, AI targets, waves, scoring, `stepGame(g, dtMs)`. No DOM, no canvas. |
| `public/js/blockmanmaze.js` | the layouts, as text, and the parser that turns one into walls, dots, pen, tunnels and no-turn tiles |
| `public/js/blockmanfx.js` | the painted layer: dots, pellets, actors, fruit, the frightened flash, the eaten-score pop |
| `public/js/blockmanview.js` | the screen: canvases, the `board3d` maze layer, the overlay hook, the HUD, the keys, the settings switches, attract mode |
| `test/blockman.test.js` | the rules: every AI target on a fixed board, wave timing, pen release, cornering, scoring, a full level played by script |
| `test/blockman-maze.test.js` | every shipped layout: connected, no 2 × 2 opening, dot count, one gate, tunnels paired, no-turn tiles present |
| `test/blockman-view.test.js` | the page wiring (ids, switches), the canvas rules (no `clip`, no `globalAlpha`, no composite), and that the play layer paints without the scene builder |

`public/index.html` gains the four canvases and the panel; `app.js` gains one lazy import entry
(`blockman: () => import('./blockman.js')…`), as every game has since 0.1.1.

## 8. Milestones

*M1 to M6 landed 2026-09-17 on branch `blockman`. M1: the maze (264 dots, four pellets, one pen,
two tunnels), the block layer of 498 cubes built once, the painted play layer, and the measurement
it exists for -- **60 fps steady in the browser, median frame 16.7 ms**, with everything moving. M2:
the rules, played by 15 scripted tests, and a screen that plays them (keys, pause, restart, HUD).
Two bugs the measurement found: the play layer painted the maze out, because the renderer fills a
board's canvas before drawing; and a dot under a stopped BlockMan was never eaten. M3: the four
targets, the junction choice, the scatter/chase waves with their reversal, the pen's dot counters
and idle timer, Chaser's two speed steps, and cheat mode (T) ringing each target. Three more bugs,
all found by the tests: the pen's gate was a wall to the pursuers as well as to him, so Chaser
began level one inside a wall; a reversal was undone at the junction it happened on; and a
quarter-tile step could skip a junction, which sent an Ambusher into the wall above the shaft. The
pursuers now stop on every tile centre and decide there, and they have a grid of their own. M4: an
eaten pursuer crosses the maze as a pair of eyes at eye speed, waits a moment in the pen and
rejoins whatever the wave says; the fruit appears twice a level below the pen, keeps for nine and a
half seconds and is worth from 100 to 5,000 by level. Two more findings: the greedy targeting rule
that is right for a hunt made the eyes flip-flop between two equally distant tiles for ever, so the
walk home follows a distance field measured once per maze; and the fruit first sat on his respawn
tile, which handed him a free one every time he was caught.

M5: the death as the cubes coming apart, the level-clear flash through five wall colours, the
dot-count pulse, and -- after the first pass borrowed the shared blip table -- a THREE-VOICE
WAVETABLE GENERATOR of its own (`public/js/blockmansound.js`), which is the era's own technique
(three channels stepping a short table at a rate set by a frequency register) with every table
computed from a formula in the file and every patch our own pitches. M6: three difficulties as one
scale over the speed table, the top eight games kept in the browser, an attract mode that plays
itself, the `blockman` settings group with its switches mirrored on the game's panel, the user
guide's section and the changelog. One finding in M6: the attract player walked into a pursuer
because its danger rule was a cliff and equal ways broke to the first of them, so danger is now a
slope.*


1. **M1 — the play layer, measured.** A static maze block layer plus 240 painted dots and five
   painted actors moving on a script, and a frame-rate reading in a real browser. If this does not
   hold 60 fps, the design changes here and not later.
2. **M2 — the rules.** Maze parsing, BlockMan moving with cornering and queued turns, dots, pellets,
   level end, lives, score. Pursuers walk a fixed patrol. Playable, with tests.
3. **M3 — the four rules.** Targeting, junction choice, scatter/chase waves, reversal on wave change,
   pen release counters, tunnel slowdown, Chaser's two speed steps. The cheat overlay draws each
   target tile.
4. **M4 — frightened, eaten, fruit.** Pellet timing by level, the 200–1600 ladder, the return to the
   pen, fruit at two dot counts, the extra life.
5. **M5 — sound and the look.** *(landed)* Our own pieces, the dot-count pulse, the level-clear flash, the
   death animation as the cubes fall apart (the block engine's own death effect, as Scorched Yard
   does for a tank).
6. **M6 — the trimmings.** *(landed)* Attract mode for a wall screen, high scores, difficulty, the maze's final
   tuning pass by play (dot count, pellet placement, the tunnel's height), the user guide's section,
   the changelog.

Each milestone leaves the suite green and the game playable.

## 9. What is deliberately not in this

- **No pixel-perfect arcade screen.** §2 measured it at 1.4 fps; it is not a matter of tuning.
- **No ROM, no emulator.** BlockYard's DOS Diversions run real shareware because those releases
  permit it. This game ships no third-party asset at all.
- **No original maze, characters, sounds or name**, for the reasons in §1.
- **No second maze, no level editor, no multiplayer.** One layout is the design, not a shortcut: the
  levels differ by speed and rhythm. The format is text, so another layout or an editor is possible
  later without touching the rules.
