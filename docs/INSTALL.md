# Installing BlockYard

This guide takes you from nothing to a monitor running as a service, reachable from the
machines you choose. Every setting mentioned here is described in full in
[CONFIGURATION.md](CONFIGURATION.md).

- [1. Requirements](#1-requirements)
- [2. Get the code](#2-get-the-code)
- [3. Try it without a node](#3-try-it-without-a-node)
- [4. Point it at your node](#4-point-it-at-your-node)
- [5. First run](#5-first-run)
- [6. Run it as a service](#6-run-it-as-a-service)
- [7. Decide who can reach it](#7-decide-who-can-reach-it)
- [8. Accounts (on by default)](#8-accounts-on-by-default)
- [9. HTTPS (on by default)](#9-https-on-by-default)
- [10. Behind a reverse proxy (optional)](#10-behind-a-reverse-proxy-optional)
- [11. Updating](#11-updating)
- [12. Uninstalling](#12-uninstalling)
- [Checklist](#checklist)

## 1. Requirements

| need | notes |
|---|---|
| **Node.js 22.2 or newer** | `node -v` must print `v22.2` or later (the index build uses its built-in CRC-32). Older runtimes fail on syntax at start-up, which looks like a bug in the app. Install from [nodejs.org](https://nodejs.org), your distribution's backports, or a version manager such as `nvm`. |
| **Bitcoin Core 25.0 or later** | [Bitcoin Core](https://github.com/bitcoin/bitcoin) with `server=1` and `txindex=1`, **on the same machine** as BlockYard, which reads the node's block files for the explorer's address index. A node on another machine is not supported. 25.0 is where `getblock` verbosity 3, which the index follower uses, arrived; 29.1 is what the macOS install was done against. `coinstatsindex=1` is optional (without it the UTXO figures are blank and the node is not asked for them). Not a pruned node: the index needs every block file. |
| **RPC credentials** | Either read access to the node's cookie file (`<datadir>/<chain>/.cookie`, the usual case on the same machine) or an RPC user and password. |
| **macOS or Linux** | There is nothing to compile, and the server calls no platform-specific API (no `child_process`, no `/proc`, no `systemctl`). Developed on Linux; a real install has been done on macOS (Core 29.1). The test suite runs in CI on Ubuntu, macOS and Windows (Node 22 and 24), but on Windows nothing more than the suite has been tried. Only the *service* instructions in section 6 are Linux-specific (they use systemd); on macOS run it in a terminal, or write a `launchd` plist. The index store opens its files per lookup, so macOS's default limit of 256 open files is enough. |
| **Disk** | About **125 GB** for the address index (124 GB measured at height 966,930, growing ~55 MB a day), on top of the node's own ~875 GB of block files, which the build reads once. A different disk from the node's is best. A few hundred MB besides for history, sessions and the audit trail (`./data` by default). |
| **Memory** | About 2.5 GB per index-build worker while the build runs (four by default); little after. |
| **A modern browser** | Any current Chrome, Edge, Firefox or Safari. The 3D views use a 2D canvas and run without WebGL; a GPU helps with the dense viewer mode. |

### Node indexes

**`txindex=1` is required for the explorer's transaction pages.** A transaction page asks the node
for `getrawtransaction <txid> 2` with no block hash, and a node without a transaction index can
only answer that for transactions still in its mempool — so without it, looking up a confirmed
transaction by id fails even though the node is perfectly healthy. Set it in `bitcoin.conf`:

```
txindex=1
```

Adding it to a node that has been running without it triggers a one-off reindex, which takes a
while and is unavoidable; the node reports progress, and `getindexinfo` tells you when it is
`synced`. Everything else in the monitor — the dashboard, block space, mempool, fees, peers,
mining, the block pages — works without it.

Two further points affect the explorer:

- an **address index** — address pages (balance, received, sent, transaction history). **Bitcoin
  Core does not have one, at any setting**, so there is no flag here to turn on: `getaddressbalance`
  and `getaddresstxids` are insight-style extensions carried by forks such as Bitcore, and stock
  Core answers `Method not found` (measured 2026-09-13 against two Core nodes). **BlockYard builds its own** from the node's block files — see
  [Building the address index](#building-the-address-index) below. Without one, the address page
  still confirms an address and its type (`validateaddress` needs no index) and marks balance and
  history as *not indexed*. Searching by transaction id or block is unaffected: that uses
  `txindex` above.
- **"spent by" links** come from `gettxspendingprevout`, which Core (24.0 and later) answers from
  its **mempool** only: an output spent by an unconfirmed transaction is linked, one spent in a
  block is not, and there is no index to turn on for that.

Pages that need an index the node does not have say so, rather than showing empty data.

### Building the address index

**By default BlockYard builds it itself**, in the background, the first time it starts with an
`addressIndex` directory that holds no index. The build runs on worker threads inside the server
while every page keeps working: the Overview's "What this panel cannot tell you" box shows the
progress (phase, files done, rows so far, an ETA that settles after the first few files), the
address page says the same in place of a history, and an event — which the browser shows as a
notification — marks the start, the finish and a failure. When it finishes the follower starts
on the spot, so address pages work without a restart. Stopping BlockYard stops the build, and the
next start resumes it: the files already scanned and the buckets already sorted are kept, and
only what was not finished is read again (at most about a minute of scanning). Three keys on the
node entry control it:

| key | meaning |
|---|---|
| `addressIndex` | the index directory (the installer's default is `data/index` inside the checkout) |
| `addressIndexWorkers` | how many worker threads the build uses; the installer writes the number you gave it (default 4, never more than 4 by default). Without the key the server uses half of what a dedicated build would, at most four |
| `addressIndexBuild: "manual"` | do not build automatically; the installer's **(l)ater** writes this. Run the command below yourself and restart |

**The build is paced by the node.** Its workers read the block files the node is also reading,
so before each file it looks at the monitor's own RPC telemetry: while the node's RPC is failing
or averaging above the monitor's slow threshold (`rpc.slowLatencyMs`, 5 s by default) it holds,
checking every 10 s; while merely slow it eases off. The progress line and the log say when it is
paused and when it resumed. The build's own RPC calls (cheap: block hashes for the height table)
go over a second connection so they are not queued behind the monitor's mempool and block reads.
On **spinning disks** use one worker (`addressIndexWorkers: 1`, or answer 1 to the installer):
parallel readers only seek against each other and against the node, and the build takes hours
there whatever the number.

The index is built once from the node's own `blocks/blk*.dat` and `rev*.dat` files, so the
build needs to run **on a machine that can read the node's data directory** -- the node's own
machine, which is where BlockYard runs. After that the server keeps it current over RPC.

**Expect the build to take a few hours** — about two on the installer's default of four workers on NVMe, longer on spinning disks — during which every other page works and address pages show the build's progress in place of a history.

What it costs, measured on the full chain at height 966,930 (`docs/MEASUREMENTS.md` §30):
**29 min 45 s** with 16 workers on NVMe (7.8 CPU-hours; peak 30 GB of memory, so about 2.5 GB
per worker), and **124 GB** of disk for 5.89 billion 21-byte rows, one per (address, transaction)
with the net amount, so a balance is a sum and never a node call; it grows about 55 MB a day. It
stores no transactions — `txindex` does that — which is why it is a tenth the size of
mempool.space's `electrs` (1.3 TB, hours to build). Put it on a different disk from the block
files if you can; the build reads ~880 GB once.

To build by hand (the installer's **(h)ere** runs the same build in the terminal, with the same
pacing):

```bash
node scripts/index-build.js --out data/index --workers 4
```

Progress goes to stderr once a second; the manifest, with every phase's timings, to stdout at
the end. Each worker holds its file pair and a row buffer, so memory scales with `--workers`
(the 16-worker build above peaked at 30 GB): on a 16-32 GB machine use `--workers 4`, which
takes roughly four times as long. The block files are found through the node's `datadir` in
`config/local.json` (`<datadir>/blocks`), so that must be set -- on macOS Core's default is
`~/Library/Application Support/Bitcoin`. Then name the directory in the node's config and restart:

```json
{
  "nodes": [
    { "id": "main", "...": "...", "addressIndex": "/opt/blockyard/data/index", "addressIndexWorkers": 4 }
  ]
}
```

One index serves every node on the same chain. The server starts a follower per directory,
which polls every 30 s, fetches each new block with `getblock <hash> 3` (up to 50 blocks a poll
when catching up), and writes `live.log` and `layers/` **inside the index directory — so it must
be writable by the service user**. A restart replays the log; a reorganisation rolls the tail
back; blocks 100 deep are folded into sorted layers. The address page says when the index is
behind the node or has stopped following, and rows above the node's current tip are never shown
as history. A reorganisation deeper than the tail it holds (100 blocks) cannot be repaired in
place: the page says to rebuild: stop the server, run the same command again (or delete the
directory and let the server build it), start it. **The build empties `--out` first**, the
follower's log and layers included, so nothing of the old index survives it (tested in
`test/chain-index-live.test.js`).

What the address page shows from it: the history, the balance, received and sent (each
transaction's net for the address), and — for an address with up to 100 transactions — its
unspent outputs, checked one by one against the node's `gettxout`; a longer history gets a note
instead. Not yet: an address's mempool transactions.

Balances are checked against the node: 40 of 40 sampled addresses equal `scantxoutset` to the
satoshi (`node scripts/index-benchmark.js` runs that check and the lookup timings against your
own build).

**Outbound network access**: none, out of the box — everything talks only to your node. The
Markets and Kiosk tabs and the explorer's dollar figures need the exchange feed (HTTPS to five
exchanges' public APIs), which is off until you tick **Display settings → Markets & Price → Enable market polling**
in the browser. See [SECURITY.md](SECURITY.md#outbound-connections).

## 2. Get the code

```bash
git clone https://github.com/BobClawblaw/blockyard.git
cd blockyard
```

There is **no `npm install`** — the project has no dependencies. Optionally confirm your
runtime is good:

```bash
npm test
```

**Or, from the published package, no checkout at all:**

```bash
npm install -g blockyard
blockyard          # with no command, prints the command list, the version, and where it keeps state
```

This installs the read-only edition (the same one `npm pack` produces from this checkout; the
administrative suite never ships — see the top of [AGENTS.md](../AGENTS.md) if you're reading the
source). A global install has no `config/` or `data/` directory of its own to live in, so it keeps
both under `~/.blockyard` (`local.json` for the config, `data/` for state and the address index)
unless `BLOCKYARD_HOME`, `BLOCKYARD_CONFIG` or `BLOCKYARD_DATA` say otherwise. Every command below
that reads `npm run <x>` in a checkout is `blockyard <x>` here instead:

| checkout | npm install -g |
|---|---|
| `npm run setup` | `blockyard setup` |
| `npm start` | `blockyard start` |
| `npm run check` | `blockyard check` |
| `node scripts/index-build.js …` | `blockyard index-build …` |
| `node scripts/manage-users.js …` | `blockyard users …` |
| — | `blockyard tls` (remake the self-signed certificate; `--san` to add names) |

There is no `blockyard dev` (the fake-node demo) or `blockyard smoke` — both are checkout-only,
for working on the code itself. The rest of this document is written for a checkout; substitute
the table above and `~/.blockyard` for `config/`/`data/` as you go.

**`blockyard: command not found` right after `npm install -g`?** The install worked; npm's global
`bin/` directory isn't on your `PATH`. Find where npm actually put it and compare against your
shell's `PATH`:

```bash
npm config get prefix        # global installs go under <prefix>/bin
echo $PATH
```

If `<prefix>/bin` isn't in that list, either add it (`echo 'export
PATH="$(npm config get prefix)/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc`) or, better, find out
*why* npm's prefix isn't one of the normal ones already on your `PATH` (Homebrew's, nvm's,
`/usr/local`, or a deliberate no-`sudo` choice like `~/.local` with `~/.local/bin` already on
`PATH`) — `npm config list -l | grep prefix`, and check for a stray `prefix=` in `~/.npmrc` or an
`NPM_CONFIG_PREFIX` in a shell rc file. A non-default prefix is not itself a problem — only one
that lands outside every `PATH` your shells actually load is. A correctly configured npm needs
none of this: a plain `npm install -g blockyard` followed by `blockyard setup` is the whole
install.

**Without `-g`** (`npm install blockyard`): the package lands in `node_modules/` in whatever
directory you run it from, not on your `PATH` — a local install never touches `PATH`, on any OS.
Running the plain `blockyard` command in your shell afterwards fails with "command not found";
`npx` is what knows to look in `./node_modules/.bin` first, so use it in front of every command:

```bash
mkdir blockyard && cd blockyard
npm install blockyard
npx blockyard setup      # not "blockyard setup" -- npm never put it on PATH
npx blockyard start
```

(`./node_modules/.bin/blockyard setup` works too, without `npx`, if you'd rather spell it out.)
It still keeps its config and data under `~/.blockyard` by the same rule above — a local install
changes nothing about *where the package runs from*, only how you invoke it.

See [Uninstalling](#12-uninstalling) for removing a global install, and
[Updating](#11-updating) for `npm update -g blockyard` in place of `git pull`.

## 3. Try it without a node

```bash
npm run dev
```

This starts the monitor on <https://127.0.0.1:18088> (with its own self-signed certificate, as in
section 9) against a built-in fake node that
simulates a node syncing, with no configuration file read. It is the quickest way to see
every page, and it is what the test suite uses. Stop it with `Ctrl-C`.

## 4. Point it at your node

**The short way:** `npm run setup` asks for the node's data directory first and reads its
`bitcoin.conf` (chain, `rpcport`, `rpcconnect`, `rpcuser`/`rpcpassword`, `rpcauth` users, a cookie
file elsewhere, `server=`, `txindex=`, `prune=`, chain sections, `includeconf=`), so the RPC URL
and credentials arrive as defaults; checks them against the node (RPC, credentials, chain,
`txindex`, `getblock 3`, a verbose mempool read, the block files, the log -- every call timed);
asks bind address, port, index directory and workers; writes `config/local.json`; and lets
BlockYard build the address index in the background when it starts --
[GETTING-STARTED.md](GETTING-STARTED.md). What follows is the same configuration by hand, and
what each key means.

Create `config/local.json` (it is git-ignored, so your settings never end up in a commit).

**Same machine, cookie authentication** — the common case. The monitor finds the cookie
at `<datadir>/<chainHint>/.cookie`:

```json
{
  "nodes": [
    {
      "id": "main",
      "label": "My node",
      "rpcUrl": "http://127.0.0.1:8332",
      "datadir": "/home/you/.bitcoin",
      "chainHint": "main",
      "addressIndex": "/home/you/blockyard/data/index",
      "addressIndexWorkers": 4
    }
  ]
}
```

**User/password authentication** -- a node that uses `rpcauth` instead of the cookie file. Keep
`datadir`: the block files are still read from it.

```json
{
  "nodes": [
    {
      "id": "main",
      "label": "My node",
      "rpcUrl": "http://127.0.0.1:8332",
      "datadir": "/home/you/.bitcoin",
      "rpcUser": "monitor",
      "rpcPassword": "a long random password"
    }
  ]
}
```

Use the RPC port your node is configured with (`rpcport` in its configuration file; Core's
mainnet default is 8332). Any value you set in `config/local.json` or in the environment
overrides the built-in defaults.

#### It runs on the node's machine

BlockYard is installed **on the machine that runs Bitcoin Core**, and nowhere else. The explorer's
address index is built from the node's own block files (`<datadir>/blocks`), the way
mempool.space's `electrs` does it ([Building the address index](#building-the-address-index)),
because Core cannot answer an address's history over RPC at any setting. A node on another
machine is **not supported**: reading one over RPC alone was tried (2026-09-13) and dropped --
real-time explorer data over RPC was a failed idea.

`rpcUser` / `rpcPassword` are still accepted, for a node that authenticates with `rpcauth` rather
than the cookie file (see [Configuration](CONFIGURATION.md#nodes)). The web UI's node-connection
form takes no password on purpose -- taking one over a web endpoint is not something to add
quietly -- so credentials go in `config/local.json`.

##### `bitcoin.conf` settings worth having

```conf
txindex=1              # required for the explorer's transaction pages
coinstatsindex=1       # the Chain page's UTXO figures; rebuilds from genesis, which takes hours
dbcache=4096           # or what the machine can spare: the expensive reads are disk-bound
rpcservertimeout=120   # keeps the node from closing a connection under a slow call
```

| line | what it does for this monitor |
|---|---|
| `txindex=1` | **Required** for the explorer's transaction pages. Without it a confirmed transaction cannot be looked up by id. |
| `coinstatsindex=1` | **Optional.** The Chain page's UTXO figures come from `gettxoutsetinfo muhash`; unindexed, that call walks the whole UTXO set (41 s measured), so on a node that reports no synced `coinstatsindex` the monitor does not ask for them at all, leaves the figures blank and flags `utxo-unindexed`. The index **rebuilds from genesis** and takes hours -- until it finishes those figures stay unavailable and the rebuild competes with everything else for the disk. |
| `dbcache=4096` | Measured 2026-09-13 on one Core 31.1.0 node that shipped with 450 MB: raised to 4096 together with the RPC settings here, the slowest call went from 4.0-4.5 s to 488-565 ms and the monitor's lane stopped timing out. Which line deserved the credit was not isolated, so they are recommended together. |
| `rpcservertimeout=120` | The monitor's own ceilings are 90 s ordinary / 300 s heavy, so this only matters on a heavily loaded node. |
| `rpcthreads`, `rpcworkqueue` | **Not for us:** this monitor has at most `rpc.maxInFlight` calls in flight (four by default). That matches Core's default of four RPC threads, so raising them does not speed the monitor up. They matter where other software (Electrs, LND) shares the same bitcoind. |
| `rest=1` | **Nothing.** This monitor makes no REST calls; it is JSON-RPC only. |

Restart the node after changing these: `bitcoin.conf` is read at start-up. `peerinfo-partial` is
normal on Core -- bytes from peers that have since disconnected remain in `getnettotals` but
leave no per-peer row, so the two do not sum. **Log parsing does not support Core** (see below);
leave the log source off, nothing in the UI depends on it.

**Several nodes** — add more entries to `nodes`; a node picker appears in the header and
every chart, table and stream is per node.

**The node's log.** The monitor works from RPC alone, and that is the supported mode.
**Log parsing does not currently support Bitcoin Core**: the parsers were written against an
experimental node with a different log grammar, and fed real Core `debug.log` lines they
extract no figures and misdate the entries (measured 2026-09-13). Leave `log.enabled` off --
it is off by default -- and ignore `logFile`. Nothing is lost on Core: `getnettotals` and per-peer
byte counts are served over RPC (verified 2026-09-13). The Node & RPC page
lists exactly which figures each source provides.

## 5. First run

```bash
npm run check       # every configured node: RPC, credentials, txindex, getblock 3, mempool, block files, index -- every call timed
npm start
```

Watch the start-up lines. You should see `listening on https://127.0.0.1:21000` (the first start
makes the monitor its own self-signed certificate under `data/tls/`; the browser warns once per
address and remembers it), a line per node, and — because accounts are on by default — `created
the first admin account (admin)` with a generated password **shown once** (set
`BLOCKYARD_ADMIN_PASSWORD` before the first start to choose it; `blockyard user` changes it
later). If the node entry names an `addressIndex` directory with no index in it, `address index:
building … with N workers -- the Overview shows the progress` follows, and the build runs on in
the background (see [Building the address index](#building-the-address-index)). Then open
<https://127.0.0.1:21000> and sign in.

Check it from the shell (`-k`, because the certificate is self-signed):

```bash
curl -sk https://127.0.0.1:21000/api/health
```

If a node shows as offline, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#a-node-shows-offline).

## 6. Run it as a service

> **macOS:** this section is Linux/systemd. On a Mac, either leave `npm start` running in a
> terminal, or wrap it in a `launchd` plist -- there is no other platform-specific step, and the
> configuration in section 4 is identical.

1. **Create an account for it** that can read the node's cookie and its `blocks/` directory
   (the index is built from the block files), and that can write the index directory. Usually
   that means adding it to the node's group:

   ```bash
   sudo useradd --system --home /opt/blockyard --shell /usr/sbin/nologin blockyard
   sudo usermod -aG <node-group> blockyard
   ```

2. **Put the code somewhere stable**, for example `/opt/blockyard`, owned by that account:

   ```bash
   sudo git clone https://github.com/BobClawblaw/blockyard.git /opt/blockyard
   sudo cp config/local.json /opt/blockyard/config/   # the file from step 4
   sudo chown -R blockyard:blockyard /opt/blockyard
   ```

3. **Install the unit** shipped in `systemd/blockyard.service` and edit it:

   ```bash
   sudo cp /opt/blockyard/systemd/blockyard.service /etc/systemd/system/
   sudo systemctl edit --full blockyard
   ```

   Set `User=` / `Group=` to the account from step 1, `WorkingDirectory=` to where the code
   lives, the two `ReadWritePaths=` lines to that directory's `data` and `config` (and add one for
   your address index directory; the unit makes everything else read-only to the service), and replace the `Environment=` lines that name paths with your own (or delete
   them and keep everything in `config/local.json`). Point `ExecStart` at an absolute Node
   22 binary — `/usr/bin/env node` can resolve to an older system Node under systemd:

   ```ini
   ExecStart=/usr/local/bin/node server/main.js
   ```

4. **Start it:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now blockyard
   journalctl -u blockyard -f
   ```

The unit restarts the monitor if it ever exits and gives it time to save its history on
shutdown. Stop and start with `systemctl stop|start blockyard`.

## 7. Decide who can reach it

Where the monitor listens is a security decision. Set `server.host` in `config/local.json`
(a string or a list) or `BLOCKYARD_BIND`:

| bind | who can connect | typical use |
|---|---|---|
| `"127.0.0.1"` (the default) | this machine only | reach it with an SSH tunnel: `ssh -L 21000:127.0.0.1:21000 you@host` |
| `"192.0.2.10"` (a LAN address) | anything that can route to that address | a home or office LAN |
| `["192.0.2.10", "198.51.100.7"]` | exactly those addresses | LAN plus a VPN such as Tailscale or WireGuard |
| `"0.0.0.0"` | every interface | behind a firewall you control |

Notes:

- Binding a single LAN address means `127.0.0.1` on the host itself stops answering — test
  with the address you bound.
- An address the machine does not have at start-up is skipped with a warning; start-up fails
  only if none of the listed addresses exist.
- A bind chooses a destination address, not an incoming interface. If "LAN only" must hold
  against containers or tunnels on the same host, add a firewall rule, for example:

  ```bash
  sudo ufw allow from 192.0.2.0/24 to any port 21000 proto tcp
  ```

- `server.allowCidrs` (or `BLOCKYARD_ALLOW_CIDRS=192.0.2.0/24,2001:db8::/32`) makes the
  monitor itself refuse clients outside those networks, as a second line of defence.

## 8. Accounts (on by default)

Sign-in is required out of the box. The first start with an empty data directory creates an
`admin` account and prints its password **once** in the log (under systemd: `journalctl -u
blockyard`). Set your own instead with `BLOCKYARD_ADMIN_PASSWORD` for that first start.

To open the monitor to readers with no account, set `"auth": { "enabled": false }` or
`BLOCKYARD_AUTH=0` and restart: anyone who can reach the port then reads it as a `viewer` —
charts, the explorer, the event stream, the read-only RPC console — while user
administration, the audit trail and every node write stay closed. The boot log names the
addresses that leaves readable.

Manage accounts from the Admin page, or from the shell — for example, to reset the admin
password:

```bash
node scripts/manage-users.js passwd admin
```

Roles: `viewer` reads; `operator` may also run node actions that you have enabled; `admin`
also manages users and reads the audit trail. Node actions are off unless you enable them
explicitly — see [SECURITY.md](SECURITY.md#node-writes).

## 9. HTTPS (on by default)

Every listener serves HTTPS out of the box. With no certificate of your own named, the first
start makes one: a self-signed certificate and key under `<data>/tls/` (`data/tls/cert.pem` and
`key.pem`, the key readable by the service account only), naming the addresses the monitor is
reached on — the bound hosts, this machine's addresses and hostname, `localhost`. It is remade
by itself when it nears expiry (825 days) or stops naming a bound address. Browsers warn once
per address about a self-signed certificate and then remember it; the start-up log prints its
fingerprint so you can compare.

To add a name or address (say, a DNS name you gave the machine) or start over:

```bash
blockyard tls --san monitor.lan.example        # or: node scripts/tls.js --san ...
blockyard tls --force                          # a fresh key and certificate
blockyard tls --print > blockyard.crt          # the certificate, for another machine's trust store
```

To use a certificate of your own instead, name it and every listener serves that:

```bash
BLOCKYARD_TLS_CERT=/etc/blockyard/cert.pem BLOCKYARD_TLS_KEY=/etc/blockyard/key.pem npm start
```

or in `config/local.json`: `"server": { "tls": { "cert": "...", "key": "..." } }`. To serve plain
HTTP — behind a reverse proxy that terminates TLS (section 10) — set `BLOCKYARD_TLS=0` or
`"server": { "tls": { "enabled": false } }`.

If you would rather make the certificate with openssl yourself:

```bash
sudo mkdir -p /etc/blockyard
sudo openssl req -x509 -newkey rsa:3072 -nodes -days 825 \
  -keyout /etc/blockyard/key.pem -out /etc/blockyard/cert.pem \
  -subj "/CN=blockyard" -addext "subjectAltName=IP:192.0.2.10,DNS:blockyard.lan.example"
sudo chown blockyard:blockyard /etc/blockyard/*.pem && sudo chmod 600 /etc/blockyard/key.pem
```

With TLS on, the session cookie is marked `Secure` and a short HSTS header is sent. A
half-configured pair (only a cert, or only a key) and an expired certificate stop the start-up
rather than silently serving plain HTTP.

## 10. Behind a reverse proxy (optional)

If you already run nginx, Caddy or similar, bind the monitor to `127.0.0.1`, set
`BLOCKYARD_TLS=0` so it speaks plain HTTP to the proxy, and let the proxy terminate TLS. The live stream (`/api/stream`) is Server-Sent Events, so the proxy must not
buffer it. An nginx example:

```nginx
server {
    listen 443 ssl;
    server_name monitor.example.org;
    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:21000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location /api/stream {
        proxy_pass http://127.0.0.1:21000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

Then set `"server": { "trustProxy": true }` so the monitor uses the forwarded client
address for rate limits and the CIDR gate, and `BLOCKYARD_SECURE_COOKIE=1` so the session
cookie is marked `Secure` behind the proxy's TLS.

## 11. Updating

```bash
cd /opt/blockyard
sudo -u blockyard git pull
sudo systemctl restart blockyard
```

**Installed from npm:** `npm update -g blockyard` (or `npm install -g blockyard@latest`), then
restart it (`blockyard start`, or your service's restart command). `~/.blockyard` is untouched.

Your `config/local.json` and `data/` directory are untouched by updates. Read
[CHANGELOG.md](../CHANGELOG.md) for anything that needs your attention. The browser picks
up new front-end files on the next page load; the header shows a notice when the page you
have open is older than the server.

**Updating from 0.0.9.** The defaults hardened in 0.1.0, and a `config/local.json` written by
0.0.9's installer does not name them, so the first start after the update behaves like a fresh
install in four ways:

- **HTTPS.** The monitor makes itself a self-signed certificate under `data/tls/` and serves
  HTTPS on the same port; `http://…:21000` stops answering. Open `https://`, accept the
  certificate once. Behind your own reverse proxy, set `BLOCKYARD_TLS=0` (§10).
- **Sign-in.** Accounts are on. The first start creates the `admin` account and prints its
  password **once** in the log (`journalctl -u blockyard` under systemd); set
  `BLOCKYARD_ADMIN_PASSWORD` before that start to choose it. To keep the monitor open as before,
  put `"auth": { "enabled": false }` in `config/local.json` or start with `BLOCKYARD_AUTH=0`.
- **This machine only.** With no `server.host` in the config the bind is `127.0.0.1`. A
  0.0.9 config written by the installer names the host it chose, so a LAN bind stays; if yours
  does not, add `BLOCKYARD_BIND` or `server.hosts` (§7).
- **Market polling is off** until someone ticks **Display settings → Markets & Price → Enable
  market polling** — once, for every screen.

## 12. Uninstalling

BlockYard touches nothing outside its own directories: it reads `bitcoin.conf` and never writes
it, and it leaves the node as it found it. Removing it is deleting those directories.

**Installed from npm** (`npm install -g blockyard`): stop it, then

```bash
npm uninstall -g blockyard
rm -rf ~/.blockyard               # local.json, data/ (history, accounts, the audit trail) and data/index
```

**Installed from npm, without `-g`** (`npm install blockyard` into some directory): stop it, then
delete that directory (removes `node_modules/blockyard` along with everything else there) and,
separately, `rm -rf ~/.blockyard` — the config and data directory is outside `node_modules` and
survives deleting it.

**A checkout** run with `npm start`: stop it and delete the checkout; `config/` and `data/`,
the index included, live inside it. If you pointed the index elsewhere at setup time
(`addressIndex` in `config/local.json`), delete that directory too.

**The systemd service** of section 6:

```bash
sudo systemctl disable --now blockyard
sudo rm /etc/systemd/system/blockyard.service && sudo systemctl daemon-reload
sudo rm -rf /opt/blockyard        # includes data/: history, accounts and the audit trail
sudo userdel blockyard
```

## Checklist

- [ ] `node -v` prints v22 or later for the account the service runs as
- [ ] `config/local.json` names your node's RPC URL and a readable cookie (or user/password)
- [ ] `npm run check` passes: Core 25.0+, `txindex` synced, the block files readable, no pruning
- [ ] the index directory has ~125 GB free and is writable by the service account
- [ ] the start-up log shows the addresses you intended, and no node offline
- [ ] you have decided who can reach the port: it binds `127.0.0.1` until you say otherwise (bind, firewall, `allowCidrs`)
- [ ] accounts stay on (the default) if the port is reachable by people who should not see your node; you have the admin password from the first start
- [ ] HTTPS is on by default with the monitor's own certificate; a certificate of your own, or a proxy / tunnel in front, if you want no browser warning
- [ ] **Enable market polling** ticked in Display settings if you want the Markets and Kiosk tabs (off by default); `BLOCKYARD_MARKETS=0` on machines that must make no outbound connections at all
