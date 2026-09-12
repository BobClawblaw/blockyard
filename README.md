# bmcmonitor

A live, multi-user web monitor and block explorer for
[Bitcoin Machine Code](https://github.com/BobClawblaw/bitcoinmachinecode) (`bmc`), the
fully-validating Bitcoin node written in hand-authored x86-64 assembly.

Point it at a `bmc` node and open a browser: live charts, a 3D block-space viewer,
a block / transaction / address explorer, exchange prices with order-book depth, and a
kiosk view for a wall screen. No dependencies to install, no CDN, no telemetry, and
read-only toward your node by default.

![Overview](docs/images/overview.jpg)

## Highlights

| | |
|---|---|
| **Block space, in 3D.** The next block's worth of the mempool as a board of glowing tiles: area is vbytes, colour is feerate. Refreshes are choreographed — blocks lift, travel in collision-free lanes and land under gravity — and the board comes alive at rest with ripples, light cycles and a lightning ball. Two viewer modes: **Simple** (the richest few hundred transactions as cubes) and **Detailed** (every transaction in the block). | ![Block space, Detailed mode](docs/images/block-space-mode2.jpg) |
| **An explorer that looks the part.** Search a height, block hash, txid or address. Transaction pages with fee, fee rate and dollar value, feature badges, a flow diagram from inputs to outputs, and links to where every coin came from and went. | ![Explorer transaction](docs/images/explorer-tx.jpg) |
| **Markets.** Five exchanges' public prices: a 3D candle chart with a neon price line, a precise flat candlestick chart, an exchange table, and a bitcoinity-style order-book depth chart with change bars. Fetched by the server only while someone is looking. | ![Markets](docs/images/markets.jpg) |
| **Kiosk.** The 3D markets board, a price panel and the block-space board side by side, full screen with one click. | ![Kiosk](docs/images/kiosk.jpg) |

Also on board: a sync viewer with an honest ETA, Block flow (projected blocks, the block
being built, recent blocks), mempool and fee charts, a peer table, bandwidth, the node's
event stream, a provenance table for every figure, and a read-only RPC console behind a
default-deny allowlist.

## Quick start

You need **Node.js 22 or newer** and a running `bmc` node with JSON-RPC enabled.

```bash
git clone https://github.com/BobClawblaw/bmcmonitor.git
cd bmcmonitor
npm test            # optional: 595 unit tests, all built in
npm run dev         # try it first against a built-in fake node: http://127.0.0.1:18088
```

To watch your own node, create `config/local.json`:

```json
{
  "server": { "host": "127.0.0.1", "port": 8088 },
  "nodes": [
    {
      "id": "main",
      "label": "My bmc node",
      "rpcUrl": "http://127.0.0.1:8331",
      "datadir": "/var/lib/bmc/data",
      "chainHint": "main"
    }
  ]
}
```

then `npm start` and open <http://127.0.0.1:8088>. There is no `npm install` step — there
is nothing to install.

The full walkthrough — service install, network exposure, accounts, TLS, a reverse proxy —
is in **[docs/INSTALL.md](docs/INSTALL.md)**.

## Documentation

| document | what it covers |
|---|---|
| [Install](docs/INSTALL.md) | requirements, first run, systemd service, exposure, accounts, TLS, reverse proxy, updating |
| [Configuration](docs/CONFIGURATION.md) | every config key and environment variable, with examples |
| [User guide](docs/USER-GUIDE.md) | a tour of every tab and panel, and how to read them |
| [API](docs/API.md) | the JSON HTTP API and the Server-Sent Events stream |
| [Architecture](docs/ARCHITECTURE.md) | server, RPC lane, collectors, browser app and the 3D engine |
| [Security & privacy](docs/SECURITY.md) | the access model, hardening, and every outbound connection |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | the problems people actually hit, and the fixes |
| [Contributing](CONTRIBUTING.md) | development setup, tests, and the project's rules |
| [Changelog](CHANGELOG.md) | release history |

Deeper reference material: [docs/RULES.md](docs/RULES.md) (the rules, each with the defect
that produced it), [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) (the node measurements the
design rests on) and [docs/DEFECTS.md](docs/DEFECTS.md) (known limits).

## Design principles

- **Read-only by default.** The monitor never writes to your node unless you enable
  individual actions, with accounts on and a typed confirmation per call.
- **A good guest.** The `bmc` RPC server answers one connection at a time on one thread,
  so every request goes through one serialized, prioritised, batched lane. The monitor
  would rather skip a poll than slow your node down.
- **Honest data.** A missing figure is shown as missing, never as zero; stale data looks
  stale; inferred numbers are labelled as inferences; every figure's source is listed on
  the Node & RPC page.
- **Zero dependencies.** Node built-ins on the server; vanilla ES modules and hand-written
  canvas rendering in the browser. No build step, no CDN, nothing fetched from third
  parties by your browser.

## Security at a glance

- **Open, read-only access by default** — like a block explorer, anyone who can reach the
  port can look. Accounts, roles, sessions, CSRF protection and a per-user audit trail turn
  on with `BMC_MON_AUTH=1`.
- **Where it listens is your decision** — bind to `127.0.0.1`, a LAN address, a VPN
  address, or several. Built-in HTTPS with `BMC_MON_TLS_CERT` / `BMC_MON_TLS_KEY`.
- **Outbound connections are limited and on demand**: exchange APIs only while someone has
  the Markets or Kiosk tab open (and a cached spot price for the explorer's dollar figures).
  `BMC_MON_MARKETS=0` turns all of it off.

Details in [docs/SECURITY.md](docs/SECURITY.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # fake node doing a simulated sync, port 18088
npm test             # 595 unit tests (node:test, no dependencies)
npm run smoke        # boots the real server and checks the HTTP contract
npm run counts:fix   # keep the documented test count in step with the suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project's rules (CSP, canvas, privacy,
RPC etiquette) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.

## Status

Version **0.9.0** — the first public release. The feature set is complete and covered by
the test suite; expect polish and fixes before 1.0. Known limits are listed in
[docs/DEFECTS.md](docs/DEFECTS.md).

## Acknowledgements

The block-space view and the explorer are inspired by the look of
[mempool.space](https://mempool.space); the markets tab by
[bitcoinity.org](https://data.bitcoinity.org). Market data comes from the public APIs of
Coinbase, Kraken, Bitstamp, Bitfinex and OKX.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). The block-space packer and feerate palette are an original implementation (public/js/blockpack.js, public/js/feepalette.js), inspired by the look of mempool.space but containing none of its code.
