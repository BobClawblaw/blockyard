# Scorched Yard — a plan for a Scorched Earth Diversion

*Scoped 2026-09-16, before any code. Operator: "Scope out a plan for re-creating the classic PC
DOS game Scorched Earth using our engine. I suggest using blocks to generate the deformable
landscape unless you have a better idea. Make it at least 3 player. 1 Human Player and 2 AI
Players. Try to reproduce it as faithfully as possible, but make it look fabulous as an
additional new diversion."*

The working name is **Scorched Yard** (Tetrust, Blockout, Blockanoid, Scorched Yard). The name,
like every "decision" flagged below, is the operator's to change.

## 1. What Scorched Earth is, and what "faithful" means here

Scorched Earth (Wendell Hicken, 1991) is a turn-based artillery game: two to ten tanks sit on a
randomly generated side-view landscape; each turn a player sets a **barrel angle** (0–180°) and a
**power** (0–1000), picks a **weapon**, and fires. Shells fly under **gravity** and **wind**,
carve **craters** out of the ground where they land, and the dirt above a crater **falls** to fill
it. Tanks take damage from blasts, fall when the ground goes from under them (and take damage
for the fall unless they have a parachute), and die in a blast of their own. Between rounds
every player spends the **cash** they earned on weapons and defensive items in a **shop**. The
game is a fixed number of rounds; the winner is the highest score.

What makes it *Scorched Earth* rather than any artillery game, and what this plan reproduces:

- the deformable dirt that falls and settles, so every crater reshapes the fight;
- wind that changes between turns (or every shot, as a setting), and the four **wall** modes:
  concrete (shells explode on the edge), rubber (they bounce), wraparound, and none;
- the weapon roster with its personalities — Baby Missile to Death's Head, Funky Bomb, MIRV,
  Leapfrog, Rollers that run downhill, Napalm that flows and burns, Diggers and Sandhogs that
  tunnel, Riot charges that clear dirt without hurting, Dirt Clods and a Ton of Dirt that add
  it, Tracers that show the wind, the Laser;
- the items — Shields (plain, deflector, force), Parachutes, Batteries, Mag Deflector, Auto
  Defense, Fuel (tanks can drive), Contact Triggers, Heat Guidance;
- the AI personalities by name — Moron, Shooter, Poolshark, Tosser, Chooser, Spoiler, Cyborg,
  Unknown — with their distinct habits;
- cash for kills, interest between rounds, the shop with weapons sold in packs;
- and the small things people remember: tanks that talk ("Nuke 'em"), the death explosion,
  the trace of the last shot, the sky that changes each round.

What it will not reproduce: the VGA look. The original is 640×350 pixels of flat colour; this
one is built from the engine's cubes on the oblique camera, with the effects library for the
blasts and the star field or a day sky behind it. Faithful in the mechanics, fabulous in the
look.

## 2. The landscape: blocks, as suggested — and how

The operator's suggestion is the right one, with one refinement. The playfield is a grid of
`W × H` cells (proposed **80 × 40**, an aspect of 2:1 like the original's 640×350 minus its
status bar); the ground is a **bitmap of dirt cells** over that grid, not merely a height per
column, so that tunnels, overhangs and caves exist (Diggers and Sandhogs need them, and so does
the moment when a Nuke leaves an arch of dirt that then collapses). Each column also keeps its
top for the fast questions (where does a shell land, where does a tank sit).

*(M1 found otherwise: under the oblique camera a tile's height climbs 0.3 of a row per unit, so a
tall run does not stack against the run above it -- the strata drew as floating ribbons. The land
is a cube per cell after all, on its own canvas redrawn only when the dirt changes, with the
actors on a transparent canvas over it; the tile budget below is therefore per change, not per
frame, and the measured build for 1,600 cubes is well under a frame.)*

The plan as first written: the engine draws it as **one tile per vertical run of dirt**, not one cube per cell:
`{ txid: 't<x>:<base>', x, y: base, s: 1, tall: runLength, color }`. A column with no holes is
one tile; a column with a tunnel is two or three. That keeps the tile count at a few hundred
(the block-space board draws a thousand at full resolution without trouble) while every cell
stays individually removable. Colour comes from **strata**: a grass or snow cap, soil, clay,
rock, and a magma glow at the very bottom, with a per-column hash nudging each shade so the
face is not flat colour. A run that crosses a stratum boundary is split so each piece keeps
its stratum's colour. `cellTops` in the engine already reads a heightmap off a tile set; the
game keeps its own to avoid the round trip.

**Generation** follows the original's landscape styles as a setting: rolling hills (a sum of
low-frequency sines with seeded phases), mountains (higher amplitude, a ridge), a valley, a
plateau, flat, and random. Tanks are placed on the surface at spaced columns, the surface under
each tank flattened for two cells, as the original does. Everything is drawn from a seeded RNG
(`agents.rng`) so a round is reproducible in tests.

**Craters.** A blast of radius `r` at `(cx, cy)` clears every dirt cell inside the circle. Dirt
weapons add cells the same way. Diggers clear along the shell's path. Napalm converts cells at
the surface it flows over.

**Settling.** After any change, every column is scanned: a run of dirt above a hole falls until
it rests on the run below it. The rules commit the new bitmap at once; the screen animates the
fall with the engine's own `fallMs`/`bounceDrop` timing by handing the falling runs to the
board with a `floor` offset that decays to zero (the same mechanism as Tetrust's cleared-line
drift, in reverse). Tanks standing on a falling run fall with it and take the original's fall
damage unless a parachute is fitted (which then is consumed).

## 3. Physics, shells, and walls

All motion is in the plane of the playfield, in grid units, integrated with substeps the way
Blockout does (`MAX_STEP` per substep, so a full-power shot never tunnels through a two-cell
ridge; a test holds this at coarse frame times). The shell is a tile: `{ txid: 'shell', x, y,
s: 0.4, sphere: true }` with a lit trail drawn over it (`chargeTrail`/`bloom`). Its state is
`{ x, y, vx, vy }`; each substep applies gravity `g` (a setting, the original's 1.0 = Earth) and
wind `w` (a per-turn value; "wind changes every shot" is a setting, as is "no wind"); a
viscosity setting damps velocity as the original's "air viscosity" does.

Collision each substep: with dirt (the cell at `floor(x), floor(y)` is dirt), with a tank's
hitbox (2 wide × 1.4 tall), with the floor (`y ≤ 0`), and with the walls by mode:

- **concrete**: the shell explodes at the wall;
- **rubber**: `vx = -vx × 0.8` and it carries on;
- **wraparound**: `x` wraps to the other side;
- **none**: the shell is lost off the side (the original's "no walls").

The ceiling is open: a shell can leave the top of the screen and come back down; while it is
above the field the side panel shows a marker at its `x` and its height.

Every weapon is a shell with a **behaviour**: what it does on impact, at its apex, on every
bounce, or every substep. That table is the whole roster (§4); the physics is shared.

## 4. The roster

*Checked against the manual on 2026-09-16* (SCORCH.DOC, the copy at abandonwaredos.com). The
manual's tables are the ones below; `public/js/scorchedshop.js` carries them as data, with each
blast radius (pixels on the original's 640-wide screen) divided by 6.67 for a 96-cell field.
Damage is ours: the manual does not number it. The manual's own defaults: **$0 to start, 5%
interest, walls NONE, computers buy ON**; ours starts with $10,000 so the first shop has a use
(a setting, down to 0).

**Weapons** (cost · bundle · radius px · arms level): Baby Missile $400·10·10·0 (unlimited: you
always have 99) · Missile $1,875·5·20·0 · Baby Nuke $10,000·3·40·0 · Nuke $12,000·1·75·1 · Leap
Frog $10,000·2·20/25/30·3 · Funky Bomb $7,000·2·80·4 · MIRV $10,000·3·20·2 · Death's Head
$20,000·1·35 ×9 warheads·4 · Napalm $10,000·10·2 · Hot Napalm $20,000·2·4 · Tracer $10·20·0 ·
Smoke Tracer $500·10·1 · Baby Roller $5,000·10·10·2 · Roller $6,000·5·20·2 · Heavy Roller
$6,750·2·45·3 · Riot Charge $2,000·10·36 (a wedge from the turret)·2 · Riot Blast $5,000·5·60
(wider wedge)·3 · Riot Bomb $5,000·5·30·3 · Heavy Riot Bomb $4,750·2·45·3 · Baby Digger
$3,000·10·0 · Digger $2,500·5·0 · Heavy Digger $6,750·2·1 · Baby Sandhog $10,000·10·0 · Sandhog
$16,750·5·0 · Heavy Sandhog $25,000·2·1 · Dirt Clod $5,000·10·20·0 · Dirt Ball $5,000·5·35·0 ·
Ton of Dirt $6,750·2·70·1 · Liquid Dirt $5,000·10·2 · Dirt Charge $5,000·5 (a wedge of dirt)·1 ·
Earth Disrupter $5,000·10·0 · Plasma Blast $9,000·5·10–75·3 · Laser $5,000·5·2.

**Accessories**: Heat Guidance $10,000·6 · Ballistic Guidance $10,000·2 · Horz Guidance
$15,000·5 · Vert Guidance $20,000·5 · Lazy Boy $20,000·2 · Parachute $10,000·8 · Battery
$5,000·10 · Mag Deflector $10,000·2 · Shield $20,000·3 · Force Shield $25,000·3 · Heavy Shield
$30,000·2 · Super Mag $40,000·2 · Auto Defense $1,500·1 · Fuel Tank $10,000·10 · Contact
Trigger $1,000·25. (The guidance systems and Lazy Boy are v2.) Shield strengths are not
numbered in the manual; ours are 60 / 100 / 150.

**The computer players, in the manual's words** (for M3): Moron — "pick an angle and power, and
shoot"; Shooter — "significantly deadlier … only if they have a straight line of fire";
Poolshark — "act like Shooters unless … rebounding walls. Then they try to rebound shots";
Tosser — "start out like Morons, but they'll refine their aim … until they hit"; Chooser —
"have all the above methods available … decide which one will be most effective"; Spoiler —
"taking into account the wind factor and gravity, they will get a perfect shot almost every
time"; Cyborg — "use methods similar to the Spoilers, but are much nastier … attack tanks who
are weakened, winning, or have attacked them"; Unknown — "one of the above will be chosen
randomly … you will not be notified". Walls in the original: CONCRETE, PADDED, RUBBER, SPRING,
WRAP, RANDOM, ERRATIC, NONE.

The table as first planned, superseded by the above:

### Weapons (v1 — the first playable set)

| weapon | behaviour | crater r | blast damage |
|---|---|---|---|
| Baby Missile | explodes on impact | 1.5 | small |
| Missile | explodes on impact | 2.5 | moderate |
| Baby Nuke | explodes on impact | 4 | heavy |
| Nuke | explodes on impact | 6.5 | very heavy |
| Death's Head | explodes on impact | 9 | most of the field |
| Funky Bomb | bursts into 6 bomblets that scatter and explode | 2 each | moderate each |
| MIRV | splits at apex into 5 shells fanning out | 2.5 each | moderate each |
| Leapfrog | explodes, then bounces on twice more, exploding each time | 2.5 ×3 | moderate ×3 |
| Tracer | no crater, no damage; leaves its arc drawn until the next shot | 0 | 0 |
| Smoke Tracer | as Tracer, with a smoke trail that drifts on the wind | 0 | 0 |
| Roller | on landing rolls downhill until it meets a tank or the bottom of a dip, then explodes | 2.5 | moderate |
| Heavy Roller | as Roller, bigger | 4 | heavy |
| Riot Charge / Riot Blast / Riot Bomb | clears dirt in a small / medium / large radius, no damage to tanks | 3 / 5 / 7 | 0 |
| Dirt Clod / Dirt Ball / Ton of Dirt | adds a ball of dirt on impact | +2 / +4 / +7 | 0 |
| Napalm / Hot Napalm | on impact becomes liquid that flows downhill and burns what it touches over several turns' worth of frames | surface | burn per contact |
| Sandhog / Heavy Sandhog | on impact tunnels on along its heading through dirt, exploding at the end | 1 along the bore, 3 at the end | moderate at the end |
| Baby Digger / Digger / Heavy Digger | on impact digs straight down, exploding at the end | 1 / 1.5 / 2 along the bore | small at the end |
| Laser | instant straight line from the barrel; burns dirt and tanks along it | 0.6 along the line | moderate, by exposure |

### Items (v1)

| item | what it does |
|---|---|
| Shield | absorbs damage until spent (a coloured halo on the tank; the halo dims as it goes) |
| Deflector Shield | as Shield, and shells that hit it bounce off |
| Force Shield | a stronger Shield |
| Parachute | opens when the tank falls, cancelling fall damage; one per fall |
| Battery | restores health, used from the item slot on your turn |
| Mag Deflector | shells passing near the tank are pushed away (a field, not a wall) |
| Auto Defense | on the turn a shield would help, it is raised automatically |
| Fuel Tank | lets the tank drive left or right along the surface, one cell per unit of fuel |
| Contact Trigger | the shell explodes on the first thing it touches, including a shield or a tank's hull, rather than only on dirt |
| Heat Guidance | the shell bends toward the nearest tank in its last part of flight |

### v2 (after the first playable build)

Plasma Blast, Earth Disrupter, Liquid Dirt, Lazy Boy (a guided shell the player steers), the
"suicide" options, and the talk table's full set of taunts.

## 5. Turns, rounds, and the economy

- A **game** is `rounds` rounds (setting; default 5). Each round: generate a landscape (new
  seed), place every living-and-dead tank afresh with full health (100), wind for the round.
- A **turn**: the current tank's player sets angle, power and weapon (or drives, or uses an
  item), then fires. The shell plays out, craters carve, dirt settles, tanks fall, damage is
  applied, deaths explode. Then the next living tank in order. Turn order rotates each round.
- **Death**: health ≤ 0. The tank explodes with the force of a random weapon from its own
  inventory (the original's habit; a setting to turn it off), which can chain. The killer is
  credited: cash per point of damage dealt, and a kill bonus; a tank that kills itself pays.
- **Round end**: one or zero tanks alive. Survivors score; interest is paid on cash (setting,
  default 5%); the **shop** opens for every human player (AI players buy by their personality's
  taste: Chooser buys wisely, Moron buys Baby Missiles). The shop lists every weapon and item
  with its price and pack size and the count owned, and shows cash.
- **Game end**: the highest score; the scoreboard shows kills, damage dealt, cash left, and the
  weapon that did the most damage. High scores in `localStorage` as the other games keep them.

## 6. The three players, and the AI

At least three players: the human plus two AI, default. The setting allows two to six, any
mix of human and AI, each with a name and a colour (the original's tank colours), and the
personality per AI player. All-AI is allowed: it is the demo the original shipped with, and it
runs on the Kiosk as an attract mode if the operator wants it there.

**Personalities**, each a strategy in `scorchedai.js`:

- **Moron**: random angle and power, cheapest weapon.
- **Shooter**: aims at the nearest tank with a rough ballistic guess, then **corrects from the
  last shot's miss** (bisects power, then angle); picks a bigger weapon when close.
- **Tosser**: high lobs (angles 60–85°) with the Shooter's correction; likes Funky Bombs and
  MIRVs, which suit lobs.
- **Poolshark**: only exists under rubber walls; aims bank shots off a wall, correcting the
  same way.
- **Chooser**: the Shooter's aim with a weapon chosen by the distance and the target's health
  (a Nuke on a close, healthy target; a Baby Missile to finish one off); spends its cash well.
- **Spoiler**: the Chooser's aim aimed at the current **leader**, not the nearest.
- **Cyborg**: solves the shot outright — angle and power from the target's position, gravity
  and wind, by a short numeric search that integrates the same physics the shell uses — with a
  small error that shrinks each round; the hardest opponent.
- **Unknown**: one of the above, drawn at the start of each round.

A test holds each one to its habit: the Cyborg hits a stationary tank on flat ground within
two shots; the Shooter's misses shrink monotonically; the Moron's do not.

The AI shares nothing with the screen: it takes the rules' state and returns
`{ angle, power, weapon }` (or `{ drive }` / `{ item }`), so it is testable headless and could
one day be an effect (the missile agent already flies arcs across the block-space board).

## 7. The look: fabulous, on this engine

- **The field** on the oblique camera (`oblique: { ox: 0.10, oy: 0.30 }`, `dome: 0`, `light:
  'overhead'`), the strata colours above, a faint neon grid off by default (the court games'
  quiet grid as an option), the space floor.
- **The sky** as its own canvas behind a transparent board, exactly as Tetrust does: the star
  field with the galaxy by default; **day skies** as an option — dawn, noon, dusk, storm —
  built from `softStops` fills (a sun disc with a halo, a band of colour at the horizon), and a
  seeded pick per round so the sky changes as the original's did. Weather that the original
  only hinted at can be real here: rain streaks under the storm sky, snow on the caps.
- **Tanks**: a two-cube hull in the player's colour with a sheen, a turret cube, and a barrel
  as a `poly`+`rot` tile that turns with the angle; a floating name and health bar over it;
  the shield as a translucent halo ring (`ring`, `bloom`); the parachute as a `poly` canopy
  while falling.
- **Shells**: a `sphere` tile with a hot trail; MIRV's split as a spark burst; the Roller as a
  spinning `poly`; napalm as lit, flickering surface cells that dim as they burn out; the
  Laser with `drawSaberLine`'s glow and core.
- **Blasts**, by size: a white flash and a shockwave ring for small shells; the supernova's
  treatment for nukes — flash, `gasCloud` smoke that rises and drifts on the wind,
  `lensFlare`, a shockwave that lights the cubes it crosses (through the same per-tile
  lighting the effects use, `heads` with a colour and a radius) and shakes the tanks it
  reaches; Death's Head whites the sky out for a moment.
- **Dirt** falls with the engine's gravity and lands with its bounce; dust puffs where it
  lands. A tank's death is a fireworks shell in its colour, the hull tumbling as a `poly`.
- **The last shot's trace** stays drawn until the next, as the original's did; Tracers keep
  theirs for the turn.
- **Sound** through `tetsound.js`: a thump for the shot, a whistle that falls as the shell
  does, a crack or a rumble for the blast by size (the synth gains a noise burst for this — a
  short buffer of noise, still no files), a hiss for napalm, a chime for the turn, a fanfare
  for a kill; a chiptune theme of its own with the music switch.
- **Talk**: a line over the tank when it fires or is hit, from the original's tables ("Nuke
  'em", "Just wait 'til my turn", "Oops"), a setting.

None of this is on the critical path: M1 plays with plain cubes, a flash and a ring.

## 8. Controls and the side panel

Keys, following the original where it had them: **←/→** angle by 1° (Shift: 5°), **↑/↓**
power by 10 (Shift: 1, Ctrl: 100), **PgUp/PgDn** or **[ ]** weapon, **Tab** item, **Space** or
**Enter** fire, **A/D** drive (with fuel), **B** battery, **S** shield, **Esc** pause, **F**
fast shells (skips the flight's slow part), **N** next round from the scoreboard. Mouse: drag
from the tank to aim (direction is the angle, length is the power), click fire. Touch the same.

The side panel (the `.tethud` card): whose turn (name, colour), angle and power readouts, the
weapon with its count, cash, the wind gauge (an arrow with the value), every tank's health
bar, the round counter; Keys; Switches (stars, galaxy, music, sfx, fast shells, talk); High
scores. Between rounds the panel becomes the shop.

## 9. Files, settings, wiring, tests

**Files** (the rules/screen split every game here keeps):

- `public/js/scorched.js` — rules, zero DOM: landscape generation, the dirt bitmap and its
  tops, craters and settling, tanks, the shell integrator with walls and wind, damage, turns,
  rounds, cash; `newGame(opts, seed)`, `fire(g, angle, power, weapon)`, `step(g, dtMs)`,
  `tiles(g)`; every random choice from a seeded stream.
- `public/js/scorchedshop.js` — the weapon and item table (behaviour, price, pack, damage,
  radius) as data; the shop's arithmetic.
- `public/js/scorchedai.js` — the personalities.
- `public/js/scorchedyard.js` — the screen: `FIELD` and `SKY` options, the frame loop with the
  page/hidden pause, input, the panel and the shop DOM, the effects drawn over the board, the
  sounds, `localStorage` scores, `renderScorchedYard(s, state, h)`.
- `public/js/tetsound.js` — the new sound names and a noise burst.

**Settings** (`settings.js`): a `scorched` group in the Diversions row with `stars`, `galaxy`,
`galaxyAt`, `sky` (space / dawn / noon / dusk / storm / random), `grid`, `gridColour`,
`gridBrightness`, `neon` (the tanks' finish), `sfx`, `music`, `talk`, `fastShells`, and the
game's rules that the original exposed: `players` (2–6), `ai` (the personalities per slot),
`rounds`, `walls`, `gravity`, `wind` (none / steady / changes each shot), `viscosity`,
`landscape`, `startCash`, `interest`, `deathBlast`. `scorchedOptions(s)` merges the sky's
make-up as `tetrustOptions` does.

**Wiring**: the menu button and the `<section class="page" data-page="scorched">` in
`index.html` (the `.tetrust` layout with a `.seyard` well at `aspect-ratio: 2 / 1`), the import,
`case` and `DIVERSION_PAGES` entry in `app.js`, the CSS rules beside the other wells.

**Tests**, mirroring `tetris.test.js` and `breakout.test.js` (headless, seeded):

- landscape: each style generates within bounds, tanks sit on the surface, the same seed gives
  the same field;
- craters and settling: a blast removes exactly the cells inside the circle; dirt above a hole
  falls until it rests; nothing floats after settling; dirt weapons add; diggers bore;
- shells: a shot at 45°/500 lands where the closed form says (no wind); wind shifts it; a
  full-power shot at a coarse frame time does not tunnel a two-cell ridge; each wall mode does
  what it says; the ceiling is open;
- weapons: MIRV splits into five at the apex; Leapfrog explodes three times; the Roller rolls
  downhill and stops in the dip; napalm flows to the low side; the Laser is a line;
- damage and death: blast damage by distance, fall damage, the parachute, shields absorb and
  the deflector bounces, death explodes with an inventory weapon and credits the killer;
- rounds and cash: kill cash, interest, the shop refuses what you cannot afford, packs add
  their count, scores over a game;
- AI: the personality tests in §6;
- `tiles(g)` shape and stable ids; the field refuses hover; the sky canvas is separate;
- the canvas rules (`viewer-canvas-rules.test.js`) extended to the new screen module if it
  draws; `web-contract`, `nav-menu` and `settings` tests pass by construction;
- `npm run counts:fix` after.

**Docs**: a USER-GUIDE section (playing, the roster, the AI, the switches), CHANGELOG, AGENTS.

## 10. Milestones

Each milestone is playable at its end and lands as its own commit set, tests included.

| # | milestone | what is playable |
|---|---|---|
| M0 | this plan, signed off: name, defaults, v1 roster, sky default | — |
| M1 | **the core**: landscape, tanks, Baby Missile → Nuke, craters, settling, falls, damage, death, turns, one human vs two Morons, keys and mouse, plain flash and ring, the panel | a full round |
| M2 | **the roster**: every v1 weapon and item, the walls, wind modes, fuel, the checked price table, the shop between rounds, cash and interest, a game of N rounds, the scoreboard, high scores | the game — *landed 2026-09-16; the price table is as remembered, not yet checked against SCORCH.DOC* |
| M3 | **the AI**: Shooter, Tosser, Poolshark, Chooser, Spoiler, Cyborg, Unknown, AI shopping | a real opponent |
| M4 | **fabulous**: strata, day skies and weather, the tank models, the blast treatments, dirt dust, death fireworks, traces, sound and music, talk | the look |
| M5 | **finish**: the settings tab, Kiosk attract mode (if wanted), docs, the full test set, `counts:fix`, screenshots for the guide and the announcement | ship |

Rough size, from the three games that exist: M1 is the largest single step (about the size of
Blockanoid's first cut); M2 and M4 are each about that again; M3 and M5 are smaller.

## 11. Decisions for the operator

1. **The name.** Scorched Yard, or another.
2. **Field size**: 80 × 40 cells (proposed), or finer (96 × 48) for smoother hills at some
   frame cost on a small machine.
3. **Default sky**: the star field with the galaxy (matches the other games), or a day sky.
4. **Death blast** from the inventory: on by default (faithful) or off (kinder).
5. **All-AI on the Kiosk**: worth having as an attract mode, or not.
6. **v1 roster** as listed in §4, or a shorter first cut (missiles, nukes, MIRV, Funky Bomb,
   Roller, Napalm, Dirt Clod, Riot Bomb, Tracer, Shield, Parachute) to reach M2 sooner.
