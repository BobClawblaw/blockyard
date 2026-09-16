# AGENTS.md — resuming work on BlockYard

Read this first, then `docs/MEASUREMENTS.md` (and, on a working copy that keeps one, the
latest file in the local `worklog/`).

This is a multi-user web monitor for a **Bitcoin Core** node. It reads the node's
JSON-RPC (a log follower exists, but it does not understand Core's log -- see below), and
serves charts plus a live event feed to several users at once. This box watches the node configured in `config/local.json` / the unit's
`BLOCKYARD_NODE_*` environment.

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

1. **The node's RPC server services one connection at a time, on one thread.**
   Never add a concurrent or per-user poll. Everything goes through
   `server/rpc/client.js`'s lane. Measured cost of getting this wrong: a bare
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

## Current state (2026-09-16)

**0.1.0, the first minor release**, tagged `v0.1.0` on 2026-09-16: everything since 0.0.9 in one
release (the 0.0.10 that was prepared on 09-15 was never published; its GitHub draft was removed
and its changes ship here). What it carries, in `CHANGELOG.md` under 0.1.0: hardened defaults
(loopback bind, sign-in on, HTTPS with a self-signed certificate made in pure Node, no outbound
connection until market polling is ticked), the Appearance tab (light/dark/system, five themes,
a custom nine-colour scheme), the Mining tab's network row in mempool.space's layout with View
more panels, every tab packed to one screen, the DOS Diversions (Wolfenstein 3D, DOOM, Quake on
an emulated PC written here), the Markets board's effects (black hole, supernova, light saber,
x-ray, breathe, fireworks as a display), and the fixes of two days' use. 987 tests. Screenshots
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

**Scope, settled.** BlockYard supports **Bitcoin Core on the machine that runs it**. The
experimental node this repo was first written against is not supported (its measurements are
kept as records), and neither is reading a node elsewhere over RPC alone: the Umbrel-on-the-LAN
path was tried on 09-13 and dropped, because real-time explorer data over RPC was a failed idea.
`docs/DEFECTS.md` opens with that decision; entries whose only subject was one of those are
closed with it. Five open items remain.

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

**Two AI security audits**, both remediated the same day: `docs/SECURITY-AUDIT.md` (09-13, one
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

**Effects.** Thirty-four, with a no-repeat window (12) per board; two lists (`effects` for Block
space, `marketEffects` for Markets), nothing rare -- the pulse and the bulge are ordinary picks
on the Markets list since 2026-09-14. The bulge is a ball that fits the line: exactly
the tube at both ends, an arced skin, the core magnified through it, gravity along the pipe.

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
  pages go live with no restart; failure raises `address-index-build-failed`. Ctrl-C does not resume
  a build; the next start begins it again. Config keys per node: `addressIndex`,
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

`npm test` = 987 tests. `bash scripts/smoke.sh` = 109 checks against a real server.

`npm run counts:fix` writes the test count into `README.md` and `AGENTS.md` from the
suite itself. Do not type it by hand. The old guard compared README with AGENTS and so
could only prove the two were wrong together — it passed while the docs said 180 and
`npm test` printed 183 (rule 21). `test/doc-counts.test.js` derives the number from the
declarations in `test/`, and validates that derivation by running three files through
`node --test` and comparing the reporter's count with the scanner's.

The smoke count is the one number here that is still typed by hand (60 before
2026-09-09; the new checks cover the build stamp, CSP nonce, login throttle,
drill-down routes, audit budget and breaker telemetry).

Still open as of 2026-09-09: see `docs/DEFECTS.md` — six items then (five today), and each one says why it is still open.
Four are node-side (mempool add/remove stream needs the `zmqpubsequence` the node
refuses; per-peer byte and relay counts are not in `getpeerinfo` on the deployed
build; the restart storm belongs to whoever owns the deploy). One is a deliberate
non-change (per-tier circuit breakers — the policy is unchanged, but `rpc.breaker`
in telemetry now answers which method opened it and what it froze). One needs a
browser engine: layout, CSS cascade and real `EventSource` reconnect behaviour. TLS,
by contrast, is no longer open: TLS is available (see `docs/SECURITY.md`, "Transport
security"), and the plaintext default is now a boot-time warning rather
than a footnote. The licence is Apache-2.0 (`LICENSE`, `NOTICE`).

## Conventions

- Zero dependencies. Node builtins and hand-written canvas only.
- Every claim about the node in a comment must be a measurement, with the number
  and the date. "Seems slow" is not a justification.
- Rules in `docs/RULES.md` cite the defect that produced them.
- Working notes are dated files in `worklog/`, which is git-ignored: kept on the working
  machine, never published. Newest work at the bottom of the day's file, unfinished items left as `- [ ]` on purpose.
