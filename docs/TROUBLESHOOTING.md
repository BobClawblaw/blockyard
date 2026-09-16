# Troubleshooting

The monitor tries to explain itself: the start-up log, the header badges and the **Node &
RPC** page usually name the problem. This page collects the cases people actually hit.

- [The service does not start](#the-service-does-not-start)
- [A node shows offline](#a-node-shows-offline)
- [The page does not load from another machine](#the-page-does-not-load-from-another-machine)
- [The header says "stale" or "reconnecting"](#the-header-says-stale-or-reconnecting)
- [The header says STALLED](#the-header-says-stalled)
- [The node's RPC is slow](#the-nodes-rpc-is-slow)
- [The block-space board is empty, or "no block template yet"](#the-block-space-board-is-empty-or-no-block-template-yet)
- [The address index build is paused, or slow](#the-address-index-build-is-paused-or-slow)
- [Markets or Kiosk show no prices](#markets-or-kiosk-show-no-prices)
- [An exchange shows an error](#an-exchange-shows-an-error)
- [Explorer: a transaction id is not found](#explorer-a-transaction-id-is-not-found)
- [Explorer: address pages read "not indexed"](#explorer-address-pages-read-not-indexed)
- [Explorer: the address page says the index is behind, or has stopped following](#explorer-the-address-page-says-the-index-is-behind-or-has-stopped-following)
- [Explorer: "spent by" links are missing](#explorer-spent-by-links-are-missing)
- [Explorer: no dollar figures](#explorer-no-dollar-figures)
- [The 3D views are slow or blank](#the-3d-views-are-slow-or-blank)
- [Full screen does not work on the Kiosk](#full-screen-does-not-work-on-the-kiosk)
- [Sign-in problems](#sign-in-problems)
- [Tests fail on a fresh clone](#tests-fail-on-a-fresh-clone)

## The service does not start

Read the journal first: `journalctl -u blockyard -n 100 --no-pager`.

| message or symptom | cause and fix |
|---|---|
| a syntax error at start-up | the runtime is older than Node 22. Check `node -v` **as the service account**, and give `ExecStart` an absolute path to a Node 22 binary. |
| `EADDRINUSE` | something else holds the port. Change `server.port` / `BLOCKYARD_PORT`, or stop the other process (`ss -ltnp | grep 21000`). |
| none of the configured addresses exist | the bind names addresses this machine does not have (for example after a DHCP change). The log prints the addresses it does have; fix `server.host`. |
| `Invalid configuration` followed by a list | each line names the setting and why — for example a certificate without a key, an expired certificate, a malformed CIDR, or node writes enabled without accounts. |
| `config: cannot parse …/local.json` | the JSON has a syntax error (a trailing comma is the usual one). |

## A node shows offline

The Node & RPC page shows the last error. Common causes:

- **`ECONNREFUSED`** — nothing is listening at `rpcUrl`. Check the node is running and which
  RPC port it uses (`rpcport` in its configuration); the node may also bind RPC a little while
  after its service reports "started".
- **`401` / authentication failed** — the cookie could not be read or is out of date. The
  cookie is rewritten on every node restart and removed when the node stops. Make sure the
  service account can read `<datadir>/<chain>/.cookie` (usually by being in the node's group),
  or configure `rpcUser` / `rpcPassword`.
- **"datadir does not exist"** at start-up — the node entry points at a directory that is not
  there; the node is skipped rather than shown as permanently offline. Fix `datadir` or set
  `cookieFile` directly.
- **Timeouts** right after the node starts — some node builds block RPC for a while during
  start-up. The monitor keeps retrying; wait a minute.

## The page does not load from another machine

0. Out of the box the monitor binds `127.0.0.1` and answers this machine only. Either reach
   it over an SSH tunnel (`ssh -L 21000:127.0.0.1:21000 you@host`, then `https://localhost:21000`)
   or bind a LAN address: `BLOCKYARD_BIND=192.0.2.10` (or `0.0.0.0`), or `server.hosts` in
   `config/local.json`, and restart.
1. From the other machine, check how it reaches the server: `ip route get <address>`.
2. Make sure that address is one the monitor binds — see the start-up log. A LAN-only bind is
   not reachable over a VPN unless the VPN address is also listed in `server.host`.
3. Check firewalls on the server (`ufw status`, `nft list ruleset`) for the port.
4. If `server.allowCidrs` is set, the client's network must be in it.
5. Testing from the server itself proves little: with a single LAN address bound, `127.0.0.1`
   does not answer, and a firewall usually allows loopback.

## The header says "stale" or "reconnecting"

- **reconnecting** — the live stream (Server-Sent Events) dropped. Behind a reverse proxy the
  usual cause is response buffering or a short read timeout on `/api/stream`; see the proxy
  example in [INSTALL.md](INSTALL.md#10-behind-a-reverse-proxy-optional).
- **stale** — no fresh data has arrived for a while. Charts keep the last picture with a
  "stale" label rather than going blank; the Node & RPC page shows which poll is failing.

## The header says STALLED

A long gap between blocks is not a stall: the network finds no block for 40 minutes about once
in fifty, and two healthy nodes at the same height once sat through 42 minutes of it with the
header red. Since 2026-09-14 the sync state is **stalled** only when the node's **connected
peers report a higher tip than the node holds** (`getpeerinfo` `synced_headers`) — it is behind
the network, not waiting for it. When the peers agree on the node's tip, a long gap is shown as
*synced* with a caveat naming the gap. When no peer height is known at all (no peers, or none
that report one), the node is called stalled only after **two hours** without a block, because a
long gap and a node cut off from its peers cannot be told apart sooner. The sync panel's caveats
say which of the three cases it is.

If it really is stalled: check the node's peer count and its own log; a node behind a firewall
that has lost its connections looks exactly like this.

## The node's RPC is slow

The Node & RPC page shows RPC latency and the queue. When the node is slow the monitor
stretches its polling automatically and skips heavy reads, so a busy node (for example during
initial sync) shows fewer updates rather than being slowed further. Slow means an average above
`rpc.slowLatencyMs` (5 s by default): the `rpc-slow` flag appears on the Overview, and a running
address index build pauses until the node recovers (see
[below](#the-address-index-build-is-paused-or-slow)).

To time the node **alone**, with no monitor in the way: `npm run check` runs the install-time
checks against every configured node and prints how long each call took — `getblockchaininfo`,
`getblock <tip> 3` and a verbose `getrawmempool` among them. A `getblock 3` over 5 s or a mempool
read over 10 s is marked slow there, with what it will mean for the pages.

The monitor runs **one** request at a time, always. `rpc.maxInFlight` exists in the config and
is reported by `/api/config`, but the lane is serialised by construction and does not read it --
measured 2026-09-13 at 1, 4 and 8: four 200 ms jobs took ~807 ms with peak concurrency 1 in every
case. Treat it as documentation of intent, not a tuning knob. (The address index build has a
second connection of its own for its few cheap calls; it is paced by the first lane's telemetry
and adds nothing while the node is slow.)

What costs time on a mainnet node is the expensive reads, and how much depends on how the node is
configured. The sharpest example used to be the block template -- since 2026-09-13 the monitor
assembles that from the mempool and never calls `getblocktemplate`, so the numbers below are kept
as the clearest illustration of what node tuning is worth, not as a call this software still
makes. Measured on a Core 31.1.0 node on 2026-09-13, **before** its RPC settings were
tuned: `getblockchaininfo` 95-110 ms, `getmempoolinfo` ~100 ms, but `getblocktemplate`
**4.0-4.5 s**, five times in a row with no warming -- while the same call on a local Core node
answered in **51 ms**. Two concurrent templates contended rather than overlapped there (6.9 s and
8.8 s against 4.5 s alone), so more concurrency would not have helped that call.

**After** applying `dbcache=4096` plus the RPC settings in [INSTALL](INSTALL.md), the same node
answered `getblocktemplate` in **488-565 ms** and the monitor's lane stopped timing out entirely,
with average latency sampling between ~180 ms and a few seconds. If your node shows
`rpc-slow`, check those settings before concluding the node is simply slow -- and note that a
rebuilding index (`coinstatsindex` takes hours from genesis) competes for the same disk and will
keep latency up until it finishes.

## The block-space board is empty, or "no block template yet"

The board and the block being built are **assembled from the node's verbose mempool**
(`getrawmempool true`), which the monitor reads every 20 s; the monitor never calls
`getblocktemplate`. The board is empty when that read has not succeeded yet:

- **Right after start-up** — the first verbose read comes a few seconds in; the board lands a
  little after the Overview fills.
- **The node's RPC is slow** — a verbose mempool read on a large mempool is the monitor's
  heaviest regular call, and on a slow node it is the one that takes tens of seconds. While the
  lane's average latency is over the slow threshold the heavy tiers are skipped
  (`heavy-tiers-skipped` on the Overview), and a read that is superseded before it finishes is
  **dropped as stale** rather than queued (`getrawmempool verbose failed` in the events feed) — so
  the board stays as it was, or empty. `npm run check` times that same read against the node with
  nothing else in the way; if it is slow there too, the node is the bottleneck: see
  [above](#the-nodes-rpc-is-slow) and the `dbcache` / `rpcservertimeout` lines in
  [INSTALL](INSTALL.md#bitcoinconf-settings-worth-having). An address index build on the same disk
  pauses itself while this lasts.
- **Initial block download** — the card says so; there is no chain to build a block on yet.
- **`BLOCKYARD_MINING_TEMPLATE=0`** — the block being built is disabled by configuration.

## The address index build is paused, or slow

The Overview's "What this panel cannot tell you" box shows the build's phase, files done, rows
so far and an ETA; the address page repeats it. Things it says, and what they mean:

- **paused while the node's RPC is slow** — by design. The build's workers read the block files
  the node is also reading, so before each file the build checks the monitor's RPC telemetry:
  while the node is failing or answering slower on average than `rpc.slowLatencyMs` (5 s by
  default) it **holds**, rechecking every 10 s; while merely slow it eases off between files. The
  log says `address index build: paused while the node's RPC is answering in N s` and `resumed`.
  A build that is paused most of the time means the node cannot keep up with the monitor and the
  build together on that disk: fewer workers, or a node tuned as in
  [INSTALL](INSTALL.md#bitcoinconf-settings-worth-having), or let it run overnight.
- **The ETA is wrong at first** — it is computed from the files done so far in the current phase
  and settles after the first few; files are not all the same size.
- **It stopped one short — "scan 5,720 of 5,721, about 1 s left" for an hour** — a worker
  died, most likely killed for memory (four workers is about 10 GB beside the node). Since
  2026-09-15 that fails the build at once with `an index worker exited with code N while on
  {"type":"scan","file":...}` and the flag turns to *build failed*; before that fix the build
  hung there for good. Either way: restart BlockYard with fewer workers (`addressIndexWorkers` on
  the node entry in `config/local.json`). The build starts over; it is not resumable. The flag
  also says **no progress for N min** whenever nothing has moved for two minutes, so a stall is
  visible as one rather than as a stale ETA.
- **Hours, not minutes** — expect **a few hours**: 29 min 45 s is 16 workers on NVMe, and four
  workers (the installer's default) are roughly four times slower; **spinning disks** are slower still whatever the
  number, and there one worker is the fast setting, because parallel readers only seek against
  each other and against the node. Set `addressIndexWorkers` on the node entry in
  `config/local.json` (the installer writes the number you gave it) and restart: there is no
  resume, so the build starts over from the first file.
- **It started over** — stopping BlockYard stops the build, and the next start begins it again
  from scratch. Leave it running until the notification says it is done.
- **the address index build failed** — the reason is in the events feed and the log; fix it and
  restart (the server builds again), or run `node scripts/index-build.js --out <dir>` by hand.
  A pruned node, unreadable block files and a full disk are the usual causes.

## "getrawmempool verbose dropped as stale" in Events, and the mempool panels look old

The monitor keeps one RPC request in flight and serves the live polls first; the full-pool poll is
the lowest priority, so when the node's RPC is slow it waits behind them and, past its freshness
budget, is dropped rather than shown as current. A streak of drops is one warning event when it
starts, a counter on **Node & RPC → data quality** while it lasts, and one event when the poll
answers again with the count and the span. The Mempool, Block space and Mining panels show their
last reading meanwhile and say how old it is.

The cause is the node, not the monitor: look for what else is asking it. On 2026-09-15 an Umbrel
node answered in seconds for thirteen hours while another BlockYard built its address index
against it over the LAN, and the drops stopped the moment that build finished. A remote index
build, a wallet rescan, `gettxoutsetinfo` from another tool, or an initial block download all
show the same way.

## Markets or Kiosk show no prices

- **"market polling is off"** — the default. Tick **Display settings → Markets & Price → Enable market polling**.
- **"market data is off on this server"** — `BLOCKYARD_MARKETS=0` or `markets.enabled: false` is set on the server; the checkbox cannot override it.
- **"asking the exchanges…" for a long time** — the server cannot reach the exchanges. Test
  from the server: `curl -sI https://api.exchange.coinbase.com/products/BTC-USD/ticker`. Check
  outbound firewall rules and DNS.
- Market data is only fetched while the Markets, Kiosk or Overview tab is open; the first prices take a
  few seconds, the order-book depth up to half a minute.

## An exchange shows an error

The exchange table shows each exchange's last error next to its row.

| error | meaning |
|---|---|
| `HTTP 451` | the exchange refuses requests from your region. |
| `HTTP 429` | the exchange is rate-limiting this address; the monitor retries on its next cycle. |
| `fetch failed` | a network error reaching that exchange (DNS, firewall, or no route over IPv6 while IPv4 works). The monitor already allows slow connection set-up; persistent failures are usually a firewall. |

A failing exchange is left out of the median and the spread; the others keep working.

## Explorer: a transaction id is not found

The explorer asks the node for `getrawtransaction <txid> 2` with no block hash. A node without a
transaction index can only answer that for transactions still in its **mempool**, so a confirmed
transaction looks missing even though the node is healthy and fully synced. Block pages are
unaffected — they pass the block hash, so the node can find the transaction without an index.

Set `txindex=1` in `bitcoin.conf` and restart the node. Adding it to a node that has been running
without one triggers a one-off reindex; `getindexinfo` reports progress and says `"synced": true`
when it is done:

```bash
bitcoin-cli getindexinfo
```

## Explorer: address pages read "not indexed"

**Bitcoin Core has no address index at any setting, and this is not something you have
misconfigured.** `getaddressbalance` and `getaddresstxids` are insight-style extensions that only
forks carry; stock Core answers `Method not found` (measured 2026-09-13 on two Core nodes). There is no node option to enable.

BlockYard builds its own index from the node's block files instead — about 30 minutes on 16
workers and 124 GB of disk for the whole chain — and the server keeps it current as blocks
arrive. It builds it **by itself, in the background**, when it starts with an `addressIndex`
directory that holds no index (the installer's default); while that runs the address page says
*the address index is being built* with the progress, and fills in when it is done. So *not
indexed* with no build in progress means one of:

- no `addressIndex` directory on the node entry in `config/local.json` — `npm run setup` writes
  one (`data/index` by default), or add it by hand and restart;
- `addressIndexBuild: "manual"` on the node entry (the installer's **(l)ater** answer) — run
  `node scripts/index-build.js --out <dir>` and restart, or remove the key and restart;
- the build failed — the reason is in the events feed and the log (see
  [above](#the-address-index-build-is-paused-or-slow)).

[Building the address index](INSTALL.md#building-the-address-index) has the details.

Until then the address page confirms the address and its type (`validateaddress` needs no
index) and marks balance, totals and history as **not indexed**. It does not report a
transaction count of `0` — nothing counted — and it does not print the node's error where a
figure belongs.

## Explorer: the address page says the index is behind, or has stopped following

**Behind** by a block or two is normal: the follower polls every 30 s and fetches each new block
with `getblock <hash> 3`; it was measured reaching a new block 16 s after the node. An index
built a while ago catches up 50 blocks a poll. Behind by many blocks and not closing the gap means
the follower is failing: usually because `live.log` and `layers/` live **inside the index
directory**, which must be writable by the service user. A follower that cannot open its index
is reported in the server log at boot (`address index <dir>: ...`); one whose poll fails keeps
retrying every 30 s. `npm run check` reports how far behind the index is and whether the
directory is writable.

**Stopped following** means a reorganisation deeper than the blocks the follower still holds in
its tail (100), which cannot be repaired in place. Stop the server and either delete the index
directory (the server builds it again on the next start) or run the same `index-build.js`
command into the same directory — the build empties it first, the old log and layers included —
and start the server again.

## Explorer: "spent by" links are missing

"Spent by" links come from `gettxspendingprevout`, which Bitcoin Core (24.0 and later) answers
from its **mempool** only: an output spent by a transaction that is still unconfirmed gets a link,
an output spent in a block does not, and there is no node index to turn on for that. Looking up
an arbitrary historical transaction by id is a different matter — that needs `txindex` (see
[above](#explorer-a-transaction-id-is-not-found)).

## Explorer: no dollar figures

Dollar amounts appear only when a spot price is available within a moment of loading the page:
from a fresh Markets feed, or from one quick ticker request. With market data off, or with the
exchanges unreachable, pages show BTC figures only — never a guessed price.

## The 3D views are slow or blank

- **Slow** — the dense viewer mode (**Detailed**) draws thousands of tiles; on an old
  or GPU-less machine switch the Block space viewer to **Simple** in its control bar.
  The Markets board keeps animating while visible (for its star field); switching to another
  tab stops it.
- **No motion** — the browser or operating system has "reduce motion" on; the views then draw
  without animation, by design.
- **Blank** — reload the page. If it stays blank, open the browser console and look for errors;
  a stale cached front-end after an update is the usual cause, and the header shows a notice
  when the page is older than the server.

## Full screen does not work on the Kiosk

Browsers allow full screen only after a click on the page, and some embedded or kiosk-mode
browsers refuse it entirely. Use the browser's own full-screen key (F11) instead, or start the
browser in kiosk mode pointed at `http://<host>:21000/#kiosk`.

## Sign-in problems

- **Lost the admin password** — `node scripts/manage-users.js passwd admin` on the server.
- **"too many attempts"** — the lockout lasts 10 minutes per username and per address.
- **Sign-in does not stick** — over plain HTTP, make sure `BLOCKYARD_SECURE_COOKIE` is not set
  (a `Secure` cookie is never sent over HTTP). Behind a TLS proxy, set it.
- **The browser warns about the certificate** — expected once per address: the monitor's own
  certificate is self-signed. Compare the fingerprint in the start-up log with the browser's,
  then accept it. To be rid of the warning, name a certificate of your own (INSTALL §9) or put
  a proxy with a real one in front (§10).
- **`https://` says the connection was reset, or `http://` shows nothing** — the port speaks
  one or the other: HTTPS unless `BLOCKYARD_TLS=0`. Use the scheme the start-up log prints.

## Tests fail on a fresh clone

- Use Node 22 or later (`node -v`).
- The suite is hermetic — it does not read `config/local.json` and needs no node — but a few
  tests boot servers on local ports; make sure nothing else holds them.
- Timing-sensitive tests can fail on a heavily loaded machine; run the suite again.
