import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This repository gets pushed. Everything in it is therefore public to whoever can
// see the remote, and the things most likely to slip in are not secrets in the
// API-key sense -- they are the machine's own username and addresses, which ride
// along in systemd units, doc examples and test fixtures without anyone deciding
// to publish them.
//
// So this test does NOT hardcode the values it forbids (that would put them right
// back into the repo). It derives them from the machine at run time and fails if
// any of them appear in a tracked file.

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    return null; // not a git checkout; nothing to check
  }
}

// ACCOUNTS THAT NAME A MACHINE, NOT A PERSON. A GitHub runner's username is `runner`; a
// container's is often `root` or `ubuntu`. Those are ordinary English words, and "the test
// runner's own TAP output" -- which appears in three tracked files -- is not a privacy leak.
//
// This file already reasons exactly this way about the bare hostname ("a common English word,
// and matching it would flag ordinary prose"). Usernames never got the same treatment, because
// on the machine this was written on the username is distinctive, so it never fired. The first
// CI run found it immediately: three sentences about test runners, reported as identity leaks.
//
// The guard stays ON in CI -- a push is exactly when leaked identity would escape. What changes
// is that a generic account name is not an identity worth guarding.
export const GENERIC_ACCOUNTS = new Set([
  'runner', 'root', 'user', 'users', 'admin', 'administrator', 'build', 'builder',
  'ubuntu', 'debian', 'centos', 'fedora', 'alpine', 'node', 'nobody', 'default',
  'ci', 'github', 'gitlab', 'jenkins', 'travis', 'circleci', 'vsts', 'azureuser',
  'docker', 'vagrant', 'codespace', 'devcontainer', 'runneradmin',
]);
export const isGenericAccount = (u) => GENERIC_ACCOUNTS.has(String(u ?? '').toLowerCase());

/** Identifiers that say "this particular person's machine". */
function machineIdentity() {
  const out = [];
  const user = os.userInfo().username;
  // A short username can sit inside an ordinary word, so matches are word-bounded.
  if (user && user.length >= 3 && !isGenericAccount(user)) {
    out.push({ kind: 'username', re: new RegExp(`\\b${esc(user)}\\b`, 'i'), shown: user });
  }

  // The bare hostname here is a common English word, and matching it would flag
  // ordinary prose. The resolvable forms are specific enough to be worth checking.
  const host = os.hostname();
  if (host) for (const form of [`${host}.local`, `${host}.lan`, `${host}.internal`]) {
    out.push({ kind: 'hostname', re: new RegExp(esc(form), 'i'), shown: form });
  }

  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    // Ephemeral bridge IPs (docker0, br-*, veth*) churn and identify nothing about
    // a person; the routed interfaces are the ones worth keeping private.
    if (/^(docker|br-|veth|virbr|lo)/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      out.push({ kind: `interface ${name}`, re: new RegExp(esc(a.address), 'i'), shown: a.address });
    }
  }
  return out;
}

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('no tracked file contains this machine username, hostname or addresses', () => {
  const files = trackedFiles();
  if (files === null) return; // skip outside a git checkout
  const identity = machineIdentity();

  const hits = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const id of identity) {
      if (id.re.test(text)) hits.push(`${f} contains ${id.kind} "${id.shown}"`);
    }
  }
  assert.deepEqual(hits, [], `personal/host identifiers would be published:\n  ${hits.join('\n  ')}`);
});

test('committed text carries no overlay-network address and no unreviewed host address', () => {
  const files = trackedFiles();
  if (files === null) return;

  // Rule 1, absolute: nothing in 100.64.0.0/10. That is the CGNAT/tailnet range, so
  // an address there is a specific device on someone's overlay network. One turned
  // up in three docs files as an `ip route get` example and nobody noticed, because
  // it looks like a made-up IP.
  const OVERLAY = /\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}\b/;

  // Rule 2: RFC1918 identifies a network. Loopback, the wildcard, docker's default
  // bridge in a hermetic fixture, and one README example CIDR are allowed; anything
  // else must be justified by name here rather than added silently.
  const RFC1918 = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;
  const RFC1918_OK = new Set(['172.17.0.1']);

  // Rule 3: routable addresses are only permitted where they are quoted measurements
  // of a public Bitcoin peer -- never as a config value or a host fact. Adding a
  // file here is the review step.
  const PEER_QUOTE_OK = [
    /^test\/fixtures\//, /^test\/logparse\.test\.js$/, /^test\/app-boot\.test\.js$/,
    /^test\/bench-log\.test\.js$/, /^server\/collect\/logparse\.js$/,
    /^scripts\/fake-node\.js$/, /^docs\/MEASUREMENTS\.md$/,
    // Other parser fixtures quoting real peer lines (public bitcoin nodes, not hosts).
    /^test\/rpc-only\.test\.js$/, /^test\/shape-liveness\.test\.js$/, /^test\/node-series\.test\.js$/,
    // The shareware game packages under games/ (DOOM first), byte for byte as id Software shipped it (2026-09-15): HELPME.TXT
    // and the FAQ list the FTP mirrors of 1993 by address. Public archive hosts, not this network,
    // and the files cannot be edited without breaking "unmodified".
    /^games\//,
  ];
  // No `$` in these lookaheads: without /m it means end-of-string, which made
    // "0.0.0.0" fail to be excluded everywhere it appeared mid-line.
    const routable = /\b(?!127\.|0\.0\.0\.0|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|10\.|172\.|192\.168\.|1\.2\.3\.4|8\.8\.8\.8)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;;

  const hits = [];
  for (const f of files) {
    // This file necessarily contains the ranges it forbids, in order to express
    // them. Scanning it would be a self-referential false positive -- the identity
    // rule above still applies to it, because the machine's real values are never
    // written down here.
    if (f === 'test/privacy.test.js') continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    // SVG PATH DATA IS GEOMETRY, NOT TEXT. Compact path data elides separators, so
    // `d="...5.47 7.59.4.07.55-.17..."` contains the run "7.59.4.07", which these rules read as
    // a routable address. That happened twice in one afternoon -- the settings cog and the GitHub
    // mark -- and hand-formatting every path forever is a tax, not a fix. A `d` attribute cannot
    // carry a meaningful address, so it is excluded from the ADDRESS rules only.
    //
    // Note what is NOT excluded: the identity rules above (username, resolvable hostnames) still
    // scan the whole file, path data included. Only the numeric-address patterns skip `d`.
    const scan = text.replace(/\sd="[^"]*"/g, ' d=""');
    if (OVERLAY.test(scan)) hits.push(`${f}: overlay-network (100.64/10) address`);
    for (const m of scan.matchAll(RFC1918)) {
      if (RFC1918_OK.has(m[0])) continue;
      if (f === 'README.md' && m[0].endsWith('.0.0')) continue; // the 192.168.0.0/16 example CIDR
      hits.push(`${f}: RFC1918 address ${m[0]} -- use an RFC 5737 documentation address (192.0.2.x / 198.51.100.x / 203.0.113.x)`);
    }
    if (!PEER_QUOTE_OK.some((re) => re.test(f)) && routable.test(scan)) {
      hits.push(`${f}: a routable address outside the reviewed peer-quote list`);
    }
  }
  assert.deepEqual(hits, [], `addresses that should not be published:\n  ${hits.join('\n  ')}`);
});

test('the unit file names no real account and no real address', () => {
  const file = path.join(ROOT, 'systemd', 'blockyard.service');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  const identity = machineIdentity();
  for (const id of identity) assert.ok(!id.re.test(text), `the unit would publish ${id.kind} "${id.shown}"`);
  assert.match(text, /User=blockyard/, 'a neutral placeholder service account');
  assert.match(text, /EDIT ME/, 'and it must be obvious that it is a placeholder');
  // Regression: two Environment= assignments once ended up on one line, which
  // silently discarded BLOCKYARD_PORT.
  assert.doesNotMatch(text, /Environment=\S+=\S*Environment=/, 'one assignment per line');
});

test('the privacy guard ignores accounts that name a machine rather than a person', () => {
  // Found by the first CI run this repository ever had: it runs as `runner`, and three tracked
  // files say "the test runner's own TAP output". The guard reported all three as leaked
  // identity and failed the build -- loudly, and for nothing. Word boundaries did not help,
  // because `runner` really is a whole word in that sentence.
  for (const u of ['runner', 'root', 'ubuntu', 'RUNNER', 'Build', 'codespace']) {
    assert.equal(isGenericAccount(u), true, `"${u}" names a machine, not a person`);
  }
  for (const u of ['bobclawblaw', 'j.smith', 'alice']) {
    assert.equal(isGenericAccount(u), false, `"${u}" could identify a person`);
  }
  // and nothing else was weakened to achieve it: addresses and resolvable hostnames still count
  const src = fs.readFileSync(new URL('./privacy.test.js', import.meta.url), 'utf8');
  assert.ok(src.includes('kind: `interface ${name}`'), 'interface addresses are still checked');
  assert.ok(src.includes("`${host}.local`"), 'resolvable hostnames are still checked');
});
