# Getting started: macOS or Linux, from a command prompt

Everything here is typed into a terminal on **the machine that runs Bitcoin Core**. BlockYard
reads the node's block files to build the explorer's address index, so it lives next to the
node; see [INSTALL.md](INSTALL.md#it-runs-on-the-nodes-machine) for why a node elsewhere over
RPC was tried and dropped. Ten minutes of typing, then the index build runs on its own.

## 1. Bitcoin Core

BlockYard needs Bitcoin Core **25.0 or later** (`getblock` verbosity 3, which the index follower
uses; v29 is what it is being released against), with its RPC server on and a transaction index.
Add to `bitcoin.conf` if they are not there, and restart the node:

```conf
server=1
txindex=1
```

`txindex=1` on a node that has run without it triggers a one-off reindex that takes a while;
`bitcoin-cli getindexinfo` says `"synced": true` when it is done. Everything but the explorer's
transaction-by-id pages works before that.

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

- **macOS:** `brew install node@22` (or the installer from <https://nodejs.org>).
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

It asks four things, checks the answers against the node, writes `config/local.json`, and
offers to build the address index straight away. Every check is a read; nothing on the node is
changed.

| it asks | default | what it does with the answer |
|---|---|---|
| Bitcoin Core RPC URL | `http://127.0.0.1:8332` | connects, reads the chain and height |
| Bitcoin Core data directory | the platform default above | finds the `.cookie` for RPC authentication, the `blocks/` directory, and `debug.log` |
| a label | `Bitcoin Core` | what the header calls the node |
| rpcUser / rpcPassword | *(only asked if no cookie is readable)* | a node using `rpcauth` instead of the cookie |

Then it prints the checks. This is what a good node looks like:

```
node at http://127.0.0.1:8332
  [  ok  ] credentials        cookie /Users/you/Library/Application Support/Bitcoin/.cookie
  [  ok  ] rpc                http://127.0.0.1:8332 answers: chain main, block 966,976 of 966,976 headers
  [  ok  ] version            /Satoshi:29.0.0/ (290000)
  [  ok  ] txindex            synced to 966,976
  [ info ] coinstatsindex     off: the Chain page marks UTXO figures unindexed (optional)
  [  ok  ] getblock 3         the tip block decodes with prevouts (3,876 transactions)
  [ info ] address index rpc  the node has no address index, as expected of Bitcoin Core; BlockYard builds its own
  [  ok  ] block files        5757 block files and 5757 undo files, 875.9 GB, XOR-obfuscated (xor.dat present)
  [  ok  ] read a block       blk00000.dat opens and its first record is the genesis block
  [ info ] node log           /Users/you/Library/Application Support/Bitcoin/debug.log (10.3 MB) -- found; not parsed on Bitcoin Core, and not needed
  everything this needs is there
```

A `FAIL` names what is missing and what to do about it (`txindex=1`, a readable cookie, the
chain the node is really on). If the RPC server does not answer it offers to ask again; with
anything else failing it asks before writing.

Then the web interface (bind address and port; `127.0.0.1` keeps it to this machine, `0.0.0.0`
opens it to everyone who can reach the port, see [SECURITY.md](SECURITY.md)), the address index
directory (`~/blockyard-index`; about 124 GB for the whole chain, best on a different disk from
the node's), and the number of build workers (each needs about 2.5 GB of memory; the default
fits the machine). It writes `config/local.json` (mode 0600; a backup is kept if one was there)
and shows it.

**"Build the address index now?"** — yes, unless you want the web interface first. The build
reads every block file once: **29 min 45 s on 16 workers** for the whole chain on the machine it
was measured on; roughly four times that on four. It prints progress once a second. If you
answer no, it prints the command to run later:

```bash
node scripts/index-build.js --out ~/blockyard-index --workers 4
```

The address page says **not indexed** until the build is done, and BlockYard needs a restart
after it to pick the index up.

Scripted, with no questions (a fresh machine, a Makefile):

```bash
node scripts/setup.js --yes --rpc-url http://127.0.0.1:8332 \
  --datadir "$HOME/Library/Application Support/Bitcoin" --index-dir ~/blockyard-index --workers 4
```

`--no-build` writes the config and stops; `--force` replaces an existing `config/local.json`
(with a backup).

## 5. Run it

```bash
npm start
```

The log says `BlockYard 0.1.0 listening on http://127.0.0.1:21000` and, once the index exists,
`address index /Users/you/blockyard-index: following main from block N`. Open
<http://127.0.0.1:21000>. The Overview fills in within about thirty seconds; Block space lands a
little after. Open Explorer, click the latest block, then any output address: with the index
built, its balance and history appear.

To check the setup again at any time, or after changing the node:

```bash
npm run check
```

It runs the same checks against every node in `config/local.json` and exits non-zero if one
fails, so it can sit in a health script.

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
format changed, rebuild it with the same `index-build.js` command into the same directory —
the build empties the directory first.

## If something does not fill in

[TROUBLESHOOTING.md](TROUBLESHOOTING.md): a node showing offline, a transaction id not found
(`txindex`), an address page reading *not indexed* or *behind*, no dollar figures, a slow
board.
