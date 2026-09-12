# Rules

Rules earned by breaking things in this repo. Each cites the defect that produced
it, in the house style of `/storage/bitcoinmachinecode/docs/ENGINEERING_RULES.md`:
a rule without its scar tissue gets argued away by the next session.

---

## 1. Measure the node before you poll it

**Never choose a timeout, a poll interval or a concurrency from intuition about
how fast a Bitcoin node "should" be.**

Chosen on intuition first, then measured: `getblockcount` against the bench node
during initial block download took **40.4 s** (`docs/MEASUREMENTS.md` §1). The
default timeout at the time was 20 s and the fast tier was 4 s — so the monitor
would have reported a healthy-but-busy node as unreachable, tripped its own
circuit breaker repeatedly, and stacked an unbounded queue behind a call that was
already too slow.

Three code changes came out of that one measurement: 90 s ceiling, adaptive tier
cadence (`monitor.effectiveTierMs`), and coalesce-or-drop for poll jobs.

**In practice:** new numbers go in `docs/MEASUREMENTS.md` with a date and a
reproduce command before they go in `server/config.js`.

## 2. Zero dependencies, and no CDN

Nothing is `npm install`ed. Node builtins, `node:test`, hand-written canvas.

This box serves a LAN, gets no outbound access from browsers on the wrong VLAN,
and an install step is also a supply-chain step for a tool that holds a path to
the node's RPC cookie. It also means the charts are ~400 lines instead of a
dependency tree.

If a dependency ever looks necessary, the answer is to write less UI, not to add
one. (`zmq` is not even importable on this box — Python-side ZMQ was not an
option either.)

## 3. Never accept a CSRF token from the cookie

The first version read `header ?? body ?? cookies.blockyard_csrf`. Testing it with
`curl -b cookies.txt` — i.e. a request carrying **only** the cookie — returned
200. The check was decorative: a cross-site request carries the cookie just as
happily, and the whole point of double-submit is the part a cross-origin page
cannot do, which is read the cookie and echo it in a header.

Fixed to header-or-body only, compared against the server-side session value.
**A credential is never validated against a value the attacker also controls.**

## 4. A Map key is not a dedupe key

`pending` became a keyed Map so a fresh poll could supersede a stale one. Unkeyed
jobs were inserted with a generated Map key but the code deleted
`pending.delete(first.key)` — `key` was `null` for unkeyed jobs, so nothing was
removed, and `_drain` re-read the same stale entry forever:

```
RangeError: Maximum call stack size exceeded
    at Lane._drain (client.js:104)  x 40 frames
```

`node --check` passed. Every unit test passed. Only booting it found this.
**Store the map key on the entry; never derive a deletion key from an optional
argument.**

## 5. Boot it; syntax checks and unit tests find none of the interesting bugs

Three defects in one evening survived `node --check` and a green test suite and
appeared only on the first run: rule 4's recursion, `m.id` undefined in the boot
banner (the monitor had `state.id` but no `id` getter), and a
`if (self_blocks_ahead: true)` placeholder left in `scripts/fake-node.js`.

**`npm test` is necessary and nowhere near sufficient. `npm run dev` plus a curl
of the real endpoints is the actual gate.** `scripts/smoke.sh` exists to make that
one command.

## 6. Chart datasets do not belong in the live frame

The SSE snapshot carried the mempool scatter (1,500 points) and 120 blocks in
every 1-second push: **112,665 bytes per frame per client**. After moving the
scatter to `/api/mempool` and trimming block history to 40: **25,509 bytes**.

With eight tabs open that was ~900 KB/s for almost no information gain, on a box
whose node was busy syncing 300 GB.

**Ask of every field: does this change every second?** If not it rides the 20 s
`series` event or an on-demand endpoint.

## 7. Parse against real lines, never against remembered ones

Written from the shapes in the terminal scrollback, then checked against the
actual file, the parser was wrong twice:

| assumed | real |
|---|---|
| `-- peers banned: N of M --` | `-- peers banned this run: N of M --` |
| tags are `[a-z0-9]+` | `[tx_accept]` has an underscore — the tag silently vanished |

Both were caught by `test/logparse.test.js` against `test/fixtures/log-samples.txt`
(22 frozen real lines). Also found there: a genuine new line shape worth parsing
(`[config] conns: max=256 outbound=11 (...) inbound=245`).

**Fixture files come from `zcat the real log`, not from typing.**

## 8. Absent beats zero

Three places the node cannot answer, each of which a naive panel would report as a
number:

- `getnettotals` → 0 bytes: an "upload: 0 B/s" chart would imply an idle uplink
  when the truth is "this build does not publish the counter".
- `getpeerinfo` → `[]`: "0 peers" while `getconnectioncount` says 13.
- `estimatesmartfee` → no feerate: a cold estimator says "unset"; Core does too.

Every one is rendered as `–` plus a reason, and named in `health.quality`. The
node's own docs use exactly this standard ("omitted rather than reported low …
a short count that looks real is worse than an absent one"). **A monitor is the
one place a plausible fake is unforgivable, because it is what you trust when you
decide the node is fine.**

**The corollary the first cut missed: a zero can also be a *ratio*'s fault.**
Measured 2026-09-08 on the bench build: `getnettotals` reported **12,896,531,244
bytes received against 1,129 sent, with 21 peers connected**. `Δ(sent)/Δt` is
arithmetically `0 B/s` and is still a lie — no node receives 11 million times what
it sends while pulling 12.9 GB of blocks it must have requested. So the guard is
not "is the counter zero" but "is this number possible", and the check that caught
it is a sentence in the flag text: *impossible ratio, upload absent not zero*
(`upload-unmeasurable`). Absent-beats-zero needs a magnitude sibling.

## 9. Two similar numbers are not one number

`blocks/headers` and `verificationprogress` both read ~67% during the observed
IBD, and the temptation is one `pct` field, or `Math.max(...)` for a "safety"
margin. They measure different things — blocks held vs announced headers, and
difficulty-weighted work done. The bar fills with the first; the second is drawn
as a separately labelled tick on the same track, and the caveat appears only when
they actually disagree.

Same rule for the ETA: recent-window rate drives it, the 10-minute rate is kept
separately as `etaOptimistic`, and a falling rate is reported as `rateTrend` with
a caveat saying the ETA will get **longer**.

## 10. The test expectation can be the bug

Two failures in `test/sync.test.js` were my arithmetic, not the code:

- expected `50.0001%` for 482,996/965,993 — that is 49.9999%, being 0.5 below half.
- expected uptime `21,081,000 ms` for `00:14:15:21` — I read the field order wrong.
  The code's `51,321,000 ms` (= 51,321 s) matched the node's own `uptime` RPC
  **exactly**, which is the cross-check that settled it.

**When a test fails, prove which side is wrong before editing either.** Fixing
code to match a bad expectation would have baked in an inverted uptime format —
exactly the class of bug the parent project's rule 1 exists to stop.

## 11. Beware `pkill -f` in a shell script

`pkill -f "server/main.js"` inside a `bash -c` block matched the block's **own**
command line (it contains that literal string) and killed the shell mid-script,
silently discarding the rest of the test run and producing no output at all.

Kill the listener, not a pattern: `kill $(ss -tlnp | grep <port> | grep -oE 'pid=[0-9]+')`.

## 12. A cap is a ceiling, never a floor

`effectiveTierMs` stretched a poll tier to at least 2x observed RPC latency,
capped so a wedged node was not hammered:

```js
const cap = Math.min(Math.max(base * 8, 30_000), 180_000);
return Math.min(cap, Math.max(base, stretched));
```

For the rare tier `base` is 900,000 ms (15 min), so `cap` became 180,000 and the
`Math.min` returned **180,000** -- the most expensive tier (getpeerinfo,
getdeploymentinfo, getrpcinfo) was being polled five times as often as
configured, on the one box where RPC cost is the whole design constraint.

A ceiling that can fall below the thing it caps is a floor wearing its clothes.
**Cap above the base, always:** `Math.max(base, Math.min(...))`.

The same bug hid itself in the UI: the cadence panel looked up
`tierIntervalMs['rareMs']` where the key written was `'rare'`, so it always
displayed the configured value and reported `stretched: false` while the poller
was stretching. A dashboard that echoes its own settings back rather than its
actual behaviour is worse than no dashboard, because it makes the setting look
verified. Both now covered by tests in `test/rpc-lane.test.js`.

## 13. Assert that an edit landed; `replace()` reports nothing

Several file edits in this session were `python3 - <<'PY' … s.replace(old, new)`.
One of them failed to match — the file contained an em-dash `—` where the pattern
had `--` — and `str.replace` does not complain about matching nothing. The script
printed "patched", the diff looked plausible in the next `git status`, and the
stale text went into a commit **and was pushed**.

What was stale was not cosmetic: `docs/DEFECTS.md` claimed `panels.js` did not
exist and that every page but Overview was blank, after all eight pages had been
written and verified against a live node. A doc that contradicts the code is
worse than no doc, because the next session trusts the doc and goes looking for a
bug that is not there.

**In practice:** any scripted edit carries `assert old in s` (or the edit tool,
which fails loudly). After scripted doc edits, `grep` for the *new* string and
for the *old* one — the second must be gone. Prefer one edit call per file over a
script that patches four files and prints a cheerful summary.

## 14. A destructured parameter is not in scope from the caller's head

`caveatsOf()` builds the explanation lines under the sync bar. Three separate
times, in that one function, a new caveat read a value that was never passed to
it:

| read | declared as a parameter | passed at the call site |
|---|---|---|
| `rateTrend` | no | no → `ReferenceError` at first test |
| `etaBestSec` / `etaWorstSec` | no | no → `ReferenceError` |
| `reason` | **yes** | **no** → silently `null`, no crash, caveat never appeared |

The third is the dangerous one: adding a parameter to the signature without
adding it to the call site is not an error in JS — it is just `undefined`, so the
caveat quietly stopped firing and the test suite was the only thing that noticed.

**In practice:** when a helper's body grows a new input, change the signature and
the call site in the same edit, and give the new input a test that fails if the
value is absent. `test/sync.test.js` now asserts the caveat text itself, not just
that `caveats` is a non-empty array — an assertion of "some caveat exists" would
have passed all three times.

## 15. A parsed source needs a canary, not only a parser

The monitor's own docs say the node's log is a *primary* source, and for two hours
on 2026-09-08 that source was read by nobody. Two independent failures, neither of
which produced a single warning:

1. the bench node's `logFile` pointed at `<datadir>/main/debug.log`, a 144-byte
   stub written at boot, while the node wrote to `console.log`;
2. the bench build rewrote `[dlc]`, so even the live file yielded **1 parsed line
   in 1,006**.

Every panel simply stopped changing. `exists: true` was true, the fd was open,
`readErrors` was 0 — the data was being read from the wrong place, and absence of
data looks exactly like absence of activity.

**In practice:** any source you parse rather than call needs three things, and
none of them is a parser:

- **a coverage ratio that is published**, not just computed — `log.health.ratio`
  says what share of the last window of lines a rule actually claimed;
- **a threshold on a frozen real sample** — `test/bench-log.test.js` asserts
  ≥0.85 over every 12th line of a real 90-minute run. It cannot pass on a fixture
  of hand-picked lines, which is why there are two fixture files with two jobs;
- **a stall flag that names what it checked** — `log-silent` reports the block
  delta observed during the silence, because "the log is stale" is a guess and
  "the chain advanced 15,000 blocks while the file sat still" is a diagnosis.

The corollary applies to the numbers a parser *does* return: when the node prints
`(median 353.4)` with no unit, keep the text and leave the number null (rule 8).
A unit guessed to fill a gap is the same mistake as the file guessed to fill a
config field.

**Update the same day, the same rule failing again — and the gate being too coarse.
At 05:42 the build added one field** (`| staged 1`) **to the `[dlc]` tick, and 26 of
26 tick lines stopped parsing.** `log-unparsed` did not fire, because it is a <5%
gate across all lines and that run still parsed ~24% overall: a ratio over every
line hides the death of one rule. Two fixes are owed, and DEFECTS records both:

- coverage must be reported **per rule** — "the bandwidth rule last matched 12 min
  ago while 26 tick-shaped lines arrived", not one blended percentage;
- a labelled line should be scanned **field by field**, not matched end-to-end, so a
  new or reordered field costs that field and not the line.

The general form: a coverage metric averaged over a corpus measures the corpus. The
failure is always local to one shape.

## 16. A parser that matches a whole line is a parser that loses the whole line

Rule 15 said a parsed source needs a canary. Four times on 2026-09-08 the same
mechanism then proved the second half of the lesson: **match a labelled line end to
end, and one new word is a total loss.**

| time | the one thing that changed | lines matched |
|---|---|---|
| 05:42 | `[dlc] --` gained `\| staged 1` | 0 of 26 |
| 06:14 | it gained `commit 6288` too | 0 of 30 |
| ~06:22 | `[dlc] ==` became `(no gap, 100.00% landed)`; `eta` became `--:--:--:--` | 0 of 185 |
| 06:22 | a whole new tag, `[serve] inbound …` | 0 of 646 |

Three of those four are the *most important* figures on the page — bandwidth, the
node's IBD progress and its own eta — and in each case the pattern still matched
*something*, so nothing looked broken from the outside: the corpus ratio stayed at
24%, 68%, 74%. What died was a single rule.

**In practice:**

- **Scan labelled lines field by field.** Split on the label separator, match each
  labelled field independently, and require two recognisable fields before claiming
  the line. Then a new field costs that field: it lands in `extraFields`/
  `extraValues` verbatim (`staged: "26"`, `commit: "6484"`) and the numbers keep
  flowing. `MEASUREMENTS 17` has the before/after coverage.
- **Delete the rigid rule when the scanner replaces it.** Keeping the old one "as a
  fallback" is how you end up with two paths, one of which silently stops being
  taken. One path, tested against both grammars in the fixtures.
- **A placeholder the node itself prints is information.** `eta --:--:--:--` means
  *no estimate*; decode it to `null`. Coercing it to `0` would have meant "arrives
  immediately", and to a large number would have meant "never" — both are invented.
- **Aggregate the repetitive, forward the rare.** 323 `v2 handshake failed` lines are
  one sentence ("323 inbound connections, all from 127.0.0.1, dropped before BIP324
  completed"), and 323 feed rows are that sentence buried. The shutdown line happens
  once and belongs in the feed verbatim.

## 17. A warning is a claim, and it can be wrong in two directions

Rule 16 ended with "scan labelled lines field by field". Shipping that produced the
per-shape liveness flag — and then the flag produced two of its own defects, both
caught by testing it against the live node rather than against my expectation of it:

1. **It accused a synced node of losing its bandwidth figure.** I had inferred "is
   this node in IBD?" from log shapes, and the tailed history contained `[utxo_live]
   catchup progress` from the post-boot catch-up — which a synced node also emits.
   The node had said `initialblockdownload: false, verificationprogress: 1,
   blocks == headers` in the same second. **A source that answers directly outranks a
   source you interpret**, and where neither answers, say unknown and do not watch.
2. **It announced a restart that had happened four hours earlier.** The tail backfill
   replays history, so `[serve] shutting down (signal 15)` arrived with an old
   timestamp and produced a present-tense warning. Age-gated, and cleared the moment
   `getblockchaininfo` answers. The event still goes to the feed, where its timestamp
   speaks for itself — the difference between a record and a claim is that a record
   carries when.

Both directions matter. A flag that never fires is decoration; a flag that fires on a
healthy node is worse than no flag, because the fix is someone learning to ignore it.
The two devices that keep this one honest are both boring:

- **Gates from measured cadences** — p95 × 8, clamped — with shapes listed by name in
  `MEASUREMENTS 19`, including the two (`updating utxo`: 460/1868/3669 s, `header
  mirror`: 502/2054/3669 s) that are parsed and **deliberately not watched** because
  they are bursty. Irregular + watched = ignored.
- **Arm on first sight** — a shape is only watched once its rule has matched, so a
  build that never emits `heartbeat` (the bench build) or emits a bandwidth tick twice
  in three hours (production, synced) is excused without maintaining a table of
  builds. That table would have been stale by this afternoon; four grammars changed
  today.

Same principle decided a smaller thing in the same file: silence is measured against
**event time, not wall clock**, because the bench node block-buffers its stdout and
delivers minutes of history in one burst. Judged by arrival time that is a 4-minute
silence every few minutes; judged by the log's own timestamps it is zero, which is
what actually happened.

## 18. A hermetic run must not inherit the machine's config

`scripts/smoke.sh` pinned its data dir, its fake-node port, its admin password and its
log level — everything except **which address to bind**. That was fine while the default
was `0.0.0.0`. Then a *deployment* decision went into `config/local.json` ("bind this
box's LAN + tailnet addresses"), and the next smoke run curled `http://127.0.0.1:18099`
against a server listening somewhere else. Result:

```
passed: 2   failed: 54
  FAIL weak password refused
  FAIL audit recorded the admin action
```

Nothing about passwords or audit was wrong. Nothing had answered. Two things made that
expensive, and both are now fixed in code:

- **The machine config had no opt-out.** `BLOCKYARD_CONFIG=none` now exists, and both
  `scripts/smoke.sh` and `npm run dev` set it *and* pin `BLOCKYARD_BIND=127.0.0.1` — so
  neither inherits a laptop's or a server's notion of where it should be reachable.
  Asserted in `test/config-nodes.test.js` against the scripts' own source, because a
  convention nobody checks is a wish.
- **The readiness loop fell through.** It waited for `/api/health`, gave up after 18
  seconds, and let the script continue into 54 contract assertions against a port that
  never answered. It now stops with: *"server never answered at $BASE — not a contract
  failure, a wiring one."* A cascade of downstream failures is not a diagnosis; it is
  the removal of one.

Same incident, quieter lesson: the log line that would have explained all of it —
*"not on 127.0.0.1 either"* — was logged at **info**, and smoke runs at
`BLOCKYARD_LOG_LEVEL=warn`, so it was invisible in exactly the situation it existed for.
A diagnostic's level is part of the diagnostic.

<!-- Renumbered 2026-09-09: this heading said "15", which is already the log-canary
rule above, and both were cited as "rule 15" in three files. A citation that can mean
two rules is a citation that proves nothing. -->
## 19. Force-pushing a rewrite does not remove the old commits from GitHub

After scrubbing the machine username and host addresses out of history with
`git filter-repo` and force-pushing, the branch and its tarball were verifiably
clean -- 61 files, 27 commit messages, zero hits. That check would have let me
report "wiped", and it would have been wrong.

The pre-rewrite commits were still served. Requested by their old SHAs, they
returned HTTP 200 with (a) the original author name and email, and (b) a file body
still containing the unit's `User=` line naming the operator's login account. The
`raw.githubusercontent.com` route for the same commit did return 404, which is
exactly the kind of partial signal that makes a check pass for the wrong reason.

So a rewrite removes the values from the *branch*, not from the *repository*.
Objects left dangling by a force-push stay reachable by SHA until GitHub's
housekeeping collects them, which is not something to wait on or assume.

**In practice:** when a secret or personal identifier has actually been pushed,
verifying the branch is not the check. Request the old SHA; if it answers, the fix
is delete-and-recreate the repository (or GitHub support for anything genuinely
sensitive), not another force-push. Ask what the check can actually see -- "is it
in HEAD" and "is it in the repository" are different questions, and only one of
them is the question you care about.

The other lesson, from the attempt right after this one: writing this rule with the
leaked values quoted verbatim re-introduced them into a fresh commit, and the sweep
caught it only because the sweep ran before the next push. Document a leak by
describing it -- `User=<login>`, a redacted SHA, a documentation-range address --
because prose is content too, and it gets published on the same terms as the config
file you just cleaned up.

## 20. An env var is a string until code decides otherwise

`server/config.js` had a table of env vars, each with a cast. `env()` implemented
`Number` and `Boolean` and returned the raw string for everything else — including
every entry whose cast was a *function*. Nothing failed. The values were simply the
wrong shape, in the direction that matters:

| variable | intended shape | what it actually became | consequence |
|---|---|---|---|
| `BLOCKYARD_ALLOW_CIDRS` | list of networks | the string `"203.0.113.0/24"` | the gate iterated it character by character, parsed nothing, and refused **every** address — the documented way to restrict the monitor to a LAN was a deny-all that also locked out the operator |
| `BLOCKYARD_ACTIONS` | list of action names | a string | `allow.includes(name)` became a substring test on a string, i.e. permissions decided by substring matching instead of set membership |
| `BLOCKYARD_HOST` / `_BIND` | list of addresses | a string | survived by luck only, because `validate()` re-splits a string there |

Found by `test/cidr.test.js` on 2026-09-09, which was written to test CIDR matching,
not config parsing. That is typical: the bug surfaced as a side effect of testing the
layer *below* the one where the mistake was.

**In practice:** any value whose type is a list, a set, or a parsed thing must be
constructed by code, and the construction must be asserted. A cast table where half
the casts are silently ignored is worse than no table, because it documents the
intents that the code does not carry out. When a config value gates a permission or a
firewall, assert the failure direction too: a malformed list must deny (or refuse to
boot), never admit.

## 21. A guard that compares two documents proves they are wrong together

The documented test count drifted out of sync three times on 2026-09-08. The fix at
the time was a test asserting that `README.md` and `AGENTS.md` stated the same
number. That test passed on 2026-09-09 while the docs said 180 and `npm test` printed
183.

Self-consistency is not truth. Two documents can agree to be wrong, a refactor can be
"consistent" with a spec nobody follows, and an assertion that compares a file to
itself — or to its sibling — has no way to notice reality.

**In practice:** derive the number from the artifact it describes (here: count the
declarations in `test/**/*.test.js`), then validate the *derivation* — `scripts/doc-counts.js`
counts declarations, and the test runs three real files through `node --test` and
compares the reporter's count with the scanner's. If a scanner can silently undercount,
the derived number is a nicer-looking version of the same bug. `npm run counts:fix`
writes the docs from the suite, so the number is never typed twice.

The same shape appeared twice more the same day: a grep-based assertion that matched
nothing and "passed", and an end-to-end check whose positive result came from a route
that 404s for the wrong reason (rule 19). Ask of every green check: *what would this
print if the thing were broken?* If the answer is "nothing", it is not a check.

## 22. Do not hijack a shared global to observe it

To assert that the monitor warns at boot when it is serving plaintext, a test replaced
`process.stdout.write` for the duration of a boot. It captured the warning, and also
captured the test runner's own TAP output — because Node runs a file's top-level tests
concurrently and the runner writes to the same stream. The result was a file where one
test's *result line disappeared entirely*: the test ran (a probe `console.log` proved
it), other tests reported around it, and the summary counted six tests when seven were
registered. Debugging that meant suspecting the code under test, the app's boot path,
and the TLS stack, in that order, all innocent.

**In practice:** a test that needs to observe something gets a seam in the code — here
`boot({ log })`, a logger injection with the production default kept. Same for clocks
(`loadConfig({ now })`, which is how the expired-certificate branch is tested without
shipping a certificate that expires on a Tuesday) and interfaces
(`loadConfig({ ifaces })`, rule 18). Never capture `process.stdout`, `process.env`
en-masse, timers, or the DOM from the outside when one parameter would do: an outside
observer of shared state competes with everything else using it, and its failures look
like the failures it is watching.

A related trap from the same session: making a failure impossible in a test by making
a file read-only does not work — rename is governed by the *directory's* permissions,
so the rotation under test succeeded anyway. Make the obstacle the kind the code
actually hits (a non-empty directory where the rotated file must go), and confirm the
obstacle throws by itself before trusting a test that depends on it.

## 23. Open by default is a posture; ship it with a ceiling and a loud line

The ask was "no login required, unless we set the config to support it" — a block
explorer. That is a reasonable posture for a read-only monitor on a LAN. The version of
it that ships by accident is not, because the obvious implementation has a hole shaped
like this:

```js
if (route.auth !== 'none') {
  if (!session) return 401;                       // skipped entirely when auth is off
  if (route.auth === 'admin' && user.role !== 'admin') return 403;
}
```

Move the session check behind a flag and the admin check goes with it. "No login
required" becomes "no login required, and anyone may create accounts" — the first
anonymous visitor makes themselves admin. The fix is structural, not a careful `if`:

- **A ceiling that is not a config value.** `viewer`, frozen, with no credential able
  to raise it. The admin routes keep asking for `admin`, and the role check runs on
  **both** branches — authenticated and anonymous.
- **Refuse the vacuous gate.** With no roles to check, `role: 'admin'` on an action is
  a comment. So `BLOCKYARD_ENABLE_ACTIONS=1` while accounts are off is a **boot error**,
  and the deliberate way around it (`BLOCKYARD_ALLOW_WRITES_WITHOUT_AUTH=1`) has to be
  chosen twice.
- **Re-derive the checks that assumed a cookie.** CSRF exists because a cross-site
  request can ride a session cookie; with no session there is nothing to ride, and
  keeping the check only breaks the console. Say why in the comment, then assert the
  two things that made skipping it safe (the ceiling, and writes refused).
- **Meter per address, not per identity.** Every anonymous client sharing one `user.id`
  means one chatty tab spends the whole LAN's rate-limit budget.

And say it out loud: the boot line names the addresses that are now readable, what
"read" actually grants (including the read-only RPC console), and the one switch that
closes it. "Anyone on the LAN can read your node" must never be discovered from a
screenshot.

The tail of this one is the test suite's version of the same mistake: the open-mode
tests are mostly *not* about what open mode allows. They assert the ceiling —
`/api/users` 403, `/api/audit` disabled, `/api/login` answering
`accounts_disabled` rather than `bad_credentials`, writes refusing even with
`confirm` matching. A test that only checks "the dashboard loads without a login"
would have passed against the vulnerable version above.

## 24. Node runs a file's tests concurrently; do not let them share `process.env`

Two test files "proved" the server was broken and neither bug existed.

`test/open-access.test.js` had a test asserting the default config, which sets
`BLOCKYARD_AUTH=1` for the duration. A sibling test in the same file booted the server
and got **401** — it had read the other test's environment. Same variable, same
process, overlapping in time. Verified directly:

```
test('a', async () => { process.env.PROBE='a'; await sleep(60); });   // b sees "a"
test('b', async () => { await sleep(20); });                          // while b is mid-await
```

`--test-concurrency` does not change this: it governs files, not tests within a file.

The fix is not to serialise the tests, it is to give them nothing shared to fight
over. `test/helpers/http.js` now touches **no** environment: configuration goes into a
temp config file passed explicitly to `boot({ configFile })` (which is also what keeps
this box's `config/local.json` out of a run — rule 18), and the bootstrap admin's
password is read back from `app.bootstrap` instead of injected via
`BLOCKYARD_ADMIN_PASSWORD`. Env-var assertions live in `test/config-env.test.js`, which
boots nothing at all, so nothing can read the wrong config.

Two related traps hit on the same path:

- **A helper that throws before its `finally` leaks state.** The old helper mutated
  `process.env`, then validated the config *outside* the `try`: an invalid-config test
  left the variables set for the rest of the file, and the next two failures named an
  unrelated test's config error. Anything that mutates global state must establish the
  `finally` first.
- **Env is also how a test disables TLS verification**, and nothing built-in replaces
  that one (`fetch` has no per-request dispatcher reachable from `node:`), so
  `test/tls.test.js` sets and restores that single variable itself, around its own
  body, with the reason written down.

And the shell equivalent, since it bit the same afternoon: `trap cleanup EXIT` followed
by a second `trap cleanup_open EXIT` does **not** stack — the second replaces the
first. Smoke stopped reaping its main server, which then held port 18099; the next run's
readiness loop found *that* answering and asserted 100-odd checks against a leftover
instance whose login bucket was already drained. One handler, on `EXIT INT TERM`, and a
preflight that refuses to run against a busy port — because a suite silently testing
yesterday's process is the check that passes for the wrong reason (rule 21).

## 25. A browser harness that cannot reload is measuring the previous build

`scripts/browser-check.mjs` navigated with `Page.navigate({url})`, and the URL differed
from the page already loaded only in its `#fragment`. That is not a navigation: the old
document, with its pre-deploy JS and CSS, keeps running and answers every question you ask
it. Every alarming reading this harness produced against a warm browser was that — a block
map reporting `401 rects laid out, 0 painted pixels`, a CSS pass that appeared to evaluate
an older function than the bytes the server was sending, `applyMiningStyles` writing
`--pool` into `style="--pool: ..."` where the committed source uses `setProperty`.

None of it was in the app. The map painted 100% of its pixels the moment the harness was
made to actually load the current build (`?t=<ms>` on the URL, verified 2026-09-10,
`gnTreemap` and `gnMempoolTreemap` both `paintedPixelsPct: 100`).

This is rule 21's instrument-error failure mode in a new costume, and it cost hours: a
"bug" that reproduces only in the tool reproduces nowhere. Before believing any claim
about a rendered page — especially a claim that contradicts the source you are reading —
prove the browser is running the bytes you served, by reading a build marker in the page,
not by trusting the URL bar. The same discipline already exists for the test suite, which
refuses to run against a busy port for exactly this reason.

## 26. A view that must not move may depend only on constants

The block-space viewer had to keep its bottom-left corner pinned while blocks
animated over it. Three attempts failed in a row, and all three failed the same
way: each fixed the *framing* and left something *varying*.

1. **Fit to the measured scene.** The scene includes blocks in flight, whose
   extent changes every frame. Obviously wrong once stated.
2. **Fit to the grid's measured corners.** Better, but the growth expansion was
   applied about a vanishing point computed as positive while the flipped board's
   projected `y` runs negative, so the bounds skewed and the picture sank.
3. **Map the board's corners to the panel's corners.** No measurement at all, so
   row 0 sits on the canvas floor by construction and bottom-left *cannot* move.
   The operator still reported "it shift down on first transition", and they were
   right: the mapping's **scale** was `ph / (gridH * unit)`, and `gridH` was the
   packed extent. A packing one row taller shrank the vertical scale, compressed
   the picture toward the floor, and walked the top edge down the panel.

The corner that was pinned had been pinned for two rounds. The thing that moved
was never the framing.

The same defect had a second head. The perspective constant `risePerUnit` was
derived from *this round's* lane stack, so a quiet round and a busy round on the
same board got cameras nearly 3x apart in depth scaling. The first paint is a
no-op self-transition with one lane, so it took the shallow-stack value and drew
every cube's dark front lip almost three times too tall — and either side of the
vanishing line that lip flips from pointing up to pointing down through a
degenerate triangle. The operator saw "dark triangles on load that go away after
the first animation", which is an exact description of a camera swap.

**The rule.** When a view is required to hold still, enumerate every input to its
transform and require each one to be a constant of the *board*, not of the round.
Write the enumeration down. Both defects here are one sentence once the inputs are
listed: `gridH` varies, and `risePerUnit` varies.

**Testing it.** Do not assert on the source text of the framing — a test that
matched `BOTTOM-LEFT IS FLUSH WITH THE PANEL` and the literal `setTransform`
arguments passed happily while the scale underneath it moved, because it pinned
the *approach* rather than the *property*. Assert the property directly: render
two pools that differ as much as the data ever will, and require the recorded
transform to be identical. That test fails against all three earlier attempts.

**The cost of making a bound constant.** The old `risePerUnit` was honest — it
bounded growth using the lane stack actually built. A constant must assume a
worst case, so restate the bound rather than deleting it: it holds while the
stack fits under the compression ceiling, and past that blocks fly beyond the
panel edge. Say which, in the code, at the line that made the choice.
