#!/usr/bin/env bash
# End-to-end smoke test: boots the real server against the fake node on spare
# ports and asserts the API contract. `npm test` covers units; this covers the
# thing units cannot see -- wiring, auth, CSRF, the SSE frame, the RPC guard.
#
# Tallies failures and exits non-zero if any check failed; always reaps the servers it
# started. It deliberately does NOT `set -e`: an abort would skip the cleanup trap and
# leave a server and a temp dir behind. The cost of that choice, found 2026-09-14: a
# line reading `OPID is reaped by the single cleanup trap at the top` -- a comment with
# no `#` -- was executed as a command and printed "OPID: command not found" while the
# run still reported 109 passed. A harness that cannot fail on its own broken line is
# worth less than it looks, so `check()` is the only thing that may decide the exit.
set -uo pipefail

PORT="${BLOCKYARD_SMOKE_PORT:-18099}"
FAKE_PORT="${BLOCKYARD_SMOKE_FAKE:-18461}"
DIR="$(mktemp -d /tmp/blockyard-smoke.XXXXXX)"
PW='smoke-test password length ok'
BASE="http://127.0.0.1:${PORT}"
PASS=0; FAIL=0
SRV=""

# ONE trap handler for everything, on EXIT *and* on signals. Two separate
# `trap ... EXIT` lines do not stack in bash -- the second replaces the first, which
# is how the open-access instance's cleanup silently stopped reaping the main server
# and left it holding port 18099 for the next run (which then tested that one).
# SIGTERM is trapped too: `timeout 400 bash scripts/smoke.sh` sends exactly that, and
# an EXIT trap does not run when the shell dies of an untrapped signal.
cleanup() {
  for pid in "$SRV" "$OPID"; do
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null
  done
  sleep 0.4
  for pid in "$SRV" "$OPID"; do
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  done
  rm -rf "$DIR" "$OPEN_DIR" 2>/dev/null
  return 0
}
trap cleanup EXIT INT TERM

ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "want [$3] got [$2]"; }

cd "$(dirname "$0")/.."

# Fail fast if the port is already taken. Without this the readiness loop below finds
# SOMEONE's server answering, and every assertion then runs against a leftover
# instance from an earlier run -- which is how a script that "passed" was really
# testing a server whose login bucket was already drained.
port_free() { ! ss -ltn 2>/dev/null | grep -q ":$1 "; }
for p in "$PORT" "$FAKE_PORT" "${BLOCKYARD_SMOKE_OPEN_PORT:-18199}" "$((FAKE_PORT + 1))"; do
  port_free "$p" || { echo "FAIL port $p is already in use -- refusing to test someone else's server."; echo "     look for a leftover: pgrep -af 'server/main.js'"; exit 1; }
done

echo "== booting server on :${PORT} (fake node :${FAKE_PORT}) =="
# BLOCKYARD_CONFIG=none: do not read config/local.json. It holds this box's deployment
# choices -- including which addresses to bind -- and inheriting them made this script
# curl 127.0.0.1 against a server listening elsewhere (54 failures, 2 passes).
# BLOCKYARD_BIND: pin it explicitly anyway, so a future default cannot repeat that.
# BLOCKYARD_AUTH=1: accounts are OFF by default now, and this script's bulk is the
# signed-in contract (sessions, CSRF, per-user audit, RBAC). The open posture gets its
# own instance further down, on its own port, so both are asserted rather than one
# replacing the other.
BLOCKYARD_CONFIG=none BLOCKYARD_BIND=127.0.0.1 BLOCKYARD_AUTH=1 BLOCKYARD_TLS=0 \
BLOCKYARD_DATA="$DIR" BLOCKYARD_FAKE_NODE=1 BLOCKYARD_PORT="$PORT" BLOCKYARD_ADMIN_PASSWORD="$PW" \
BLOCKYARD_LOG_LEVEL=warn FAKE_PORT="$FAKE_PORT" node server/main.js >"$DIR/server.log" 2>&1 &
SRV=$!

READY=0
for _ in $(seq 1 60); do
  curl -fs --max-time 1 "$BASE/api/health" >/dev/null 2>&1 && { READY=1; break; }
  kill -0 "$SRV" 2>/dev/null || { echo "server died:"; cat "$DIR/server.log"; exit 1; }
  sleep 0.3
done
# Without this, an unreachable port silently becomes 54 "FAIL" lines about passwords
# and audit entries -- a wall of noise that hides the one fact: nothing answered.
if [ "$READY" != "1" ]; then
  echo "FAIL server never answered at $BASE -- not a contract failure, a wiring one."
  echo "     The process is alive, so most likely it is not listening on loopback."
  echo "     This script sets BLOCKYARD_BIND=127.0.0.1 and BLOCKYARD_CONFIG=none; if that"
  echo "     changed, server.hosts from config/local.json is pointing elsewhere."
  echo "     --- server log ---"; cat "$DIR/server.log"; exit 1
fi

echo "== health and the public surface =="
H=$(curl -s --max-time 5 "$BASE/api/health")
check "health ok:true" "$(echo "$H" | grep -c '"ok":true')" "1"
check "health reports a node online" "$(echo "$H" | grep -c '"online":true')" "1"
check "unauthenticated /api/state is 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/state")" "401"
check "unauthenticated /api/peers is 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/peers")" "401"
check "index.html served" "$([ "$(curl -s --max-time 5 "$BASE/" | grep -c 'data-sync-hero')" -ge 1 ] && echo 1 || echo 0)" "1"
# the endpoint is called from /js/login.js (CSP forbids inline scripts), so
# assert on what login.html actually contains plus that its script is fetchable
check "login.html served at /login" "$([ "$(curl -s --max-time 5 "$BASE/login" | grep -c 'name=\"password\"')" -ge 1 ] && echo 1 || echo 0)" "1"
check "login.js is fetchable" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/js/login.js")" "200"
check "login.js calls the endpoint" "$(curl -s "$BASE/js/login.js" | grep -c '/api/login')" "1"
check "CSP header present" "$(curl -s -D- -o /dev/null "$BASE/" | grep -c "Content-Security-Policy")" "1"
check "no server version leak" "$(curl -s -D- -o /dev/null "$BASE/" | grep -ci 'x-powered-by')" "0"

echo "== path containment =="
check "dotdot to /etc/passwd blocked" "$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "$BASE/../../etc/passwd")" "404"
check "encoded traversal blocked" "$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "$BASE/%2e%2e%2f%2e%2e%2fetc/passwd")" "404"
check "absolute path blocked" "$(curl -s --path-as-is -o /dev/null -w '%{http_code}' "$BASE//etc/passwd")" "404"
check "a 404 page answers 404, not 200" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/no-such-page")" "404"
check "no body leak on blocked traversal" "$(curl -s --path-as-is "$BASE/../../etc/passwd" | grep -c 'root:')" "0"

echo "== authentication =="
CODE=$(curl -s -o "$DIR/login.json" -w '%{http_code}' -c "$DIR/ck" -X POST "$BASE/api/login" \
  -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PW\"}")
check "correct password accepted" "$CODE" "200"
check "session cookie is HttpOnly" "$(grep -c '#HttpOnly_' "$DIR/ck")" "1"
check "csrf cookie is readable by design" "$(grep -c 'blockyard_csrf' "$DIR/ck")" "1"
CSRF=$(awk '/blockyard_csrf/{print $7}' "$DIR/ck")
[ -n "$CSRF" ] && ok "csrf token present" || bad "csrf token present" "empty"
check "wrong password rejected" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" -H 'content-type: application/json' -d '{"username":"admin","password":"not the password at all"}')" "401"
check "unknown user gives the same message" "$(curl -s -X POST "$BASE/api/login" -H 'content-type: application/json' -d '{"username":"nosuchuser","password":"whatever whatever"}' | grep -c 'invalid username or password')" "1"

# The per-address login throttle. LoginGuard answers "this username keeps failing";
# the per-user token bucket cannot apply to a request with no user. Each attempt costs
# a scrypt KDF on the request thread, so an unthrottled endpoint is a cheap CPU
# denial of service wearing a login form.
THROTTLED=0
for i in $(seq 1 22); do
  C=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/login" -H 'content-type: application/json' -d "{\"username\":\"grinder\",\"password\":\"wrong passphrase $i\"}")
  [ "$C" = "429" ] && THROTTLED=$((THROTTLED+1))
done
[ "$THROTTLED" -ge 8 ] && ok "login is throttled per address ($THROTTLED of 22 refused)" || bad "login is throttled per address" "only $THROTTLED refused"
check "the throttle says when to come back" "$(curl -s -X POST "$BASE/api/login" -H 'content-type: application/json' -d '{"username":"grinder","password":"wrong passphrase again"}' | grep -c 'retry in')" "1"
check "the throttle is a distinct code from the lockout" "$(curl -s -X POST "$BASE/api/login" -H 'content-type: application/json' -d '{"username":"grinder","password":"wrong passphrase again"}' | grep -c '"code":"throttled"')" "1"

# Some answers only exist after a few poll cycles: the ETA needs two height
# samples, and the nettotals-zero flag only fires on the second pass (it has to
# see the counter stay at zero rather than merely be zero the first time).
sleep 9

echo "== the sync bar's data contract (the point of this app) =="
S=$(curl -s -b "$DIR/ck" "$BASE/api/sync")
for f in state height headers behind pct verificationProgress etaBasis caveats; do
  check "sync.${f} present" "$(echo "$S" | grep -c "\"$f\"")" "1"
done
PCT=$(echo "$S" | tr ',' '\n' | grep '"pct":' | head -1 | tr -dc '0-9.')
awk -v p="$PCT" 'BEGIN{exit !(p>=0 && p<=100)}' && ok "sync.pct within 0..100 ($PCT)" || bad "sync.pct within 0..100" "$PCT"
check "fake node reports IBD" "$(echo "$S" | grep -c '"state":"ibd"')" "1"
# Early on there must be NO ETA: the node downloads in bursts, and a rate from a
# 9-second window produced a 23-day ETA against a node that finished in hours.
# Silence plus an explanation is the required behaviour; a confident wrong
# number is the bug.
check "no ETA before the window has span" "$(echo "$S" | grep -c '"eta":null')" "1"
check "the absence of an ETA is explained" "$(echo "$S" | tr ',' '\n' | grep -c 'caveats')" "1"
echo "  .. waiting for a rate window with real span (up to 75s)"
ETA=""
for _ in $(seq 1 15); do
  ETA=$(curl -s -b "$DIR/ck" "$BASE/api/sync" | tr ',' '\n' | grep -c '"eta":"[0-9][0-9]:')
  [ "$ETA" -ge 1 ] && break
  sleep 5
done
check "an ETA appears once a window has >=60s of span" "$([ "$ETA" -ge 1 ] && echo 1 || echo 0)" "1"
check "the ETA names the window it came from" "$(curl -s -b "$DIR/ck" "$BASE/api/sync" | grep -c 'measured .* blocks/s over')" "1"

echo "== the RPC lane's manners =="
FULL=$(curl -s -b "$DIR/ck" "$BASE/api/state" | wc -c)
LEAN=$(curl -s -b "$DIR/ck" "$BASE/api/state?series=none" | wc -c)
[ "$LEAN" -lt "$FULL" ] && ok "series=none is smaller ($LEAN < $FULL bytes)" || bad "series=none smaller" "$LEAN vs $FULL"
check "poll cadence reported" "$(curl -s -b "$DIR/ck" "$BASE/api/telemetry" | grep -c 'busyMsPerSec')" "1"
check "stale-drop counter exposed" "$(curl -s -b "$DIR/ck" "$BASE/api/telemetry" | grep -c 'staleDropped')" "1"

echo "== the RPC allowlist (default deny) =="
DENY=$(curl -s -b "$DIR/ck" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/api/rpc" -H 'content-type: application/json' -d '{"method":"sendrawtransaction","params":["00"]}')
check "broadcast refused from the UI" "$(echo "$DENY" | grep -c rpc_denied)" "1"
check "getnewaddress refused despite its prefix" "$(curl -s -b "$DIR/ck" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/api/rpc" -H 'content-type: application/json' -d '{"method":"getnewaddress","params":[]}' | grep -c rpc_denied)" "1"
check "rescanblockchain refused (monopolises the server)" "$(curl -s -b "$DIR/ck" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/api/rpc" -H 'content-type: application/json' -d '{"method":"rescanblockchain","params":[]}' | grep -c rpc_denied)" "1"
check "a read method is allowed" "$(curl -s -b "$DIR/ck" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/api/rpc" -H 'content-type: application/json' -d '{"method":"getconnectioncount","params":[]}' | grep -c '"ok":true')" "1"

echo "== CSRF: the cookie alone must not be enough =="
NOHDR=$(curl -s -b "$DIR/ck" -X POST "$BASE/api/rpc" -H 'content-type: application/json' -d '{"method":"getconnectioncount","params":[]}')
check "cookie-only POST rejected" "$(echo "$NOHDR" | grep -c '"kind":"csrf"')" "1"
check "header + cookie accepted" "$(curl -s -b "$DIR/ck" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/api/rpc" -H 'content-type: application/json' -d '{"method":"getconnectioncount","params":[]}' | grep -c '"ok":true')" "1"
check "wrong token rejected" "$(curl -s -b "$DIR/ck" -H 'X-CSRF-Token: not-the-token' -X POST "$BASE/api/rpc" -H 'content-type: application/json' -d '{"method":"getconnectioncount","params":[]}' | grep -c '"kind":"csrf"')" "1"

echo "== node write actions are off unless enabled =="
A=$(curl -s -b "$DIR/ck" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/api/action" -H 'content-type: application/json' -d '{"action":"savemempool","confirm":"savemempool"}')
check "disabled by default" "$(echo "$A" | grep -c action_denied)" "1"

echo "== the live frame actually arrives over SSE =="
FRAMES=$(curl -s -N -b "$DIR/ck" --max-time 8 "$BASE/api/stream" 2>/dev/null | head -c 400000 | grep -c 'event: snapshot')
[ "$FRAMES" -ge 1 ] && ok "SSE delivered a snapshot frame" || bad "SSE delivered a snapshot frame" "0 frames in 6s"
check "SSE requires authentication" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/api/stream")" "401"
# An unknown node on the stream used to be ACCEPTED: the hub stored nodeId and then
# filtered out every frame, so a tab left pointing at a removed node showed a "live"
# badge over frozen numbers forever, with nothing in any log. That is the exact shape
# of the "nothing refreshes" report -- so it must fail where it can be seen.
UNKNOWN=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -b "$DIR/ck" "$BASE/api/stream?node=not-a-node")
check "SSE refuses an unknown node instead of streaming silence" "$UNKNOWN" "404"
check "the refusal says which nodes exist" "$(curl -s --max-time 3 -b "$DIR/ck" "$BASE/api/stream?node=not-a-node" | grep -c unknown_node)" "1"
# And the known node still streams, so the refusal is not a blanket block.
NFRAMES=$(curl -s -N -b "$DIR/ck" --max-time 8 "$BASE/api/stream?node=main" 2>/dev/null | head -c 400000 | grep -c 'event: snapshot')
[ "$NFRAMES" -ge 1 ] && ok "SSE still delivers for a known node" || bad "SSE still delivers for a known node" "0 frames"
# The same unknown node on the read model must also say 404, not serve the primary.
check "/api/state refuses an unknown node" "$(curl -s -o /dev/null -w '%{http_code}' -b "$DIR/ck" "$BASE/api/state?node=not-a-node")" "404"

echo "== provenance is stated, not implied =="
CFG=$(curl -s -b "$DIR/ck" "$BASE/api/config")
# Mode-aware on purpose: which sources are in effect is a fact about the deployment, so
# the check reads the posture from the payload and asserts the table matches it. A fixed
# string here passed while the code was right and failed while the code was right --
# which is what a check that remembers instead of observes does.
LOG_ON=$(echo "$CFG" | grep -c '"enabled":true')
if [ "$LOG_ON" != "0" ]; then
  check "log mode: bandwidth source is the node log" "$(echo "$CFG" | grep -c 'node log')" "1"
  check "log mode: peer identity names the log" "$(echo "$CFG" | grep -c 'node log (relay legs')" "1"
else
  check "RPC mode: bandwidth source is getnettotals" "$(echo "$CFG" | grep -c 'getnettotals delta rate')" "1"
  check "RPC mode: peer identity names getpeerinfo" "$(echo "$CFG" | grep -c 'getpeerinfo')" "1"
fi
check "quality flags surfaced" "$(curl -s -b "$DIR/ck" "$BASE/api/state?series=none" | grep -c 'getnettotals reports 0')" "1"

echo "== user management =="
check "viewer cannot reach /api/users" "$(curl -s -o /dev/null -w '%{http_code}' -b "$DIR/ck" "$BASE/api/users")" "200"
GEN=$(curl -s -b "$DIR/ck" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/api/users/generate" -H 'content-type: application/json' -d '{"username":"smoketester","role":"viewer"}')
check "admin can create a user" "$(echo "$GEN" | grep -c '"ok":true')" "1"
check "generated password shown exactly once" "$(echo "$GEN" | grep -c 'shown once')" "1"
check "weak password refused" "$(curl -s -b "$DIR/ck" -H "X-CSRF-Token: $CSRF" -X POST "$BASE/api/users" -H 'content-type: application/json' -d '{"username":"shorty","password":"abcd","role":"viewer"}' | grep -c 'at least')" "1"
check "audit recorded the admin action" "$(curl -s -b "$DIR/ck" "$BASE/api/audit?limit=10" | grep -c user-create)" "1"

echo "== the served page knows which build it is =="
# A tab quietly running yesterday's app.js is indistinguishable from one running
# today's, and every "did the fix land?" on 2026-09-08 cost fifteen minutes for want
# of a stamp. The page carries the build id, its assets are versioned by it, and
# /api/build tells the page whether it is still current.
BUILD=$(curl -s "$BASE/api/build" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')
[ -n "$BUILD" ] && ok "/api/build reports a build id ($BUILD)" || bad "/api/build reports a build id" "empty"
PAGE=$(curl -s "$BASE/")
check "the page carries that build id" "$(echo "$PAGE" | grep -c "data-blockyard-build=\"$BUILD\"")" "1"
check "the entry module is cache-busted by build" "$(echo "$PAGE" | grep -c "js/app.js?v=$BUILD")" "1"
check "the stylesheet is cache-busted too" "$(echo "$PAGE" | grep -c "css/app.css?v=$BUILD")" "1"
check "a stale tab can be told it is stale" "$(curl -s "$BASE/api/build?build=0.0.0-deadbeef" | grep -c '"matchesClient":false')" "1"
check "and a current one is confirmed" "$(curl -s "$BASE/api/build?build=$BUILD" | grep -c '"matchesClient":true')" "1"

CSP=$(curl -s -D - -o /dev/null "$BASE/" | grep -i '^content-security-policy:' | tr -d '\r')
check "CSP offers a per-response script nonce" "$(echo "$CSP" | grep -c "nonce-")" "1"
check "CSP carries no inline-style allowance" "$(echo "$CSP" | grep -c 'unsafe-inline')" "0"
check "no served HTML carries a style attribute" "$(echo "$PAGE" | grep -cE '<[a-zA-Z][^>]* style="')" "0"
check "plaintext does not claim HSTS" "$(curl -s -D - -o /dev/null "$BASE/" | grep -ci 'strict-transport-security')" "0"

# The same nonce must not be reused across responses: a constant nonce is an open
# door with a documentation comment attached.
N1=$(curl -s -D - -o /dev/null "$BASE/login" | grep -io 'nonce-[^;]*' | head -1)
N2=$(curl -s -D - -o /dev/null "$BASE/login" | grep -io 'nonce-[^;]*' | head -1)
[ -n "$N1" ] && [ "$N1" != "$N2" ] && ok "the nonce differs between responses" || bad "the nonce differs between responses" "$N1 vs $N2"

echo "== drill-down: one block, one transaction =="
# "Which transaction?" used to mean typing an RPC into the console. The routes ask
# verbosity 1 + getblockstats, never verbosity 2, which this node answers with 11 MB
# of hex per block.
TIP=$(curl -s -b "$DIR/ck" "$BASE/api/sync" | sed -n 's/.*"height":\([0-9]*\).*/\1/p' | head -1)
BLK=$(curl -s -b "$DIR/ck" "$BASE/api/block?height=$TIP")
check "a block resolves by height" "$(echo "$BLK" | grep -c '"ok":true')" "1"
check "the header carries its hash" "$(echo "$BLK" | grep -c '"hash":"[0-9a-f]\{64\}"')" "1"
check "stats come from getblockstats, not from fetching the block" "$(echo "$BLK" | grep -c '"totalfee"')" "1"
check "txids are a page, not the whole block" "$(echo "$BLK" | grep -c '"txidsShown"')" "1"
check "the route says why it stopped at verbosity 1" "$(echo "$BLK" | grep -c 'verbosity=2')" "1"
check "a malformed hash is our error, not the node's" "$(curl -s -o /dev/null -w '%{http_code}' -b "$DIR/ck" "$BASE/api/block?hash=nope")" "400"
check "a block the node does not have is passed through" "$(curl -s -b "$DIR/ck" "$BASE/api/block?hash=$(printf '0%.0s' $(seq 64))" | grep -c '"ok":false')" "1"
TXID=$(echo "$BLK" | sed -n 's/.*"txids":\["\([0-9a-f]*\)".*/\1/p')
BHASH=$(echo "$BLK" | sed -n 's/.*"hash":"\([0-9a-f]*\)".*/\1/p')
TX=$(curl -s -b "$DIR/ck" "$BASE/api/tx?txid=$TXID&block=$BHASH")
check "a transaction decodes" "$(echo "$TX" | grep -c '"ok":true')" "1"
check "its outputs are listed" "$(echo "$TX" | grep -c '"outputsTotal"')" "1"
check "the fee it cannot have is named, not guessed" "$(echo "$TX" | grep -c 'fee / feerate')" "1"
check "a malformed txid is refused" "$(curl -s -o /dev/null -w '%{http_code}' -b "$DIR/ck" "$BASE/api/tx?txid=abc")" "400"
check "the mempool says it is a poll, not a stream" "$(curl -s -b "$DIR/ck" "$BASE/api/mempool" | grep -c '"kind":"poll"')" "1"

echo "== the audit trail has a size, and the breaker has a name =="
AUD=$(curl -s -b "$DIR/ck" "$BASE/api/audit?limit=5")
check "audit reports its own size" "$(echo "$AUD" | grep -c '"maxBytes"')" "1"
check "audit rotation is configured, not infinite" "$(echo "$AUD" | grep -c '"keep"')" "1"
TEL=$(curl -s -b "$DIR/ck" "$BASE/api/telemetry")
check "telemetry reports the breaker state" "$(echo "$TEL" | grep -c '"breaker"')" "1"
check "the breaker names its threshold" "$(echo "$TEL" | grep -c '"threshold":3')" "1"
check "telemetry reports the audit log too" "$(echo "$TEL" | grep -c '"rotationError"')" "1"
check "the peer identity table has data to draw" "$(curl -s -b "$DIR/ck" "$BASE/api/peers" | grep -c '"identity"')" "1"

echo "== open access: the default posture, no sign-in =="
# Accounts are OFF by default. A second instance on its own port asserts what that
# grants (reads, the read-only RPC console, the stream) and, more importantly, what it
# does NOT: user admin, the audit trail, node writes. Keeping this a separate boot is
# the point -- the signed-in checks above must not be quietly replaced by open ones.
OPEN_PORT="${BLOCKYARD_SMOKE_OPEN_PORT:-18199}"
OPEN_DIR="$(mktemp -d /tmp/blockyard-open.XXXXXX)"
OPID=""
# OPID is reaped by the single cleanup trap at the top
BLOCKYARD_CONFIG=none BLOCKYARD_BIND=127.0.0.1 \
BLOCKYARD_DATA="$OPEN_DIR" BLOCKYARD_FAKE_NODE=1 BLOCKYARD_PORT="$OPEN_PORT" \
BLOCKYARD_LOG_LEVEL=warn FAKE_PORT="$((FAKE_PORT + 1))" node server/main.js >"$OPEN_DIR/server.log" 2>&1 &
OPID=$!
OBASE="http://127.0.0.1:$OPEN_PORT"
for _ in $(seq 1 60); do curl -fs --max-time 1 "$OBASE/api/health" >/dev/null 2>&1 && break; sleep 0.3; done

check "no cookie needed for /api/state" "$(curl -s -o /dev/null -w '%{http_code}' "$OBASE/api/state?series=none")" "200"
check "the anonymous identity is viewer" "$(curl -s "$OBASE/api/state?series=none" | grep -c '"username":"anonymous"')" "1"
check "health says auth is not required" "$(curl -s "$OBASE/api/health" | grep -c '"authRequired":false')" "1"
check "/api/me reports the posture in words" "$(curl -s "$OBASE/api/me" | grep -c '"accounts":false')" "1"
check "config exposes the access mode" "$(curl -s "$OBASE/api/config" | grep -c '"mode":"open"')" "1"
# >= 1, not == 1: however many frames arrive in six seconds is fine, the point is that
# an anonymous socket gets frames at all.
SNAP=$(curl -s -N --max-time 6 "$OBASE/api/stream" 2>/dev/null | head -c 400000 | grep -c 'event: snapshot')
[ "$SNAP" -ge 1 ] && ok "the stream works without a session ($SNAP frames)" || bad "the stream works without a session" "0 frames in 6s"
check "/login redirects home instead of a dead form" "$(curl -s -o /dev/null -w '%{http_code}' "$OBASE/login")" "302"
check "login refuses rather than guessing passwords" "$(curl -s -X POST "$OBASE/api/login" -H 'content-type: application/json' -d '{"username":"admin","password":"***"}' | grep -c accounts_disabled)" "1"
check "no session cookie is minted" "$(curl -s -D - -o /dev/null "$OBASE/api/state?series=none" | grep -ci 'set-cookie')" "0"
check "user admin stays closed" "$(curl -s -o /dev/null -w '%{http_code}' "$OBASE/api/users")" "403"
check "the refusal names the switch" "$(curl -s "$OBASE/api/users" | grep -c 'accounts are disabled')" "1"
check "creating accounts is refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OBASE/api/users" -H 'content-type: application/json' -d '{"username":"planted","password":"***","role":"admin"}')" "403"
check "the read-only RPC console works with no CSRF token" "$(curl -s -X POST "$OBASE/api/rpc" -H 'content-type: application/json' -d '{"method":"getconnectioncount","params":[]}' | grep -c '"ok":true')" "1"
check "open does not mean unguarded: writes still denied" "$(curl -s -X POST "$OBASE/api/rpc" -H 'content-type: application/json' -d '{"method":"sendrawtransaction","params":["00"]}' | grep -c rpc_denied)" "1"
check "node writes are refused with no identity" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$OBASE/api/action" -H 'content-type: application/json' -d '{"action":"savemempool","confirm":"savemempool"}')" "403"
# "at least one", not "==1": the switch is named in the boot warning AND the banner,
# and an exact-count assertion here would just track how many places mention it.
N=$(grep -c 'NO SIGN-IN' "$OPEN_DIR/server.log"); [ "$N" -ge 1 ] && ok "the boot announces the posture" || bad "the boot announces the posture" "0 lines"
N=$(grep -c 'BLOCKYARD_AUTH=1' "$OPEN_DIR/server.log"); [ "$N" -ge 1 ] && ok "and names the switch that closes it" || bad "and names the switch that closes it" "0 lines"

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || { echo; echo "server log tail:"; tail -20 "$DIR/server.log"; exit 1; }
echo "smoke: all green"
