# BlockYard Security Audit — 2026-09-16

> **STATUS: HIGH AND MEDIUM FINDINGS REMEDIATED — 2026-09-16, the same day.** H1: a stream client
> whose socket is full is sent nothing until it drains, and is dropped at 4 MB buffered or a minute
> blocked; 16 streams per address or account. M1/M2: with accounts off the node connection form
> answers only a loopback caller (`auth.openNodeConfigFromNetwork` widens it, and a trusted proxy
> closes it); a save to a new host drops the old endpoint's credentials; a probe of a foreign
> endpoint reports the kind of failure, not the body. M3: the index build checks its output
> directory (no symlink, root, home, working or blocks directory, nothing an index does not write)
> and removes only its own files. M4: every wallet RPC is refused by name. M5: `requestTimeout`
> is 30 s (the stream is unaffected: measured). M6: audit strings are clamped to 1,024 characters.
> M7: `package.json` excludes the private notes, and a test holds the pack to tracked files. M8:
> the shipped unit is sandboxed, and was started under exactly those settings. Each fix has a test
> in `test/audit-2026-09-16.test.js`. The H1 and M4 tests were run against the old code and failed,
> and the M3 proof of concept was re-run against the old build, which again deleted the planted file.
> The Low and Informational findings are still open.
>
> Findings are listed most severe first. Each one says whether it was reproduced (**CONFIRMED**) or
> found by reading the code (**CODE-READ**).

- **Project:** BlockYard, a multi-user web monitor for Bitcoin Core nodes.
- **Audit date:** 2026-09-16.
- **Repo state at audit:** branch `main` @ `84e10b8`, clean working tree. The previous audit ended at
  `0fb2c39`; since then 256 commits and about 26,300 inserted lines have landed. Of those, about
  1,900 lines are in `server/`, `scripts/`, `systemd/` and `package.json`. The largest new server
  surface is the resumable address-index build (`server/chain/index/build.js`, landed today), the
  network collector (`server/collect/network.js`), the DOS game file route (`server/http/games.js`)
  and the self-signed TLS generator (`server/tls/selfsigned.js`).
- **Scope:** the whole codebase: `server/`, `public/`, `scripts/`, `systemd/`, the CI workflow and the
  npm package contents. The machine the audit ran on is a development box that is deliberately not
  configured as a secure install would be, so its own settings are not findings; only the code, the
  shipped defaults and the shipped unit are.
- **Method:** four auditors ran in parallel, one per area: network-facing server; chain parsing
  and data stores; browser code; scripts, deployment and supply chain. The lead auditor
  re-ran the most consequential proofs before writing this report. Dynamic tests used throwaway
  instances with scratch config files, a fake RPC node (`scripts/fake-node.js`) and hostile
  subclasses of it.
- **Report generator model:** Claude Opus 5, in Claude Code.

## Executive summary

| verdict | count |
|---|---|
| High | **1**, fixed |
| Medium | 8, all fixed |
| Low | 17, open |
| Informational | 6, open |
| Findings from the 2026-09-13 and 2026-09-14 audits | fixed, except the two left open by decision |
| Test evidence | `npm test` 1013/1013 · targeted chain tests 19/19 · decoder fuzzing, 20,000 inputs per decoder |

The fixes from both earlier audits hold. The strict Content Security Policy (CSP), with a nonce
per response, turned every markup injection found this time into markup only: no injected script
ran in a real browser. Escaping is disciplined almost everywhere. The RPC allowlist resisted every
case, whitespace and batch trick tried. No credential reaches any API response.

The weak points were availability and the "open mode" posture, where accounts are switched off. All four below are fixed:

- **One High.** A client that opens the live event stream and stops reading is never dropped.
  400 such connections from one address pushed a test instance from 73 MB to 1.5 GB in three
  minutes. With accounts off, this needs no sign-in.
- **Open mode is safe only against browsers.** The cross-site check refuses requests that carry
  a foreign `Origin` or `Sec-Fetch-Site`. A script or `curl` sends neither. Any host that can reach
  the port can therefore rewrite the saved node connection, so the node's RPC cookie goes to an
  address of its choosing after the next restart. It can also make the server fetch internal URLs
  and read back the first 200 bytes of each response.
- **The index build removes its output directory without checking what it is.** A mistyped
  `addressIndex` path, such as a home directory, is deleted recursively on the next start.
- **The RPC console admits wallet reads that return private keys** (`listdescriptors true`,
  `gethdkeys`), contrary to `docs/SECURITY.md`.

---

## Verification evidence

| check | result |
|---|---|
| `npm test` | 1013/1013 pass at `84e10b8`. |
| `node --test test/chain-index.test.js test/chain-decode-property.test.js` | 19/19 pass. |
| Decoder fuzzing | 20,000 random inputs each into `decodeBlockUndo`, `undoShape`, `decodeTx`, `decodeBlock`, `classifyScript`, `records`, `blockRows` and `addressToScript`, biased toward CompactSize markers. Every failure was a thrown `RangeError` or `ERR_OUT_OF_RANGE`. No hang. Worst input took 64 ms; peak memory 65 MB. |
| Hostile node in a real browser | A fake node planted markup in every non-hex string, peer field, warning, log line, node label and a failed-login username. The only raw markup that reached the page came from the fields in L2 and L3. `<img onerror>` did not execute under the CSP. |
| Response headers (throwaway instances) | CSP `script-src 'self' 'nonce-…'`, `style-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, plus `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, and HSTS over TLS only. |
| Path traversal | `/js/../../config/local.json`, `%2e%2e`, `%00`, `/.git/config`, `/games/doom/..%2f..` all return 404 or 400. |
| RPC allowlist | `stop`, `dumpprivkey`, `dumpwallet`, `setban`, `addnode`, `invalidateblock`, `importdescriptors`, `signmessage`, `send*`, `getnewaddress`, `createpsbt` refused. `Stop`, `STOP`, ` stop`, `"getblockcount,stop"` and array methods refused. `listdescriptors`, `gethdkeys`, `listunspent` allowed (M4). |
| Secret hygiene | `git log --all -p` over 441 commits: no private keys, tokens or real RPC passwords; only test fixtures. No tracked `.pem`, `.key`, `.bak`, `local.json`, `users.json` or `.env`. |

---

## High

### H1 — HIGH, FIXED, CONFIRMED: a stalled event-stream reader is never dropped, so memory grows without bound

> **FIXED 2026-09-16** (commit `8e9c6a4`, test in `test/audit-2026-09-16.test.js`). `server/http/sse.js`: a client whose socket is full is sent nothing until it drains (the newest snapshot waits); it is dropped at 4 MB buffered or after 60 s blocked. `server/http/server.js`: at most 16 streams per address in open mode, or per account.

**Files:** `server/http/sse.js:76` (reaper), `server/http/sse.js:89-90` (write), `server/http/server.js:62`.

The reaper removes a client only when nothing has been written to it for 120 s **and** it has
received zero bytes:

```js
if (Date.now() - c.lastWriteAt > 120_000 && c.bytes === 0) this.remove(c);
```

Neither half can be true for a client that stops reading. Every 15 s ping and every snapshot
refreshes `lastWriteAt`, and the first `: stream open` frame makes `bytes` non-zero. `write()` sets
`client.backpressured = true` when the socket is full, and nothing reads that flag. Snapshots of
20–150 KB per second therefore queue in Node's socket buffer for as long as the connection stays
open. The per-address stream limiter allows a burst of 120 and refills at 40 per second, so one
address reaches hundreds of streams in seconds.

**Proof:** 400 stalled TLS connections to `/api/stream` from one host, against an open-mode test
instance. Resident memory went 73 → 293 → 613 → 1066 → 1425 → 1491 MB over about 180 s, with all
400 clients still registered. Killing the clients brought it back to 205 MB.

**Impact:** any client that can open the stream can exhaust memory. With accounts off, that is
anyone who can reach the port. The process under pressure is the one holding the node's RPC
cookie. A browser tab that is suspended, or one on a very slow link, builds up the same backlog
more slowly.

**Fix:** track `res.writableLength` per client. Stop pushing snapshots while it is backpressured,
and drop the client when the buffer passes a ceiling (for example 4 MB) or stays backpressured past
a timeout. Reap on that condition regardless of `bytes`. Cap concurrent streams per address to a
small number, for example 8.

---

## Medium

### M1 — MEDIUM, FIXED, CONFIRMED: in open mode, a non-browser caller can rewrite the node connection and receive the node's cookie

> **FIXED 2026-09-16** (commit `8e9c6a4`, test in `test/audit-2026-09-16.test.js`). `server/http/api.js`: with accounts off, the node connection save and test answer only a loopback socket peer, and never behind `server.trustProxy`; `auth.openNodeConfigFromNetwork` restores the old reach. A save to a different host or port drops `rpcUser`, `rpcPassword` and `cookieFile`.

**Files:** `server/http/api.js:97-99` (`configWriteAllowed`), `server/http/api.js:836-878` (`POST /api/config/node`), `server/http/server.js:240-256` (open-mode cross-site gate).

`configWriteAllowed` checks nothing when accounts are off. The open-mode gate refuses a request
only when it carries a cross-site `Origin` or `Sec-Fetch-Site`. A script sends neither, and a forged
`Host` with a matching `Origin` also passes. The save merges onto the existing node entry, so
`cookieFile` survives while `rpcUrl` changes.

**Proof:** on an open-mode test instance, an unauthenticated
`POST /api/config/node {"confirm":"save","rpcUrl":"http://<collector>"}` with no `Origin` was
saved. After a restart, the monitor sent `Authorization: Basic` with the planted cookie to the
collector three times. The browser path stays refused, as the 2026-09-13 fix intended.

**Impact:** persistent tampering with the monitor's configuration, and disclosure of the node's RPC
cookie to whoever can reach the port. How useful the cookie is depends on whether the node's RPC
port is reachable from the attacker.

**Relation to earlier audits:** this is 2026-09-14 **I1**, left open by decision. It is raised to
Medium here because it was reproduced end to end.

**Fix:** with accounts off, refuse config and settings writes unless the caller is on loopback or
an explicit `allowOpenConfigWrites` option is set. On save, drop `cookieFile`, `rpcUser` and
`rpcPassword` whenever the `rpcUrl` host changes.

### M2 — MEDIUM, FIXED, CONFIRMED: the node-connection probe is a server-side request forgery (SSRF) that reflects the response

> **FIXED 2026-09-16** (commit `8e9c6a4`, test in `test/audit-2026-09-16.test.js`). `server/http/api.js`: a probe of any endpoint but the configured one returns only the kind of failure (timeout, unreachable, not JSON-RPC, RPC error), never the endpoint's reply. The loopback gate from M1 also applies.

**Files:** `server/http/api.js:772-834` (`POST /api/config/node/test`), `server/rpc/client.js:361-366` (error text).

The 2026-09-13 fix holds: the probe sends no credentials to a new endpoint (the collector saw no
`Authorization`). But the route is reachable without sign-in in open mode by any non-browser
caller, as in M1. It POSTs to any URL the caller names. When the reply is not JSON, the error
message returns the first 200 characters of the body.

**Proof:** open-mode test instance, no `Origin` header,
`POST /api/config/node/test {"rpcUrl":"http://127.0.0.1:<port>/internal"}` →
`{"error":{"message":"RPC returned non-JSON (INTERNAL-ADMIN-PANEL secret-token=abc123 …)"}}`.
The distinct errors for refused, timed out, unparseable and unauthorised also map which internal
ports are open.

**Fix:** require a positive same-origin signal for stateful POSTs in open mode, for example an
anonymous double-submit token. Report only `reachable`, `refused`, `timed out` or `not an RPC
server`, never the body.

### M3 — MEDIUM, FIXED, CONFIRMED: the index build deletes its output directory recursively with no check

> **FIXED 2026-09-16** (commit `8e9c6a4`, test in `test/audit-2026-09-16.test.js`). `server/chain/index/build.js`: `checkOutputDir` refuses a symlink, the filesystem root, the home and working directories, the blocks directory or anything containing it, and any directory holding a name an index does not write. The build removes only index entries, never the directory.

**Files:** `server/chain/index/build.js:306-309`, reached from `server/main.js` at startup and from `scripts/index-build.js`.

When there is no trusted build journal, `buildIndex` runs `rmSync(out, { recursive: true, force: true })`.
Nothing checks that `out` is empty, looks like an index, is not a symlink, or is not `/`, a home
directory, the working directory, the node's datadir or its blocks directory. The server starts
this build by itself whenever a node has `addressIndex` set and no `manifest.json` is there. The
deletion happens after the heights phase, minutes after start, when nobody is watching.

**Proof:** `buildIndex` with a fake RPC, an empty blocks directory and `out` set to a directory
holding `.ssh/id_x`. The build threw "1 heights were not indexed". Afterwards `.ssh/id_x` no longer
existed. With `out` a symlink, the link was replaced by a real directory.

**Impact:** a typo such as `"addressIndex": "/home/bitcoin"`, `"."` or `"data"`, or `--out ~` on the
command line, destroys that directory.

**Fix:** never remove `out` itself. Create it with a marker file such as `.blockyard-index`, and
refuse to build in a non-empty directory that lacks the marker. When clearing, delete only the
index's own names: `bucket-*.unsorted`, `seg-*`, `manifest.json`, `build-journal.json`, `*.tmp`,
`live.log`, `layers/`. `lstat` `out` and refuse a symlink.

### M4 — MEDIUM, FIXED, CODE-READ (classification CONFIRMED): the RPC allowlist admits wallet reads that return private keys

> **FIXED 2026-09-16** (commit `8e9c6a4`, test in `test/audit-2026-09-16.test.js`). `server/rpc/allowlist.js`: `WALLET_METHODS`, every method in Core's wallet category plus the legacy wallet methods, is refused by name before any prefix rule.

**File:** `server/rpc/allowlist.js:45` (the `get` and `list` allow prefixes).

`classifyMethod` returns `allowed: true` for `listdescriptors`, `gethdkeys`, `listunspent`,
`listtransactions`, `getbalances`, `getwalletinfo`, `listwalletdir` and `getaddressinfo`. With an
unlocked wallet loaded, `listdescriptors true` and `gethdkeys {"private":true}` return private key
material. `docs/SECURITY.md` says key-material methods are refused by name and that the monitor has
no wallet access. The same prefix rule was 2026-09-13 finding 2, left open by decision; these two
methods make it concrete.

**Impact:** anyone allowed to use the RPC console can read wallet private keys. With accounts off
that is anyone who can reach the port.

**Fix:** deny `listdescriptors` and `gethdkeys` by exact name. Better, deny every wallet RPC,
since the monitor has no use for them, and correct the documentation.

### M5 — MEDIUM, FIXED, CONFIRMED: no deadline on reading a request body

> **FIXED 2026-09-16** (commit `8e9c6a4`, test in `test/audit-2026-09-16.test.js`). `server/http/server.js`: `requestTimeout` is 30 s. Measured: a stream outlives the deadline; a trickled body gets 408.

**File:** `server/http/server.js:62` (`server.requestTimeout = 0`).

The timeout is zeroed for every request so the event stream is not cut off. That also removes the
body-read deadline from every other route. `headersTimeout` (15 s) bounds only the headers.

**Proof:** `POST /api/login` with `Content-Length: 100000`, sending one byte every 20 s, was still
open after 95 s.

**Fix:** exempt only the stream, for example with `req.setTimeout(0)` on that socket. Restore a
finite `requestTimeout`, or add a deadline inside the body reader.

### M6 — MEDIUM, FIXED, CONFIRMED: the audit trail can be flushed out with oversized RPC method names

> **FIXED 2026-09-16** (commit `8e9c6a4`, test in `test/audit-2026-09-16.test.js`). `server/main.js`: every string in an audit row is clamped to 1,024 characters; `/api/rpc` clamps the method it audits and echoes to 64.

**Files:** `server/http/api.js:602-611`, `server/main.js:271-283`, `server/config.js:200-201`.

`/api/rpc` writes the caller's `method` string into the audit row verbatim. The body limit is 1 MB,
the log rotates at 8 MB and keeps 5 files.

**Proof:** with accounts on, about 60 requests carrying a 900 KB method name from a signed-in viewer
rotated the log through all retained files. The earlier `user-create` rows were gone. In open mode
the rows are written the same way, so an anonymous caller can do it too.

**Fix:** clamp `method` and every other free-form audited field to a short length, for example 128
characters, before writing.

### M7 — MEDIUM, FIXED, CONFIRMED: the npm package includes private notes that `.gitignore` excludes

> **FIXED 2026-09-16** (commit `8e9c6a4`, test in `test/audit-2026-09-16.test.js`). `package.json`: `!docs/STATE-*.md` and `!docs/PRIVATE-*.md`. A test fails if `npm pack` would publish any file git does not track.

**File:** `package.json`, `"files"`: `"docs/*.md"`.

npm selects files by the `files` globs and does not read `.gitignore`. `docs/STATE-*.md` and
`docs/PRIVATE-*.md` are therefore packed. `test/privacy.test.js` scans only `git ls-files`, so
nothing catches this.

**Proof:** `npm pack --dry-run` today lists `docs/PRIVATE-LEADERBOARD.md` and
`docs/STATE-2026-09-09.md`. The published `blockyard-0.0.9.tgz` contains both. 0.1.0 does not. The
0.0.9 copies hold internal paths, service names and port numbers. No credentials, keys or IP
addresses were found in them.

**Fix:** list the published docs explicitly, or add negations for `docs/STATE-*` and
`docs/PRIVATE-*`. Add a test that runs `npm pack --dry-run --json` and fails on any gitignored path.
Consider deprecating 0.0.9.

### M8 — MEDIUM, FIXED, CODE-READ: the shipped systemd unit has almost no sandboxing, and its comment says otherwise

> **FIXED 2026-09-16** (commit `8e9c6a4`, test in `test/audit-2026-09-16.test.js`). `systemd/blockyard.service`: `ProtectSystem=strict` with `ReadWritePaths` for `data/` and `config/`, `ProtectHome=read-only`, `PrivateTmp`, no capabilities, `SystemCallFilter=@system-service`, restricted address families, `UMask=0077`; the misleading comment is replaced. The app was started under exactly these settings as a transient service and served pages and saved settings.

**File:** `systemd/blockyard.service`.

The unit sets `NoNewPrivileges=yes` and nothing else of note: no `ProtectSystem`, `ProtectHome`,
`PrivateTmp`, `ReadWritePaths`, `CapabilityBoundingSet`, `RestrictAddressFamilies`,
`SystemCallFilter` or `UMask`. Its comment describes a read-only `/home` that is not configured. It
also claims `ProtectSystem=strict` would stop the service reading the node cookie, but `strict`
makes paths read-only; it does not block reading. `docs/INSTALL.md` §6 correctly recommends a
dedicated system account, but anyone who copies the unit as shipped gets no filesystem isolation.
Any code-execution bug would reach everything the service account can.

**Fix:** add `ProtectSystem=strict`, `ProtectHome=read-only` (or `tmpfs` with `BindReadOnlyPaths=`
for the cookie), `ReadWritePaths=` for `data/`, `config/` and the index directory, `PrivateTmp=yes`,
`CapabilityBoundingSet=`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`,
`SystemCallFilter=@system-service`, `ProtectProc=invisible` and `UMask=0077`. Correct the comment.

---

## Low

### L1 — LOW, CONFIRMED: open redirect after sign-in

**File:** `public/js/login.js:79-80`.

```js
window.location.replace(back && back.startsWith('/') ? back : '/');
```

`//host` and `/\host` both start with `/` and leave the site. Signing in at
`/login?next=//<other-origin>/` landed on the other origin. A crafted link can send a user from a
genuine sign-in page to a lookalike "session expired" page. The server never sets `next` itself.

**Fix:** accept only `^/(?![/\\])`, or resolve with `new URL(back, location.origin)` and require the
same origin. Or remove `next`.

### L2 — LOW, CONFIRMED: some RPC fields reach the page unescaped

**Files:** `public/js/panels.js:84, 93, 95, 156, 291-292, 517`; `kv()` in `panels.js` (about line 833) does
not escape; `setText` in `public/js/app.js:468-470` assigns `innerHTML`. Server side:
`server/collect/monitor.js:1824, 1878, 1904` copy the fields without type checks.

`getblockchaininfo.chain`, `.pruned`, `.initialblockdownload`, `getmempoolinfo.unbroadcastcount`, the
budget values and the node-self values are rendered as HTML. A hostile node returned them as strings
with `<u>` and `<img>` appended, and those elements appeared on the Chain, Mempool and Node pages.
The CSP blocked script. What remains is fake text, links and forms, with `form-action 'self'`
limiting the forms. Only a malicious RPC endpoint, or someone who can tamper with plain-HTTP RPC to a
remote node, can do this. Peers and miners cannot.

**Fix:** escape in `kv()` by default, with an explicit opt-in for markup. On the server, validate
`chain` against the known chain names, booleans with `typeof`, and counts with `Number.isFinite`.

### L3 — LOW, CONFIRMED: the node's RPC URL is rendered unescaped, and shown to viewers

**File:** `public/js/panels.js:477`, source `server/rpc/client.js:402`.

An `rpcUrl` with markup in its query string passed URL validation and injected elements on the Node
page for every viewer. Setting it needs an admin, or anyone in open mode (M1). The URL is also shown
to every viewer, so a URL written as `http://user:pass@host` would expose those credentials.

**Fix:** escape it. On the server, strip the userinfo part before sending the URL to any client.

### L4 — LOW, CONFIRMED: one malformed byte in a coinbase stalls pool attribution

**Files:** `server/collect/mining.js:44-45` (`parsePushes`), retry loops in `server/collect/monitor.js:814-831` and `server/collect/network.js:242-244`.

A coinbase scriptSig that ends in `OP_PUSHDATA2` or `OP_PUSHDATA4` with no length bytes makes
`readUInt16LE`/`readUInt32LE` throw. Consensus allows any bytes after the BIP34 height, so any pool can
do this to its own block for free. The failed height goes back to the front of the queue with up to
60 s backoff, so every later block waits behind it. The pool-history view retries the whole chunk of
eight every 15 s and stops filling. `decodeCoinbase('03aabbcc4d')` throws `ERR_OUT_OF_RANGE`.

**Fix:** stop parsing when `i + head > bytes.length`. Catch per block and record it as unparseable
instead of retrying forever.

### L5 — LOW, CONFIRMED: one absurd order book can freeze the server and allocate gigabytes

**Files:** `server/collect/markets.js:114-120, 182-186, 234-247`.

The depth grid size is `ceil(mid × 0.24 / 50)`, where `mid` is the median of the books' mid-prices.
With one book answering, that book alone sets it. A book of bid 60,000 and ask 2×10¹⁰ gave 48 million
levels: `pollBooks` blocked for 10.2 s and memory reached 5 GB for one snapshot, which is kept for an
hour. Response bodies have no size cap, only an 8 s timeout. Reaching this needs a broken,
compromised or intercepted exchange API; TLS verification is on. Market polling is off by default.

**Fix:** discard a book whose mid is more than 20% from the ticker median, and clamp the level count,
for example to 2,000. Stream response bodies with a byte cap.

### L6 — LOW, CONFIRMED: a log-parsing pattern takes cubic time on long lines

**File:** `server/collect/logparse.js`, the `legDown` rule; `parseLine` runs every rule unanchored on the main thread.

`'[mux:1] next peer a unreachable: ' + ' '.repeat(N) + 'x'` took 5 ms at 250 spaces, 177 ms at 1,000,
1.4 s at 2,000, and did not finish in 300 s at 20,000. The `bandwidth` rule is quadratic. `splitLines`
keeps an unterminated line in `carry` with no limit. It needs a multi-kilobyte line in the node's log.

**Fix:** truncate lines to 4–8 KB before matching and cap `carry` the same way. Replace
`\s*(.+?)\s*` with a form that cannot backtrack across the same spaces, such as `\s*(\S.*?)\s*`.

### L7 — LOW, CONFIRMED: the height table loops forever when it is full

**Files:** `server/chain/index/heights.js:141, 147`; capacity fixed at `1<<21` in `build.js:30`.

The open-addressing table has no load check, so at 2,097,152 entries `set` never finds a free slot.
It runs on the server's main thread during the background build, so a node reporting a tip above that
height hangs the monitor. Mainnet reaches that height around 2046. Inserting the 1,025th key into a
table of capacity 1,024 hung until the 5 s test timeout.

**Fix:** size capacity from the tip, at least twice `tip + 1`, and throw past a load of 0.75.

### L8 — LOW, CONFIRMED: the index trusts the coin count of an undo record

**File:** `server/chain/index/rows.js:514-521` (the `nin` from `walkTx` is ignored).

Blocks and undo records are paired by `hash256(prevhash ‖ undo)`, which does not commit to the block's
contents. Two sibling blocks in one file with the same parent and transaction count can each match
either undo record. A wrong pick is not detected, and rows are written with the wrong spent scripts
or amounts. A transaction with two inputs paired with an undo holding one coin produced three rows and
no error.

**Fix:** throw when `coins.length !== nin`, which also turns a mispairing into a detected failure.

### L9 — LOW, CODE-READ: nothing stops two builds writing the same index directory

**Files:** `server/chain/index/build.js`, `server/main.js`.

The server's automatic build and `scripts/index-build.js --out <same dir>` can run at once. The server's
own failure message suggests running that command, and a restart re-enters the build. Each can delete,
truncate and rename the other's files. The CRC checks make most interleavings fail, but not all of them
for segments.

**Fix:** take an exclusive lock file in `out` (`openSync(lock, 'wx')`, with the PID and a stale-PID check).

### L10 — LOW, CODE-READ: file modes follow the umask, and temporary files follow symlinks

**Files:** `writeFileAtomic` in `build.js`, `worker.js` segment writes, `live.js` `writeAtomic`, bucket
files, `server/store/ledger.js`, `server/store/audit.js`, `server/store/history.js`, directory creation
in `server/main.js:29-30`.

Index files, the journal, the live log and the ledger are created without a mode, so on a host with
umask `0002` they are group-writable. `audit.js` and `history.js` pass `0o600`, which only applies on
creation, so a file created before the 2026-09-14 fix keeps its old mode. Every `.tmp` is opened with flag `w`, which follows a symlink. Anyone who can create
entries in `out` or `data/` can plant `manifest.json.tmp` pointing at another file and have it
overwritten as the service account.

The build journal's SHA-256 detects a torn write; it is not authentication. With write access to
`out`, a forged journal plus a `bucket-XX.unsorted` symlink makes a resume truncate the symlink's target.
A forged journal can also mark buckets sorted over arbitrary segment files of the right size, so a wrong
index is served. All of this needs write access to `out`, which already means control of the index.
Journal-driven deletion was checked and stays inside `out`.

**Fix:** pass explicit modes, `fchmod` existing audit and data files at startup, create directories with
`0o700`, set `UMask=0077` in the unit. Unlink temporary files first and open them with `wx`; `lstat`
bucket files before truncating.

### L11 — LOW, CONFIRMED: anonymous responses disclose filesystem paths

**Routes:** `/api/telemetry` (`cookieSource`), `/api/state` (`getrpcinfo.logpath`).

In open mode these return the full paths of the node cookies and debug log, which include the
service account's home directory name. The comment on `/api/about` says usernames and paths are withheld
on purpose; these routes defeat that. `/api/about` also returns kernel, CPU model and memory, and
`/api/peers` returns peer addresses, both by design for a viewer.

**Fix:** send a boolean such as `cookieFound`, or a basename, and drop `logpath` for viewers.

### L12 — LOW, CODE-READ: `setup.js` shows the RPC password on screen and on the command line

**File:** `scripts/setup.js:222-229, 261, 272, 297`.

The `secret: true` prompt only hides the default value; `readline` still echoes what is typed.
`--rpc-password` is visible in `ps` and shell history. `writeLocalConfig --force` never re-applies `0600`
to an existing file. `scripts/manage-users.js` already does all of this correctly.

**Fix:** use muted input as `manage-users.js` does, accept `--rpc-password-file` or stdin, and `chmod 0600`
after writing.

### L13 — LOW, CONFIRMED: malformed percent-encoding in a route parameter returns 500

**File:** `server/http/server.js:305-316` (`matchRoute`).

`POST /api/users/%E0%A4%A/role` → 500 `internal error`. No information leaks; it is a wrong status and a
noisy log line.

**Fix:** catch the `decodeURIComponent` error and return 400. The browser has the same pattern in
`public/js/explorer.js:23` (I1).

### L14 — LOW, CONFIRMED: sign-in lockout by address lets one client lock out a shared address

**Files:** `server/auth/sessions.js:162-184`, `server/http/api.js:291-294`.

Eight failures lock both the username and the source address for 10 minutes, so one person behind a
shared NAT or proxy can lock everyone behind it out of every account. This is the usual trade-off for
lockouts, and the per-address token bucket limits floods. Worth knowing; not urgent.

### L15 — LOW, CODE-READ: `pool-map.js` fetches without pinning and follows any redirect

**File:** `scripts/pool-map.js:253-283, 299`.

It fetches the pool list over verified HTTPS but checks no expected hash; the SHA-256 is recorded, not
compared. The `curl -fsSL` fallback follows redirects to any protocol, including plain HTTP. The effect
is limited to display labels, which are escaped. The coverage check hardcodes port 8088, while the
default is now 21000, so coverage is never measured.

**Fix:** add `--proto =https --proto-redir =https`, show a diff before overwriting, and read the port from config.

### L16 — LOW, CONFIRMED: security documentation has drifted from the code

- `SECURITY.md`'s supported-versions table lists 0.0.9 and says nothing else was released; 0.0.1 and 0.1.0 are on npm.
- `docs/CONFIGURATION.md:403` gives the `BLOCKYARD_AUTH` default as `false`; the code default is `true` (`server/config.js:221`).
- The shipped unit's comment and `scripts/smoke.sh` still say accounts are off by default.
- `docs/SECURITY.md`'s open-mode table lists "every node write" as closed but omits that the node connection and Display settings are writable (M1).
- `docs/SECURITY.md` says the monitor has no wallet access (M4).

Checked and still true: loopback bind and sign-in by default, TLS key `0600` in a `0700` directory,
the full header set, `/api/audit` and `/api/users` refused in open mode, node writes gated, market
polling off by default, no credential value in any API response.

### L17 — LOW, CONFIRMED: game files are served without sign-in, and CI actions are pinned by tag

- `/games/doom/DOOM1.WAD` returns 200 and 4 MB with no session. No data is exposed, but anyone who can
  reach the port can pull tens of megabytes repeatedly. Consider requiring a session for `/games/`.
- `.github/workflows/test.yml` uses `actions/checkout@v7` and `actions/setup-node@v7` by tag. The workflow
  already has `permissions: contents: read`, no `pull_request_target`, no secrets and no install step.
  Pin both to commit SHAs.

---

## Informational

- **I1** — `public/js/explorer.js:23`: `decodeURIComponent` on a hash like `#explorer/tx/%E0` throws and
  stops that tab's explorer rendering. Wrap it and fall back to the explorer home.
- **I2** — `public/js/depthchart.js:245`: `d.note` goes into `innerHTML` unescaped. It is a fixed server
  string today; escape it before it ever becomes dynamic.
- **I3** — `scripts/index-build.js:181`: `--workers abc` or `--workers 0` makes a pool with no workers.
  With `--files` that writes a "successful" manifest with zero rows. Validate `>= 1`, as the server path does.
- **I4** — robustness of self-written files: a CRC-valid but short `live.log` record throws in the
  constructor; a bad `.idx` length throws in `reloadLayers`; a manifest's `blockRows` sizes an allocation
  unchecked; one corrupt undo record fails its whole file and so the whole build. All fail safe.
- **I5** — `.gitignore` has no pattern for `config/*.bak-*`, which `setup.js` writes. Such files hold the
  RPC password and would show as untracked, one `git add` away from a commit.
- **I6** — the game binaries under `games/` are served, never executed on the server (there is no
  `child_process` in `server/`), and are excluded from the npm package. Wolfenstein 3D ships no licence
  text beyond `file_id.diz`, and no provenance or hash manifest exists for any game.

---

## Earlier audits, re-verified

### 2026-09-13 (`docs/SECURITY-AUDIT.md`)

| # | finding | status now | evidence |
|---|---|---|---|
| 1 | node probe leaked credentials; open-mode CSRF | **fixed**; the residual gap for non-browser callers is M1 and M2 | `api.js:797-803`; the collector saw no `Authorization` |
| 2 | allowlist prefix table | **open by decision**; no bypass found, but see M4 | `allowlist.js:45-61` |
| 3 | config and settings writes CSRF-exempt in open mode | **partly fixed**: browsers refused; scripts still write (M1) | `server.js:240-256` |
| 4 | `randomPassword` modulo bias | **fixed** | `users.js:454-462`, `crypto.randomInt` |
| 5 | session lifetime inverted | **fixed** | `config.js:228-229`; both limits checked in `sessions.js:71-72` |
| 6 | double KDF on failed sign-in | **mitigated** | sign-in limiter 10 at 0.5/s (`main.js:127`), lockout works |
| 7 | test disables TLS verification process-wide | **contained**; restored in `finally` | `test/tls.test.js:150`, `test/selfsigned.test.js:85-98` |
| 8 | `getblock` height unclamped | **fixed** | `api.js:1000-1003` refuses above tip + 1000 |
| 9 | shared snapshot object | not an issue | unchanged |
| 10 | audit result not redacted | **fixed** (length is M6) | `main.js:271-279` |

### 2026-09-14 (`docs/SECURITY-AUDIT-2026-09-14.md`)

| # | finding | status now | evidence |
|---|---|---|---|
| M1 | `page` sized an allocation | **fixed** | `store.js:131-140`; `page=999999` returns quickly |
| M2 | post-tip rows shown as history | **fixed** | `store.js:125-142`, `explorer.js:327,354` |
| L1 | pool key unescaped | **fixed** | `mining.js:1402` |
| L2 | transaction cache bounded by count only | **fixed** | `explorer.js:37-44` |
| L3 | test fixture at a fixed `/tmp` path | **fixed** | `shape-liveness.test.js:23-24` uses `mkdtempSync` |
| L4 | runtime files not `0600` | **fixed for new files**; old files keep their modes (L10) | `history.js:154,219` |
| I1 | open-mode config save aims the cookie | **open by decision; reproduced** (M1) | save, restart, cookie sent three times |

---

## Things done right

- **Defaults:** loopback bind, accounts on, HTTPS with a generated certificate, market polling off,
  node writes off and refused without an identity; a fatal config error for open mode with writes on.
- **Headers:** strict CSP with a per-response nonce and no inline script or style, enforced by a
  test; frame-busting set twice; HSTS only over TLS.
- **Authentication:** scrypt with per-user parameters and transparent rehash, equal-cost decoy for
  unknown users, session tokens stored hashed, `HttpOnly` and `SameSite=Strict` cookies, `Secure`
  forced under TLS, double-submit CSRF compared in constant time and refused from the cookie alone.
- **Open mode's ceiling:** the anonymous user is a frozen viewer on both authentication branches;
  user administration, the audit trail and password changes stay closed.
- **RPC allowlist:** default deny with exact and prefix deny lists ahead of the allow list; case,
  whitespace and batch tricks all refused.
- **File serving:** lexical plus `realpath` containment for static files; a strict 8.3 name pattern,
  a fixed game list and a no-symlink directory match for game files.
- **Secrets:** redaction by shape in logs and the audit trail; no credential in any API response;
  secrets and TLS key `0600`; atomic writes with `fsync` and rename; a clean git history, guarded by a
  privacy test.
- **Parsing:** the undo decoders are held to "throw or decode exactly" by seeded property tests, with
  exact-width VARINTs, a BigInt amount path and bounds-checked script reads. Fuzzing found no hang.
- **The build journal:** records only what is proven, checks every bucket's CRC before sorting,
  deletes inputs only after the journal records the sort, and discards itself on any identity
  mismatch or reorganisation.
- **Front end:** consistent escaping of every peer-, miner- and log-derived string traced; stored
  Display settings are normalised through allowlists and colour patterns before use, so they cannot
  become markup; games load through a fixed import table; no `eval`, `new Function` or string timers.
- **Supply chain:** zero dependencies, no install step in CI, a read-only workflow token.

## Recommendations, in priority order

Items 1 to 7 are done (see each finding's FIXED note). Item 8, the Lows, is open.

1. **H1 and M5 together.** Drop backpressured stream clients, cap streams per address, and restore a
   body deadline for everything except the stream. One area of `server/http/`.
2. **Close open mode to scripts (M1, M2).** Refuse config writes and the probe in open mode unless
   the caller is on loopback, strip credentials when the RPC host changes, and stop echoing probe
   response bodies. Running with accounts on, the shipped default, closes these already.
3. **M3.** Never remove the index directory itself; use a marker file and delete only the index's own files.
4. **M4.** Deny wallet RPCs by name and correct `docs/SECURITY.md`.
5. **M7** before the next publish: fix the `files` list and add the pack test.
6. **M6.** Clamp free-form audit fields.
7. **M8.** Harden the shipped unit.
8. The Lows, starting with L2/L3 (escape in `kv()`), L4 (the coinbase parser), L1 (the redirect) and L7
   (the height table), which are each a few lines.

## Scope and limits

- **Reviewed:** every file under `server/`; every module under `public/js`, with each of about 90
  `innerHTML`, `outerHTML` and `insertAdjacentHTML` sinks read individually; `public/index.html`;
  `scripts/`; `systemd/`; `.github/workflows/`; `package.json` and the packed file list; `.gitignore`.
- **Dynamic:** throwaway instances with auth on and off, fake and hostile RPC nodes, a headless browser
  against a throwaway instance.
- **Not covered:** the Bitcoin Core nodes themselves; the configuration of the development machine
  the audit ran on, which is not a secure install and is not reported; the DOS emulator's x86 core as an
  attack surface beyond confirming it runs in the browser with no `eval` or WebAssembly.
- Per the project's privacy rule, no host name, account name, address, credential value or real peer
  address appears in this report.
