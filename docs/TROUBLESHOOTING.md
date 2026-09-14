# Troubleshooting

The monitor tries to explain itself: the start-up log, the header badges and the **Node &
RPC** page usually name the problem. This page collects the cases people actually hit.

- [The service does not start](#the-service-does-not-start)
- [A node shows offline](#a-node-shows-offline)
- [The page does not load from another machine](#the-page-does-not-load-from-another-machine)
- [The header says "stale" or "reconnecting"](#the-header-says-stale-or-reconnecting)
- [The node's RPC is slow](#the-nodes-rpc-is-slow)
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

## The node's RPC is slow

The Node & RPC page shows RPC latency and the queue. When the node is slow the monitor
stretches its polling automatically and skips heavy reads, so a busy node (for example during
initial sync) shows fewer updates rather than being slowed further.

The monitor runs **one** request at a time, always. `rpc.maxInFlight` exists in the config and
is reported by `/api/config`, but the lane is serialised by construction and does not read it --
measured 2026-09-13 at 1, 4 and 8: four 200 ms jobs took ~807 ms with peak concurrency 1 in every
case. Treat it as documentation of intent, not a tuning knob.

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

## Markets or Kiosk show no prices

- **"market data is off"** — `BLOCKYARD_MARKETS=0` or `markets.enabled: false` is set.
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
cores and 124 GB of disk for the whole chain — and the server keeps it current as blocks arrive.
Build it and name the directory as `addressIndex` in the node's config:
[Building the address index](INSTALL.md#building-the-address-index).

Until then the address page confirms the address and its type (`validateaddress` needs no
index) and marks balance, totals and history as **not indexed**. It does not report a
transaction count of `0` — nothing counted — and it does not print the node's error where a
figure belongs.

## Explorer: the address page says the index is behind, or has stopped following

**Behind** by a block or two is normal: the follower polls every 30 s and fetches each new block
with `getblock <hash> 3`; it was measured reaching a new block 16 s after the node. Behind by
many blocks means the follower is failing: usually because `live.log` and `layers/` live **inside
the index directory**, which must be writable by the service user. A follower that cannot open
its index is reported in the server log at boot (`address index <dir>: ...`); one whose poll fails
keeps retrying every 30 s.

**Stopped following** means a reorganisation deeper than the blocks the follower still holds in
its tail (100), which cannot be repaired in place. Stop the server, run the same `index-build.js` command into the same directory — the build
empties it first, the old log and layers included — and start the server again.

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

## Tests fail on a fresh clone

- Use Node 22 or later (`node -v`).
- The suite is hermetic — it does not read `config/local.json` and needs no node — but a few
  tests boot servers on local ports; make sure nothing else holds them.
- Timing-sensitive tests can fail on a heavily loaded machine; run the suite again.
