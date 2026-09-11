# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

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
- Viewer modes: **Simple** (the richest few hundred transactions as cubes) and
  **Detailed** (every transaction in the next block, one square each on a 96-unit
  grid, drawn as low slabs), remembered per browser.

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

### Security

- Open, read-only access by default; optional accounts with scrypt hashing, hashed sessions,
  CSRF protection, lockouts and a rotated audit trail.
- Default-deny RPC allowlist; node writes off unless explicitly enabled per action.
- Built-in HTTPS, multi-address binding, a CIDR gate, and a strict Content Security Policy
  with no inline styles and no third-party assets.

## [0.1.0] — 2026-09-08

Internal first version: multi-user monitor with charts, sync viewer, mempool view, peers and
event feed.

[0.9.0]: https://github.com/BobClawblaw/bmcmonitor/releases/tag/v0.9.0
[0.1.0]: https://github.com/BobClawblaw/bmcmonitor/commits/main
