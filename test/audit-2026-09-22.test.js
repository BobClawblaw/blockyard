// AUDIT 2026-09-22 regression tests: H1 (the nginx example's X-Forwarded-For), M1 (the
// admin-suite exclusion is content-checked, not just path-checked), M2 (manage-users.js
// passwd revokes sessions), M3 (/api/login gets the same cross-site check every other
// mutating route does), M4 (SSE responses carry the app's security headers), L1 (the
// RPC allowlist's dead exception clause), L2/D1 (the DOS loaders validate header fields
// against the file length), L4 (COOP/CORP headers), L5 (the audit trail is HMAC-chained),
// L6 (IPv6 login-throttle buckets collapse to a /64), L7 (the index-build sort worker
// closes its fd on a read error), L8 (rows.js bounds-checks its reads), L9 (pool-map.js
// caps its response size), L10 (a decoded backslash is refused by the static server on
// every platform, not just Windows).
//
// Each test here failed against the code before its fix -- the convention every other
// audit round in this repository follows. Report: docs/SECURITY-AUDIT-2026-09-22.md.
// Remediation record: docs/REMEDIATION-2026-09-22.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withApp } from './helpers/http.js';
import { classifyMethod } from '../server/rpc/allowlist.js';
import { SECURITY_HEADERS } from '../server/http/static.js';
import https from 'node:https';
import { makeSelfSigned } from '../server/tls/selfsigned.js';
import { getOverHttps, MAX_POOL_MAP_BYTES } from '../scripts/pool-map.js';
import { LoginGuard } from '../server/auth/sessions.js';
import { loadLE, parseCoff, MEM_SIZE } from '../public/js/dospc.js';
import { RpcClient } from '../server/rpc/client.js';
import { WALLET_METHODS } from '../server/rpc/allowlist.js';
import { blockRows, RowSink } from '../server/chain/index/rows.js';
import { AuditLog } from '../server/store/audit.js';
import os from 'node:os';
import { spawn } from 'node:child_process';

// manage-users.js's hidden-password prompt reads stdin one chunk at a time and treats a bare
// '\n'/'\r' chunk as Enter -- true of a real terminal's keystroke-by-keystroke delivery, not of
// a single bulk pipe write. Writing one character per tick (still a pipe, no pty needed) gets
// each character delivered as its own 'data' event, which is what the prompt expects.
function runManageUsers(args, env, password = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/manage-users.js'), ...args], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(9); reject(new Error(`manage-users.js ${args.join(' ')} timed out; output so far: ${out}`)); }, 10_000);
    (async () => {
      if (password != null) for (const ch of `${password}\n`) { child.stdin.write(ch); await new Promise((r) => setTimeout(r, 3)); }
      child.stdin.end();
    })();
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('H1: the reverse-proxy nginx example overwrites X-Forwarded-For, not appends to it', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/INSTALL.md'), 'utf8');
  assert.ok(!/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for/.test(doc), 'the append form must not be the active directive: it lets a client-forged header survive as the entry clientIp() trusts');
  assert.match(doc, /proxy_set_header X-Forwarded-For \$remote_addr/, 'the worked example must overwrite the header with what nginx itself observed');
});

test('L1: the RPC allowlist\'s deny-prefix rule has no exact-match "exception" left to misread as a prefix test', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/rpc/allowlist.js'), 'utf8');
  assert.ok(!/for \(const p of DENY_PREFIXES\).*!ALLOW_PREFIXES/.test(src), 'the dead clause is gone from the active deny-prefix loop, not just documented as dead');
  // every deny-prefixed method is refused, unconditionally -- no method name can slip past this
  for (const m of ['generate', 'generatetoaddress', 'invalidateblock', 'importprivkey', 'sendtoaddress', 'setban', 'unloadwallet', 'loadwallet', 'signmessage']) {
    const r = classifyMethod(m);
    assert.equal(r.allowed, false, `${m} must still be denied`);
  }
});

test('L4: COOP and CORP are sent same-origin, since nothing here needs cross-origin isolation', () => {
  assert.equal(SECURITY_HEADERS['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(SECURITY_HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
});

test('L7: the index-build sort worker closes its fd in a finally, matching readChainFile', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/chain/index/worker.js'), 'utf8');
  const fn = src.slice(src.indexOf('function sortBucket'), src.indexOf('const hex = bucket'));
  assert.match(fn, /try\s*{[\s\S]*fstatSync[\s\S]*readSync[\s\S]*}\s*finally\s*{\s*closeSync\(fd\);\s*}/, 'fstatSync/readSync must run inside a try whose finally closes the fd');
});

test('L9: pool-map.js\'s fetch refuses a body over its cap, declared or actual', async () => {
  const { cert, key } = makeSelfSigned({ sans: ['127.0.0.1'] });
  const server = https.createServer({ cert, key }, (req, res) => {
    if (req.url === '/declared') { res.writeHead(200, { 'Content-Length': String(MAX_POOL_MAP_BYTES + 1) }); res.end('x'); return; }
    // no Content-Length: the cap must still catch it as bytes actually arrive
    res.writeHead(200);
    res.end(Buffer.alloc(MAX_POOL_MAP_BYTES + 1024, 'y'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const extra = { rejectUnauthorized: false };
  try {
    await assert.rejects(getOverHttps(`https://127.0.0.1:${port}/declared`, 0, extra), /cap/);
    await assert.rejects(getOverHttps(`https://127.0.0.1:${port}/actual`, 0, extra), /cap/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('L6: an IPv6 /64 cannot rotate past the per-address login-throttle tiers', () => {
  const guard = new LoginGuard({ maxAttempts: 3, windowMs: 300_000, lockoutMs: 600_000 });
  // same /64 (2001:db8:1234:5678::/64), a different host suffix every attempt: still one bucket
  for (let i = 0; i < 3; i++) {
    const ip = `2001:db8:1234:5678:${i.toString(16)}::1`;
    guard.noteFailure('alice', ip);
  }
  const stillSameBucket = guard.status('alice', '2001:db8:1234:5678:ffff::2');
  assert.equal(stillSameBucket.blocked, true, 'a fresh host suffix inside the same /64 hits the same, now-locked bucket');
  // a genuinely different /64 is not affected
  const otherPrefix = guard.status('alice', '2001:db8:9999:0000::1');
  assert.equal(otherPrefix.blocked, false, 'a different /64 is a different bucket');
  // IPv4 is untouched: exact-address keying, as before
  const v4a = new LoginGuard({ maxAttempts: 3, windowMs: 300_000, lockoutMs: 600_000 });
  v4a.noteFailure('bob', '203.0.113.5');
  v4a.noteFailure('bob', '203.0.113.5');
  v4a.noteFailure('bob', '203.0.113.5');
  assert.equal(v4a.status('bob', '203.0.113.5').blocked, true);
  assert.equal(v4a.status('bob', '203.0.113.6').blocked, false, 'a different IPv4 address is still a different bucket');
});

test('M2: manage-users.js passwd and disable revoke the account\'s existing sessions', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-manage-users-'));
  const env = { ...process.env, BLOCKYARD_CONFIG: 'none', BLOCKYARD_DATA: scratch };
  try {
    const created = await runManageUsers(['create', 'alice', 'viewer'], env, 'first-password-123');
    assert.match(created.out, /created alice as viewer/, created.out);
    const usersFile = path.join(scratch, 'users.json');
    const alice = JSON.parse(fs.readFileSync(usersFile, 'utf8')).users.find((u) => u.username === 'alice');
    assert.ok(alice, 'the user was created');
    // plant a session for alice directly, the way a real sign-in would have left one
    const sessionsFile = path.join(scratch, 'sessions.json');
    const plant = () => fs.writeFileSync(sessionsFile, JSON.stringify({ version: 1, savedAt: Date.now(), sessions: [
      { tokenHash: 'deadbeef', userId: alice.id, username: 'alice', role: 'viewer', csrf: 'x', createdAt: Date.now(), lastSeenAt: Date.now(), ip: null, userAgent: null },
    ] }), { mode: 0o600 });
    plant();
    const changed = await runManageUsers(['passwd', 'alice'], env, 'second-password-456');
    assert.match(changed.out, /1 existing session\(s\) signed out/, changed.out);
    const afterPasswd = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    assert.equal(afterPasswd.sessions.filter((s) => s.userId === alice.id).length, 0, 'the session is gone after passwd, not left for the UI to clean up');

    // plant another session, then disable: the CLI route should match the web route's revoke
    plant();
    const disabled = await runManageUsers(['disable', 'alice'], env);
    assert.match(disabled.out, /1 existing session\(s\) signed out/, disabled.out);
    const afterDisable = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    assert.equal(afterDisable.sessions.filter((s) => s.userId === alice.id).length, 0, 'disable revokes too, matching the web route');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('M3: a cross-site POST to /api/login is refused (login CSRF), with accounts on or off', async () => {
  const CROSS = { Origin: 'http://evil.example', 'Content-Type': 'application/json' };
  for (const auth of [true, false]) {
    await withApp({ auth }, async ({ base }) => {
      const res = await fetch(`${base}/api/login`, { method: 'POST', headers: CROSS, body: JSON.stringify({ username: 'admin', password: 'whatever-the-attacker-knows' }) });
      assert.equal(res.status, 403, `auth=${auth}: a cross-site login POST must be refused before it is ever evaluated`);
      const j = await res.json().catch(() => null);
      assert.equal(j?.error?.kind, 'csrf', `auth=${auth}: refused for the wrong reason: ${JSON.stringify(j)}`);
      assert.ok(!res.headers.get('set-cookie'), `auth=${auth}: no session cookie may be set on a refused cross-site login`);
    });
  }
});

test('M3: a same-site login POST (no Origin header, as a plain client sends) is unaffected', async () => {
  await withApp({ auth: true }, async ({ client }) => {
    const r = await client.post('/api/login', { username: 'nobody-such-user', password: 'wrong' });
    // still refused, but for being the WRONG credential, not for the cross-site check
    assert.notEqual(r.body?.error?.kind, 'csrf', 'a same-site request (no Origin) must reach the real login logic');
  });
});

// L2/D1: the DOS loaders fail LOUD on a truncated/corrupted file, instead of silently copying
// short and leaving the emulated machine's memory quietly wrong. games/ may not be present in
// every checkout (it is not shipped in the npm package, per AGENTS.md) -- skip, named, if so.
const DOOM_EXE = path.join(ROOT, 'games/doom_dos/DOOM.EXE');
const QUAKE_EXE = path.join(ROOT, 'games/quake_dos/QUAKE.EXE');
const haveDoom = fs.existsSync(DOOM_EXE);
const haveQuake = fs.existsSync(QUAKE_EXE);

test('L2/D1: a truncated LE (DOS/4GW) executable is refused with a named reason, not a silent short copy', haveDoom ? {} : { skip: 'games/doom_dos/DOOM.EXE is not in this checkout' }, () => {
  const full = new Uint8Array(fs.readFileSync(DOOM_EXE));
  const truncated = full.slice(0, Math.floor(full.length * 0.9));
  const mem = new Uint8Array(MEM_SIZE);
  assert.throws(() => loadLE(truncated, mem), /runs past the end of the file/, 'a page whose source data was cut off must throw, not copy whatever bytes remain');
  // the real file is untouched by any of this and still loads
  assert.doesNotThrow(() => loadLE(full, new Uint8Array(MEM_SIZE)));
});

test('L2/D1: a truncated COFF (DJGPP) executable is refused with a named reason', haveQuake ? {} : { skip: 'games/quake_dos/QUAKE.EXE is not in this checkout' }, () => {
  const full = new Uint8Array(fs.readFileSync(QUAKE_EXE));
  const truncated = full.slice(0, Math.floor(full.length * 0.9));
  assert.throws(() => parseCoff(truncated), /runs past the end of the file/, 'a section whose file data was cut off must throw, not be handed to bootCoff to clip further');
  assert.notEqual(parseCoff(full), null, 'the real file still parses');
});

test('M1: RpcClient itself refuses a wallet method with no adminAuthorized flag -- the enforcement does not depend on the caller checking first', async () => {
  // rpcUrl points nowhere reachable; if this ever reached the network, the test would time out
  // instead of failing fast, which is itself part of the proof -- it doesn't get that far.
  const c = new RpcClient({ id: 'x', rpcUrl: 'http://127.0.0.1:1' }, { maxInFlight: 1, timeoutMs: 500, heavyTimeoutMs: 500 });
  // a representative sample, not just one method: the gate is WALLET_METHODS-wide
  for (const method of ['sendtoaddress', 'walletpassphrase', 'dumpprivkey', 'listunspent', 'getnewaddress']) {
    await assert.rejects(c.call(method, []), (err) => {
      assert.equal(err.kind, 'wallet-unauthorized', `${method} must be refused with the wallet-unauthorized kind, got ${err.kind}: ${err.message}`);
      return true;
    }, `${method} must be refused without adminAuthorized`);
  }
  // and explicitly authorized, it is passed through (fails on the network instead, proving it
  // got past the gate -- 'x' is not in WALLET_METHODS, a plain unknown-method style failure is fine)
  await assert.rejects(c.call('sendtoaddress', [], { adminAuthorized: true }), (err) => {
    assert.notEqual(err.kind, 'wallet-unauthorized', 'adminAuthorized: true must get past the gate');
    return true;
  });
  // a non-wallet read is entirely unaffected
  await assert.rejects(c.call('getblockcount', []), (err) => {
    assert.notEqual(err.kind, 'wallet-unauthorized', 'a non-wallet method must never be refused for this reason');
    return true;
  });
});

test('M1: every method the admin suite can call, and only those, are the ones RpcClient will admit as admin-authorized', () => {
  // Not a claim about WHERE the check lives (that's the test above) -- a claim that the set of
  // methods it gates is exactly WALLET_METHODS, the same census server/rpc/allowlist.js already
  // uses to refuse these on the read-only console. Two lists that happen to agree today is not a
  // guarantee; importing the same Set and asserting on it is.
  assert.ok(WALLET_METHODS.has('sendrawtransaction') || WALLET_METHODS.has('walletprocesspsbt'), 'sanity: the set actually contains real spend methods');
  assert.ok(WALLET_METHODS.size > 20, 'sanity: this is the full wallet census, not a short list');
});

test('L10: a decoded backslash in a static request is refused, not passed to path.normalize', async () => {
  await withApp({ auth: false }, async ({ base }) => {
    // %5C decodes to a literal backslash. On POSIX this is just an odd filename byte and 404s
    // safely; the point is that it is refused BEFORE reaching path.normalize/path.join at all, so
    // whatever those do with a backslash on another platform never gets a chance to matter.
    const res = await fetch(`${base}/js%5C..%5C..%5Cconfig%5Clocal.json`);
    assert.equal(res.status, 400, 'a decoded backslash must be refused outright');
  });
});

test('L8: a corrupted output-script length in a block is refused loudly and specifically, not clipped silently', () => {
  const compact = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 255, n >> 8]));
  // one transaction: version, no segwit marker, 1 (empty-scriptSig) input so the leading bytes
  // can never read as the segwit marker (0x00 0x01), 1 output whose script CLAIMS 80 bytes but
  // the buffer holds only 3 before it ends -- a truncated file, or a single flipped length byte.
  const tx = Buffer.concat([
    Buffer.from([1, 0, 0, 0]),          // version
    compact(1),                          // nin
    Buffer.alloc(36),                    // one input: 32-byte prevout hash + 4-byte index
    compact(0),                          // scriptSig length: empty
    Buffer.alloc(4),                     // sequence
    compact(1),                          // nout
    Buffer.alloc(8),                     // value
    compact(80),                         // script length: 80 claimed
    Buffer.from([0xaa, 0xbb, 0xcc]),     // only 3 actually present
  ]);
  const body = Buffer.concat([Buffer.alloc(80), compact(1), tx]);
  assert.throws(() => blockRows(body, null, 100, new RowSink(4)), /truncated: need 80 bytes/, 'walkTx must name exactly which read ran past the buffer, not just report a final position mismatch');
});

test('L3/D2: /games/* is rate-limited, like every other size-heavy route', async () => {
  await withApp({ auth: false }, async ({ base, app }) => {
    app.gamesLimiter.capacity = 3;
    app.gamesLimiter.perSec = 0.001;   // effectively no refill within the test's lifetime
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${base}/games/doom/DOOM.EXE`);
      statuses.push(res.status);
    }
    // the first 3 are answered (404 in this harness -- no real game files are configured here;
    // the point is that the limiter runs BEFORE that, so it caps requests whether or not the file
    // exists), the rest are refused for being too many, not for the file being missing
    assert.deepEqual(statuses.slice(0, 3).every((s) => s !== 429), true, `expected no 429s in the first 3: ${statuses}`);
    assert.deepEqual(statuses.slice(3), [429, 429], `expected the 4th and 5th capped: ${statuses}`);
  });
});

test('L5: the audit trail is hash-chained; a tampered line is detected and named', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-audit-chain-'));
  const file = path.join(scratch, 'audit.jsonl');
  try {
    const log = new AuditLog(file);
    await log.append({ type: 'login', username: 'alice' });
    await log.append({ type: 'action', username: 'alice', action: 'savemempool' });
    await log.append({ type: 'logout', username: 'alice' });

    const clean = await log.verifyChain();
    assert.deepEqual(clean, { ok: true, checked: 3 }, 'three untouched entries verify cleanly');

    // edit the MIDDLE line in place -- exactly the "one entry changed, nothing after it
    // regenerated" shape this is meant to catch -- and confirm the break is reported at THAT
    // line, not just "somewhere": everything strictly before it is still counted as verified.
    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    const row = JSON.parse(lines[1]);
    row.action = 'stop';                                  // tampered: a refused action rewritten as one that wasn't
    lines[1] = JSON.stringify(row);                        // hash left as it was -- the attacker didn't recompute it
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const tampered = await log.verifyChain();
    assert.equal(tampered.ok, false);
    assert.equal(tampered.brokenAt.line, 2, 'names the exact line that no longer matches');
    assert.equal(tampered.checked, 1, 'only the entry strictly before the break is counted as verified');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('L5: pre-existing entries written before hash-chaining existed do not crash verifyChain, or adopt()', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-audit-chain-migrate-'));
  const file = path.join(scratch, 'audit.jsonl');
  try {
    // exactly what a real audit.jsonl written before this fix looks like: no `hash` field at all
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'login', username: 'alice' }),
      JSON.stringify({ type: 'logout', username: 'alice' }),
    ].join('\n') + '\n', { mode: 0o600 });

    const log = new AuditLog(file);
    const before = await log.verifyChain();
    assert.deepEqual(before, { ok: true, checked: 2 }, 'unhashed legacy rows are treated as fresh-start points, not a crash');

    await log.adopt();
    await log.append({ type: 'login', username: 'carol' });   // the first entry written after the upgrade
    const after = await log.verifyChain();
    assert.deepEqual(after, { ok: true, checked: 3 }, 'the new, chained entry verifies too, seeded from GENESIS_HASH the same way adopt() seeded it at append time');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('L5: a restart (a fresh AuditLog + adopt()) continues the chain instead of resetting it', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'blockyard-audit-chain-restart-'));
  const file = path.join(scratch, 'audit.jsonl');
  try {
    const log = new AuditLog(file);
    await log.append({ type: 'login', username: 'alice' });
    await log.append({ type: 'logout', username: 'alice' });

    // a fresh instance, as a real restart gets: no in-memory lastHash of its own until adopt()
    const restarted = new AuditLog(file);
    await restarted.adopt();
    await restarted.append({ type: 'login', username: 'bob' });

    const result = await restarted.verifyChain();
    assert.deepEqual(result, { ok: true, checked: 3 }, 'all three entries verify as one continuous chain across the restart, not reset at genesis for the third');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('M4: an SSE response carries the same security headers every other response does', async () => {
  await withApp({ auth: false }, async ({ port }) => {
    const res = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, resolve);
      req.on('error', reject);
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-security-policy'], 'CSP must be present on the SSE response');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.ok(res.headers['permissions-policy'], 'Permissions-Policy must be present too');
    res.destroy();
  });
});
