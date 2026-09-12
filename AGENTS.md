# AGENTS.md — resuming work on bmcmonitor

Read this first, then `docs/MEASUREMENTS.md` (and, on a working copy that keeps one, the
latest file in the local `worklog/`).

This is a multi-user web monitor for the **Bitcoin Machine Code** node at
`/storage/bitcoinmachinecode`. It reads that node's JSON-RPC and follows its log,
and serves charts plus a live event feed to several users at once.

## Run it

```bash
npm start                     # port 8088, NO sign-in by default; bound to config/local.json server.hosts (this box: 0.0.0.0 since 2026-09-11; bmc-port-guard admits the LAN interface and lo, and tailscale0 for 8088 only)
BMC_MON_AUTH=1 npm start      # accounts on: login, roles, sessions, CSRF, per-user audit
BMC_MON_TLS_CERT=… BMC_MON_TLS_KEY=… npm start  # HTTPS on every listener; cookie becomes Secure
BMC_MON_LOG_SOURCE=0 npm start # RPC only: opens no log file, and says what it lost
npm run dev                   # port 18088 + an in-process fake node doing IBD
npm test                      # node:test, zero dependencies; the count in this file is generated -- see "Counts" below
node scripts/manage-users.js  # CLI user admin (list/create/passwd/role)
node scripts/pool-map.js   # refresh coinbase-tag -> pool-name labels (manual by design; see MEASUREMENTS 25)
bash scripts/smoke.sh         # boots on a spare port and asserts the API contract
```

`npm test` globs (`test/**/*.test.js`) rather than passing the directory: on Node
v22.23.2 `node --test test/` dies with `Cannot find module '<root>/test'` — the
positional is resolved as a module instead of searched for `*.test.js`. Measured
2026-09-08; `test/*.test.js` and `test/**/*.test.js` both run the whole suite.

`BMC_MON_LOG_SOURCE=0` is not a neutral switch. The monitor then opens no log file
at all, raises `log-source-disabled` naming every figure that loses its source, and
regenerates the `/api/config` provenance table so no row can claim a log source.
Whether bandwidth survives depends on the **node**, not on us — and not on which
*build* either. Measured 2026-09-08: one build answers `getnettotals` 0/0 and
`getpeerinfo []` with 17 connections, another answers 11.56 MB/s (against 11.2 MB/s in
its own log) and 21 peers with per-peer byte counts — both reporting
`subversion: /BitcoinMachineCode:0.0.1/`, so RPC cannot tell you which one you are
talking to. Measured again 2026-09-09, on one process with **no restart between the two
readings**: the daemon that answered 0/0 at 09:36 had advanced to 23,955,131 bytes
received by 17:36, while `getpeerinfo` stayed `[]`. So the honest form of the question is
"what does it read now", asked per boot and re-asked periodically; a cached answer is a
staleness bug with documentation attached. `downloadMeasured`/`uploadMeasured` are where
that re-asking lives — they gate on a *moving* counter, so a counter that never moved
renders as `–` instead of a chart of zeros claiming an idle node. The log banner remains
the only build attestation on this box (MEASUREMENTS 23).

No npm install step exists **by design** — see Rule 1.

**Access is open by default** (`auth.enabled: false`): anyone who can reach the bound
addresses reads everything, as role `viewer`. That role is a hard ceiling, not a config
value — user admin, the audit trail, password changes and every node write stay closed,
and node writes refuse to be enabled at all while accounts are off unless
`BMC_MON_ALLOW_WRITES_WITHOUT_AUTH=1` says so deliberately. Rule 23.

**Since 2026-09-11 this box binds `0.0.0.0`** (operator: "Rebind the server to 0.0.0.0").
Measured after the restart: one socket, `0.0.0.0:8088`; `/api/health` 200 over `lo` and
over the LAN address; `bmc-port-guard.sh status` unchanged -- ACCEPT on `enp14s0` and `lo`,
REJECT otherwise for 8081/8088/8443 -- so the docker bridges were still refused, by the
guard rather than the bind, and so were tailnet peers (operator: "I can't reach via
Tailscale"; the REJECT counter rose by 14 while they tried). **Also since 2026-09-11 the guard
ACCEPTs tcp/8088 on `tailscale0`** (IPv4 and IPv6), inserted before the REJECT; 8081/8443 stay
LAN-only and 8999 loopback-only. The installed `/usr/local/sbin/bmc-port-guard.sh` carries the
reasoning next to the rule; the previous version is `bmc-port-guard.sh.bak-2026-09-11`. With
accounts off, every tailnet device reads everything as `viewer` (the role ceiling still holds).
Only a real tailnet peer moves that rule's counter -- this box reaches its own tailnet address
over lo. Seen the same day: the port answers plain HTTP, not TLS, so
the "TLS only" notes below describe an earlier unit. The history, kept for the reasoning:

**This box bound the LAN address only — the tailnet address was removed on
2026-09-09** — `config/local.json` → `server.hosts = ["192.0.2.10"]`. Measured the same
day against the real config: exactly one socket, on that address. Consequences that look
like faults and are not:

- `curl http://127.0.0.1:8088/...` **refuses**, twice over: the address is not bound, and
  since 2026-09-09 the port speaks TLS only (`BMC_MON_TLS_CERT`/`_KEY` in the unit), so a
  plaintext request fails on scheme before it fails on bind. Every local check is
  `curl --cacert /etc/ssl/bmc-local/ca.crt https://192.0.2.10:8088/api/health`.
- **The bridges needed a packet filter; the bind did not do it.** The sentence that used
  to be here — "the docker bridges are not served" — was measured against a bridge
  *address* (`172.17.0.1:8088` refuses, correct) and then generalised to something the
  kernel does not do. A named-address bind selects a **destination**, not an interface:
  measured 2026-09-09 from a container on the bridge, `192.0.2.10:8088` connected, as did
  the UI and API ports beside it. What enforces it now is `BMC-MON-INPUT`
  (`/usr/local/sbin/bmc-port-guard.sh`, systemd `bmc-port-guard.service`): ACCEPT on
  `enp14s0` and `lo`, REJECT otherwise, for these four ports only, inserted *above* the
  tailscale jump in `INPUT` because `ts-input`'s second rule accepts everything arriving
  on the tunnel. It fails closed — if `enp14s0` is renamed, LAN clients get a refusal
  rather than a wider audience. Verify with the rule counters
  (`bmc-port-guard.sh status`), not with a curl from this box: traffic from a host to its
  own address arrives over `lo`, so a local curl tests the ACCEPT rule and proves nothing.
- **Tailnet peers cannot reach it.** This is the cost of the decision, and it is the
  same trap that produced "still no response" at 15:00 on 2026-09-08 — recorded here so
  the next person reads it before debugging sessions, cookies and the RPC lane.
  Measured today: `tailscaled` is up with peers installed as /32 routes in table 52
  (`ip route show table all | grep tailscale`), so the tunnel works, **but this box
  advertises no tailnet subnets** (`tailscale status --json` → `advertisedRoutes: {}`),
  so a peer has no route to the LAN /24 through here and arrives nowhere we listen.
  If a client reports "no response", the first question is *how does it reach this
  box* — from the client, `ip route get <address you are using>`; if it is not a LAN
  client, LAN-only is the answer, not a bug.
- **Getting tailnet access back** (in the honest order): add this box's tailnet address
  to `server.hosts` — multi-address bind is supported, one HTTP server per address —
  which serves tailnet clients by *destination* without serving anything else; or bind
  `0.0.0.0` (serves the bridges too, don't); or advertise `192.0.2.0/24` as a subnet
  route and approve it in the tailnet, which is a network-wide change and needs the
  operator's deliberate yes. Whichever you choose, `bmc-port-guard.sh` has to be taught
  about it: it filters on interface, so a tunnel address added to `server.hosts` while
  the guard only ACCEPTs `enp14s0` produces a monitor that is bound and unreachable —
  the failure looks identical to the tailnet being down, which is how this file got
  wrong twice.

Binding is now multi-address (one HTTP server per address; a single socket cannot
listen twice). An address missing at boot is warned about and skipped — a tunnel that
starts after us must not stop the LAN being served — and startup is fatal only when
**none** of the listed addresses exist, in which case the log prints the addresses the
machine does have. `enp14s0` is on NetworkManager, so a moved lease shows up as that
message rather than as a silent half-start.

First boot with an empty `data/` creates an `admin` account and prints its
password once. Lost it? `node scripts/manage-users.js passwd admin`.

## Layout

```
server/
  main.js            app assembly, boot, shutdown (app.shutdown), log seam (boot({log})), banner
  netinfo.js         bind planning AND CIDR membership (parseIp/parseCidr/ipDecision)
  store/audit.js     the audit trail: size-triggered rotation, chain-aware reader, stats
  config.js          defaults (wired to this box) + env overrides + validation
  rpc/client.js      THE serialized RPC lane: 1 in flight, spaced, coalesced, breaker
  rpc/allowlist.js   which RPCs the web UI may call; default deny
  collect/monitor.js tiers -> state -> read model; the log-derived sources
  collect/sync.js    the sync bar's whole data contract (pure, tested)
  collect/logparse.js  node log line parsers (pure, tested against real fixtures)
  collect/logtail.js   follower: rotation, truncation, partial-line carry
  store/ring.js      ring + CounterRate + downsampling
  store/history.js   named series + atomic snapshots
  auth/              users (scrypt), sessions (hashed tokens), rate limit
  http/              server, api routes, static, SSE hub
public/              index.html, login.html, css/, js/{app,panels,charts,fmt}.js
  js/blockpack.js    the square packer: first fit on an integer grid, area ~ vsize,
                     plus the stable re-pack. Our own implementation, inspired by
                     the look of mempool.space's block view (no code from it).
  js/feepalette.js   128 feerate bands (a geometric series from 0.1 sat/vB) and their colour ramp.
                     Both pure geometry and colour: no canvas, so unit-testable.
  js/blockscene3d.js the 3D projection, the transition planner (lanes, L-paths,
                     gravity, bounces) and the fit. Also pure.
  js/details3d.js    the renderer: canvas, rAF, hover. Per-canvas state in a
                     WeakMap -- a module-level rAF handle made two viewers on one
                     page fight over it.
                     Since 2026-09-11 tiles are Tetris cells with a metallic finish
                     (detail by size), airborne tiles cast shadows at their true
                     footprint, and all flight converges on the centre (gatherShift):
                     arrivals are born there, departures end there.
  (page #space)      the viewer at window size + being-built and tip panels
                     (renderBlockSpace in mining.js)
  js/goggles.js      the 2D treemap maps (squarify) that the 3D viewer sits beside
scripts/doc-counts.js  derives the test count the docs quote (--check / --fix)
test/                fixtures/log-samples.txt = frozen REAL log lines
test/helpers/http.js   boots the REAL app in-process: N fake nodes, log sink, TLS.
                     Touches NO process.env (rule 24) -- config via file, admin
                     password via app.bootstrap.
test/config-env.test.js  env-var config assertions ONLY; nothing boots in this file.
```

Two seams exist so tests can observe without hijacking, and both are used:
`boot({ log })` (capture log lines) and `loadConfig({ ifaces, now })` (pretend
interfaces, pretend clock). Replacing `process.stdout.write` in a test instead
silently ate another test's result line — rule 22.

## The things that will bite you

1. **The node's RPC server services one connection at a time, on one thread.**
   Never add a concurrent or per-user poll. Everything goes through
   `server/rpc/client.js`'s lane. Measured cost of getting this wrong: a bare
   `getblockcount` took **40.4 s** during initial block download.
2. **The node's log is a primary source, not a fallback — and it is also how you
   know whether the RPC can be trusted.** Re-measured four times on 2026-09-08; the
   node gave three different answers. Deployed build: `getpeerinfo []` with
   `getconnectioncount 13-17` and `getnettotals 0/0`. A 03:02 build: peer rows whose
   bytes summed to exactly `getnettotals` = 3,232 B while its log moved ~47 GB. A
   ~05:47 build: 21 rows with up to 201 MB each, `bmc_download_worker` marked, and a
   `getnettotals` delta-rate matching its own stated rate to 3%. Per-peer throughput
   and every reject/stall/hole figure are still log-only, and there is no
   `getlogevents` on either build (171 identical methods on 2026-09-08; 165 on
   deploy-20260910ag on 2026-09-11, still no log feed -- MEASUREMENTS §27). See rule 15 and
   `docs/MEASUREMENTS.md` §3, §4, §11, §15 before "fixing" a panel by adding an RPC
   call, or a `logFile` by guessing.
3. **Never fabricate a number to fill a gap.** Absent is rendered as `–` with a
   reason. `health.quality` and the Overview "what this panel cannot tell you"
   card exist for this. This mirrors the node's own documented ethos.
4. **The two sync percentages are not one number.** `blocks/headers` is what the
   bar fills with; `verificationprogress` is the node's difficulty-weighted
   estimate, drawn as a separate labelled tick. Never average or max them.
5. **`mempool.dist.scatter` stays out of the SSE snapshot.** It was 45 KB of the
   112 KB per-second frame; it is served by `/api/mempool` on its own cadence.
6. **The sync bar refuses to guess.** No ETA during IBD without a measured rate,
   and no rate at all from a window with under 60 s of span. Both rules exist
   because a guess was wrong by 2 orders of magnitude -- see README and
   `docs/MEASUREMENTS.md` §8 before loosening either.
7. **The sync header is ONE dense strip, budgeted at <=60px.** Stats are assembled
   server-side by `stripFacts()`; the browser draws one layout for every state.
   Long form is behind `detail`. A test computes the height from the CSS and fails
   if the budget breaks -- do not add rows back, add them to the `detail` view.
   Tip age is deliberately omitted during IBD (the tip block is historically old
   by definition there; it read as a 13-year stall).
8. **A chart never erases itself.** Draw only via `paint(canvas, {when, draw,
   placeholder})` in charts.js. `empty()` refuses to clear a canvas holding data
   and degrades to an opaque "no fresh data" pill instead. Data is cached per node
   (`state.byNode`); canvases are wiped in exactly one place, `switchNode()`,
   because those pixels belong to a different daemon. Never set `state.snap` or
   `state.series` to null -- that is what blanked four charts on a node click.
   Stale must be *visibly* stale: an old chart presented as live is the same sin
   as an invented number.
9. **A parsed source reports its own coverage.** Log-derived panels went silent for
   two hours twice over -- once tailing a 144-byte stub instead of `console.log`,
   once when a new build rewrote `[dlc]` so 1 line in 1,006 parsed. Both looked like
   an idle node. `log.health.ratio` (share of lines a rule claimed) is published, a
   frozen-sample test holds it at >=0.85, and `log-missing` / `log-silent` /
   `log-unparsed` fire as flags -- `log-silent` quoting the chain delta it observed
   during the silence, so it diagnoses instead of accusing. Rule 15.

10. **A test that mutates `process.env` races every other test in its file.** Node
   runs a file's top-level tests **concurrently** (verified: a sibling sees an env var
   set mid-await). `test/helpers/http.js` therefore touches no environment at all —
   config goes in a file, the bootstrap admin password comes back on `app.bootstrap` —
   and env-var assertions live in `test/config-env.test.js`, which boots nothing.
   Rule 24.

11. **Open by default is a posture, so it needs a ceiling and a loud line.** Anyone
   reaching the port reads as `viewer` — hardcoded, not configurable, not raisable.
   User admin, the audit trail and password changes 403 on the role; node writes are
   refused twice over (config load is fatal, and the route checks again). The boot
   prints who can now read and which switch closes it. Rule 23.

## Current state (2026-09-12)

A long day on the 3D engine and the browser. Everything below is committed, tested and live.

**Tetrust** (`public/js/tetris.js` rules, `public/js/tetrust.js` screen, `public/js/tetsound.js`
audio). A playable Tetris on the block-space engine. The rules file knows nothing of the screen —
no DOM, no canvas, no clock — so the whole game runs under `node:test`. The well is a `board3d`
with `still: true`; the panel behind it is a second canvas carrying the star field and galaxy at
`maxDpr: 1`. Sound is synthesised with the Web Audio API (no files, no deps) on a lookahead
scheduler that runs on the audio clock, because the page's timers are not reliable enough to keep
a tempo.

**The arcade.** 26 idle effects (was 9). The seventeen new ones are pure functions in `fxAt`;
board-level choices come from `fxHash(seed)`, never `Math.random`, so they replay identically and
are tested rather than watched. Each has a switch in `settings.js`; a test holds `FX_KINDS`, the
defaults and the panel rows to the same list in the same order.

**Finishes and lighting.** `neon` (dim solid body, lit tubes) and `sheen`, both tunable
(`neonSource` / `neonColour` / `neonBrightness`), and a `LIGHTS` table for where the lamp hangs —
Block space now ships `'overhead'`.

**The settings panel is tabbed**, with a live preview canvas that redraws on every change.

### Two bugs here that are worth remembering

1. **`render3d`'s view object is a second place options must be listed.** `neon` and `sheen` were
   in `buildScene` and in the look signature, but not in the object `render3d` builds per frame —
   so the switches drew nothing and the tests, which called `buildScene` directly, could not see
   it. If you add a render option, add it there too, and test it *through* `render3d`.
2. **`still` governs the tiles, never the sky.** It also used to return before
   `requestAnimationFrame`, so a board with a star field and no tile choreography never animated
   at all. Measured at zero repaints in three seconds before, 87 after. Ask "is it slow or is it
   stopped?" before optimising anything — the galaxy had already been optimised twice while it
   was not being drawn.

### Paint order

Tangles (strongly connected components of the overlap graph) now keep their previous frame's
relative order via an `orderMemo` the renderer keeps per canvas. Ordering them by depth alone
discarded the pair decisions inside, so a cube flying past made settled pairs swap. Replayed over
a 634-frame transition: 19 order flickers to none. The probes are in the session scratchpad
(`flicker*.mjs`, `contradict.mjs`) and want `blockpack.js` / `details3d.js` imports.

## Current state (2026-09-11)

The block-space viewer was rebuilt over 2026-09-10/11: a square packing with the
look of mempool.space's block view -- since reimplemented from scratch as
`blockpack.js` + `feepalette.js`, so the project can be Apache-2.0 -- then a 3D viewer with a
choreographed refresh (`blockscene3d.js` + `details3d.js`), shared by Overview and
Mining. Two invariants carry most of the weight and both are guarded by tests
verified to fail without them:

* **The board transform is a constant.** It depends only on the fixed square grid
  and the panel, never on the packed extent, so the board -- centred on its sphere since
  2026-09-11 -- cannot move while blocks animate. Three earlier attempts fixed the framing and left the *scale*
  varying — rule 26.
* **The camera is a constant of the board.** `risePerUnit` comes from the grid and
  the height cap, not from this round's lane stack. When it varied, the first
  paint drew cube lips ~3x too tall and they read as dark wedges.
* **Paint order is geometric, and no cube is ever see-through.** Under the oblique
  camera (the default, with a domed board) `obliqueOrder` sorts each overlapping
  pair by the axis that separates them (height, then row, then column); shadows
  paint first because they lie on the floor. Arrivals fall in from off screen
  and departures fly off it, solid and whole. A fixed "airborne last" rule and alpha fades were what made
  landings look like ghosts sliding through each other (2026-09-11).

Also fixed here: `layoutTreemap` fed squarify the server's **feerate** order when
squarify requires descending **areas**, so the 2D maps packed slivers (45 rects
over 10:1 on a live 401-cell template, worst 49:1). Every fixture in the suite was
already size-descending — the one order the bug handles correctly.

Non-negotiable in this code: no `ctx.clip()`, no `ctx.globalAlpha`, no composite
modes. Software rasterisers drop them silently, and that blanked the map once.

The deployment is **plaintext on one LAN address** by operator decision, and the
LAN is ethernet only — never a tunnel. A reachability failure on this box is far
more likely ARP flux on a dual-homed host than anything about certificates.

## Current state (2026-09-09)

Later on 2026-09-09 the access posture changed: **sign-in is opt-in**
(`BMC_MON_AUTH=1`), anonymous visitors read as `viewer`, node writes need two explicit
yeses, and the CLI this file documents for password recovery turned out not to parse —
fixed, with a guard so no shipped file can hide that again (rules 23 and 24).

Earlier on 2026-09-09 the defect register was worked through: TLS became an option, the CIDR
gate computes on bytes, the audit log rotates, scrypt upgrades on login, `/api/login`
is throttled per address, `style-src-attr` is gone, pages carry a build id, `/api/block`
and `/api/tx` exist, the block-map cap is measured, IBD suppresses the hashrate
estimate, `[dl]` peer identity has a table, and the breaker says who opened it. Seven
entries closed, three new ones found and fixed (2026-09-09). Tests 183 →
263; smoke 60 → 92.


Working and verified against a real mainnet node (both a live IBD on the bench
node and the synced production node): config, RPC lane with coalescing,
priority, adaptive cadence and skip, log parser and tail with rotation, rings +
atomic snapshots, sync model, auth (scrypt/sessions/CSRF/lockout), RBAC,
default-deny RPC allowlist, gated actions, audit log, SSE hub with per-client
coalescing, static server with realpath containment, all eight pages, login
page, CLI user admin, systemd unit, fake node for dev. Log-derived sources report
their own coverage (`log.health.ratio`) and flag a tail that is missing, silent, or
no longer matching any rule.

Watches **production only** by default (`bmc-main`); multi-node is supported via
`config/local.json` and was verified against two live nodes, but the benchmark node was
dropped from the defaults on measured grounds — see `MEASUREMENTS 21` and the comment in
`server/config.js`.

### Render against live data, not just geometry

`npm run render:live` drives the Mining page renderers under the DOM stub with the running
monitor's own responses. It exists because two real defects survived a green suite: the
treemap's draw path referenced a `label` that was never destructured (every partly-filled
block threw and the canvas stayed blank), and its tween re-requested animation frames
whenever the clock failed to advance, recursing until the stack gave out. Neither is
visible to a test of the layout maths. Layout, the note text beside a chart, and the code
that actually paints are three different obligations; assert each one. A test that renders
real-shaped data would also have caught the note block that passed `node --check` while
being unable to run.

### Counts, and why they are generated

`npm test` = 684 tests. `bash scripts/smoke.sh` = 109 checks against a real server.

`npm run counts:fix` writes the test count into `README.md` and `AGENTS.md` from the
suite itself. Do not type it by hand. The old guard compared README with AGENTS and so
could only prove the two were wrong together — it passed while the docs said 180 and
`npm test` printed 183 (rule 21). `test/doc-counts.test.js` derives the number from the
declarations in `test/`, and validates that derivation by running three files through
`node --test` and comparing the reporter's count with the scanner's.

The smoke count is the one number here that is still typed by hand (60 before
2026-09-09; the new checks cover the build stamp, CSP nonce, login throttle,
drill-down routes, audit budget and breaker telemetry).

Still open: see `docs/DEFECTS.md` — six items, and each one says why it is still open.
Four are node-side (mempool add/remove stream needs the `zmqpubsequence` the node
refuses; per-peer byte and relay counts are not in `getpeerinfo` on the deployed
build; the restart storm belongs to whoever owns the deploy). One is a deliberate
non-change (per-tier circuit breakers — the policy is unchanged, but `rpc.breaker`
in telemetry now answers which method opened it and what it froze). One needs a
browser engine: layout, CSS cascade and real `EventSource` reconnect behaviour. TLS,
by contrast, is no longer open: TLS is available (see README, "TLS: the lack of it was
a gap, not a trade-off"), and the plaintext default is now a boot-time warning rather
than a footnote. The licence is Apache-2.0 (`LICENSE`, `NOTICE`).

## Conventions

- Zero dependencies. Node builtins and hand-written canvas only.
- Every claim about the node in a comment must be a measurement, with the number
  and the date. "Seems slow" is not a justification.
- Rules in `docs/RULES.md` cite the defect that produced them.
- Working notes are dated files in `worklog/`, which is git-ignored: kept on the working
  machine, never published. Newest work at the bottom of the day's file, unfinished items left as `- [ ]` on purpose.
