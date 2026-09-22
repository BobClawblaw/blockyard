# AGENTS.md — resuming work on BlockYard

Read this first, then `docs/MEASUREMENTS.md` (and, on a working copy that keeps one, the
latest file in the local `worklog/`).

This is a multi-user web monitor for a **Bitcoin Core** node. It reads the node's
JSON-RPC (a log follower exists, but it does not understand Core's log -- see below), and
serves charts plus a live event feed to several users at once. This box watches the node configured in `config/local.json` / the unit's
`BLOCKYARD_NODE_*` environment.

## Releases while the wallet is unfinished

The administrative suite (`server/admin/`, `docs/PLAN-ADMIN-SUITE.md`) **does not ship**.
It can spend money and has not had a security review, so every release artifact excludes it
and `test/release-guard.test.js` fails if one stops doing so. Release the monitor as normal:
`npm pack` produces the read-only edition, the container image excludes the suite through
`.dockerignore`, and `scripts/build-edition.js --edition admin` refuses to build without
`--unreleased` (and marks what it builds `private`, so it cannot be published). A released
build that is asked for the suite explains that it is not in this build rather than
ignoring the setting.

## Run it

```bash
npm start                     # port 21000; SHIPS bound to 127.0.0.1 with sign-in ON (2026-09-15) -- this box overrides both in config/local.json (0.0.0.0 since 2026-09-11, auth off; the host's port-guard script admits the LAN interface and lo, and tailscale0 for 21000 only)
BLOCKYARD_AUTH=0 npm start      # open mode: no sign-in, anyone who can reach the bind reads as `viewer`
BLOCKYARD_TLS=0 npm start        # plain HTTP (HTTPS is the default since 2026-09-15, with a certificate the server makes itself under data/tls)
BLOCKYARD_TLS_CERT=… BLOCKYARD_TLS_KEY=… npm start  # your own certificate instead of the made one
BLOCKYARD_LOG_SOURCE=0 npm start # RPC only: opens no log file, and says what it lost
npm run dev                   # port 18088 + an in-process fake node doing IBD
npm test                      # node:test, zero dependencies; the count in this file is generated -- see "Counts" below
node scripts/manage-users.js  # CLI user admin (list/create/passwd/role)
npm run setup                 # a fresh machine: check the node, write config/local.json, build the index (scripts/setup.js)
npm run check                 # the same checks against every configured node (scripts/check.js); exit 1 on a FAIL
node scripts/pool-map.js   # refresh coinbase-tag -> pool-name labels (manual by design; see MEASUREMENTS 25)
node scripts/index-build.js --out <dir> --workers 16   # the address index by hand, from the node's blk/rev files (30 min, 124 GB; MEASUREMENTS 28-30); name it as addressIndex in the node's config. Since 2026-09-14 the SERVER builds a missing one itself on start, in the background, unless addressIndexBuild: "manual"
node scripts/index-benchmark.js   # check a built index against the node (scantxoutset) and time lookups
bash scripts/smoke.sh         # boots on a spare port and asserts the API contract
```

`npm test` globs (`test/**/*.test.js`) rather than passing the directory: on Node
v22.23.2 `node --test test/` dies with `Cannot find module '<root>/test'` — the
positional is resolved as a module instead of searched for `*.test.js`. Measured
2026-09-08; `test/*.test.js` and `test/**/*.test.js` both run the whole suite.

**LOG PARSING IS NOT AVAILABLE FOR BITCOIN CORE.** Measured 2026-09-13: every structured rule in
`collect/logparse.js` keys on tags an experimental node emits -- `[dlc]`, `[dl]`, `[dial]`,
`[utxo_live]`, `[config]` -- and `TS_RE` wants `YYYY-MM-DD HH:MM:SS.mmm `, which is not the
`2026-09-13T01:30:00Z` Core writes. Fed real Core `debug.log` lines the parser returns
`kind: "raw"` with **no structured fields** and a timestamp that fell back to *now* rather than the
line's own time, so rows would appear in the feed at the wrong moment. The same lines from the
experimental node return `kind: "bandwidth"` with six fields. Both fixtures in `test/fixtures/` are
experimental-format; no Core log has ever been tested against this parser.

So: the log source is OFF by default and must stay off against Core. Turning it on buys nothing and
costs a misdated event feed. Supporting Core means writing Core fixtures first, then rules for
Core's own lines -- not flipping a switch.

`BLOCKYARD_LOG_SOURCE=0` is therefore the normal, supported mode, not a degradation. The monitor
opens no log file, raises `log-source-disabled` naming every figure that loses its source, and
regenerates the `/api/config` provenance table so no row can claim a log source.

The measurements below are from the experimental node and are kept because the REASONING still
applies to any node whose RPC under-reports -- they are not claims about Core. Measured 2026-09-08:
one build answers `getnettotals` 0/0 and `getpeerinfo []` with 17 connections, another answers
11.56 MB/s (against 11.2 MB/s in its own log) and 21 peers with per-peer byte counts -- both
reporting the same non-Core subversion string, so RPC cannot tell you which one you are talking to.
Measured again 2026-09-09, on one process with **no restart between the two readings**: the daemon
that answered 0/0 at 09:36 had advanced to 23,955,131 bytes received by 17:36, while `getpeerinfo`
stayed `[]`. So the honest form of the question is "what does it read now", asked per boot and
re-asked periodically; a cached answer is a staleness bug with documentation attached.
`downloadMeasured`/`uploadMeasured` are where that re-asking lives -- they gate on a *moving*
counter, so a counter that never moved renders as `–` instead of a chart of zeros claiming an idle
node.

No npm install step exists **by design** — see Rule 1.

**Access is sign-in by default since 2026-09-15** (`auth.enabled: true`, bound to `127.0.0.1`;
the first outside review of 0.0.9 called out the open wildcard default). Open mode
(`auth.enabled: false`) is a choice: anyone who can reach the bound addresses reads
everything, as role `viewer`. That role is a hard ceiling, not a config
value — user admin, the audit trail, password changes and every node write stay closed,
and node writes refuse to be enabled at all while accounts are off unless
`BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH=1` says so deliberately. Rule 23.

**THE PORT MOVED TO 21000 on 2026-09-13** (operator: "make default web port 21000 for access").
`server.port` now defaults to 21000, the unit sets `BLOCKYARD_PORT=21000`, and
the host's port-guard script was rewritten so 21000 takes 8088's place in every rule -- ACCEPT on
`enp14s0` and `lo`, ACCEPT on `tailscale0`, REJECT otherwise; 8081/8443 and loopback-only 8999
are untouched. Verified after the restart: 21000 answers on `lo`, 8088 no longer connects, and
the jump is installed on v4 and v6. **Everything below this line that says 8088 is a record of
what was measured on 2026-09-09/11, when that was the port. Those numbers are left as they were
measured rather than rewritten -- the reasoning is what makes them worth keeping.**

**Since 2026-09-11 this box binds `0.0.0.0`** (operator: "Rebind the server to 0.0.0.0").
Measured after the restart: one socket, `0.0.0.0:8088`; `/api/health` 200 over `lo` and
over the LAN address; the port guard's `status` unchanged -- ACCEPT on `enp14s0` and `lo`,
REJECT otherwise for 8081/8088/8443 -- so the docker bridges were still refused, by the
guard rather than the bind, and so were tailnet peers (operator: "I can't reach via
Tailscale"; the REJECT counter rose by 14 while they tried). **Also since 2026-09-11 the guard
ACCEPTs the monitor port on `tailscale0`** (IPv4 and IPv6; tcp/8088 then, tcp/21000 since
2026-09-13), inserted before the REJECT; 8081/8443 stay
LAN-only and 8999 loopback-only. The installed port-guard script (in `/usr/local/sbin`, outside this repo) carries the
reasoning next to the rule; its previous version is kept beside it, dated 2026-09-11. With
accounts off, every tailnet device reads everything as `viewer` (the role ceiling still holds).
Only a real tailnet peer moves that rule's counter -- this box reaches its own tailnet address
over lo. Seen the same day: the port answers plain HTTP, not TLS, so
the "TLS only" notes below describe an earlier unit. The history, kept for the reasoning:

**This box bound the LAN address only — the tailnet address was removed on
2026-09-09** — `config/local.json` → `server.hosts = ["192.0.2.10"]`. Measured the same
day against the real config: exactly one socket, on that address. Consequences that look
like faults and are not:

- `curl http://127.0.0.1:8088/...` **refuses**, twice over: the address is not bound, and
  since 2026-09-09 the port speaks TLS only (`BLOCKYARD_TLS_CERT`/`_KEY` in the unit), so a
  plaintext request fails on scheme before it fails on bind. Every local check is
  `curl --cacert <the host's local CA certificate> https://192.0.2.10:8088/api/health`.
- **The bridges needed a packet filter; the bind did not do it.** The sentence that used
  to be here — "the docker bridges are not served" — was measured against a bridge
  *address* (`172.17.0.1:8088` refuses, correct) and then generalised to something the
  kernel does not do. A named-address bind selects a **destination**, not an interface:
  measured 2026-09-09 from a container on the bridge, `192.0.2.10:8088` connected, as did
  the UI and API ports beside it. What enforces it now is the port guard's own
  iptables chain (the script in `/usr/local/sbin` and its systemd unit, outside this repo): ACCEPT on
  `enp14s0` and `lo`, REJECT otherwise, for these four ports only, inserted *above* the
  tailscale jump in `INPUT` because `ts-input`'s second rule accepts everything arriving
  on the tunnel. It fails closed — if `enp14s0` is renamed, LAN clients get a refusal
  rather than a wider audience. Verify with the rule counters
  (the guard's `status`), not with a curl from this box: traffic from a host to its
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
  operator's deliberate yes. Whichever you choose, the port guard has to be taught
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
  rpc/client.js      THE RPC lane per node: up to rpc.maxInFlight in flight (4 by default), starts spaced, coalesced, breaker
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
  js/lightning.js    a bolt's shape from a seed, a stroke's life from the clock (pure; the lightning ball)
  js/gl2d.js         the WebGL renderer: the viewer's Canvas 2D subset on WebGL2 (appearance.renderer)
  js/goggles.js      the 2D treemap maps (squarify) that the 3D viewer sits beside
  js/x86.js, dospc.js, soundcard.js, dosworker.js, dosaudio.js, dosio.js, dosgame.js, wolf3d.js, doom.js, quake.js
                     the DOS Diversions: an i386 interpreter, the PC (real-mode DOS for Wolf3D,
                     DOS/4GW for DOOM, go32 + CWSDPMI for Quake), a Sound Blaster Pro 2 + OPL3, the worker, the
                     AudioWorklet, pure I/O helpers, the shared tab and each game's own.
                     The game files are games/wolf3d_dos/, doom_dos/ and quake_dos/, served by http/games.js.
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

1. **Everything goes through `server/rpc/client.js`'s lane, one per node.** Never add a
   poll outside it, and never a per-user one. The lane keeps at most `rpc.maxInFlight`
   calls in flight (4 by default; both Core and bmc serve calls in parallel, MEASUREMENTS
   §40), with starts spaced. A node that really is single-threaded sets
   `"rpc": {"maxInFlight": 1}` on its own entry. Measured cost of getting this wrong: a bare
   `getblockcount` took **40.4 s** during initial block download.
2. **The node's log is a primary source, not a fallback — and it is also how you
   know whether the RPC can be trusted.** Re-measured four times on 2026-09-08; the
   node gave three different answers. Deployed build: `getpeerinfo []` with
   `getconnectioncount 13-17` and `getnettotals 0/0`. A 03:02 build: peer rows whose
   bytes summed to exactly `getnettotals` = 3,232 B while its log moved ~47 GB. A
   ~05:47 build: 21 rows with up to 201 MB each, a download-worker marker present, and a
   `getnettotals` delta-rate matching its own stated rate to 3%. Per-peer throughput
   and every reject/stall/hole figure are still log-only, and there is no
   `getlogevents` on either build (171 identical methods on 2026-09-08; 165 on
   deploy-20260910ag on 2026-09-11, still no log feed -- MEASUREMENTS §27). See rule 15 and
   `docs/MEASUREMENTS.md` §3, §4, §11, §15 before "fixing" a panel by adding an RPC
   call, or a `logFile` by guessing. (All of this was measured on the experimental node; on
   Core the log source stays off and per-peer bytes come over RPC -- see the log note above.)
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

11. **Open mode is a posture, so it needs a ceiling and a loud line** (it was the default
   until 2026-09-15; now it is chosen). Anyone reaching the port reads as `viewer` — hardcoded, not configurable, not raisable.
   User admin, the audit trail and password changes 403 on the role; node writes are
   refused twice over (config load is fatal, and the route checks again). The boot
   prints who can now read and which switch closes it. Rule 23.

## Current state (2026-09-21): two renderers, Software and WebGL

**Every 3D board, sky and effect draws on either renderer** (operator: "a second rendering option to
blockyard for WebGL rendering, and port all existing effects over to the new system. Supporting
either WebGL or Software rendering"). Not thirty-five effects rewritten as shaders: everything
already drew through ONE seam, the context `render3d` hands `paintFrame`, so that seam exists twice.
`public/js/gl2d.js` is the Canvas 2D subset the viewer uses, on WebGL2; `surfaceFor` in
`details3d.js` picks per frame. Setting: `appearance.renderer` (`'software'` shipped, `'webgl'`);
`options.renderer` overrides it per canvas. What will bite:

- **An effect is still written once, against the 2D API, under the same rules** (no clip, no
  globalAlpha, no composite modes). If it needs a call gl2d.js does not have, add it THERE, with a
  test, rather than branching the effect. The one branch that exists is `softStops`: on GL it is
  one radial-gradient fill instead of two hundred nested discs (same cumulative alpha by
  construction). `ctx.gl2d` is the flag.
- **A native Path2D cannot be read back.** The two caches that used one (drawGround's layers, the
  price line's CURVE) ask `ctx.createPath()` when it exists; a Path2D handed to the GL context is
  refused, not drawn wrong.
- **Overlap is the whole difficulty.** A 2D fill or stroke paints each pixel once however its
  pieces overlap; triangles do not. Convex outlines, opaque paint, specks (<= 6 px: stars, the
  pulsar's dots), hairlines (<= 1.5 px) and single thin outlines (the seam round a cube, as a
  non-overlapping mitre strip) batch directly; everything else goes through the stencil. Getting
  this wrong is SLOW, not ugly: the first cut stencilled every cube seam, 2,372 draws a frame;
  it is 20-400 now. `node scripts/gl-compare.mjs --trace` names the call sites that stencil.
- **A one-point subpath draws nothing** (closePath leaves one behind every outline; the 2D context
  drops it too). Counting it as a round-capped dot was the 2,372.
- **The GL canvas goes DIRECTLY UNDER the board canvas, same stacking layer, document order**
  (`layerUnder`), glued to its box every frame, copying its CSS transform. Never raise the board
  canvas with a z-index: Tetrust's sky canvas would sit over the well and the play button and take
  every click. The Formation's overlay uses the same helper now. The board canvas stays, clear,
  and keeps the pointer; its CSS background is let go and restored.
- **Whoever reads pixels back keeps Software**: Scorched Yard's land (`fluidFloor`) and sky
  (scorchedwind.js) pass `renderer: 'software'`. A new getImageData on a board canvas needs the same.
- **A cached bitmap drawn with drawImage carries a `__v` stamp** (gasLayer, the Living sky's dome),
  bumped when it is repainted; unstamped sources are uploaded on every draw.
- **Fallback is silent and final per canvas**: no WebGL2, a compile failure, a lost context.
- **WebGL has a finish Software cannot have** (operator: "The WebGL should look much better than the
  software renderer"): with `appearance.glow` > 0 the frame is drawn into a multisampled target,
  what is EMISSIVE is blurred at three sizes and added back (bloom), and the result is dithered.
  **Emissive is marked, not guessed**: `ctx.emissive` (paintFrame turns it off round the cubes and
  the day sky) feeds a second render target. The first cut bloomed by brightness and turned every
  yellow cube into a lamp -- a cube's colour is the feerate, DATA, and must come out as drawn.
  Glow 0 is the Software picture and is what the parity check runs at.
  **The glow is BOUNDED and SCREENED on, and there is no brightness rule.** Added straight, a neon
  game board (every tube of every piece a lamp) summed past white and the pieces lost their colours;
  a "near-white is light" rule lit the Earth sky's clouds into blown-out blobs; the ground's FILLS
  (the floor, its haze) bloomed the whole background -- only its lines are lamps (`drawGround`).
  All three were found by LOOKING (`gl-compare.mjs --look`), none by the pixel check, which runs at
  glow 0: a change to the finish is not verified until somebody has looked at a neon board, the
  Earth sky and the price line with glow on.
- **Measure at the panel's real size** (`--size 2560x1300`): Software scales with the pixels and
  WebGL barely moves, so a 720x450 panel flatters Software. 2026-09-21, RTX 5090, ms a frame
  Software -> WebGL: rest 29.6 -> 3.3, supernova 90.5 -> 10.3, pulsar 68.1 -> 9.7, black hole 37.3 -> 15.3.
- **Speed is in three places, all measured on the profile** (`gl-compare.mjs --profile --gl-only`):
  gradients are rows of a 64-texel ramp ATLAS keyed by a numeric hash, so they batch (a supernova
  was 400 draws with 32-stop uniform uploads each); whole circles, ellipses and round dots are ONE
  QUAD with the rim computed per pixel (`discQuad`), not a fan of up to 280 triangles; and the
  supernova's half-size plume layer is skipped on GL (a 2D canvas rasterised and uploaded every
  frame is the opposite of an economy there). `rgba(r,g,b,a)` is parsed by character code.
  Measured 2026-09-21 on an RTX 5090, 720x450, ms a frame Software -> WebGL: supernova 21 -> 14,
  fireworks 14 -> 7, pulsar 30 -> 26, black hole 23 -> 14 once its strips were triangulated.
- **The resting board is kept on the graphics card** (`ctx.retained(id, same, fn)` in gl2d.js; paintFrame
  wraps the ground, grid, wall and cubes). `sameBoard` compares this frame's ops with the last
  frame's VALUE FOR VALUE -- a hover glow, a tint, a lift all arrive as different ops -- so "the
  same" is measured, never assumed; only effects the GRID draws a part of (ripple, outline, tide,
  the ball) force it live, so a supernova plays over a kept board. Anything not replayable from
  vertices (a texture, a two-circle gradient) marks the segment bad and it draws live for ever.
  Resting Block space on the 5090: 7.3 -> 3.8 ms (software 12.8). What is left is the star field.
  If you add a board input that is NOT in the ops (a new grid option read from `view`), add it to
  sameBoard or the board will not repaint.
- **The star field and the pulsar's gas LIVE on the card.** `ctx.starField`: a star's constants go up
  once (keyed on the `bk` bucket record, which is rebuilt exactly when the stars or colours are),
  the turn, twinkle and shade are the vertex shader's, one instanced draw. Twinkle frequencies are
  snapped to whole turns in `STAR_BEAT` so the clock can wrap (a float32 stutters on a big clock).
  `ctx.particles`: state in two buffers, stepped with TRANSFORM FEEDBACK, drawn as instanced discs;
  the effect supplies `simulate` and `look` as GLSL. **`PULSAR_GLSL` is drawPulsar's particle block
  term for term: change one, change both.** Its dice are the card's (an INTEGER hash -- `fract(sin)`
  on a float32 clumped 27,000 particles on to a few lanes), so GL shows the same wind, not the same
  dots. Either returns false where it cannot run and the ordinary path draws instead. Measured on
  the 5090: resting Block space 11.0 -> 2.9 ms (about 1k vertices a frame left), pulsar 26 -> 8.
- **Per-puff overhead, not physics, was the supernova's cost**, so it was NOT ported to GLSL (its nine
  clouds each carry a JS colour function; a second copy of each would have to be kept in step).
  Instead: a whole-turn arc's outline is lazy (`WholeTurn`: a disc is one quad and nothing read the
  hundred points), `gasBlobs` keeps a cloud's seed-only layout, stops go to the GL gradient as
  `[r,g,b,a]` arrays instead of strings to parse back, and `bakeRamp` steps span by span.
- **A recorded path keeps its stroke triangles per pen** (`path.strokes`, dropped when it is flattened
  again), and the resting price line is a retained segment keyed on `CURVE.key` (`WIRE_SIG`).
  Resting Markets on the 5090: 10.4 -> 2.9 ms, 37k -> 2k vertices a frame.
- **A concave fill is triangulated, not stencilled**, when it is one outline that does not cross
  itself (`earClip`: a ribbon test first -- the black hole's forty ring strips close on themselves
  with a zero-width seam no ear clipper accepts -- then ears, and either way the triangles' area
  must equal the outline's or it is refused and the stencil does it). Black hole: 105 draws and 41
  stencil passes a frame -> 30 and 4.
- **`ctx.gl2d === true`, never truthy**: the suite's catch-all Proxy stubs answer every property
  with a function.
- **The Formation's GL layer is a FIELD, not particles** (`formgl.js` v3; operator, with the film open:
  "It looks nothing like the reference material ... the pinks, purples, oranges"). v1/v2 were blue
  sprites because nobody had LOOKED at the film; its main view is gas density through a magma ramp.
  One fragment shader: halo x warped ridged noise (wisps, a finer tangled layer), streams sampled at
  direction * r^k and bent hard by the warp (straight down the radius they were a sunburst round a
  dark hole), a rigid-pattern log spiral (a differential turn wound the arms into rings), satellites
  as knot + haze. **Gas tops out at orange; only stars reach pale yellow** (two tone curves), and
  the corners fall to black. `precision highp int` is REQUIRED: a fragment shader's ints are
  mediump, the hash is 32-bit, and without it the picture is television static. It declines on a
  software rasteriser (`isSoftwareGl`: 0.11 ms a frame on the 5090, 64 ms on SwiftShader) and a
  declined layer stands down for good (`FORM_DEAD`) with the frame's background painted.
  **The gas is ADVECTED, not slid** (operator: "I'm not seeing any shifting of the filaments"): two
  layers half a life apart, each pulled in and swirled from rest and cross-faded (weights sum to
  one), on the WALL clock so speed 0 still flows, phases computed in doubles on the CPU. Keep the
  warp's churn SLOW (`FLOW_CHURN`): ridged noise decorrelates under a small warp change, and at
  five times this rate features lost their identity in two seconds -- boiling, not flowing.
  `form-preview.mjs --times 100000,101000,102000 --speed 0` prints how much of the picture moved.
  It is measured against the PANEL'S aspect (`wide`, `pe`), not its short side, or a wide board gets a
  disc with empty sides. What says "flowing": clumps that RUN down the streams (noise sampled at
  direction x (radius + phase)), a small jostle on the gas's position (`pj` -- never on the galaxy or
  the satellites, which are placed from `p`), wakes laid where a satellite HAS BEEN, and ragged
  outburst shells from the galaxy (bipolar, along its minor axis) and from each satellite (a thin
  even ring reads as a donut: keep them broad and torn by the smoke). A backtick inside the GLSL
  template's comments ends the template. Judge it
  by looking: `node scripts/form-preview.mjs --gpu vulkan --times 200000,201000,202000`, next to the film.
  **It is PERPETUAL** (operator: "have the scene perpetually evolving. don't fade it out"): no loop
  fraction, no envelope. The galaxy is grown and breathes (`BREATHE`); each satellite lives its own
  wall-clock life out of step with the others and is reborn on ANOTHER orbit (its life number is in
  every hash); phases are doubles on the CPU, fractions on the card. **Satellites move the gas, they
  are not drawn over it**: the smoke's sampling place is turned round each one and dragged along its
  path (`STIR`, `DRAG`, and weaker at three places it has just been) BEFORE the smoke is looked up --
  a knot laid over the smoke passes through it like a ghost. A wake sample is never narrower than
  the gap to the last, or a fast outer satellite trails a string of beads.
  Its galaxy sits in the middle or a corner (`sky.formAt`, `FORM_PLACEMENTS`: the Galaxy sky's five
  places and fractions, plus a scale -- in a corner the scene is drawn 1.55x, or the far half of the
  panel is empty). A satellite ARRIVES: born beyond the frame (`SAT_R0`), its cloud eased up over
  nearly half its life, its knot condensing later; born inside the frame it popped.
  **Its shipped place, level and pace are the OPERATOR'S OWN saved settings** (2026-09-21: "It was
  originally too bright and was threatening to overpower the chart"): `formAt` top-left (bottom-left since 2026-09-22, and the Markets board's shipped sky is the Formation: "make formation the default 3d background view for markets. default position bottom left"), `formFlow` 0.5,
  `formSpeed` 0.4, and since 2026-09-22 `formPalette` cobaltGold at `formBrightness` 1 (it was magma at
  0.8: the blues do not fight the chart, so the full picture can stand) -- a sky behind a chart, not a
  film in front of one. They are one set of numbers (settings.js DEFAULTS.sky == formgl.js FORM_*_DEFAULT, pinned).
  **Thirteen palettes** (`FORM_PALETTES`, picker `sky.formPalette`, the shader's ramp a UNIFORM so a palette is
  a setting and not a recompile; the fallback wears it too). The chart is the most important thing on the
  board, so a palette is judged in NUMBERS against the chart's real colours (`node scripts/form-palettes.mjs`:
  CIELAB distance over the gas range to #1fc98a, #ef4d5e and the yellow line): the film's magma is 23 from the
  candles' red, every other one >= 46 from everything, and a test holds them there. `settings.js` imports the
  labels from formgl.js -- which the SERVER loads too, so formgl.js must stay free of DOM at module level.
  Two sliders: `sky.formBrightness` (1 = the picture as first made; it scales the COLOUR --
  scaling the tone slides orange down the ramp to magenta) and `sky.formFlow` (the gas's own pace;
  `formSpeed` is how fast the galaxy and satellites LIVE). **Both clocks are INTEGRATED in the layer's
  state, never `now x speed`**: that clock jumps when the speed changes -- an hour in, 1.0 -> 1.1 is six
  minutes of scene per tick of the drag. A fresh layer still starts at now x speed, so a first frame
  is a pure function of the clock.
  **The no-GPU fallback (`galform.js`) was brought along**: perpetual (assembles once, then stays,
  the disc turning on `gasAt`'s extraSec and the fountains going round their two windows), placed by
  the same `formAt`, and tinted through `formRamp` -- ONE ramp, `FORM_RAMP`, from which the shader's
  magma() is GENERATED. It has no satellites and no smoke: those are a field's, this is 9,000 dots.
- **The Galaxy sky's gas is BAKED BY A SHADER on WebGL** (`ctx.bake` in gl2d.js: a fragment shader run
  once into a texture that `drawImage` then draws like any bitmap; `GAS_GLSL` + `gasLayerGl` in
  details3d.js). Same nine clouds and fourteen lanes from the same seeded lists (they carry `size` now),
  each laid ALONG its arm (a log spiral's pitch is one angle: atan2(1, GALAXY_TWIST)), its envelope
  WARPED as well as its inside, hollows cut in it, dust that ABSORBS. The tints are dark paint made to
  be laid thirty times over; laid once they must be normalised to full strength or the clouds are grey.
  Software keeps the bitmap of ellipses. So the two renderers now DIFFER on this sky by design (mean
  4-7 of 255): the parity check passes `glSky: false` so it still compares like with like, and
  `--look` shows the clouds. `sky.galaxySpin` paces the turn, integrated on the field.
  The same bake lays THE LIGHT BETWEEN THE STARS -- a blue-white haze along the same log spiral, a warm
  bulge held under 0.4 (this sky stands behind a chart) -- stars are POINTS OF LIGHT (`uSoft`: a gaussian
  core holding the square's light, sub-pixel stars widened and dimmed so they do not flicker as the disc
  turns, halo and diffraction spikes on the giants in the shader, no 2D glints on top), and far galaxies
  are gradient smudges. All of it is `glSky`; `glSky: false` is the 2D canvas's sky on WebGL (parity).
  **A shader that fails to compile falls back SILENTLY**: `patch` is a GLSL reserved word, the bake
  died, and the old ellipses came back looking like "nothing changed". The log now goes to the console
  and to `window.__blockyardGlErrors`, which gl-compare reports as an ERROR.
- **The price line's halo is a SOFT STROKE on WebGL** (operator: "looks banded in WebGL ... a subtle emissive
  glow instead"). Its glow is three flat strokes, 30/18/10 wide: a fall-off in three steps, which the 2D
  canvas's antialiasing smears and GL's crisp edges show as bands. `ctx.softStrokeMin` (set by priceLine, let
  go after it) makes any stroke that wide AND faint fade across itself in the shader (flag 4 in the disc
  word, beside 1 disc and 2 emissive), through `softStrokeGeometry`: a FAN on the outside of each bend, one
  mitre point inside, half-fans at the ends. A plain strip has one point per corner and stood a little
  flame on every peak of the chart. A GRADIENT paint that is faint all the way along is soft too (the
  energy pulse paints the halo along its length; it used to fall to the stencil, banded, while it ran).
  Found by zooming in, isolated by switching the glow off
  (`softGlow: false`, which the parity check also passes).
- **TWO BALLS, AND THE NAMES ARE CROSSED.** The operator's "lightning ball" / "ball lightning" is the STORM BALL
  (agents.js `stormball`, on both boards): it throws the bolts. His "plasma ball" is `ball` (details3d.js `drawBall`,
  Block space only, Settings now says "Plasma ball"): the sphere tracing the grid, and since 2026-09-22 it throws NO
  bolts ("Only the lightning ball should emit lightning bolts ... this is the one", with a picture of the storm
  ball). The first day's lightning work went on the wrong one. When he names a ball, ask for a screenshot.
  The storm ball's CRACKLE is held tendrils from the clock (`strokesAt`, twelve slots, forked, a bead at the tip) --
  it was fourteen hairs re-rolled from Math.random every frame -- and its orbiting dots are sixteen sparks on three
  tilted orbits with tails, passing behind the ball and in front of it. On Markets its run starts and ends beyond the
  PANEL's edge, measured from `st.lastFit` (`pw` is in it for this): the Markets canvas is far wider than its board.
- **Lightning is a CHANNEL THAT HOLDS ITS SHAPE** (`public/js/lightning.js`, pure; the storm ball draws it; what follows about the "lightning ball" drawing it in cells was `drawBall`, whose bolts are gone).
  The ball used to re-randomise six-point zig-zags every frame -- at 60 fps that is fuzz, not lightning.
  `boltShape(seed, A, B)`: midpoint displacement (tortuous at every scale) plus forks that leave the parent
  early, shorter, and thin by the SQUARE of their weight. `strokesAt(now, seed)`: five slots out of step, each
  firing a NEW bolt, alight ~a fifth of a second, then dark -- a function of the clock, no state, no
  Math.random. `strokeLight(age, life)`: the return stroke's slam, one to three re-strikes, out at nothing.
  Drawn in CELLS (a small Kiosk board gets a small storm; reach capped by `boundedRadius`), a fat white core
  in a wide lavender glow with a flare where it lands; on WebGL every stroke of a bolt is SOFT
  (`softStrokeAny`: the core too -- as hard translucent polylines they were ~90 stencil passes a frame, now 7)
  and emissive. One firing in four is a long one. A single captured frame can be a DARK GAP (about 8% are):
  look at several instants (`gl-compare.mjs --at 0.30` / `0.37` / `0.52`) before deciding nothing is drawn.
- **The Markets board's lightning is the STORM BALL** (agents.js `stormball`; settings calls it "Ball lightning"),
  not the lightning ball, and it draws lightning.js's channels too -- held through each ~240 ms re-strike, soft and
  emissive on WebGL -- keeping its own flash, bead, sparks, rings and green chains. Its bolts are sized by the BOARD
  (`max(R, 5.2 U)`), not the ball's radius: on the price board the ball was shrunk twice and took its bolts down to
  threads. RATE, the operator's history: half the block board's ("tone down ... 50%"), then far more ("should throw
  off fucking lightning bolts in market view"), then the same hour "Way too violent ... at least half as much":
  `every = 1.0`, under half the block board's bolts a second, no bolt alive 25-75% of the time (a test holds both).
- **The supernova's debris cloud is a live SHADER on WebGL** (`ctx.shade`: a quad drawn every frame by its own GLSL,
  in paint order, emissive; `NOVA_GLSL`). From NASA's film itself, frame by frame (svs.gsfc.nasa.gov/20413 publishes
  the mp4; `ffmpeg -ss` pulls frames): soft deep-blue OUTER GAS, a BODY that breaks out as one smooth
  white-hot lump with a cyan rim and then opens into lavender-violet billows with lit tops, a MAGENTA HEART -- a full
  volume that expands WITH the cloud. **NO RIDGED NOISE, AND THE NOISE IS BAND-LIMITED** (operator: "What's with the
  blue squigly lines"): ridges are creases, and on Markets the cloud is ~100 px across, where five octaves are
  sub-pixel and draw as scribbles through a warp and a threshold -- `fbm(p, oct, cell)` fades an octave out under
  3-9 px a cell (`fwidth`, taken before any early return). On GL the flash's white blobs are skipped and a plume is
  drawn only once it has left the lump (`clear`), or they grain the breakout. Blobs can never be that. Staging (radii, `bright`, the heart's rise) is drawSupernova's own, so the operator's
  sizes and timing hold; the blobs are the fallback. Beside the film the first cuts were GREY: mixed toward white,
  under the old white glow pools (`pool = shaded ? 0 : 1`), a grey shock disc (a thin cyan ring on GL), and the
  operator's white plumes thinning to smoke (they cool to blue on GL). Put ours ABOVE the film's frame to judge.
- **THE FINISHES ON WEBGL (2026-09-22; operator: "terribly slow on the OpenGL path", "neon blocks are WAY TOO EXPENSIVE
  IN WEBGL").** Measured on the 5090 at 2560x1300, ms a frame: a live board plain 6.7, old chrome 13.5, neon 38.7
  (1,321 stencil passes). The cost was never the vertices: it was OPS (a chrome cube was 37 faint quads, each five
  path calls) and see-through wide strokes (each one a stencil pass). Four things, all in the board painter's seam:
  an op may carry a **`ramp`** (`{x0,y0,x1,y1,stops}`: one linear-gradient fill, on EITHER renderer; stops are
  MEMOISED arrays -- `rampStops` -- so `sameBoard` compares them by identity and gl2d's `useStops` skips the sort
  and keeps the atlas key on the array; a test stub's gradient takes no stops, and the painter must survive that); **`ctx.fillPoly(points)`**
  sends an unstroked convex face straight to the batch (false = not vouched for, take the path); **neon tubes are
  ONE soft stroke an outline** on GL -- the halo's, in the tube's colour (`op.neonTube`, kept just under opaque: an
  opaque stroke is never drawn soft and came out as flat bands), its cross-section (halo, tube, core toward white)
  shaped in the shader (gl2d flag 16, `ctx.neonStroke`); the tube's and core's ops (`neonPart`) are skipped. Live
  neon 38.7 -> 9.2 ms. `softGlow: false` -- the parity check -- keeps the three hard strokes, so a plain `--bench`
  shows the HARD figure; time the real one with `--look --bench`.
  Keep a ramp's stops independent of per-cube numbers (put those in the gradient LINE) or the 1,024-row atlas churns.
  **A ramp on GL is 64 texels**: a hard line written as close stops comes out as a smear -- make hard edges geometry.
- **CHROME is a room's lights in polished steel** (third design; the first was the 37-quad wash, the second a hard
  tilted horizon cut per cube: "looks terrible with the slanted areas that move", with pictures of soft-banded steel).
  ONE long soft ramp (`ROOM`, fixed numbers) lies across the whole board and every face is filled from the part it
  sits under, so bands run on from cube to cube and nothing on a resting board moves; a flying cube's reflection
  slides by its height only. Two fills a face (the room, a near-edge fall-off), on BOTH renderers. Now costs what the
  plain board does on GL (rest 3.9, live 8.1). NOT verified: Software in a real browser -- the harness's 2D canvas is
  CPU-rasterised and gradient faces read 70 ms there against 56 for the old quads.
- **THE SUN IS A SKY** (`public/js/sunsky.js`; plan and research: `docs/PLAN-SUN-SKY.md`; operator, 2026-09-21: "an
  animated simulation of our sun ... rotating very slowly ... a rather serious simulation"). **MILESTONE 1 OF 7 IS
  BUILT (2026-09-22): the disk.** SDO's 171 angstrom gold; one fragment shader on its own GL canvas under the board,
  on the FORMATION'S SEAM (`FIELD_SKIES` in details3d.js: a context runs one field sky at a time, `kind` on its
  record, the other dropped first; each has its own DEAD set and 2D fallback). What it draws: a sphere, cells as 3D
  Voronoi ON the sphere (no seam, no polar pinch), the magnetic NETWORK BRIGHT along the lanes over cloudy plasma
  (the first cut drew the visible-light picture -- bright tiles, dark edges -- and it read as giraffe skin),
  limb darkening `1 - 0.6(1 - mu)` from the same constant `limbDarkening()` uses, a bright rim, a glow off the
  limb. **Differential rotation winds a texture into hairlines**, so only the rigid turn is unbounded; the SHEAR
  runs on a sawtooth in two cross-faded layers (`sunPhases`, weights sum to one, zero weight at a reset). Clock
  integrated, phases in doubles. EVERYTHING IS BAND-LIMITED by pixels per cell -- and that is also how
  **`sky.sunSize`** works (operator, of the first cut: "The sun needs to fill WAY MORE OF THE FRAME! ... a slider
  to be able to make the sun take up the entire screen ... the entire surface as a background"): 0.3-10, ships 2.6
  (a great limb across the frame); past ~4 centred or ~7 from a corner the surface covers the panel, and granulation
  appears inside the network because the pixels now exist. Other settings: `sunAt`, `sunBrightness` (ships 0.6:
  "so the chart always wins"), `sunSpin` (1 = a turn in ten minutes; real: 24.5 days). All pinned to the module's
  constants, all through `skyFor`, all in `optSig`. `node scripts/sun-preview.mjs --gpu vulkan --place center
  --sun-size 1 --brightness 1` to look at it; 0.06-0.5 ms a frame on the 5090.
  **ACTIVITY (the same day; operator, with NASA SVS 5268 open: "Where is all the solar activity in ours?!")**: beside
  SDO's own frame the first cut was an evenly lit ball. The real 171 sun is a DARK mottled disk with a handful of
  blazing ACTIVE REGIONS -- so the ramp went yellow-olive, the quiet sun went dark and fibrous with coronal holes, and
  `sunRegions(turn, wall)` (pure, doubles, no state) places ten regions in the belts (8-32 degrees, both
  hemispheres, Joy's-law tilt), carries each round at ITS latitude's rate, gives each a life of a few turns born and
  ended at nothing, and a flare cycle on the WALL clock (sharp rise, slow fall, a few large). The shader draws a
  region as a DIPOLE SEEN FROM ABOVE: in the tangent plane with footpoints at (+-1, 0), the field lines are the
  circles through both, so which circle a pixel is on is ONE DIVISION, and stripes in that number are the loop fan.
  The same function on the LIMB PLANE makes tufts stand off the limb; the corona has streamers (fbm by position
  angle). `sky.sunActivity` switches it. Always judge it BESIDE NASA's frame (the stills are one curl away:
  svs.gsfc.nasa.gov/vis/a000000/a005200/a005268/).
  **FILAMENT ERUPTIONS AND CMEs** ("build the filament eruptions and CMEs next", with SVS 5268 and 5239; modelled on
  contact sheets cut from the films with ffmpeg -- the eruption's quadrant, twelve frames, 171 and 304):
  `sunEruption(k, wall)` runs each region on its own 46-84 s period on the WALL clock: a dark S-bent FILAMENT along
  the inversion line (it re-forms gradually in the quiet); it lights and rises slowly (`sunEruptionHeight`: slow to
  0.045 R, then `~t^1.8` out to 2.8 R), and what leaves is the three-part structure -- a thin ragged FRONT, a dark
  CAVITY, a red CORE -- while two RIBBONS part and an ARCADE lights between them, and the site DIMS. 46% FAIL (rise a
  fifth of a radius, fall back; no front). The ejecta is drawn in the PICTURE's frame (`sunToScreen`, the exact
  inverse of the shader's roll-then-tip; `uARs`), hidden by the disk when behind the limb, faded over a long way.
  **The core is an ARCH, not a pattern**: the first cut striped a blob with a sine and drew sergeant's chevrons; it
  is the distance to a parabola (apex leading, legs trailing sunward), fibres as noise stretched along it, and
  FORESHORTENED by `length(cs.xy)` -- face-on it drew a thin red parabola right across the disk. `sky.sunEruptions`.
  **LOOK AT IT AT THE SHIPPED SIZE, NOT ONLY SMALL** (`sun-preview.mjs --size 1920x1080 --place top-right`): every
  check of the first cuts was a small centred disk, and at sunSize 2.6 the operator saw none of it -- "I'm still
  not seeing any surface activity or finer details": a flaring region was a flat white blob with a straight seam
  (its light was CLIPPED and its cut-off was hard: now an exponential shoulder `arx`, and `edgeK` to zero before the
  cut), and the surface was cracked-mud tiles (now fibrous fbm at 41x, 127x, 380x, each let in by pixels per grain,
  bright points pulsing along the network, a faster boil, and `SUN_MAX_PIXELS` 1.4M -> 4.2M so a big display is not
  drawn at a third of its pixels). **The loops are NOT the dipole's circles** (operator, with a screenshot: "What is
  that looping shit supposed to be? ... really flat and strange" -- complete rings through both footpoints, a bar
  magnet's diagram): an ARCADE of arches between the feet that LEAN limbward by their height (`ua = u - ld*lean*H*hp`,
  which is what makes them read as arches), and FANS whose threads CURVE (`launch`) and fade -- straight they were
  starbursts. **The erupting arch GROWS** ("The red flares sorta appear out of nowhere... they need to grow"): `born`
  scales its size and light from nothing through the slow rise. Placements: centre, four corners, middle-left/right.
  **THE WHOLE POLISH LIST WAS THEN BUILT (the goal, 2026-09-22: "do the entire list. Make this sun ... beautiful. Equal
  to NASA footage at least")**, each step judged BESIDE NASA's 171 frame (`nasa171.jpg`, one curl away):
  * **LOOPS ARE 3D** (`loops3d` + `sunLoops`): each a half-ELLIPSE standing off the sphere between two footpoints,
    28 a region (an arcade of 13, 15 long ones that read as fans). The view is parallel, so an arch's picture is the
    same ellipse in x,y: per pixel, five samples + four BOUNDED Newton steps on (X-p).X'=0 find the nearest point and
    its depth, the sun hides it SOFTLY. **Do NOT meet the ray with the loop's plane**: it is closed-form and singular
    edge-on, and an upright loop seen from above -- the commonest loop on the disk -- IS edge-on (blunt half-arcs,
    white dashes). The loops' geometry is worked out ONCE A FRAME ON THE CPU into an RGBA32F texture (4 texels a loop,
    `texelFetch`): built per pixel it was more than half the frame.
  * sunspots (umbra, striated penumbra, the plage a grainy gold RING, white only at a flare's kernel); quiet
    PROMINENCES (`sunProminences`: 3D low arches with a hanging curtain, red against the sky, ABSORBING against the
    disk, heights the measured 0.035-0.095 R); coronal RAIN (it CONDENSES, streaks, goes out -- "dots appearing out
    of nowhere" was the verdict on knots that switched on); the FLARE (teal flash at the loop tops, SDO's
    diffraction cross on big ones, a wave over the disk); the eruption WRITHES, drains down its legs, dims from its
    two feet, and its FRONT shows only against the sky (face-on it drew a yellow worm over the disk); the corona has
    HELMETS that thin to stalks (a threshold rising with height), polar plumes, outward wind.
  * `sky.sunCycle` (regions 1..10, latitude band, flare/eruption pace, polar holes), `sky.sunChannel` (171/304/193/
    211/131/white as ramps over the same picture), `sky.sunDetail` (pixel budget low/medium/high), switches for
    prominences and eruptions. The quiet sun is DARK and its network BROKEN (every lane lit was a honeycomb).
  * COST on the 5090: 1080p at size 3.2 went 2.8 -> 1.08 ms (fine structure once, not once a shear layer; loops on
    the CPU; per-arch bounds). NOT MEASURED on a laptop GPU: `sunDetail` ships 'medium' for that reason.
  NOT DONE: a Kiosk / game-well look with the Sun chosen; the fallback has region glows but no loops or eruptions;
  prominences are lens-shaped on the disk (no sinuous spine); nothing here has been watched in MOTION by me.
  A backtick in a GLSL comment ended the template AGAIN here; a test counts them.
- **DISPLAY SETTINGS ARE RE-READ WHILE A PAGE IS OPEN** (2026-09-22; operator: "Kiosk is not honoring market settings
  selected in the market screen"). They live on the server so every browser shows the same monitor, but they were
  fetched ONCE, at boot -- so a Kiosk on a wall, which nobody reloads, went on showing the old exchange and range.
  app.js `refreshSettings`: every 15 s and on becoming visible; never while the settings panel is open here or a
  local change is still on its way up (`settingsPushPending`), and only when what came back differs. **A module
  must not keep its own copy of a setting**: markets.js `prefs()` read exchange/range/view once and kept them, so
  even a fresh store was ignored; it reads `loadSettings()` every time now. And the Kiosk's caption counted CANDLES
  as hours ("last 36 h" for a 3 h chart of five-minute bars): it says the span and the bar size.
- **ROOM ON A BOARD IS PIXELS, NOT GRID UNITS, WHEREVER TEXT GOES** (2026-09-22, the Kiosk on a tablet: "Price
  getting cut off in market screen with 1h chart"). `obliqueFit` kept nine GRID UNITS for the price tags; with sixty
  one-minute bars a unit is six pixels and the tag ran off the panel. It is 8.8% of the panel now, nine units the
  floor -- the hours' strip under the chart had made the same mistake a fortnight earlier. **And a KEPT SEGMENT IS
  DEVICE PIXELS** ("old price line visible after switching back and forth from market to kiosk"): the price line's
  `WIRE_SIG` was the curve's key, which is in BOARD units and does not change when the panel does -- a page switched
  away is laid out at another size, and coming back replayed that size's line. The panel's pixels and the transform
  are in the signature. Any new `ctx.retained` needs the same.
  (10 m and 30 m charts were built the same day -- ten-second bars from the exchanges' trades feeds -- and removed
  within the hour at the operator's word: "Nuke 10 minutes and 30 minutes". One hour is the shortest chart.)
- **MARKETS HAS SHORT CHARTS** (2026-09-22; operator: "bitcoinity.org/markets has 10m 1h 3h and 12h charts. Why don't
  we? ... Why don't we fetch finer bars like bitcoinity does?" -- there was no reason; hourly-only was the first day's
  simplification). A range names its GRAIN: 1 h = 60 x 1 m, 3 h = 36 x 5 m, 12 h = 48 x 15 m (`RANGES`, `grainOf`,
  `barsOf` in public/js/markets.js; `GRAINS`, `fineUrl`, `pollFine` in server/collect/markets.js). The page asks
  `/api/markets?tf=<grain>`, the reply carries `bars` per exchange, and ONLY A GRAIN SOMEBODY ASKED FOR IN THE LAST TEN
  MINUTES IS POLLED (20 s / 60 s / 2 min). The hourly series is always kept: the table's 24 h figures are made from it.
  All six exchanges serve all three grains (probed live 2026-09-22: 120 bars each). `chartSeries` returns null while
  the reply still carries another grain, and the note under the table says the chart is still the last range.
  **GEMINI is the sixth exchange** (the same day: "Don't forget to add gemini exchange"): v1 pubticker (its volume is
  an object), v2 candles `[ms,o,h,l,c,v]` newest first -- which LAG (the newest hourly bar was 1.7 h old), so its live
  bar is the ticker's or nobody's -- and the whole book. CEX.IO was probed and left out: its candle endpoint returns
  `[]` and its market was 0.35 BTC in 24 hours. NOT DONE YET: a currency picker (Coinbase, Kraken, Bitstamp and Gemini all list BTC/EUR). New exchanges are NEW OUTBOUND HOSTS: docs and the
  Settings text name every host contacted.
- **ON MARKETS, WHAT CROSSES THE BOARD STARTS AND ENDS BEYOND THE PANEL** (operator, 2026-09-22: "Never make an
  effect just blink in out of existence for the market board"). The Markets canvas is far wider than its chart (the
  chart is about the middle half), so "past the board's edge" is in plain view. Anything that travels measures the
  PANEL from `st.lastFit` (`pw`, `tx`, `scaleX`, `unit`): the storm ball per side, the pulsar (it ran 14-86% of the
  board and was faded up where it stood). A sweeping front (scan, tide, xray, wave, outline) gets `fx.margin` = the
  panel's overhang ALONG ITS OWN DIRECTION (`mx*|dx| + my*|dy|`); it used to be the largest overhang on any side --
  the price board's depth overhang, three times the hours' -- and the scan's saucer spent two thirds of its run out
  of sight. `node scripts/gl-compare.mjs --edges` prints where every Markets effect's pixels are at the ends of its
  run (noisy: a constant 16-40 px box is baseline, not an effect). LEFT AS DESIGNED, because they GROW out of the
  chart rather than blink: the bulge and the pulse (exactly tube-sized at the line's ends, the operator's 09-14
  design) and the black hole ("still while it opens and while it closes", 09-15). Ask before changing those.
- **A RESTING BOARD IS BUILT ONCE** (2026-09-22: "cache the settled scene so a resting board isn't rebuilt every
  frame"). `draw` keeps the settled frame on `st.restFrame` and reuses it while the plan and the closure are the same
  and there is no effect and no hover glow -- everything else `buildScene` reads is a constant of that closure, which
  holds ONLY because nothing writes to `opts` in place (a test holds that): a new look or size is a new `render3d`
  call. **If you add a scene input that changes while a board rests** (something read from `view.now`, a new per-frame
  map like `hoverGlow`), add it to that condition or the board will not repaint. Resting WebGL boards on the 5090 at
  2560x1300: plain 3.9 -> 1.0 ms, chrome 3.5 -> 1.6, satin 5.6 -> 0.8, neon 4.5 -> 1.8. Software is raster-bound
  and did not move.
- **SATIN is brushed metal** (rebuilt 2026-09-22: "still too muted and not metallic enough" -- it was a gleam along
  one edge over flat paint). A broad sheen across every face from a board-wide ramp like chrome's but gentle (never
  blown out, never black: that difference IS the two finishes), the colour pulled a little toward steel, each bevel
  rim its own ramp (white-hot along the lamp's corner, deep on the far two), a near-edge fall-off, and on the GL
  renderer a **brushed grain** in the shader (flag 8, `ctx.grain`, asked for per op with `grain: true`; device-pixel
  streaks, a few percent; off under `softGlow: false`). The vertex flag word is now 1 disc + 2 emissive + 4 soft
  + 8 grain + 16 neon: decode the big ones FIRST.
- **The frame rate** (`appearance.showFps`, `options.showFps`): top right of any board that has tiles,
  drawn through the frame's own context so it is the same on both renderers. It counts frames THIS
  canvas painted in the last second (a resting board under a sky reads about 30 by design; a parked
  board keeps its last figure) and the processor's ms a frame -- the card's time is not visible
  from script. Scorched's land passes `showFps: false`: the actors' canvas over it carries the figure.
- **Verify in a browser, both renderers, the same frame**: `node scripts/gl-compare.mjs` (headless
  chromium, SwiftShader or `--gpu vulkan` for the real card -- it prints the renderer it got -- virtual clock, seeded Math.random; 52 scenes, the live switch, restore
  and lost-context fallback; PNG pairs with `--out`). Measured 2026-09-21: mean difference 0.6-1.8
  of 255. Its fake `cancelAnimationFrame` must really cancel, or a replaced loop keeps painting and
  reads as a renderer bug. A look change arriving mid-transition is parked until the board lands.
  `test/gl2d.test.js` holds the geometry and the context against a recording WebGL stub.

## Current state (2026-09-15): DOOM

**DOOM is the fourth Diversion** (operator: "I've added doom_dos to the project directory. Get DOOM
working as a diversion inside blockyard with zero dependancies"; then, offered a source port instead,
chose the emulator). The shareware `DOOM.EXE` v1.9 runs **unmodified** on a PC this repo emulates;
nothing of id's code is ported, so the repo stays Apache-2.0 apart from the game files themselves.
Built on the `doom` branch. What will bite:

- **No JIT, ever.** The page's CSP is `script-src 'self'` with no `unsafe-eval` (rule-level, see
  csp.test.js), so `x86.js` is a pure interpreter and speed is its whole problem. Keep every value
  an int32 (`| 0`, never `>>> 0` on a hot path: above 2^31 it is a double, and a double stored in a
  closure variable allocates), keep the lazy flags in their `Int32Array`, and do not put a
  try/catch back inside the instruction loop. Numbers in MEASUREMENTS §32; `node
  scripts/dos-bench.js [doom|quake]` re-measures.
- **The extender is not emulated, it is impersonated.** `dospc.js` loads the LE at +1 MB and answers
  INT 21h/31h itself. Things DOOM checks that are easy to miss: `INT 21h AX=FF00 DX=78h` must say
  DOS/4G; the environment is read through a selector with a base (so DS bases are honoured);
  **the BIOS mode byte at 0x449** decides whether DOOM returns to text mode on quit (without it,
  no ENDOOM).
- **VGA is planar.** DOOM unchains mode 13h and flips pages with the CRTC start address; a frame is
  "new" when `vga.frames` (CRTC start writes) or `vga.palSeq` moves.
- **Controls are rebound live, in DOOM's memory.** DOOM reads key bindings once, at start-up, into
  its defaults table (20-byte entries: name pointer, pointer to the live int, default,
  scantranslate, the scancode it saves back). `rebindKeys` in `dosio.js` finds entries by name
  and writes both, so the WASD switch (the default) applies mid-game with no restart or refresh
  (operator: "have to refresh for settings to take effect").
- **The sound card's `tick` batches** (at least 128 frames): called every 2,000 instructions it
  was re-preparing the synth 40,000 times a second.
- **Audio in an insecure context.** On plain HTTP to a LAN address there is no `audioWorklet`;
  `dosgame.js` falls back to a ScriptProcessor. Both paths take the same MessagePort stream.
- **The CPU was fuzzed against the host CPU** (78k instructions, 0 mismatches) with a C harness that
  is not in the repo (it needs gcc); `test/x86.test.js` holds a case per class. Re-fuzz after any
  change to flags, shifts, multiply or divide.
- **`games/` is not in package.json `files`**, so an npm install has no game and the page says
  which file is missing. Whether the shareware files ship is the operator's call.
- Tests: `test/x86.test.js`, `test/dos-pc.test.js` (boots the real WOLF3D.EXE, DOOM.EXE and QUAKE.EXE headless
  when games/ has them, a named skip when not), `test/dos-io.test.js` (keys, configs, text mode,
  the `/games/` route).

## Current state (2026-09-15, late evening): Wolfenstein 3D

**Wolfenstein 3D is a Diversion, before DOOM and Quake in the menu** (operator: "I added wolf3d_dos -
Add that one next, but add it before DOOM and Quake in the Diversions list"), from `games/wolf3d_dos/`.
`WOLF3D.EXE` v1.4 is a **real-mode** Borland program packed with LZEXE, so the machine grew real mode:

- **`cpu.realMode`** switches segment bases to value x 16, CS to 16-bit, SP to a 16-bit pointer that
  wraps (the upper half of ESP kept), 16-bit string ops (`stringOp16`), and 16-bit interrupt frames
  through `bus.vector`, which reads the IVT at 0:0 in real mode. **Real-mode code is not cached**
  (`cs16` goes through `step()`): 65 MIPS against the ~20 the game needs at 70 fps. Cache it only if a
  heavier real-mode program turns up.
- **`bootMZ`** (dospc.js) when `boot()` finds no LE and no COFF: DOS memory manager (`dosAlloc`,
  `dosResize`, first fit under 9F00h), PSP with the top of memory at [2] and the environment segment at
  2Ch, relocations, the IVT filled with F000:n*16. **`bus.softInt` defers to the program** when the
  IVT entry no longer points at the machine's stub (Wolf3D hooks INT 9 and the timer); INT 21h 25h/35h
  read and write the IVT. 49h/4Ah have real semantics only in real mode (DOS/4GW and DJGPP never
  relied on them).
- **VGA write mode 1** and the read latch: Wolf3D copies between pages with it, and so does DOOM at
  one point (lock-step against the old build differs from 173 M for that reason, MEASUREMENTS §36).
- **Page ids may have digits now** (`wolf3d`): the nav and web-contract tests matched `[a-z]+` and
  silently skipped it, and so did the `/games/` route's regex.
- `createPC({ programName })` names the program in the environment (argv[0]); dosworker passes
  `game.exe`.

## Current state (2026-09-15, evening): Quake

**Quake is the fifth Diversion** (operator: "yes, get Quake working as a diversion"), on the same PC,
from `games/quake_dos/` (the operator's shareware copy). `QUAKE.EXE` v1.06 is a **DJGPP** program, not
DOS/4GW, and that is most of what changed:

- **Segment bases are real now.** DJGPP bases CS, DS and SS at its memory block (0x300000 here).
  The CPU keeps EIP linear and converts pushed return addresses and loaded targets against CS's base;
  ESP is an offset in SS. Lock-stepped DOOM for 15 M instructions before and after: identical.
- **16-bit code segments.** crt0 copies a 16-bit helper into DOS memory (its sbrk trampoline) and its
  exit runs 16-bit code in the transfer buffer through stubinfo's `cs_selector`; `selectorIs16`
  comes from the descriptor's D bit (DPMI 0009/000C).
- **The go32 stub is impersonated** (`bootCoff`): what crt0 reads is the stubinfo through FS, the
  **PSP exactly 100h below the transfer buffer** (libc computes it that way), and the environment as
  a **selector** at PSP:2Ch (a DPMI host swaps the segment for one).
- **`fstat` walks DOS's SFT**: INT 21h AH=52h's list of lists, the PSP's job file table, and a real
  system file table kept in step with every file call (`syncSft`), and it trusts the layout only
  after **INT 21h AX=3306h** says DOS 5 or later. DOS calls arrive through DPMI 0300 and must
  answer with segments (AH=62h returns the PSP *segment* there).
- **Directories exist**: Quake reads `ID1/PAK0.PAK` and writes `ID1/CONFIG.CFG`; paths normalise
  to upper case, `.`/`..` resolve, find-first looks inside a directory.
- **Quake never flips pages**: it copies each frame into A0000h, so the worker shows the picture
  once a slice passes with no writes (`vga.writes`), or it would send half a copy.
- **The BIOS tick count at 0x46C** advances with PIT channel 0's wraps (DJGPP's `uclock`).
- `-nocdaudio` always (no CD, or Quake waits at a warning); `ID1/AUTOEXEC.CFG` gives `+mlook` every
  start and WASD binds only until Quake has written its own config.
- **Speed**: `timedemo demo1` 28.9 fps at the emulator's own speed on the first cut (~77 MIPS); 40.9
  at full view and 44.7 at the default `viewsize 80` after the decoded-instruction cache below.

**The decoded-instruction cache** (operator: "1 and 2" -- a smaller view and the cache). `x86.js`
`run()` decodes each instruction once into an Int32Array per page and dispatches on a switch; what it
does not specialise goes through `step()`. What will bite:

- **Anything that writes memory behind the CPU must call `cpu.invalidate(addr, len)`.** The CPU's own
  writes do (wb/ww/wd, the string ops' block moves); `dospc.js` does after a DOS read, a DPMI block
  resize and a block allocation; **tests that `mem.set` new instructions over old ones must too**, or
  they run the previous instruction's decoding.
- **Invalidation is by overlap, not by page.** Dropping the whole page on a write made DOOM *slower*
  with the cache than without: its span drawer patches its own immediates every call.
- **Closures were tried and are slower** (megamorphic call per instruction): Quake 77 -> 69 MIPS.
- **Second pass (operator: "do all 5")**, MEASUREMENTS §35: handlers split per ALU operation and for
  the hot x87 forms, and the address formed inline in the loop, took Quake's timedemo from 37.7 to
  52.5 fps of wall time. **Tried and removed, because they measured as nothing or worse:** fused
  cmp/test+Jcc dispatch, flag-liveness "no flags" forms, and a block copy of `rep movs` into the VGA
  window. Measure pinned to one core (`taskset`), best of three, against a copy of the previous build:
  unpinned runs on this box vary +-5%, and **DOOM's MIPS is not a speed** unless it runs
  `-timedemo demo1` (a scheduling change alters how much of its time is its cheap wait loop).
- **Checked**: lock-stepped against the uncached interpreter -- DOOM 400 M, Quake 1.5 G instructions,
  registers and flags every 10,000, memory identical at the end -- and the native fuzzer re-run through
  `run(1)` (118k instructions, 0 mismatches). `cpu.step()` in the API is the interpreter alone.

## Current state (2026-09-19)

**0.1.3, prepared 2026-09-19 for the operator's review -- not tagged, not published** (`CHANGELOG.md`
under 0.1.3, with an "Upgrading from 0.1.2" note): Bitcoin Machine Code named as the first-class
companion node (README section, About card, mempool.space out of the box, RPC parity measured in
MEASUREMENTS §41), every line of its log read or set aside by name (100% of every current log, MEASUREMENTS §42), the RPC lane at four in
flight, the block charts for a node in initial sync (sampled by height) and for a synced node beside
one, the Throughput card, the node switch, Wolfenstein 3D's menu and its arrows-and-WASD controls,
and the shareware packages made whole. The administrative suite reached M7 on `main` and is excluded
from the release. The announcement is `docs/announcement/0.1.3/`. Tag, tarball from the tag, GitHub
release and npm wait for the operator's "release".

**0.1.2, released 2026-09-17** (`CHANGELOG.md` under 0.1.2, with an "Upgrading from 0.1.0" list):
the third AI security audit with every finding fixed, the resumable and reference-checked address
index, the undo-decoder fixes, one sky per board with the Earth sky's sun and moon, lazy-loaded
games, and Scorched Yard (opponents shuffled each game, a colour per personality, human-sized aim).
Node 22.2 is now the minimum. A 0.1.1 went to npm earlier the same day; 0.1.2 replaces it (npm
cannot reuse a version), its GitHub release was turned back into a draft and its tag removed, and
the changelog has no 0.1.1 section. The announcement is `docs/announcement/0.1.2/`.

**0.1.0, the first minor release**, tagged `v0.1.0` on 2026-09-16: everything since 0.0.9 in one
release (the 0.0.10 that was prepared on 09-15 was never published; its GitHub draft was removed
and its changes ship here). What it carries, in `CHANGELOG.md` under 0.1.0: hardened defaults
(loopback bind, sign-in on, HTTPS with a self-signed certificate made in pure Node, no outbound
connection until market polling is ticked), the Appearance tab (light/dark/system, five themes,
a custom nine-colour scheme), the Mining tab's network row in mempool.space's layout with View
more panels, every tab packed to one screen, the DOS Diversions (Wolfenstein 3D, DOOM, Quake on
an emulated PC written here), the Markets board's effects (black hole, supernova, light saber,
x-ray, breathe, fireworks as a display), and the fixes of two days' use. 1412 tests. Screenshots
re-shot at 0.1.0 (`docs/images/`, plus a Mining shot); the announcement for the bitcointalk
thread is `docs/announcement/0.1.0/`. Upgrading a 0.0.9 install: `docs/INSTALL.md` §11.

The paragraphs below are the state at 0.0.9 and remain true unless a later note says otherwise.

Release day: **0.0.9, the initial release**, tagged `v0.0.9` (the operator names the number; do
not bump it). **Shipped 2026-09-14 evening:** published to npm as `blockyard@0.0.9`, the GitHub
release carries the tarball and the changelog, the repository is public, and the announcement is
posted on bitcointalk (https://bitcointalk.org/index.php?topic=5594141.msg67144312; the post and
its pictures are in `docs/announcement/`). `main` is a few docs commits ahead of the tag
(screenshots re-shot at 0.0.9, uninstall for every layout, the settings panel's note); the next
version is the operator's call. Everything below is committed, tested (862) and live on this box.

**Scope, settled** (2026-09-14; revised 2026-09-18). BlockYard supports **Bitcoin Core, or
Bitcoin Machine Code (bmc), on the machine that runs it**. bmc, the experimental node this repo
was first written against, is first-class again. What is not supported is reading a node
elsewhere over RPC alone: the Umbrel-on-the-LAN path was tried on 09-13 and dropped, because
real-time explorer data over RPC was a failed idea. `docs/DEFECTS.md` opens with that decision;
entries whose only subject was that are closed with it. Four open items remain.

**The address index** (`server/chain/`): Core has no address index, so the explorer's address
page reads one built from the node's own blk/rev files -- 21-byte rows, 256 sorted segments with
a sparse key index, 29 min 45 s and 124 GB for the whole chain on 16 workers, balances equal to
`scantxoutset` to the satoshi (MEASUREMENTS §28-30). `LiveIndex` (`index/live.js`) follows the
chain over RPC: a CRC-framed `live.log` replayed on restart, rollback on a reorg, folding at 100
deep, merging past 32; a reorg below what is folded marks it stale and the page says to rebuild
(same command, same directory: the build empties it first, tested). Rows above the node's tip are
excluded and reported as `index.postTip`. Config key `addressIndex` per node; one index serves
every node on the same chain.

**The installer.** `npm run setup` (`scripts/setup.js`, dress in `scripts/ui.js`): six steps,
every answer validated, the node proven by `scripts/check.js` (RPC, credentials, chain, Core
25+, txindex, `getblock <tip> 3`, not pruned, blk/rev files opening to genesis through the XOR
key, `debug.log`, a configured index), `config/local.json` written 0600, the index built with a
progress bar, the monitor started in the same terminal. `npm run check` re-runs the checks;
`--yes` with flags is the scripted form; `BLOCKYARD_CONFIG` names another file. Untested on
macOS as of this writing -- the operator's Mac (Core v29) is the first fresh deploy. (Later the
same day it was run there; what it found is below. Since then the installer **reads the node's own
`bitcoin.conf`** -- chain, `rpcport`, `rpcuser`/`rpcpassword`, `rpcauth` users, a cookie file the
node was told to write elsewhere, `server=1`, `txindex=1` -- so the questions it still asks are the
ones the file cannot answer; it offers to leave the index build to the server's first start, the
default; and `--workers N` is written into the config as `addressIndexWorkers`, defaulting to at
most 4, not the 16 a dedicated build takes.)

**Two more AI security audits ran on 2026-09-19, back to back.** The first (GLM, report kept beside
the tree) found three code items, fixed in `7736b1c` with tests that failed first
(`docs/REMEDIATION-2026-09-19.md` records it; its log-source finding settled as a decision with a
named follow-up). The second (report `docs/SECURITY-AUDIT-2026-09-19b.md`) re-verified all of the
09-13/14/16 findings plus `7736b1c`, and found the follow-up's gate missing from the code, plus three
more items: all four fixed 2026-09-20 on `audit-2026-09-19-round2` (`docs/REMEDIATION-2026-09-19b.md`,
tests in `test/audit-2026-09-19b.test.js` and the files it names). Still open by design: M8, the
security audit of the administrative suite — the release exclusion holds in the meantime.

**A third AI security audit, `docs/SECURITY-AUDIT-2026-09-16.md`: every finding remediated the same day (`test/audit-2026-09-16*.test.js` hold the fixes):** 1 high (a stalled event-stream reader is never dropped, so memory grows without bound), 8 medium (open mode writable by scripts, probe SSRF, the index build deleting its output directory, wallet key reads in the RPC allowlist, no body deadline, audit-trail flushing, private docs in the npm package, an unsandboxed systemd unit), 17 low. **Two earlier AI security audits**, both remediated the same day: `docs/SECURITY-AUDIT.md` (09-13, one
HIGH: the node-probe credential leak) and `docs/SECURITY-AUDIT-2026-09-14.md` (1 medium: an
allocation sized by the `page` parameter; 4 low). A re-audit is due now that the installer has landed on the Mac
(done 2026-09-14 evening). I1 (open mode lets a LAN client save a node URL the cookie will follow) is the
operator's decision and stays.

**Docs.** Every document was read against the code on 09-14 (three review passes); the product
is BlockYard in prose and `blockyard` only for the repo, paths, service, user and env vars.
`docs/GETTING-STARTED.md` is the macOS/Linux walkthrough. Screenshots are shot against the local
Core (`BLOCKYARD_NODE=main node scripts/shots.mjs`); a fresh browser profile defaults to the first
node in the config, which on this box is the slow Umbrel -- the first pass photographed an empty
board.

**The Living sky** (`public/js/livingsky.js`, 2026-09-16): a second sky type. `drawLivingSky` is
called from `paintFrame` in the star field's place when `opts.skyType === 'living'`, with
`softStops` and a bound `drawStars` handed in (no import cycle); the astronomy is pure and tested
(`sunPosition` six-to-six or by latitude, `moonPhase` from a known new moon, `skyColours`
keyframes by altitude, `starVisibility`); the dome is cached on an offscreen canvas per half a
degree of sun; `skyExtras()` in settings.js carries the `sky.*` settings to every board as
`sky*` options, and the four games spread `...t.sky` into their sky canvases.

**Effects are checked on the Kiosk too.** Every effect plays on the Kiosk's two small panels as
well as on its own page, and a size that is fine on the Markets page can be the whole panel
there (2026-09-15, the supernova's white-out filled the Kiosk's Markets panel: "Test on kiosk
display as well to avoid this in future!!!"). Sizes are capped by the board's width in grid
units (`boundedRadius`), never set in units alone, a capture on the Kiosk page is part of
shipping one, and `test/kiosk.test.js` plays every effect at the Kiosk's panel size and holds
the caps and the soft fills' opacity.

**Effects.** Thirty-five, with a no-repeat window (12) per board; two lists (`effects` for Block
space, `marketEffects` for Markets), nothing rare -- the pulse and the bulge are ordinary picks
on the Markets list since 2026-09-14. The bulge is a ball that fits the line: exactly
the tube at both ends, an arced skin, the core magnified through it, gravity along the pipe.
The newest is the pulsar wind (2026-09-20, the price board's own -- it played on both for a day,
then "remove it from the block space view", and it is twice the size it was on Markets): a
pulsar's passage through a companion's
stellar wind, after NASA's XRISM / BP Crucis film. Two cuts of it were rejected before the
operator's own words named what was missing -- "the winds don't look enough like a particle
simulation" -- so the gas is one: 3200 particles advected every frame through a flow field (the
stream, a swirl, an infall that takes over at the flare's peak, a bow shock), the spiral arms a
density modulation of their brightness rather than drawn arms, stroked in ten brightness buckets
so the whole cloud costs about a dozen strokes. **Anything with state must live on `st.fx`, the
run's record: `fxNow` builds a fresh object every frame**, and the first cut of the particles kept
them there and silently re-seeded 3200 of them sixty times a second (it draws as an even haze --
the giveaway is that nothing ever moves). **A PARTICLE IS A POINT.** Three cuts drew it as a
motion-blur streak -- velocity times seven, then two chasing points, then a curve through six
distance-sampled breadcrumbs -- and the operator rejected every one in the same words ("too much
like lines", "line segments when accreting", "Still looks too much like lines and not a particle
field"), because a streak IS a line however faithfully it follows the path. Dots, and enough of
them (15000, afforded by a sine table for the flow field and one batched stroke per brightness
bucket, a dot being a zero-length segment with a round cap). Structure then has to come from
DENSITY, and the banding that makes the gas fibrous has to be **carried by the particle** (fixed
at spawn, shared along a lane) rather than painted as a pattern in space -- a spatial pattern
stays put while the flow slides through it, which puts a hard ring round the star and blotches in
the wind. The turbulence is a CURL field (the
perpendicular gradient of a two-octave stream function), because sines added to the drift deflect
a particle without turning it and its path stays locally straight -- but keep it to about a third
of the drift, or the eddies stop bending the wind and become the wind, piling the gas into rolls
and leaving the pulsar in a void. The gas is spawned bunched on the stream's axis, too: spread
evenly, the gas nearest the star is the gas that gets eaten, so the middle empties and the wind
ends up as two bands with the pulsar flying down the corridor between them. The beam is a ray on a rotating star:
it swings, foreshortens and flashes, and the star's beat is the same number. The price line leans
toward it as it passes (`pulsarBend`, the black hole's `lensPoints` with the opposite sign -- a
lens pushes the background out, a passing mass pulls the line in). **A warp that travels along the
line has to go into the curve's cache key**: `priceLine` caches its Path2D on the ends plus the
middle point, which a bend crossing the line can leave untouched -- and then the warp freezes in
place while the star flies on. It is cheaper per
frame than the supernova (a headless timing at Kiosk panel size: 2.4 ms against 23 ms).

**The first fresh install (a Mac, 2026-09-14) found the release's worst bug**, and it was not
where the symptoms pointed: `gettxoutsetinfo` walked the whole UTXO set every minute on a node
without `coinstatsindex`, and the address index build -- which started at the same moment -- took
the blame for an hour of throttling. Measure a slow node ALONE before blaming anything running
beside it: `npm run check` times every call. Also found there: 16 workers written into the config
by pressing Enter, a pool map that lived only in `data/`, a bitcoin.conf nobody read, three
half-block art seams, and 256 open file descriptors on a platform that allows 256.

**Later on 2026-09-14, every one of those is fixed and landed:**

- **The UTXO walk.** The slow tier asks `getindexinfo` first, alone, and sends `gettxoutsetinfo`
  ONLY to a node whose `coinstatsindex` reports synced (`utxoStatsWanted()` in `monitor.js`); the
  bug was both in the same batch, so the answer that would have said no arrived with the 41 s walk
  it should have prevented, every minute. Without the index the UTXO figures are `null` and flagged
  `utxo-unindexed`. The `rpc-slow` / `rpc-timeouts` flags no longer assert a cause; they name the
  index build when one is running and otherwise say what was measured. Core 25+, `server=1`,
  `txindex=1` are required; `coinstatsindex` is optional.
- **The stall fix.** `computeSync` takes `peerBestHeight` (the monitor passes the max of
  `getpeerinfo` `synced_headers`, `startingheight` as the fallback): `stalled` only when peers
  report a tip above the node's; a long gap with the peers agreeing is synced plus a caveat; with no
  peer heights, stalled after 7200 s. A 40-minute gap happens about once in fifty on the network,
  and the old rule called every one a stall. The three log-derived sync-detail rows are drawn only
  when their figure exists, so they never appear on Core.
- **The background build and the pacer.** `main.js` builds a missing index inside the server on
  worker threads: its own `RpcClient` on a second lane (its `getblockhash` batches starved behind
  the monitor's multi-second reads: "heights 1,000 of 967,015" for a quarter of an hour); `rpcPacer`
  reads the monitor lane's telemetry before each file and holds while the node is failing, the
  breaker is open or average latency is above `rpc.slowLatencyMs` (5 s), easing above 40% of it (a
  1 s threshold held a healthy Mac at a sixth of its speed). Progress is the `address-index-building`
  flag (phase, done/total, rows, ETA, "paused while the node's RPC is slow"); events of kind `index`
  at start, finish and failure, which `app.js` toasts; on finish the follower starts and address
  pages go live with no restart; failure raises `address-index-build-failed`. A build stopped by Ctrl-C
  or a crash resumes on the next start from `build-journal.json` (per block file in the scan, per
  bucket in the sort; discarded, with the reason logged, on another tip, format or selection, or
  damage). Config keys per node: `addressIndex`,
  `addressIndexBuild: "manual"`, `addressIndexWorkers` (default at most 4, half a dedicated build's;
  1 on spinning disks).
- **`/api/x/address`** now carries `utxos` (up to 100-transaction histories, else `null` with a
  `utxoNote`; each output checked with `gettxout`), `index.postTip`, `indexBuilding` while the server
  builds, and `localIndexError` so a broken index cannot pass for an unconfigured one.
- **The pool map ships**: `config/pool-map.json` (mempool.space/mining-pools, MIT, 151 pools);
  `data/pool-map.json` overrides it, `BLOCKYARD_POOL_MAP` overrides both.
- **The descriptor limit.** `IndexStore` holds no file open (it kept 256+ for the life of the
  process; macOS `ulimit -n` is 256); a lookup opens and closes the one file it reads.
- **CI** runs the suite on Ubuntu, macOS and Windows, on Node 22 and 24. Display settings are
  stored on the server (`config/blockyard.json`). The block-flow cards' stat columns size to content.

**What to do next, in order:** the Mac install again from clean (`git clone`, `npm run setup`,
this time with the server building the index); the re-audit; then move `v0.0.9` to the release
commit when the operator says so.

## Current state (2026-09-12)

A long day on the 3D engine and the browser. Everything below is committed, tested and live.

**Tetrust** (`public/js/tetris.js` rules, `public/js/tetrust.js` screen, `public/js/tetsound.js`
audio). A playable Tetris on the block-space engine. The rules file knows nothing of the screen —
no DOM, no canvas, no clock — so the whole game runs under `node:test`. The well is a `board3d`
with `still: true`; the panel behind it is a second canvas carrying the star field and galaxy at
`maxDpr: 1`. Sound is synthesised with the Web Audio API (no files, no deps) on a lookahead
scheduler that runs on the audio clock, because the page's timers are not reliable enough to keep
a tempo.

**Scorched Yard** (`public/js/scorched.js` rules, `public/js/scorchedai.js` the computer players,
`public/js/scorchedyard.js` screen, `public/js/scorchedshop.js` the roster and prices as data;
`docs/PLAN-SCORCHED-YARD.md` the plan, M1 and M2 landed 2026-09-16). Every weapon is a shell with
a `kind` the rules switch on at impact (blast, funky, mirv, leapfrog, tracer, roller, riot, dirt,
liquidDirt, napalm, digger, sandhog; wedge, disrupter, plasma and laser are instant from the
turret); the table is the manual's (SCORCH.DOC via abandonwaredos.com, radii in pixels over 6.67); `g.shells` is a list so a MIRV's heads fly
together; items sit on the tank (`items`, a `shield` up, `armed` for the shot); cash flows through
`applyDamage`, `kill`, `settled` and `payInterest`; the shop is `SHOP` + `buy`. The personalities (M3)
plan with `simulateShot` (the flight physics with no side effects); an Unknown's `persona` is drawn
in `startRound`; `lastHitBy` is the Cyborg's grudge; `scorchedai.shop` buys by a taste list per kind.
Scorched Earth on the engine: the dirt is a bitmap over a 96×48 grid drawn as **a cube per cell**
(about 1,600; a tall tile per run was tried first and drew as floating ribbons, because the oblique
camera climbs 0.3 of a row per unit of height) on its own canvas that is redrawn only when
`landVersion` moves; the actors -- tanks (two cubes, a turret, a `poly` barrel turned by the
angle), the `sphere` shell, the trace, falling dirt, flash-and-spark blasts -- on a transparent
canvas over it, every frame of a flight. `settleDirt` compacts the columns a blast touched and
reports the runs that moved; `actorLayer` lifts their cells by what is left to fall while the land
canvas leaves them out. Everything random comes from the game's seeded stream;
`test/scorched.test.js` holds the physics to the closed form, the walls, the craters, the settling
and the round.

**Blockanoid** (`public/js/arkanoid.js` rules, `public/js/blockanoid.js` screen). Arkanoid on the
same engine, the third Diversion. Same split as Tetrust and Blockout: the rules file has no DOM, no
canvas, no clock and no `Math.random`, so a whole run is reproducible under `node:test`. The part
worth knowing: **which brick carries a capsule is `hash01(brick, level)`, not a roll** — that is the
only reason "this wall drops a laser from that brick" can be a test rather than a hope. Silver
counts down, gold is scenery (`breakable()` is what `cleared` is measured against, so gold can never
trap a level), and the `capsules` / `enemies` switches live ON THE GAME (`setOptions`) rather than in
the renderer's options, because they change the rules; `blockanoid.js` re-applies them on a flip so
the control is not dead until the next life.

**The arcade.** 26 idle effects at the time (was 9; 30 today, after the agent effects of
2026-09-13/14 and the removals in `docs/EFFECTS-AGENTS.md`). The seventeen new ones are pure functions in `fxAt`;
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
(`BLOCKYARD_AUTH=1`), anonymous visitors read as `viewer`, node writes need two explicit
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

Watches **production only** by default (the first configured node); multi-node is supported via
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

`npm test` = 1412 tests. `bash scripts/smoke.sh` = 109 checks against a real server.

`npm run counts:fix` writes the test count into `README.md` and `AGENTS.md` from the
suite itself. Do not type it by hand. The old guard compared README with AGENTS and so
could only prove the two were wrong together — it passed while the docs said 180 and
`npm test` printed 183 (rule 21). `test/doc-counts.test.js` derives the number from the
declarations in `test/`, and validates that derivation by running three files through
`node --test` and comparing the reporter's count with the scanner's.

The smoke count is the one number here that is still typed by hand (60 before
2026-09-09; the new checks cover the build stamp, CSP nonce, login throttle,
drill-down routes, audit budget and breaker telemetry).

Still open as of 2026-09-19: four items in `docs/DEFECTS.md`, each saying why. Three are the
explorer's (an address page shows no mempool transactions; verbose RPC it re-parses costs 3-5x;
the transaction cache does not survive a restart) and one needs a browser engine (layout, the
CSS cascade and real `EventSource` reconnects: narrowed, not closed). The mempool add/remove
stream was closed 2026-09-19 as a decision: a visualizer draws snapshots, and the poll is the
design. TLS is on by default (see `docs/SECURITY.md`, "Transport security"). The licence is
Apache-2.0 (`LICENSE`, `NOTICE`).

## Conventions

- Zero dependencies. Node builtins and hand-written canvas only.
- Every claim about the node in a comment must be a measurement, with the number
  and the date. "Seems slow" is not a justification.
- Rules in `docs/RULES.md` cite the defect that produced them.
- Working notes are dated files in `worklog/`, which is git-ignored: kept on the working
  machine, never published. Newest work at the bottom of the day's file, unfinished items left as `- [ ]` on purpose.
