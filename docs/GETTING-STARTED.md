# Getting started: macOS or Linux, from a command prompt

Everything here is typed into a terminal on **the machine that runs Bitcoin Core**. BlockYard
reads the node's block files to build the explorer's address index, so it runs on the node's
machine and nowhere else. Ten minutes of typing, then the index build runs on its own.

## 1. Bitcoin Core

BlockYard needs Bitcoin Core **25.0 or later** (`getblock` verbosity 3, which the index follower
uses; v29 is what it is being released against), with its RPC server on and a transaction index.
Add to `bitcoin.conf` if they are not there, and restart the node:

```conf
server=1
txindex=1
```

`txindex=1` on a node that has run without it triggers a one-off reindex that takes a while;
`bitcoin-cli getindexinfo` says `"synced": true` when it is done (with the macOS app bundle,
`bitcoin-cli` is inside it: `/Applications/Bitcoin-Qt.app/Contents/MacOS/bitcoin-cli`). Everything but the explorer's
transaction-by-id pages works before that. `coinstatsindex=1` is optional: without it the Chain
page's UTXO figures are blank and the node is not asked for them.

**Disk:** the address index is about **125 GB**, on top of the node's own ~875 GB of block
files; the build reads those files once. A different disk from the node's is best, if there is one.

Where `bitcoin.conf` and the data directory are, by default:

| | data directory | `bitcoin.conf` |
|---|---|---|
| macOS | `~/Library/Application Support/Bitcoin` | the same directory |
| Linux | `~/.bitcoin` | the same directory |

A **pruned** node will not do: the index needs every block file.

## 2. Node.js 22 or newer

```bash
node -v        # v22.x or later
```

If that prints nothing or an older version:

- **macOS:** `brew install node` (Homebrew's current Node is newer than 22), or the installer
  from <https://nodejs.org>. (`node@22` from Homebrew is keg-only and needs linking; the plain
  `node` formula is simpler.)
- **Linux:** your distribution's `nodejs` package if it is 22+, otherwise the installer or
  NodeSource repository from <https://nodejs.org>.

## 3. Get BlockYard

```bash
git clone https://github.com/BobClawblaw/blockyard.git
cd blockyard
npm test              # optional: the unit tests; there is no npm install -- no dependencies
```

## 4. `npm run setup` — the installer

```bash
npm run setup
```

It asks for the data directory first and **reads the node's own `bitcoin.conf`** there -- the
chain, `rpcport`, `rpcconnect`, `rpcuser`/`rpcpassword`, `rpcauth` users, a cookie file the node
was told to write elsewhere, `server=` and `txindex=`, sections (`[main]`, `[test]`, ...) and
`includeconf=` all understood -- so the rest arrive as defaults to accept rather than questions
to answer. Then it checks the answers against the node (every call timed, a verbose mempool read
included, so you learn how fast the node answers before anything depends on it), asks where the
web interface and the index go, writes `config/local.json`, and offers to build the address
index. Every check is a read; nothing on the node is changed. The banner is pixel art and, like
everything the installer prints, fits an 80-column terminal.

| it asks | default | what it does with the answer |
|---|---|---|
| Bitcoin Core data directory | the platform default above | reads `bitcoin.conf`; finds the `.cookie` for RPC authentication, the `blocks/` directory, and `debug.log` |
| Bitcoin Core RPC URL | from `bitcoin.conf`: `rpcconnect` and `rpcport`, else `http://127.0.0.1:8332` (the chain's default port) | connects, reads the chain and height |
| a label | `Bitcoin Core` | what the header calls the node |
| rpcUser / rpcPassword | from `bitcoin.conf` when it has them; *asked only if no cookie is readable* -- an `rpcauth` user is pre-filled, its password is not in the file | a node using `rpcauth` instead of the cookie |

Then it prints the checks. This is what a good node looks like:

```
  2/6  Checking the node  ────────────────────────────────────────────────────

    ✓ credentials        cookie /Users/you/Library/Application Support/Bitcoin/.cookie
    ✓ rpc                http://127.0.0.1:8332 answers in 10 ms: chain main, block 967,016 of 967,016 headers
    ✓ version            /Satoshi:29.1.0/ (290100)
    ✓ txindex            synced to 966,978
    · coinstatsindex     off: the Chain page marks UTXO figures unindexed (optional)
    ✓ getblock 3         the tip block decodes with prevouts (4,077 transactions) in 921 ms
    ✓ mempool            34,455 transactions, verbose, in 1.0 s
    · address index rpc  the node has no address index, as expected of Bitcoin Core; BlockYard builds its own
    ✓ block files        5757 block files and 5757 undo files, 875.9 GB, XOR-obfuscated (xor.dat present)
    ✓ read a block       blk00000.dat opens and its first record is the genesis block
    · node log           /Users/you/Library/Application Support/Bitcoin/debug.log (10.3 MB) -- found; not parsed on Bitcoin Core, and not needed

    everything this needs is there
```

A ✗ names what is missing and what to do about it (`txindex=1`, a readable cookie, the chain
the node is really on, a pruned node). A slow `getblock 3` (5 s or more) or a slow mempool read
(10 s or more) is a warning, not a failure: it says the board and the block being built will lag
behind the node. If the RPC server does not answer it offers to ask again; with anything else
failing it asks before writing. Every answer is validated before it is accepted -- a URL that is
not one, a port outside 1-65535, a directory that is not there -- and asked again.

Then, in this order:

| it asks | default | notes |
|---|---|---|
| bind address | `127.0.0.1` | keeps it to this machine; `0.0.0.0` opens it to everyone who can reach the port, see [SECURITY.md](SECURITY.md) |
| port | `21000` | it warns if something (a running BlockYard included) already answers there |
| index directory | `data/index` inside the checkout | alongside everything else this install writes; about 125 GB for the whole chain -- give another path to put it on a different disk from the node's |
| build workers | `4` (fewer on a machine with fewer cores or less memory; never more by default) | each needs about 2.5 GB of memory. **Answer 1 if the block files are on spinning disks**: parallel readers only seek against each other and against the node, and the build takes hours there whatever you answer |

It writes `config/local.json` (mode 0600; a backup is kept if one was there) and shows it. The
number of workers is written as `addressIndexWorkers`, so the background build uses the same one.

**Step 6, building the index** — the default is **(b)ackground**: BlockYard builds it itself
once it starts, on worker threads, while every page keeps working. **Expect the build to take a few hours** — about two on the installer's default of four workers on NVMe, longer on spinning disks — during which every other page works and address pages show the build's progress in place of a history. The Overview's "What this
panel cannot tell you" box shows the progress (`the address index is being built: scan 1,234 of
5,757 (21%), 1,204,511,033 rows so far, about 20 min left`), the address page says the same in
place of a history, and a notification pops up at the start and when it is done (both appear in
the events feed, as does a failure) — the address pages fill in from then on, no restart. The
ETA settles after the first few files. The build is **paced by the node**: it holds while the
node's RPC is failing or answering slower than the monitor's slow threshold (`rpc.slowLatencyMs`,
5 s by default), eases off while merely slow, and says so in the progress line and the log; it
talks to the node over its own RPC connection so the pages are not queued behind it. Reading
every block file once took **29 min 45 s on 16 workers** on NVMe on the machine it was measured
on; expect roughly four times that on four. **(h)ere** builds it in this terminal instead, with a
progress bar and the same pacing; **(l)ater** writes `addressIndexBuild: "manual"` so nothing
builds until you run this and restart BlockYard:

```bash
node scripts/index-build.js --out data/index --workers 4
```

Last question: **start BlockYard now, in this terminal?** — yes runs it right there (Ctrl-C
stops it, and stops a background build with it; there is no resume, so it starts over on the
next start); `--start` does the same without asking.

Scripted, with no questions (a fresh machine, a Makefile):

```bash
node scripts/setup.js --yes --rpc-url http://127.0.0.1:8332 \
  --datadir "$HOME/Library/Application Support/Bitcoin" --index-dir "$PWD/data/index" --workers 4
```

Every question has a flag: `--datadir`, `--rpc-url`, `--label`, `--rpc-user` / `--rpc-password`,
`--host`, `--port`, `--index-dir`, `--workers`. `--build-here` builds in the terminal and
`--build-later` leaves it to you; `--start` boots the monitor at the end; `--force` replaces an
existing `config/local.json` (with a backup).

## 5. Run it

```bash
npm start
```

The log says `BlockYard 0.1.0 listening on https://127.0.0.1:21000` (its own self-signed
certificate, made on this first start; the browser warns once and remembers it), then `created the
first admin account (admin)` with a generated password **shown once** — copy it, or set
`BLOCKYARD_ADMIN_PASSWORD` before the first start to choose it — then `address index: building
/Users/you/blockyard/data/index from main's block files with 4 workers -- the Overview shows the
progress` (and `address index build: paused while the node's RPC is answering in … s` /
`resumed` if the node struggles) and, when that is done, `address index built: … rows to block N
in … min -- address pages are live` followed by `address index /Users/you/blockyard/data/index:
following main from block N`. Open <https://127.0.0.1:21000> and sign in as `admin`. The
Overview fills in within about thirty seconds; Block space lands a little after. Open Explorer,
click the latest block, then any output address: while the index is building the page says so
with the progress; once it is built, its balance, history and unspent outputs appear.

To check the setup again at any time, or after changing the node:

```bash
npm run check
```

It runs the same checks against every node in `config/local.json`, with every call timed, and
exits non-zero if one fails, so it can sit in a health script.

## 6. Keep it running

- **Linux:** as a systemd service — [INSTALL.md §6](INSTALL.md#6-run-it-as-a-service).
- **macOS:** leave `npm start` running in a terminal (or a `tmux`/`screen` session), or write a
  `launchd` plist that runs `node server/main.js` in the checkout with `KeepAlive`.

## 7. Updating

```bash
git pull
npm test
```

then restart it. There is nothing to install and no build step. If a release says the index
format changed, delete the index directory (or rebuild it with the same `index-build.js` command
into the same directory — the build empties the directory first) and BlockYard builds it again
on the next start.

## If something does not fill in

[TROUBLESHOOTING.md](TROUBLESHOOTING.md): a node showing offline, an empty block-space board,
a slow or paused index build, STALLED in the header, a transaction id not found (`txindex`), an
address page reading *not indexed* or *behind*, no dollar figures, a slow board.
