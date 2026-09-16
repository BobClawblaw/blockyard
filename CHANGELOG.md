# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]
- **Scorched Yard: the wind's strength changes every turn, its direction once a round.** Holding both for a whole round made the wind something you read once and forgot; holding neither was the flip-flop that started this. The round draws a direction and keeps it, and every turn draws a fresh strength within it
- **Scorched Yard: the air runs at one steady speed.** The wind layer carried a gust — a slow wave that lengthened and quickened every streak together by a third either way. It never reversed (measured frame by frame, no streak ever moves upwind) but a stream that surges and eases while the gauge reads one number does not look like that number. The gust is gone: the streaks advance at exactly the rate the gauge says
- **A board can ask for a harder lamp.** The renderer put every face of every cube between 0.34 and 0.86 of its own colour with the top at 0.8 — a narrow band, which reads as tinted rather than lit. `lightGain` stretches that range about its middle and `topLight` sets where the tops sit; 1 and 0.8 are exactly what every board drew before. Scorched Yard's field uses a hard lamp at the viewer, so the front of the land carries the light and the strata separate
- **Scorched Yard: a restart button.** A war is five rounds, and a player knocked out in round one had nothing to do but watch the computer finish it. **Restart** on the panel, or **F2**, starts a fresh war from round one at any moment, and a knocked-out player is told so
- **Scorched Yard: the wind changes by crossfade, and says which way it blows.** A new wind used to replace the old one between two frames, so every streak jumped. The old air thins away while the new air comes up over it, already at its own speed and in its own direction, over about half a second; the new one leads, so the direction is readable long before the old one is gone. A row of chevrons at the top of the field points downwind, as many as the wind is strong, brightest just after a change
- **Scorched Yard's wind holds for a round.** A new wind mode, **Once a round**, is how the game ships: the wind is drawn when the round starts and keeps its direction and its strength until the round ends, so the air blows one way while you read it and every shot in the round is judged against the same gauge. The original's every-turn wind is still there under Display settings → Scorched Yard → Wind, and it can still turn right around between two shots
- **Fixed: nothing could be bought in Scorched Yard's shop.** Every panel decided whether to redraw by comparing its new markup with `box.innerHTML`, which a browser hands back normalised, so the comparison never matched and the markup was rebuilt on every draw. That was harmless while the board only drew on events and fatal once the wind kept it drawing thirty times a second: a button replaced between the press and the release is never clicked. Each panel remembers what it wrote, and the shop keeps its scroll position when something is bought
- **Scorched Yard's controls, the first step of the rescoped plan.** A held arrow accelerates (one a step, then two, then five, so the whole arc is about a second and a half and the last degree is still one press); Shift is fine and Ctrl coarse, and the keys line says so; **, and .** nudge the power by one for bracketing; the **wheel** over the field changes power, and with Shift the angle; **click the angle or the power** on the panel and type it; **R** fires the last shot again
- **Scorched Yard's explosions are painted, not built out of tiles.** The renderer already knew how to draw a firework — a white core, a shockwave, sparks that curve and trail and twinkle, and smoke built from flat discs that add up to a soft cloud — and a shell landing now draws with the same machinery, through the board's own projection, so the fire is exactly over the crater it made. A tank going up takes its own colour, and the dirt's dust is a low puff. `details3d` gained one seam for it: a board may hand the renderer an `overlay` to paint after the cubes, with the projector and `softStops`
- **Scorched Yard: the aim gauge.** A protractor stands over the tank whose turn it is — ticks every fifteen degrees, the round numbers written in, a needle along the current angle whose length is the power, and the angle and power printed at its tip. It dims for a computer player's turn, so you can see what it is about to do
- **Scorched Yard is lit from the viewer.** The field was lit from straight overhead, which lit the tops of the cubes and left every face you actually look at on one flat shade. The lamp stands low and at the viewer now, so the front of the board carries the light and the strata separate
- **The sun is not white.** The Living sky's sun ran to a near-white disc at noon; it is deep orange on the horizon and warm gold overhead now, which is what a sun looks like to an eye rather than to a camera
- **The Living sky no longer depends on the Star field switch.** With the Living sky chosen and that switch off, every board went black: a control about stars was hiding the whole day. A board that asks for the Living sky now draws it whatever the star switch says, and the star field still comes out at night by itself
- **The deep sky belongs to the star field.** The spiral galaxy, nebulae, dust lanes, halo clusters and distant galaxies are off while the Living sky is drawing, the way the Space effects already are, and their rows in Display settings → Sky are dimmed and say "Star field only" (the Living sky's own rows dim the same way under Space). Nothing is forgotten: choosing Space brings them all back as saved. Scorched Yard's panel hides its star and galaxy switches under the Living sky for the same reason
- **Scorched Yard, the wind is its own flat layer.** It used to be tiles in the 3D field: they bobbed as they crossed, they were drawn over the hills they should have passed behind, and a gust that eased off dragged them backwards (the wind appeared to change direction while you were thinking). The air is now a plain 2D plane between the sky and the land — level streaks whose length is the wind's speed, in three bands of depth, the land in front of them hiding whatever goes behind a hill. It keeps blowing while the board is idle, at its own rate, and only ever blows one way
- **Scorched Yard, the blast is made of blocks.** The fireball, the shockwave, the embers and the smoke were spheres, and the engine gives a sphere a rim and a glint, so an explosion was a heap of bubbles on the dirt. They are blocks now, like the land, the tanks and the shells: a fireball on the field's own grid, hot at the centre and dark at the rim, a ring racing out, embers thrown on ballistic paths, and smoke that rises, spreads, drifts downwind and thins by its alpha rather than shrinking away
- **Scorched Yard, attract mode** (M5): a **watch** switch on the game's panel (and Display settings → Scorched Yard → Attract mode) hands your chair to another computer player — every seat is a computer player, a round rolls into the next without waiting at the shop, and when one of them wins the war a fresh one begins. Nothing is written to the high-score table for a war nobody played
- **The Block space lamp hangs in six places at three heights**: straight above, top left, top right, bottom left, bottom right, or at the viewer, each low, middle or high (Display settings → Block space → Light and Light height). A saved upper-left, upper-right or front comes forward as top left, top right and the viewer
- **Scorched Yard**: the field runs to the frame's edges and its bottom (no sky under or beside the land); the wind is visible — motes of dust drift across the field at its speed and in its direction, a pennant on every turret streams downwind and lifts with the strength, and under the Living sky the clouds drift with the round's wind
- **The Living sky**: a second sky type (Display settings → Sky → Sky: Living sky) for every board that draws a sky — a real day from this machine's clock. The sun rises on the left and sets on the right, the dome passes through night, dawn, day and dusk by the sun's altitude, a twilight glow stands at the sun's side, clouds drift lit from the sun (cumulus in clusters of soft discs, cirrus above them), the moon comes up at tonight's phase with its terminator, and the star field fades in as the sun goes down. A clock setting (real time, a day every 24 minutes, a fixed hour), weather (clear, scattered, overcast, storm with rain and lightning), cloud cover, an optional latitude for real sunrise and season, and switches for crepuscular rays, a rainbow and shooting stars. Drawn under the same canvas rules as everything else (no gradients or blend modes: the dome is one huge soft disc cached until the sun moves half a degree). The Space effects are off while the Living sky is on, their switches kept
- **Scorched Yard, the look** (M4): a shockwave ring and smoke that rises, grows and drifts on the wind after every blast; a tank's death as sparks in its colour and three pieces of hull tumbling; dust where fallen dirt lands; a tank's fall animated, by gravity or slowly under a drawn parachute; tracks under the hull; the tanks talk ("Nuke 'em!", "Ouch!", "Tell my wife…") in a bubble over the field; a march in D minor as the game's music; under the Living sky each round draws its own hour; music, talk and per-round-sky switches; a screenshot in the guide
- **Scorched Yard, the computer players** (M3): the manual's eight personalities — Moron, Shooter (straight shots), Poolshark (bank shots off rubber walls), Tosser (lobs, correcting by halves), Chooser (the best of the three), Spoiler (nearly perfect, from the wind and gravity), Cyborg (a Spoiler with a grudge for whoever hit it, the weakest, the leader), Unknown (drawn each round) — planning with a side-effect-free shot simulator that carries the walls, the dirt and the tanks; they use batteries and shields before firing and shop to their tastes; a setting fields a mix or one kind
- **Scorched Yard, the roster and the shop** (M2): the manual's thirty-three weapons at the manual's prices, packs and blast radii (SCORCH.DOC) with the original's behaviours — the four blasts, Leap Frog's three growing warheads, Funky Bomb, MIRV and the nine-head Death's Head, the tracers, three rollers, the riot charge and blast as wedges cut from the turret, the riot bombs, the dirt shells, liquid dirt that oozes and fills, the dirt charge, the earth disrupter, napalm that flows and burns, the diggers and sandhogs that bore, plasma thrown from the tank, the laser — and eleven accessories (Shield, Force and Heavy shields, Mag Deflector and Super Mag, parachute, battery, auto defense, fuel, contact trigger, heat guidance); the manual's six wall modes with none as the default; several shells in flight at once; cash for damage, kills and survival, interest between rounds, and the shop in the round-end overlay; the items line and cash on the HUD; keys to drive, heal, shield and arm; the computer players shop too; fire and beams on screen
- **Scorched Yard, the first cut** (docs/PLAN-SCORCHED-YARD.md, M1): Scorched Earth on the block engine, under Diversions. A 96×48 field of dirt cubes drawn as runs by stratum, tanks with a turning barrel, a shell that flies under gravity and wind with the original's angle and power, craters, dirt that falls and settles, fall damage, death and its blast, the four wall modes, four missiles, one human against two computer players (the Moron; more opponents and personalities to come), turns, a game of rounds, a HUD with the wind and every tank's health, the mouse to aim, a high-score table, and a settings group for the rules

## [0.1.0] — 2026-09-16

The first minor release, two days after the initial 0.0.9, and everything since it in one place:
the 0.0.10 that was prepared on 2026-09-15 was never published, and its changes ship here. Four
things shaped it. The **first outside review** of 0.0.9 on bitcointalk, which called out a monitor
that bound every interface with no sign-in: 0.1.0 ships hardened — this machine only, sign-in on,
HTTPS with a certificate it makes itself, and no outbound connection at all until the exchange
feed is switched on. A day of **use on a laptop screen**, which found every tab a scroll: every
page now packs to one screen at 1093×945, and the Mining tab follows mempool.space's dashboard
with its **View more** panels. **Appearance**: the layout's colours are a setting — light or
dark, five themes, or nine colours of your own. And the **DOS Diversions**: Wolfenstein 3D, DOOM
and Quake, unmodified shareware on a PC emulated in the browser, written here with no
dependencies, because "can it run DOOM?" deserved a straight answer. 945 tests, from 862.

Upgrading from 0.0.9: [docs/INSTALL.md §11](docs/INSTALL.md#11-updating) — the first start after
the update serves HTTPS, creates the `admin` account and prints its password once.

### Security

- **Hardened defaults** (after the first outside review of 0.0.9): the monitor binds `127.0.0.1`
  and requires sign-in out of the box — the first start creates the `admin` account and prints its
  password once (or takes `BLOCKYARD_ADMIN_PASSWORD`). Reach it from elsewhere over an SSH tunnel,
  or bind a LAN address with `BLOCKYARD_BIND` / `server.hosts`; open read-only access is a choice
  (`BLOCKYARD_AUTH=0`), announced at boot. The boot banner says how to reach a loopback-only
  monitor. Existing installs keep whatever `config/local.json` says.
- **HTTPS by default.** Every listener serves HTTPS; with no certificate named, the first start
  makes the monitor its own self-signed one under `<data>/tls/` — written without dependencies
  (`server/tls/selfsigned.js`: a v3 X.509 certificate assembled in DER and signed with ECDSA P-256
  over SHA-256), naming the bound hosts, this machine's addresses and hostname — and remakes it
  near expiry or when a bound address is missing from it. `blockyard tls` remakes it by hand
  (`--san` to add names, `--print` to export it). Your own certificate still replaces it;
  `BLOCKYARD_TLS=0` serves plain HTTP behind a proxy. The installer's summary and port probe know
  both schemes.
- **The installer asks twice before a non-loopback bind.** A LAN or wildcard address is written
  only when the operator types it and confirms it; the default it offers is `127.0.0.1`.
- **Market polling is off by default** — a new checkbox, **Display settings → Markets & Price →
  Enable market polling**, shared by every screen. A fresh install makes no outbound connection
  but to the node: the Markets and Kiosk tabs say that polling is off and where the switch is,
  Overview's price line stays hidden and the explorer shows no dollar figures. Ticking it takes
  effect at once; unticking parks the feed at once. `BLOCKYARD_MARKETS=0` still removes the feed
  so that the checkbox cannot turn it on. Existing installs tick the box once.

### Appearance

- **A first tab in Display settings for the colours of the layout.** A theme mode — Light, Dark,
  or System, which follows the operating system and changes with it — and theme cards with swatch
  strips of the face the mode picks: **BlockYard** (the shipped look, the default; its dark face
  is value for value what the monitor drew before), **Mono** (clean grayscale), **Nous** (GitHub's
  chrome with a Nous blue accent), **GitHub** (Light Default and Dark Default) and **Catppuccin**
  (Latte and Mocha). **Custom** is nine colour pickers — page, panels, text, muted text, accent,
  lines, good, warning, bad — with the rest of a face derived from them (a raised panel, the
  softer rules, the fainter text, the darker accent of a pressed button), and whether Custom is
  light or dark read off its page colour; **customise <theme>** copies the theme on screen into
  the pickers so a custom scheme starts from a look. Saved on the server with the other settings,
  so every screen of the monitor draws the same; the sign-in page draws in the theme the browser
  last saw.
- The theme is applied through the CSSOM (the page's custom properties rewritten on `<html>`),
  which the content-security policy permits where a style attribute is refused. The charts' axis
  text, grid lines and tooltips, the order-book depth chart's two sides and the market charts'
  grounds follow the theme — they were literals of the dark look, and a light theme would have
  drawn grey-on-grey. The 3D boards stay space, and the Explorer's block and transaction pages
  keep their own dark cards.

### Mining

- **The Mining tab has the network row**: reward stats over the last 144 blocks, the difficulty
  period (blocks remaining, the estimated and the previous change, the next halving), a week of
  pools with luck and counts, a year of hashrate with the difficulty's steps, and the last twelve
  adjustments as a table — every figure from this node alone (`server/collect/network.js`:
  `getblockstats` for the reward window, block headers for the periods and a daily sample, the
  week's coinbases read in the background at the lowest RPC priority).
- **mempool.space's layout**: two columns in its order (reward stats, difficulty adjustment;
  pools, hashrate; recent blocks, adjustments) under the block flow, our own panels beneath, and
  **View more »** on four cards opening that card full screen — the whole week of pools as a
  table, the year's chart large, the whole attributed window of blocks, a year of adjustments.
- **The pool chart is a labelled pie**: every pool named beside its slice and joined to it by a
  leader in the slice's colour, the small ones stacked, slices under half a percent gathered as
  "Other" — and the "Other" threshold rises until every label fits the card, so no name runs off
  the bottom at any window height. The pie and the year chart size themselves to the window.
- **Dollar figures** on the reward stats while market polling is on, from a new `/api/price` that
  answers the cached spot price and never starts the exchange polling itself.
- The Mempool space viewer left this page — it is on Overview, Block space and Mempool — and with
  it the full-pool poll the page used to ask for. The reward window is exactly 144 blocks.
- At a narrow window the block flow spans the width and is thinner, and the packages table scrolls
  inside its card instead of bleeding into the neighbour; the three stacks become two below 1400px.
- **A streak of stale drops of the full-pool poll is one story**: one warning event when it
  starts, a counter on Node & RPC while it lasts, one event when the poll answers again with the
  count and the span. On a day the node answered slowly for thirteen hours, each drop had been its
  own event, 188 of the feed's 200 rows.

### Every tab on one screen

Measured at 1093×945 and 1600×1000 with a dead-height probe, page by page:

- **Globally**: tighter card padding and heading spacing, and a short card beside a tall one keeps
  its own height instead of being stretched to match (Chain & Sync's drill-down card had a
  thousand pixels of nothing under its input; Node & RPC's poll cadence and connection cards
  hundreds).
- **Overview**: the block flow card a quarter shorter, and the Block space board capped to the
  viewport (it set the whole right column's height), so the events are on the first screen.
- **Block space**: the card tighter and the board sized so the whole page, note included, fits the
  viewport without a scroll.
- **Markets**: the board takes what the window leaves, and the exchange table and the order-book
  depth sit side by side beneath it (under 1400px the table drops the pair, 24 h range and volume
  columns; all still in the summary line and on the Kiosk) instead of the depth chart starting a
  thousand pixels down.
- **Kiosk**: tighter heads and gaps, the price panel's padding trimmed, the Block flow strip a
  quarter shorter, and the full-screen button in that strip's head instead of floating over its
  cards.
- **Mempool**: keeps its two columns down to 900px (it stacked from 1100), and the room over goes
  to its time-series charts, a fifth taller.
- **Explorer**: a smaller title, the block strip's padding and scrollbar band trimmed, tighter
  table rows and the table reaching the window's bottom edge — three more blocks on the first
  screen.
- **Peers**: a long onion or i2p address no longer makes the whole page scroll sideways (it clips
  with an ellipsis and carries the full text as its title; a wide table scrolls inside its card),
  rows and service badges tighter, the top strip's cards at their own heights.
- **Network**: Throughput beside a stack of Upload and Traffic accounting, the throughput chart
  taller, and the sources table taking the rest of the window.
- **Events**: the feed reaches the window's bottom edge (it stopped a hundred pixels short).
- **Chain & Sync**: one-line notes under the block-size and tip charts (the longer sentences are
  their tooltips), the transaction-rate figures as one wrapping line, values that keep to their
  line, and a shorter uptime label — the first three rows sit level and the drill-down and indexes
  reach the first screen.
- **Node & RPC**: two stacks (RPC etiquette with its figures in two columns, Data quality and Node
  connection; Poll cadence, self-telemetry beside the log tail, Panel sources and the RPC
  console) instead of grid rows that left holes beside the short cards.
- **Admin**: two stacks (Users over the audit log; Node actions over Change own password, whose
  two fields share a row). **Sign-in** and **404**: the same tighter card.
- **Display settings**: the tabs in three labelled rows — Boards (Appearance, Block space, Sky,
  Markets & Price), Effects, and the Diversions last; rows, note and groups tighter, the sheet a little wider so hints wrap
  less, and on the two effects tabs the switches run two across with each hint as the row's
  tooltip — the Space effects tab is under half the scrolling it was. The price line on Overview
  switch sits directly under the polling switch it depends on.
- **About**: the sky runs to the bottom edge with the credit line at its foot, and the GitHub
  link and the tip pill share a row.
- **The Diversions pages take the window**: the wells of Tetrust, Blockout and Blockanoid grow to
  the window's height (they stopped at 600px), and the DOS screen is always 4:3 and as large as
  the window allows — at a 1093px window the 320×200 picture had been drawn squashed into a
  761×720 box.

### DOS Diversions

- **DOOM.** The shareware `DOOM.EXE` v1.9 and `DOOM1.WAD` from `games/doom_dos/`, unmodified,
  running on a PC emulated in the browser with no dependencies: an i386 interpreter
  (`public/js/x86.js`), the DOS/4GW machine around it — DOS, DPMI, BIOS, PIC, timer, keyboard and
  a planar VGA (`dospc.js`) — and a Sound Blaster Pro 2 with an OPL3 for the effects and the music
  (`soundcard.js`), in a worker. Demos, menus, savegames and ENDOOM all work; 35 frames a second.
  Mouse capture, WASD keys by default (the switch rebinds the running game at once), smoothing,
  full screen; pauses when you look away; savegames and DOOM's config stay in the browser.
- **Wolfenstein 3D.** The shareware `WOLF3D.EXE` v1.4 and its `.WL1` files from
  `games/wolf3d_dos/`, unmodified, on the same emulated PC — which now also runs a 16-bit real-mode
  DOS program: real mode in the CPU (segments times sixteen, a wrapping SP, 16-bit string
  instructions and interrupt frames), a plain MZ loader with its relocations, DOS's memory
  allocator, the interrupt vector table, and VGA write mode 1. Menus, demos, AdLib music,
  digitised sound effects, savegames and high scores kept in the browser, at its full 70 frames a
  second. It sits before DOOM and Quake in the Diversions menu.
- **Quake.** The shareware `QUAKE.EXE` v1.06 and `PAK0.PAK` from `games/quake_dos/`, unmodified,
  on the same emulated PC — which now also plays the go32 stub and CWSDPMI for a DJGPP program:
  segment bases and 16-bit code in the CPU, a COFF loader, a directory tree, DOS's system file
  table, the BIOS tick count. Demos, menus, savegames, sound effects through the Sound Blaster,
  and the order screen on quit. W A S D and mouse look on the first start, Quake's own bindings
  after. Quake starts with a smaller view (`viewsize 80`); **−** and **=** change it and Quake
  keeps the choice.
- **The emulated PC is fast.** Each instruction is decoded once and cached rather than decoded
  every time it runs (writes into cached code clear what they overlap, because both games patch
  their own drawing code), the arithmetic and the x87 forms Quake runs most have handlers of their
  own, and memory addresses are formed inline: Quake from 77 to about 141 million instructions a
  second, its `timedemo demo1` from 29.7 fps to over 50; in the browser Quake plays at 40–50
  frames a second.
- **A way out of full screen**: an **exit full screen** button in the top corner while full
  screen, and holding **Esc** for a second (a tap of Esc stays the game's menu, which is what the
  keyboard lock is for); leaving unlocks the keyboard and releases the mouse.
- The game files are served at `/games/<game>/<path>` (`server/http/games.js`); the shareware
  packages live under `games/` (DOOM's moved from `doom_dos/` at the repository root).

### Markets and the effects

- **Black hole**, a Markets effect (modelled on NASA's visualisation, svs.gsfc.nasa.gov/14576): a
  point of darkness opens and grows to a horizon over 26 s, the price line bends round it as
  through a lens (the Einstein-radius push), the candles it reaches stretch and lean toward it and
  shrink away into it, and an accretion disk seen nearly edge-on — a thin band white-yellow at its
  inner edge through orange to a dark red rim, five hundred fibres spiralling inward sheared by
  the Keplerian flow, its far side lensed into an arch over the shadow and a smaller one beneath,
  a photon ring hugging the horizon, starlight bent into arcs. **It crosses the board**: it opens
  a fifth of the way in on one side and runs a straight line through the chart to a fifth from the
  other, from one height to another, so the line is seen bending round it as it passes; the
  candles' orbits ride along at a quarter of the first cut's speed. It finishes its crossing before
  it lets go, and lets go evenly, every candle gliding home and growing back smoothly. It hovered
  over Block space for a day and its cubes never came home cleanly enough, so it is a Markets
  effect only.
- **Supernova** (the solar flare, renamed and remade on NASA Goddard's animation,
  svs.gsfc.nasa.gov/20413): the star is a glint — halo, hot core, diffraction spikes — growing and
  blue-shifting as it goes; the opening explosion is a **white-hot flash**, held and washing far
  out, that throws **a hundred and twenty-eight plumes of white gas** in every direction, each
  flying and growing on its own out to nine star radii and drifting on until the effect is nearly
  done (drawn on a half-resolution layer to keep the frame cheap); the debris is a volume of gas in
  three layers — a blue cloud out in front, a white one behind it into which **violet grows patch
  by patch from a tenth of the run**, and a deep violet heart — with a soft shock band throwing
  and shaking the candles it crosses; and as the cloud dims a **pulsar** beats seven times a
  second at the centre, two thin beams sweeping round, inside a nebula of the same gas that holds
  its violet weight until four fifths of the run. 16 s (24 on Markets).
- **Fireworks are a display**, on both boards: every shell drawn — the rocket's arc, a white flash
  and a shockwave ring at the burst, seven shell kinds by turn (peony, chrysanthemum, willow, ring,
  crossette, strobe and more), sixty to ninety sparks each a curved trail, a lens flare at every
  burst, glitter rain, and a nebula of smoke that drifts up and lingers; up to ten shells on
  Markets over 14 s (five on Block space), each lighting the candles under it in its own colour.
  **Off by default** on both boards, kept for special occasions.
- **X-ray**, on both boards: a front sweeps the board and everything behind it goes x-ray — bodies
  dimmed to glass, every edge lit, a raster of thin lines across each face — then develops back.
- **Breathe** and **Light saber**, on the price line: three slow swells from the plain wire to
  white heat and back; and the line igniting from its left end, blue, green, red or purple by the
  run, humming with a breathing glow, spitting sparks, retracting to the hilt.
- **The energy pulse is heat, not blue, and its head is a crackling ball of plasma**; **the scan
  line is a light curtain** standing on the board floor to the chart's top; **ball lightning is a
  light source**, its arcs discharges built by midpoint displacement rather than zigzags, a quarter
  of its size and a third of its speed on Markets; the scanner's cone is dimmer on both boards.
- **The Markets board keeps its price fit across refreshes**: the last fit is kept while the data
  still sits inside it and fills at least two-thirds of it, so a refresh no longer re-scales the
  whole chart unanimated. Whatever a head pulls is painted last, nearest the head on top; a held
  pool refresh waits a moment and a half after an idle effect ends, with the board whole and still.
- **Layered soft fills add up correctly** (`softStops`): each nested disc carries only its
  increment, so a stop's cumulative opacity is exactly the stop's; measured on the Kiosk, the
  supernova's peak opacity fell from about 0.9 to about 0.45 and the chart shows through it.
- **The no-repeat window holds from the first pick** on both boards: every effect plays once
  before any repeats (a negative slice index had let one come round at the tenth pick). The
  searchlight and the tractor beam, which fly the same saucer, share the window.
- **A Kiosk test suite** (`test/kiosk.test.js`): every Markets and Block space effect plays through
  the frame loop on a Kiosk-sized panel; the supernova, the black hole and the fireworks are
  bounded by the board's width so no panel is covered.

### Fixed

- **The donation QR shows on Safari.** It was an inline SVG of 800 module rects, and Safari on
  the first Mac install painted its white ground and none of the rects. It is a PNG now, painted
  the same everywhere.
- **A dead index worker fails the build instead of hanging it.** A worker killed outright (out of
  memory, with four beside the node) left its job unanswered and the build sat at "scan 5,720 of
  5,721, about 1 s left" for an hour and a half on the first Mac install. The run now rejects the
  moment a worker exits or throws, naming the job and the fix (fewer `addressIndexWorkers`); the
  progress flag says *no progress for N min* when nothing has moved.
- The 0.0.9 release notes' test count corrected (862, not 864).

### Documentation

- INSTALL, GETTING-STARTED, SECURITY, CONFIGURATION, API, TROUBLESHOOTING and the README describe
  the hardened defaults, HTTPS and the polling switch; INSTALL §11 has the notes for updating a
  0.0.9 install; the USER-GUIDE has the Appearance section, the Mining row and the packed layouts;
  TROUBLESHOOTING explains a streak of stale pool-poll drops. Screenshots re-shot at 0.1.0, with a
  Mining shot added. The announcement for the bitcointalk thread is in `docs/announcement/0.1.0/`.

## [0.0.9] — 2026-09-14

The initial release. Everything in it, like everything before it, was written by an AI directed by a human
operator, and audited by AI (`docs/SECURITY-AUDIT.md`, `docs/SECURITY-AUDIT-2026-09-14.md`). It is
experimental pre-release software. BlockYard runs **on the machine that runs Bitcoin Core** (25.0 or
later), because the explorer's address index is built from the node's own block files; a node on
another machine, and the experimental node that earlier measurements were taken on, are not supported.
864 unit tests, no dependencies. Tagged `v0.0.9`. **The address index takes a few hours to build** on first start (about two on four workers on NVMe); every other page works meanwhile.

### The 3D boards' effects, per board

- **Each 3D board has its own effects list.** The one Effects tab is now two: **Space effects**
  (the Block space board's 28 switches — every effect but the two drawn on a price line) and
  **Market effects** (the Markets board's 12: ripple, outline sweep, tide, cascade, twinkle,
  scan line, fireworks, solar flare, wave, energy pulse, pipe bulge, ball lightning — the ones
  that translate to a candle chart; ball lightning is half its Block space size there). Each has its own no-repeat window and its own
  all on / all off, which the no-repeat slider had silently taken away. A saved settings store is
  migrated (schema 4): the Markets list starts as a copy of the list there was.
- **Each effects tab sets its board's cadence.** *Between effects, at least* / *at most*
  (seconds, 5–9 by default, up to ten minutes on Space effects and five on Market effects) on both tabs, and *First effect after landing*
  (1.2 s by default, up to two minutes) on Space effects only — the candle board has no landing
  — drive the scheduler's own timers, per board.
  The no-repeat slider on each tab tops out at that list's length.
- **Nothing on the Markets board waits its turn.** The pulse, the bulge and ball lightning were
  held to a clock of 2.5-6 minutes between plays; they are ordinary picks now, and the list you
  leave on decides how often any one of them comes round.
- **Everything on the Markets board moves along the hours** — left or right, never toward the
  viewer — and lights the candles or the line: fronts (outline, scan, tide, wave) run along the
  chart, rings (ripple, shockwave, nova) start on the candle row, the light cycles ride in from
  the two ends with their walls on the candle tops, the lightning ball rides the price line, and
  ball lightning flies through the chart's own height. Candle faces light under an effect now
  (the camera is low, and a glow painted on a candle's top alone was invisible).
- **Ball lightning strikes candles.** `cellTops` began each tile at its own fractional x and y,
  which on the candle board (tiles between grid lines) stored nothing, so every cell top was
  zero and no arc found a target. Half the arcs now chain on from the struck block to
  another in electric green, the instant they land, and half of those on to a third block.
- The lightning ball is one pale gradient with a white-hot heart, and a pale burn behind it,
  instead of five stacked discs of deepening blue that read as a dark blot.

### The explorer's address history, from an index of our own

- **Address pages show full history and balances on Bitcoin Core.** This was the explorer's one
  real gap, and it was not a bug: Core has **no address index at any setting**. `getaddressbalance`
  and `getaddresstxids` are insight-style extensions carried by forks, and stock Core answers
  `Method not found` (measured 2026-09-13 against two Core nodes). mempool.space
  shows the same address's history only because `electrs` builds that index from the block files
  itself. So this monitor now does the same, in a form it can afford: `server/chain/`.
- **Reading the node's own files, not asking the node.** `blk*.dat` on a current Core is
  XOR-obfuscated at rest (`-blocksxor`, default since v28, the key in `blocks/xor.dat`) -- the
  first spike concluded "not a Core datadir" and was wrong. De-obfuscated, `server/chain/blockfile.js`
  frames the records; `server/chain/tx.js` decodes transactions and blocks, checked
  **field-for-field** against `getblock <hash> 3` (91,813 spent coins in 16 sampled file pairs, 0
  mismatches); and the undo (`rev*.dat`) records supply each spent coin's script and amount,
  which is how the spending side is known without replaying the UTXO set. Pairing blocks with
  undo records by trying every candidate was quadratic on the tiny early blocks (file 0: 35 minutes
  and not finished); Core appends undo in connection order, so blocks are put in chain order by
  their previous-block links and walked in step -- file 0 pairs in 5.9 s.
- **A lean row.** One 21-byte row per (script, transaction that touched it): 8 bytes of
  sha256(script), the height, the position in the block, and the **net satoshis** the transaction
  moved for that script -- so a balance is a sum, with no node call. A script paid and spent in the
  same transaction is one row (18% fewer). The full decoder builds Core's verbose shape and was 5.9
  of the 9.5 single-core hours measured for the chain; the index needs only each output's value and
  script bytes, so `server/chain/index/rows.js` walks the raw transaction itself and is checked
  row-for-row against rows from the full decoder.
- **Flat sorted files, no database.** Measured against `node:sqlite` on three real file pairs
  (`docs/MEASUREMENTS.md` §29): 21 bytes per row against 24-27, a 5.5 M rows/s sort against a
  1.4 M rows/s key-ordered load, and no B-tree collapse once the keys outgrow memory. 256 sorted
  segments by key prefix with a sparse index (one key per 4,096 rows) held in memory; a lookup
  binary-searches the sparse keys and reads the one 86 KB block that can hold its key.
- **Built and measured** (§30): `node scripts/index-build.js --out <dir> --workers 16` read all
  5,756 file pairs in **29 min 45 s** (7.8 CPU-hours across 16 workers) and wrote
  **5,890,519,289 rows, 123.7 GB** -- every height present exactly once, two stale blocks skipped,
  and within 1.5% of the projection. **40 of 40 balances equal `scantxoutset`** at the same
  height, to the satoshi; every (script, transaction) pair of four whole blocks from 2009 to the
  tip found at its height and position with its amount. Lookups: **0.25 ms** median first touch,
  0.03 ms warm; a 2.3 M-transaction address's whole history summed for its balance in 83 ms.
  For scale: `scantxoutset`, the only thing Core offers, took 26.5 s for one scan of 40 addresses
  holding the node's RPC thread, and answers only the current balance, never a history.
- **It follows the chain.** `server/chain/index/live.js`, started by the server for each configured
  index directory, polls every 30 s, fetches each new block with `getblock <hash> 3` over RPC (so
  the files are read once, at the build), and **logs the rows before serving them** in a
  CRC-framed `live.log` that is replayed on restart and drops a record torn by a crash. A
  reorganisation rolls the tail back to the fork; blocks 100 deep are **folded** into immutable
  sorted layers and layers past 32 are merged; a reorganisation below what is folded stops the
  follower and the page says to rebuild. Checked live: 12 blocks caught up in 6.5 s, 40 of 40
  balances then equal to `scantxoutset`, and on release day the index reached a new block 16 s
  after the node did. The rows it derives through RPC agree row-for-row with the rows built from
  the files (`test/chain-index-live.test.js`).
- **The address page reads it.** `addressIndex` in a node's config names the directory (one index
  serves every node on the same chain); the page shows the transaction count, balance, total
  received and sent, and the transactions newest first with the **net change each made**, 25 a
  page, deep pages costing no more than the first. The reply carries `index.tip`, `index.behind`,
  `index.following` and `index.stale`, and the page says when the index is behind the node or has
  stopped following. Checked live: every row of four pages, including page 4 of a 2.3
  M-transaction address, matched the node's decoded transaction for txid, height and amount.
- **Without an index, the page is honest rather than empty.** A node's refusal used to become `[]`,
  then `txCount: 0`, then "no transactions in this node's address index" -- a fabricated zero
  indistinguishable from an unused address. The reply now carries `indexed: false` with a **null**
  count, the page says the index is absent, and the dead RPCs are not re-sent on every view: a
  "method not found" is remembered per node for ten minutes, then asked again, because the daemon
  behind a node id can change.
- **A rebuild in place is safe.** `buildIndex` empties its output directory first, so a follower's
  `live.log` and layers -- holding the reorganised-away blocks -- cannot survive into a new index and
  a fresh follower catches up on the chain as it is (`test/chain-index-live.test.js`). Stop the
  server, run the same command, start it; the advice to build into a fresh directory is withdrawn.
- **A missing address index is built by BlockYard itself, in the background** (operator: "Is it
  possible to run step 6 in the background, and have a status notification in blockyard when the
  index process is finished?"). On start, an `addressIndex` directory with no index in it is built
  on worker threads while every page keeps serving; the progress is a quality flag on the Overview
  and a line on the address page (phase, files done, rows so far, time left); an event marks the
  start, the finish and a failure, and the browser toasts it; when it finishes the follower starts
  and address pages work with no restart. `addressIndexBuild: "manual"` keeps it from happening.
  The installer's step 6 offers background (the default), here, or later.
- **The build shares the machine with the node, and behaves like it.** Every build -- the server's
  background one, the installer's build-here and `scripts/index-build.js` -- goes through one pacer
  (`rpcPacer`) that reads the monitor's own RPC telemetry: before each file it holds, ten seconds at
  a time, while the node's RPC is failing, its breaker is open or its answers average more than
  `rpc.slowLatencyMs` (5 s), and eases to one file at a time with a pause between above 40% of that.
  It first held at one second, which ran a healthy build on a node whose heavy reads take a second
  at a sixth of its speed; the threshold is the monitor's own notion of slow now. The height batches
  are paced the same way, 1,000 at a time at the lowest priority. The server's build opens its own
  RPC connection, as `scripts/index-build.js` always did, so it and the monitor stop starving each
  other: on the first Mac its `getblockhash` batches queued behind multi-second mempool and block
  reads on the monitor's one lane, and both sides starved ("heights 1,000 of 967,015" for a quarter
  of an hour). Workers: `addressIndexWorkers` in the node's config, written by the installer; unset,
  the server takes half of what a dedicated build would and at most four. The `rpc-slow` and
  `rpc-timeouts` quality flags name the build when one is running and no longer assert a cause from
  another node's era. **An interrupted build starts over**: there is no resume after Ctrl-C, and the
  installer says so when it happens.
- **An address's unspent outputs are listed** (operator, the same day: "Why don't we do this"): the
  index names every transaction that touched the address, each one's outputs paying it are asked of
  `gettxout` (the UTXO set, less what the mempool already spends), and the page lists them with the
  index's own height and their count on the card. The walk is the whole history, so it is made for
  an address with at most 100 transactions and declined in words for a longer one.
- **Not yet:** an address's transactions still in the mempool.
- **An unconfirmed transaction shows its inputs and fee** (operator: "Unknown script?!", of a
  mempool transaction whose 858 inputs all read *unknown script*). Core carries no `prevout` on a
  mempool transaction's inputs, so `fillPrevouts` fetches the parents in one batch and fills each
  input's script and amount; checked on that transaction, 858 of 858 inputs, and a fee of 77,958
  sat equal to `getmempoolentry`.

### The installer: `npm run setup`, `npm run check`, and the `blockyard` command

- **An installer: `npm run setup`** (operator: "build a test into the installer so we can verify it
  properly connects to an RPC server and finds the bitcoin logs ... something that writes out a
  config/local.json at the end ... that we can up and run immediately to start building the
  transaction set"). It asks for the RPC URL and data directory, finds the cookie (or asks for
  `rpcUser`/`rpcPassword`), and proves the answers before writing anything: the RPC server answers
  and on which chain, the node's version is 25.0 or later, `txindex` is on and synced,
  `getblock <tip> 3` carries prevouts, the node is not pruned, `blocks/` holds matched block and
  undo files and the first one opens to the genesis block through the XOR key, `debug.log` is where
  it should be, and a configured index directory is readable, writable and not far behind. Then it
  writes `config/local.json` (mode 0600, a backup of any previous one) and offers to build the
  address index on the spot. `npm run check` runs the same checks against every configured node
  and exits non-zero on a FAIL; `--yes` with flags is the scripted form. `docs/GETTING-STARTED.md`
  walks a macOS or Linux command prompt through it. Six numbered steps, every answer validated and
  explained before it is accepted (a URL that is not one, a port off the range, a directory that
  is not there, a hostname where the config wants an address), a warning when something already
  listens on the port, a progress bar with the rows so far and the time left for each phase of the
  build (the same bar in `scripts/index-build.js`), Ctrl-C that leaves everything as it was, and a
  last question that starts the monitor in the same terminal.
  It reads the node's own `bitcoin.conf` first (operator: "can't you look through the user's
  .conf and find the rpc values?"): chain, `rpcport`, `rpcconnect`, `rpcuser`/`rpcpassword`,
  `rpcauth` users, a cookie file named elsewhere, `server=`, `txindex=`, `prune=`, sections and
  `includeconf=`, so the RPC URL and the credentials arrive as defaults rather than questions.
- **Every check is timed**, because how fast the node answers is half of what an install needs to
  know, and the verbose mempool read -- the monitor's heaviest regular call, every 20 s -- is one of
  the checks, with a warning when it is slow enough to lag the board. An unbuilt index is reported
  as information, not a fault.
- **Defaults**: the index in the checkout's `data/index`, like everything else the install writes;
  at most **four** build workers (the shared-machine number; one on spinning disks, each needing
  ~2.5 GB of memory); the build in the background once BlockYard starts.
- **The banner** (operator: "I want the installer to have amazing ANSI Art here for the BY logo",
  then "It needs to fit in 80 character space. Standard CRT"): the BY monogram -- the same tile the
  favicon is -- in 26x12 solid cells, one cell per pixel painted as a background colour so it fills
  the cell in every font, the About text beside it, and the whole run inside 80 columns (piped at
  80: widest line 79). Every line wraps to the terminal with its indent kept, a box cuts a line past
  its room with an ellipsis, widths are measured on what is seen rather than on colour codes, and
  colour steps aside without a TTY or under `NO_COLOR` (`FORCE_COLOR` turns it on).
- **An npm package and a `blockyard` command** (operator: "push to npm"). `package.json` loses
  `private` and gains `bin` and `files` (bin, server, public, scripts, the pool map, systemd, the
  docs, the licence and notice; no tests, no images: 924 kB packed). `blockyard setup | start |
  check | index-build | users` keeps the config and data under `~/.blockyard` (`BLOCKYARD_HOME`),
  since a global install's own directory is nowhere to keep a config or 124 GB of index; a checkout
  run with `npm run …` is unchanged.

### Fixes from the first fresh install (a Mac, Core 29.1)

- **A node without `coinstatsindex` was sent a full UTXO-set walk every minute.** Found on the
  first Mac install: `getindexinfo` said there was no coinstats index, and the rule read that as
  "not assumed unindexed" and asked `gettxoutsetinfo` anyway, on the slow tier, every 60 s -- a
  walk of 165 M outputs that Core kept computing after the 90 s timeout, holding its chain lock,
  so every other call answered in 18 s, the mempool read was dropped and the block-space board
  stayed empty. Everything was blamed on the index build, which had nothing to do with it. The
  UTXO figures are now asked only of a node that has said it keeps the index; the indexes are
  asked first, alone, before anything expensive.
- **A fresh install attributed no blocks** and showed raw coinbase tags: the curated pool map
  lived only in `data/`, written by a script nobody had run. The map (mempool.space's
  mining-pools list, MIT, 151 pools) ships in `config/` and is used until `scripts/pool-map.js`
  writes a newer one into `data/`.
- **Nothing holds hundreds of files open any more.** The index store kept one descriptor per
  segment and layer -- 256 and more -- for the life of the process, and the build kept all 256
  bucket files open through the scan; a stock macOS allows a process 256 (`ulimit -n`) before it
  has opened a socket. A lookup opens the one file it reads and closes it (measured on the full
  index afterwards: 0.02 ms median warm, 21 descriptors held by the whole process), and the build
  keeps at most 64 bucket files open, least recently written closed first. Found while preparing
  the first macOS install.
- **The installer wrote 16 workers when Enter was pressed.** The suggestion was the machine's core
  count; it is the shared-machine number now, at most four. And it asked for what the node's own
  `bitcoin.conf` already answered -- read first now, above.
- **The banner's half-block art seamed on the Mac's Terminal** (operator: "What is this garbage?!"):
  a font decides where a half-block glyph sits in its cell. One character cell per pixel, painted as
  a background colour, which every font fills.
- **Lines wider than 80 columns.** The summary box's one long line broke its frame on an 80-column
  terminal; every line the installer says now wraps to the terminal width.
- **Block cards clipped and wrapped numbers on a wider font**: a value could wrap mid-number ("604"
  drawn as "60" over "4"), and the stats columns clipped. Values keep their line, the columns size
  to their content, and the card is ten pixels wider.
- **Windows.** The run-as-main check compared a file URL (`/C:/x`) with a realpath (`C:\x`) as
  strings, so no script's `main()` ran; they are compared as paths (`fileURLToPath`). LF on every
  checkout (`.gitattributes`): several tests match line-anchored patterns in source files, and a
  CRLF checkout turned every one into a miss. The temp directory is the platform's, not `/tmp`;
  defaults and paths are spelled per platform; a file-mode assertion knows Windows has none; the
  scanner is keyed with `/`. **CI runs on Ubuntu, macOS and Windows**, Node 22 and 24, and the suite
  passed on all six at `2010b24`.

### Sync: a long gap is not a stall

- **Stalled only when the peers know a higher tip.** Two independent nodes at the same height, no
  block for 42 minutes, and the header said STALLED in red. The network finds no block for 40
  minutes about once in fifty. The state is stalled only when a connected peer reports a tip above
  this node's (`getpeerinfo` `synced_headers`, `startingheight` as the fallback); when the peers
  agree on the tip the node is synced and the caveat names the gap as the network's; with no peer
  height to check, the word waits for two hours. The caveats say which of the three it is.
- The sync detail's three log-derived rows exist only where the figure does; Bitcoin Core prints
  none of them.

### Block space and Markets

- **Agent effects.** The board's idle repertoire is **30 effects**, each with a switch: to the
  fields (ripples, plasma, code rain, fireworks and the rest) the operator asked for things that
  *happen* -- "think more TRON light cycles" -- and fifty video-game-inspired effects were designed
  (`docs/EFFECTS-AGENTS.md`), built, watched, and cut to the ones that earned their place. The
  agents that stayed: **light cycles**, the **lightning ball**, a **centipede** that weaves down the
  board and splits, a **UFO** whose tractor beam lifts the tallest transaction and drops it back
  under gravity, **Missile Command** arcs against rising interceptors, **Boulder Dash** where the
  board gives way from a point, and **ball lightning** drifting across the whole view, its arcs
  electrifying the blocks they strike (it replaced a portal pair). Every agent is checked on a
  flat uniform board too, so none can be blinded by a skyline it happens not to read.
- **No repeats within N** (default 12): an effect is never played again until that many others
  have played; where fewer are switched on, the one that has waited longest plays next.
- **The Markets price line is one continuous pipe** rather than forty segments, with a rarer
  **energy pulse** and a new **pipe bulge**, each of them rare -- 2.5-6 minutes between plays: a ball forced through the tube,
  swelling the wall with an arced, stretched skin, the bright core magnified through it as through
  a fish-eye lens; it enters at the line's first point at exactly the tube's size, is as large as
  fits for as long as possible, leaves at the last, and runs quicker downhill than up.
- **A chrome finish** (Display settings → Metallic finish): every face mirrors a horizon that
  slides as the blocks move; satin is the softer highlight that was there before.
- **Depth**: a touch of perspective, off by default, so a cube's top grows a little wider than its
  base and a flying block swells as it rises. Capped at 0.001 after larger values put flyers
  through resting cubes.
- **Departures and arrivals**: how blocks leave and rejoin the board on a refresh, chosen by
  measurement (flights clear their neighbours before fanning, leave the frame rather than popping
  at its edge, and take a lane per leg); a recoloured cube blends to its new colour instead of
  popping; and where a flyer is clearly above a resting cube it paints over it.
- **The block-flow cards are linked as a chain that reads as one** (operator: "looks bad on a black
  background. Re-do it to be much more stylized and visible"): two pale outlined pills that vanished
  on the dark panel are two interlocked links now, accent-coloured tubes with a highlight and a
  glow, the left link's top strand painted again over the right so the pair weaves.

### Security

- **The second AI security audit's findings, the same day** (`docs/SECURITY-AUDIT-2026-09-14.md`,
  which re-verified the 09-13 fixes live and covered the address index and explorer). Its one
  medium: `/api/x/address` sized an allocation by the request's page number, 525 MB for
  `page=999999` on a two-row address -- a deep page now counts the history first and keeps at most
  what exists. The rest: rows above the node's tip (a reorganised tail the follower has not yet
  rolled back) are left out of the count, balance and page and reported as `index.postTip` with a
  caveat on the page; a pool key is escaped like everything around it; a transaction summary with
  more than 2,000 inputs and outputs is never cached; a test fixture no longer lives at a fixed
  name in `/tmp`; `audit.jsonl` and `history.json` are created owner-only.
- **The first AI security audit** (`docs/SECURITY-AUDIT.md`, 2026-09-13) found one HIGH and four
  more, all fixed the same day; they are the next four items.
- **The node-connection probe leaked the node's RPC credential** (HIGH, found by audit and
  reproduced with a working exploit). `POST /api/config/node/test` built its throwaway client from
  the live node's config, so `resolveCookie` read the real `.cookie` and sent it as an
  `Authorization` header **to whatever URL the request named** -- on a request needing no session
  and no CSRF token, reachable by a plain cross-site form. Credentials now go only to the endpoint
  the monitor is already configured for; anywhere else is probed unauthenticated and says so. Open
  mode additionally refuses any state-changing request whose `Origin` is not this server or whose
  `Sec-Fetch-Site` says cross-site.
- **Session TTLs were inverted**: an 8-hour absolute lifetime with a 72-hour idle ceiling meant the
  idle check could never fire. Now 72 h absolute, 8 h idle, with a test on the invariant.
- **`randomPassword()` drew with modulo bias**, over-representing the first 58 characters of its
  66-character alphabet. It uses `crypto.randomInt` now.
- **The audit trail redacts by key shape**, not by two hardcoded field names, so an action echoing a
  key-shaped argument cannot write a secret into the one file designed to be kept.
- A re-audit is planned after the first install (`AGENTS.md`).

### Scope, documentation and the name

- **A node on another machine, over RPC alone: tried, and dropped.** On 2026-09-13 the monitor was
  pointed at a node appliance on the LAN with `rpcUser` / `rpcPassword` and no `datadir` -- a
  configuration the validator had refused at boot until it was fixed -- and the monitor half
  worked: chain, mempool, peers, blocks, the block being built. The explorer did not, and no
  setting would make it: Core has no address index, `scantxoutset` holds the node's single RPC
  thread for tens of seconds per query and knows no history, and a node answering over the
  network in seconds left address pages waiting minutes. **Real-time explorer data over RPC was
  a failed idea.** The address data is rebuilt from the block files and stored locally instead,
  the way mempool.space's `electrs` does it (above), which is why BlockYard runs on the node's
  machine. The install guide's appliance section is gone; `rpcUser` / `rpcPassword` remain for a
  node that uses `rpcauth` instead of the cookie file, and the `bitcoin.conf` lines that measured
  as worth having (`txindex`, `coinstatsindex`, `dbcache`) are kept, each annotated with what it
  does for this monitor.
- **This is a Bitcoin Core-centric release.** The README, install, configuration, API and
  architecture documents describe Core; the shipped defaults are Core's own (`id: main`,
  `127.0.0.1:8332`, `~/.bitcoin`, `bitcoind.service`). Measurement records taken against a
  non-Core build are anonymised rather than relabelled -- they describe what was measured, and
  claiming otherwise would invent measurements that never happened.
- **Log parsing is documented as unavailable for Bitcoin Core.** The parsers target an experimental
  node's log grammar; fed Core's `debug.log` they extract no figures and timestamp entries at read
  time. The log source is off by default and should stay off against Core --
  `test/log-core-unsupported.test.js` pins that so it cannot be assumed away.
- **The old name is gone from the tree** (operator: "WHY THE FUCK DO I STILL SEE THE OLD NAME
  REFERENCES IN OUR TREE DOCS"): a `git grep` for the old prefix finds nothing but bytes in a JPEG.
  The allowlist's vendor-prefixed read verbs -- an earlier node's, and that node is not supported --
  are gone with their test, and a vendor-shaped method is denied by default; two scripts that
  defaulted a CA path to a directory named after the old project take it from the environment or
  nothing; `NOTICE` and `LICENSE` name BlockYard and its copyright holder.
- **Every document read against the code**: sessions are 72 h absolute / 8 h idle (two documents had
  it inverted); display settings live on the server; the effects list is the thirty that exist; four
  API routes that were undocumented are documented from their handlers; ARCHITECTURE gains the
  address-index subsystem; three stale code comments and the mempool feed's stated cadence
  (60 -> 20 s) corrected; screenshots re-shot against the local Core node. `docs/GETTING-STARTED.md`
  walks a macOS or Linux command prompt through the install (brew's plain node formula, where
  `bitcoin-cli` lives inside the macOS app bundle, one worker on spinning disks, the build's memory
  per worker). `docs/DEFECTS.md` states the scope and closes the entries whose only subject was the
  experimental node or a remote one. Eight one-off pixel probes whose questions are answered in
  MEASUREMENTS and DEFECTS are removed; the checks still used stay.
- **Donations are in two places only**: the foot of the README, in small type, and the About page,
  where the address is a pill that copies on a click (verified in a headless browser by reading the
  clipboard back) beside a QR of it (`scripts/donate-qr.py` generates the inline SVG and checks it
  decodes; the rendered page's screenshot decodes to the address too). They are out of the installer.
- **0.0.9 is the initial release number**, the operator's. The two earlier CHANGELOG sections that
  carried version numbers were never tagged or released and are kept as dated milestones;
  `server/main.js` reads the version from `package.json`, and `test/version.test.js` ties the
  CHANGELOG's newest release and the README to it.

### Since the 2026-09-11 milestone: added

- **A node connection form**, on **Node & RPC** (operator: "Still left to do is a config connection
  in the web settings. We have no way for users to configure a connection to their rpc backend").
  Enter an RPC URL, a data directory, a chain and a label; **test connection** probes it with a
  throwaway client that never touches the live node's request lane, and **save** is disabled until
  a test has actually answered — and goes back to disabled the moment a field changes. No password
  field: authentication is the node's own `.cookie`, found from the data directory.
- The save is honest about two things it would otherwise hide. It **keeps the fields the form does
  not show** — `logFile`, `systemdUnit`, the colour — because the config merge replaces arrays
  whole, so a naive write would quietly unconfigure the log tail. And where the environment sets
  `BLOCKYARD_NODE_URL` (a systemd drop-in, say), it says the environment beats the file rather than
  reporting a success the next restart contradicts.
- **The mempool page carries two panels it was already collecting data for.** `renderMempool` has
  been writing ingest/reject figures and orphan-pool figures into elements that did not exist —
  collected from the node's log, sent to the browser and dropped. They have cards now, and on a
  monitor running without a log tail they say so rather than showing a column of dashes. The page
  also lost four dead grid columns, and Pool usage gained the pool's total vsize, average vsize and
  total fees, all of which were computed on every sample and never drawn.
- **The grid is yours, per board** (operator: "we need to break out the green grid settings per
  game. We should also add a grid color picker, and a transparency slider ... I really want to turn
  down the intensity on blockanoid", and "add a color selector and brightness setting for the grid
  lighting for blockspace"). Block space, Tetrust, Blockout and Blockanoid each get a **grid
  colour** and a **grid intensity**, and the three games get a **grid** switch as well; Block space
  already had one. Every board is independent, so a court can be turned right down while the board
  stays bright. Until now the colour was hardcoded green in four separate files and could not be
  changed at all.
- One colour drives the whole grid rather than a single value. The board does not draw its grid in
  one colour: it lays an opaque core under a translucent halo and glow with a brighter line along
  the edge, and that relationship is deliberate — a see-through core reads dimmer wherever the
  floor beneath it is shadowed, and composite modes are off the table. The picker recolours the
  family and keeps each layer's relative weight; intensity multiplies them together.

- **Tetrust**: a playable Tetris on the 3D engine (`public/js/tetris.js` for the rules,
  `public/js/tetrust.js` for the screen). The well is the block-space board with its oblique
  camera and curved surface; a neon-blue wireframe marks where the piece will land; cleared
  lines fly up off the top of the canvas. Seven-bag piece order, wall kicks, the classic score
  table times the level, ten lines a level, and a top-ten high score table kept per browser.
  Pauses when the tab or the page loses focus. Arrows or WASD.
- **Music and sound effects for Tetrust**, synthesised in the browser with the Web Audio API —
  no audio files and no dependencies. Korobeiniki on a lookahead scheduler running on the audio
  clock, and nine shaped tones for move, rotate, soft drop, hard drop, lock, line clear, tetris,
  level up and game over. A switch for each.
- **Blockout**: Breakout on the 3D engine, in its own tab beside Tetrust (`public/js/breakout.js`
  for the rules, `public/js/blockout.js` for the screen). The bat follows the mouse — or the arrow
  keys — the wall is six rows of block-space stones one grid cell each, and where the ball lands on
  the bat decides where it goes. Three balls, a faster wall each level, and a per-browser high score
  table. The rules file has no DOM, no clock and no randomness (a launch angle is an argument), so
  the whole of it runs under the test suite, and the ball is sub-stepped so it cannot tunnel through
  a brick on a slow frame.
- **Every timed power expires after 30 seconds** — laser, wide, catch and slow, each counted down on
  the heads-up display. Three balls and the extra life are one-shot and have nothing to run out. One
  timer table and one expiry loop rather than four hand-written countdowns, for the same reason
  `loseLife()` exists: separate copies of a rule drift apart. Slow puts the pace back when it lapses
  (or "slow" would be permanent by omission) and wide restores the bat about its own centre,
  re-gripping a held ball into the narrower span.
- **A caught ball is locked to the bat.** It recorded no grip, so a stuck ball held its absolute
  position while the bat slid underneath and moved only when an edge caught up with it — which read
  as the ball drifting around. It remembers where along the bat it landed and is placed from that.
- **The ball bounces off a minion** instead of passing through. The collision forced the ball
  downward whatever direction it had arrived from, so dropping onto a minion pushed it further down.
  It reflects on the axis of least penetration now, exactly as a brick does, which gives the side
  bounces as well.
- **Catch expires after 30 seconds.** Held indefinitely it stopped being a power-up and became a
  different game: park the ball, aim every shot, and the rally ceases to exist. The countdown runs
  off `step`'s own elapsed milliseconds, like the laser cooldown and the minion timer, so the rules
  still carry no clock and a run stays reproducible. A ball still held when it lapses is released at
  the angle its position on the bat implies, rather than stranded there with nothing to explain it.
- **Minions, pill capsules and a bat that morphs.** The engine gained a rotated-polygon tile kind
  (`poly` + `rot`, with optional `eyes`), built the way the sphere is — nested filled polygons,
  since the op format has no arcs and gradients are forbidden — and claiming its own face name so
  the sphere's "nothing but ball ops" guarantee is untouched. On it: four **minion** types with
  their own silhouettes, spin rates and drift behaviours (a swinging cone, a tumbling cube, a
  wobbling orb, a zig-zagging molecule), each with eyes; **capsules** are now elongated pills that
  tumble as they fall, the angle taken from their own height rather than a clock so a frame stays
  reproducible; and **Vaus grows cannons** and a raised housing while the laser is up, so the bat
  shows what it can do rather than only changing colour. The capsules keep their per-capsule band
  mark, so the seven remain separable without colour even though they now share one silhouette.
- **An About page**, reached by clicking the BlockYard monogram in the header rather than by a nav
  tab of its own — the bar is already full enough to wrap below 2000 px. It shows the version and
  live build, the host's operating system, architecture, processors, memory and runtime, and the
  Bitcoin node's own version and protocol, over the spiral galaxy the other boards draw. New
  `GET /api/about` supplies the host facts and deliberately reports no hostname, username, network
  address or environment: the monitor is open-access by default, so the OS and processor describe
  the machine's shape and never its owner.
- **A stylised BY monogram and a real gear.** The brand mark was the letter `B` in a tile; it is now
  a drawn monogram whose tile, gradient and courses of blocks live in the SVG, so the favicon is the
  same drawing. The settings button was a circle with eight radiating rays — the standard sun glyph,
  which is why it read as a light/dark toggle — and is now a cog with teeth and a punched bore.
- **The Kiosk's price panel becomes Price & order book depth.** The 24 h high, low, volume,
  spread across books and the per-exchange table are gone; in their place is the depth chart,
  compact and toolbar-less, fixed at ±2.5% around the mid. A wall display is read from across a
  room, where a four-column table is unreadable and the shape of the book says more than a spread
  figure — all of it is still on the Markets tab. The chart shares the Markets tab's single poll,
  so having both open does not double the traffic to five exchanges, and the depth endpoint marks
  the collector as watched, so an unattended kiosk keeps its books fresh by itself.
- **Blockanoid**: Arkanoid on the 3D engine, the third Diversion (`public/js/arkanoid.js` for the
  rules, `public/js/blockanoid.js` for the screen). Six hand-built walls that cycle; **silver**
  bricks that take two hits and one more every four levels, standing lower once damaged; **gold**
  that never breaks and never blocks a level, since a wall is cleared when its *breakable* bricks
  are gone. Six **capsules** fall out of broken bricks — laser, enlarge, catch, slow, disrupt
  (three balls) and player (a life) — one on the court at a time, as the
  arcade did it. Vaus turns red while the laser is up, so the bat says what it can do. Minions
  drift down the court and pay when destroyed. Which brick carries a capsule is a **hash of the
  brick and the level, never `Math.random`**, so a wall always drops the same letters and the
  whole thing is assertable under `node:test`. Capsules and minions each have a switch, and
  because they change the rules rather than the look, flipping one reaches the game in play.
- **Seventeen new idle effects**, bringing the total then to **26** (30 at release; above), each with its own switch:
  shockwave, nova, fireworks, solar flare, wave, quake, code rain, sparkle, checkerboard, radar,
  vortex, laser, power-up, combo chain, aurora, plasma and glitch. All are pure functions of the
  tile and the effect's clock, so each replays identically and is covered by tests rather than
  by watching.
- **Block finishes**: **neon blocks** (a dim solid body in the block's fee-rate colour under lit
  tubes on every visible edge) and a **metallic sheen** (a specular highlight on the lit edge of
  each top face, a dark roll-off on the far one). Both work at every level of detail. The neon
  tubes can take the block's own colour or one colour of your choosing, at a brightness you set.
- **A movable lamp**: `Light` chooses straight above (now the default for Block space), upper
  left, upper right, or from the viewer.
- **A thickness slider for Tetrust's landing marker**, 0.3 to 2.5 times the shipped weight, so the
  outline can be thinned out of the way of the stack behind it.
- Broken bricks in Blockout **fly up off the court** instead of vanishing, the same launch Tetrust's
  cleared lines take.
- **`txindex=1` is documented as required** for the explorer's transaction pages — a transaction page
  asks for `getrawtransaction <txid> 2` with no block hash, which a node without the index can only
  answer for its mempool. Block pages pass the hash and are unaffected. Install, README and
  troubleshooting all say so now.
- **The Tetrust landing marker's colour is a setting.** The wireframe showing where the falling
  piece will land is drawn instead of a block rather than over one, so the neon finish never
  applied to it and it stayed the shipped blue whatever else was changed; it has its own colour
  now, and `tiles()` takes it as an argument so the rules file still knows nothing of the store.
- **A tabbed Display settings panel**, with all-on / all-off on the Effects tab, whose
  twenty-six switches -- thirty now -- are a lot of clicking otherwise.
- **Markets remembers its toolbar**: the exchange and the range are settings now, so the page
  opens where you left it.

### Since the 2026-09-11 milestone: changed

- **The block being built is assembled here now, and costs your node nothing.** It used to be a
  `getblocktemplate` call worth 1.3-1.5 s of the node's single RPC thread and 1.79 MB per reply,
  fetched on demand so a page nobody had open did not pay it every minute. Bitcoin Core publishes
  everything the selection needs in the `getrawmempool(true)` reply this monitor **already reads
  every 20 s** for the mempool view: `depends`, the ancestor sizes and fees, and
  `fees.chunk`/`chunkweight` -- Core's own cluster-mempool linearization, which is the order its
  miner sorts by. `server/collect/gbt.js` selects greedily over that, taking each transaction with
  its unselected ancestors, and returns the result in the shape a `getblocktemplate` reply has, so
  the summary, the histogram, the package analysis and the block economy read it unchanged.

  Measured against the node's own template on a back-to-back pair at height 966821, so the two
  describe the same pool: **6,546 transactions / 3,995,859 weight / 643,076 sat** against the
  node's **6,535 / 3,991,951 / 642,860** -- 0.03% apart on fees, with the set difference confined
  to the 0.30 sat/vB margin where ties are arbitrary. Assembly takes ~50-70 ms of this process's
  CPU. It is a reconstruction of what a miner would choose, not the node's answer: sigop limits
  and policy the mempool does not publish are not modelled, and the card says so.

  The old measurement in `docs/MEASUREMENTS.md` -- that `getrawmempool` verbose carries no
  `depends` -- was true of the experimental node it was taken on, and is kept there with the
  correction appended rather than rewritten.
- **The default web port is 21000** (was 8088).
- **Display settings are stored on the server** in `config/blockyard.json`, so a phone and a
  desktop pointed at the same monitor agree. The browser keeps a cache so boards still draw when
  the server cannot be reached.
- **Block space ships with simple cubes and shadows off.** Shadows are the costliest single thing
  the board draws, and the board is the first thing most people open; both remain one click away in
  Display settings.
- The two games sit at the end of the nav under a **Diversions** pop-down, rather than among the
  working tabs.
- The Markets energy pulse now runs along the neon price line itself, leaving an electric-blue
  tail that fades back to yellow behind a bright head, with a nebula of blue smoke emitted along
  the whole charged span and a shimmer over it. The lightning ball trails the same charge across
  the block-space board; the light cycles do not.
- The pulse's nebula is emitted over the whole charged span rather than per segment — emitting per
  segment gave neighbouring puffs the same age, so they shared a radius and lined up into the
  concentric rings they were meant to replace. (Its motes and crackle branches were removed at the
  same time and restored afterwards; they are present.)
- The Simple viewer packs the block exactly: the block's own area is solved so the tiles fill
  the grid flush, and the remainder is tiled to the edge instead of leaving a partial top row.
- Pool attribution moved out of the block card's body into a readable pill beneath it.

### Since the 2026-09-11 milestone: fixed

- **Coinbase attribution stopped permanently after one failed block.** `pumpMining` cleared the
  whole queue on a single failure and nothing ever re-queued it, so one slow moment discarded the
  entire 36-block boot window and the Mining page sat empty. The failed height is put back, the
  rest of the queue survives, and a backoff decides when to retry.
- **The block template no longer monopolises the RPC lane.** `getblocktemplate` went through as an
  ordinary call with a 12-second freshness budget; on a node where it takes seconds, everything
  queued behind it was stale-dropped and `/api/nextblock` took 75 s. It is now heavy, keyed and
  given a realistic budget -- measured 52.8 s to 4.2 s on the same node.
- **The display-settings sliders no longer jitter while dragging** (operator: "the grid intensity
  slider jitters when I move it"). Every `input` event ran a full synchronous re-render; a drag
  across the grid intensity control queued forty of them, each repainting a board. The value and
  the readout still update on every event — only the repaint is coalesced, to one per animation
  frame. All twelve range controls were affected; the new one merely made it visible.
- **The Diversions menu renders correctly in Safari** (operator: "rendering on safari is still
  broken. It's only showing half the drop-down contents"). The panel was inside `header.top`, which
  is `overflow: hidden` and 46px tall, and WebKit clipped the fixed panel to it. It is a top-level
  element now, like the settings dialog, which is the fixed overlay that always rendered correctly.
  Its position is measured and set rather than pulled back by a transform.
- **Display-settings sliders jumped as their value changed**: the readout's width changed with its
  digits and pushed the slider about. The value is printed to the step's decimals in a fixed-width
  box.
- **The header's uptime blanked every second** and **the node you pick stays picked**.
- **The travelling cube's perspective froze in flight** (a regression of our own, recorded).
- **The pulse-gap simulation was flaky**: seeded now, its bound the real worst case.
- The block-being-built card named a call it does not make; lightning stopped whiskering; the
  paint-order comments described a camera the viewer no longer has.
- **The star field never animated on a board that asked for no tile choreography.** `still` is
  about the tiles; it was also returning before the animation loop started, so Tetrust's galaxy
  repainted only when the page happened to redraw — measured at zero repaints in three seconds.
  The loop now parks only when there is genuinely nothing moving. Measured after: 87 repaints in
  three seconds, idle and in play.
- **Blocks swapped in front of each other during refreshes.** Where cubes overlap, the paint
  order is solved as a graph; a cube flying past could pull a settled pair into a tangle and the
  tangle was ordered by depth alone, discarding the pair's own decision. A tangle now keeps the
  relative order it had in the previous frame. Replayed over a 634-frame transition: 19 flickers
  to none.
- **Neon and the metallic sheen did nothing when switched on** — `render3d` never passed either
  option through to the scene builder.
- The galaxy is much cheaper to draw: its gas is painted once into an offscreen bitmap and drawn
  turned, and the stars are batched by colour and brightness instead of setting a fill style per
  star.
- Blocks with no pool attribution showed no statistics at all.
- Taller cubes no longer clip the neighbour they lean over on a settled board.
- **The Explorer's Latest blocks cubes were drawn with faces that did not meet.** The top face and
  the right face were each inset five pixels on two sides, so neither reached the top-right corner:
  every block carried a dark triangular wedge there, a sliver of bare card at the top left and a
  gap at the bottom right. The faces are now flush with the card and with each other.
- **The network hash rate read "0.0 EH/s".** Two bugs, one hiding the other. The estimator divided
  difficulty by the average block gap and left out the 2^32 hashes a difficulty-1 target expects,
  so it was out by a factor of 4.29 billion; and the formatter's unit prefixes were each one step
  too low, so a four-digit EH/s figure would have printed as a single-digit one. Checked against
  the node's own `getnetworkhashps`, which the monitor had never used: the corrected estimate is
  1111.8 EH/s against the node's 1097.9, agreeing to 1.26%. The test covering it asserted that the
  wrong magnitude was "of the right order", which is why it survived; it now checks the figure
  could be true rather than restating the implementation.

## Milestone 2026-09-11 (labelled 0.9.0 internally; never tagged or released)

Licensed Apache-2.0 from here on. The block-space packer and feerate palette
are an original implementation (`public/js/blockpack.js`, `public/js/feepalette.js`).

### Monitor

- Live dashboard for one or more Bitcoin nodes over JSON-RPC, with an optional
  log source: Overview, Chain & Sync, Mempool, Peers, Network, Mining, Events, Node & RPC and
  Admin tabs, updated once a second over Server-Sent Events.
- Sync viewer whose bar is blocks held over announced headers, with the node's own progress
  shown separately and an ETA computed only from a measured rate window.
- Block flow: projected blocks beyond the one being assembled (fee range, median, fees,
  transaction count, time estimate), the block being built with its age ring, and recent
  blocks linked as a chain.
- Peer table from `getpeerinfo`: direction, transport, services, height at connect, bytes and
  rates per connection.
- A provenance table naming the source of every figure, and explicit "not reported" markers
  instead of zeros.

### Block space viewer

- A 3D board of the next block's worth of the mempool: square tiles sized by vbytes and
  coloured by feerate, on a curved, neon-gridded board.
- 128 feerate colours from under 0.1 to 2,000 sat/vB, sky blue through green, yellow, orange
  and red to purple, with neighbouring bands stepped in tone so they read apart.
- Choreographed refreshes: blocks lift, travel in collision-free lanes and land under gravity
  with bounces; cube-on-cube shadows; a refresh countdown and a "refresh now" button.
- Idle effects at rest: ripples, scans, tides, cascades, twinkles, TRON light cycles and a
  lightning ball that runs along the grid lighting the cubes it passes.
- Viewer modes: **Simple** (the richest few hundred transactions as cubes, the rest as
  equal pieces coloured by their feerate) and
  **Detailed** (every transaction in the next block, one square each on a 96-unit
  grid, drawn as low slabs, each square area-true so a full block fills the board),
  remembered per browser.

### Explorer

- Search by block height, block hash, transaction id or address; every page is a shareable
  link (`#explorer/…`).
- Transaction pages: status, fee and fee rate with dollar values, feature badges (SegWit,
  Taproot, RBF, consolidation, OP_RETURN, coinbase), a flow diagram from inputs to outputs,
  inputs and outputs with links to the spent and spending transactions, copy buttons.
- Block pages with statistics and paged transactions; address pages with balance, totals and
  history (with the node's address index); the latest blocks as fee-coloured cubes.
- Links into the explorer from the rest of the app.

### Markets

- Prices from Coinbase, Kraken, Bitstamp, Bitfinex and OKX, fetched by the server only while
  someone has the Markets or Kiosk tab open.
- A 3D candle chart on a low side-on camera with a neon close line, volume band, labelled
  price levels, a star field and light from the front right.
- A flat candlestick chart with a crosshair readout and other exchanges overlaid; an exchange
  table; 24 h / 48 h / 7 d ranges.
- An order-book depth chart: cumulative bids and asks per exchange and in total, the total as
  it stood 1–60 minutes ago, and change bars on a symmetric-log axis.

### Kiosk

- The 3D markets board, a price panel and the block-space board side by side, with a
  full-screen button.

### Display settings

- A gear in the header opens a settings panel: shadows, idle effects, stone edges, the neon grid,
  a star field, level of detail (full / simple cubes / flat tiles), refresh animation
  (full / quick / none) and board curve for the block-space board; star field, density, brightness
  and grid glow for the markets board. Kept in the browser, applied without a reload, and each one
  changes what is drawn rather than only what is stored.

### Security

- Open, read-only access by default; optional accounts with scrypt hashing, hashed sessions,
  CSRF protection, lockouts and a rotated audit trail.
- Default-deny RPC allowlist; node writes off unless explicitly enabled per action.
- Built-in HTTPS, multi-address binding, a CIDR gate, and a strict Content Security Policy
  with no inline styles and no third-party assets.

## Milestone 2026-09-08 (labelled 0.1.0 internally; never released)

Internal first version: multi-user monitor with charts, sync viewer, mempool view, peers and
event feed.

[0.0.10]: https://github.com/BobClawblaw/blockyard/releases/tag/v0.0.10
[0.0.9]: https://github.com/BobClawblaw/blockyard/releases/tag/v0.0.9
