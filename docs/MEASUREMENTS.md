# Measurements of the node, from this box

Every number here was taken with `curl` against a running node on 2026-09-08.
Reproduce with the commands given. **If you are about to add a poll, a panel or a
timeout, check here first** — each of these changed a design decision, and
re-deriving them costs real time.

Two nodes were live during this work:

| name | RPC | datadir | chain | log |
|---|---|---|---|---|
| production | `127.0.0.1:8331` | `<datadir>` | main | `logs/main/bitcoin.main.log` (systemd stdout, logrotated) |
| bench | `127.0.0.1:8461` | `/mnt/2tbssd/bench/data` | main, **doing IBD** | `console.log` in the run dir, **not** `data/main/debug.log` (see §11) |

Auth is cookie: `<datadir>/<chain>/.cookie`, regenerated every start, deleted on
stop. Resolve fresh, re-resolve on 401; a cached cookie is a restart away from
being wrong.

## 1. The RPC server is single-connection, single-thread

Confirmed by the node's own `docs/RPC_LIVE_NODE.md` (slice 11), which also
explains why its `waitforblock` refuses to wait indefinitely and why
`rescanblockchain` blocks every other RPC while it runs.

Latency of `getblockcount` on the **bench node during IBD**: **40.4 s**.
Same method on the **synced production node** under benchmark load: **7.0 s**.
Same method on the synced node when idle: **~0 s** (batched with two others: 3 ms).

Consequences already implemented:

- `rpc.timeoutMs` is 90 s, not 20 s. A 20 s ceiling declares a busy-but-healthy
  node unreachable.
- Poll tiers **stretch** to at least 2× observed RPC latency
  (`monitor.effectiveTierMs`), capped, and recover automatically when the node
  speeds up.
- Poll jobs **coalesce by key** and are **dropped rather than queued** if they
  cannot be answered inside `rpc.staleDropMs` (12 s). A queued poll answers a
  question about a moment that has already passed.

## 2. Batching works, and it is the cheapest thing available

A top-level JSON array is answered on **one** connection (`docs/RPC_LIVE_NODE.md`
slice 11: "Batches never throw HTTP errors"). Verified:

```bash
A=$(cat <datadir>/main/.cookie)
curl -s --user "$A" http://127.0.0.1:8331/ -d '[
 {"jsonrpc":"1.0","id":"a","method":"getdifficulty","params":[]},
 {"jsonrpc":"1.0","id":"b","method":"getconnectioncount","params":[]},
 {"jsonrpc":"1.0","id":"c","method":"uptime","params":[]}]'
# -> [{...127450789715843.1},{"result":13},{"result":51321}]   in 3 ms
```

Ten methods per tier therefore costs ~1 connection instead of 10. Every tier in
`collect/monitor.js` is one batch.

## 3. `getpeerinfo` returns `[]` while `getconnectioncount` says 13

```
getconnectioncount -> 13
getnetworkinfo     -> connections: 13, connections_in: 0, connections_out: 13
getpeerinfo        -> []
```

The node's `docs/RPC_LIVE_NODE.md` slice 2 describes a shared peer table that
should fill this, and `rpc_fill_peer_slot(...)` is called in `main.c` — but the
deployed build (`deploy-20260907a`) publishes nothing. **This is a
node-side gap, not a monitor bug.** The monitor therefore:

- renders peer **identity and activity from the log** (relay legs, block serving,
  connects/drops),
- shows `getpeerinfo` verbatim in its own panel so the gap is visible,
- raises the `peerinfo-empty` quality flag naming the counts.

Do not "fix" this by hiding the empty table or by inventing peers.

## 4. `getnettotals` reports zero bytes

```
getnettotals -> {"totalbytesrecv":0,"totalbytessent":0,
                 "uploadtarget":{"target":0,"serve_historical_blocks":true,...}}
```

The byte counters are per-peer `TCP_INFO` values held by the forked download
worker (slice 6). Result: **upload rate is genuinely unavailable.** The Network
page says so in words rather than charting a zero.

Downlink and disk-write throughput **are** available, from the log:

```
[dlc] -- network recv this tick: 6.6KB (674.1B/s) | total recv: 1.8MB ||
       disk write this tick: 0.0B (0.0B/s) | total written: 1.7MB --
```

Units are **decimal**: 4096 bytes prints as `4.0KB`. `parseSize` decodes the same
way. A 1024-based decoder here would make every bandwidth figure wrong by 2.4%.

## 5. `getrawmempool verbose` shape and size

```
4,743 txs  ->  660,151 bytes  in 21 ms
entry keys: vsize, weight, time, fees{base}
```

Not present, therefore **not shown**: `depends`, `ancestors`, `descendants`,
`ancestorcount`, `modifiedfees`, `fees.prioritiserved`, `currentlimit`,
`replaceable`, `withdrawreason`, `replaced-by`. The Mempool page lists these
under "fields this node does not report" instead of rendering empty boxes.

Peak pool observed in the log: **17,288 tx** (~2.4 MB verbose) — hence the 60 s
tier, not the 15 s one.

## 6. `getblock verbosity 2` is unusable for block analytics

Returns the full hex of every transaction: **11,254,837 bytes for one block,
83 ms**, and — the real problem — **no `fee` or `deltafee` per transaction**,
which Core includes. So per-block fee data cannot come from `getblock`.

`getblockstats` is the right source and is complete and fast:

```
getblockstats 965993 [totalfee,txs,...] -> 4 ms
{totalfee:1109919, txs:6041, total_size:1601834, total_weight:3991625,
 avgfee:183, medianfee:46, maxfee:84983, subsidy:312500000,
 feerate_percentiles:[0,0,0,1,2], ins:7338, outs:13167, swtxs:5975,
 utxo_increase:5829, ...}
```

All block charts use it. 12 heights per batch.

## 7. Fast reads that are safe at any reasonable cadence

```
getdifficulty      3 ms     getmempoolinfo     fast    getchaintips    3 ms
estimatesmartfee   4 ms     getmininginfo      fast    getnettotals    fast
gettxoutsetinfo    6 ms     (muhash + txouts; NOT the 60-83 s reload the docs
                             mention — that is `gettxout`'s old read-only view)
getindexinfo     524 ms     getchaintxstats    fast    uptime          fast
```

`getindexinfo` at ~0.5 s is the only slow one in the slow tier.

## 8. Real IBD numbers (bench node, 2026-09-08 ~01:06–01:09Z)

This is the dataset the sync bar is designed and tested against:

```
time                 rpc_s   blocks  headers   height%   vprogress   ibd
2026-09-08T01:06:08Z     1   647688   965953    67.05%    0.670517   True
2026-09-08T01:06:34Z     1   648283   965953    67.11%    0.671133   True   +595
2026-09-08T01:06:59Z     0   648723   965953    67.16%    0.671589   True   +440
2026-09-08T01:07:24Z     0   649123   965953    67.20%    0.672003   True   +400
2026-09-08T01:07:49Z     0   649531   965953    67.24%    0.672425   True   +408
2026-09-08T01:08:14Z     0   649906   965953    67.28%    0.672814   True   +375
2026-09-08T01:08:39Z     0   650105   965953    67.30%    0.673020   True   +199
2026-09-08T01:09:04Z     0   650263   965953    67.32%    0.673183   True   +158
2026-09-08T01:09:29Z     0   650266   965953    67.32%    0.673186   True     +3
```

Three findings, each of which is now encoded:

1. **`verificationprogress` ≈ `blocks/headers` during IBD** (67.05% vs 0.670517).
   They are still kept as two separate figures — but the divergence caveat stays
   quiet when they agree, tested in `test/sync.test.js`.
2. **The rate decelerates hard**: 595 → 3 blocks per 25 s sample as validation
   catches the download. One window's ETA would be a number about to be wrong, so
   the sync model computes a 2-minute rate *and* a 10-minute rate, uses the recent
   one, and reports `rateTrend: decelerating` with a caveat saying the ETA will
   get **longer**.
3. Headers were **constant at 965,953** while blocks advanced, i.e. the
   headers-first shape means `blocks/headers` is the correct 0→100% measure.

## 9. Log formats

`test/fixtures/log-samples.txt` holds frozen real lines; `test/logparse.test.js`
asserts against them. Formats that differ from what you might assume:

- `-- peers banned this run: 95 of 123 --` — *not* `peers banned:`.
- Tags include **underscores** (`[tx_accept]`) and **indices** (`[mux:11]`,
  `[dl:7]`). A `[a-z0-9]+` tag regex silently loses `tx_accept`.
- `[block] stored height=… hash=0000000000000000.. bytes=… tx=… (via IP:port)` —
  the hash is truncated with `..`, and `via` is the only place that names which
  peer served a block.
- Timestamps are **local time with no offset**: `2026-09-07 09:24:39.281`.
  Build with explicit `new Date(y,m-1,d,...)`; `Date.parse` of a non-ISO string is
  implementation-defined.
- `uptime=00:14:15:21` is `DD:HH:MM:SS` = 51,321 s — which matched the node's own
  `uptime` RPC exactly, confirming the format.
- **A build can rewrite these lines.** The bench build of 2026-09-08 03:02 changed
  `[dlc]` so comprehensively that the rules written against the production build
  matched **30 of 1,702 lines** in its log, and **1 of its 1,006** `[dlc]` lines.
  Same facts, new grammar — see §11. `test/bench-log.test.js` now keeps a
  representative frozen sample and fails on the ratio, not only on a regex.

## 11. The second build: bench node 2026-09-08 03:02, and what its log says

The bench node was rebuilt during this work (`v0.0.1 built Sep 8 2026 03:02`, run
03:02–04:31Z archived as `console.run17c.log`). It disagrees with every
measurement above in three specific ways, each re-run by hand:

**`getpeerinfo` publishes rows now — and they still are not the traffic.**

```
getconnectioncount -> 5
getpeerinfo        -> 5 rows, each carrying bytessent / bytesrecv
sum(bytessent)     -> 1153      sum(bytesrecv) -> 3232
getnettotals       -> {totalbytesrecv: 3232, totalbytessent: 1153}
stalest lastrecv   -> 4443 s ago
log for the same run -> [dlc] -- recv 11.2MB/s ... elapsed 1:11:11
```

11.2 MB/s for 71 minutes is ~47 GB. The peer table reported **3,232 bytes**, and
those bytes **sum exactly to `getnettotals`**, on peers last heard from 74 minutes
ago. So the newest build publishes a peer table for the control channel only; the
block bytes still live in the forked download worker and still appear nowhere in
RPC. Production (`deploy-20260907a`) was re-checked in the same minute and still
answers `[]` with `getconnectioncount: 13`.

**Per-peer throughput exists only in the log**, in a line the production build
does not print at all:

```
[dlc]   w1 84.215.4.221:8333   chunks=54  blocks=2160  (+10 blk/s, 941.2KB/s)
[dlc]   w2 164.90.253.129:8333 chunks=0   blocks=0     (+0 blk/s, 0.0B/s) [early-kill, last 0.0B/s, peer BANNED]
```

256 such lines in the 90-minute run, naming a peer, a rate and a block count.
That is the whole per-peer bandwidth panel, and no RPC call returns any of it.

**The `[dlc]` tick changed grammar**, so `bandwidth` now arrives from two shapes:

```
prod  [dlc] -- network recv this tick: 4.0KB (405.0B/s) | total recv: 2.3MB ||
            disk write this tick: 0.0B (0.0B/s) | total written: 1.9MB --
bench [dlc] -- recv 11.2MB/s (avg 10.5MB/s) | write 11.2MB/s (avg 10.7MB/s) |
            floor 32.0 KB/s (median 353.4) | banned 6/121 | events 0 rot 0 ... --
```

The bench form drops the running totals (so the totals panels show `–`, not 0)
and prints `(median 353.4)` **with no unit**. Both readings are defensible — KB/s
would make it a peer speed, B/s would make it 1000× smaller — so the value is
kept as the printed text in `poolMedianText` and `poolMedian` stays `null`.

**Three progress figures, not one.** The bench build prints its own sync
arithmetic twice, and they disagree by design:

| source | line | measured |
|---|---|---|
| download worker | `[dlc] == elapsed 1:28:22 \| eta 00:08:38:19 \| overall: 397852/966011 stored (41.19%) \| applied=396275 lag=0 ==` | node's own eta **8h38m** |
| applying thread | `[utxo_live] catchup progress: height=396273/966010 (41.0%) 23.8 blk/s ... eta 00:06:38:48` | node's own eta **6h38m**, 42.3 ms/blk |
| monitor | blocks/headers + measured rate over ≥60 s windows | separate, see §8 |

All three are stored and labelled separately. Rules 4 and 9 apply: the node's ETA
is a fourth opinion, not a correction to ours.

**Clock widths differ by line**: `elapsed 1:22:01` is `H:MM:SS` while
`eta 00:07:54:48` is `DD:HH:MM:SS`. Decoding the first as four fields would read
1 h 22 m as 1 day 22 min. `parseClock()` counts fields instead of assuming.

**Where the file is.** This node writes its log to the run directory's
`console.log`. `<datadir>/main/debug.log` exists but is **144 bytes — three `node
start` lines — and had not moved since boot**, which is what the monitor had
open (fd 22) for two hours while every log-derived panel of this node sat still.

**And it is buffered.** At 04:50 the replacement run's `console.log` sat frozen at
**2,719 bytes for 18 minutes while the node's chain advanced ~15,000 blocks**
(397k → 412,606). stdout is block-buffered when it is a file, so lines arrive in
bursts: delayed here, never lost. A "log is stale" warning that did not check the
chain height would have accused the config of being wrong while being right about
nothing.

## 12. Quiet gaps in a healthy node's log (why a stale gate cannot be short)

Across 1,840 lines of the synced production node's log, the longest gap between
consecutive lines was **1,182 s (~20 min)**. A 5-minute "the log stopped moving"
gate would flag a healthy idle node every few minutes, which trains people to
ignore it. The default `log.staleMs` is 30 min, per-node `logStaleMs` tightens it
where the node is chatty, and the flag reports the chain delta observed during the
silence rather than asserting a cause.

## 13. Parser coverage, measured on both builds

Share of tagged log lines that a parser claimed (a `raw` event is a miss):

| corpus | before this change | after |
|---|---|---|
| bench run `console.run17c.log` (1,997 tagged lines) | 1.5% (30 lines; `[dlc]` 1/1006) | **94.8%** |
| production `bitcoin.main.log` (1,931 tagged lines) | 82.4% | **90.5%** |

The remaining misses are one-shot `[config]`, `[boot]`, `[wallet]`, `[tor]` and
`[serve]` lines that carry no figure the monitor wants. Coverage is now asserted
in `test/bench-log.test.js` against a frozen representative sample, at ≥0.85, and
surfaced live as `log.health.ratio` on the Node panel.


## 14. Methods the node documents as refusing

`getmempoolcluster`, `loadtxoutset`, `getblockfilter`/`scanblocks`/
`getdescriptoractivity` (outside the undo window), `getblockfrompeer`,
`preciousblock`, `pruneblockchain`, `submitheader`, `exportasmap`,
`enumeratesigners`, `getopenrpcinfo`. A refusal from these is expected behaviour,
and `NODE_REFUSES` in `server/rpc/allowlist.js` says so in the reply rather than
letting it look like a monitor fault.

## 15. Third build in four hours: the RPC grew a spine, and the log grew a field

Every RPC claim above is scoped to a build, because in a single day the same host
gave three different answers to the same three calls. This is the record.

| build / time | `getconnectioncount` | `getpeerinfo` | `getnettotals` recv |
|---|---|---|---|
| deployed to production, 04:16 and again 05:20 | 13 → 17 | **`[]`** | **0** |
| bench, built 03:02, sampled 04:16 | 5 | 5 rows, bytes summing to 3,232 | 3,232 |
| bench, rebuilt ~05:47, sampled 05:51 | 5 | **21 rows**, largest 201,608,074, a download-worker marker field present | 2,116,236,872 |

`getpeerinfo`'s 21 rows sum to 1,487,577,978 = **70.29%** of what `getnettotals`
reports received. The missing third is traffic from peers no longer in the table,
so the rows are a subset, not a breakdown — surfaced as `peerinfo-partial`.

**Down rate is now derivable from RPC on the newest build.** Sampled twice, 90 s
apart, on the bench node mid-IBD:

```
getnettotals delta over 90s : 11.56 MB/s      blocks 407.43/s
node's own log, same window : recv 11.2MB/s (avg 9.0 → 10.1MB/s across the window)
```

**3% apart.** §4's conclusion ("bandwidth comes from the log") is now build-scoped,
not absolute, and §11's "3 KB against 47 GB" is equally real for the build it
measured. Both were measured today; neither is a universal.

**Up rate is still not there, and the arithmetic proves it.** Same process
lifetime: **12,896,531,244 bytes in against 1,129 bytes out**, with 21 peers
connected (later 14.0 GB against ~1 KB with 5). A node that pulled 12.9 GB of
blocks necessarily sent `getdata` for them; an 11,000,000:1 ratio is a statement
about the counter, not the traffic. So `outBps` is withheld and the reason is
published (`upload-unmeasurable`). A rate computed as `Δ(1129)/Δt` would have
rendered as a calm `0 B/s` upload on a node doing 11 MB/s in the other direction.

**RPC cannot tell you which regime you are in.** Both the build that reports 12.9 GB
and the build that reports 0 answer the same vendor `subversion` string and the same
`version: 1`. The only build attestation on this box is the build's own log banner
(`… LOG START … built Sep 8 2026 03:02 …`). So "trust the RPC instead of the log" is
not a safe global stance: the log is how you know whether
the RPC's zeros mean zero or mean *unpublished*.

**Update 2026-09-11 (§27):** true of every build up to this date, and no longer of
`deploy-20260910ag`. Its `getnetworkinfo` carries the build's own commit attestation
field, "860b8fdd", and a dirty flag reading false. Older builds omit the field, so this
paragraph still describes them.

**And the log moved again, an hour after its parser was written.** At 05:42:27 the
tick line gained a field:

```
[dlc] -- recv 81.2MB/s (avg 108.7MB/s) | write 62.8MB/s (avg 80.4MB/s) | floor 32.0 KB/s (median 5.1) | banned 8/114 | staged 1 --
```

26 of 26 tick lines in that run matched nothing, because the rule anchored on the
end of the line. The global `log-unparsed` gate (<5% of lines) never fired — the
run overall still parsed ~24% — so a shape can die completely while the ratio looks
survivable. Coverage per rule, not just coverage overall, is the actual lesson; see
rule 15 and DEFECTS.

## 16. Cheap RPC reads worth having (measured on production, 2026-09-08)

| method | ms | bytes | note |
|---|---|---|---|
| `getaddrmaninfo` | 11 | 300 | peer book: 52,877 tried (ipv4 36,482 / ipv6 9,046 / onion 6,304 / i2p 1,045) |
| `getchainstates` | 2 | 336 | headers + per-state blocks/difficulty/`validated` |
| `listbanned` | 3 | 36 | **`[]` while the same node's log said `banned 8/114`** — worker bans are not in the stored ban table |
| `uptime` | 2 | 39 | seconds |
| `getmemoryinfo` | 2 | — | refused: `getmemoryinfo "stats" reports Bitcoin Core's SECURE ALLOCATOR…` |
| `getlogging` | 2 | — | does not exist; the method is `logging`, which is denied as a mutator |

There is **no `getlogevents`** and no build-specific stats method (171 methods,
identical lists on both builds), so the log buffer is not reachable over RPC:
`[dlc]`'s write rate, `[tx_accept]`'s reject breakdown, `[check]`'s archive holes
and `[utxo_live]`'s validation stalls have no RPC equivalent at any cadence.

**Update 2026-09-11 (§27):** `deploy-20260910ag` serves **165** methods and has gained a
build-specific one, a vendor download-info method with no Core counterpart. It covers
the download's state, not the log's reject, write-rate or hole figures, and there is
still no `getlogevents`. The 171-name
list above was never saved, so the six dropped methods cannot be named. The 165-name list
is in `docs/rpc-methods-2026-09-11.txt`.

## 17. Fourth build, and the parsers that died while nobody was looking

At 06:21:35 the production node logged `[serve] shutting down (signal 15):
tip=965914 outbound_legs=0` and came back as `deploy-20260908a`. Two
things were true the moment it returned:

**1. The `[dlc] ==` progress line had changed parenthetical, and the rigid rule
matched 185 of 185 → 0 of 185:**

```
old: … | in flight 279 of window 4096 through 391761 (oldest gap 0s at 388878, 99.93% landed) | applied=388876 lag=1 ==
new: … | in flight   0 of window 4096 through 322920 (no gap, 100.00% landed)                | applied=322920 lag=0 ==
```

`eta` also prints `--:--:--:--` when the node has no estimate — decoded as `null`,
never as zero.

**2. Production was suddenly talking to something RPC cannot see.** 646 lines in
half an hour:

```
[serve] inbound 127.0.0.1:34208 accepted -> child pid 3425602 (2/245 inbound)
[serve] inbound 127.0.0.1:34208 v2 handshake failed -- dropping
```

323 inbound connections from **this host**, accepted and dropped before BIP324
completed. `getpeerinfo` cannot show a peer that never negotiated, and
`getconnectioncount` never counted them. The monitor aggregates them
(`inbound-handshake-failing`, with the per-host breakdown) instead of putting 323
identical rows in the feed — the finding is the rate and the source, not the
individual socket.

**Coverage, live, before and after field-scanning these two lines:**

| corpus | rigid rules | field-scanned |
|---|---|---|
| bench `console.log` (947 tagged lines) | 68.2% | **90.3%** |
| production `bitcoin.main.log` (3,689 tagged lines) | 73.6% | **89.7%** |

The remaining misses are one-shot `[config]`, `[boot]`, `[wallet]`, `[tor]`,
`[serve]` boot chatter and `[dl]` internal-progression lines.

Four grammars changed in one day on two builds, and each time the *global* parse
ratio stayed high enough to look survivable — 24%, 68%, 74%. That is the argument
for scanning labelled lines field by field, which is now how the tick and progress
lines are parsed: a new field costs that field (`extraFields`, values kept verbatim:
`staged 38 commit 6288`) instead of costing the line.

## 18. Production deploy-20260908a: the RPC gap closed, and a port trap reloaded

Fixed at 07:52 after an outage the monitor reported correctly the whole time
(`main online false`, with the reason, no invented numbers).

**What actually broke was two lines in the node's `bitcoin.conf`.** The 06:21 deploy
rewrote that file to four lines, dropping `rpcport=8331` and `port=8332`, so the
daemon fell back to Core's defaults and both halves of the default layout collided
with something else on this box:

1. P2P wanted **8333**, which the benchmark's Core oracle (`bitcoind`, pid 106094)
   holds on `127.0.0.1`–`16`. Boot died with `[boot] lsock failed: Address already
   in use` at 06:32:02, having loaded the archive fine (`tip=966028 (0.00s)`).
2. The 06:35 workaround bound P2P to `192.0.2.10`, which fixed the collision but
   left **RPC on 8332** — while the monitor, the systemd unit and this node's own
   `config/bitcoin.conf` all say RPC is **8331**. Result: RPC answering on a port
   nobody was looking at, and a monitor reporting `ECONNREFUSED` truthfully.

The node's own conf header records this exact failure from 2026-08-26 ("rpcport MUST
differ from port= … the embedded RPC server loses that bind and comes up RPC-less") —
a third repeat. Restoring the two lines fixed both symptoms; the node came up with
`[rpc] JSON-RPC server on 127.0.0.1:8331` at 07:53:24 and the monitor's breaker
closed within a minute. Backup kept as `bitcoin.conf.pre-rpcport-restore-20260908-0752`.

**Two timings worth knowing before blaming the monitor:**

- **RPC binds ~100 s after systemd reports `running`.** Boot 07:51:41 → RPC 07:53:24.
  A probe at 40 s sees `ECONNREFUSED` and no cookie file; neither means failure.
- **`[utxo_live] init` blocks chain RPCs for ~40 s** (07:53:24 → 07:54:06 measured).
  The monitor's slow tier landed inside that window and reported
  `rpc timeout after 90000ms` — while `uptime`, `getconnectioncount`,
  `getblockcount` and `getnettotals` each answered in **0.15 ms** moments later.
  Cheap methods answering while chain-backed ones hang is the signature; the lane's
  timeout and breaker are the right response, not a bug.

**And the gap that started this whole investigation is now closed on production.**
Same host, new build, 2 minutes after boot:

| | deploy-20260907a (04:16, 05:20) | **deploy-20260908a** (07:56) |
|---|---|---|
| `getconnectioncount` | 13–17 | 6 |
| `getpeerinfo` | **`[]`** | **4 rows** |
| sum of `bytesrecv` | 0 | **1,036,340 — exactly `getnettotals` recv** |
| `getnettotals` sent | 0 | **310,937** |
| download-worker marker field in rows | — | absent (the bench build has it) |

So on the build production runs *now*, RPC-only mode can back the bandwidth and peer
panels. Two caveats the data still shows: rows (4) were fewer than
`getconnectioncount` (6), and `subversion` is still the same vendor string on
every build including the two that reported 0 bytes — so the log banner remains the
only way to know which regime you are in, which is why `BLOCKYARD_LOG_SOURCE=0` states
its losses instead of assuming they are gone.

**Update 2026-09-11 (§27):** on `deploy-20260910ag` both caveats moved. Rows equal
connections (9 of 9, 09:22Z), and `getnetworkinfo` attests the build
(commit attestation "860b8fdd"). Rows now sum to 99.99% of `getnettotals` because that
total no longer counts closed peers, not because it covers them.

## 19. Cadences, measured — because a stale-warning needs a number, not a feeling

Four grammars changed today and the corpus parse ratio flagged none of them (rule 16).
The fix is a per-shape liveness flag, which needs one thing I did not have: how often
each line *should* arrive. Measured on both live nodes (production, 355–640
occurrences per shape):

| shape | median | p95 | max | watched? | gate |
|---|---|---|---|---|---|
| heartbeat | 65 s | 152 s | 1657 s | yes | 20 min |
| relay legs | 64 s | 120 s | 1842 s | yes | 16 min |
| orphans | 65 s | 152 s | 1657 s | yes | 20 min |
| accepts and rejects | 33 s | 86 s | 1652 s | yes | 12 min |
| address gossip | 22 s | 87 s | 902 s | yes | 12 min |
| bandwidth tick | 10 s | 17 s | 17 s | IBD only | 10 min |
| download progress | 10 s | 17 s | 17 s | IBD only | 10 min |
| **`[dl] updating utxo`** | **460 s** | **1868 s** | **3669 s** | **no** | — |
| **`[dl] header mirror`** | **502 s** | **2054 s** | **3669 s** | **no** | — |

Gate = p95 × 8, clamped to [10, 30] min. The last two rows are the ones that make the
flag trustworthy rather than noise: an irregular line watched on a tight gate is
wrong often enough to be ignored, and an ignored warning is worse than none. The
maxima of ~1,650 s are the restart windows, where *no* lines arrive — the flag
requires other lines to be arriving, so a down node does not also produce a format
warning.

Shapes also stay unarmed until their rule matches once, which is how build
differences are handled with no build table: the bench build never emits `heartbeat`,
production emits a bandwidth tick twice in hours because it is synced.

**Event time, not wall clock**, deliberately: the bench node block-buffers its
stdout (§11), so a tail delivers minutes of history in one burst. Measuring silence
against arrival time would cry wolf at every flush; measured against the log's own
timestamps it is ~0 s across a burst, which is the truth.

### Four unparsed shapes found while building this, and one lesson about ratios

Production was at 73.4% coverage; after parsing what was actually missing it is at
**82.8%** (bench 85.7%). The unparsed shapes were:

```
418  [txrelay] addrv2 gossip: +3 address(es) to the book
130  [dl] outbound top-up: 4 dial(s) failed, first 93.201.114.79:8333: connect: Operation now in progress
 43  [dl] updating utxo: applied 1 block(s), now at height 966054, live=165330654 (0.21s)
 41  [dl] header mirror +1 from the archive (now 966055, archive tip 966054)
 52  [dial] 31.21.210.206:8333: dialing in the background (ipv4)
  2  [dial] no global IPv6 route on this host: ipv6 peers are unreachable (cjdns unaffected)
```

The ratio had *fallen* 16 points for a completely harmless reason — gossip chatter
grew — after it had stayed *healthy* while three rules died. A corpus number is
useless in both directions; it is reported now because it is cheap, and nothing
depends on it.

Two of those are figures the monitor did not have: `[dl] updating utxo` is
**validation throughput** (`applied 1 block in 0.21 s` → 4.76 blk/s), kept as a third
rate beside the download rate and the catch-up rate, never averaged with either
(rule 9); and `[dial] no global IPv6 route` explains an ipv6 peer count of zero
better than the count does — flagged as `ipv6-unreachable`, "a host capability, not a
node fault".

`updating utxo` and `header mirror` are parsed but deliberately *not* watched, per the
table above — so the bursty-rate lesson is encoded where the data that produced it
lives, not in a comment nobody re-reads.

## 20. One ring per series had been averaging two daemons since the second node was added

Found while trying to answer a different question ("did the RPC breaker open while the
node was healthy?") — which turned out to be **unanswerable from the history**, because
no ring row said which node it came from. The measured mix, two live nodes, 2026-09-08:

| ring | rows | from production | from bench |
|---|---|---|---|
| `peers` | 5,005 | 2,308 (`connections >= 15`) | 1,816 (`connections <= 6`) |
| all 9 rings | ~45,000 | no marker | no marker |

So every chart on the Nodes/Network/Peers pages was drawing a bucketed aggregate of
two different daemons, and `last()`/`tail()` were returning whichever node wrote most
recently. With `agg: 'last'` per bucket, a bucket holding a production point and a
bench point rendered as *the node the chart is labelled with* — which is not a
misreading by the viewer, it is a wrong value from the store.

Now: writes are stamped (`node: <id>`) and reads are filtered through
`History.forNode(id)`. One ring per series is kept deliberately — capacity and
retention are configured per series, and per-node rings would multiply memory by node
count and orphan a removed node's history. The cost is that two nodes halve each
other's reach back in time, which is asserted in a test so it stays a decision rather
than becoming a surprise.

**The consequence of fixing it, stated rather than hidden:** every row written before
this change is unattributed — 14,177 `node`, 18,022 `peers`, 12,619 `net`, 16,384
`rpc` — and a node-filtered read **excludes** them. Attributing them would need a
guess about which daemon produced them, and a guessed owner is the same error one
degree further out. So per-node charts refill from the restart: minutes for the 1 h
ranges, and up to a day and a week for the long ones. `history.summary()` now reports
`unattributed` and `nodes` per ring so that gap is visible from the API instead of
being discovered as "where did my history go".

## 21. What monitoring the benchmark cost, and why it stopped

The benchmark node (`bench`) was removed from the default configuration on
2026-09-08. Not because its data was wrong — because on this box the act of watching
it was load, and it could not be read reliably enough to be worth that load.

**Cost to the node we actually care about.** The node's RPC services one connection on
one thread. Every poll of the bench node is a slot the benchmark cannot use. This repo
already knew that: `main.js` deliberately strips the real bench node out of
`npm run dev` and `scripts/smoke.sh`, with a comment saying a benchmark disturbed by a
test suite is a nasty class of interference. Running the bench node as a permanently
polling-monitored node was the same mistake with better branding.

**Reliability, measured over roughly one hour of it being watched:**

| measurement | bench | main, same monitor, same code |
|---|---|---|
| RPC average latency | ~18–32 s | ≤ 22 ms |
| RPC timeouts | 90 s, on fast *and* slow tiers | 0 |
| failed tier runs | 25 | 0 |
| breaker trips | several (flapping `online`) | 0 |
| restarts during the window | 9+ (its harness cycles it) | the deploys |
| log continuity | truncated at every restart; block-buffered, minutes frozen then a burst | continuous, logrotated |

A node that is being benchmarked by someone else on the same machine is not a
telemetry source with a little jitter; it is a different operating environment, and the
monitor kept reporting it as if it were the first kind.

**And it had already corrupted the production view once.** Before series rows carried
a node id, the `peers` ring held 2,308 production rows interleaved with 1,816 bench
rows and drew them as one line (§20). The rings are per-node now, but the incident is
the reason this file treats "which node produced this row" as a first-class fact
rather than a refinement.

**What was lost, honestly:** live visibility of a second IBD in progress — the thing
that motivated §8's rate/ETA work, and the reason the sync bar's refusal to guess an
ETA was ever tested against real numbers. That knowledge stays in this file and in
`test/`'s frozen bench fixtures, which is where it does its job. If a future session
needs live bench eyes again, `config.js` carries the exact `config/local.json` block to
bring it back, along with the two traps that bit us: the real log is `console.log` in
the run directory (not `<datadir>/main/debug.log`, a 144-byte stub), and it is
block-buffered, so silence means "flushed late" as often as it means "stopped".

## 22. Per-response page rewriting, the block map, and the cost of a login attempt (2026-09-09)

Numbers behind the changes made on 2026-09-09, measured on this box rather than
estimated. The method for each is in parentheses, because three of them are the kind
of claim that silently becomes false when a file grows.

### HTML rewriting per response is free

The build stamp and the CSP nonce both require rewriting every HTML response. Cost:

| measurement | value | how |
|---|---|---|
| `index.html` on disk | 21,341 B | `Buffer.byteLength` |
| after rewriting (nonce + 3 versioned asset URLs) | 21,391 B | same |
| `renderHtml()` per request | **0.009 ms** | 3,000 iterations after 200 warm-up |
| `securityHeaders()` per request | 0.0019 ms | same |
| combined throughput ceiling | ~95,000 rewrites/s | 1000 / (sum) |

So the per-response rewrite is not a performance decision, and the `?v=` stamp does
not need a build step or a manifest. It also means HTML can no longer answer `304`:
the body is not the file on disk any more, and a cached body would carry a nonce the
new CSP refuses. Assets keep their ETag/`304` path (asserted in
`test/http-app.test.js`), which is where the bytes actually are.

### The in-memory block map

`store.blockMapCap` became configurable, so the default needed a cost:

| measurement | value |
|---|---|
| 12,000 block rows | **3.6 MB heap** (~310 B/row) |
| 3,000 rows (the old hard-coded cap) | ~0.9 MB, i.e. the old cap was saving ~2.7 MB |

Measured by filling a `Map` with rows shaped exactly as `fetchBlockStats()` builds
them and differencing `process.memoryUsage().heapUsed` (`test/monitor-shapes.test.js`,
which prints the figure and asserts an upper bound so the comment cannot rot). The old
3,000-row cut bought 2.7 MB and threw away blocks that the 72 h retention would have
kept — and `gapSec` for the oldest survivor then described a block whose predecessor
had been dropped, silently.

### One login attempt

The login throttle exists because an attempt is not free:

| measurement | value |
|---|---|
| `scrypt(N=16384, r=8, p=1, keylen=32)` | **20 ms**, 16.0 MB (`128·r·N`) |
| the comment in `server/auth/users.js` before this | claimed "~50 ms" — corrected to the measured 20 ms |
| throttle bucket | capacity 10, refill 0.5/s, per address |
| 22–24 attempts in one burst | first refusal at attempt ~6–10, ≥10 of the burst refused (`test/http-app.test.js`, `scripts/smoke.sh` asserts ≥8 of 22) |

`LoginGuard` locks a *username* after 8 failures in 5 min; the per-user token bucket
does not apply pre-auth. So before this change a distributed grind — many addresses, a
few attempts each — sat under every threshold in the code while each attempt cost
20 ms of the request thread and 16 MB of its memory.

### Audit log budget

`audit.jsonl` now rotates by size: `store.auditMaxBytes` 8 MiB, `store.auditKeep` 5.
Worst-case footprint on disk is therefore **48 MiB** (current + 5), against "unbounded"
before. The reason for a hard bound at all is that this disk also holds the history
snapshots and the node's datadir: an unbounded audit log's failure mode is not "no
audit", it is "no node".

### Things that were *not* measured, and therefore were not done

- **No verbosity-2 block fetch, anywhere.** The drill-down asks `getblock` verbosity 1
  plus `getblockstats`. §6 measured 11 MB of hex per block for verbosity 2 on this
  node, and the fake node now *refuses* verbosity 2 so that a test can fail if the
  monitor ever asks (`test/drilldown.test.js`).
- **No per-tier circuit breakers.** Still one breaker per node. What was added is the
  telemetry to answer which method opened it, how long it will block, and which calls
  were in the lane when it opened. The granularity question stays unimplemented
  because the contention it would relieve has never been measured (DEFECTS).
- **No fee in the transaction view.** Computing it means fetching every input's
  prevout — N more turns on a one-threaded RPC server — and §6 records that this node
  omits `fee`/`deltafee` from its verbose reply anyway. The field is named in
  `notReported` instead (rule 8).

## 23. The node started publishing getnettotals without restarting (2026-09-09)

Switched this monitor to RPC-only (`BLOCKYARD_LOG_SOURCE=0`) at 17:31Z to settle what the
mode actually costs on the running build. Two claims died in the next few minutes, one of
them mine.

### getnettotals went from 0/0 to real, mid-uptime

```
09:36Z   getnettotals  totalbytesrecv 0            totalbytessent 0        (also 0 on 09-08, repeatedly)
17:36Z   getnettotals  totalbytesrecv 23,955,131   totalbytessent 164,323
17:36Z+25s              23,955,307                    170,419        (delta 176 B / 6,096 B)
17:44Z   getconnectioncount 17   |   getpeerinfo -> []   (still)
```

No restart happened in between — see the process tree below. So "does this node publish
byte counters?" is not only a question about **which build** (the 03:02 bench build
answered 11.56 MB/s against the 11.2 MB/s in its own log while the production build
answered 0, both reporting the same vendor subversion string); it is a question
about **when**, answerable only by asking again. Anything in this repo that caches the
answer — a flag string, a provenance row, a panel that stays empty out of habit — is a
staleness bug with documentation attached. Peer identity did **not** change: `getpeerinfo`
still answers `[]` with 17 connections, so the peer panel remains log-only on this build
even though bandwidth no longer is.

Practical consequence for the mode itself: RPC-only on *this* build keeps bandwidth and
loses per-peer bytes, per-peer identity, relay legs, the accept/reject breakdown, disk
writes, the worker ban count, the node's own ETA, archive holes and `sync_failing`. That
list is what `log-source-disabled` and `/api/net`'s `unavailable` must enumerate, and both
now do.

### The 16:00:49 process is a grandchild, not a restart

I reported `ps -o lstart` at 16:00:49 as evidence of a daemon restart. Wrong, and the
ppid chain is the correction:

```
2034867  ppid 1        started 08:50:56   the daemon  (serve .../data)
2057444  ppid 2034867  started 08:52:26   forked download worker
241094   ppid 2057444  started 16:00:49   coinstats fold worker
```

A fork of a daemon inherits its command line, so `pgrep`/`ps` filtering on the command
line cannot tell a daemon from its children — only `ppid` can. This matters for
attribution: the entire post-reindex window is **one build in one process**, which is
exactly what makes the 0/0 → 23.9 MB observation above a statement about a process
rather than a comparison of builds. Any lifetime or teardown measurement that assumed a
restart at 16:00:49 was slicing one run in half.

### What stopped being a fabricated zero

`inBps` was computed from `getnettotals` deltas and shipped whatever came out, including
0 while the counter was identically 0 — a chart reading "idle node" drawn from a counter
that had never counted anything. The gate now mirrors the one upload already had:
`downloadMeasured` requires a nonzero, moving counter (or a log rate, when the tail is
on), and the panel shows `–` otherwise. Measured both ways: totals 0 → `inBps` null;
totals advancing (23,955,131 → 23,955,307) → `inBps` 7.24 B/s. The same code had been
printing `node log [dlc] tick lines` as `/api/net`'s provenance while the tail was closed
by configuration; provenance is per mode now, because a source the process refused to
open is not a source.

## 24. Block size was empty because we asked for a field that does not exist (2026-09-09)

Reported as "Block size never updates". It never updated because it never had a value:
`BLOCKSTATS_FIELDS` asked `getblockstats` for `size`, `weight` and `strippedsize`. Those
are `getblock` fields. `getblockstats` has never provided them, and it answers a request
for a statistic it lacks by **omitting it** — no error, nothing in the response, no flag.
Every other figure on the row (fees, txs, percentiles, utxo increase) filled in normally,
so the panel looked healthy apart from one permanently empty chart.

Same height, two requests, through the monitor's own read-only console (2026-09-09):

```
getblockstats 966253 ["size","weight",...]        -> 31 keys, none of them size/weight/strippedsize
getblockstats 966253 [...,"total_size","total_weight","mediantxsize","swtotal_size","swtxs"]
                                                   -> total_size 1,579,815  total_weight 3,991,545
                                                      mediantxsize 221  swtotal_size 1,403,359  swtxs 4,103
getblockstats 966252                               -> total_size 1,628,281  total_weight 3,991,846
24h of the size series before the fix              -> 0 non-null samples in 400 buckets
```

`total_weight` at 3,991,545 against the 4,000,000 cap is the sanity check that the field
is the right one.

Three consequences kept, not just the mapping:

- **The number is labelled with its basis, in the payload.** `total_size` is the sum of
  transaction sizes; the serialized block also carries the 80-byte header and the
  txid-count varint. The row ships `sizeBasis` and the Chain page prints it under the
  chart, because "size" is a name that invites a reader to assume identity.
- **Absence names itself.** A reply without `total_size` sets `sizeMissing`; the slot
  says so instead of rendering an empty chart that reads as a broken panel.
- **The fields this node does publish were being thrown away.** `mediantxsize`,
  `avgtxsize`, `swtotal_size` and `swtxs` were never in the request, so they were never
  in the reply either. They are stored and ringed now.

The lesson is about the shape of the bug rather than its size: an RPC allowlist and a
field list are both claims about a node, and a claim answered by silence looks exactly
like a claim that is fine. A test now pins the list — `'size'`, `'weight'` and
`'strippedsize'` may not come back — because the failure mode is silence, not error.
Measured live after the fix: heights 966253–966255 carry 1,579,815 / 1,501,896 /
1,505,279 bytes.

## 25. Who mined it: coinbase attribution, and the map that names it (2026-09-09)

Cost of the two reads per block, measured through the monitor's own read-only console:
`getblock <hash> 1` = 259,891 bytes in 8 ms (exact `size`/`weight`/`strippedsize` plus the
txid list; `tx[0]` is the coinbase), `getrawtransaction <coinbase> 2` = 2,915 bytes in
63 ms. Two calls per block, one block per poll tick, priority 3, nothing at all while the
node is in initial download. The 11 MB verbosity-2 path (MEASUREMENTS 6) is never used.

Three decoding traps, each found on a real block the same afternoon:

| block | what the coinbase did | what was wrong with the obvious parser |
|---|---|---|
| 966257 | `/ViaBTC/Mined by ecgbtc/` in its own push | none — the clean case, BIP34 `71be0e` = 966257 little-endian |
| 966253 | `Mined by AntPool971` with the extra nonce **inside the same frame** (`...971\x15\x00"\x00\xe16{m`) | "is the frame text?" is the wrong question; the answer is the **printable prefix**, so the tag is `Mined by AntPool971` and not `null` |
| 966258 | `/Foundry USA Pool #dropgold/` inside a 50-byte scriptSig that declares a **47-byte push it has no room for** | the strict push walk stops with no tag, though the name is plain ASCII in the block. Fallback: scan for printable runs. The row says `tagSource: 'scan'` so the weaker method is visible in the data |

OP_PUSHDATA1/2/3 (0x4c/0x4d/0x4e) are handled: tags longer than 75 bytes use them, and
stopping at them silently files the block as an unknown pool. The witness commitment
(`fabe6d6d…`) is recovered from the unparsed tail — and when a scriptSig genuinely has no
commitment, as Foundry's does here, the answer is `null` rather than something recovered.
The test asserts both.

### Labels from mempool.space, with provenance

`node scripts/pool-map.js` writes `data/pool-map.json` from
`raw.githubusercontent.com/mempool/mining-pools/master/pools-v2.json` — 35,733 bytes,
171 pools listed, **151 with usable tags, 200 matchers**, sha256 `0491a15f88db…`. Matching
is a case-insensitive **literal substring** test on the whole scriptSig as text, longest
tag first, tags under three normalised characters dropped so a bare "pool" cannot claim a
block. No regexes, no similarity, no guessing.

What that produced against the live node, 23 blocks (966237–966259):

```
antpool       6 blk 26.1%   raw tags seen: 'Mined by AntPool971', 'Mined by AntPool '
foundry usa   6 blk 26.1%   raw tags seen: '/Foundry USA Pool #dropgold/', …#dropgold/O'
viabtc        3 blk 13.0%   raw tags seen: '/ViaBTC/Mined by akamali2/', …
spiderpool    3 blk 13.0%   raw tags seen: 'jSpiderPool/213/', 'jSpiderPool/561/'
f2pool        3 blk 13.0%   raw tags seen: '/F2Pool/e', '/F2Pool/d'
ocean         1 blk  4.3%   raw tag:  '< OCEAN.XYZ >'
mara pool     1 blk  4.3%   raw tag:  'j| MARA Made in USA '
```

Every grouped row keeps the distinct raw tags folded into it, and every labelled row
keeps the tag that matched (`matchedTag`) plus how the tag was read (`tagSource`). The
map's provenance travels with the payload: `labelSource = { source, sha256, fetchedAt,
attribution }`, so "who says this is AntPool?" is answerable from the screen. Unmatched
blocks stay `unknown:<fingerprint>` with their raw text shown. Refresh is manual by
design: the app must not need the network at runtime, and a fetch nobody asked for should
not be able to change which organisation the dashboard blames for a block.

Fetch trivia, because it cost a debugging turn: node's `fetch` tried every A and AAAA
address, all IPv6 attempts were `ENETUNREACH` (this box has no IPv6 route — the node's own
log says so), and the call died inside a 20 s budget while an IPv4 socket to the same host
connected in **367 ms** and `curl` returned 200 in 300 ms. The tool pins `family: 4` and
falls back to `curl` rather than depending on Happy Eyeballs behaving.

## 26. The block being built, and the ancestor graph the Mining page was wrong about (2026-09-09)

The Mining page used to state that Goggles-style cluster analysis was impossible on this
node, because `getrawmempool verbose` returns `vsize` and `fees.base` with no `depends` and
no `ancestorcount`, and there is no `zmqpubsequence`. That observation was measured; the
conclusion drawn from it was not. **The node does publish the ancestor graph -- from
`getblocktemplate`, where every selected transaction carries `depends`.**

Measured on height 966265, same day:

```
getblocktemplate(rules:[segwit])     1,790,010 bytes, 1.286 s first call, 1.482 s second
selected transactions                1,496
transaction entries                  { data, depends, fee, hash, sigops, txid, weight }
weight selected                      1,630,838 WU of 4,000,000 = 40.8%
fees selected                        790,578 sat (0.00791 BTC); coinbasevalue 313,322,914 sat
per-tx feerate sat/vB                min 0.10  median 1.60  p90 4.00  max 74.30
ancestor packages                    1,475 total, 19 multi-transaction, 40 txs (2.7%) inside one
example package                      3 tx: rates 38.1 / 7.6 / 0.5 sat/vB -> package feerate 10.93
```

That last line is the whole point of the Goggles view: the 0.5 sat/vB transaction is not
going to be mined for its own sake, and no per-transaction feerate says so. Folded with its
child, the package pays 10.93. `depends` entries are **indices into the same
transactions array** (measured: `'depends': [6]`), not txids -- reading them as txids
finds zero packages in a template that has 19, which is how a false limitation ends up
written into documentation and repeated by everyone who reads it.

`getmininginfo` still reports `pooledtx: 0` on this build while `getrawmempool` returns
thousands of entries, so the "transactions waiting to be mined" figure is taken from
`getrawmempool`/`getmempoolinfo`, never from `pooledtx` -- another counter that reads zero
and means "not published".

Cost, and the decision it forced: one `getblocktemplate` costs this node **1.3-1.5 s of its
single RPC thread**, on a server that serves one connection at a time. A background poll
would spend the node's minute on a page most viewers do not have open, so the Mining page
asks for the template only while it is visible, at most every 20 s, and the server shares
one in-flight call between concurrent viewers and serves the cached answer for 15 s after.
The `data` field -- the full hex of every selected transaction, and the entire reason the
reply is 1.79 MB -- is dropped before the summary is built and never reaches a snapshot
frame.

**Superseded 2026-09-13 (§26b): Bitcoin Core publishes the graph in the mempool, so the call
is no longer made.** The paragraph above is kept because it was measured and it was true of
the node it was measured on. Against Bitcoin Core on an Umbrel, `getrawmempool(true)` returns
per entry:

```
depends[]          present -- 24,796 of 29,742 entries were in a package
ancestorcount      present, with ancestorsize and fees.ancestor
descendantcount    present, with descendantsize and fees.descendant
chunkweight        present, with fees.chunk  <- Core's own cluster-mempool linearization
```

So the dependency graph does not have to be bought with a 1.79 MB template call: it is in the
reply the monitor already reads every 20 s for the mempool view. `server/collect/gbt.js`
assembles the block from it -- greedy over `fees.chunk`/`chunkweight`, each transaction taken
with its unselected ancestors -- and returns it in the shape a `getblocktemplate` reply has,
so `summarizeTemplate`, `templateCells`, `packagesFromTemplate` and `blockEconomy` read it
unchanged.

Measured the same day, a back-to-back template and mempool pair at height 966821 (so the two
describe the same pool):

```
                    transactions      weight        fees      assembly
ours                       6,546   3,995,859   643,076 sat       52 ms
the node's template        6,535   3,991,951   642,860 sat    ~500 ms of the NODE's thread
difference                    +11      +3,908      +216 sat (0.03%)
set difference       178 in theirs not ours, 189 in ours not theirs -- all at the
                     0.30 sat/vB margin, where ties are arbitrary
```

It is a reconstruction, not the node's answer: sigop limits and policy the mempool does not
publish are not modelled, so it can differ at the margin. What it costs the operator's node is
nothing.

One number in the paragraph above is also stale on a warm node: on 2026-09-13 the same
`getblocktemplate` answered in **0.5 s**, not 1.3-1.5 s, after the `dbcache`/`rpcthreads`
tuning in INSTALL.md. The 4.0-4.5 s figure in §TROUBLESHOOTING was an untuned Umbrel.

## 27. The node's RPC surface, re-read (2026-09-11)

29 calls against production (`127.0.0.1:8331`, cookie auth), strictly one at a time,
~1.5 s apart, 2026-09-11 **09:18:42–09:23:42Z**. Each was a `curl` whose `time_total` is
the latency column below. The running monitor kept polling throughout (see *Contention*).
The raw responses stayed in the session scratch and are **not** committed, because
`getpeerinfo` rows carry real peer addresses. The method list is committed as
`docs/rpc-methods-2026-09-11.txt`, the baseline §16 never kept.

### Which build answered, and RPC can now say so

```
09:20:05Z getnetworkinfo   build commit "860b8fdd"   build dirty false
                           subversion <the build's own vendor string>  version 1   connections 9 (in 0 / out 9)
09:20:32Z uptime           10823            -> RPC up since 06:20:09Z
09:23:06Z getblockchaininfo blocks 966,485 == headers 966,485, initialblockdownload false, vp 1
```

Cross-checked off the wire. The daemon pid (started 06:18:24Z per `ps lstart`, box in
UTC) has `/proc/<pid>/exe` → the deployed build `deploy-20260910ag`, and its log banner
reads `LOG START: 2026-09-11 06:18:25 UTC … v0.0.1 built Sep 10 2026 20:04:29`. The
build's `live` symlink points at the same file, but its mtime was 09:24 (touched
*during* the survey), so it was not taken as evidence. `uptime` started 105 s after the
process did, the same shape as §18's ~100 s bind delay.

**This supersedes a claim three sections made.** §15 ("RPC cannot tell you which regime you
are in"), §18 ("the log banner remains the only way") and §23 (subversion identical across
builds) were true of every build before this one. On `deploy-20260910ag`, RPC attests the
commit and whether the tree was dirty. Two limits:

- a build that predates the field omits it, so absence means "a pre-attestation build",
  not "commit unknown";
- a commit says which code, not what it publishes *now*. §23 measured a counter going
  from 0 to real inside one process, so the commit keys a cache of capability answers
  but does not replace re-asking.

### `help`: 165 methods, a flat list, and no usage text

| call | time | bytes | result |
|---|---|---|---|
| `help` | 1.503 s (contended, below) | 3,028 | `== Methods served by this node (165) ==`, one alphabetical list, **no category headings**; the header says it "is generated from the dispatch tables, so it is exactly what will be answered" |
| `help <m>`, 11 methods, 09:21:05–09:21:24Z | 0.17–0.25 ms (one outlier: 4.42 s) | 283–298 | the same template for every method: "This node serves `<m>`, but does not carry Bitcoin Core's per-method usage text. Consult Core's own `help <m>` …" |

§16 counted **171** on the 09-08 builds and did not save the list, so the six methods
missing now **cannot be named**. That is why the list is committed this time. The next
count should be a diff of that file.

The per-method text is also **cut at 255 characters**. 9 of the 11 sampled replies end
mid-word (`…recorded in docs/RP`, `…docs/RPC_L`). Only the two shortest names
(`addhdkey` 240 chars, `getorphantxs` 252) arrive whole. Either way `help` says nothing
about arguments or side effects. **Every read-only judgement in the table below came from
the node's source** (`asm/rpc_node.c`, `asm/rpc_chain.c`), not from `help`.

### New and non-standard methods

| method | read-only? (from source) | params | latency | shape |
|---|---|---|---|---|
| the build's own download-info method | yes: reads the shared-memory `node_status_t` the download publishes; no Core counterpart | none | **0.175 ms** (09:22:08Z) | measured idle: `{"active":false,"bytes_total":0}`, 71 B. **The download-time shape is read from source and was NOT measured on the wire** (production was synced): `workers, pool_idle_pct, pool, banned, free_peers, window, first_hole, claim, applied, end_height, staged, stall_timeout_s, stall_evictions, median_bps, bytes_total`, plus `peers[]` of `{worker, addr, subver, services, startingheight, conntime, bytes_recv, bps_recv, idle_pct, inflight_lo, inflight_hi}` |
| `getorphantxs` | yes: a compact snapshot the worker shares | verbosity `0` or `1`; `2` (hex) is refused `-8` by source | v0 **0.253 ms**, 375 B; v1 **0.200 ms**, 622 B | v0: 5 txids. v1: `{txid, bytes, parents, age_ms}`; 5 orphans, `bytes` 3,071 ×4 and 195, `parents` 1 each, `age_ms` 97,934–217,047. Core fields absent by source: `wtxid`, `vsize`, `weight`, `expiration`, `from`. `parents` (inputs still missing) is this node's own |
| `getprivatebroadcastinfo` | yes (its sibling `abortprivatebroadcast` is a control op, not invoked) | none | 0.187 ms | HTTP 404, `-32601` "Private broadcast is not enabled. Ensure you're running Bitcoin Core with -privatebroadcast=1": the option is off on production |
| `getaddressbalance` / `getaddresstxids` | read, from the address-index journal; Core has no such methods | address, array, or `{"addresses":[…]}` | **not invoked** | by source: answers only with `addrindex=1`; `getaddresstxids` returns up to 100,000 txids. A monitor has no address to ask about |
| `getdescriptoractivity` | read but **heavy**: walks blocks directly; `DENY_EXACT` in `server/rpc/allowlist.js` | blockhashes, scanobjects | **not invoked** | — |
| `getmempoolcluster` | refuses by source: "this node's mempool has no cluster linearization…" | — | not invoked (help only); already in §14 | — |

`simulaterawtransaction`, `addhdkey` and `exportwatchonlywallet` were only
`help`-sampled. Nothing is recorded about them beyond the boilerplate.

### Gap statuses on this build

| gap | before | deploy-20260910ag, 2026-09-11 |
|---|---|---|
| per-peer **bytes** | `[]` on deploy-20260907a (§3) and on the 2026-09-09 process (§23); 4 rows for 6 connections on deploy-20260908a (§18) | **closed.** 09:22:05Z `getpeerinfo` 9 rows; `getconnectioncount` 9 at 09:22:14Z. Row sums **109,027,561** recv / **34,804,574** sent against `getnettotals` **109,036,122** / **34,807,044** at 09:22:07Z = **99.992%** / 99.993%, 1.5 s apart. 09:23:36Z: 8 rows, 90,137,131 vs 90,139,443 (99.997%) |
| per-peer **relay counts** | absent (DEFECTS) | still absent. Row keys: `id, addr, services, servicesnames, relaytxes, lastsend, lastrecv, bytessent, bytesrecv, conntime, timeoffset, version, subver, inbound, permissions, startingheight, synced_headers, synced_blocks, network`. `relaytxes` is a boolean (true on all 9), not a count |
| `getnettotals` as a lifetime counter | assumed | **no: it falls when a peer leaves** (next subsection) |
| ancestor fields in `getrawmempool true` | absent (§5) | still absent: 09:23:08Z, **19,014** entries, 2,641,932 B, **0.144 s**, keys `vsize, weight, time, fees{base}` only |
| … in `getmempoolentry` | not recorded | **present**, 0.69 ms, 522 B: `vsize, weight, time, height, descendantcount, descendantsize, ancestorcount, ancestorsize, wtxid, fees{base, modified, ancestor, descendant}, depends, spentby, unbroadcast` (sampled tx: `ancestorcount` 18). One call per txid, so a full sweep is ≥19,014 × 0.69 ms ≈ 13 s of the single RPC thread: a drill-down, not a poll. §26's `getblocktemplate` was the cheap ancestor graph on that node; **on Core the graph is in `getrawmempool(true)` itself and costs nothing extra — see §26b** |
| ZMQ | `zmqpubsequence` refused (DEFECTS) | `getzmqnotifications` → `[]`, 0.180 ms. No mempool sequence feed. **2026-09-13, Bitcoin Core/Umbrel: all five publishers present** — `pubsequence` tcp://0.0.0.0:28335, `pubrawblock` 28332, `pubrawtx` 28333, `pubhashblock` 28334, `pubhashtx` 28336, hwm 1000 each. Not reachable from this host, though: all five refuse while 8332 is open, because bitcoind binds them inside its container and Umbrel publishes only the RPC port |
| log over RPC | no `getlogevents` (§16) | still none: the only log-named method in the 165 is `logging`, which `allowlist.js` denies |

### `getnettotals` is a sum over live peers, not a lifetime counter

| time (Z) | call | recv | sent |
|---|---|---|---|
| 09:22:05.667 | `getpeerinfo`, 9 rows, summed | 109,027,561 | 34,804,574 |
| 09:22:07.189 | `getnettotals` | **109,036,122** | 34,807,044 |
| 09:22:08.709 | the download-info method | `bytes_total` 0 | — |
| 09:23:03.804 | `getnettotals` | **89,979,098** | 30,012,780 |
| 09:23:36.938 | `getpeerinfo`, **8** rows, summed | 90,137,131 | 30,063,796 |
| 09:23:38.456 (served 09:23:41.372) | `getnettotals` | 90,139,443 | 30,066,175 |

The counter fell **19,057,024** bytes received (4,794,264 sent) in 56.6 s. The row missing
at 09:23:36 (`id` 15) held **19,303,469** / 4,868,658 at 09:22:05. The difference,
246,445 / 74,394, is what the surviving peers moved in between. The download term was 0
(the download-info method reported inactive), so the drop is exactly one departed peer.

The node's source says so in so many words. `cmd_getnettotals` sums the `used` slots of
the live peer table plus `dl_bytes_total`, and comments: *"Core counts bytes for the
process lifetime including closed peers; we sum the LIVE peer table plus everything the
download received this run."* So it is a documented divergence from Core, not a bug in
the node. Two consequences:

- **The 99.99% above is not coverage.** Rows and total agree because both forget closed
  peers. §15's `peerinfo-partial` (70.29% on the bench build) passes on this build for
  that reason, not because nothing is lost.
- **A delta across a disconnect is negative**: −336,613 B/s over 09:22:07→09:23:03. The
  monitor's `CounterRate` reads any decrease as a node restart and publishes `0`. That
  is an open defect, recorded in DEFECTS under Security / correctness. The next clean
  interval, 09:23:03→09:23:41, read 4,268 B/s received.

### Contention: three sub-millisecond calls took seconds

| call | time | same method elsewhere in the run |
|---|---|---|
| `help` (09:18:42Z) | **1.503 s** | — (first call of the run) |
| `help getprivatebroadcastinfo` (09:21:09Z) | **4.421 s** | the other 10 `help <m>`: 0.167–0.251 ms (two at 5 and 11 ms, one at 87 ms) |
| `getnettotals` (09:23:38Z) | **2.914 s** | 0.174 and 0.259 ms |

The third call carries its own evidence. Its `timemillis` is **09:23:41.372Z**, 2.916 s
after curl started, and the reply arrived at 09:23:41.370Z by curl's clock. The node built
the answer at the end of the 2.9 s, not the start, so the time was spent **waiting to be
served**, not computing. The likely cause is queueing behind the running monitor's own
tiers on the single RPC thread (§1): the fast tier batches five methods every 4 s, and
§26's `getblocktemplate` holds the thread 1.3–1.5 s (no longer called — §26b). **Unconfirmed**: the monitor's lane
telemetry for those seconds was not read. The general point stands. A latency measured
from this box while the monitor runs is an upper bound, and a sub-ms method's outlier is
somebody else's call.

### Not wired, as of this survey

`grep` over `server/`, 2026-09-11: nothing calls the download-info method or
`getorphantxs`, and nothing reads the build's commit/dirty attestation fields. The only
`server/` mention is the allowlist comment that admits the download-info method to the
read-only console via its vendor method-name prefix. What each could supply is listed in
DEFECTS (Functional gaps) as an
opportunity, not a feature.

## 28. What an address index over the chain costs, read from the node's own files (2026-09-14)

`scripts/blockfile-measure.js --sample 16 --verify` on the local Core datadir: 16 of 5,756
`blk`/`rev` file pairs, evenly spaced from file 0 to 5754, each decoded end to end with
`server/chain/tx.js` and `server/chain/blockfile.js`, one block per file checked against
`getblock <hash> 3` (every prevout: value, script, height, coinbase flag) — **0 mismatches**
in 91,813 spent coins. Totals are interpolated between the samples, because a file's
contents change enormously over the chain's history (file 0 holds 119,960 blocks; file 5754
holds 84).

**Calibrated against the node, not only extrapolated.** Interpolated transactions:
1,448,817,382; `getchaintxstats` at height 966,921: **1,438,794,396** — 0.7% high (the blk
files also carry stale blocks). The unspent-output cross-check is looser and says so:
funding rows minus spending rows is 121.3 M against `gettxoutsetinfo` txouts **165.2 M**.
That is a small difference of two ~3.5 B figures, each within a couple of percent, so treat
row totals as ±2% and the difference between them as not measured by this method.

| | Whole chain (interpolated) |
|---|---|
| block files / undo files | 768.3 GB / 108.8 GB |
| transactions | 1.449 B |
| outputs / funding rows (spendable) | 3.823 B / 3.627 B |
| inputs = spending rows | 3.506 B |

Single-core time, by stage:

| stage | hours | note |
|---|---|---|
| read | 0.62 | **warm cache for some files** (file 0 and 5754 read in ~40 ms); cold device read is the 0.7 h of the earlier spike (DEFECTS) |
| XOR | 0.23 | |
| decode blocks, addresses included | 5.87 | the dominant cost |
| pair blocks with undo | 0.34 | after the fix below |
| decode undo, addresses included | 3.06 | early files cost most: uncompressed-key P2PK coins are rebuilt with BigInt modular arithmetic |
| **CPU total** | **9.5** | per core; files are independent, and this box has 32 cores |

Raw index rows, before any storage engine's overhead:
**85.6 GB** history only (12 B per row: an 8-byte script-hash or outpoint prefix and a 4-byte
height) and **142.7 GB** with an 8-byte amount on every row, so a balance needs no node call.
Free space on `/storage` at the time: 653 GB.

**The pairing bug this run found.** Pairing each block with its undo record by trying every
candidate of the same transaction count is quadratic where blocks are tiny: file 0 ran 35
minutes without finishing, and a second attempt (one hash per distinct record) still took
230 s. Core appends undo records in connection order, so `pairBlocksWithUndo` puts each
file's blocks in chain order by their previous-block links and walks the records in step,
checksum-verified: file 0 pairs in 5.9 s, a recent file in ~15 ms, and every block but
genesis (which has no undo) pairs.

## 29. Storing the address index: SQLite against sorted flat files (2026-09-14)

`node --no-warnings scripts/index-bench.js --files 384,2685,5370` builds real index rows from three
file pairs (2015, 2021 and 2026 — 436 blocks, 695,639 transactions) and stores them two ways.

**The row.** One per (address script, transaction that touched it): an output paying the script, or
an input spending an output that paid it, the spent script taken from the undo file. Key: the first
8 bytes of sha256(script), block height, position in the block. Value: the net satoshis that
transaction moved for the script. The transaction itself stays in the node (`txindex`). A script
paid and spent in the same transaction is one row, which removes **18.3%** of raw rows here
(21.6% on the 2026 file alone): 3,827,812 raw rows became **3,128,638**, 4.50 per transaction.

| | SQLite (`node:sqlite`, WITHOUT ROWID) | sorted flat file |
|---|---|---|
| bytes per row | 26.5 as inserted; 24.1 after VACUUM; 27.4 bulk-loaded in key order | **21.0** with amounts; **13.0** history only (+ a sparse index of one key per 4,096 rows) |
| build rate | 418 k rows/s in arrival order; **1.40 M rows/s** in key order | sort **5.53 M rows/s**, write **2.99 M rows/s** |
| lookup (warm, 20,000 real scripts) | **0.0027 ms** | 0.057 ms (one 86 KB read per lookup) |

**What these numbers do not show.** The whole sample fits in memory, so every figure is the
in-memory regime. At full size the arrival-order SQLite rate will not hold: a B-tree fed random
keys past RAM pays a disk seek per insert. That collapse was not measured and nothing here should
be read as its rate. Key-order loading avoids it, but requires sorting every row first -- the same
sort the flat file needs.

**Extrapolated to the chain** (MEASUREMENTS 28: 7.13 B raw rows, less the 18.3% merged here ≈
**5.8 B rows**; the merge share varies by era, so ±10%):

| design | size |
|---|---|
| flat, history only (13 B) | ≈ 76 GB |
| flat, with amounts (21 B) | ≈ 122 GB |
| SQLite, with amounts (24–27 B) | ≈ 140–160 GB, before any second index for reorg deletes by height |

A key-order SQLite load of 5.8 B rows at 1.40 M rows/s is ≈ 69 minutes on one thread; the flat
file's sort is ≈ 18 minutes of single-thread CPU if bucketed by hash prefix so each bucket sorts in
memory. Both sit on top of the 9.5 single-core hours of decoding (§28), which splits across cores
because files are independent.

## 30. The address index, built and compared (2026-09-14)

`node scripts/index-build.js --out ~/blockyard-index --workers 16` read every blk/rev pair from the
local node's `/storage` NVMe and wrote to a separate NVMe (`/`). `node scripts/index-benchmark.js`
then measured it against the node.

**Build.** 29 min 45 s wall, 16 workers (1,633% CPU; 7.8 CPU-hours; peak RSS 30 GB):

| phase | time |
|---|---|
| block hashes 0..966,930 (`getblockhash`, batches of 5,000) | 49 s |
| scan 5,756 file pairs (lean rows, not the full decoder) | 25 min 45 s |
| sort 256 buckets | 3 min 10 s |

5,890,519,289 rows, **123.7 GB**, every height 0..966,930 present exactly once, 2 stale blocks
skipped, 0 missing undo records, 0 duplicate rows. §29 projected ≈5.8 B rows and ≈122 GB: both
within 1.5%. The first attempt failed on its last file, the one the node is still writing: Core
preallocates it as raw zeros, which read as the XOR key once de-obfuscated (`records` now takes the key).

**Correct.** 40 of 40 addresses (the heavy ones below except the genesis address, and a sample from
across the chain) have an index balance equal, to the satoshi, to `scantxoutset` at the same height.
Before that, every (script, transaction) pair of four whole blocks from 2009 to the tip was found
at its height and position with its net amount (21,351 pairs, a 5-file test build). The genesis
address is excluded from the balance check on purpose: its first 50 BTC is the genesis coinbase,
which Core never added to the UTXO set; the index counts it as received, as explorers do.

**Lookups** (344 distinct addresses sampled from 24 blocks spread over the chain; median history 14
transactions, largest 3,195,827):

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| first lookup | 0.248 ms | 1.108 ms | 28.3 ms | 119 ms |
| repeated (warm) | 0.028 ms | — | 25.0 ms | — |

Heavy addresses, whole history summed for the balance: 2,326,967 transactions in 82.9 ms; 65,786 in
2.5 ms; 5,583 in 0.5 ms. Opening the index (the sparse keys into memory) takes 84 ms.

**Against the alternatives.**

| method | what it answers | cost |
|---|---|---|
| this index | full history, balance, per-transaction amounts | 0.25 ms p50 lookup; 124 GB; 30 min build on 16 cores |
| `scantxoutset` (Core, no index) | current balance / UTXOs only, no history | **26.5 s** for one scan of 40 addresses, holding the node's RPC thread |
| `getaddresstxids` (insight-style) | — | refused by Core at every setting (DEFECTS) |
| SQLite, same rows (§29, in memory only) | same | 24–27 B/row ≈ 140–160 GB; 1.4 M rows/s sorted load |
| romanz/electrs (published) | history, no amounts | ≈2 h on 6 cores; 56 GB |
| mempool/electrs, what mempool.space runs (published) | history, amounts, full tx store | "a few hours"; 1.3 TB |

The published figures are the projects' own READMEs, on other hardware; they are context, not a
race run on this box.

## 31. The first fresh install, and a sync false alarm (2026-09-14)

Figures from the first install on a machine that is not this one -- a Mac, Core 29.1, block files on
a platter array -- as recorded in the day's commits; not re-run here, since the machine is the
operator's. The descriptor figures were taken on this box.

**A node without `coinstatsindex`, sent `gettxoutsetinfo` every minute** (`6bf0ea5`): RPC answers of
18 s on the monitor's lane, 90 s timeouts, the verbose mempool read dropped, the block-space board
empty; `getindexinfo` reported no coinstats index and the UTXO set held 165 M outputs. The same node
measured alone by `npm run check` (`ab2c5dc`): `getblockchaininfo` 10 ms, `getblock <tip> 3` 921 ms,
`getrawmempool true` 1.0 s. The index build running beside it was throttled four ways first
(`4a2bb49`, `89c738e`, `02b35e5`, `26a9433`) and was not the cause; the pacer's first threshold of
1 s then ran a healthy build at about a sixth of its speed (`0b87d2e`), so it holds at
`rpc.slowLatencyMs` (5 s) and eases above 40% of that now (RULES 27).

**Descriptors** (`a05f1c6`): the index store held a descriptor per segment and layer (256 and more)
and the build all 256 bucket files, on a platform whose soft limit is 256. After opening per read, on
the full index on this box: 0.02 ms median warm lookup, 0.28 ms p90, 21 descriptors held by the
process; the build keeps at most 64 buckets open.

**The installer at 80 columns** (`ce54ae8`): the whole run piped at 80 columns, widest line 79.

**Sync** (`72908f0`): two independent nodes at the same height, no block for 42 minutes, both
showing STALLED. Block intervals are close to exponential with a 10-minute mean, so a gap of 40
minutes or more has probability e^-4, about 1.8% -- once in fifty blocks, a few times a day. Stalled
now means a connected peer reports a higher tip (`getpeerinfo` `synced_headers`); peers agreeing on
the tip is a long gap and synced; no peer height at all waits two hours.

## 32. The DOOM Diversion's emulated PC (2026-09-15)

Not the node: the i386 and the PC in `public/js/x86.js` and `dospc.js` running the shareware
`DOOM.EXE` v1.9 (the Diversion). Taken on this box -- AMD Ryzen 9 9950X3D, Node v22.23.2, Chromium
152 (snap, headless). Reproduce the headless figures with `node scripts/dos-bench.js doom`.

**Speed of the interpreter**, 400 M instructions of DOOM's title and demos on a clock of 30 M
instructions to the virtual second:

| build | instructions a second |
|---|---|
| first cut: unsigned values (`>>> 0`), flag operands in closure variables, a try/catch per instruction | 66-68 M |
| every value an int32, lazy flags in an `Int32Array`, one try/catch around the loop, 32-bit fast paths | 95 M |
| the same with the Sound Blaster and OPL3 attached, synthesising at 44.1 kHz per call of `tick` | 73 M |
| the OPL's per-register work hoisted out of the sample loop | 82 M |
| `tick` working in batches of at least 128 frames (it had been called every 2,000 instructions: a sample or two each) | **92 M** |

The try/catch alone was 14% of the profile, and the collector 1.5% from doubles boxed in closure
variables; the rewrite was checked instruction by instruction against the first cut for 40 M
instructions (identical except the start-up's environment read, which the first cut got wrong).

**In the browser**, the machine in a worker, sound on: **94-110 M instructions a second, 34-37
frames a second** -- DOOM's own cap is 35. The game needs about a million instructions a frame of
real work; the rest of each tic it spends in its own busy wait for the timer. The page's CSP forbids
eval, so a JIT was never an option; a slower machine than this one has roughly a factor of two in
hand before DOOM drops below 35.

**Start-up**: graphics mode after 8.0 M instructions without a sound card, 17.0 M with one (the
DMX driver probes the DSP and the OPL); 20 pages flipped by 31 M.

**Correctness of the CPU, measured against the host's own**: a differential fuzzer ran random
instructions natively (a C harness in 64-bit mode, 32-bit operands, register forms) and in `x86.js`,
comparing all registers and every flag the instruction defines -- ALU rows, immediates, shifts and
rotates with counts past the width, MUL/IMUL/DIV/IDIV including divide faults, BT/BTS/BTR/BTC,
BSF/BSR, SHLD/SHRD, MOVZX/MOVSX, SETcc, BSWAP, XADD, CMPXCHG, SAHF/LAHF. Two seeds, 78,565
instructions, 2,338 divide faults agreed, **zero mismatches**. The harness needs a C compiler, so it
is not in `npm test`; `test/x86.test.js` keeps a case from each class it covered.

**The music is in tune**: over 10 s of the title music, 178 notes keyed on, 96 of them within
2.5 cents of equal temperament; the rest spread to +-50 cents, which is DMX's pitch bends.

## 33. Quake on the same PC (2026-09-15)

`QUAKE.EXE` v1.06 (DJGPP, go32 stub) on the emulated PC, this box, Node v22.23.2. Reproduce with
`node scripts/dos-bench.js quake`.

**Speed**: 77 M instructions a second headless with the Sound Blaster attached, 72-79 in a Chromium
worker -- lower than DOOM's 90-105 because Quake's code is FPU-heavy (the x87 was 15% of the profile)
and every memory operand adds a segment base (DJGPP's DS is at its memory block; `ea` was 13%).
Moving the FPU stack to a Float64Array with typed-array operand conversion and one base addition
when DS and SS share it took 74 to 76: the interpreter's dispatch is the rest.

**Frame rate**: `+timedemo demo1` on a clock of 74 M instructions to the virtual second -- the
emulator's own speed -- reported **969 frames in 33.5 seconds, 28.9 fps**, about 2.6 M instructions a
frame. In the browser, a new game on the start map drew 26 frames a second. Period hardware for
comparison: a Pentium 90 ran the same demo at 320x200 at roughly that rate.

**Start-up**: graphics mode after 244 M instructions on a 30 M clock (Quake pages its 27 MB heap in
and times its hardware), twenty screens drawn by 285 M; 2.8 s of wall time headless.

## 34. The decoded-instruction cache, and Quake's view size (2026-09-15)

This box, Node v22.23.2, `node scripts/dos-bench.js doom 400` / `quake 1500` (M instructions a
second, headless, Sound Blaster attached):

| build | DOOM | Quake |
|---|---|---|
| before (the interpreter, §32-33) | 90 | 77 |
| a closure per decoded instruction | 68 | 69 |
| int32 decodings in a typed array per page, one switch; a write drops the whole page | 83 | 90 |
| ...a write clears only the instructions it overlaps (DOOM patches its span drawer each call) | 100 | 90 |
| ...the FPU decoded too, and the loop keeps the current page between instructions | 107 | 104 |
| ...no page check after a cached handler | **111** | **108** |

The page-drop row is the one to remember: 217,660 whole-page drops in 300 M instructions of DOOM,
every one from `mov [eax],ebx` into the constants of its own span routine at 0x12bdaf.

**Quake's view size**, `+viewsize N +timedemo demo1` (969 frames), on a clock set to the emulator's
speed:

| viewsize | before the cache (76 M clock) | after (105 M clock) |
|---|---|---|
| 100 | 29.7 fps | 40.9 fps |
| 80 (the new default) | 32.5 | 44.7 |
| 60 | 40.5 | -- |

In a Chromium worker: Quake 99-106 MIPS and 40-42 frames a second in a new game at `viewsize 80`
(26 before), DOOM 133 MIPS at its 35 fps cap.

**Checked, not assumed**: both games lock-stepped against the uncached interpreter (DOOM 400 M, Quake
1.5 G instructions; registers and flags compared every 10,000; memory identical at the end), and the
native fuzzer re-run through `run(1)` over 118k instructions with no mismatch.

## 35. A second pass on the CPU: what paid and what did not (2026-09-15)

Asked for all five of: split the ALU routine, specialise the hot x87 forms, cheaper dispatch, dead
flags, and a block copy of the frame into video memory. **Method, after the first readings misled:**
each build against a copy of the previous one (`oracle4`), pinned to one core with `taskset`, best of
three; unpinned runs on this shared box moved +-5% between identical runs. Quake throughput as M
instructions a second over its timedemo, and as **frames a second of wall time** over 600 timedemo
frames -- the second catches work a MIPS figure cannot, such as a `rep movsd` that is one instruction
however many bytes it moves. DOOM on `-timedemo demo1` only: its normal MIPS depends on how much time
lands in its cheap wait loop, which a change to the machine's slice size alone moved by 5%.

| build | Quake MIPS | Quake fps (wall) | DOOM timedemo MIPS |
|---|---|---|---|
| before (the cache, §34) | 101 | 37.7 | 103 |
| ALU split per operation + hot x87 forms decoded to their own handlers | 133 | -- | -- |
| + fused cmp/test+Jcc dispatch and "no flags" forms by flag liveness | 131 | -- | 110 |
| the same without the look-ahead (fusion and no-flags off) | 133 | -- | 114.5 |
| + the address formed inline in the loop instead of a call per handler | 141.5 | -- | 112 |
| + aligned reads/writes inline in the hottest moves | 141 | 52.5 | 115 |
| the same without the VGA block copy | 141 | 51 (noise) | -- |

**Kept**: the ALU split, the x87 handlers, the inline address and moves -- Quake's frames a second of
wall time 37.7 -> 52.5 (+40%). **Removed**: the fused branches and the no-flags forms (nothing gained;
the look-ahead re-ran on every re-decode of DOOM's self-patching drawer), and the block copy (within
noise: the frame copy is 64,000 bytes against 140 M instructions a second).

The reason inlining mattered: `run()` is one function with 170-odd cases, V8's cumulative inlining
budget runs out long before the helpers it calls, and every uninlined `eaOf` was a real call.

**In a Chromium worker** (new game, `viewsize 80`): Quake 115-118 MIPS and 39-49 frames a second on
screen, once the worker looked for a finished frame every 50,000 instructions instead of once per
10 ms slice (two frame copies inside one slice had been showing as one). DOOM 139 MIPS.

Checked: DOOM 400 M and Quake 1.5 G instructions lock-stepped identical to `oracle4` (memory equal),
and the native fuzzer through `run(1)`, 78k instructions, no mismatch.

## 36. Wolfenstein 3D in real mode (2026-09-15)

`WOLF3D.EXE` v1.4 (LZEXE-packed, Borland C, real mode) on the emulated PC, this box, Node v22.23.2,
pinned to one core. It unpacks itself and reaches the sign-on screen in 1.0 s of wall time (60 M
instructions on a 20 M clock).

**Speed**: in a game, turning on the first map, **65 M instructions a second** headless (twice the same
reading) and 68-69 in a Chromium worker. Real-mode code runs through the uncached `step()`, so this is
the plain interpreter's speed; the game needs about **285 k instructions a frame**, so its 70 frames a
second (the VGA's refresh, which it waits for) take 20 M a second -- a third of what is there, and the
browser shows 70 frames a second.

**DOOM and Quake unchanged**: best of three against a copy of the previous build (`oracle5`), DOOM
timedemo 93.3 vs 93.0 M a second, Quake 126.3 vs 127.7. Quake lock-stepped identical for 600 M
instructions, memory equal. DOOM lock-steps identical to 175 M and then differs, by design: at 173 M it
copies between VGA pages in write mode 1, which the previous build wrote as plain data, and reads the
planes back.
