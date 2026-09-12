# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

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

### Changed

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

## [0.9.0] — 2026-09-11

The first public release, licensed Apache-2.0. The block-space packer and feerate palette
are an original implementation (`public/js/blockpack.js`, `public/js/feepalette.js`).

### Monitor

- Live dashboard for one or more Bitcoin Machine Code nodes over JSON-RPC, with an optional
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

## [0.1.0] — 2026-09-08

Internal first version: multi-user monitor with charts, sync viewer, mempool view, peers and
event feed.

[0.9.0]: https://github.com/BobClawblaw/blockyard/releases/tag/v0.9.0
[0.1.0]: https://github.com/BobClawblaw/blockyard/commits/main
