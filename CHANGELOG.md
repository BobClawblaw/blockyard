# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-09-14

The first official release. Everything in it, like everything before it, was written by an AI directed by a human
operator, and audited by AI (`docs/SECURITY-AUDIT.md`). It is experimental pre-release software.

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
  it works for a node on another machine), and **logs the rows before serving them** in a
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
- **Not yet:** an address's unspent-output list, and its transactions still in the mempool.
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
  walks a macOS or Linux command prompt through it.
- **An unconfirmed transaction shows its inputs and fee** (operator: "Unknown script?!", of a
  mempool transaction whose 858 inputs all read *unknown script*). Core carries no `prevout` on a
  mempool transaction's inputs, so `fillPrevouts` fetches the parents in one batch and fills each
  input's script and amount; checked on that transaction, 858 of 858 inputs, and a fee of 77,958
  sat equal to `getmempoolentry`.

### Block space and Markets since the 2026-09-11 milestone

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

### Fixed since the 2026-09-11 milestone

- **Display-settings sliders jumped as their value changed**: the readout's width changed with its
  digits and pushed the slider about. The value is printed to the step's decimals in a fixed-width
  box.
- **The header's uptime blanked every second** and **the node you pick stays picked**.
- **The travelling cube's perspective froze in flight** (a regression of our own, recorded).
- **The pulse-gap simulation was flaky**: seeded now, its bound the real worst case.
- The block-being-built card named a call it does not make; lightning stopped whiskering; the
  paint-order comments described a camera the viewer no longer has.


### Changed

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

### Added

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

### Changed

- **This is a Bitcoin Core-centric release.** The README, install, configuration, API and
  architecture documents describe Core; the shipped defaults are Core's own (`id: main`,
  `127.0.0.1:8332`, `~/.bitcoin`, `bitcoind.service`). Measurement records taken against a
  non-Core build are anonymised rather than relabelled -- they describe what was measured, and
  claiming otherwise would invent measurements that never happened.
- **The default web port is 21000** (was 8088).
- **Display settings are stored on the server** in `config/blockyard.json`, so a phone and a
  desktop pointed at the same monitor agree. The browser keeps a cache so boards still draw when
  the server cannot be reached.
- **Log parsing is documented as unavailable for Bitcoin Core.** The parsers target an experimental
  node's log grammar; fed Core's `debug.log` they extract no figures and timestamp entries at read
  time. The log source is off by default and should stay off against Core --
  `test/log-core-unsupported.test.js` pins that so it cannot be assumed away.

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

### Fixed

- **The node-connection probe leaked the node's RPC credential** (HIGH, found by audit and
  reproduced with a working exploit). `POST /api/config/node/test` built its throwaway client from
  the live node's config, so `resolveCookie` read the real `.cookie` and sent it as an
  `Authorization` header **to whatever URL the request named** -- on a request needing no session
  and no CSRF token, reachable by a plain cross-site form. Credentials now go only to the endpoint
  the monitor is already configured for; anywhere else is probed unauthenticated and says so. Open
  mode additionally refuses any state-changing request whose `Origin` is not this server or whose
  `Sec-Fetch-Site` says cross-site.
- **Coinbase attribution stopped permanently after one failed block.** `pumpMining` cleared the
  whole queue on a single failure and nothing ever re-queued it, so one slow moment discarded the
  entire 36-block boot window and the Mining page sat empty. The failed height is put back, the
  rest of the queue survives, and a backoff decides when to retry.
- **The block template no longer monopolises the RPC lane.** `getblocktemplate` went through as an
  ordinary call with a 12-second freshness budget; on a node where it takes seconds, everything
  queued behind it was stale-dropped and `/api/nextblock` took 75 s. It is now heavy, keyed and
  given a realistic budget -- measured 52.8 s to 4.2 s on the same node.
- **Session TTLs were inverted**: an 8-hour absolute lifetime with a 72-hour idle ceiling meant the
  idle check could never fire. Now 72 h absolute, 8 h idle, with a test on the invariant.
- **`randomPassword()` drew with modulo bias**, over-representing the first 58 characters of its
  66-character alphabet. It uses `crypto.randomInt` now.
- **The audit trail redacts by key shape**, not by two hardcoded field names, so an action echoing a
  key-shaped argument cannot write a secret into the one file designed to be kept.

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
- **Seventeen new idle effects**, bringing the total to **26**, each with its own switch:
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
  twenty-six switches are a lot of clicking otherwise.
- **Markets remembers its toolbar**: the exchange and the range are settings now, so the page
  opens where you left it.

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

[0.1.0]: https://github.com/BobClawblaw/blockyard/releases/tag/v0.1.0
