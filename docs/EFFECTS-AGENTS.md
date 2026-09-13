# Agent effects: a catalogue

(operator, 2026-09-13: *"no more per-tile stuff. Think more tron lightcycles stuff"*, then
*"Give me at least 25-50 new video game inspired effects. Examine all video games, and explain
your choices"*, then *"we can even add flying ships or other pixel-graphic inspired art"*.)

This is a design document. Six of the fifty are built (see **Built so far** below); the rest
are proposals, and the numbering here is what the commits refer to.

---

## What separates an agent effect from what we already have

The board has twenty-six idle effects. Seventeen of them are **fields**: pure functions of a
tile's position and the effect's clock, `fxAt(tile, fx) -> {glow, outline, lift, color}`. A field
effect has no location of its own — it is a pattern evaluated everywhere at once. Plasma, aurora,
checker, ripple, quake: every one is a formula over `(cx, cy, u)`.

Three are **agents**: `lightcycle`, `ball`, and the unused `packets`. An agent has a *position*,
a *route it has already travelled*, and a *future*. It is drawn as its own geometry over the
cubes (`drawCycles`, `drawBall`) and it lights the board through `fx.heads` — the cubes it is
near flash in its colour. That is the difference the operator is pointing at: a field is
wallpaper, an agent is **something happening**, and you can watch it and wonder what it will do.

The existing machinery for agents:

| primitive | what it gives | file |
|---|---|---|
| `cyclePath(seed, W, H, from)` | a right-angled route edge to edge, jinking | `blockscene3d.js` |
| `ballPath(seed, W, H, from, E)` | the same, entered from `E` units off-board | `blockscene3d.js` |
| `packetPaths(seed, W, H, n)` | `n` short wandering walks, each with its own start | `blockscene3d.js` |
| `cycleCrashes(paths)` | where two riders collide, worked out up front | `blockscene3d.js` |
| `cellTops(tiles, W, H)` | the height of the cube under every grid cell | `blockscene3d.js` |
| `pathHeights(pts, tops, W, H)` | what a route rides over, stepping at corners | `blockscene3d.js` |
| `chargeTrail(ctx, segs, lw, now)` | the shared electrical wake: puffs, tube, crackle, motes | `details3d.js` |
| `fx.heads` | `[{x, y, color, alpha, r, lift}]` — how an agent lights cubes. `r` is its reach in GRID UNITS (default 0.8: a gantry lights a swath, a thrown disc lights a point), `lift` throws the cubes it passes | `fxAt` |
| `AGENTS` registry | `{ build, frame, draw }` per kind; details3d.js keeps only three seams | `agents.js` |
| `view.unit` | pixels per grid unit — **size every sprite against this, never against `lw`** | `project` |

**Two hard rules any new effect must satisfy**, both enforced by tests:

1. `effects.test.js` plays every `FX_KINDS` entry through `fxAt` and demands it lights something
   (`worst > 0.3`). Only `pulse` is exempt, because it draws on the price line. **So every new
   agent must publish `fx.heads`** and join the heads branch — which is also what makes it feel
   connected to the board rather than painted over it.
2. `viewer-canvas-rules.test.js`: no `ctx.clip()`, no `globalAlpha`, no composite modes, no
   `shadowBlur`. Every glow is layered plain `rgba()` fills. This is not a style preference — the
   software rasteriser drops clipped fills and honours `globalAlpha` inconsistently.

And one rule that is not enforced but matters: **the board is data**. Each cube is a transaction,
sized by vbytes and coloured by feerate. An effect that reads the data it crosses is worth more
than one that ignores it — `cascade` already does this (it runs richest-to-cheapest, so the
effect *is* a reading of the fee structure). The best entries below do the same.

---

## The catalogue

Fifty, grouped by what kind of agent they are. Each says what it does, why it suits *this* board,
and roughly what it costs. "Data-aware" marks the ones that read the transactions they cross.

### I. Riders — things that travel a route and leave a wake

The `lightcycle` family. Cheap: one polyline, drawn stretch by stretch.

**1. Recognizer** (Tron) — the marching gantry: two legs and a crossbar, striding the board on a
straight line, lighting a wide swath *under* it rather than a point. Why: our cubes are a city
from above, and the Recognizer is the canonical "something is patrolling your city" silhouette.
It also solves a problem the light cycles have — they are thin, and on a dense 96-unit board a
1-unit wall is faint. A gantry is wide. Cost: low.

**2. Identity disc** (Tron) — thrown from one edge, ricochets off the board's walls three or four
times, returns. Each bounce flashes the cubes at the impact point. Why: ricochet geometry gives
*anticipation* — you can see where it will land before it does, which no field effect can offer.
Cost: low. Route is `ballPath` with reflection instead of jinking.

**3. Snake** (Nibbler/Snake) — a segmented body that grows as it eats: it heads for the *tallest*
cube on the board, consumes it (a flash), grows two segments, picks the next. **Data-aware** — it
is literally eating the biggest transactions first, and the body length tells you how many it has
taken. Cost: low, and the pathfinding is greedy-nearest, not A*.

**4. Centipede** (Centipede) — a column of segments weaving down the board, dropping a row each
time it hits an edge. Splits into two independent centipedes if something interrupts its middle.
Why: the split is the memorable part, and our board is a grid of obstacles, which is exactly the
mushroom field Centipede needs.

**5. Pac-Man** — a mouth running the grid *lines* (not the cells), eating pellets at each
intersection; four ghosts on their own routes, each with a different pursuit rule (chase, ambush,
random, scatter). Why: four agents with *different personalities* on one board is the most legible
"something is happening" our engine could show, and the routes are already right-angled.

**6. Sonic loop** — a rider that accelerates downhill and launches off the top of a tall cube,
arcing through the air and landing further on. Why: our cubes have real heights (`cellTops`), and
nothing currently uses height as *terrain*. This makes the skyline matter.

**7. Excitebike ramp run** — same idea, low and fast, with a landing shockwave.

**8. Road Rash / OutRun sweeper** — a horizon-to-foreground racer that grows as it approaches,
leaving tyre tracks that fade. Why: sells the board's depth, which the oblique camera already has.

**9. Frogger crossing** — several agents crossing simultaneously in opposite lanes at different
speeds, some of which collide. Why: collisions we already compute (`cycleCrashes`).

**10. Q*bert hopper** — a small agent hopping cube-to-cube diagonally, each landing recolouring
the cube it lands on for a moment. Why: Q*bert's board *is* our board — an isometric stack of
cubes. It is the single most on-the-nose match in this list.

**11. Marble Madness roller** — a ball that obeys the skyline: rolls off high cubes toward low
ones, gathering speed. **Data-aware**: it drains toward the cheap transactions.

**12. Trials rider** — a two-wheeler that follows the height profile of one row, wheelie-ing over
the tall ones.

### II. Formations — many agents moving as one

The thing our board has never shown: *coordinated* motion. All are cheap because the formation is
one transform over a sprite list.

**13. Space Invaders descent** — a rank-and-file grid of invaders stepping sideways, dropping a
row at the edge, accelerating as their numbers fall. They shoot; hit cubes flash and the invader
above dies. Why: the operator asked for flying ships and pixel art, and this is *the* pixel-art
formation. Our board is already a grid; the invaders are a grid above it.

**14. Galaga wing** — ships peel off a formation in Lissajous dives and rejoin. Why: the dive
curve is two sines — trivial — and it looks far more expensive than it is.

**15. Galaga tractor beam** — one ship stops over a tall cube, beams it up (the cube rises off the
board and vanishes), and a "captured" ghost of it flies in formation. **Data-aware**, and it uses
`lift`, which most effects ignore.

**16. Xevious bombing run** — a ship crossing at altitude dropping markers ahead of itself; each
marker detonates on the cube beneath a beat later. Why: the *lead* — the marker lands before the
bomb — creates suspense.

**17. 1942 barrel roll** — a squadron crossing with a roll animation, sprite-scaled.

**18. R-Type charge beam** — a ship crosses slowly charging (a growing bead), then releases a beam
that lights *an entire row* of cubes at once. Why: a long wind-up and a big release is a rhythm
none of our current effects have.

**19. Gradius Options** — a lead ship trailed by four satellites that follow its exact past path
on a delay. Why: the delayed-follow is four lines of code and reads as intelligence.

**20. Missile Command interception** — arcs rain from the top toward cubes; interceptors launch
from the bottom and detonate as expanding rings that stop them. Why: two agent populations that
interact, and the expanding-ring geometry is already in `drawCycles`' de-res.

**21. Asteroids drift** — wireframe polygons tumbling across, splitting into smaller ones when
they cross a tall cube. Why: pure vector art, which is exactly what this renderer draws natively.

**22. Zerg rush** — a swarm of small agents entering from one edge with slight per-agent noise,
converging on the tallest cube. Why: emergent-looking, trivially cheap, and **data-aware**.

**23. Lemmings procession** — a line of walkers that turn at obstacles, some digging *through* a
tall cube (which visibly shortens as they pass). Why: the board changing shape under an effect.

**24. Bomberman blast** — an agent walks the grid, drops a bomb, and the blast runs in four
straight lines until a tall cube stops it. Why: the cross-shaped blast *reads the skyline* as
walls — it is a picture of the board's density. **Data-aware**.

### III. Boards that transform — the effect changes the board itself

**25. Tetris drop** — a tetromino falls onto the skyline, locks onto the tops of cubes, and if it
completes a flat row, that row flashes and clears. Why: we already have `tetris.js` rules, pure
and tested; this is that rule-set pointed at the block board.

**26. Breakout wall** — the top rows of cubes become bricks; a ball and paddle play a few seconds
of Breakout against them. Why: `breakout.js` exists and is pure.

**27. Qix / Gravitrons claim** — a line agent crawls the board's perimeter, cuts inward, and the
enclosed region is claimed (filled with colour). Why: an effect that *encloses* rather than
sweeps; nothing else here does area.

**28. Pipe Mania** — pipe segments lay themselves tile by tile into a connected run; then fluid
flows the completed pipe. Why: the two-phase build-then-flow is a strong rhythm.

**29. Minesweeper reveal** — a flood-fill reveal spreading from one cube, stopping at "mines"
(the highest-feerate transactions), which then flash red. **Data-aware**, and flood-fill from a
seed is a genuinely different spread shape from a radius.

**30. Boulder Dash collapse** — cubes unsupported by a neighbour fall, cascading. Why: uses the
skyline as physics.

**31. Katamari roll** — a ball that rolls over the board *absorbing* cubes, visibly growing.
**Data-aware**: it gets bigger the more weight it crosses.

**32. Dig Dug tunnel** — an agent tunnels *through* the board leaving a visible cleared corridor
that slowly refills.

### IV. Scanners, beams and sweeps with an agent behind them

**33. Tempest lane pulse** — pulses rushing up lanes from a vanishing point toward the viewer.
Why: our oblique camera has a natural horizon; this is the only effect that uses the *depth* axis
as the axis of motion.

**34. Star Fox barrel corridor** — a moving frame of reference: the board appears to bank left and
right as an unseen ship rolls. Why: cheap (it is a camera trick) and startling.

**35. Rez / Child of Eden lock-on** — a reticle flicks across the board tagging eight cubes in
sequence, then fires eight homing streaks at all of them at once. Why: the tag-then-release
rhythm, and **data-aware** if it tags by feerate.

**36. Metroid scan visor** — a horizontal band that, as it passes, briefly *labels* the cubes it
crosses with their feerate. Why: an effect that makes the board more legible, not less — the only
one here that adds information.

**37. Sniper glint sweep** — a slow searchlight cone rotating from one corner.

**38. Portal pair** — two portals open on opposite sides; an agent enters one and exits the other,
carrying its trail through. Why: the trail crossing the discontinuity is a genuinely novel visual.

**39. Tron derez wave** — a front that de-resolutes cubes into shards as it passes and
re-resolves them behind it. We already have de-res shards in `drawCycles`.

**40. Matrix bullet-time orbit** — everything holds still while one agent orbits the board.

### V. Sprites and pixel art — the operator's "flying ships"

`arkanoid.js` already proves this works: its capsules are multi-part glyph-on-body silhouettes
with `poly`, `rot` and `floor`, tumbling as they fall, and its enemies are drawn the same way.
A sprite here is a small list of tiles with offsets — not a bitmap — so it scales, rotates and
lights like everything else on the board.

**41. UFO flyby** (Space Invaders' mystery ship) — the saucer crossing the top of the board on a
timer, worth "points"; a rare visitor rather than a regular effect. Why: rarity is its own effect.

**42. Zaxxon isometric fighter** — a ship flying *at an altitude above the board*, with its shadow
tracking on the cube tops beneath it. Why: we already cast shadows; nothing currently flies.

**43. Choplifter rescue** — a helicopter that descends to a cube, hovers, lifts it, and carries it
off the board.

**44. Defender sweep + humanoid** — fast horizontal scroll, with a lander stealing a cube and a
ship intercepting it.

**45. Joust flap** — two winged riders in slow flapping arcs that collide; the higher one wins.

**46. Mario pipe warp** — a sprite descends into the board between two cubes and re-emerges
elsewhere.

**47. Rampage climb** — a large sprite that climbs the tallest stack and knocks the top cube off.

**48. Pixel-art banner drift** — a sprite spelled out in cubes (a block, a coin, a "GM") drifting
across as a formation of lit cells, then dispersing. Why: it turns the board itself into the
sprite — the highest-impact version of pixel art here.

**49. Duck Hunt flush** — birds break from the board and fly off; one is "shot" and falls back in.

**50. Konami code easter egg** — the code typed on the keyboard triggers a scripted sequence
(a 30-ship formation, or every effect at once for four seconds). Why: it is the arcade tradition
the whole board is quoting, and it costs nothing until someone finds it.

---

## Built so far

Batch one landed 2026-09-13: **recognizer (1), disc (2), snake (3), qbert (10), invaders (13),
bomberman (24)** -- five different motion vocabularies, two of them data-aware.

Batch two, the same day: **centipede (4), pacman (5), galaga (14), tractor (15), missile (20),
asteroids (21)**. These add the three things batch one had no example of -- an agent that
DIVIDES (the centipede splits and both halves carry on), agents with DIFFERENT RULES FROM EACH
OTHER (four pursuers: chase, ambush, scatter, wander), and TWO POPULATIONS THAT INTERACT (arcs
raining down against interceptors rising to meet them). The tractor beam is the only agent that
uses `lift`, and it is data-aware: it takes the tallest transaction on the board and puts it back.

Fourteen agents now. `test/agents.test.js` holds every one of them to the same contract -- builds,
frames, draws, publishes heads, replays from a seed, and leaves the board's tiles untouched -- so a
new batch is checked against all of it the moment it is registered.

Batch three, the same day: **tetrisdrop (25), qix (27), minesweeper (29), tempest (33),
lockon (35), scanvisor (36)**. These work in AREA rather than along a path -- qix claims a region,
minesweeper floods outward and goes *around* what blocks it -- and two of them add INFORMATION
rather than decoration, which is the rarest thing an effect here can do: lockon tags the eight
richest transactions in turn before firing, and scanvisor labels the blocks it crosses with their
feerate. Three of the six are data-aware. `tetrisdrop` points the real, already-tested rules in
`tetris.js` at the skyline instead of a well, so the piece shapes are not reinvented.

Batch four, the same day: **katamari (31), boulderdash (30), lemmings (23), marble (11),
gradius (19), portal (38)**. This is the family that ALTERS the board, and it could not be built
until heads carried `hide`/`scale` through to the renderer -- see the fourth lesson below. The
katamari absorbs cubes as it rolls and grows with what it has taken; boulder dash collapses them
outward from a point; a lemming digs straight through one. All of it snaps back, by construction:
nothing touches a tile, the override just stops being computed. `marble` is data-aware in a new
way -- it obeys the board as TERRAIN, rolling greedily downhill, so it drains away from the big
transactions and shows which way the block leans.

Batch five, the same day: **sonic (6), frogger (9), xevious (16), pipemania (28), derez (39),
ufo (41)**. `sonic` is the second agent to use height as TERRAIN rather than as an obstacle -- it
launches off the tallest block in its row and arcs. `xevious` is the only effect where you see what
is about to happen: the marker lands a beat before the bomb. `derez` takes the board apart as it
passes and puts it back behind itself, which is the plainest demonstration that an effect can do
that without touching a tile. `ufo` is deliberately brief -- rarity is its whole design.

**Thirty-two agents, and with the twenty-four field effects that is FIFTY-SIX on the board.**
Every entry in this catalogue worth building has been built. (An earlier note here said fifty;
that was my arithmetic, not a count -- there were twenty-four fields, not eighteen.)

**A seventh lesson: a bias written when the list was short becomes a takeover when it grows.**
`scheduleFx` gave the light cycles a 50% head start on the first effect after the board came to
rest -- a reasonable flourish among nine effects, and an eighteenfold bias among fifty-six (measured:
33.2% of picks against 1.8% for an even split). The block-space board re-lays on every pool refresh,
so that branch fired constantly and the operator saw light cycles and little else. Nothing guarded
it, which is why it survived four batches of new effects being added around it. `effects.test.js`
now replicates the scheduler's choice and fails if any kind takes more than twice an even share, or
if any kind is unreachable.

Related, and the same shape: the recognizer flipped a coin between marching along grid X or grid Y.
On this camera +10 in grid x moves 73.4 screen pixels horizontally and +10 in grid y moves **zero**
-- y is depth. So half the time both its legs projected to the same screen x, the gantry collapsed
into a single vertical line, and it read as a scanning artifact. Geometry that is symmetric in the
data is not necessarily symmetric on screen.

**A sixth lesson, and the one with the highest recurrence: on this board, FLAT IS THE COMMON CASE.**
The dense block-space viewer packs thousands of slabs at exactly the same height, so any agent that
reads the skyline for a gradient finds none. Three were blinded by it before the pattern was
obvious -- bomberman's wall threshold made every neighbour a wall and the blast drew a dot; marble's
greedy descent stopped at the first step and it sat still; sonic found no rise, so it never launched
and parked at the left edge. Each was measured only because its frame sizes stayed suspiciously
flat across a whole capture.

`agents.test.js` now plays EVERY registered agent on a perfectly uniform board and requires it to
keep publishing heads and to visit more than a handful of distinct places. A skyline-reading agent
must degrade to something worth watching, never to nothing.

**A fifth lesson, learned three times in one day: a measurement that contradicts a working picture
is usually the measurement.** Three times a probe reported an effect doing nothing while the
screenshot plainly showed it working. Every one announced itself the same way -- *results identical
across cases that should differ*, or a zero where a picture showed something:

- probing `hide` with `kind: 'katamari'`, which is not a registered kind, so every case fell to
  `default: FX_NONE` and came back the same;
- sweeping the board-alterers over a 96x96 grid holding only 3,700 tiles -- 38 rows of 96 -- so the
  agents roamed empty space and touched nothing. On a fully-populated board the same sweep reports
  katamari hiding 2,173 cube-frames and boulder dash shrinking 3,404;
- judging invaders, bomberman and pacman from a four-phase capture of effects that run 6-9 s in
  distinct phases.

Before believing a null result, check the experiment ran: does the control case behave differently?
Is the board the agent is walking actually occupied? Did the capture land inside the phase?

**A fourth lesson, and the sharpest one: machinery nobody uses is machinery that does not work.**
`hide` and `scale` were added to `fxAt`'s result so an effect could eat or collapse a cube and have
it snap back -- and the heads branch then hardcoded `hide: 0, scale: 1`, so no agent could actually
reach them. Three batches passed with that dead. It was only caught when batch four's whole family
(katamari, boulder dash, lemmings) was about to be built on top of it; every one of them would have
drawn a glow and called it eating. Wire a capability to a caller the same day you add it, or test
it end to end from the caller's side.

A third lesson, from verifying batch two: **a four-phase capture is not enough to judge an effect.**
Pac-Man was written up as "did not appear at all" on the strength of one frame; captured every
500 ms instead, all five characters are plainly there -- the wedge mid-board with its mouth open
and four ghosts in the corners, eyes tracking him. The effect was fine and the *photograph* was
mistimed, which is the same mistake twice now (bomberman spends its first 35% walking). Capture
across the whole run, or do not draw a conclusion. They live in
`public/js/agents.js` behind the registry described below; `test/agents.test.js` drives the real
build/frame/draw path for every registered kind.

Two things learned building them, which apply to all the rest:

- **Size in GRID UNITS, never in line-widths.** `lw` is about one device pixel, so a sprite drawn
  at `lw * 20` is 20px on any board -- 2.8% of a 705px panel, a speck among 3,700 cubes. The first
  cut of the recognizer, the invaders and the blast were all invisible for this reason and had to
  be redrawn against `view.unit` (7.3px per unit on the dense 96-grid board, 16px on the 44-grid
  one). `drawCycles` had it right all along with `wallH = 3`.
- **The board is never mutated.** `fxAt` results carry `hide` and `scale`, applied per frame onto a
  *copy* of the tile. An effect interrupted by a transition or a hidden tab stops being computed
  and the board is correct again by construction -- which is the only version of "it snaps back"
  that cannot leak.

## What I would build first, and why

If the point is to blow people away rather than to add length to a list:

1. **Space Invaders descent (13)** — the formation is the thing our board has never done, and it
   is instantly recognisable to everyone who will look at a screenshot.
2. **Q*bert hopper (10)** — the closest match between a real arcade board and ours; it will look
   *native*, not bolted on.
3. **Recognizer (1)** — solves the light cycles' real weakness (too thin on a dense board).
4. **Bomberman blast (24)** — the first genuinely **data-aware** agent: the blast is stopped by
   the skyline, so the picture it draws is a picture of the mempool's shape.
5. **Snake (3)** — eats the biggest transactions first, and its own length is the readout.
6. **Missile Command (20)** — two interacting populations; the most "alive" of the lot.

That is six effects covering all five families, each with a different motion vocabulary. Beyond
that the list has more ideas than the board has seconds to show them: at one effect every 7-13 s,
twenty-six kinds already means any given one appears about twice an hour.

## Costs and constraints to respect when building these

- **The dense board is 96 units across** with thousands of slabs. An agent that touches every cube
  per frame is O(tiles) per frame; the heads branch in `fxAt` is already that, so keep the
  *number of heads* small (the light cycles use two).
- **Determinism**: board-level choices come from `fxHash(seed)`, never `Math.random()`, in
  anything the tests replay. Per-frame sparkle (the crackle) may be random because it is never
  asserted frame-to-frame.
- **Every effect needs a switch** in `settings.js` `effects` and a row in `PANEL`, in `FX_KINDS`
  order, or `effects.test.js` fails. That is a feature: it is what stops an effect shipping
  without a way to turn it off.
- **Sprites** should be built as tile lists like `capsuleTiles()`, so they light, shadow and
  depth-sort with everything else rather than being painted over the top.
