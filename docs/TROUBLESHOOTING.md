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
- [Explorer: address pages or "spent by" are missing](#explorer-address-pages-or-spent-by-are-missing)
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
initial sync) shows fewer updates rather than being slowed further. If latency stays high,
check the node's own load; the monitor never runs more than one request at a time.

## Markets or Kiosk show no prices

- **"market data is off"** — `BLOCKYARD_MARKETS=0` or `markets.enabled: false` is set.
- **"asking the exchanges…" for a long time** — the server cannot reach the exchanges. Test
  from the server: `curl -sI https://api.exchange.coinbase.com/products/BTC-USD/ticker`. Check
  outbound firewall rules and DNS.
- Market data is only fetched while the Markets or Kiosk tab is open; the first prices take a
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

## Explorer: address pages or "spent by" are missing

Address pages need the node's address index, and "spent by" links need its spent-output
index. Without them the explorer says the index is unavailable instead of showing an empty
balance. Looking up an arbitrary historical transaction by id needs the transaction index;
without it only mempool and recently seen transactions resolve.

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
