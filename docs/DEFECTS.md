# Defect and gap register

Open items, honestly stated. Checked items keep their entry so the reasoning is
not re-litigated.

## Done since the first draft

Kept as checked rather than deleted, so nobody re-derives them.

- [x] **`public/js/panels.js` written** — all eight pages render (`renderChain`,
  `renderMempool`, `renderPeers`, `renderNetwork`, `renderLogs`, `renderNode`,
  `renderAdmin`, `ensureLogsLoaded`).
- [x] **`login.html` + `js/login.js` + `404.html` exist.** The login script is a
  separate file because the page's CSP is `script-src 'self'`: an inline script
  would not run, and "the button does nothing" is a miserable bug to chase.
- [x] **git repo, `.gitignore`, and the private GitHub remote.** `data/` holds
  `users.json` (scrypt hashes + salts), `sessions.json` (hashed session tokens)
  and `audit.jsonl`; verified after pushing that `data/` is absent from the
  remote tree entirely.
- [x] **`README.md` written** for humans; `AGENTS.md` stays the agent resume point.
- [x] **404 answers 404.** It was answering HTTP 200 with a page body, which makes
  every crawler and uptime probe think the guessed path was correct.
- [x] **The bench node was being tailed from the wrong file.** `logFile` pointed at
  `<datadir>/main/debug.log`, which is 144 bytes (three `node start` lines) and had
  not moved since boot, while the node wrote to `console.log` in its run directory.
  The monitor held the stub open on fd 22 for two hours and every log-derived panel
  of that node sat still without a single warning. Verified with `ls -l /proc/<pid>/fd`
  before and after. Now repointed, and `log-silent` exists so the next one speaks up.
- [x] **Log grammar drift, measured and covered.** The bench build of 2026-09-08
  03:02 rewrote `[dlc]`: 30 of 1,702 lines parsed, and 1 of its 1,006 `[dlc]` lines.
  Now 94.8% of that run parses (production went 82.4% → 90.5% from the same rules),
  including per-peer download rates that exist in no RPC call. Frozen real fixtures
  plus a ratio canary: `test/bench-log.test.js`, rule 15.
- [x] **Three log-health flags**: `log-missing` (no source, not a zero), `log-silent`
  (file frozen — and it reports the chain delta observed during the silence rather
  than asserting a cause, because the bench node block-buffers stdout to a file),
  `log-unparsed` (lines arriving, <5% matching any rule). Plus `log.health.ratio`
  published so coverage is visible on the Node panel instead of being internal.
- [x] **`cfg.log.tailBytes` never reached the tailer.** It was read as
  `log.tailBytes` off the *logger function*, which has no such property, so the
  configured value was ignored and LogTail's own default applied — the same number,
  which is why it looked fine. Same trap would have swallowed `staleMs`; the monitor
  now takes a `logCfg` of its own.

- [x] **RPC-only mode exists and is honest about what it loses.** `log.enabled: false`
  / `BLOCKYARD_LOG_SOURCE=0`: the monitor opens no log file at all (verified — the
  process has no log fd), states the mode in `health.quality` (`log-source-disabled`)
  naming the figures that lose their source, and `/api/config`'s provenance table is
  generated per mode so no row can name a log source while the log is off. Two new
  RPC sources came with it: `getaddrmaninfo` (11 ms) and `listbanned` (3 ms).
- [x] **`upload-unmeasurable`: the ratio check that stops a fake `0 B/s`.** The bench
  build reports 12,896,531,244 bytes received against 1,129 sent with 21 peers
  connected. That is not traffic, it is a counter missing the download worker, so
  `outBps` is withheld (`uploadMeasured: false`) instead of rendering a calm zero.
- [x] **`peerinfo-partial`**: on builds that do publish rows, 21 peers sum to 70.29%
  of `getnettotals` — labelled a subset, not presented as a breakdown.
- [x] **`nettotals-zero` and `peerinfo-empty` now say what happens *in the mode you
  are running*.** Both used to end with "...comes from the node log instead", which is
  a lie in RPC-only mode.
- [x] **`CounterRate.add` was called twice per `getnettotals` sample** (once discarded).
  Harmless to the value, but it doubled the sample buffer; the RPC-only path made it
  worth cleaning.

- [x] **Labelled log lines are scanned field by field, and the rigid rules were
  deleted, not kept as fallbacks.** `bandwidthTickFields` and `dlcProgressFields`
  decode the `[dlc]` tick and progress lines one labelled field at a time; unknown
  fields are kept verbatim (`extraFields` / `extraValues`) and surfaced at
  `log.unrecognisedTickFields`. Live coverage: bench **68.2% → 90.3%**,
  production **73.6% → 89.7%**. A second code path for one line is how a rule can be
  matching 185/185 and then 0/185 without anyone noticing, so there is now one path.
- [x] **Peers RPC cannot see are parsed**: 323 inbound connections on production were
  accepted and dropped before BIP324 completed (`[serve] inbound … v2 handshake
  failed`) — `getpeerinfo` never counts a peer it never negotiated with. Aggregated
  into `inbound-handshake-failing` with a per-host breakdown (323 rows would have
  pushed every real event out of the feed and said less).
- [x] **`node-restarting`**: `[serve] shutting down (signal 15): tip=965914` is
  surfaced with the tip at shutdown, so the ECONNREFUSED that follows reads as the
  restart instead of as a monitor or network fault. Measured while it happened: a
  concurrent session deployed `deploy-20260908a` at 06:21 and the
  monitor reported `online: false` with the reason intact.
- [x] **An unknown eta stays unknown**: `[dlc] ==` can print `eta --:--:--:--`;
  decoded as `null`, never as zero or as a huge number.

- [x] **A production outage caused by two lost conf lines, surfaced correctly by the
  monitor while the node looked "running" to systemd.** The 06:21 deploy dropped
  `rpcport=8331`/`port=8332`; P2P then collided with the benchmark's Core on 8333
  (`[boot] lsock failed: Address already in use`) and RPC drifted to 8332, so the
  monitor reported `online false / ECONNREFUSED` about a node that was alive on a port
  nobody was watching. Restoring the two lines fixed both. Full record in
  `MEASUREMENTS 18`; the diagnostic note now sits in `server/config.js`, because this
  is the third time those lines have been lost (2026-08-26, twice on 2026-09-08).
- [x] **Two timings that make a healthy node look broken**, now written down: RPC binds
  **~100 s** after systemd says `running`, and `[utxo_live] init` blocks chain RPCs for
  **~40 s** after that. A probe at 40 s sees `ECONNREFUSED`; the slow tier landing in
  the init window produces `rpc timeout after 90000ms` while `getblockcount` answers in
  0.15 ms moments later. Neither is a monitor fault and neither is now a mystery.
- [x] **The RPC peer/byte gap is closed on the current production build**
  (`deploy-20260908a`: 4 peer rows, `bytesrecv` summing to exactly `getnettotals`,
  nonzero sent) where the previous build answered `[]` and `0/0`. RPC-only mode is
  therefore viable on production *today* — and left switched off by default, because
  every build still reports the same non-Core `subversion` (`:0.0.1`) and the mode has
  no way to know it is on a generous build. That asymmetry is the whole argument for
  the log staying a primary source.
  **Update 2026-09-11:** the "no way to know" half is false on `deploy-20260910ag`.
  `getnetworkinfo` answers the build's own commit attestation "860b8fdd", dirty false
  (MEASUREMENTS 27). The monitor does not read the field yet (see Functional gaps), and
  older builds omit it.

## Security / correctness

- [x] **Listening address is now a decision on this box, and the failure modes are
  loud.** Bound to the LAN address (`config/local.json` → `192.0.2.10`; the unit
  agrees) instead of the wildcard, so tailscale and the docker bridges are no longer
  served and `127.0.0.1` is not either — documented in `AGENTS.md` as the trap it is,
  because a refused loopback curl looks exactly like a dead monitor. Two behaviours
  added with it: binding an address the machine does not have **fails at boot and
  prints the addresses it does have** (matters when the address came from DHCP), and
  the boot log names the interfaces left unserved. `server.host` must now be an
  address literal — a hostname is refused at load rather than at `listen()`, or worse,
  at the next reboot after a DNS change. Covered by `test/bind.test.js`.
  **Followed within the hour by the correction that mattered:** LAN-only locked the
  operator out, because this box's browser traffic arrives over `tailscale0`
  (`ip route get 198.51.100.8` → `dev tailscale0`) and the tailnet advertises no route
  for `192.0.2.0/24` — a tailnet client cannot reach the LAN address at all. So
  binding is multi-address now (`server.hosts`, one HTTP server per address; a single
  socket cannot listen twice, which is what `ERR_SERVER_ALREADY_LISTEN` at 15:11 was
  telling me), an address missing at boot is warned about and skipped rather than
  fatal, and the configured set is LAN + tailnet — bridges and loopback still refused.
  The lesson is recorded in `AGENTS.md`: *"no response from the LAN address" was
  correct behaviour, not a fault*, and a bind change is a client-topology decision
  that has to be checked against how clients actually arrive.
  **Deliberately unchanged: the code default is still `0.0.0.0`**, so a fresh clone or
  `npm run dev` binds everything. Changing that would break development on other
  machines; the deployment decision lives in `config/local.json` (gitignored) and the
  unit, which means *a new machine gets the wildcard until someone says otherwise*.
- [x] **TLS exists now; the lack of it stops being a documented shrug.** Serving
  HTTPS was an option (`server.tls.cert`/`key`, `BLOCKYARD_TLS_CERT`/`_KEY`), and the
  settings that must not be independent are wired together: turning TLS on forces the
  session cookie `Secure` (a Secure cookie over HTTP is never sent, which reads as a
  login that will not stick), HSTS is sent only over TLS (2 days, no `includeSubDomains`,
  no `preload` — a LAN address can be reissued and HSTS cannot be unsaid), and every
  listener is encrypted or none is ("encrypted on the tunnel, clear on the LAN" lets the
  weakest address decide whether the cookie is a secret). Config mistakes that were
  silent are now fatal: a **half** pair (cert without key) would otherwise fall back to
  plaintext on a port someone believes is HTTPS; an **expired** certificate is fatal,
  because a browser refuses and the dashboard — being behind that refusal — cannot say
  so. Certs are parsed with `crypto.X509Certificate` (a builtin), so `selfSigned`,
  `notAfter` and the fingerprint appear in the boot log; inside 14 days of expiry warns
  rather than refusing. `test/tls.test.js` generates a throwaway cert with `openssl`
  (and skips, naming the reason, where openssl is absent), and asserts plaintext
  against the TLS listener *fails* rather than falling back. What remains true: the
  default is still plaintext, and the boot now says so on stdout in words.
- [x] **CIDR membership is computed on bytes, for both families.** The old
  implementation compared the TEXT of a client address with the text of a network
  prefix (`net.split('::')[0]`, then `startsWith`). For `fd00::/8` that behaves; for
  anything subtler it over-permits — the regression now pinned by `test/cidr.test.js`:
  `2001:db8:1::/48` accepted `2001:db8:1f::1`, because the string starts with the
  characters `2001:db8:1`. Text does not know where a nibble ends. Now: IPv4 and IPv6
  parsed to bytes (compression, `%zone`, embedded IPv4, brackets), bit-exact
  comparison, family never crossed (`0.0.0.0/0` does not admit `::1`), a malformed
  entry admits nobody **and** stops the boot, and the refusal names the entry that
  matched — for the log line, not the client.
- [x] **A per-response CSP script nonce.** `script-src 'self'` was fine *until*
  someone added an inline script, at which point it would fail in the browser with
  nothing recorded server-side — the same silently-dead shape as the module-scope
  ReferenceError that blanked this UI for a day. HTML is now rewritten per response
  (`%BLOCKYARD_NONCE%` placeholder + asset versioning), measured at 0.009 ms per request
  (MEASUREMENTS §22), so the cost of the option is nil. The nonce lands in `script-src`
  only — never in `style-src`, which would reopen the thing fixed below — and
  `test/csp.test.js` asserts it differs between responses, because a constant nonce is
  an open door with a documentation comment attached.
- [x] **`audit.jsonl` rotates by size** (8 MiB, keeping 5 ⇒ worst case 48 MiB), the
  reader walks the chain newest-first so a rotation is invisible mid-page, the budget
  is checked against the on-disk file rather than a drifting counter, a **failed**
  rotation keeps appending and says so in `/api/telemetry` and the admin page, and a
  restart adopts the existing file size. The reason for a hard bound is not tidiness:
  this disk also holds the history snapshots and the node's datadir, so an unbounded
  audit log's failure mode is not "no audit", it is "no node" (MEASUREMENTS §22).
- [x] **`/api/login` has its own per-address bucket** (capacity 10, refill 0.5/s),
  separate from `LoginGuard`. The lockout answers "this username keeps failing" and the
  per-user token bucket cannot apply pre-auth, so the unmitigated case was a slow grind
  spread over addresses — each attempt costing a scrypt KDF, measured at **20 ms and
  16 MB** on this box (that comment previously claimed ~50 ms and is corrected). Refusals
  return `code:"throttled"` with a retry window and are audited as `login-throttled`.
  Asserted in `test/http-app.test.js` and `scripts/smoke.sh`.
- [x] **Rehash-on-login, with the parameters stored per user.** Raising
  `auth.scrypt` now actually raises it, one account at a time, at the only moment the
  plaintext is in hand. Three details that matter: rehash happens on a **successful**
  verify only (hashing a wrong password would store a hash of the wrong secret and
  destroy the account), verification uses the *stored* parameters so an old hash never
  stops working, and an unrecognised `scheme` is refused rather than assumed to be
  scrypt. The admin page marks accounts whose stored cost is behind (`kdf behind`), and
  the upgrade is logged and audited — "it applies on next login" is only checkable if
  that login reports it.

- [x] **A latent one, found while testing something else: env vars whose cast was a
  function were never cast.** `env()` implemented `Number` and `Boolean` and returned
  the raw string otherwise, so `BLOCKYARD_ALLOW_CIDRS=a/24,b/8` arrived as a **string** —
  and the gate iterated it character by character, parsed nothing, and refused every
  address including the operator's. The documented way to restrict the monitor to a LAN
  was a deny-all. `BLOCKYARD_ACTIONS` was the same shape, making `allow.includes(name)` a
  *substring* test on a string. `BLOCKYARD_HOST`/`_BIND` survived only because `validate()`
  re-splits a string there. Found by `test/cidr.test.js`, which was written to test CIDR
  matching — the bug surfaced one layer below where the mistake was. Fixed in
  `env()` (rule 20), with regressions for both variables.

- [x] **Access is now open by default, and the way it was done is the defect that
  would have been.** `auth.enabled` flipped to `false`: no sign-in, like a block
  explorer. The obvious implementation moves the session check behind the flag — and
  takes the `route.auth === 'admin'` check down with it, so "no login required" becomes
  "no login required, and anyone may create accounts". Guarded structurally instead:
  the anonymous identity is a frozen `viewer` that no config or credential can raise;
  the admin-role check runs on **both** branches; `/api/login` answers
  `accounts_disabled` rather than pretending a credential exists; `/api/audit` declines
  rather than serving a trail that can name nobody; CSRF is skipped only because there
  is no cookie to ride (with the two checks that make that safe asserted next to it);
  rate limits key per **address**, so one chatty tab cannot spend the LAN's bucket; and
  node writes are refused twice over — fatal at config load, again at the route — unless
  `BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH=1` is chosen deliberately. The boot line names the
  readable addresses, what "read" grants, and the switch that closes it. Rules 23, 24;
  `test/open-access.test.js`, 19 new smoke checks against a second, open instance.

- [x] **`scripts/manage-users.js` — the documented password-recovery CLI — had not
  parsed for some time.** An editor put a real carriage return *inside a string
  literal*. Legal in CommonJS, a syntax error in ESM, and this project is
  `"type": "module"`, so `node scripts/manage-users.js passwd admin` threw before
  `main()` ran. Nothing caught it because nothing imports a CLI: `npm test` never
  executed it, and `node --check` on the same bytes **passes outside the project**
  (parsed as CJS) — a check that succeeds for the wrong reason (rule 21). Fixed the
  literal (raw DEL/ETX operands replaced with escapes while I was there) and added
  `test/parse-all.test.js`: every shipped file under `server/`, `public/js/` and
  `scripts/` must parse **as the module it will be loaded as**, no raw control
  characters anywhere, and the CLI must actually run. It asserts how many files it
  checked, so the glob cannot quietly match nothing.

- [ ] **`CounterRate` fabricates a `0 B/s` download rate after every peer disconnect
  on `deploy-20260910ag`, and understates it silently after smaller ones.** Found
  2026-09-11 (MEASUREMENTS 27); not fixed. `server/store/ring.js` `CounterRate.add`
  treats any value below the window's oldest sample as a node restart:
  `if (value < this.samples[0].value) { this.samples = [{ t, value }]; return 0; }`.
  That is right for a lifetime counter, and this build's `getnettotals` is not one. It
  sums the **live** peer table plus the download's bytes (`cmd_getnettotals`, whose own
  comment calls this a documented divergence from Core), so it drops whenever a peer
  leaves.
  Measured: **109,036,122 → 89,979,098** bytes received between 09:22:07 and
  09:23:03Z, when a peer holding **19,303,469** bytes disconnected. Two failure shapes:
  - **Drop larger than the window's growth**: reset, and `rateIn.add()` returns `0`,
    which `monitor.js` stores straight into `state.net.inBps`. That lands in the `net`
    ring and on the chart as a calm idle sample. The node was moving 4,268 B/s over the
    next clean interval. `rateOut` resets the same way. Its `add()` return is discarded
    and `outBps = rateOut.rate()` reads `null` with one sample, so upload shows `–` for
    that tick with no reason attached.
  - **Drop smaller than the window's growth** (180 s window for both directions): no
    reset. `rate()` is `(last − first) / span`, which silently includes the departed
    peer's bytes as a negative step. It stays understated by
    `bytes the peer held / window span` until the pre-disconnect samples age out of the
    window. No flag, no zero, just a lower number: the shape nobody will catch by eye.

  This breaks AGENTS.md rule 3 (never fabricate a number to fill a gap) and RULES rule 8
  (absent beats zero). It is the same sin §23 removed for a counter stuck at 0, now
  arriving through the restart heuristic.
  Candidate fixes, to decide rather than implement blind:
  1. **Per-peer deltas keyed by `getpeerinfo` `id`.** For control peers `id` is
     `nodeid`, taken from `__sync_fetch_and_add(&next_nodeid, 1)` (node `main.c`) and
     documented in `rpc_node.c` as unique for the process lifetime. A departed peer then
     simply stops contributing. Two costs: download-worker rows are appended with
     `id = 100000 + slot`, a slot index a different peer can reuse, so key those on
     `(id, addr, conntime)`; and `getpeerinfo` sits in the 15-min rare tier while the log
     is on, whereas this needs it on the 4 s fast tier (0.25–0.29 ms, 3.5–3.9 kB measured).
  2. **Tell a restart from a departure.** `uptime` is already in the same fast-tier batch.
     Reset only when it went backwards. Otherwise the decrease is a departure: withhold
     the sample (`null` plus a reason) instead of returning `0`. The understated case
     still needs option 1, because the drop in `getnettotals` mixes the departed peer's
     bytes with everyone else's growth.
  3. Whatever is chosen, `blockRate` (`monitor.js`) relies on the reset-on-decrease
     behaviour deliberately and must keep it. A test should replay the measured sequence
     above and assert that neither `0` nor an understated rate comes out.

## Functional gaps

- [x] **Coverage is now measured per shape, not globally.** `SHAPES` in
  `logparse.js` declares which measurements must keep arriving with gates derived from
  measured cadences (p95 x 8, clamped to [10, 30] min — table in `MEASUREMENTS 19`),
  and the monitor raises `log-shape-silent` when a shape it has *seen* stops arriving
  while the log keeps moving. A shape is armed on first match, so a build that never
  emits a line is excused without a build table. Gates are overridable via
  `logCfg.shapeGatesMs`, which is how the tests assert in milliseconds.

  Four unparsed production shapes were found on the way and are now rules: `addrv2
  gossip`, `outbound top-up` (aggregate, with a reason breakdown →
  `outbound-dial-failing`), `[dl] updating utxo` (validation throughput, a third rate
  kept separate per rule 9), `header mirror`, plus `[dial]` background attempts /
  failures and the **`no global IPv6 route`** note (`ipv6-unreachable`, "a host
  capability, not a node fault"). Production coverage 73.4% → **82.8%**.

  Two bugs this caught, both mine, both now pinned by tests:
  - it flagged a **synced** node (`initialblockdownload=false`, `vp=1`,
    `blocks==headers`) for "bandwidth rate stopped arriving", because I had inferred
    IBD from log shapes and the tail contained post-boot `[utxo_live] catchup
    progress`. The node's own RPC answer now takes precedence; log shapes are the
    fallback, and if even that is unknown, we do not watch.
  - `[serve] shutting down` replayed from four hours of backfilled tail raised
    `node-restarting` on a node that had been up since. The flag is now age-gated and
    is cleared the moment `getblockchaininfo` answers. The event still reaches the
    feed, where its timestamp speaks for itself.
- [ ] **The RPC circuit breaker is per-node, so in principle one slow method can blind
  every panel — unproven as harmful, and now measurable.** Observed at 10:35–10:38:
  `online false (breaker open, retry in 26s)` → `online true` → `online false` within
  25 s, while a direct `getblockcount` answered in 1 ms in between. That looked like
  granularity until it could be measured properly: over 15 minutes of clean running
  after the per-node tagging landed, **0 breaker trips and 0 errors on either node**
  (max avg latency 22 ms on production, 362 ms on bench, chain points continuing on
  both). Every flap that day aligned with one of the nine real restarts. So the earlier
  guess — that this was the mechanism behind "8088 is not updating" — is not supported,
  and is corrected here rather than left in as a plausible-sounding defect.
  Remaining question, worth answering only if it bites again: a slow-tier timeout
  currently opens a breaker that also blocks the 4 s tier. Per-tier granularity is a
  small change but it is not obviously better — blocking *everything* for 30 s after 3
  consecutive failures is also what protects a single-threaded node from a client that
  will not stop asking.

  **Updated 2026-09-09 — the question is now answerable even though the policy is
  unchanged.** The lane records what opened the breaker (`openedBy`: method label,
  error kind, duration, and the calls that were queued when it opened), the last
  failure, the consecutive count against the threshold, and the remaining cooldown;
  `/api/telemetry` publishes it as `rpc.breaker`, and a call refused *because* the
  breaker is open now says which method opened it instead of emitting a shrug. A gap
  found while writing that: the breaker was checked at submit but **not** at dequeue,
  so work already queued when it opened still fired at the node — "back off for 30 s"
  meant "back off for new questions only". Fixed, with a test
  (`test/breaker.test.js`).
- [ ] **Production was restarted nine times before 10:39** (18 shutdown lines in one
  log file: 06:21, 06:31, 06:35, 09:53, 10:11, 10:34, 10:36, 10:38, …) by a concurrent
  deploying session. Not this repo's bug, but it is the single biggest determinant of
  what the dashboard looks like, and every monitor reading during those windows is
  correct-but-alarming. Whoever owns the deploy should know the box sees it as ~9
  outages. **What this repo changed on 2026-09-09:** the shape is now said out loud —
  3+ shutdowns in 60 min raises `node-restart-storm`, quoting the timestamps, with the
  window on the **log's** clock so a backfill of archived shutdown lines cannot read as
  nine restarts happening now. Nine individually-correct alarms in an hour were being
  read as "the monitor is flapping", which is the opposite of what a true-but-noisy
  signal should produce. The history that produced the shape table below:

  | shape | what changed | rigid-rule result |
  |---|---|---|
  | `[dlc] --` tick | `+ staged 1` at 05:42 | 0 of 26 lines |
  | `[dlc] --` tick | `staged N commit N` at 06:14 | 0 of 30 lines |
  | `[dlc] ==` progress | `(no gap, 100.00% landed)`, `eta --:--:--:--` | 0 of 185 lines |
  | `[serve] inbound` (new tag) | 646 lines, none previously parsed | — |

  Each was fixed by scanning labelled fields one at a time (`bandwidthTickFields`,
  `dlcProgressFields`): a new field now costs that field and lands in
  `log.unrecognisedTickFields` verbatim (`{"staged":"26","commit":"6484"}`). A third
  field, `cursorhelp`, appeared two hours later and cost nothing.
- [x] **`app.js` had zero coverage and died while evaluating — the page has never
  rendered, since the first commit.** `app.js:3` imported five chart helpers;
  `app.js:379` builds `helpers.charts = { lineChart, histogram, scatter, meter,
  stackedBars, ... }` at **module scope**. Shorthand properties resolve identifiers, so
  the module threw `ReferenceError: histogram is not defined` before `boot()`, before
  login, before the stream — and therefore **before any HTTP request**. Every symptom
  today ("does not update with any stats at all", "nothing refreshes", "can't get stats
  for the production build") traces here. `git log -S` puts it in `256d970`, the initial
  commit: it has never worked in a browser.
  - Why nothing caught it: 60 smoke checks drive HTTP directly and never execute the
    shipped entry point; `node --check` parses, and a missing import parses fine; the
    static DOM-contract tests check identifiers used in strings, not bindings. A green
    suite that never evaluates the thing the user runs is measuring the wrong thing.
  - Why I did not find it: the server log was empty of requests, which is *evidence of
    a dead client*, and I read it as "their tab isn't connecting" and went three layers
    into sessions, cookies and bind addresses. The browser console settled it in one
    line, and asking for the console should have been the **first** question, not the
    sixth. Cheapest decisive evidence goes first — that is the whole reason this repo
    writes down measurements before opinions.
  - Fixed by importing the four names, and closed with `test/app-boot.test.js`, which
    imports `app.js` under the DOM stub (`test/dom-stub.js`) — Node evaluates the same
    ESM graph, so this is the browser's structural check with no browser. Verified in
    both directions: with the import removed it fails with the browser's own message
    (`ReferenceError: histogram is not defined`), and a second assertion names all four
    missing imports. That second assertion was initially **vacuous** — it matched the
    first `charts: {}` in the file, which is the empty one in `state`, and "passed"
    while the bug was live; it now scans every occurrence and asserts it found
    something to check.
- [x] **CSP blocked every data-driven style attribute**, so the layout collapsed on top
  of the dead script: `style-src 'self'` also refuses `style="…"`, and the UI draws bar
  and progress widths that way, producing a wall of "Refused to apply inline style".
  Narrowed with `style-src-attr 'unsafe-inline'` — data-driven attributes allowed,
  inline `<style>` elements and style text still blocked — rather than loosening
  `script-src`, which is the directive that actually matters for XSS.
- [x] **`style-src-attr 'unsafe-inline'` is deleted, and a test keeps it dead.** The
  static `style="…"`s became classes in `public/css/app.css`; the data-driven ones (the
  sync bar's fill and the `verificationprogress` tick) travel as `data-w` / `data-left`
  and are written through the CSSOM by `applyDataSizes()`, which CSP permits — a string
  that never reaches an HTML attribute cannot be an injection site. Numbers only: a
  value that will not parse is skipped rather than pasted into CSS, and out-of-range
  values are clamped. `test/csp.test.js` asserts three separate things — no style
  attribute in shipped HTML, none in injected markup, and that the CSSOM path actually
  sets the width (without which "no style attributes" would just be a grep that broke
  the sync bar).
- [ ] **No real-browser harness — narrowed, not closed.** The gap this entry
  described ("the network/session layer between the renderers and the node") is now
  covered, but by Node rather than by a browser: `app.shutdown()` exists (teardown was
  the only thing preventing an in-process boot), so `test/helpers/http.js` boots the
  real app — one node, two nodes, or HTTPS with a generated certificate — and speaks
  HTTP to it: headers, cookies, `304` behaviour, nonces, the login throttle, the
  drill-down routes. The DOM stub also parses the tags the app injects, which is how
  the CSSOM-width claim is asserted as behaviour rather than as a grep.
  **Still open, and not closeable without a browser engine:** layout, the CSS cascade,
  real `EventSource` reconnect semantics, and anything a stub agrees with itself about.
  The stub is a parser of the markup this app writes, not a layout engine; do not read
  its green as "the page renders".
- [x] **The page says which build it is running, and complains when it is not
  current.** The static layer stamps `data-blockyard-build` and rewrites asset URLs to
  `?v=<build>` (build id = version + digest of asset sizes and mtimes, `0.1.0-3faef7bb00`
  form — not a git SHA, because this box deploys by copy and a SHA would describe a tree
  that was never committed at boot). `/api/build?build=` answers `matchesClient`,
  `checkBuild()` compares them on load and every 5 min, and on mismatch the header shows
  `stale build — reload` and toasts once. The important part is the *comparison*: a
  footer that shows a hash nobody can compare against anything is decoration. HTML
  consequently never answers `304` (its body is per-response); assets keep their ETag.
  Asserted in `test/http-app.test.js` and nine checks in `scripts/smoke.sh`.
- [x] **`rpc-lane.test.js` raced under load: fixed 2026-09-13.** "a long-running heavy call
  does not starve a cheap high-priority poll" and its sibling each did `await sleep(5)` to let the
  blocking task start before queueing behind it. That is a coin flip, not a wait: on a loaded
  machine the 5 ms can elapse before the heavy task reaches its first `await`, so the lane is still
  free and the cheap poll runs first -- `['cheap','heavy']` instead of `['heavy','cheap']`.
  Measured across this session's logs: **4 failures in ~40 full-suite runs, 0 in 8 isolated runs**,
  which is exactly the signature of a load-dependent race and exactly why it kept looking like
  "just a flake". Both now await a promise the task itself resolves once it is genuinely holding
  the lane. Nothing in `server/rpc/` changed: the lane was never wrong, the test was.

- [ ] Mempool **add/remove stream** is not real: the node refuses
  `zmqpubsequence` (documented in its `docs/RPC_LIVE_NODE.md` slice 19 — it can
  publish adds but has no clean "removed" choke point). So "realtime mempool"
  here is a 60 s verbose poll plus log-derived ingest rate, not a per-tx stream.
  The UI must not imply per-transaction add/remove events.
  **Since 2026-09-09 the payload says so itself:** `/api/mempool` carries
  `feed:{kind:'poll', cadenceSec:60, streamAvailable:false, why:…}`, naming the missing
  removal choke point, so "don't imply a stream" is a field rather than a style guide
  (`scripts/smoke.sh` asserts it). A poll-diff of successive `getrawmempool` snapshots
  would report *some* removals and is deliberately not done: it would present
  eviction as a remove only when the poll happened to straddle it, which is a fabricated
  stream with better optics.
  Re-checked 2026-09-11 on `deploy-20260910ag`: `getzmqnotifications` answers `[]`, and
  none of the 165 methods is a sequence feed (MEASUREMENTS 27).
  **Corrected 2026-09-13 -- that is a fact about THAT node, not about the feature.** Bitcoin
  Core on an Umbrel answers `getzmqnotifications` with all five publishers:
  `pubhashblock` 28334, `pubrawblock` 28332, `pubrawtx` 28333, `pubhashtx` 28336 and
  **`pubsequence` 28335** -- the per-transaction add/remove/replace stream this entry says does
  not exist. It does exist on Core; the experimental build is what lacked it. (Same shape of
  error as the `getrawmempool … depends` claim corrected in MEASUREMENTS 26b the same day: a
  true measurement on one node written up as a general limitation.)
  What is still true is that we cannot *reach* it by default: bitcoind binds `0.0.0.0:2833x`
  **inside its container**, and Umbrel publishes only 8332 to the LAN -- measured from this host,
  all five ports answer `Connection refused` while 8332 is open. So a ZMQ feed has to be an
  opt-in accelerator for operators who publish those ports, with the 20 s poll as the floor for
  everyone else. The `feed:{kind:'poll', …}` field stays honest either way; it would report
  `kind:'zmq'` when a stream is actually connected.
- [x] No per-peer **byte** counters: **closed on `deploy-20260910ag`, still
  build-dependent.** 2026-09-11 09:22:05Z: `getpeerinfo` 9 rows, and
  `getconnectioncount` 9. `bytesrecv` summed to **109,027,561** against
  `getnettotals` **109,036,122** 1.5 s later (99.992%; sent 34,804,574 vs 34,807,044),
  and again 99.997% with 8 rows at 09:23:36Z (MEASUREMENTS 27). History kept so nobody
  re-derives it: `deploy-20260907a` answered `[]` (so there per-peer bytes existed only
  in the log's `[dlc] w<N>` lines); `deploy-20260908a` gave 4 rows for 6 connections;
  the ~05:47 bench build gave 21 rows with `bytesrecv` up to 201,608,074 and a
  vendor download-worker marker, summing to 70.29% of `getnettotals`.
  **Why the ~30% "gap" vanished:** it was not filled. This build's `getnettotals`
  forgets closed peers too, so rows and total agree by both leaving them out. That is a
  divergence from Core, and it broke the rate maths (open item under Security /
  correctness). Measured on a synced node only: no download-worker rows
  (`id` ≥ 100000) were present, because the vendor download-info method was inactive.
- [ ] No per-peer **relay transaction** counts: not in `getpeerinfo` on any build
  measured (`[txrelay]` legs are the only source), and no method exposes them.
  Re-checked on `deploy-20260910ag` 2026-09-11 09:22:05Z: rows carry `relaytxes: true`,
  a per-peer boolean, and no count.
- [ ] **Three RPC sources on `deploy-20260910ag` that nothing reads yet**
  (opportunities, not features; MEASUREMENTS 27). Verified by `grep` over `server/` on
  2026-09-11: no call site for either method and no read of either field. The only
  mention is the allowlist comment admitting that vendor read method to the read-only
  console via its vendor read prefix.
  - **A vendor download-info method** (0.175 ms; read-only, shared memory). It is aimed
    at what RPC-only mode loses per MEASUREMENTS 23. By source, **not yet measured while
    active**, it would supply: the worker ban count (`banned`); per-download-peer
    identity and rate (`peers[].addr/subver/bytes_recv/bps_recv`); and the download's
    own progress (`applied`, `end_height`, `window`, `first_hole`, `staged`,
    `stall_evictions`). It does not supply the node's own ETA, disk writes, relay legs,
    the accept/reject breakdown, archive holes or `sync_failing`, so those stay
    log-only. Idle it answers `{active:false, bytes_total:0}`, so a poller can call it
    unconditionally.
  - **The build's own commit / dirty attestation fields** in `getnetworkinfo`: build
    attestation over RPC, which MEASUREMENTS 15/18/23 said did not exist. It could stamp
    provenance and history rows, and invalidate cached capability answers on change. It
    is not a reason to stop re-asking: §23 saw a counter change inside one process.
  - **`getorphantxs 1`** (~0.2 ms): `{txid, bytes, parents, age_ms}`. `parents` is the
    count of missing inputs, i.e. *why* a transaction is stuck. It is an RPC source for
    the orphan figure that is log-only today.
- [x] **The block map's cap is configured and measured.** `store.blockMapCap`
  (default 12,000) replaces the hard-coded 3,000; the cost was measured — 12,000 rows =
  **3.6 MB** (~310 B/row), so the old cap was saving ~2.7 MB while evicting blocks the
  72 h retention would have kept. Trimming is a named method (`trimBlockMap()`), evicts
  to 90% of the cap so it cannot thrash, keeps the tip, counts evictions, raises an
  info quality flag, and publishes `{size, cap, evicted, oldestHeight}` in the snapshot.
  Why it mattered: `gapSec` for the oldest surviving row is computed against the previous
  height, and after a silent eviction that predecessor was gone.
- [x] **Suppressed during IBD, with the reason in the payload.** The figure is
  difficulty × 2^32 ÷ the gap between blocks *we have*, which during IBD is the apply rate
  wearing a network label — millions of EH/s. It is withheld (`null`) when
  `initialblockdownload` is true or the node trails its own headers by more than 6, and
  `hashrateNote` carries the sentence, so the UI renders `–` with an explanation rather
  than a large orange number. A synced node still gets the figure, because there it is
  honest. (The `2^32` was missing from the estimator itself until 2026-09-12 — a separate
  defect, and one this page described correctly while the code did not: it understated the
  rate by 4.29 billion and put `0.0 EH/s` on the page. Fixed and cross-checked against the
  node's own `getnetworkhashps`, which the monitor had never read.)
- [x] **Two real nodes are wired, tested, and no longer the default.** With both
  configured the monitor was verified against production *and* a live IBD node:
  per-node series rings, the node switcher (which collapses to a single labelled
  state dot at one node), `?node=` on every state fetch, and per-node SSE filtering.
  The benchmark node was then removed from the defaults on measured grounds — RPC
  latency ~18–32 s with 90 s timeouts, 25 failed tier runs and 9+ harness restarts in
  about an hour, against production's 0 errors / ≤22 ms on the same code — and because
  polling a benchmark from the machine running it consumes the single-threaded RPC lane
  the benchmark needs (`MEASUREMENTS 21`). Multi-node stays a supported configuration:
  `config.js` carries the exact `config/local.json` block to restore it, and
  `test/config-nodes.test.js` asserts both halves — production-only by default, and
  multi-node still working when configured.
- [x] **`/api/block` and `/api/tx`, plus a drill-down panel on Chain & Sync.**
  Height or hash (blank = tip); header, `getblockstats`, and a page of 50 txids rendered
  as buttons; a transaction pane drawn from the node's own verbosity-1 decode. Two
  constraints, both about the node's single lane: **verbosity 2 is never asked**
  (measured: 11 MB of hex per block, and it still omits Core's fee fields — the fake node
  now *refuses* it so a test fails if the monitor ever asks), and no transaction hex is
  ever proxied. The fee is absent and `notReported` says why: computing it needs every
  input's prevout, N more turns on a one-threaded server, and this node omits it anyway.
- [x] **Unseen log lines are now counted *by tag*, not only by ratio.** The ratio
  said coverage had fallen; it did not say what arrived, which is the difference
  between "go read 5,000 lines" and "the node started printing `[migratetx]`". The
  monitor keeps a census of lines no rule claimed — tag, count, first/last seen, one
  sample line — publishes the top 8 in `log.unclaimed`, and raises `log-new-tag` when a
  single unknown tag reaches 25 lines **while the rest of the log still parses**
  (≥50% claimed). That second condition is what separates "the node added a subsystem"
  from "the node rewrote everything", which `log-unparsed` already covers, and better.
  Untagged lines are counted under `(untagged)` rather than dropped: a format change
  with no tag is exactly as much news. Still unparsed on purpose: one-shot `[config]`,
  `[boot]`, `[wallet]`, `[tor]`, `[serve]` lines carrying no figure any panel wants.
- [x] **History rings no longer average two daemons.** Rows are stamped with their
  node and reads are filtered via `History.forNode(id)`; `history.summary()` reports
  `unattributed` and `nodes` per ring. The measured mix this replaces: 2,308 production
  rows against 1,816 bench rows in one `peers` ring, drawn as one line, with
  `last()`/`tail()` returning whichever node wrote last (`MEASUREMENTS 20`).

  Two consequences, both deliberate:
  - **Pre-tagging history is excluded from per-node charts**, not guessed into them.
    14,177 `node` / 18,022 `peers` / 16,384 `rpc` rows stay on disk and still count in
    the unfiltered `summary()`; node-filtered reads refuse to claim them, because
    picking an owner for them would put bench traffic on a production chart. Per-node
    ranges refill from the restart: minutes for 1 h, up to a day/week for the long
    windows. That is the honest cost of having stored the wrong thing, and it is
    visible in the API rather than being discovered as missing history.
  - **One ring per series is kept**, so two nodes halve each other's reach back in
    time. Per-node rings would multiply memory per node and orphan a removed node's
    history; the trade-off is asserted in `test/node-series.test.js` rather than left
    as an opinion.
- [x] **The peer identity table exists.** The `[dl]` identity rows — user agent,
  protocol version, the peer's own height, direction — are the only such figures on a
  build where `getpeerinfo` answers `[]`, and they had been parsed, merged onto peer
  rows, and returned by the API with nowhere to be seen: data collected and dropped on
  the floor. The Peers page now has the table, flags a peer behind our tip, and says
  which source it fell back to when no identity line is in the tail window. The fake node
  was extended to print these lines, so the table is exercised by dev and smoke rather
  than existing only in theory.
- [x] **They are in the `detail` view, each with its own label — not in the
  strip.** `[dlc] ==` (the download worker's own percent, stored/total, its own ETA),
  `[utxo_live] catchup progress:` (the applying thread's), and `[dl] updating utxo`
  (validation throughput) are three threads reporting three rates; the strip's ≤60 px
  budget has no room for a fourth figure and rules 4/9 forbid merging them. They now
  appear as three separately-labelled rows behind `detail`, where "not printed by this
  build" is a possible answer and the absence is visible.

## Deliberate non-gaps (do not "fix")

- Upload rate is **not** estimated, and on the newest build there is a proof it
  cannot be: 12,896,531,244 bytes received against 1,129 sent with 21 peers
  connected. No source has it; see `docs/MEASUREMENTS.md` §4 and §15.
- Peer identity comes from the log, not from a synthesized table; see §3.
- The two sync percentages stay separate; see `docs/RULES.md` rule 9.
- The mempool scatter is absent from SSE frames; see rule 6.

- [x] **Multi-node is now exercised by the tests, not only by config.** The register
  previously said multi-node "exists in config but is only exercised with one node".
  `test/helpers/http.js` boots the real app with two fake daemons and asserts both are
  monitored, that each `/api/state?node=` answers for its own node, that the sync object
  carries the node it describes, that an optional node degrades to a note rather than a
  red app, and that an unknown node is refused on both the stream and the read model
  (`test/drilldown.test.js`). The measured 2,308-against-1,816-row mixing that motivated
  per-node rings is still the reason the assertion exists.

## Node-side issues observed (not this repo's to fix)

- `getpeerinfo` empty while `getconnectioncount` is 13 (§3): **build-dependent**.
  `deploy-20260907a` answered `[]` (2026-09-08 04:16 and 05:20), and so did the process
  running on 2026-09-09 (`[]` with 17 connections at 17:44Z, §23). `deploy-20260908a`:
  4 rows for 6 connections (2026-09-08 07:56, §18). `deploy-20260910ag`: 9 rows for 9
  connections (2026-09-11 09:22:05Z, §27).
- `getnettotals` zeroed (§4): **build- and time-dependent**. 0/0 on `deploy-20260907a`
  (2026-09-08, repeatedly). 0/0 → 23,955,131 received mid-uptime in one process on
  2026-09-09 (§23). Nonzero on `deploy-20260910ag` (109,036,122 received at 09:22:07Z
  on 2026-09-11), but it is a sum over **live** peers plus download bytes: it fell to
  89,979,098 by 09:23:03Z when one peer left (§27). That divergence from Core's
  lifetime counter is documented in the node's own source. Worth stating in its
  `docs/RPC_LIVE_NODE.md` too, because every consumer that differences it is affected.
- `getblock verbosity=2` omits `fee`/`deltafee` that Core includes, and returns
  11 MB of hex for one block (§6).
- `getrawmempool` verbose omits the ancestor/priority fields Core emits (§5). Unchanged
  on `deploy-20260910ag`: 19,014 entries, keys `vsize/weight/time/fees.base`, 0.144 s
  (2026-09-11 09:23:08Z). `getmempoolentry` does carry the full set (`depends`,
  `ancestorcount`, `fees.ancestor`, …) in 0.69 ms, per txid (§27).
- `help <method>` carries no usage text on `deploy-20260910ag`: the same boilerplate for
  every method. It is also cut at 255 characters, mid-word, for 9 of 11 sampled
  methods, which truncates the pointer to `docs/RPC_LIVE_NODE.md` it exists to give
  (2026-09-11, §27). Method safety has to be judged from the node's source.
- `getpeerinfo` **does** return rows on the 2026-09-08 03:02 bench build — but its
  `bytessent`/`bytesrecv` sum to exactly `getnettotals` (1,153 / 3,232 bytes) on
  peers last heard from 4,443 s ago, while the same run moved ~47 GB at 11.2 MB/s.
  Still control-channel-only bytes; production still answers `[]` (§11).
- The node's `[dlc]` tick prints `(median 353.4)` **with no unit**, so the monitor
  cannot report it as a rate without inventing one. If it is meant as KB/s, print
  the unit (§11).
- `console.log` is block-buffered when stdout is a file: 2,719 bytes frozen for 18
  minutes while the chain advanced ~15,000 blocks. Line flush should be unbuffered
  or line-buffered when the destination is not a tty (§11).
- The benchmark harness truncates `console.log` on restart and archives the previous
  run as `console.runNNN.log`, so a follower sees a truncation with counters back at
  zero rather than a rotation. A stable path (a symlink, or append) would let the
  monitor keep one continuous series per node.
- Production node's `[check] block data is NOT laid out monotonically (first
  break at height 964924)` warning, present repeatedly in its log: the node itself
  says truncation and pruning will refuse to run. Surfaced as `archive-hole`.
