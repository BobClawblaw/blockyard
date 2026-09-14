# BlockYard Security Audit — 2026-09-14

> **STATUS: REMEDIATED — 2026-09-14, the same day.** M1: `summaryForKey` never sizes its ring by the
> page number -- a page past 4,096 rows counts the history first and keeps at most what exists
> (`test/chain-index.test.js` asserts a `page=1,000,000` request allocates nothing for it). M2: rows
> above the node's tip are excluded from the count, the balance and the page and reported as
> `index.postTip`, which the page shows as a caveat. L1: the pool key is escaped like its
> neighbours. L2: a summary with more than 2,000 inputs and outputs is never cached. L3: the
> shape-liveness fixture lives in a `mkdtemp` directory. L4: `audit.jsonl` and `history.json` are
> created 0600 (`pool-map.json` is a public curated map and stays as it is). I1 is an open
> decision, unchanged. The report below is kept as written.


- **Project:** BlockYard — a multi-user web monitor for a Bitcoin Core node (`/storage/blockyard`)
- **Audit date:** 2026-09-14 (single session, sequential)
- **Scope:** full code + security re-audit of `server/` (http, auth, rpc, collect, store, chain, netinfo, config, main), `public/` browser code, `scripts/`, `systemd/`, `test/` infrastructure, plus deployment posture and secret hygiene on this box
- **Repo state at audit:** branch `main` @ `f9dae64`; working tree carries one untracked file, `scripts/check.js` (a read-only pre-flight CLI using the already-audited `RpcClient`/blockfile readers; no security findings)
- **Relation to the previous audit:** this is the follow-up to `docs/SECURITY-AUDIT-2026-09-13.md`. Its one HIGH finding (node-connection probe credential leak) and the same-day fixes were re-verified against the live code and the live server; the new attack surface added since (the address index `server/chain/`, the explorer `server/http/explorer.js`, the markets feed, the server-stored display settings) is what this report concentrates on. ~30 commits / ~9,200 inserted lines since that audit.
- **Method:** manual review of every security-relevant module; repo-wide pattern scans (eval/Function, child_process, fs-write-from-request-data, path.join-from-request-data, hardcoded secrets, prototype pollution via config merge, ReDoS-prone regexes on request data); frontend sink tracing against `fmt.esc()` coverage by injection context; dynamic verification — `npm test`, `bash scripts/smoke.sh` against a real booted server, live cross-site CSRF probes against the running monitor on port 21000, and an attempt to reproduce each new finding over HTTP.
- **Report generator model:** GLM-5.3-Flash-EXL3 (served via 198.51.100.20:8888), running as Hermes Agent by Nous Research.

## Executive summary

| verdict | counts |
|---|---|
| High findings | **0** |
| Medium findings | 1 |
| Low findings | 4 |
| Informational / hardening | 3 |
| Positive observations | 14 |
| Prior audit's HIGH finding | **still fixed**, re-verified live |
| Test evidence | 841/849 unit (8 environmental failures, one cause) · 109/109 smoke |

The 2026-09-13 remediations hold. The CSRF/credential fix was probed on the running server: a cross-site POST to `/api/config/node/test` is refused with 403 and the reason names the check. The discipline that audit credited — fail-closed gates everywhere, honest absence instead of invented numbers, secrets never logged — is intact in all the new code.

The one medium is in the newest code path, the local address index: **`/api/x/address` hands an unvalidated `page` parameter into an allocation sized by the page number**, so a single unauthenticated GET can make the monitor allocate ~525 MB and walk an address's entire history in one request. It is not remotely exploitable for code execution, but on a 1 GB-class box it is a cheap way to hurt the process that also reads the node's RPC cookie.

---

## Verification evidence (what was actually run)

| check | result |
|---|---|
| `npm test` | 849 tests: **841 pass, 8 fail** — all 8 failures share one cause (Finding L3): `test/shape-liveness.test.js:22` writes a fixture to the fixed path `/tmp/shapes-fake.log`, which on this box exists owned by another user; `open()` fails with EACCES. No code regression behind them. |
| `bash scripts/smoke.sh` | **109/109 pass** against a real booted server, including: "the read-only RPC console works with no CSRF token", "open does not mean unguarded: writes still denied", "node writes are refused with no identity". |
| Live probe of the 09-13 fix | `POST /api/config/node/test` with `Origin: http://evil.example` → **403** `cross-site request refused…`; same-origin POST → 400 (route reached, bad body), confirming the Origin/Sec-Fetch-Site gate sits in front of the probe and the probe itself answers only same-origin callers. |
| Live probe of Finding M1 | `GET /api/x/address?addr=<genesis address>&page=999999` → 200, `pages: 2632`, empty `txs`, ~5 ms. Allocation did not show in RSS at this size (see the finding for why the static analysis still stands). |
| Secret hygiene | `git ls-files` greps for credential-shaped strings: no secrets in tracked files. `config/local.json` (real `rpcUser`/`rpcPassword`, a cookieFile path) is **0600 and gitignored**, never committed (`git log --all -- config/local.json data/` is empty). `data/users.json`, `sessions.json` are 0600. |

---

## Finding M1 — MEDIUM: `/api/x/address` `page` parameter drives an unbounded allocation and a full-history walk

**Files:** `server/chain/index/store.js:120-133` (`summaryForKey`), `server/http/explorer.js:62` (`pageOf`), `server/http/explorer.js:279` (call site), route `GET /api/x/address` (`server/http/api.js:424`, `auth: 'any'`).

```js
// explorer.js:62 — page is clamped to 0..1,000,000
const pageOf = (q) => Math.max(0, Math.min(1_000_000, Math.floor(Number(q?.page) || 0)));
// ...
const sum = store.summaryForKey(scriptKey(script), { limit: PAGE, skip: page * PAGE });   // explorer.js:279
```

```js
// store.js:124-130 — skip is trusted: the ring buffer is allocated from it
const keep = Math.max(0, skip) + Math.max(0, limit);
const ring = Buffer.allocUnsafe(Math.max(1, keep) * ROW);        // ROW = 21
this.forEachRow(key, (buf, at) => { ... });
```

`page` is clamped to a million — but a million pages × 25 rows/page × 21 bytes/row = **~525 MB of `Buffer.allocUnsafe` per request**, for one unauthenticated GET. With accounts off (the shipped default) there is no session, no CSRF token needed on a GET, and no rate limit tighter than the generic per-address token bucket (40 req/s burst, capacity 120 — several such requests fit in a burst). The same line also makes the handler **walk every row of the address's history** (`forEachRow` visits all `txCount` rows even though only a page is kept), so a whale address (65,792 rows for the genesis address, measured live) costs a full scan per request regardless of the allocation.

Two factors blunt it in practice, and one hides it from a naive PoC:

- the allocation is a single `allocUnsafe` — V8 serves it from fresh mmap'd pages lazily, so RSS does not jump until the pages are touched, and the `ring` is written only at `((txCount-1) % keep) * ROW` positions modulo the actual row count. `txCount 65,792 < keep 25,000,025`, so writes stay inside the first 1.4 MB — the 525 MB is allocated but mostly never touched. That is why the live probe above moved RSS by <1 MB.
- explorer.js resolves the address to a script and calls `validateaddress` first; a syntactically invalid address is refused before the index is opened. A valid address is all an attacker needs.

The exposure is therefore: cheap **memory pressure and event-loop stalls** (an address with millions of rows would make `forEachRow` run for seconds per request; the ring write pattern then touches pages striding `keep × ROW` apart, which after the row count exceeds one page-deep ring starts faulting across the whole allocation). On the box this repo documents (the monitor and the node share a machine; the process holds the node RPC cookie), degrading the monitor is a real cost even without a compromise. Repeatable by one LAN client at the rate-limiter's burst ceiling.

**Recommendation:** clamp `page` against reality, not against a fantasy bound — `skip = min(page * PAGE, max(0, txCountCeiling))` where the ceiling comes from the index's own row budget (e.g. refuse `page * PAGE > 1_000_000` rows outright with a sentence), or better: implement `summaryForKey`'s paging the way its own comment says ("a page deep into a huge history keeps skip+limit rows, never the whole history") by counting rows and reading only the wanted window. One line of honest rejection beats 525 MB of untouched buffer.

---

## Finding M2 — LOW/MEDIUM: the address page serves post-reorg history without checking heights against the node's tip

**Files:** `server/chain/index/store.js:126-133`, `server/http/explorer.js:291-315`.

`summaryForKey` builds `recent` from the newest `skip+limit` rows **of the index**, and `addressFromIndex` passes them on with `delta` amounts — even when those rows' heights are **above the node's current tip**. During a deep reorg (or after the node itself rolls back past the index), the explorer page keeps listing transactions, balances and per-tx deltas for blocks that are no longer in the chain. The response does carry `index.behind`, and the base/layer reorg case is explicitly declared unrecoverable (`live.js:19-20` marks the index stale only when the reorg reaches folded data) — but a tail reorg (live.js rolls back correctly) still serves the old rows for any page whose blocks were dropped, and nothing on the page says those rows are gone from the chain. The monitor's own rule 8 — "stale must be visibly stale" — is met for charts and not met for this page.

Exposure is integrity, not confidentiality: a LAN viewer is shown chain history that is no longer history. Severity low because it self-corrects at the next poll and because the honest `behind` figure is present; it is listed at all because this project's standard elsewhere is higher than "eventually correct".

**Recommendation:** filter `sum.recent` rows to `r.height <= nodeTip` (the tip is already fetched two lines up) and count the filtered-out rows into a `postTip` figure shown on the page.

---

## Finding L1 — LOW: the pool table interpolates a third-party string into an HTML attribute without escaping

**File:** `public/js/mining.js:1113`

```js
<td><span class="bdot" data-pool-key="${p.poolKey ?? p.poolLabel ?? ''}"></span>
```

Every neighbouring interpolation on the page goes through `fmt.esc()`; this one does not. Today it is **not reachable as XSS**: `p.poolKey` is always present on `byPool` rows (`server/collect/mining.js:269` refuses rows without a pool key), and pool keys are the output of `cleanTag()` — constrained to `[A-Za-z0-9 ._-]{1,24}`, lowercased — so the attribute can only ever hold those characters. `poolLabel` (which comes from the third-party `mempool/mining-pools` map fetched by `scripts/pool-map.js`, and after that from a file an operator may hand-edit) is only consulted when `poolKey` is falsy, which the ledger makes impossible.

It is still the one sink in the codebase where a third-party-derived string reaches markup unescaped, one refactor away from being live (`data-pool-key` also feeds `poolIndex()` for colouring). CSP `script-src 'self'` would stop script execution even if it went live, but attribute injection can still break out of the element and forge sibling markup.

**Recommendation:** `data-pool-key="${fmt.esc(p.poolKey ?? p.poolLabel ?? '')}"` — one function call, and the file's own convention is restored.

## Finding L2 — LOW: `txCache` bounds entries, not bytes

**Files:** `server/http/explorer.js:32-39` (`CACHE_MAX = 3000` entries), `server/http/explorer.js:65-97` (`txSummary` maps **every** `tx.vout`/`tx.vin`, unsliced), `server/http/explorer.js:199` (`xTx` caches the full summary).

An LRU of 3,000 decoded transaction summaries is a sensible *count* cap, but one decoded summary can be multiple megabytes (a 1 MB transaction can carry ~20,000 outputs; `txSummary` builds an object per output with address strings, and `xTx`'s response returns all of them even though it advertises `outputsShown: 500`). A LAN client who walks a few thousand known huge historical transactions can grow the heap by hundreds of MB and keep it there — the cache evicts by recency, so the giants stay resident as long as they keep being requested.

**Recommendation:** cap the cache by approximate bytes (e.g. refuse to cache summaries above ~64 KB, or keep a running byte count and evict oldest until under ~64 MB total), and slice `tx.vout`/`tx.vin` in `txSummary` to the page's real need.

## Finding L3 — LOW: tests write to a fixed, shared `/tmp` path

**File:** `test/shape-liveness.test.js:22` — `logFile = '/tmp/shapes-fake.log'`.

Eight of 849 tests fail on this box for one reason: the fixture path is a fixed name in the shared `/tmp`, owned by another user, and Linux `fs.protected_regular` makes opening it EACCES even for root. Beyond breaking the suite on any multi-user machine, a predictable filename in a world-writable directory is symlink-bait: a hostile local user who pre-creates `/tmp/shapes-fake.log` as a symlink gets the test to write through it (tests run as whoever runs them). This is test-hygiene, not a product exposure.

**Recommendation:** `fs.mkdtempSync(path.join(os.tmpdir(), 'shapes-'))` per test file, the pattern `test/helpers/http.js` already uses for its own fixtures.

## Finding L4 — LOW: runtime state files drift from the 0600 posture

**Files (measured `stat` on this box):** `data/audit.jsonl` and `data/pool-map.json` are **0664**, `data/history.json` is **0644**, while `data/users.json`, `data/sessions.json`, `config/local.json` and `config/blockyard.json` are correctly 0600.

The audit trail records who did what; history.json holds node-derived operational detail. On a single-user box the group/other read bit is noise; on a box with other local accounts (this one has them), the audit log readable by another local user defeats part of its purpose. Nothing writes these files with an explicit mode — they inherit the process umask.

**Recommendation:** create `data/audit.jsonl` (and siblings) with mode 0600 in `AuditLog.append`/`History` (the codebase already does exactly this for users/sessions via `fsp.open(tmp, 'w', 0o600)`), or set `UMask=0077` in the systemd unit.

---

## Informational

**I1 — Open mode lets any reachable client rewrite the node connection that credentials will later follow.** `POST /api/config/node` (`auth:'any'`, `csrf:true`) is `configWriteAllowed` = no-op while `auth.enabled: false` (the shipped default), by documented operator decision ("With accounts OFF there is no identity to check, and the operator chose to allow it rather than demand BLOCKYARD_AUTH just to point the monitor at a node" — `server/http/api.js:58-60`). The probe route never sends credentials to a new endpoint (09-13 fix, re-verified), but a *saved* config does: a LAN client can POST `{ rpcUrl: attacker, datadir: <real datadir> }`, and after a restart the monitor reads the real node's cookie and sends it to the attacker's URL. The Origin/Sec-Fetch-Site gate blocks browsers from being tricked into it (verified live above), so this needs a deliberate direct request from the LAN — the same class of actor who could edit `config/local.json` if they had shell, but who needs nothing more than the port to do it this way. The role ceiling does not apply because the danger is server-side state, exactly the reasoning the 09-13 audit used for the probe. If the operator's posture ("assume a safe network", quoted in the same file) changes, these two routes are where the change belongs; a middle option is to refuse saving a *different* `rpcUrl` together with an *existing* datadir unless authenticated.

**I2 — Allowlist prefix classes stay as the 09-13 audit left them.** `classifyMethod` remains deny-exact → deny-prefix → allow-prefix → default-deny, with `getnewaddress`/`getrawchangeaddress` pinned in `DENY_EXACT` despite the `get` prefix. The prior audit recorded keeping prefix matching as an open decision; nothing in the ~30 commits since changes it. Carried forward, unchanged, by decision.

**I3 — `logparse.js` remains untested against real Bitcoin Core lines — and stays off.** The log source is off by default, boot prints a loud warning that the parsers target an experimental node grammar, and `test/log-core-unsupported.test.js` pins that Core lines come back unstructured and misdated. This is the correct posture; the only risk left is someone setting `BLOCKYARD_LOG_SOURCE=1` against Core, and the boot now argues with them in plain text when they do.

---

## Things done right (observed this pass, not inherited from last audit)

1. **Fail-closed everywhere, verified live.** Malformed `allowCidrs` entries are refused at boot and can never admit a client (`netinfo.js:ipDecision`); open-mode cross-site writes are refused by Origin/Sec-Fetch-Site (probe returned 403 on the running server); open mode + enabled node writes is a *fatal* config, not a warning (`config.js:563`).
2. **The CSRF fix's comment tells the next reader why the naive re-introduction is wrong.** `api.js:739-752` documents that dropping the spread alone does not fix the credential leak because `candidateNode` falls back to the configured datadir — the rule had to be about the destination. This is the difference between a patch and a defence.
3. **Admin ceiling held in open mode by construction.** `ANONYMOUS_USER` is frozen at `viewer`; `/api/users`, `/api/audit`, `/api/password` still 403 with a message naming `BLOCKYARD_AUTH=1` (smoke-asserted, not just claimed).
4. **Every request-data → path/regex sink in the new explorer code is guarded:** addresses must match `[A-Za-z0-9]{14,100}` before touching the index; txids/block hashes `HEX64`; heights `\d{1,9}` with an above-tip refusal on `/api/block`; paging clamped; URL-context interpolation always through `encodeURIComponent`.
5. **The index reader treats on-disk data as hostile.** Row format bounds checked (`MAX_HEIGHT`, `MAX_POS`), undo pairing proven by Core's checksum rather than assumed, live-log replay stops at the first short/bad-CRC record and truncates there, `unxor` handles Core 28's preallocated zero tails. Nothing trusts a file because the node wrote it.
6. **The RPC lane is a DoS budget, and it got stricter.** One in-flight request, spacing, rate ceiling, breaker with dequeued-work handling, priority queue, 512 MB hard cap on any single node response (`client.js:304`), batched explorer calls at bounded `maxWaitMs`. The code quotes its own measurements for why.
7. **Bounded everything else that faces a socket:** body 1 MB, settings blob 256 KB, event batches capped and trimmed, session/user/audit stores rotated or swept, `blockTxids` capped at 64, rate-limiter map self-prunes at 5,000 keys.
8. **Credentials never rest and never echo.** Cookie re-resolved on 401 rather than cached; log redaction is shape-based (`password|secret|cookie|token|…`), applied recursively to audit rows with a stated reason for what is *not* redacted; stdout scrubber catches `user:pass@` and `password=…` shapes; bootstrap admin password printed exactly once.
9. **Audit trail now redacts by shape, not by name** — the 09-13 fix for nested action arguments is in place (`main.js:250-258`), and rotation is budgeted with a visible `headroomBytes`.
10. **`settings.js` `normalise()` makes the server-stored settings blob structurally safe:** every value is clamped to option lists, numeric ranges, or a hex-colour regex before any consumer or `value="${v}"` interpolation sees it — the server stores an opaque blob, the client refuses to trust it. (This closed the stored-XSS question before it could be asked.)
11. **The About page draws the line between machine shape and owner identity** and its comment names `test/privacy.test.js` as the enforcement — OS/arch/CPU model are readable pre-auth, but hostname, username, network addresses and environment are deliberately absent from `/api/about`.
12. **syslog-grade honesty in the systemd unit:** no machine facts in the committed file (they live in the gitignored `local.json`), an interpreter story with measured dates, `Restart=always` justified by a recorded outage, and hardening (NoNewPrivileges, kernel tunables/modules/control-groups locked, RestrictSUIDSGID) sized to what the service actually needs.
13. **Zero runtime dependencies** — no supply-chain surface at all; the one `child_process` use (`pool-map.js:115`) shells out to `curl` with a constant URL and array args.
14. **Tests that assert security behaviour, not structure:** CSP assertions, session-TTL relationship (72 h absolute / 8 h idle, the 09-13 inversion bug pinned by test), random-password distribution, audit redaction, open-mode write refusal — all present and passing.

## Recommendations, in priority order

1. **Fix M1** — clamp `page` against a real row budget in `summaryForKey` (or window the read). Small change, removes the only finding that lets one GET pressure the process.
2. **Fix L1** — escape `data-pool-key` (one call), and consider a repo grep test that fails on unescaped `${` inside attribute context for the pool/explore templates, in the spirit of the existing `style="` guard in `test/csp.test.js`.
3. **Bound the cache (L2)** by bytes as well as count.
4. **Adopt 0600 for runtime files (L4)** or `UMask=0077` in the unit.
5. **Fix the test fixture path (L3)** so the suite is green on any machine — 841/849 today is an environment artefact, and a red suite dulls the alarm a real regression deserves.
6. **M2** — filter post-tip rows on the address page so stale chain data never renders as current.
7. **Revisit I1** whenever the "assume a safe network" posture is revisited: config writes from unauthenticated LAN clients decide where the node's cookie is sent after the next restart.

## Scope and limits

- Reviewed line-by-line: `server/http/{server,api,static,sse,explorer}.js`, `server/auth/{users,sessions}.js`, `server/rpc/{client,allowlist}.js`, `server/config.js`, `server/netinfo.js`, `server/store/{audit,history}.js` (history via its write path), `server/chain/tx.js`, `server/chain/blockfile.js`, `server/chain/index/{store,rows,live,build,worker}.js`, `server/collect/markets.js`, targeted review of `server/collect/monitor.js` (config/credential flow, unbounded-state spots, block-row rendering) and `server/collect/{mining,gbt,nextblock,logparse,logtail,sync}.js` via their exported contracts and call sites; `public/js/{app,mining,explorer,markets,about,settings,fmt,panels,login}.js` sink tracing plus sweep of the remainder; `scripts/*`; `systemd/blockyard.service`; `test/` infrastructure; repo-wide pattern scans.
- **Not re-tested end-to-end this pass:** the full monitor tier machinery under a hostile node (the 09-13 audit's dynamic coverage stands; the lane's caps were re-read, not re-measured); browser-engine behaviour behind the CSP (declared out of scope there and here — it needs a real engine).
- The 8 failing tests are environmental (Finding L3), verified individually to fail on `EACCES` at the fixture path, not on assertions.
- Per this project's privacy rule, the model-host address above is an RFC 5737 documentation address; no credential value, real peer address, or user datum appears in this report.
